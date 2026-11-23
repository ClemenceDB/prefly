/**
 * Seuils de pré-vol calibrés pour l'atelier : Konica AccurioPrint C4065
 * avec RIP Fiery à jour (impression toner quadri, A3+, 300 dpi natives).
 *
 * Les valeurs sont volontairement plus strictes qu'un simple contrôle PDF/X :
 * l'objectif est d'éviter les fichiers qui saturent la mémoire du RIP ou qui
 * imposent une substitution de police.
 */
export interface Thresholds {
  image: {
    /** En dessous : pixellisation visible. */
    dpiCritical: number;
    /** En dessous : alerte. */
    dpiWarning: number;
    /** Cible recommandée pour l'impression. */
    dpiIdeal: number;
    /** Au-delà : poids inutile, décodage lent. */
    dpiExcessive: number;
    /** Poids d'une image seule déclenchant une alerte. */
    heavyBytes: number;
    /** Poids d'une image seule déclenchant un blocage. */
    heavyCriticalBytes: number;
    /** Surface en pixels au-delà de laquelle un bitmap sature la mémoire. */
    megapixels: number;
    /** Part du fichier occupée par les images pour le signaler. */
    dominanceRatio: number;
    /** Taille minimale du fichier pour que la dominance soit pertinente. */
    dominanceMinBytes: number;
  };
  file: {
    /** Taille du PDF au-delà de laquelle le transfert au RIP devient risqué. */
    sizeWarningBytes: number;
    /** Taille au-delà de laquelle le RIP peut refuser le fichier. */
    sizeCriticalBytes: number;
  };
  pages: {
    /** Nombre de pages à partir duquel on signale le volume. */
    many: number;
    /** Nombre de pages qui pèse réellement sur la mémoire du RIP. */
    heavy: number;
  };
  fonts: {
    /** Nombre de polices différentes avant alerte. */
    many: number;
  };
  compress: {
    /** Résolution conservée lors de la compression (images au-delà réencodées). */
    targetDpi: number;
    /** Marge de tolérance avant réencodage. */
    toleranceDpi: number;
  };
  raster: {
    /** Résolution proposée par défaut. */
    defaultDpi: number;
    /** Valeurs proposées dans le menu. */
    choices: number[];
  };
}

export const PROFILE_ID = 'konica-c4065';

export const PROFILE_LABEL = 'Konica AccurioPrint C4065 · RIP Fiery';

export const THRESHOLDS: Thresholds = {
  image: {
    dpiCritical: 120,
    dpiWarning: 200,
    dpiIdeal: 300,
    dpiExcessive: 450,
    heavyBytes: 10 * 1024 * 1024,
    heavyCriticalBytes: 25 * 1024 * 1024,
    megapixels: 50_000_000,
    dominanceRatio: 0.7,
    dominanceMinBytes: 20 * 1024 * 1024,
  },
  file: {
    sizeWarningBytes: 120 * 1024 * 1024,
    sizeCriticalBytes: 250 * 1024 * 1024,
  },
  pages: {
    many: 120,
    heavy: 250,
  },
  fonts: {
    many: 12,
  },
  compress: {
    targetDpi: 300,
    toleranceDpi: 15,
  },
  raster: {
    defaultDpi: 200,
    choices: [150, 200, 300],
  },
};

export interface ThresholdSummaryLine {
  label: string;
  value: string;
}

/** Lignes lisibles, affichées dans le rapport et exportées en JSON. */
export function thresholdSummary(t: Thresholds = THRESHOLDS): ThresholdSummaryLine[] {
  return [
    { label: 'Images · alerte', value: `sous ${t.image.dpiWarning} dpi` },
    { label: 'Images · bloquant', value: `sous ${t.image.dpiCritical} dpi` },
    { label: 'Images · cible', value: `${t.image.dpiIdeal} dpi à taille finale` },
    { label: 'Images · sur-échantillonnage', value: `au-delà de ${t.image.dpiExcessive} dpi` },
    { label: 'Image isolée', value: `> ${mega(t.image.heavyBytes)} (bloquant > ${mega(t.image.heavyCriticalBytes)})` },
    { label: 'Bitmap', value: `> ${Math.round(t.image.megapixels / 1_000_000)} Mpx` },
    { label: 'Fichier', value: `> ${mega(t.file.sizeWarningBytes)} (bloquant > ${mega(t.file.sizeCriticalBytes)})` },
    { label: 'Volume', value: `${t.pages.many} pages signalées, ${t.pages.heavy} pages lourdes` },
    { label: 'Polices', value: `alerte au-delà de ${t.fonts.many} polices` },
    { label: 'Compression', value: `conserve ${t.compress.targetDpi} dpi` },
  ];
}

function mega(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} Mo`;
}
