import { PDFDict, PDFName, type PDFContext, type PDFDocument } from 'pdf-lib';
import { CODE_LABEL, detectCode, type CodeKind } from './code';
import {
  buildEnv,
  colorSpaceName,
  pageContentStreams,
  scanContent,
  type ColorDescriptor,
  type PageScan,
} from './content';
import {
  asArray,
  asDict,
  asStream,
  collectPages,
  documentInfoDict,
  get,
  loadPdf,
  nameOf,
  numOf,
  resolve,
  strOf,
  type PageInfo,
} from './pdfdoc';
import { rawScan, type RawScan } from './rawscan';
import type {
  AnalyzeOptions,
  ColorInfo,
  DocInfo,
  ExoticItem,
  Finding,
  FontInfo,
  ImageInfo,
  PageSizeBucket,
  Report,
  ReportStats,
  Severity,
  TextPage,
} from './types';
import { DEFAULT_THRESHOLDS, PROFILE_ID, PROFILE_LABEL, type Thresholds } from './thresholds';
import { SEVERITY_ORDER } from './types';
import {
  cleanFontName,
  clamp,
  formatMm,
  formatPageSize,
  humanBytes,
  humanNumber,
  isSubsetName,
  latin1,
  truncate,
  unique,
} from './utils';

const FONT_SUBTYPES = new Set(['Type0', 'Type1', 'MMType1', 'TrueType', 'Type3']);
const ANNOT_RISK: Record<string, string> = {
  '3D': 'annotation 3D',
  RichMedia: 'annotation RichMedia (vidéo / web)',
  Movie: 'annotation vidéo',
  Sound: 'annotation audio',
  Screen: 'annotation multimédia',
  FileAttachment: 'pièce jointe',
  Widget: 'champ de formulaire',
};

export interface AnalyzeInput {
  name: string;
  bytes: Uint8Array;
  size?: number;
}

type Collector = {
  findings: Finding[];
  exotic: ExoticItem[];
  stats: ReportStats;
  add: (finding: Finding) => void;
  item: (item: ExoticItem) => void;
  bump: (key: keyof ReportStats, by?: number) => void;
};

function createCollector(): Collector {
  const findings: Finding[] = [];
  const exotic: ExoticItem[] = [];
  const stats: ReportStats = {
    fonts: 0,
    fontsNotEmbedded: 0,
    images: 0,
    imagesLowDpi: 0,
    minDpi: null,
    spots: 0,
    javascript: 0,
    embeddedFiles: 0,
    svg: 0,
    imageBytes: 0,
    maxImageBytes: 0,
  };
  return {
    findings,
    exotic,
    stats,
    add: (finding) => findings.push(finding),
    item: (item) => {
      if (!exotic.some((e) => e.kind === item.kind && e.label === item.label)) exotic.push(item);
    },
    bump: (key, by = 1) => {
      if (key === 'minDpi' || key === 'maxImageBytes') return;
      stats[key] = (stats[key] as number) + by;
    },
  };
}

function formatPdfDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?/.exec(value.trim());
  if (!match) return undefined;
  const [, year, month, day] = match;
  if (!month) return year;
  const date = `${day ?? '01'}/${month}/${year}`;
  return date;
}


interface SourceGuess {
  name: string;
  family: string;
}

/** Reconnaît le logiciel d'origine à partir des métadonnées du PDF. */
export function guessSourceApp(producer?: string, creator?: string): SourceGuess | undefined {
  const haystack = `${producer ?? ''} ${creator ?? ''}`;
  if (!haystack.trim()) return undefined;
  const rules: { pattern: RegExp; name: string; family: string }[] = [
    { pattern: /adobe indesign/i, name: 'Adobe InDesign', family: 'mise en page' },
    { pattern: /adobe illustrator/i, name: 'Adobe Illustrator', family: 'illustration' },
    { pattern: /adobe photoshop/i, name: 'Adobe Photoshop', family: 'image' },
    { pattern: /adobe acrobat/i, name: 'Adobe Acrobat', family: 'PDF' },
    { pattern: /adobe incopy/i, name: 'Adobe InCopy', family: 'mise en page' },
    { pattern: /distiller/i, name: 'Adobe Distiller', family: 'PDF' },
    { pattern: /figma/i, name: 'Figma', family: 'interface' },
    { pattern: /canva/i, name: 'Canva', family: 'web' },
    { pattern: /sketch/i, name: 'Sketch', family: 'interface' },
    { pattern: /affinity (publisher|designer|photo)/i, name: 'Affinity', family: 'PAO' },
    { pattern: /scribus/i, name: 'Scribus', family: 'PAO' },
    { pattern: /quarkxpress/i, name: 'QuarkXPress', family: 'mise en page' },
    { pattern: /microsoft (word|powerpoint|excel)/i, name: 'Microsoft Office', family: 'bureautique' },
    { pattern: /libreoffice|openoffice/i, name: 'LibreOffice', family: 'bureautique' },
    { pattern: /google (docs|slides|chrome)/i, name: 'Google Workspace', family: 'web' },
    { pattern: /craft|craftdesign/i, name: 'Craft', family: 'design' },
    { pattern: /pixelmator/i, name: 'Pixelmator', family: 'image' },
    { pattern: /coreldraw/i, name: 'CorelDRAW', family: 'illustration' },
    { pattern: /pdf-?lib|pdfkit|jspdf|puppeteer|playwright|chrome headless|skia/i, name: 'export automatique (navigateur / bibliothèque)', family: 'généré' },
    { pattern: /latex|tex/i, name: 'LaTeX', family: 'composition' },
    { pattern: /ghostscript/i, name: 'Ghostscript', family: 'conversion' },
    { pattern: /reportlab/i, name: 'ReportLab', family: 'généré' },
    { pattern: /mac os x.*quartz|quartz pdfcontext/i, name: 'Quartz (macOS)', family: 'système' },
    { pattern: /cups/i, name: 'CUPS (impression système)', family: 'système' },
  ];
  for (const rule of rules) {
    if (rule.pattern.test(haystack)) return { name: rule.name, family: rule.family };
  }
  const first = (producer ?? creator ?? '').trim();
  if (!first) return undefined;
  return { name: first.slice(0, 60), family: 'non identifié' };
}

function fontDescriptorOf(ctx: PDFContext, font: PDFDict): PDFDict | undefined {
  const direct = asDict(get(ctx, font, 'FontDescriptor'));
  if (direct) return direct;
  const descendants = asArray(get(ctx, font, 'DescendantFonts'));
  if (!descendants) return undefined;
  for (let i = 0; i < descendants.size(); i += 1) {
    const descendant = asDict(resolve(ctx, descendants.get(i)));
    const descriptor = asDict(get(ctx, descendant, 'FontDescriptor'));
    if (descriptor) return descriptor;
  }
  return undefined;
}

function buildFontInfo(ctx: PDFContext, font: PDFDict): FontInfo {
  const subtype = nameOf(get(ctx, font, 'Subtype')) ?? 'Inconnu';
  const rawName = strOf(get(ctx, font, 'BaseFont')) ?? nameOf(get(ctx, font, 'BaseFont'));
  const baseFont = rawName ?? (subtype === 'Type3' ? 'Police Type 3' : 'Police sans nom');
  const descriptor = fontDescriptorOf(ctx, font);
  const type3 = subtype === 'Type3';
  const embedded =
    type3 ||
    Boolean(
      descriptor &&
        (get(ctx, descriptor, 'FontFile') || get(ctx, descriptor, 'FontFile2') || get(ctx, descriptor, 'FontFile3')),
    );
  const encodingValue = get(ctx, font, 'Encoding');
  const encodingName =
    nameOf(encodingValue) ??
    nameOf(get(ctx, asDict(encodingValue), 'BaseEncoding')) ??
    (asDict(encodingValue) ? 'Encoding personnalisé' : undefined);
  return {
    name: cleanFontName(baseFont),
    subtype,
    embedded,
    type3,
    subset: isSubsetName(baseFont),
    toUnicode: Boolean(get(ctx, font, 'ToUnicode')),
    encoding: encodingName,
    used: false,
    pages: [],
  };
}

