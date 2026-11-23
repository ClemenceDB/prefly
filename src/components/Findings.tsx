import { useMemo, useState } from 'react';
import type { Finding, Severity } from '../core/types';
import { CATEGORY_LABEL, SEVERITY_ORDER } from '../core/types';

type Filter = 'all' | Severity;

const LABEL: Record<Severity, string> = {
  critical: 'Bloquant',
  warning: 'Alerte',
  info: 'Info',
};

const SHORT: Record<Severity, string> = {
  critical: 'Bloquants',
  warning: 'Alertes',
  info: 'Infos',
};

function pagesLabel(pages?: number[]): string | null {
  if (!pages || pages.length === 0) return null;
  if (pages.length <= 6) return `pages ${pages.join(', ')}`;
  return `${pages.length} pages concernées`;
}

export default function Findings({ findings }: { findings: Finding[] }) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const base = { critical: 0, warning: 0, info: 0 };
    for (const finding of findings) base[finding.severity] += 1;
    return base;
  }, [findings]);

  const visible = useMemo(() => {
    const list = filter === 'all' ? findings : findings.filter((finding) => finding.severity === filter);
    return [...list].sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.title.localeCompare(b.title, 'fr'),
    );
  }, [findings, filter]);

  return (
    <>
      <div className="filters">
        <button
          type="button"
          className={`filter${filter === 'all' ? ' is-on' : ''}`}
          onClick={() => setFilter('all')}
        >
          Tout <b>{findings.length}</b>
        </button>
        {(['critical', 'warning', 'info'] as Severity[]).map((severity) => (
          <button
            type="button"
            key={severity}
            className={`filter${filter === severity ? ' is-on' : ''}`}
            onClick={() => setFilter(severity)}
            disabled={counts[severity] === 0}
          >
            {SHORT[severity]} <b>{counts[severity]}</b>
          </button>
        ))}
        <span className="grow" />
        <span className="mono">Tri par gravité</span>
      </div>

      <div className="finding-list">
        {visible.length === 0 && (
          <p className="muted-row">Aucun point relevé dans cette catégorie.</p>
        )}
        {visible.map((finding) => {
          const pages = pagesLabel(finding.pages);
          return (
            <details
              key={finding.id}
              className="finding"
              data-severity={finding.severity}
              open={finding.severity === 'critical'}
            >
              <summary>
                <span className="finding-title">
                  <span className="sev" data-severity={finding.severity}>
                    {LABEL[finding.severity]}
                  </span>
                  {finding.title}
                  <span className="finding-cat">{CATEGORY_LABEL[finding.category]}</span>
                </span>
              </summary>
              <div className="finding-body">
                <p>{finding.detail}</p>
                {finding.advice && (
                  <p className="advice">
                    <b>Correction</b>
                    {finding.advice}
                  </p>
                )}
                {finding.evidence && finding.evidence.length > 0 && (
                  <ul className="evidence">
                    {finding.evidence.slice(0, 14).map((item, index) => (
                      <li key={`${finding.id}-${index}`}>{item}</li>
                    ))}
                    {finding.evidence.length > 14 && (
                      <li>… et {finding.evidence.length - 14} autre(s)</li>
                    )}
                  </ul>
                )}
                {pages && <div className="pages-note">{pages}</div>}
              </div>
            </details>
          );
        })}
      </div>
    </>
  );
}
