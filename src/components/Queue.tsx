import type { Job } from '../types';
import { humanBytes, humanNumber } from '../core/utils';

interface Props {
  jobs: Job[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onBrowse: () => void;
  onClear: () => void;
}

function jobMeta(job: Job): string {
  if (job.status === 'error') return 'Analyse impossible';
  if (!job.report) {
    const progress = job.progress;
    if (progress && progress.total > 0) return progress.label.toLowerCase();
    return 'lecture…';
  }
  const { report } = job;
  const pages = report.file.pages > 1 ? `${humanNumber(report.file.pages)} p.` : '1 p.';
  return `${humanBytes(job.size)} · ${pages}${job.output ? ' · allégé' : ''}`;
}

export default function Queue({ jobs, selectedId, onSelect, onRemove, onBrowse, onClear }: Props) {
  return (
    <aside className="queue" aria-label="File d’analyse">
      <div className="queue-head">
        <h2>Fichiers</h2>
        <span className="queue-count">{jobs.length.toString().padStart(2, '0')}</span>
        <span className="grow" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={onBrowse}>
          + Ajouter
        </button>
      </div>

      <div className="queue-list">
        {jobs.map((job, index) => {
          const verdict = job.report?.verdict;
          const percent =
            job.status === 'analyzing' && job.progress && job.progress.total > 0
              ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100))
              : null;
          return (
            <button
              type="button"
              key={job.id}
              className={`job${job.id === selectedId ? ' is-active' : ''}`}
              onClick={() => onSelect(job.id)}
              title={job.path ?? job.name}
            >
              <span className="job-index">{(index + 1).toString().padStart(2, '0')}</span>
              <span>
                <span className="job-name">{job.name}</span>
                <span className="job-meta">{jobMeta(job)}</span>
              </span>
              <span className="job-score" data-verdict={verdict}>
                {job.report ? job.report.score : job.status === 'error' ? '!' : '···'}
              </span>
              {percent !== null && (
                <span className="job-progress">
                  <i style={{ width: `${percent}%` }} />
                </span>
              )}
              <span
                role="button"
                tabIndex={-1}
                className="job-remove"
                aria-label={`Retirer ${job.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(job.id);
                }}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>

      <div className="queue-foot">
        <button type="button" className="btn btn-sm" onClick={onBrowse} style={{ flex: 1 }}>
          Ajouter des PDF
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onClear} disabled={!jobs.length}>
          Vider
        </button>
      </div>
      <div style={{ padding: '0 14px 12px' }}>
        <span className="mono" aria-live="polite">
          {jobs.some((job) => job.status === 'analyzing')
            ? 'Analyse en cours — dépôt possible à tout moment'
            : jobs.length
              ? `${jobs.filter((job) => job.report?.verdict === 'ko').length} non conforme(s) · ${jobs.filter((job) => job.report?.verdict === 'check').length} à vérifier`
              : 'Aucun fichier'}
        </span>
      </div>
    </aside>
  );
}
