import { useRef } from 'react';

interface Props {
  version: string;
  isDesktopApp: boolean;
  onFiles: (files: File[]) => void;
  onBrowse: () => void;
}

const MARK = (
  <svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <path d="M12 1.5v9M1.5 12h9M22 1.5v9M32.5 12h-9M12 32.5v-9M1.5 22h9M22 32.5v-9M32.5 22h-9" />
    <rect x="12" y="12" width="10" height="10" strokeWidth="1" opacity="0.45" />
  </svg>
);

export default function DropZone({ version, isDesktopApp, onFiles, onBrowse }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="intro">
      <div className="intro-inner">
        <div className="eyebrow">
          <span className="mono">Pré-vol PDF · Konica AccurioPrint C4065</span>
          <span className="rule" />
          <span className="mono">v{version}</span>
        </div>

        <h1>
          Déposez vos PDF.
          <br />
          <em>Le reste est vérifié.</em>
        </h1>

        <p className="lede">
          Un pré-vol complet en local : polices, images, couleurs, transparence et contenu exotique.
          Le fichier est lu sur votre machine, jamais envoyé.
        </p>

        <div
          className="drop"
          role="button"
          tabIndex={0}
          aria-label="Déposer ou choisir des PDF à analyser"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.currentTarget.classList.add('is-over');
          }}
          onDragLeave={(event) => event.currentTarget.classList.remove('is-over')}
          onDrop={(event) => {
            event.preventDefault();
            event.currentTarget.classList.remove('is-over');
            event.stopPropagation();
            onFiles(Array.from(event.dataTransfer.files));
          }}
        >
          {MARK}
          <span className="drop-title">Glissez vos fichiers ici</span>
          <span className="drop-sub">
            <span>Analyse immédiate, plusieurs fichiers acceptés</span>
            <span className="sep" />
            <button
              type="button"
              className="linklike"
              onClick={(event) => {
                event.stopPropagation();
                onBrowse();
              }}
            >
              Parcourir…
            </button>
          </span>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) onFiles(Array.from(event.target.files));
              event.target.value = '';
            }}
          />
        </div>

        <div className="capabilities">
          <div>
            <strong>Polices</strong>
            <span>embarquement, Type 3, glyphes manquants</span>
          </div>
          <div>
            <strong>Images</strong>
            <span>dpi réels, poids, JPX / JBIG2</span>
          </div>
          <div>
            <strong>Couleurs</strong>
            <span>tons directs, ICC, transparence</span>
          </div>
          <div>
            <strong>Contenu exotique</strong>
            <span>SVG, code, JavaScript, pièces jointes</span>
          </div>
        </div>

        <div className="intro-foot">
          <span>{isDesktopApp ? 'Application de bureau · traitement 100 % local' : 'Version web · traitement 100 % local'}</span>
          <span>Aucun envoi serveur · aucune donnée conservée</span>
        </div>
      </div>
    </div>
  );
}
