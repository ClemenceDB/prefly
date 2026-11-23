/**
 * Seuils de pré-vol calibrés pour l'atelier : Konica AccurioPrint C4065
 * avec RIP Fiery à jour (impression toner quadri, A3+, 300 dpi natives).
 *
 * Les valeurs sont volontairement plus strictes qu'un simple contrôle PDF/X :
 * l'objectif est d'éviter les fichiers qui saturent la mémoire du RIP ou qui
 * imposent une substitution de police. Elles sont modifiables depuis les
 * préférences de l'application.
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
  bleed: {
    /** Fonds perdus minimum attendu, en millimètres. */
    minMm: number;
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

export const DEFAULT_THRESHOLDS: Thresholds = {
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
  bleed: {
    minMm: 3,
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

/** Compatibilité : valeurs par défaut exposées sous l'ancien nom. */
export const THRESHOLDS = DEFAULT_THRESHOLDS;

export function cloneThresholds(source: Thresholds = DEFAULT_THRESHOLDS): Thresholds {
  return JSON.parse(JSON.stringify(source)) as Thresholds;
}

export interface ThresholdField {
  path: string;
  label: string;
  hint?: string;
  kind: 'dpi' | 'mm' | 'mb' | 'pages' | 'count';
  min: number;
  max: number;
  step: number;
  group: 'images' | 'fichier' | 'pages' | 'polices';
}

/** Champs éditables dans la fenêtre de préférences (chemins pointés). */
export const THRESHOLD_FIELDS: ThresholdField[] = [
  {
    path: 'image.dpiWarning',
    label: 'Résolution : alerte',
    hint: 'En dessous, l’image est signalée.',
    kind: 'dpi',
    min: 72,
    max: 400,
    step: 1,
    group: 'images',
  },
  {
    path: 'image.dpiCritical',
    label: 'Résolution : bloquant',
    hint: 'En dessous, l’image est inexploitable.',
    kind: 'dpi',
    min: 36,
    max: 300,
    step: 1,
    group: 'images',
  },
  {
    path: 'image.dpiIdeal',
    label: 'Résolution cible',
    hint: 'Valeur recommandée pour l’impression.',
    kind: 'dpi',
    min: 150,
    max: 600,
    step: 1,
    group: 'images',
  },
  {
    path: 'image.dpiExcessive',
    label: 'Sur-échantillonnage',
    hint: 'Au-delà, l’image est inutilement lourde.',
    kind: 'dpi',
    min: 300,
    max: 1200,
    step: 10,
    group: 'images',
  },
  {
    path: 'image.heavyBytes',
    label: 'Poids d’une image : alerte',
    hint: 'Poids isolé d’un bitmap.',
    kind: 'mb',
    min: 1,
    max: 100,
    step: 1,
    group: 'images',
  },
  {
    path: 'image.heavyCriticalBytes',
    label: 'Poids d’une image : bloquant',
    kind: 'mb',
    min: 2,
    max: 300,
    step: 1,
    group: 'images',
  },
  {
    path: 'image.megapixels',
    label: 'Surface maximale d’un bitmap',
    hint: 'En millions de pixels.',
    kind: 'count',
    min: 10,
    max: 300,
    step: 1,
    group: 'images',
  },
  {
    path: 'file.sizeWarningBytes',
    label: 'Poids du fichier : alerte',
    kind: 'mb',
    min: 10,
    max: 2000,
    step: 10,
    group: 'fichier',
  },
  {
    path: 'file.sizeCriticalBytes',
    label: 'Poids du fichier : bloquant',
    kind: 'mb',
    min: 20,
    max: 4000,
    step: 10,
    group: 'fichier',
  },
  {
    path: 'bleed.minMm',
    label: 'Fonds perdus minimum',
    hint: 'Débord du BleedBox au-delà du TrimBox.',
    kind: 'mm',
    min: 0,
    max: 20,
    step: 0.5,
    group: 'fichier',
  },
  {
    path: 'pages.many',
    label: 'Volume : signalement',
    kind: 'pages',
    min: 10,
    max: 2000,
    step: 10,
    group: 'pages',
  },
  {
    path: 'pages.heavy',
    label: 'Volume : alerte mémoire',
    kind: 'pages',
    min: 20,
    max: 5000,
    step: 10,
    group: 'pages',
  },
  {
    path: 'fonts.many',
    label: 'Nombre de polices',
    hint: 'Au-delà, la charte typographique est signalée.',
    kind: 'count',
    min: 2,
    max: 60,
    step: 1,
    group: 'polices',
  },
  {
    path: 'compress.targetDpi',
    label: 'Compression : dpi conservés',
    kind: 'dpi',
    min: 96,
    max: 600,
    step: 10,
    group: 'images',
  },
];

export const THRESHOLD_UNITS: Record<ThresholdField['kind'], string> = {
  dpi: 'dpi',
  mm: 'mm',
  mb: 'Mo',
  pages: 'pages',
  count: '',
};

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value && typeof value === 'object') return (value as Record<string, unknown>)[key];
    return undefined;
  }, source);
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const next = cursor[key];
    if (!next || typeof next !== 'object') cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
}

