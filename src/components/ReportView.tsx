import type { Job } from '../types';
import { VERDICT_LABEL } from '../types';
import { humanBytes, humanNumber } from '../core/utils';
import Findings from './Findings';

interface Props {
  job: Job;
  isDesktopApp: boolean;
  onOptimize: (mode: 'compress' | 'raster', dpi?: number) => void;
  onExport: () => void;
  onSaveOutput: () => void;
  onReveal: (path: string) => void;
}

function pagesList(pages: number[]): string {
  if (pages.length === 0) return '—';
  if (pages.length <= 6) return pages.join(', ');
  return `${pages.length} pages`;
}

function formatTags(values: string[]): string {
  const unique = Array.from(new Set(values.filter(Boolean)));
  if (unique.length <= 2) return unique.join(' · ');
  return `${unique.slice(0, 2).join(' · ')} +${unique.length - 2}`;
}

function swatchColor(space: string, spot?: string): string {
  if (spot) {
    let hash = 0;
    for (let i = 0; i < spot.length; i += 1) hash = (hash * 31 + spot.charCodeAt(i)) % 360;
    return `hsl(${hash} 62% 48%)`;
  }
  if (space.includes('CMYK')) return '#171614';
  if (space.includes('RGB') || space === 'CalRGB') return '#d8392b';
  if (space.includes('Gray')) return '#8a877e';
  if (space === 'Lab') return '#b58a2b';
  return 'var(--line-strong)';
}