function describeFilters(ctx: PDFContext, dict: PDFDict): string {
  const filter = get(ctx, dict, 'Filter');
  const single = nameOf(filter);
  if (single) return single;
  const array = asArray(filter);
  if (!array) return '—';
  const names: string[] = [];
  for (let i = 0; i < array.size(); i += 1) {
    const name = nameOf(array.get(i));
    if (name) names.push(name);
  }
  return names.join('+') || '—';
}

function walkNameTree(ctx: PDFContext, node: PDFDict | undefined, depth = 0): number {
  if (!node || depth > 16) return 0;
  let count = 0;
  const names = asArray(get(ctx, node, 'Names'));
  if (names) count += Math.floor(names.size() / 2);
  const kids = asArray(get(ctx, node, 'Kids'));
  if (kids) {
    for (let i = 0; i < kids.size(); i += 1) {
      count += walkNameTree(ctx, asDict(resolve(ctx, kids.get(i))), depth + 1);
    }
  }
  return count;
}

interface TextSource {
  page: number;
  text: string;
}

function segmentsOf(sources: TextSource[]): { text: string; bounds: { page: number; start: number; end: number }[] } {
  let text = '';
  const bounds: { page: number; start: number; end: number }[] = [];
  for (const source of sources) {
    if (!source.text.trim()) continue;
    const start = text.length;
    text += `${source.text}\n`;
    bounds.push({ page: source.page, start, end: text.length });
  }
  return { text, bounds };
}

function pageAt(bounds: { page: number; start: number; end: number }[], index: number): number | undefined {
  for (const bound of bounds) {
    if (index >= bound.start && index <= bound.end) return bound.page;
  }
  return bounds.length ? bounds[bounds.length - 1].page : undefined;
}

interface CodeAggregate {
  kind: CodeKind;
  pages: Set<number>;
  snippets: string[];
  strong: boolean;
  source: 'text' | 'content';
}

function codeFindings(sources: TextSource[], source: 'text' | 'content'): Finding[] {
  const { text, bounds } = segmentsOf(sources);
  if (!text.trim()) return [];
  const matches = detectCode(text);
  const aggregates = new Map<CodeKind, CodeAggregate>();
  for (const match of matches) {
    const existing = aggregates.get(match.kind);
    const page = pageAt(bounds, match.index);
    if (existing) {
      if (page) existing.pages.add(page);
      const known = existing.snippets.some(
        (snippet) => snippet.slice(0, 48) === match.snippet.slice(0, 48),
      );
      if (existing.snippets.length < 3 && !known) existing.snippets.push(match.snippet);
      existing.strong = existing.strong || match.strong;
      if (source === 'text') existing.source = 'text';
    } else {
      aggregates.set(match.kind, {
        kind: match.kind,
        pages: new Set(page ? [page] : []),
        snippets: [match.snippet],
        strong: match.strong,
        source,
      });
    }
  }

  const findings: Finding[] = [];
  for (const aggregate of aggregates.values()) {
    if (!aggregate.strong) {
      findings.push({
        id: `code-weak-${aggregate.kind}`,
        severity: 'info',
        category: 'text',
        title: `Motif de type ${CODE_LABEL[aggregate.kind]} repéré dans le texte`,
        detail:
          'Un fragment ressemble à du code ou à un balisage. Vérification manuelle conseillée : il peut s’agir d’un simple texte technique.',
        evidence: aggregate.snippets,
        pages: Array.from(aggregate.pages).sort((a, b) => a - b),
      });
      continue;
    }
    const unmistakable = aggregate.kind === 'svg' || aggregate.kind === 'xml' || aggregate.kind === 'postscript' || aggregate.kind === 'html';
    const severity: Severity = aggregate.source === 'text' || unmistakable ? 'critical' : 'warning';
    findings.push({
      id: `code-${aggregate.kind}`,
      severity,
      category: 'text',
      title: `Code ${CODE_LABEL[aggregate.kind]} inscrit dans le document`,
      detail: `Du ${CODE_LABEL[aggregate.kind]} a été détecté dans un bloc de texte. Ce type de contenu (souvent collé depuis un export web ou un bloc-notes) surcharge l’interpréteur du RIP et peut provoquer des erreurs d’impression ou des ralentissements.`,
      advice: 'Corriger la source (aplatir le bloc, vectoriser ou exporter en PDF/X) puis régénérer le PDF.',
      evidence: aggregate.snippets,
      pages: Array.from(aggregate.pages).sort((a, b) => a - b),
    });
  }
  return findings;
}

function verdictOf(findings: Finding[], degraded: boolean): { verdict: 'ok' | 'check' | 'ko'; score: number } {
  if (degraded) return { verdict: 'ko', score: 10 };
  let score = 100;
  let hasCritical = false;
  let hasWarning = false;
  for (const finding of findings) {
    if (finding.positive) continue;
    if (finding.severity === 'critical') {
      hasCritical = true;
      score -= 18;
    } else if (finding.severity === 'warning') {
      hasWarning = true;
      score -= 6;
    } else {
      score -= 1;
    }
  }
  return {
    verdict: hasCritical ? 'ko' : hasWarning ? 'check' : 'ok',
    score: clamp(Math.round(score), 5, 100),
  };
}

