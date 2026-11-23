import type { Thresholds } from './thresholds';

export type Severity = 'critical' | 'warning' | 'info';

export type Category = 'fonts' | 'images' | 'colors' | 'exotic' | 'structure' | 'pages' | 'text';

export type Verdict = 'ok' | 'check' | 'ko';

export interface Finding {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  detail: string;
  advice?: string;
  evidence?: string[];
  pages?: number[];
}

export interface FontInfo {
  name: string;
  subtype: string;
  embedded: boolean;
  type3: boolean;
  subset: boolean;
  toUnicode: boolean;
  encoding?: string;
  used: boolean;
  pages: number[];
}

export interface ImageInfo {
  page: number;
  name?: string;
  width: number;
  height: number;
  bits: number;
  filter: string;
  colorSpace: string;
  dpi: number | null;
  placedW: number | null;
  placedH: number | null;
  bytes: number;
  smask: boolean;
  mask: boolean;
  imageMask: boolean;
  interpolate: boolean;
  spot?: string;
}

export interface ColorInfo {
  space: string;
  spot?: string;
  count: number;
  pages: number[];
}

export interface ExoticItem {
  kind: string;
  label: string;
  detail?: string;
  size?: number;
  pages?: number[];
}

export interface PageSizeBucket {
  label: string;
  w: number;
  h: number;
  count: number;
}

export interface DocInfo {
  name: string;
  size: number;
  pages: number;
  version: string;
  producer?: string;
  creator?: string;
  created?: string;
  encrypted: boolean;
  linearized: boolean;
  pdfa: boolean;
  pdfx: boolean;
  pageSizes: PageSizeBucket[];
  hasTrim: boolean;
  hasBleed: boolean;
  incremental: number;
  transparency: boolean;
  overprint: boolean;
  layers: boolean;
}

export interface ReportStats {
  fonts: number;
  fontsNotEmbedded: number;
  images: number;
  imagesLowDpi: number;
  minDpi: number | null;
  spots: number;
  javascript: number;
  embeddedFiles: number;
  svg: number;
  imageBytes: number;
  maxImageBytes: number;
}

export interface TextStats {
  chars: number;
  missingGlyphs: number;
  pages: number;
}

export interface Report {
  file: DocInfo;
  text?: TextStats;
  /** Seuils appliqués, joints au rapport pour la traçabilité. */
  thresholds: Thresholds;
  profile: { id: string; label: string };
  verdict: Verdict;
  score: number;
  findings: Finding[];
  fonts: FontInfo[];
  images: ImageInfo[];
  colors: ColorInfo[];
  exotic: ExoticItem[];
  stats: ReportStats;
  elapsedMs: number;
  degraded?: boolean;
}

export interface TextPage {
  page: number;
  text: string;
  missingGlyphs: number;
}

export interface AnalyzeOptions {
  onProgress?: (done: number, total: number, label: string) => void;
  extractText?: (bytes: Uint8Array, onPage?: (page: number) => void) => Promise<TextPage[]>;
  maxTextPages?: number;
}

export const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

export const CATEGORY_LABEL: Record<Category, string> = {
  fonts: 'Typographies',
  images: 'Images',
  colors: 'Couleurs & profils',
  exotic: 'Contenu exotique',
  structure: 'Structure',
  pages: 'Pages & format',
  text: 'Texte & glyphes',
};