export default function ReportView({
  job,
  isDesktopApp,
  onOptimize,
  onExport,
  onSaveOutput,
  onReveal,
}: Props) {
  const report = job.report;
  if (!report) {
    return (
      <div className="report">
        <p className="muted-row">
          {job.status === 'error' ? job.error : 'Analyse du fichier en cours…'}
        </p>
      </div>
    );
  }

  const { file, stats } = report;
  const formats = file.pageSizes.map((size) => size.label);
  const usedFonts = report.fonts.filter((font) => font.used);
  const percent =
    job.progress && job.progress.total > 0
      ? Math.min(100, Math.round((job.progress.done / job.progress.total) * 100))
      : null;
  const gain = job.output
    ? Math.round((1 - job.output.after / Math.max(1, job.output.before)) * 100)
    : 0;
  const isRaster = job.output?.kind === 'raster';

  return (
    <article className="report">
      <header className="report-head">
        <div className="report-title">
          <div className="eyebrow" style={{ marginBottom: 0 }}>
            <span className="mono">Rapport de pré-vol</span>
            <span className="rule" />
            <span className="mono">{report.elapsedMs} ms</span>
          </div>
          <h2>{job.name}</h2>
          <div className="report-path">{job.path ?? 'fichier importé'}</div>
        </div>
        <div className="verdict" data-verdict={report.verdict}>
          <div className="score">
            {report.score}
            <small>/100</small>
          </div>
          <div className="verdict-label">
            <strong>{VERDICT_LABEL[report.verdict]}</strong>
            <span>
              {report.findings.length} point(s) relevé(s)
            </span>
          </div>
        </div>
      </header>

      <div className="meta-grid">
        <div className="meta-cell">
          <span className="mono">Pages</span>
          <strong>{humanNumber(file.pages)}</strong>{' '}
          <em>{formats.length > 1 ? `${formats.length} formats` : ''}</em>
        </div>
        <div className="meta-cell">
          <span className="mono">Format</span>
          <strong>{formatTags(formats) || '—'}</strong>
        </div>
        <div className="meta-cell">
          <span className="mono">Poids</span>
          <strong>{humanBytes(file.size)}</strong>{' '}
          <em>{stats.imageBytes ? `dont ${humanBytes(stats.imageBytes)} d’images` : ''}</em>
        </div>
        <div className="meta-cell">
          <span className="mono">Version</span>
          <strong>PDF {file.version}</strong>{' '}
          <em>{file.pdfx ? 'PDF/X' : file.pdfa ? 'PDF/A' : ''}</em>
        </div>
        <div className="meta-cell">
          <span className="mono">Typographies</span>
          <strong>
            {usedFonts.length}
            {stats.fontsNotEmbedded > 0 ? ` · ${stats.fontsNotEmbedded} non embarquée(s)` : ''}
          </strong>
          <em>{stats.fonts > usedFonts.length ? `${stats.fonts} déclarées` : ''}</em>
        </div>
        <div className="meta-cell">
          <span className="mono">Images</span>
          <strong>{humanNumber(stats.images)}</strong>{' '}
          <em>{stats.minDpi !== null ? `min ${stats.minDpi} dpi` : ''}</em>
        </div>
        <div className="meta-cell">
          <span className="mono">Tons directs</span>
          <strong>{stats.spots}</strong> <em>{file.transparency ? 'transparence' : ''}</em>
        </div>
        <div className="meta-cell">
          <span className="mono">Contenu actif</span>
          <strong>
            {stats.javascript} JS
            {stats.embeddedFiles ? ` · ${stats.embeddedFiles} fichier(s)` : ''}
          </strong>
          <em>{stats.svg ? `${stats.svg} SVG` : report.exotic.length ? `${report.exotic.length} objet(s)` : ''}</em>
        </div>
      </div>

      {report.text && (
        <p className="mono" style={{ margin: '10px 0 0' }}>
          Texte extrait · {humanNumber(report.text.chars)} caractères sur {report.text.pages} page(s)
          {report.text.missingGlyphs > 0 ? ` · ${humanNumber(report.text.missingGlyphs)} glyphe(s) manquant(s)` : ''}
        </p>
      )}

      <section className="optimize" aria-label="Allègement du fichier">
        <div className="optimize-head">
          <h3>{job.output ? (gain > 0 ? 'Fichier allégé' : 'Fichier de sortie') : 'Corriger et alléger'}</h3>
          <div className="optimize-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={Boolean(job.action)}
              onClick={() => onOptimize('compress')}
            >
              {job.action === 'compress' ? 'Compression…' : 'Compresser'}
            </button>
            <details className="menu">
              <summary className="btn" style={{ listStyle: 'none' }}>
                {job.action === 'raster' ? 'Rasterisation…' : 'Rasteriser'}
                <span className="mono" aria-hidden="true">
                  ▾
                </span>
              </summary>
              <div className="menu-pop">
                {[150, 200, 300].map((dpi) => (
                  <button
                    type="button"
                    key={dpi}
                    onClick={(event) => {
                      const details = event.currentTarget.closest('details');
                      if (details) details.open = false;
                      onOptimize('raster', dpi);
                    }}
                  >
                    <span>{dpi} dpi</span>
                    <small>{dpi === 200 ? 'recommandé' : dpi === 300 ? 'qualité max' : 'léger'}</small>
                  </button>
                ))}
              </div>
            </details>
            <button type="button" className="btn" onClick={onExport}>
              Rapport .json
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
              Imprimer
            </button>
          </div>
        </div>
        <p className="mono" style={{ margin: '0 0 4px' }}>
          Compression : conserve le vectoriel · Rasterisation : aplatit tout (polices, tons directs, transparence)
        </p>
        {job.action && percent !== null && (
          <div className="progress-line" aria-live="polite">
            <i style={{ width: `${percent}%` }} />
          </div>
        )}

        {job.output && (
          <div className="output">
            <div>
              <div className="output-title">
                {isRaster
                  ? `Rasterisé à ${job.output.dpi} dpi`
                  : gain > 0
                    ? 'Compressé, vectoriel conservé'
                    : 'Compressé (aucun gain mesurable)'}
              </div>
              <div className="output-sub">
                {humanBytes(job.output.before)} → {humanBytes(job.output.after)} · {job.output.name}
              </div>
            </div>
            <div className="gain" data-negative={gain <= 0}>
              {gain > 0 ? `−${gain} %` : `${humanBytes(job.output.after)}`}
            </div>
            <div className="grow" />
            <button type="button" className="btn btn-sm" onClick={onSaveOutput}>
              {isDesktopApp ? 'Enregistrer sous…' : 'Télécharger à nouveau'}
            </button>
            {job.output.savedPath && isDesktopApp && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onReveal(job.output?.savedPath as string)}
              >
                Révéler
              </button>
            )}
            {job.output.notes.length > 0 && (
              <ul className="evidence" style={{ flexBasis: '100%', margin: 0 }}>
                {job.output.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <Findings findings={report.findings} />

      <section className="section">
        <div className="section-head">
          <h3>Typographies</h3>
          <span>{usedFonts.length} utilisée(s)</span>
        </div>
        {usedFonts.length === 0 ? (
          <p className="muted-row">Aucune police utilisée — document image ou vectoriel pur.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Police</th>
                <th>Type</th>
                <th>Embarquement</th>
                <th>Pages</th>
              </tr>
            </thead>
            <tbody>
              {usedFonts.map((font) => (
                <tr key={`${font.name}-${font.subtype}`}>
                  <td className="name">{font.name}</td>
                  <td className="num">
                    {font.subtype}
                    {font.subset ? ' · sous-ensemble' : ''}
                  </td>
                  <td>
                    <span className="tag" data-tone={font.embedded ? 'ok' : 'bad'}>
                      {font.embedded ? (font.type3 ? 'Type 3' : 'embarquée') : 'absente'}
                    </span>
                    {!font.toUnicode && <span className="tag" style={{ marginLeft: 6 }}>sans ToUnicode</span>}
                  </td>
                  <td className="num">{pagesList(font.pages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h3>Images</h3>
          <span>
            {report.images.length} placement(s)
            {stats.maxImageBytes ? ` · max ${humanBytes(stats.maxImageBytes)}` : ''}
          </span>
        </div>
        {report.images.length === 0 ? (
          <p className="muted-row">Aucune image bitmap dans le document.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Page</th>
                <th>Pixels</th>
                <th>Résolution</th>
                <th>Espace</th>
                <th>Codage</th>
                <th>Poids</th>
              </tr>
            </thead>
            <tbody>
              {report.images.slice(0, 30).map((image, index) => {
                const dpiTone = image.dpi === null ? undefined : image.dpi < 150 ? 'bad' : image.dpi > 600 ? 'warn' : 'ok';
                return (
                  <tr key={`${image.page}-${image.name}-${index}`}>
                    <td className="num">{image.page}</td>
                    <td className="num">
                      {image.width} × {image.height}
                    </td>
                    <td className="num">
                      {image.dpi !== null ? (
                        <span className="tag" data-tone={dpiTone}>
                          {image.dpi} dpi
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="num">{image.colorSpace}</td>
                    <td className="num">{image.filter}</td>
                    <td className="num">{image.bytes ? humanBytes(image.bytes) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {report.images.length > 30 && (
          <p className="pages-note">+ {report.images.length - 30} autres placements non listés.</p>
        )}
      </section>

      <section className="section">
        <div className="section-head">
          <h3>Couleurs & profils</h3>
          <span>{report.colors.length} espace(s)</span>
        </div>
        <div className="color-list">
          {report.colors.map((color) => (
            <span className="color-chip" key={`${color.space}-${color.spot ?? ''}`}>
              <span
                className="swatch"
                style={{ background: swatchColor(color.space, color.spot) }}
                aria-hidden="true"
              />
              {color.spot ?? color.space}
              <b>×{humanNumber(color.count)}</b>
            </span>
          ))}
          {report.colors.length === 0 && <span className="muted-row">Aucune couleur déclarée.</span>}
        </div>
        <table className="table" style={{ marginTop: 10 }}>
          <tbody>
            <tr>
              <td className="name">Profil de sortie</td>
              <td className="num">
                {report.findings.some((finding) => finding.id === 'output-intent')
                  ? 'déclaré'
                  : 'absent'}
              </td>
              <td className="num">{file.transparency ? 'transparence active' : 'opaque'}</td>
              <td className="num">{file.overprint ? 'surimpression' : 'sans surimpression'}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="section" style={{ paddingBottom: 40 }}>
        <div className="section-head">
          <h3>Contenu exotique</h3>
          <span>{report.exotic.length} objet(s) isolé(s)</span>
        </div>
        {report.exotic.length === 0 ? (
          <p className="muted-row">Aucun contenu externe, actif ou non imprimable détecté.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Nature</th>
                <th>Détail</th>
                <th>Poids</th>
              </tr>
            </thead>
            <tbody>
              {report.exotic.map((item, index) => (
                <tr key={`${item.kind}-${index}`}>
                  <td className="name">{item.label}</td>
                  <td className="num">{item.detail ?? '—'}</td>
                  <td className="num">{item.size ? humanBytes(item.size) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="pages-note">
          {file.hasTrim ? 'TrimBox présente' : 'TrimBox absente'} ·{' '}
          {file.hasBleed ? 'BleedBox présente' : 'BleedBox absente'} ·{' '}
          {file.linearized ? 'linéarisé' : 'non linéarisé'} ·{' '}
          {file.incremental > 0 ? `${file.incremental} révision(s)` : 'écriture unique'}
          {file.pageSizes[0] ? ` · ${file.pageSizes[0].w} × ${file.pageSizes[0].h} mm` : ''}
        </p>
      </section>
    </article>
  );
}