export async function analyzePdf(input: AnalyzeInput, options: AnalyzeOptions = {}): Promise<Report> {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const bytes = input.bytes;
  const T = options.thresholds ?? DEFAULT_THRESHOLDS;
  const onProgress = options.onProgress ?? (() => undefined);
  const raw: RawScan = rawScan(bytes);
  const collector = createCollector();
  const fonts = new Map<PDFDict, FontInfo>();
  const images: ImageInfo[] = [];
  const colors = new Map<string, ColorInfo>();
  const textSources: TextSource[] = [];
  const extractedPages: TextPage[] = [];

  const docInfo: DocInfo = {
    name: input.name,
    size: input.size ?? bytes.length,
    pages: 0,
    version: raw.version ?? '—',
    encrypted: raw.encrypted,
    linearized: raw.linearized,
    pdfa: raw.tokens.pdfaId > 0,
    pdfx: raw.tokens.gtsPdfx > 0,
    pageSizes: [],
    hasTrim: false,
    hasBleed: false,
    bleedMm: null,
    incremental: raw.incremental,
    transparency: false,
    overprint: false,
    layers: raw.tokens.ocProperties > 0,
  };

  let doc: PDFDocument | undefined;
  let pages: PageInfo[] = [];
  let degraded = false;
  let parseError: string | undefined;

  try {
    doc = await loadPdf(bytes);
  } catch (error) {
    degraded = true;
    parseError = error instanceof Error ? error.message : String(error);
  }

  let jsCount = 0;
  let embeddedFileCount = 0;
  let embeddedTreeCount = 0;
  let svgCount = 0;
  let attachmentList: { name: string; mime: string; size: number }[] = [];
  let jsLabels: string[] = [];
  let spotNames = new Set<string>();
  let imageBytesTotal = 0;
  let maxImageBytes = 0;
  let minDpi: number | null = null;
  let rgbSeen = false;
  let cmykSeen = false;
  let graySeen = false;
  let iccRgb = false;
  let iccCmyk = false;
  let outputIntents: { subtype?: string; condition?: string }[] = [];
  let hasMetadata = false;
  let hasThumb = false;
  let hasPieceInfo = false;
  let uriCount = 0;
  let launchCount = 0;
  let annotCount = 0;
  let formFieldCount = 0;
  let type3Count = 0;

  const usedFonts = new Set<PDFDict>();
  const seenImageDicts = new Set<PDFDict>();
  const seenXmp = new Set<PDFDict>();
  const seenFiles = new Set<PDFDict>();

  const addColor = (descriptor: ColorDescriptor, page?: number) => {
    const key = `${descriptor.space}|${descriptor.spot ?? ''}`;
    const existing = colors.get(key);
    if (existing) {
      existing.count += 1;
      if (page && !existing.pages.includes(page)) existing.pages.push(page);
    } else {
      colors.set(key, { space: descriptor.space, spot: descriptor.spot, count: 1, pages: page ? [page] : [] });
    }
    if (descriptor.space === 'DeviceRGB' || descriptor.space === 'CalRGB' || descriptor.space === 'ICCBased/RGB') rgbSeen = true;
    if (descriptor.space === 'DeviceCMYK' || descriptor.space === 'ICCBased/CMYK') cmykSeen = true;
    if (descriptor.space === 'DeviceGray' || descriptor.space === 'CalGray' || descriptor.space === 'ICCBased/Gray') graySeen = true;
    if (descriptor.space === 'ICCBased/RGB') iccRgb = true;
    if (descriptor.space === 'ICCBased/CMYK') iccCmyk = true;
    if (descriptor.spot) spotNames.add(descriptor.spot);
  };

  if (doc) {
    const ctx = doc.context;
    const catalog = asDict(resolve(ctx, ctx.trailerInfo.Root));
    pages = collectPages(ctx, catalog);
    docInfo.pages = pages.length;

    const infoDict = documentInfoDict(ctx);
    if (infoDict) {
      docInfo.producer = strOf(get(ctx, infoDict, 'Producer'));
      docInfo.creator = strOf(get(ctx, infoDict, 'Creator'));
      docInfo.created = formatPdfDate(strOf(get(ctx, infoDict, 'CreationDate')));
    }
    docInfo.encrypted = doc.isEncrypted || raw.encrypted;
    docInfo.sourceApp = guessSourceApp(docInfo.producer, docInfo.creator)?.name;

    // ---- Catalog-level structures ----------------------------------------
    if (catalog) {
      const openAction = asDict(get(ctx, catalog, 'OpenAction'));
      if (openAction) {
        const actionType = nameOf(get(ctx, openAction, 'S'));
        if (actionType === 'JavaScript' || get(ctx, openAction, 'JS')) {
          jsCount += 1;
          jsLabels.push('action à l’ouverture (/OpenAction)');
        }
      }
      if (get(ctx, catalog, 'AA')) {
        jsCount += 1;
        jsLabels.push('actions automatiques (/AA)');
      }
      const names = asDict(get(ctx, catalog, 'Names'));
      if (names) {
        const jsTree = asDict(get(ctx, names, 'JavaScript'));
        const jsNodes = walkNameTree(ctx, jsTree);
        if (jsNodes > 0) {
          jsCount += jsNodes;
          jsLabels.push(`script(s) nommé(s) (${jsNodes})`);
        }
        const filesTree = asDict(get(ctx, names, 'EmbeddedFiles'));
        embeddedTreeCount = walkNameTree(ctx, filesTree);
      }
      const acroForm = asDict(get(ctx, catalog, 'AcroForm'));
      if (acroForm) {
        const fields = asArray(get(ctx, acroForm, 'Fields'));
        formFieldCount = fields ? fields.size() : 0;
      }
      if (get(ctx, catalog, 'OCProperties')) docInfo.layers = true;
      if (get(ctx, catalog, 'PieceInfo')) hasPieceInfo = true;
    }

    onProgress(0, pages.length + 4, 'Lecture des objets');
    const objects = ctx.enumerateIndirectObjects();

    for (const [, object] of objects) {
      const dict = asDict(object) ?? asStream(object)?.dict;
      if (!dict) continue;
      const type = nameOf(get(ctx, dict, 'Type'));
      const subtype = nameOf(get(ctx, dict, 'Subtype'));

      if (type === 'Font' || (subtype && FONT_SUBTYPES.has(subtype))) {
        if (!(subtype && subtype.startsWith('CIDFont'))) {
          const info = buildFontInfo(ctx, dict);
          if (!fonts.has(dict)) fonts.set(dict, info);
        }
      }

      if (subtype === 'PS') {
        collector.item({ kind: 'ps', label: 'XObject PostScript', detail: 'Objet PostScript embarqué : non supporté par la plupart des RIP.' });
      }

      if (type === 'Annot') {
        annotCount += 1;
        const risky = subtype ? ANNOT_RISK[subtype] : undefined;
        if (risky) collector.item({ kind: `annot-${subtype}`, label: risky });
        const action = asDict(get(ctx, dict, 'A'));
        const actionType = nameOf(get(ctx, action, 'S'));
        if (actionType === 'JavaScript' || get(ctx, action, 'JS')) {
          jsCount += 1;
          jsLabels.push('action de formulaire / annotation');
        }
        if (actionType === 'Launch') launchCount += 1;
        if (actionType === 'GoToR') launchCount += 1;
        if (actionType === 'URI') uriCount += 1;
      }

      if (type === 'Filespec' || get(ctx, dict, 'EF')) {
        const filename =
          strOf(get(ctx, dict, 'UF')) ?? strOf(get(ctx, dict, 'F')) ?? nameOf(get(ctx, dict, 'UF')) ?? 'fichier sans nom';
        const efDict = asDict(get(ctx, dict, 'EF'));
        let mime = '';
        let size = 0;
        if (efDict) {
          for (const key of ['F', 'UF']) {
            const entry = resolve(ctx, efDict.get(PDFName.of(key)));
            const stream = asStream(entry);
            if (stream) {
              mime = nameOf(get(ctx, stream.dict, 'Subtype')) ?? mime;
              const params = asDict(get(ctx, stream.dict, 'Params'));
              size = numOf(get(ctx, params, 'Size')) ?? stream.contents.length;
              break;
            }
          }
        }
        if (!seenFiles.has(dict) && (filename !== 'fichier sans nom' || mime)) {
          seenFiles.add(dict);
          embeddedFileCount += 1;
          attachmentList.push({ name: filename, mime, size });
          const isSvg = /svg/i.test(mime) || /\.svg$/i.test(filename);
          if (isSvg) {
            svgCount += 1;
            collector.item({ kind: 'svg-file', label: `SVG embarqué : ${filename}`, size, detail: mime });
          } else {
            collector.item({ kind: 'file', label: `Fichier embarqué : ${filename}`, size, detail: mime });
          }
        }
        if (get(ctx, dict, 'AFRelationship')) {
          /* associated files: already counted through /EF */
        }
      }

      if (type === 'Metadata') {
        hasMetadata = true;
        if (!seenXmp.has(dict)) {
          seenXmp.add(dict);
          const stream = asStream(dict);
          if (stream) {
            const size = stream.contents.length;
            collector.item({ kind: 'xmp', label: 'Métadonnées XMP', size, detail: 'Bloc XMP (Adobe / appareil photo / suite bureautique)' });
          }
        }
      }

      if (subtype === 'XML' && !seenXmp.has(dict)) {
        const stream = asStream(dict);
        if (stream && stream.contents.length < 4_000_000) {
          const snippet = latin1(stream.contents.subarray(0, Math.min(stream.contents.length, 4000)));
          if (/<svg[\s>]/i.test(snippet)) {
            seenXmp.add(dict);
            svgCount += 1;
            collector.item({ kind: 'svg-xml', label: 'SVG encapsulé dans un flux XML', size: stream.contents.length });
          }
        }
      }

      if (type === 'OutputIntent') {
        outputIntents.push({
          subtype: nameOf(get(ctx, dict, 'S')),
          condition: strOf(get(ctx, dict, 'OutputConditionIdentifier')) ?? nameOf(get(ctx, dict, 'OutputConditionIdentifier')),
        });
      }

      if (type === 'OCG') docInfo.layers = true;

      if (subtype === 'Type3') type3Count += 1;

      const actionType = nameOf(get(ctx, dict, 'S'));
      if (actionType === 'JavaScript' || get(ctx, dict, 'JS')) {
        if (type !== 'Annot') {
          jsCount += 1;
          if (jsLabels.length < 5) jsLabels.push('bloc JavaScript dans un objet');
        }
      } else if (actionType === 'Launch' || actionType === 'GoToR') {
        launchCount += 1;
      } else if (actionType === 'URI') {
        uriCount += 1;
      }
    }

    onProgress(1, pages.length + 4, 'Analyse des pages');

    const sizeBuckets = new Map<string, PageSizeBucket>();
    let pagesWithTrim = 0;
    let pagesWithBleed = 0;
    let minBleedMm: number | null = null;

    for (const page of pages) {
      const env = buildEnv(ctx, page.resources);
      const streams = pageContentStreams(ctx, page.dict);
      const scan: PageScan = scanContent(ctx, streams, page.index, env);

      if (scan.transparency) docInfo.transparency = true;
      if (scan.overprint) docInfo.overprint = true;
      if (scan.layers) docInfo.layers = true;

      for (const [name, font] of scan.fontsUsed) {
        void name;
        const info = fonts.get(font);
        if (info) {
          info.used = true;
          if (!info.pages.includes(page.index)) info.pages.push(page.index);
          usedFonts.add(font);
        }
      }

      for (const descriptor of scan.colors) addColor(descriptor, page.index);

      const perPageImages = new Map<PDFDict, ImageInfo>();
      for (const placement of scan.placements) {
        if (!placement.width || !placement.height) continue;
        const dict = placement.dict;
        const colorSpace = colorSpaceName(ctx, get(ctx, dict, 'ColorSpace'));
        addColor(colorSpace, page.index);
        const stream = asStream(placement.raw);
        const size = stream ? stream.contents.length : 0;
        const existing = perPageImages.get(dict);
        const candidate: ImageInfo = {
          page: page.index,
          name: placement.resourceName,
          width: placement.width,
          height: placement.height,
          bits: numOf(get(ctx, dict, 'BitsPerComponent')) ?? 8,
          filter: describeFilters(ctx, dict),
          colorSpace: colorSpace.spot ? `${colorSpace.space} (${colorSpace.spot})` : colorSpace.space,
          dpi: placement.dpi,
          placedW: placement.placedW,
          placedH: placement.placedH,
          bytes: size,
          smask: Boolean(get(ctx, dict, 'SMask')),
          mask: Boolean(get(ctx, dict, 'Mask')),
          imageMask: Boolean(get(ctx, dict, 'ImageMask')),
          interpolate: Boolean(get(ctx, dict, 'Interpolate')),
          spot: colorSpace.spot,
        };
        if (!existing) {
          perPageImages.set(dict, candidate);
        } else if (candidate.dpi !== null && (existing.dpi === null || candidate.dpi < existing.dpi)) {
          existing.dpi = candidate.dpi;
          existing.placedW = candidate.placedW;
          existing.placedH = candidate.placedH;
        }
        if (!seenImageDicts.has(dict)) {
          seenImageDicts.add(dict);
          imageBytesTotal += size;
          maxImageBytes = Math.max(maxImageBytes, size);
        }
      }
      for (const image of perPageImages.values()) {
        images.push(image);
        if (image.dpi !== null) {
          minDpi = minDpi === null ? image.dpi : Math.min(minDpi, image.dpi);
        }
      }

      if (streams.length > 0 && scan.textSamples.length > 0) {
        textSources.push({ page: page.index, text: scan.textSamples.join(' ') });
      }

      const key = `${Math.round((page.mediaBox.width * 25.4) / 72)}x${Math.round((page.mediaBox.height * 25.4) / 72)}`;
      const bucket = sizeBuckets.get(key);
      if (bucket) bucket.count += 1;
      else {
        sizeBuckets.set(key, {
          label: formatPageSize(page.mediaBox.width, page.mediaBox.height),
          w: Math.round((page.mediaBox.width * 25.4) / 72),
          h: Math.round((page.mediaBox.height * 25.4) / 72),
          count: 1,
        });
      }
      if (page.trimBox) pagesWithTrim += 1;
      if (!hasThumb && get(ctx, page.dict, 'Thumb')) hasThumb = true;
      if (page.bleedBox) pagesWithBleed += 1;
      if (page.trimBox && page.bleedBox) {
        const trim = page.trimBox;
        const bleed = page.bleedBox;
        const margins = [
          trim.x - bleed.x,
          trim.y - bleed.y,
          bleed.x + bleed.width - (trim.x + trim.width),
          bleed.y + bleed.height - (trim.y + trim.height),
        ];
        const smallest = Math.min(...margins);
        const mm = (Math.max(0, smallest) * 25.4) / 72;
        minBleedMm = minBleedMm === null ? mm : Math.min(minBleedMm, mm);
      }

      onProgress(1 + page.index, pages.length + 4, `Page ${page.index}/${pages.length}`);
      if (page.index % 8 === 0) await Promise.resolve();
    }

    docInfo.pageSizes = Array.from(sizeBuckets.values()).sort((a, b) => b.count - a.count);
    docInfo.hasTrim = pages.length > 0 && pagesWithTrim === pages.length;
    docInfo.hasBleed = pages.length > 0 && pagesWithBleed === pages.length;
    docInfo.bleedMm = minBleedMm === null ? null : Math.round(minBleedMm * 10) / 10;
    docInfo.pdfx = docInfo.pdfx || outputIntents.some((intent) => intent.subtype === 'GTS_PDFX');
    docInfo.pdfa = docInfo.pdfa || outputIntents.some((intent) => intent.subtype === 'GTS_PDFA1');

    // ---- Text extraction (pdf.js) ----------------------------------------
    if (options.extractText && pages.length > 0) {
      onProgress(pages.length + 2, pages.length + 4, 'Extraction du texte');
      try {
        const limit = options.maxTextPages ?? 200;
        const result = await options.extractText(bytes, (page) => {
          onProgress(pages.length + 2, pages.length + 4, `Texte · page ${page}`);
        });
        for (const page of result) {
          if (page.page > limit) break;
          extractedPages.push(page);
          if (page.text.trim()) textSources.push({ page: page.page, text: page.text });
        }
      } catch {
        collector.add({
          id: 'text-extraction-failed',
          severity: 'info',
          category: 'text',
          title: 'Extraction du texte incomplète',
          detail: 'Le texte n’a pas pu être entièrement extrait. L’analyse structurelle reste valable.',
        });
      }
    }
  }

  // ---- Findings ----------------------------------------------------------
  const { add } = collector;

  if (degraded) {
    add({
      id: 'structure-unreadable',
      severity: 'critical',
      category: 'structure',
      title: 'Structure PDF illisible',
      detail: `Le fichier n’a pas pu être décodé complètement (${truncate(parseError ?? 'erreur inconnue', 140)}). Les scans de surface sont fournis, mais le fichier est probablement endommagé ou généré par un outil non standard.`,
      advice: 'Réexporter le PDF depuis l’application source, ou le reconstruire via une rasterisation.',
    });
  } else {
    if (docInfo.pages === 0) {
      add({
        id: 'no-pages',
        severity: 'critical',
        category: 'pages',
        title: 'Aucune page détectée',
        detail: 'Le document ne contient aucune page exploitable par un RIP.',
      });
    }
    if (docInfo.encrypted) {
      add({
        id: 'encrypted',
        severity: 'critical',
        category: 'structure',
        title: 'PDF protégé',
        detail: 'Le fichier est chiffré ou protégé par mot de passe. Un RIP d’impression peut refuser le fichier ou ignorer les polices protégées.',
        advice: 'Réexporter sans protection, ou déverrouiller le PDF avant l’envoi.',
      });
    }
    if (raw.eofCount === 0) {
      add({
        id: 'truncated',
        severity: 'warning',
        category: 'structure',
        title: 'Fin de fichier incomplète',
        detail: 'La marque de fin (%%EOF) est absente : le fichier a peut-être été tronqué lors d’un transfert.',
        advice: 'Récupérer une copie complète du fichier.',
      });
    }
    if (raw.headerOffset > 1024) {
      add({
        id: 'header-offset',
        severity: 'warning',
        category: 'structure',
        title: 'En-tête PDF décalé',
        detail: `L’en-tête %PDF apparaît à l’octet ${raw.headerOffset}. Des données parasites précèdent le document.`,
        advice: 'Réexporter le PDF pour retirer les données parasites.',
      });
    }
    if (docInfo.version === '2.0') {
      add({
        id: 'pdf-2',
        severity: 'warning',
        category: 'structure',
        title: 'PDF 2.0 (ISO 32000-2)',
        detail: 'Le fichier utilise la version 2.0 du format. Certains RIP et flux de production ne l’interprètent pas encore intégralement.',
        advice: 'Si le RIP refuse le fichier, exporter en PDF 1.7 ou en PDF/X-4.',
      });
    }
    if (docInfo.incremental > 0) {
      add({
        id: 'incremental',
        severity: 'info',
        category: 'structure',
        title: `${docInfo.incremental} mise(s) à jour incrémentale(s)`,
        detail: 'Le PDF contient plusieurs générations d’objets. Le fichier est plus lourd et plus lent à interpréter qu’un export propre.',
        advice: 'Un « Enregistrer sous » depuis Acrobat, ou la compression intégrée, réécrit le fichier à neuf.',
      });
    }
    if (docInfo.linearized) {
      add({
        id: 'linearized',
        severity: 'info',
        category: 'structure',
        title: 'PDF optimisé pour le web',
        detail: 'La linéarisation est inutile en impression et ajoute une couche de structure.',
      });
    }

    // Pages
    if (docInfo.pageSizes.length > 1) {
      add({
        id: 'page-size-mismatch',
        severity: 'warning',
        category: 'pages',
        title: 'Formats de page hétérogènes',
        detail: `Le document mélange ${docInfo.pageSizes.length} formats : ${docInfo.pageSizes.map((size) => `${size.label} (${size.count} p.)`).join(' · ')}.`,
        advice: 'Uniformiser le format de toutes les pages avant l’envoi au RIP.',
      });
    }
    // Traits de coupe et fonds perdus
    const bleedMm = docInfo.bleedMm;
    const bleedOk = docInfo.hasTrim && docInfo.hasBleed && (bleedMm ?? 0) >= T.bleed.minMm;
    if (bleedOk) {
      add({
        id: 'bleed-ok',
        severity: 'info',
        category: 'pages',
        title: 'Traits de coupe et fonds perdus conformes',
        detail: `TrimBox et BleedBox présentes sur toutes les pages. Débord mesuré : ${formatMm(bleedMm ?? 0)} (minimum demandé ${formatMm(T.bleed.minMm)}).`,
        positive: true,
      });
    } else if (!docInfo.hasTrim && !docInfo.hasBleed) {
      add({
        id: 'no-boxes',
        severity: 'warning',
        category: 'pages',
        title: 'Ni traits de coupe ni fonds perdus',
        detail:
          'Aucune TrimBox ni BleedBox : le RIP imprimera la page entière et le massicotage n’aura aucune marge de sécurité. Sur une affiche à fond perdu, un liseré blanc peut apparaître après coupe.',
        advice: `Exporter avec ${formatMm(T.bleed.minMm)} de fonds perdus et les repères de coupe (PDF/X-4).`,
      });
    } else if (!docInfo.hasTrim) {
      add({
        id: 'trim-absent',
        severity: 'warning',
        category: 'pages',
        title: 'Traits de coupe absents (TrimBox)',
        detail:
          'La zone de coupe n’est pas déclarée : le RIP ne sait pas où couper et utilisera le format de page. Les repères de coupe ne peuvent pas être positionnés correctement.',
        advice: `Déclarer la TrimBox et ${formatMm(T.bleed.minMm)} de fonds perdus dans l’export (PDF/X-4).`,
      });
    } else if (!docInfo.hasBleed) {
      add({
        id: 'bleed-absent',
        severity: 'warning',
        category: 'pages',
        title: 'Fonds perdus absents (BleedBox)',
        detail:
          'La zone de coupe existe mais aucun fond perdu n’est déclaré : les images et aplats s’arrêtent au trait de coupe, ce qui laisse apparaître un filet blanc après massicotage.',
        advice: `Ajouter ${formatMm(T.bleed.minMm)} de fonds perdus (BleedBox) dans l’export.`,
      });
    } else {
      add({
        id: 'bleed-too-small',
        severity: 'warning',
        category: 'pages',
        title: `Fonds perdus insuffisants (${formatMm(bleedMm ?? 0)})`,
        detail: `Le débord mesuré entre TrimBox et BleedBox est de ${formatMm(bleedMm ?? 0)}, sous le minimum de ${formatMm(T.bleed.minMm)}. Le massicotage n’a pas de marge de sécurité.`,
        advice: `Étendre le fond perdu à ${formatMm(T.bleed.minMm)} minimum.`,
      });
    }
    if (docInfo.pages >= T.pages.many) {
      const heavy = docInfo.pages >= T.pages.heavy;
      add({
        id: 'many-pages',
        severity: heavy ? 'warning' : 'info',
        category: 'pages',
        title: `${humanNumber(docInfo.pages)} pages`,
        detail: heavy
          ? `Au-delà de ${T.pages.heavy} pages, le RIP traite le fichier page par page en mémoire : prévoir un envoi fractionné et une compression préalable.`
          : `Un volume supérieur à ${T.pages.many} pages augmente le temps de traitement du RIP.`,
        advice: heavy ? 'Fractionner l’envoi ou rasteriser à 200 dpi pour alléger le flux.' : undefined,
      });
    }

    if (input.size && input.size > T.file.sizeWarningBytes) {
      const critical = input.size > T.file.sizeCriticalBytes;
      add({
        id: 'file-heavy',
        severity: critical ? 'critical' : 'warning',
        category: 'structure',
        title: `Fichier de ${humanBytes(input.size)}`,
        detail: critical
          ? `Au-delà de ${humanBytes(T.file.sizeCriticalBytes)}, le RIP peut saturer sa mémoire pendant le traitement et interrompre le travail. C’est le cas typique des PDF exportés depuis Figma ou Canva avec des images non optimisées.`
          : `Un fichier de cette taille ralentit le transfert et le traitement. Les PDF au-delà de ${humanBytes(T.file.sizeWarningBytes)} gagnent presque toujours à être allégés.`,
        advice: 'Compresser en priorité ; rasteriser à 200 dpi si le fichier reste lourd.',
      });
    }

    // Fonts
    const usedFontList = Array.from(fonts.values()).filter((font) => font.used);
    collector.stats.fonts = Array.from(fonts.values()).length;
    const notEmbedded = usedFontList.filter((font) => !font.embedded);
    collector.stats.fontsNotEmbedded = notEmbedded.length;
    if (notEmbedded.length > 0) {
      add({
        id: 'font-not-embedded',
        severity: 'critical',
        category: 'fonts',
        title: `${notEmbedded.length} police(s) non embarquée(s)`,
        detail:
          'Le RIP devra substituer ces polices : risques de décalage de composition, de caractères manquants et de rendu différent du BAT. C’est la cause n°1 de refus sur Konica / Fiery.',
        advice: 'Embarquer les polices (ou vectoriser les blocs concernés) puis réexporter.',
        evidence: notEmbedded.map(
          (font) => `${font.name} · ${font.subtype}${font.encoding ? ` · ${font.encoding}` : ''}`,
        ),
        pages: unique(notEmbedded.flatMap((font) => font.pages)).sort((a, b) => a - b),
      });
    }
    const type3Fonts = usedFontList.filter((font) => font.type3);
    if (type3Fonts.length > 0 || type3Count > 0) {
      add({
        id: 'type3',
        severity: 'warning',
        category: 'fonts',
        title: 'Polices Type 3 (glyphes procéduraux)',
        detail: 'Les polices Type 3 sont dessinées par des procédures PostScript internes : rendu imprévisible, texte non sélectionnable, poids inutile.',
        advice: 'Remplacer par une police OpenType embarquée ou vectoriser.',
        evidence: type3Fonts.map((font) => font.name),
      });
    }
    const noToUnicode = usedFontList.filter((font) => !font.toUnicode && font.embedded);
    if (noToUnicode.length > 0) {
      add({
        id: 'no-tounicode',
        severity: 'info',
        category: 'fonts',
        title: 'Table Unicode absente',
        detail: 'Certaines polices embarquées n’exposent pas de table ToUnicode : le texte reste imprimable, mais l’extraction et la recherche sont dégradées.',
        evidence: noToUnicode.map((font) => font.name),
      });
    }
    if (usedFontList.length > T.fonts.many) {
      add({
        id: 'many-fonts',
        severity: 'warning',
        category: 'fonts',
        title: `${usedFontList.length} polices différentes`,
        detail: 'Un nombre élevé de polices augmente le temps de traitement et le risque d’une police incomplète.',
        advice: 'Rationaliser la charte typographique ou vectoriser les titres.',
      });
    }

    // Images
    collector.stats.images = images.length;
    collector.stats.imageBytes = imageBytesTotal;
    collector.stats.maxImageBytes = maxImageBytes;
    collector.stats.minDpi = minDpi;

    const lowDpi = images.filter(
      (image) => image.dpi !== null && image.dpi < T.image.dpiWarning,
    );
    const severeDpi = lowDpi.filter(
      (image) => (image.dpi ?? 0) < T.image.dpiCritical,
    );
    if (lowDpi.length > 0) {
      add({
        id: 'image-low-dpi',
        severity: severeDpi.length > 0 ? 'critical' : 'warning',
        category: 'images',
        title: `${lowDpi.length} image(s) sous ${T.image.dpiWarning} dpi`,
        detail: `Résolution insuffisante pour une AccurioPrint à ${T.image.dpiIdeal} dpi : travées visibles sur les aplats et les dégradés.${severeDpi.length > 0 ? ` Dont ${severeDpi.length} sous ${T.image.dpiCritical} dpi, inexploitables en impression.` : ''}`,
        advice: `Remplacer les images basse résolution (${T.image.dpiIdeal} dpi à taille finale).`,
        evidence: lowDpi.slice(0, 8).map(
          (image) =>
            `${image.page} p. · ${image.name ?? 'image'} · ${image.width}×${image.height} px · ${image.dpi} dpi · ${humanBytes(image.bytes)}`,
        ),
        pages: unique(lowDpi.map((image) => image.page)).sort((a, b) => a - b),
      });
    }
    const oversized = images.filter(
      (image) => (image.dpi ?? 0) > T.image.dpiExcessive,
    );
    if (oversized.length > 0) {
      add({
        id: 'image-too-high-dpi',
        severity: 'warning',
        category: 'images',
        title: `${oversized.length} image(s) au-delà de ${T.image.dpiExcessive} dpi`,
        detail: `Ces images sont inutilement lourdes : au-delà de ${T.image.dpiIdeal} dpi à taille finale, le gain visuel est nul mais le décodage et la mémoire explosent.`,
        advice: `Réduire à ${T.image.dpiIdeal} dpi via « Compresser » ou « Rasteriser ».`,
        evidence: oversized.slice(0, 6).map(
          (image) => `${image.page} p. · ${image.width}×${image.height} px · ${image.dpi} dpi · ${humanBytes(image.bytes)}`,
        ),
      });
    }
    const heavy = images.filter((image) => image.bytes > T.image.heavyBytes);
    if (heavy.length > 0) {
      const veryHeavy = heavy.filter(
        (image) => image.bytes > T.image.heavyCriticalBytes,
      );
      add({
        id: 'image-heavy',
        severity: veryHeavy.length > 0 ? 'critical' : 'warning',
        category: 'images',
        title: `${heavy.length} image(s) très lourde(s)`,
        detail: `Des images dépassent ${humanBytes(T.image.heavyBytes)} (jusqu’à ${humanBytes(maxImageBytes)}). Elles saturent la mémoire du RIP et ralentissent le transfert.`,
        advice: 'Compresser ou rasteriser le fichier avant l’envoi.',
        evidence: heavy.slice(0, 6).map(
          (image) => `${image.page} p. · ${image.name ?? 'image'} · ${humanBytes(image.bytes)} · ${image.filter} · ${image.colorSpace}`,
        ),
      });
    }
    const incompatible = images.filter((image) => image.filter.includes('JPX') || image.filter.includes('JBIG2'));
    if (incompatible.length > 0) {
      add({
        id: 'image-incompatible',
        severity: 'warning',
        category: 'images',
        title: `${incompatible.length} image(s) au codage exotique`,
        detail: 'JPEG 2000 (JPXDecode) ou JBIG2 : le support varie selon les RIP. Ces flux sont souvent mal interprétés ou ignorés.',
        advice: 'Rasteriser le PDF pour convertir ces images en JPEG/Flate standard.',
        evidence: incompatible.slice(0, 8).map((image) => `${image.page} p. · ${image.filter} · ${image.colorSpace}`),
      });
    }
    const hugePixels = images.filter(
      (image) => image.width * image.height > T.image.megapixels,
    );
    if (hugePixels.length > 0) {
      add({
        id: 'image-megapixel',
        severity: 'warning',
        category: 'images',
        title: `${hugePixels.length} image(s) de plus de ${Math.round(T.image.megapixels / 1_000_000)} Mpx`,
        detail: 'Ces images sont décodées en mémoire pleine résolution par le RIP, indépendamment de leur taille d’impression.',
      });
    }
    if (
      images.length > 0 &&
      input.size &&
      imageBytesTotal > input.size * T.image.dominanceRatio &&
      input.size > T.image.dominanceMinBytes
    ) {
      add({
        id: 'image-dominated',
        severity: 'info',
        category: 'images',
        title: 'Le poids du fichier vient des images',
        detail: `${humanBytes(imageBytesTotal)} d’images sur ${humanBytes(input.size)}. La compression aura un effet important.`,
      });
    }

    // Conception du fichier (logiciel d'origine)
    const guess = guessSourceApp(docInfo.producer, docInfo.creator);
    if (guess) {
      const details = [
        guess.name,
        guess.family !== 'non identifié' ? guess.family : undefined,
        docInfo.producer ? `Producer : ${truncate(docInfo.producer, 70)}` : undefined,
        docInfo.creator && docInfo.creator !== docInfo.producer
          ? `Creator : ${truncate(docInfo.creator, 70)}`
          : undefined,
        docInfo.created ? `créé le ${docInfo.created}` : undefined,
      ].filter(Boolean) as string[];
      add({
        id: 'conception-source',
        severity: 'info',
        category: 'conception',
        title: `Fichier conçu avec ${guess.name}`,
        detail:
          guess.family === 'généré'
            ? 'Ce PDF a été produit automatiquement (navigateur, bibliothèque ou export serveur). Ces fichiers embarquent souvent des polices de substitution, des SVG convertis et des images non optimisées.'
            : 'Logiciel identifié d’après les métadonnées du document. Il détermine les habitudes d’export (polices, profils, transparence) et les corrections à appliquer.',
        advice:
          guess.family === 'généré'
            ? 'Contrôler les polices et les images ; une rasterisation est souvent plus sûre.'
            : undefined,
        evidence: details,
        positive: guess.family !== 'généré',
      });
    } else {
      add({
        id: 'conception-source',
        severity: 'warning',
        category: 'conception',
        title: 'Logiciel d’origine non identifié',
        detail:
          'Aucune métadonnée Producer / Creator exploitable. Le fichier a peut-être été nettoyé, converti ou produit par un outil minimal : les polices et les profils sont à vérifier en priorité.',
        advice: 'Réexporter depuis l’application source avec les métadonnées conservées.',
      });
    }

    // Mode colorimétrique
    const spaces = Array.from(colors.values());
    const hasRgb = spaces.some(
      (color) => color.space === 'DeviceRGB' || color.space === 'CalRGB' || color.space.includes('RGB'),
    );
    const hasCmyk = spaces.some(
      (color) => color.space === 'DeviceCMYK' || color.space.includes('CMYK'),
    );
    const hasGray = spaces.some(
      (color) => color.space === 'DeviceGray' || color.space === 'CalGray' || color.space.includes('Gray'),
    );
    const hasLab = spaces.some((color) => color.space === 'Lab');
    const modeParts: string[] = [];
    if (hasCmyk) modeParts.push('CMJN');
    if (hasRgb) modeParts.push('RVB');
    if (hasGray) modeParts.push('niveaux de gris');
    if (hasLab) modeParts.push('Lab');
    if (spotNames.size > 0) modeParts.push(`${spotNames.size} ton(s) direct(s)`);
    const modeLabel = modeParts.length ? modeParts.join(' + ') : 'indéterminé';
    const modeIsMixed = (hasRgb && hasCmyk) || (hasGray && (hasRgb || hasCmyk));
    if (!hasRgb && !hasCmyk && !hasGray && !hasLab) {
      add({
        id: 'color-mode',
        severity: 'info',
        category: 'colors',
        title: 'Mode colorimétrique : noir (par défaut)',
        detail:
          'Aucun opérateur de couleur n’a été relevé : le contenu est composé en noir d’encre (DeviceGray implicite). Impression en noir seul, aucun risque de conversion.',
        positive: true,
      });
    } else {
      add({
        id: 'color-mode',
        severity: hasRgb && !hasCmyk ? 'warning' : 'info',
        category: 'colors',
        title: `Mode colorimétrique : ${modeLabel}`,
        detail: hasRgb && !hasCmyk
          ? 'Le fichier est uniquement en RVB : le RIP convertira lui-même vers le CMJN de la Konica, avec un rendu parfois éloigné de la maquette.'
          : modeIsMixed
            ? 'Le document mélange plusieurs espaces. La conversion dépendra du profil de sortie du RIP ; un PDF/X-4 avec OutputIntent évite les surprises.'
            : 'Le document est homogène. Ce mode correspond à ce que le RIP recevra.',
        advice: hasRgb && !hasCmyk ? 'Convertir en CMJN avec le profil de l’imprimante.' : undefined,
        evidence: spaces
          .slice(0, 8)
          .map((color) => `${color.spot ?? color.space} · ${humanNumber(color.count)} opérateur(s)`),
        positive: !(hasRgb && !hasCmyk) && !modeIsMixed,
      });
    }

    // Colors
    collector.stats.spots = spotNames.size;
    if (spotNames.size > 0) {
      add({
        id: 'spot-colors',
        severity: 'warning',
        category: 'colors',
        title: `${spotNames.size} ton(s) direct(s) détecté(s)`,
        detail:
          'Des couleurs Separation / DeviceN (tons directs, type Pantone) sont présentes. Sur une presse quadri elles seront converties approximativement, ou ignorées.',
        advice: 'Convertir les tons directs en CMJN (ou vérifier la bibliothèque du RIP) avant impression.',
        evidence: Array.from(spotNames).slice(0, 12),
      });
    }
    if (iccRgb) {
      add({
        id: 'icc-rgb',
        severity: 'info',
        category: 'colors',
        title: 'Profil ICC RVB intégré',
        detail: 'Des images ou objets utilisent un profil ICC RVB. La conversion dépendra du profil de sortie du RIP.',
      });
    }
    if (outputIntents.length === 0) {
      add({
        id: 'no-output-intent',
        severity: 'warning',
        category: 'colors',
        title: 'Aucun profil de sortie (OutputIntent)',
        detail: 'Sans OutputIntent, le RIP applique son propre profil : les couleurs peuvent dériver par rapport à la maquette.',
        advice: 'Exporter en PDF/X-4 (ou PDF/X-1a) avec le profil de l’imprimante.',
      });
    } else {
      add({
        id: 'output-intent',
        severity: 'info',
        category: 'colors',
        title: 'Profil de sortie déclaré',
        detail: outputIntents
          .map(
            (intent) =>
              `${intent.subtype ?? 'OutputIntent'}${intent.condition ? ` · ${intent.condition}` : ''}`,
          )
          .join(' · '),
      });
    }
    if (docInfo.transparency) {
      add({
        id: 'transparency',
        severity: 'warning',
        category: 'colors',
        title: 'Transparence active',
        detail:
          'Le document utilise des groupes transparents, masques doux ou modes de fusion. L’aplatissement est réalisé par le RIP, avec un risque de différences de rendu et de lenteur.',
        advice: 'Rasteriser le PDF (aplatissement contrôlé) si le RIP est lent ou si le rendu diffère.',
      });
    }
    if (docInfo.overprint) {
      add({
        id: 'overprint',
        severity: 'info',
        category: 'colors',
        title: 'Surimpression (overprint)',
        detail: 'Au moins un objet est en surimpression. À vérifier sur épreuve : les fonds peuvent se mélanger de façon inattendue.',
      });
    }
    if (docInfo.layers) {
      add({
        id: 'layers',
        severity: 'warning',
        category: 'colors',
        title: 'Calques (Optional Content)',
        detail: 'Le PDF contient des calques PDF (OCG). Le RIP imprime les calques visibles : un calque masqué à l’écran peut ne pas être imprimé.',
        advice: 'Aplatir les calques avant l’envoi.',
      });
    }

    // Exotic content
    collector.stats.javascript = jsCount;
    collector.stats.embeddedFiles = embeddedFileCount;
    collector.stats.svg = svgCount;
    if (jsCount > 0) {
      add({
        id: 'javascript',
        severity: 'critical',
        category: 'exotic',
        title: 'JavaScript intégré au PDF',
        detail: `${jsCount} bloc(s) de code actif : ${unique(jsLabels).join(', ')}. Les actions JavaScript sont inutiles en impression, peuvent bloquer le RIP et constituent un risque de sécurité.`,
        advice: 'Supprimer le contenu actif (option « nettoyage » de l’export) puis réexporter.',
      });
    }
    if (attachmentList.length > 0) {
      const svgFiles = attachmentList.filter((file) => /svg/i.test(file.mime) || /\.svg$/i.test(file.name));
      add({
        id: 'embedded-files',
        severity: svgFiles.length > 0 ? 'critical' : 'warning',
        category: 'exotic',
        title: `${attachmentList.length} fichier(s) embarqué(s)`,
        detail:
          'Des fichiers sont joints au PDF (souvent des sources ou des SVG d’illustration). Ils alourdissent le fichier et ne sont pas imprimables.',
        advice: 'Retirer les pièces jointes avant l’envoi.',
        evidence: attachmentList
          .slice(0, 12)
          .map((file) => `${file.name}${file.mime ? ` · ${file.mime}` : ''}${file.size ? ` · ${humanBytes(file.size)}` : ''}`),
      });
    }
    if (svgCount > 0) {
      add({
        id: 'svg-content',
        severity: 'critical',
        category: 'exotic',
        title: 'SVG présent dans le PDF',
        detail:
          'Du contenu SVG a été identifié (fichier joint, flux XML ou code dans un bloc de texte). Le RIP Konica ne l’interprète pas comme un objet vectoriel natif : rendu manquant, cadre vide ou erreur.',
        advice: 'Vectoriser / aplatir le SVG dans l’application source puis réexporter le PDF.',
        evidence: unique([
          ...attachmentList.filter((file) => /svg/i.test(file.mime) || /\.svg$/i.test(file.name)).map((file) => `fichier · ${file.name}`),
        ]),
      });
    }
    if (collector.exotic.some((item) => item.kind === 'ps')) {
      add({
        id: 'postscript-xobject',
        severity: 'critical',
        category: 'exotic',
        title: 'Objet PostScript embarqué',
        detail: 'Un XObject PostScript ne peut pas être rendu par un RIP PDF standard. Il sera ignoré ou provoquera une erreur.',
        advice: 'Rasteriser le PDF pour aplatir cet objet.',
      });
    }
    const richMedia = collector.exotic.filter((item) => item.kind.startsWith('annot-'));
    if (richMedia.length > 0) {
      add({
        id: 'rich-media',
        severity: 'warning',
        category: 'exotic',
        title: 'Annotations interactives / multimédia',
        detail: 'Des annotations 3D, vidéo, audio ou des pièces jointes sont attachées aux pages. Elles ne s’impriment pas et encombrent le fichier.',
        evidence: unique(richMedia.map((item) => item.label)),
      });
    }
    if (annotCount > 0 && richMedia.length === 0) {
      add({
        id: 'annotations',
        severity: 'info',
        category: 'exotic',
        title: `${annotCount} annotation(s)`,
        detail: 'Les annotations (liens, commentaires) ne sont pas imprimées par défaut mais restent dans le fichier.',
      });
    }
    if (formFieldCount > 0) {
      add({
        id: 'form-fields',
        severity: 'warning',
        category: 'exotic',
        title: `${formFieldCount} champ(s) de formulaire`,
        detail: 'Un PDF formulaire conserve des apparences dynamiques. Certains RIP impriment l’apparence par défaut au lieu du contenu saisi.',
        advice: 'Aplatir les formulaires avant l’envoi.',
      });
    }
    if (launchCount > 0) {
      add({
        id: 'external-actions',
        severity: 'warning',
        category: 'exotic',
        title: 'Actions externes (Launch / GoToR)',
        detail: 'Le PDF contient des actions qui ouvrent un fichier externe. Elles sont bloquées par les RIP et les lecteurs récents.',
        advice: 'Supprimer les actions puis réexporter.',
      });
    }
    if (uriCount > 0) {
      add({
        id: 'links',
        severity: 'info',
        category: 'exotic',
        title: `${uriCount} lien(s) hypertexte`,
        detail: 'Les liens ne s’impriment pas. Ils ajoutent des annotations au fichier.',
      });
    }
    if (hasMetadata) {
      add({
        id: 'xmp',
        severity: 'info',
        category: 'exotic',
        title: 'Métadonnées XMP',
        detail: 'Bloc métadonnées (créateur, appareil, historique). Sans effet sur l’impression, mais pèse quelques kilo-octets et peut contenir des données indésirables.',
        advice: 'La compression intégrée peut les retirer.',
      });
    }
    if (hasThumb) {
      add({
        id: 'thumbnail',
        severity: 'info',
        category: 'exotic',
        title: 'Vignette de page intégrée',
        detail: 'Une vignette d’aperçu est stockée dans le PDF. Inutile en impression.',
      });
    }
    if (hasPieceInfo) {
      add({
        id: 'piece-info',
        severity: 'info',
        category: 'exotic',
        title: 'Données privées de l’application source',
        detail: 'Le PDF embarque des données propriétaires (Illustrator / InDesign) qui alourdissent le fichier.',
      });
    }
    if (raw.tokens.javascript > 0 && jsCount === 0) {
      add({
        id: 'javascript-trace',
        severity: 'info',
        category: 'exotic',
        title: 'Trace de JavaScript dans les flux',
        detail: 'Le mot-clé JavaScript apparaît dans des données compressées sans objet actif identifiable. Trace résiduelle probable.',
      });
    }
  }

  // ---- Text / code findings ---------------------------------------------
  if (textSources.length > 0) {
    const textOnly = textSources.filter((source) => extractedPages.some((page) => page.page === source.page));
    const contentOnly = textSources.filter((source) => !extractedPages.some((page) => page.page === source.page));
    for (const finding of [...codeFindings(textOnly, 'text'), ...codeFindings(contentOnly, 'content')]) {
      add(finding);
    }
    const missing = extractedPages.reduce((sum, page) => sum + page.missingGlyphs, 0);
    if (missing > 0) {
      add({
        id: 'missing-glyphs',
        severity: 'critical',
        category: 'text',
        title: `${humanNumber(missing)} caractère(s) manquant(s)`,
        detail:
          'Des glyphes ne sont pas résolus (caractère de remplacement �). Typographie incomplète ou mal intégrée : l’imprimé montrera des carrés ou des blancs à la place des caractères.',
        advice: 'Remplacer la police par une version complète et embarquée, ou vectoriser le bloc.',
        pages: extractedPages.filter((page) => page.missingGlyphs > 0).map((page) => page.page),
      });
    }
    if (extractedPages.length > 0) {
      const totalChars = extractedPages.reduce((sum, page) => sum + page.text.length, 0);
      if (totalChars === 0 && images.length === 0) {
        add({
          id: 'no-text-no-image',
          severity: 'warning',
          category: 'text',
          title: 'Aucun texte ni image détecté',
          detail: 'Le document semble vide ou entièrement composé d’objets non standard.',
        });
      }
    }
  }

  embeddedFileCount = Math.max(embeddedFileCount, embeddedTreeCount, attachmentList.length);

  const findings = collector.findings.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  const { verdict, score } = verdictOf(findings, degraded);

  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  onProgress(pages.length + 4, pages.length + 4, 'Terminé');

  const textStats = extractedPages.length
    ? {
        chars: extractedPages.reduce((sum, page) => sum + page.text.length, 0),
        missingGlyphs: extractedPages.reduce((sum, page) => sum + page.missingGlyphs, 0),
        pages: extractedPages.length,
      }
    : undefined;

  return {
    file: docInfo,
    text: textStats,
    thresholds: T,
    profile: { id: PROFILE_ID, label: PROFILE_LABEL },
    verdict,
    score,
    findings,
    fonts: Array.from(fonts.values()).sort((a, b) => Number(b.used) - Number(a.used) || a.name.localeCompare(b.name)),
    images: images.sort((a, b) => (a.dpi ?? 9999) - (b.dpi ?? 9999)),
    colors: Array.from(colors.values()).sort((a, b) => b.count - a.count),
    exotic: collector.exotic,
    stats: {
      ...collector.stats,
      fonts: Array.from(fonts.values()).length,
      fontsNotEmbedded: Array.from(fonts.values()).filter((font) => font.used && !font.embedded).length,
      images: images.length,
      imagesLowDpi: images.filter(
        (image) => image.dpi !== null && image.dpi < T.image.dpiWarning,
      ).length,
      minDpi,
      spots: spotNames.size,
      javascript: jsCount,
      embeddedFiles: embeddedFileCount,
      svg: svgCount,
      imageBytes: imageBytesTotal,
      maxImageBytes,
    },
    elapsedMs: Math.round(ended - started),
    degraded,
  };
}