/** Poids affiché en mégaoctets (base 1024) converti en octets. */
export function mbToBytes(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}

export function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

export function megapixelsToPixels(mpx: number): number {
  return Math.round(mpx * 1_000_000);
}

/** Valeur d'un champ, exprimée dans son unité d'affichage. */
export function fieldValue(thresholds: Thresholds, field: ThresholdField): number {
  const raw = readPath(thresholds, field.path);
  const value = typeof raw === 'number' ? raw : 0;
  if (field.kind === 'mb') return bytesToMb(value);
  if (field.path.endsWith('megapixels')) return Math.round((value / 1_000_000) * 10) / 10;
  return value;
}

/** Écrit une valeur d'affichage dans les seuils, avec bornage et cohérence. */
export function setFieldValue(
  thresholds: Thresholds,
  field: ThresholdField,
  display: number,
): Thresholds {
  const next = cloneThresholds(thresholds);
  const clamped = Math.min(field.max, Math.max(field.min, display));
  let stored: number = clamped;
  if (field.kind === 'mb') stored = mbToBytes(clamped);
  else if (field.path.endsWith('megapixels')) stored = megapixelsToPixels(clamped);
  writePath(next as unknown as Record<string, unknown>, field.path, stored);
  return normalizeThresholds(next);
}

/** Garde les seuils cohérents entre eux (ordre croissant, cible ≥ alerte…). */
export function normalizeThresholds(input: Thresholds): Thresholds {
  const next = cloneThresholds(input);
  const d = DEFAULT_THRESHOLDS;
  const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  next.image.dpiCritical = num(next.image.dpiCritical, d.image.dpiCritical);
  next.image.dpiWarning = num(next.image.dpiWarning, d.image.dpiWarning);
  next.image.dpiIdeal = num(next.image.dpiIdeal, d.image.dpiIdeal);
  next.image.dpiExcessive = num(next.image.dpiExcessive, d.image.dpiExcessive);
  next.image.heavyBytes = num(next.image.heavyBytes, d.image.heavyBytes);
  next.image.heavyCriticalBytes = num(next.image.heavyCriticalBytes, d.image.heavyCriticalBytes);
  next.image.megapixels = num(next.image.megapixels, d.image.megapixels);
  next.image.dominanceRatio = Math.min(
    1,
    Math.max(0.2, num(next.image.dominanceRatio, d.image.dominanceRatio)),
  );
  next.image.dominanceMinBytes = num(next.image.dominanceMinBytes, d.image.dominanceMinBytes);

  next.file.sizeWarningBytes = num(next.file.sizeWarningBytes, d.file.sizeWarningBytes);
  next.file.sizeCriticalBytes = num(next.file.sizeCriticalBytes, d.file.sizeCriticalBytes);
  next.pages.many = Math.max(1, num(next.pages.many, d.pages.many));
  next.pages.heavy = Math.max(2, num(next.pages.heavy, d.pages.heavy));
  next.fonts.many = Math.max(1, num(next.fonts.many, d.fonts.many));
  next.bleed.minMm = Math.max(0, num(next.bleed.minMm, d.bleed.minMm));
  next.compress.targetDpi = num(next.compress.targetDpi, d.compress.targetDpi);
  next.compress.toleranceDpi = Math.max(
    0,
    num(next.compress.toleranceDpi, d.compress.toleranceDpi),
  );
  next.raster.defaultDpi = num(next.raster.defaultDpi, d.raster.defaultDpi);
  if (!Array.isArray(next.raster.choices) || next.raster.choices.length === 0) {
    next.raster.choices = [...d.raster.choices];
  }

  // Ordre attendu : bloquant < alerte < cible < excessif.
  if (next.image.dpiCritical >= next.image.dpiWarning) {
    next.image.dpiCritical = Math.max(36, next.image.dpiWarning - 20);
  }
  if (next.image.dpiIdeal <= next.image.dpiWarning) next.image.dpiIdeal = next.image.dpiWarning + 50;
  if (next.image.dpiExcessive <= next.image.dpiIdeal) {
    next.image.dpiExcessive = next.image.dpiIdeal + 150;
  }
  if (next.image.heavyCriticalBytes <= next.image.heavyBytes) {
    next.image.heavyCriticalBytes = next.image.heavyBytes * 2;
  }
  if (next.file.sizeCriticalBytes <= next.file.sizeWarningBytes) {
    next.file.sizeCriticalBytes = Math.round(next.file.sizeWarningBytes * 1.5);
  }
  if (next.pages.heavy <= next.pages.many) next.pages.heavy = next.pages.many * 2;
  return next;
}

