import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { Finding, Report, Severity } from './types';
import { CATEGORY_LABEL } from './types';
import { PROFILE_LABEL, thresholdSummary } from './thresholds';
import { humanBytes, humanNumber } from './utils';

/**
 * pdf-lib n'embarque que les polices standard WinAnsi : on translittère les
 * caractères typographiques (guillemets, tirets, flèches…) pour rester lisible
 * sans ajouter de fonte.
 */
const TRANSLIT: Record<string, string> = {
  // Non représentables en WinAnsi : translittérés.
  '\u2192': '->',
  '\u2190': '<-',
  '\u2265': '>=',
  '\u2264': '<=',
  '\u2260': '!=',
  '\u2713': 'ok',
  '\u2717': 'x',
  '\u202f': ' ',
  '\u00a0': ' ',
  '\u2011': '-',
  '\u2044': '/',
  '\u2039': '<',
  '\u203a': '>',
  // WinAnsi couvre ° × · ’ – — … « » : conservés tels quels.
};

const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

function sanitize(input: string): string {
  let out = '';
  for (const char of input) {
    if (TRANSLIT[char] !== undefined) {
      out += TRANSLIT[char];
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code === 9) out += '  ';
    else if (code < 32) out += ' ';
    // WinAnsi = Latin-1 + quelques signes typographiques (plage 0x80-0x9F).
    else if (code <= 0xff) out += char;
    else if (WIN_ANSI_EXTRA.has(code)) out += char;
    else out += '?';
  }
  return out;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

const COLORS = {
  ink: rgb(0.07, 0.07, 0.07),
  soft: rgb(0.27, 0.26, 0.24),
  muted: rgb(0.54, 0.52, 0.49),
  line: rgb(0.87, 0.85, 0.82),
  accent: rgb(0.89, 0.24, 0.09),
  ok: rgb(0.11, 0.42, 0.29),
  warn: rgb(0.6, 0.36, 0),
  ko: rgb(0.71, 0.17, 0.08),
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'BLOQUANT',
  warning: 'ALERTE',
  info: 'INFO',
};

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
  pageNumber: number;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.pageNumber += 1;
  ctx.y = PAGE_H - MARGIN;
  ctx.page.drawText(sanitize(`Pré-fly — rapport de pré-vol · page ${ctx.pageNumber}`), {
    x: MARGIN,
    y: 24,
    size: 7,
    font: ctx.regular,
    color: COLORS.muted,
  });
}

function ensureSpace(ctx: Ctx, needed: number): void {
  if (ctx.y - needed < MARGIN + 20) newPage(ctx);
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = sanitize(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (font.widthOfTextAtSize(word, size) > width) {
      // Mot trop long (chemin, URL) : découpe par caractères.
      let chunk = '';
      for (const char of word) {
        if (font.widthOfTextAtSize(chunk + char, size) > width) {
          lines.push(chunk);
          chunk = char;
        } else {
          chunk += char;
        }
      }
      current = chunk;
    } else {
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function paragraph(
  ctx: Ctx,
  text: string,
  options: {
    size?: number;
    font?: PDFFont;
    color?: ReturnType<typeof rgb>;
    indent?: number;
    leading?: number;
    gapAfter?: number;
  } = {},
): void {
  const size = options.size ?? 9;
  const font = options.font ?? ctx.regular;
  const color = options.color ?? COLORS.soft;
  const indent = options.indent ?? 0;
  const leading = options.leading ?? size * 1.45;
  const lines = wrap(text, font, size, CONTENT_W - indent);
  for (const line of lines) {
    ensureSpace(ctx, leading);
    ctx.page.drawText(line, { x: MARGIN + indent, y: ctx.y - size, size, font, color });
    ctx.y -= leading;
  }
  ctx.y -= options.gapAfter ?? 0;
}

function rule(ctx: Ctx, gap = 10): void {
  ensureSpace(ctx, gap + 2);
  ctx.y -= gap / 2;
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: PAGE_W - MARGIN, y: ctx.y },
    thickness: 0.6,
    color: COLORS.line,
  });
  ctx.y -= gap / 2;
}

