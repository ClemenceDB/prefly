import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_THRESHOLDS,
  THRESHOLD_FIELDS,
  THRESHOLD_UNITS,
  PROFILE_LABEL,
  cloneThresholds,
  fieldValue,
  isDefaultThresholds,
  normalizeThresholds,
  setFieldValue,
  type ThresholdField,
  type Thresholds,
} from '../core/thresholds';

interface Props {
  open: boolean;
  thresholds: Thresholds;
  onClose: () => void;
  onSave: (thresholds: Thresholds) => void;
  onReset: () => void;
}

const GROUP_LABEL: Record<ThresholdField['group'], { title: string; note: string }> = {
  images: {
    title: 'Images',
    note: 'Résolution et poids des bitmaps, et résolution conservée à la compression.',
  },
  fichier: {
    title: 'Fichier et fonds perdus',
    note: 'Poids du PDF et débord minimal entre TrimBox et BleedBox.',
  },
  pages: {
    title: 'Volume',
    note: 'Nombre de pages à partir duquel le RIP est sollicité.',
  },
  polices: {
    title: 'Typographies',
    note: 'Diversité typographique tolérée dans un même document.',
  },
};

export default function Preferences({ open, thresholds, onClose, onSave, onReset }: Props) {
  const [draft, setDraft] = useState<Thresholds>(thresholds);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (open) setDraft(cloneThresholds(thresholds));
  }, [open, thresholds]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        onSave(normalizeThresholds(draft));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, draft, onClose, onSave]);

  const groups = useMemo(() => {
    const order: ThresholdField['group'][] = ['images', 'fichier', 'pages', 'polices'];
    return order.map((group) => ({
      group,
      fields: THRESHOLD_FIELDS.filter((field) => field.group === group),
    }));
  }, []);

  if (!open) return null;

  const defaults = isDefaultThresholds(draft);
  const dirty = JSON.stringify(normalizeThresholds(draft)) !== JSON.stringify(normalizeThresholds(thresholds));

  return (
    <div
      className="modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prefs-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-panel">
        <header className="modal-head">
          <div>
            <span className="mono">Préférences · {PROFILE_LABEL}</span>
            <h2 id="prefs-title">Seuils du pré-vol</h2>
          </div>
          <button type="button" className="modal-close" aria-label="Fermer" onClick={onClose}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <p className="modal-lede">
            Ces valeurs s’appliquent à toutes les analyses suivantes et sont enregistrées sur cet
            appareil. Les rapports déjà ouverts sont réanalysés automatiquement.
          </p>

          {groups.map(({ group, fields }) => (
            <section key={group} className="prefs-group">
              <div className="prefs-group-head">
                <h3>{GROUP_LABEL[group].title}</h3>
                <span>{GROUP_LABEL[group].note}</span>
              </div>
              <div className="prefs-grid">
                {fields.map((field) => {
                  const value = fieldValue(draft, field);
                  const unit = THRESHOLD_UNITS[field.kind];
                  return (
                    <label key={field.path} className="prefs-field">
                      <span className="prefs-label">{field.label}</span>
                      <span className="prefs-input">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={field.min}
                          max={field.max}
                          step={field.step}
                          value={value}
                          aria-label={field.label}
                          onChange={(event) => {
                            const parsed = Number(event.target.value);
                            if (!Number.isFinite(parsed)) return;
                            setDraft((current) => setFieldValue(current, field, parsed));
                          }}
                        />
                        {unit && <em>{unit}</em>}
                      </span>
                      {field.hint && <small>{field.hint}</small>}
                    </label>
                  );
                })}
              </div>
            </section>
          ))}

          <details
            className="prefs-advanced"
            open={showAdvanced}
            onToggle={(event) => setShowAdvanced((event.target as HTMLDetailsElement).open)}
          >
            <summary>Valeurs par défaut du profil</summary>
            <ul className="evidence">
              <li>Images — alerte sous {DEFAULT_THRESHOLDS.image.dpiWarning} dpi, bloquant sous {DEFAULT_THRESHOLDS.image.dpiCritical} dpi</li>
              <li>
                Image isolée — {Math.round(DEFAULT_THRESHOLDS.image.heavyBytes / 1048576)} Mo (bloquant{' '}
                {Math.round(DEFAULT_THRESHOLDS.image.heavyCriticalBytes / 1048576)} Mo), bitmap{' '}
                {Math.round(DEFAULT_THRESHOLDS.image.megapixels / 1_000_000)} Mpx
              </li>
              <li>
                Fichier — {Math.round(DEFAULT_THRESHOLDS.file.sizeWarningBytes / 1048576)} Mo (bloquant{' '}
                {Math.round(DEFAULT_THRESHOLDS.file.sizeCriticalBytes / 1048576)} Mo)
              </li>
              <li>
                Volume — {DEFAULT_THRESHOLDS.pages.many} pages signalées, {DEFAULT_THRESHOLDS.pages.heavy} pages lourdes
              </li>
              <li>Fonds perdus — minimum {DEFAULT_THRESHOLDS.bleed.minMm} mm</li>
              <li>Polices — alerte au-delà de {DEFAULT_THRESHOLDS.fonts.many}</li>
              <li>Compression — conserve {DEFAULT_THRESHOLDS.compress.targetDpi} dpi</li>
            </ul>
          </details>
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onReset} disabled={defaults}>
            Réinitialiser
          </button>
          <span className="grow" />
          <span className="mono">{dirty ? 'Modifications non enregistrées' : 'À jour'}</span>
          <button type="button" className="btn" onClick={onClose}>
            Annuler
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onSave(normalizeThresholds(draft))}
          >
            Enregistrer
          </button>
        </footer>
      </div>
    </div>
  );
}