/** Fusion tolérante d'un JSON inconnu (localStorage, fichier importé…) avec les défauts. */
export function mergeThresholds(raw: unknown): Thresholds {
  if (!raw || typeof raw !== 'object') return cloneThresholds();
  const source = raw as Partial<Thresholds>;
  const base = cloneThresholds();
  for (const key of Object.keys(base) as (keyof Thresholds)[]) {
    const value = source[key];
    if (value && typeof value === 'object') {
      Object.assign(base[key] as unknown as Record<string, unknown>, value);
    }
  }
  return normalizeThresholds(base);
}

const STORAGE_KEY = 'prefly.thresholds.v1';

export function loadThresholds(): Thresholds {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!stored) return cloneThresholds();
    return mergeThresholds(JSON.parse(stored));
  } catch {
    return cloneThresholds();
  }
}

export function saveThresholds(thresholds: Thresholds): Thresholds {
  const normalized = normalizeThresholds(thresholds);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* stockage indisponible (mode privé) : les seuils restent en mémoire */
  }
  return normalized;
}

export function resetThresholds(): Thresholds {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  return cloneThresholds();
}

export function isDefaultThresholds(thresholds: Thresholds): boolean {
  return (
    JSON.stringify(normalizeThresholds(thresholds)) ===
    JSON.stringify(normalizeThresholds(DEFAULT_THRESHOLDS))
  );
}

export interface ThresholdSummaryLine {
  label: string;
  value: string;
}

/** Lignes lisibles, affichées dans le rapport et exportées en JSON/PDF. */
export function thresholdSummary(t: Thresholds = DEFAULT_THRESHOLDS): ThresholdSummaryLine[] {
  return [
    { label: 'Images · alerte', value: `sous ${t.image.dpiWarning} dpi` },
    { label: 'Images · bloquant', value: `sous ${t.image.dpiCritical} dpi` },
    { label: 'Images · cible', value: `${t.image.dpiIdeal} dpi à taille finale` },
    { label: 'Images · sur-échantillonnage', value: `au-delà de ${t.image.dpiExcessive} dpi` },
    {
      label: 'Image isolée',
      value: `> ${mega(t.image.heavyBytes)} (bloquant > ${mega(t.image.heavyCriticalBytes)})`,
    },
    { label: 'Bitmap', value: `> ${Math.round(t.image.megapixels / 1_000_000)} Mpx` },
    {
      label: 'Fichier',
      value: `> ${mega(t.file.sizeWarningBytes)} (bloquant > ${mega(t.file.sizeCriticalBytes)})`,
    },
    { label: 'Fonds perdus', value: `minimum ${t.bleed.minMm} mm` },
    { label: 'Volume', value: `${t.pages.many} pages signalées, ${t.pages.heavy} pages lourdes` },
    { label: 'Polices', value: `alerte au-delà de ${t.fonts.many} polices` },
    { label: 'Compression', value: `conserve ${t.compress.targetDpi} dpi` },
  ];
}

function mega(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} Mo`;
}