function sectionTitle(ctx: Ctx, title: string, right?: string): void {
  ensureSpace(ctx, 34);
  ctx.y -= 8;
  ctx.page.drawText(sanitize(title.toUpperCase()), {
    x: MARGIN,
    y: ctx.y - 9,
    size: 8.5,
    font: ctx.bold,
    color: COLORS.ink,
  });
  if (right) {
    const label = sanitize(right);
    const width = ctx.regular.widthOfTextAtSize(label, 7.5);
    ctx.page.drawText(label, {
      x: PAGE_W - MARGIN - width,
      y: ctx.y - 9,
      size: 7.5,
      font: ctx.regular,
      color: COLORS.muted,
    });
  }
  ctx.y -= 18;
}

function severityColor(finding: Finding): ReturnType<typeof rgb> {
  if (finding.positive) return COLORS.ok;
  if (finding.severity === 'critical') return COLORS.ko;
  if (finding.severity === 'warning') return COLORS.warn;
  return COLORS.muted;
}

function severityLabel(finding: Finding): string {
  return finding.positive ? 'CONFORME' : SEVERITY_LABEL[finding.severity];
}

function findingBlock(ctx: Ctx, finding: Finding, index: number): void {
  const color = severityColor(finding);
  const label = severityLabel(finding);
  const labelWidth = ctx.bold.widthOfTextAtSize(label, 6.8);
  const titleLines = wrap(finding.title, ctx.bold, 10, CONTENT_W - labelWidth - 12);
  ensureSpace(ctx, 22 + titleLines.length * 13);

  // Pastille de gravité + titre
  ctx.page.drawText(sanitize(`${String(index).padStart(2, '0')}  ${label}`), {
    x: MARGIN,
    y: ctx.y - 8,
    size: 6.8,
    font: ctx.bold,
    color,
  });
  let titleY = ctx.y;
  for (const line of titleLines) {
    ctx.page.drawText(line, {
      x: MARGIN + labelWidth + 12,
      y: titleY - 8,
      size: 10,
      font: ctx.bold,
      color: COLORS.ink,
    });
    titleY -= 13;
  }
  ctx.y = titleY - 2;

  const category = CATEGORY_LABEL[finding.category];
  ctx.page.drawText(sanitize(category), {
    x: MARGIN + labelWidth + 12,
    y: ctx.y - 7,
    size: 7,
    font: ctx.regular,
    color: COLORS.muted,
  });
  ctx.y -= 14;

  paragraph(ctx, finding.detail, { indent: labelWidth + 12, size: 8.8, gapAfter: 3 });

  if (finding.advice) {
    paragraph(ctx, `Correction : ${finding.advice}`, {
      indent: labelWidth + 12,
      size: 8.6,
      color: COLORS.ink,
      gapAfter: 3,
    });
  }

  if (finding.evidence && finding.evidence.length > 0) {
    const items = finding.evidence.slice(0, 10);
    for (const item of items) {
      paragraph(ctx, `· ${item}`, {
        indent: labelWidth + 18,
        size: 7.6,
        font: ctx.mono,
        color: COLORS.soft,
        leading: 10.5,
      });
    }
    if (finding.evidence.length > items.length) {
      paragraph(ctx, `· ... et ${finding.evidence.length - items.length} autre(s)`, {
        indent: labelWidth + 18,
        size: 7.6,
        font: ctx.mono,
        color: COLORS.muted,
        leading: 10.5,
      });
    }
  }

  if (finding.pages && finding.pages.length > 0) {
    const pages =
      finding.pages.length <= 8
        ? `pages ${finding.pages.join(', ')}`
        : `${finding.pages.length} pages concernées`;
    paragraph(ctx, pages, {
      indent: labelWidth + 12,
      size: 7.2,
      font: ctx.mono,
      color: COLORS.muted,
      leading: 10,
    });
  }

  ctx.y -= 6;
  rule(ctx, 4);
}

