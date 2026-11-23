import { useCallback, useEffect, useRef, useState } from 'react';
import pkg from '../package.json';
import DropZone from './components/DropZone';
import Queue from './components/Queue';
import ReportView from './components/ReportView';
import { analyzePdf } from './core/analyze';
import { optimizePdf, suggestName } from './core/optimize';
import { THRESHOLDS } from './core/thresholds';
import type { Report } from './core/types';
import { humanBytes } from './core/utils';
import { bridge, downloadBytes, isDesktop, saveOutput } from './lib/bridge';
import { createRenderer, extractText, type PageRenderer } from './lib/pdfjs';
import type { Job } from './types';

interface PendingFile {
  name: string;
  size: number;
  path?: string;
  file?: File;
  bytes?: Uint8Array;
}

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const VERSION = (pkg as { version?: string }).version ?? '1.0.0';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App() {
  const native = bridge();
  const isDesktopApp = Boolean(native?.isDesktop);
  const platform = native?.platform ?? 'web';

  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, text, action }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 7000);
  }, []);

  const update = useCallback((id: string, patch: Partial<Job>) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  }, []);

  const analyzeOne = useCallback(
    (job: Job, pending: PendingFile) => {
      chainRef.current = chainRef.current.then(async () => {
        try {
          const bytes =
            pending.bytes ??
            (pending.file ? new Uint8Array(await pending.file.arrayBuffer()) : new Uint8Array());
          update(job.id, {
            bytes,
            status: 'analyzing',
            progress: { done: 0, total: 1, label: 'Lecture du fichier' },
          });
          const report: Report = await analyzePdf(
            { name: job.name, bytes, size: bytes.length },
            {
              extractText,
              maxTextPages: 150,
              onProgress: (done, total, label) => update(job.id, { progress: { done, total, label } }),
            },
          );
          update(job.id, { status: 'ready', report, progress: undefined });
          setSelectedId((current) => current ?? job.id);
        } catch (error) {
          update(job.id, {
            status: 'error',
            progress: undefined,
            error: `Analyse impossible : ${errorMessage(error)}`,
          });
        }
      });
    },
    [update],
  );

  const enqueue = useCallback(
    (pendingFiles: PendingFile[]) => {
      const created: Job[] = pendingFiles.map((pending) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: pending.name,
        size: pending.size,
        path: pending.path,
        bytes: new Uint8Array(),
        status: 'analyzing',
        progress: { done: 0, total: 1, label: 'Mise en file' },
      }));
      setJobs((current) => [...current, ...created]);
      created.forEach((job, index) => analyzeOne(job, pendingFiles[index]));
    },
    [analyzeOne],
  );

  const handleFiles = useCallback(
    (files: File[]) => {
      const pdfs = files.filter(
        (file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf',
      );
      if (pdfs.length === 0) {
        toast('Seuls les fichiers PDF sont acceptés.');
        return;
      }
      const rejected = files.length - pdfs.length;
      if (rejected > 0) toast(`${rejected} fichier(s) ignoré(s) : format non PDF.`);
      enqueue(
        pdfs.map((file) => ({
          name: file.name,
          size: file.size,
          path: window.prefly?.pathForFile?.(file) || undefined,
          file,
        })),
      );
    },
    [enqueue, toast],
  );

  const openPicker = useCallback(() => inputRef.current?.click(), []);

  // Window-wide drag & drop (Finder, Explorer, desktop).
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (event.dataTransfer?.files?.length) handleFiles(Array.from(event.dataTransfer.files));
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [handleFiles]);

  // Paste a PDF from the clipboard.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) handleFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFiles]);

  // Files opened from the OS (double-click, "Open with").
  useEffect(() => {
    const desktop = bridge();
    if (!desktop) return;
    return desktop.onOpenFiles((files) => {
      if (!files.length) return;
      enqueue(
        files.map((file) => ({
          name: file.name,
          size: file.data.length,
          path: file.path,
          bytes: new Uint8Array(file.data),
        })),
      );
    });
  }, [enqueue]);

  // Keyboard: ⌘/Ctrl+O
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openPicker();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPicker]);

  const selected = jobs.find((job) => job.id === selectedId) ?? jobs[0] ?? null;

  const removeJob = useCallback(
    (id: string) => {
      setJobs((current) => {
        const next = current.filter((job) => job.id !== id);
        if (selectedId === id) setSelectedId(next[0]?.id ?? null);
        return next;
      });
    },
    [selectedId],
  );

  const clearJobs = useCallback(() => {
    setJobs([]);
    setSelectedId(null);
  }, []);

  const runOptimize = useCallback(
    async (job: Job, mode: 'compress' | 'raster', dpi = THRESHOLDS.raster.defaultDpi) => {
      if (!job.bytes.length) return;
      update(job.id, {
        action: mode,
        progress: { done: 0, total: 1, label: mode === 'raster' ? 'Préparation du rendu' : 'Compression' },
      });
      let renderer: PageRenderer | undefined;
      try {
        if (mode === 'raster') renderer = await createRenderer(job.bytes);
        const result = await optimizePdf(job.bytes, {
          mode,
          imageDpi: THRESHOLDS.compress.targetDpi,
          rasterDpi: dpi,
          quality: mode === 'raster' ? 0.86 : 0.82,
          renderPage: renderer?.renderPage,
          yieldMs: 12,
          onProgress: (done, total, label) => update(job.id, { progress: { done, total, label } }),
        });
        const name = suggestName(job.name, mode, mode === 'raster' ? dpi : undefined);
        let savedPath: string | undefined;

        if (isDesktop() && job.path) {
          const saved = await saveOutput(result.bytes, name, job.path, true);
          if (saved.ok) savedPath = saved.path;
          else if (saved.error && saved.error !== 'Annulé') toast(`Enregistrement refusé : ${saved.error}`);
        } else {
          downloadBytes(result.bytes, name);
        }

        update(job.id, {
          action: null,
          progress: undefined,
          output: {
            bytes: result.bytes,
            name,
            notes: result.notes,
            before: result.before,
            after: result.after,
            kind: mode,
            dpi: mode === 'raster' ? dpi : undefined,
            savedPath,
          },
        });

        if (savedPath) {
          toast(`Enregistré à côté du fichier (${humanBytes(result.after)}).`, {
            label: 'Révéler',
            run: () => bridge()?.reveal(savedPath as string),
          });
        } else if (!isDesktop()) {
          toast(`${name} téléchargé.`);
        }
      } catch (error) {
        update(job.id, { action: null, progress: undefined });
        toast(`Échec de l’allègement : ${errorMessage(error)}`);
      } finally {
        await renderer?.destroy();
      }
    },
    [toast, update],
  );

  const exportReport = useCallback(
    async (job: Job) => {
      if (!job.report) return;
      const payload = JSON.stringify(
        {
          application: 'Pré-fly',
          version: VERSION,
          generatedAt: new Date().toISOString(),
          file: job.path ?? job.name,
          report: job.report,
        },
        null,
        2,
      );
      const bytes = new TextEncoder().encode(payload);
      const name = `${job.name.replace(/\.pdf$/i, '')}.prefly.json`;
      if (isDesktop()) {
        const saved = await saveOutput(bytes, name, job.path, false);
        if (saved.ok) toast('Rapport enregistré.');
      } else {
        const blob = new Blob([bytes], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        toast('Rapport téléchargé.');
      }
    },
    [toast],
  );

  const saveOutputAgain = useCallback(
    async (job: Job) => {
      if (!job.output) return;
      const saved = await saveOutput(job.output.bytes, job.output.name, job.path, false);
      if (saved.ok) {
        update(job.id, { output: { ...job.output, savedPath: saved.path } });
        toast('Fichier enregistré.');
      } else if (saved.error && saved.error !== 'Annulé') {
        toast(`Enregistrement impossible : ${saved.error}`);
      }
    },
    [toast, update],
  );

  const pending = !selected;

  return (
    <div className="app" data-platform={platform}>
      <header className="bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span>Pré-fly</span>
          <small>pré-vol</small>
        </div>
        <span className="bar-spacer" />
        <span className="chip hide-sm">
          <span className="chip-dot" />
          Traitement local
        </span>
        {isDesktopApp && (
          <span className="chip hide-sm">
            {platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'}
          </span>
        )}
        <span className="chip">v{VERSION}</span>
      </header>

      <main className="workspace">
        {jobs.length > 0 && (
          <Queue
            jobs={jobs}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
            onRemove={removeJob}
            onBrowse={openPicker}
            onClear={clearJobs}
          />
        )}

        <section className="stage">
          {pending ? (
            jobs.length === 0 ? (
              <DropZone
                version={VERSION}
                isDesktopApp={isDesktopApp}
                onFiles={handleFiles}
                onBrowse={openPicker}
              />
            ) : (
              <div className="intro">
                <div className="intro-inner">
                  <div className="eyebrow">
                    <span className="mono">Analyse en cours</span>
                    <span className="rule" />
                    <span className="mono">{jobs.length} fichier(s)</span>
                  </div>
                  <h1>
                    Lecture du PDF.
                    <br />
                    <em>Un instant.</em>
                  </h1>
                  <p className="lede">
                    {jobs[0].progress?.label ?? 'Analyse'} — vous pouvez déposer d’autres fichiers
                    pendant le traitement.
                  </p>
                </div>
              </div>
            )
          ) : (
            <ReportView
              job={selected as Job}
              isDesktopApp={isDesktopApp}
              onOptimize={(mode, dpi) => void runOptimize(selected as Job, mode, dpi)}
              onExport={() => void exportReport(selected as Job)}
              onSaveOutput={() => void saveOutputAgain(selected as Job)}
              onReveal={(path) => bridge()?.reveal(path)}
            />
          )}
        </section>
      </main>

      <div className={`overlay${dragging ? ' is-active' : ''}`} aria-hidden={!dragging}>
        <div className="overlay-box">
          <strong>Relâchez pour analyser</strong>
          <span className="mono">PDF uniquement · rien ne quitte la machine</span>
        </div>
      </div>

      <div className="toasts" aria-live="polite">
        {toasts.map((item) => (
          <div className="toast" key={item.id}>
            <span className="spacer">{item.text}</span>
            {item.action && (
              <button type="button" onClick={item.action.run}>
                {item.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Fermer"
              onClick={() => setToasts((current) => current.filter((toastItem) => toastItem.id !== item.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files) handleFiles(Array.from(event.target.files));
          event.target.value = '';
        }}
      />
    </div>
  );
}
