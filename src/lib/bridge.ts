export interface NativeFile {
  name: string;
  path: string;
  data: Uint8Array;
}

export interface SaveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export interface PreflyBridge {
  isDesktop: true;
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
  pathForFile: (file: File) => string;
  saveBeside: (sourcePath: string, name: string, bytes: Uint8Array) => Promise<SaveResult>;
  saveAs: (name: string, bytes: Uint8Array) => Promise<SaveResult>;
  reveal: (path: string) => void;
  openFiles: () => Promise<NativeFile[]>;
  onOpenFiles: (callback: (files: NativeFile[]) => void) => () => void;
}

declare global {
  interface Window {
    prefly?: PreflyBridge;
  }
}

export const bridge = (): PreflyBridge | undefined =>
  typeof window !== 'undefined' ? window.prefly : undefined;

export const isDesktop = (): boolean => Boolean(bridge()?.isDesktop);

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const copy = new Uint8Array(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function saveOutput(
  bytes: Uint8Array,
  filename: string,
  sourcePath?: string,
  preferBeside = true,
): Promise<SaveResult> {
  const native = bridge();
  if (native) {
    if (preferBeside && sourcePath) {
      const beside = await native.saveBeside(sourcePath, filename, bytes);
      if (beside.ok) return beside;
    }
    return native.saveAs(filename, bytes);
  }
  downloadBytes(bytes, filename);
  return { ok: true, path: filename };
}