export interface ReportPdfOptions {
  version: string;
  path?: string;
  generatedAt?: Date;
}

export async function buildReportPdf(report: Report, options: ReportPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Pré-fly — ${report.file.name}`);
  doc.setAuthor('Pré-fly');
  doc.setSubject('Rapport de pré-vol PDF');
  doc.setProducer(`Pré-fly ${options.version}`);
  doc.setCreator('Pré-fly');

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);

  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: PAGE_H - MARGIN,
    regular,
    bold,
    mono,
    pageNumber: 1,
  };

  // En-tête
  ctx.page.drawText('PRE-FLY', {
    x: MARGIN,
    y: ctx.y - 10,
    size: 9,
    font: bold,
    color: COLORS.accent,
  });
  ctx.page.drawText(sanitize(PROFILE_LABEL), {
    x: MARGIN + 54,
    y: ctx.y - 10,
    size: 7.5,
    font: regular,
    color: COLORS.muted,
  });
  const generated = options.generatedAt ?? new Date();
  const stamp = sanitize(
    generated.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }),
  );
  ctx.page.drawText(stamp, {
    x: PAGE_W - MARGIN - regular.widthOfTextAtSize(stamp, 7.5),
    y: ctx.y - 10,
    size: 7.5,
    font: regular,
    color: COLORS.muted,
  });
  ctx.y -= 30;

  const titleLines = wrap(report.file.name, bold, 17, CONTENT_W - 110);
  for (const line of titleLines) {
    ctx.page.drawText(line, { x: MARGIN, y: ctx.y - 16, size: 17, font: bold, color: COLORS.ink });
    ctx.y -= 20;
  }

  const verdictLabel =
    report.verdict === 'ok' ? 'CONFORME' : report.verdict === 'check' ? 'À VÉRIFIER' : 'NON CONFORME';
  const verdictColor =
    report.verdict === 'ok' ? COLORS.ok : report.verdict === 'check' ? COLORS.warn : COLORS.ko;

  // Bloc score (à droite du titre)
  const scoreY = PAGE_H - MARGIN - 34;
  ctx.page.drawText(sanitize(String(report.score)), {
    x: PAGE_W - MARGIN - 90,
    y: scoreY - 26,
    size: 34,
    font: regular,
    color: verdictColor,
  });
  ctx.page.drawText('/100', {
    x: PAGE_W - MARGIN - 54,
    y: scoreY - 26,
    size: 9,
    font: regular,
    color: COLORS.muted,
  });
  const verdictWidth = bold.widthOfTextAtSize(verdictLabel, 8);
  ctx.page.drawText(verdictLabel, {
    x: PAGE_W - MARGIN - verdictWidth,
    y: scoreY - 42,
    size: 8,
    font: bold,
    color: verdictColor,
  });
  const count = `${report.findings.filter((f) => !f.positive).length} point(s) relevé(s)`;
  ctx.page.drawText(sanitize(count), {
    x: PAGE_W - MARGIN - regular.widthOfTextAtSize(sanitize(count), 7),
    y: scoreY - 53,
    size: 7,
    font: regular,
    color: COLORS.muted,
  });

  if (options.path) {
    paragraph(ctx, options.path, { size: 7.4, font: mono, color: COLORS.muted, gapAfter: 6 });
  }

  // Métadonnées
  const formats = report.file.pageSizes.map((size) => size.label).join(' · ') || '—';
  const meta: [string, string][] = [
    ['Pages', `${humanNumber(report.file.pages)}`],
    ['Format', formats],
    ['Poids', humanBytes(report.file.size)],
    ['Version', `PDF ${report.file.version}`],
    ['Logiciel', report.file.sourceApp ?? 'non identifié'],
    ['Polices', `${report.stats.fonts} (${report.stats.fontsNotEmbedded} non embarquées)`],
    ['Images', `${report.stats.images}${report.stats.minDpi !== null ? ` · min ${report.stats.minDpi} dpi` : ''}`],
    ['Tons directs', `${report.stats.spots}`],
    [
      'Fonds perdus',
      report.file.bleedMm !== null
        ? `${report.file.bleedMm} mm`
        : report.file.hasBleed
          ? 'présents'
          : 'absents',
    ],
    ['Contenu actif', `${report.stats.javascript} JS · ${report.stats.embeddedFiles} fichier(s)`],
  ];

  const cellW = CONTENT_W / 2;
  ensureSpace(ctx, Math.ceil(meta.length / 2) * 22 + 10);
  meta.forEach((entry, index) => {
    const column = index % 2;
    if (column === 0 && index > 0) ctx.y -= 22;
    const x = MARGIN + column * cellW;
    ctx.page.drawText(sanitize(entry[0].toUpperCase()), {
      x,
      y: ctx.y - 7,
      size: 6.4,
      font: bold,
      color: COLORS.muted,
    });
    const value = sanitize(entry[1]);
    const max = cellW - 14;
    const size = regular.widthOfTextAtSize(value, 9) > max ? 7.6 : 9;
    ctx.page.drawText(value, {
      x,
      y: ctx.y - 18,
      size,
      font: regular,
      color: COLORS.ink,
      maxWidth: max,
    });
  });
  ctx.y -= 26;
  rule(ctx, 10);

  // Contrôles
  const controls = report.findings.filter((finding) => !finding.positive);
  const passed = report.findings.filter((finding) => finding.positive);
  sectionTitle(ctx, 'Contrôles', `${controls.length} point(s)`);
  if (controls.length === 0) {
    paragraph(ctx, 'Aucun point bloquant relevé sur ce fichier.', { color: COLORS.ok });
  }
  controls.forEach((finding, index) => findingBlock(ctx, finding, index + 1));

  if (passed.length > 0) {
    sectionTitle(ctx, 'Contrôles conformes', `${passed.length}`);
    for (const finding of passed) {
      ensureSpace(ctx, 16);
      const label = 'CONFORME';
      ctx.page.drawText(label, {
        x: MARGIN,
        y: ctx.y - 7,
        size: 6.8,
        font: bold,
        color: COLORS.ok,
      });
      ctx.page.drawText(sanitize(finding.title), {
        x: MARGIN + 54,
        y: ctx.y - 7,
        size: 9,
        font: regular,
        color: COLORS.soft,
        maxWidth: CONTENT_W - 54,
      });
      ctx.y -= 15;
    }
    rule(ctx, 8);
  }

  // Typographies
  const usedFonts = report.fonts.filter((font) => font.used);
  sectionTitle(ctx, 'Typographies', `${usedFonts.length} utilisée(s)`);
  if (usedFonts.length === 0) {
    paragraph(ctx, 'Aucune police utilisée.', { color: COLORS.muted });
  } else {
    for (const font of usedFonts) {
      ensureSpace(ctx, 14);
      ctx.page.drawText(sanitize(font.name), {
        x: MARGIN,
        y: ctx.y - 8,
        size: 8.6,
        font: regular,
        color: COLORS.ink,
        maxWidth: 200,
      });
      ctx.page.drawText(sanitize(font.subtype), {
        x: MARGIN + 210,
        y: ctx.y - 8,
        size: 7.6,
        font: mono,
        color: COLORS.soft,
      });
      const status = font.embedded ? (font.type3 ? 'Type 3' : 'embarquée') : 'ABSENTE';
      ctx.page.drawText(sanitize(status), {
        x: MARGIN + 320,
        y: ctx.y - 8,
        size: 7.6,
        font: bold,
        color: font.embedded ? COLORS.ok : COLORS.ko,
      });
      ctx.page.drawText(sanitize(`${font.pages.length} page(s)`), {
        x: MARGIN + 420,
        y: ctx.y - 8,
        size: 7.4,
        font: mono,
        color: COLORS.muted,
      });
      ctx.y -= 13;
    }
    ctx.y -= 4;
    rule(ctx, 8);
  }

  // Images
  sectionTitle(ctx, 'Images', `${report.images.length} placement(s)`);
  if (report.images.length === 0) {
    paragraph(ctx, 'Aucune image bitmap.', { color: COLORS.muted });
  } else {
    for (const image of report.images.slice(0, 24)) {
      ensureSpace(ctx, 12);
      const line = `p.${image.page}  ${image.width}x${image.height}px  ${image.dpi !== null ? `${image.dpi} dpi` : 'dpi ?'}  ${image.colorSpace}  ${image.filter}  ${image.bytes ? humanBytes(image.bytes) : '-'}`;
      ctx.page.drawText(sanitize(line), {
        x: MARGIN,
        y: ctx.y - 7,
        size: 7.6,
        font: mono,
        color:
          image.dpi !== null && image.dpi < report.thresholds.image.dpiCritical
            ? COLORS.ko
            : image.dpi !== null && image.dpi < report.thresholds.image.dpiWarning
              ? COLORS.warn
              : COLORS.soft,
        maxWidth: CONTENT_W,
      });
      ctx.y -= 11.5;
    }
    if (report.images.length > 24) {
      paragraph(ctx, `... et ${report.images.length - 24} autre(s) placement(s)`, {
        size: 7.4,
        font: mono,
        color: COLORS.muted,
      });
    }
    rule(ctx, 8);
  }

  // Couleurs
  sectionTitle(ctx, 'Couleurs & profils', `${report.colors.length} espace(s)`);
  if (report.colors.length === 0) {
    paragraph(ctx, 'Aucune couleur déclarée.', { color: COLORS.muted });
  } else {
    const line = report.colors
      .map((color) => `${color.spot ?? color.space} (${humanNumber(color.count)})`)
      .join('  ·  ');
    paragraph(ctx, line, { size: 8.4, gapAfter: 4 });
    rule(ctx, 8);
  }

  // Contenu exotique
  sectionTitle(ctx, 'Contenu exotique', `${report.exotic.length} objet(s)`);
  if (report.exotic.length === 0) {
    paragraph(ctx, 'Aucun contenu externe ou non imprimable.', { color: COLORS.muted });
  } else {
    for (const item of report.exotic.slice(0, 20)) {
      const detail = item.detail ? ` — ${item.detail}` : '';
      const size = item.size ? ` (${humanBytes(item.size)})` : '';
      paragraph(ctx, `${item.label}${detail}${size}`, {
        size: 8,
        font: mono,
        leading: 10.5,
      });
    }
    if (report.exotic.length > 20) {
      paragraph(ctx, `... et ${report.exotic.length - 20} autre(s)`, {
        size: 7.6,
        font: mono,
        color: COLORS.muted,
      });
    }
    rule(ctx, 8);
  }

  // Seuils
  sectionTitle(ctx, 'Seuils appliqués', PROFILE_LABEL);
  for (const line of thresholdSummary(report.thresholds)) {
    ensureSpace(ctx, 11);
    ctx.page.drawText(sanitize(line.label), {
      x: MARGIN,
      y: ctx.y - 7,
      size: 7.6,
      font: regular,
      color: COLORS.soft,
    });
    ctx.page.drawText(sanitize(line.value), {
      x: MARGIN + 190,
      y: ctx.y - 7,
      size: 7.6,
      font: mono,
      color: COLORS.ink,
    });
    ctx.y -= 11;
  }

  ensureSpace(ctx, 30);
  ctx.y -= 12;
  paragraph(
    ctx,
    'Rapport généré localement par Pré-fly. Aucun fichier n’a été envoyé sur un serveur.',
    { size: 7.4, color: COLORS.muted },
  );

  return doc.save();
}

export function reportPdfName(fileName: string): string {
  return `${fileName.replace(/\.pdf$/i, '')}-prefly.pdf`;
}
