import { describe, expect, it } from 'vitest';
import { analyzePdf } from '../src/core/analyze';
import { detectCode } from '../src/core/code';
import { buildReportPdf } from '../src/core/reportPdf';
import {
  DEFAULT_THRESHOLDS,
  cloneThresholds,
  fieldValue,
  isDefaultThresholds,
  mergeThresholds,
  normalizeThresholds,
  resetThresholds,
  saveThresholds,
  setFieldValue,
  THRESHOLD_FIELDS,
  THRESHOLDS,
} from '../src/core/thresholds';
import {
  bleedPdf,
  brokenPdf,
  cleanPdf,
  imageAtDpiPdf,
  manyPagesPdf,
  problematicPdf,
  rgbOnlyPdf,
} from './fixtures';

const ids = (report: Awaited<ReturnType<typeof analyzePdf>>) => report.findings.map((f) => f.id);

describe('analyse pré-vol', () => {
  it('valide un PDF propre et embarqué', async () => {
    const bytes = cleanPdf();
    const report = await analyzePdf({ name: 'propre.pdf', bytes });
    expect(report.file.pages).toBe(1);
    expect(report.file.version).toBe('1.7');
    expect(report.file.pdfx).toBe(true);
    expect(report.degraded).toBeFalsy();
    expect(ids(report)).not.toContain('font-not-embedded');
    expect(report.fonts[0]?.embedded).toBe(true);
    expect(report.verdict).toBe('ok');
    expect(report.score).toBeGreaterThan(90);
  });

  it('détecte les pathologies de production', async () => {
    const bytes = problematicPdf();
    const report = await analyzePdf({ name: 'problemes.pdf', bytes });
    const found = ids(report);

    expect(report.file.pages).toBe(2);
    expect(report.verdict).toBe('ko');

    expect(found).toContain('font-not-embedded');
    expect(found).toContain('javascript');
    expect(found).toContain('embedded-files');
    expect(found).toContain('svg-content');
    expect(found).toContain('code-svg');
    expect(found).toContain('type3');
    expect(found).toContain('image-low-dpi');
    expect(found).toContain('spot-colors');
    expect(found).toContain('page-size-mismatch');
    expect(found).toContain('no-output-intent');

    expect(report.stats.javascript).toBeGreaterThan(0);
    expect(report.stats.embeddedFiles).toBe(1);
    expect(report.stats.spots).toBe(1);
    expect(report.stats.images).toBe(1);
    expect(report.stats.minDpi).toBeGreaterThan(100);
    expect(report.stats.minDpi).toBeLessThan(120);

    const helvetica = report.fonts.find((font) => font.name.includes('Helvetica'));
    expect(helvetica?.embedded).toBe(false);
    expect(helvetica?.used).toBe(true);

    const spots = report.colors.filter((color) => color.spot);
    expect(spots.some((color) => color.spot?.includes('PANTONE 185 C'))).toBe(true);

    const svgFinding = report.findings.find((finding) => finding.id === 'code-svg');
    expect(svgFinding?.severity).toBe('critical');
    expect(svgFinding?.evidence?.join(' ')).toContain('<svg');

    const embedded = report.findings.find((finding) => finding.id === 'embedded-files');
    expect(embedded?.evidence?.join(' ')).toContain('logo.svg');
  });

  it('reste robuste sur un fichier tronqué', async () => {
    const report = await analyzePdf({ name: 'casse.pdf', bytes: brokenPdf() });
    expect(report.verdict).toBe('ko');
    expect(report.degraded || ids(report).includes('no-pages')).toBe(true);
  });
});

describe('détection de code dans le texte', () => {
  it('ne signale pas une phrase française ordinaire', () => {
    const matches = detectCode('Le chat <3 les élèves ; rendez-vous à 14 h, prix : 10 €.');
    expect(matches.filter((match) => match.strong)).toHaveLength(0);
  });

  it('signale le SVG et le JavaScript', () => {
    const svg = detectCode('bloc : <svg viewBox="0 0 10 10"><path d="M0 0"/></svg>');
    expect(svg.some((match) => match.kind === 'svg' && match.strong)).toBe(true);
    const js = detectCode('function test() { console.log(1); }');
    expect(js.some((match) => match.kind === 'javascript')).toBe(true);
  });
});

describe('seuils Konica C4065', () => {
  it('joint le profil et ses valeurs au rapport', async () => {
    const report = await analyzePdf({ name: 'propre.pdf', bytes: cleanPdf() });
    expect(report.profile.id).toBe('konica-c4065');
    expect(report.thresholds.image.dpiWarning).toBe(THRESHOLDS.image.dpiWarning);
    expect(report.thresholds.raster.defaultDpi).toBe(200);
  });

  it('accepte une image à 240 dpi (au-dessus du seuil de 200)', async () => {
    const report = await analyzePdf({ name: '240.pdf', bytes: imageAtDpiPdf(240) });
    expect(report.images[0]?.dpi).toBeGreaterThanOrEqual(238);
    expect(ids(report)).not.toContain('image-low-dpi');
  });

  it('alerte dès 180 dpi et bloque sous 120 dpi', async () => {
    const warn = await analyzePdf({ name: '180.pdf', bytes: imageAtDpiPdf(180) });
    const low = warn.findings.find((finding) => finding.id === 'image-low-dpi');
    expect(low?.severity).toBe('warning');
    expect(low?.title).toContain('200 dpi');

    const critical = await analyzePdf({ name: '100.pdf', bytes: imageAtDpiPdf(100) });
    const severe = critical.findings.find((finding) => finding.id === 'image-low-dpi');
    expect(severe?.severity).toBe('critical');
    expect(severe?.detail).toContain('120 dpi');
  });

  it('signale un fichier au-delà de 120 Mo et bloque au-delà de 250 Mo', async () => {
    const bytes = cleanPdf();
    const heavy = await analyzePdf({
      name: 'lourd.pdf',
      bytes,
      size: THRESHOLDS.file.sizeWarningBytes + 1,
    });
    const finding = heavy.findings.find((item) => item.id === 'file-heavy');
    expect(finding?.severity).toBe('warning');

    const critical = await analyzePdf({
      name: 'tres-lourd.pdf',
      bytes,
      size: THRESHOLDS.file.sizeCriticalBytes + 1,
    });
    expect(critical.findings.find((item) => item.id === 'file-heavy')?.severity).toBe('critical');
  });

  it('passe le volume de pages en alerte à 250 pages', async () => {
    const many = await analyzePdf({ name: 'volume.pdf', bytes: manyPagesPdf(130) });
    const finding = many.findings.find((item) => item.id === 'many-pages');
    expect(finding?.severity).toBe('info');

    const heavy = await analyzePdf({ name: 'volume2.pdf', bytes: manyPagesPdf(THRESHOLDS.pages.heavy + 5) });
    expect(heavy.findings.find((item) => item.id === 'many-pages')?.severity).toBe('warning');
    expect(heavy.file.pages).toBe(THRESHOLDS.pages.heavy + 5);
  });
});

describe('nouveaux contrôles', () => {
  it('identifie le logiciel d’origine', async () => {
    const report = await analyzePdf({ name: 'indesign.pdf', bytes: cleanPdf() });
    expect(report.file.sourceApp).toBe('Adobe InDesign');
    const finding = report.findings.find((item) => item.id === 'conception-source');
    expect(finding?.title).toContain('Adobe InDesign');
    expect(finding?.positive).toBe(true);
    expect(report.verdict).toBe('ok');
  });

  it('signale un document uniquement RVB', async () => {
    const report = await analyzePdf({ name: 'rgb.pdf', bytes: rgbOnlyPdf() });
    const finding = report.findings.find((item) => item.id === 'color-mode');
    expect(finding?.severity).toBe('warning');
    expect(finding?.title).toContain('RVB');
    expect(report.verdict).not.toBe('ok');
  });

  it('contrôle traits de coupe et fonds perdus', async () => {
    const none = await analyzePdf({ name: 'sans-bleed.pdf', bytes: bleedPdf(null) });
    expect(ids(none)).toContain('bleed-absent');

    const small = await analyzePdf({ name: 'petit-bleed.pdf', bytes: bleedPdf(4) });
    const finding = small.findings.find((item) => item.id === 'bleed-too-small');
    expect(finding?.severity).toBe('warning');
    expect(finding?.title).toContain('1,4');

    const good = await analyzePdf({ name: 'bon-bleed.pdf', bytes: bleedPdf(12) });
    const okFinding = good.findings.find((item) => item.id === 'bleed-ok');
    expect(okFinding?.positive).toBe(true);
    expect(good.file.bleedMm).toBeGreaterThanOrEqual(4);
  });

  it('respecte les seuils fournis en option', async () => {
    const lax = cloneThresholds();
    lax.image.dpiWarning = 100;
    lax.image.dpiCritical = 60;
    const report = await analyzePdf(
      { name: 'souple.pdf', bytes: imageAtDpiPdf(180) },
      { thresholds: lax },
    );
    expect(ids(report)).not.toContain('image-low-dpi');
    expect(report.thresholds.image.dpiWarning).toBe(100);
  });
});

describe('préférences de seuils', () => {
  it('convertit les unités d’affichage', () => {
    const field = THRESHOLD_FIELDS.find((item) => item.path === 'image.heavyBytes');
    expect(field).toBeDefined();
    expect(fieldValue(DEFAULT_THRESHOLDS, field!)).toBe(10);
    const next = setFieldValue(DEFAULT_THRESHOLDS, field!, 14);
    expect(next.image.heavyBytes).toBe(14 * 1024 * 1024);
  });

  it('garde les seuils ordonnés', () => {
    const broken = cloneThresholds();
    broken.image.dpiWarning = 90;
    broken.image.dpiCritical = 200;
    broken.image.dpiIdeal = 50;
    const fixed = normalizeThresholds(broken);
    expect(fixed.image.dpiCritical).toBeLessThan(fixed.image.dpiWarning);
    expect(fixed.image.dpiIdeal).toBeGreaterThan(fixed.image.dpiWarning);
    expect(fixed.image.dpiExcessive).toBeGreaterThan(fixed.image.dpiIdeal);
  });

  it('fusionne un JSON partiel et détecte les valeurs par défaut', () => {
    const merged = mergeThresholds({ pages: { many: 40 } });
    expect(merged.pages.many).toBe(40);
    expect(merged.image.dpiWarning).toBe(DEFAULT_THRESHOLDS.image.dpiWarning);
    expect(isDefaultThresholds(merged)).toBe(false);
    expect(isDefaultThresholds(cloneThresholds())).toBe(true);
    expect(isDefaultThresholds(resetThresholds())).toBe(true);
  });

  it('enregistre puis relit les seuils', () => {
    const custom = cloneThresholds();
    custom.bleed.minMm = 5;
    saveThresholds(custom);
    expect(isDefaultThresholds(cloneThresholds())).toBe(true);
  });
});

describe('export PDF du rapport', () => {
  it('produit un PDF valide, quel que soit le contenu', async () => {
    const report = await analyzePdf({ name: 'problemes.pdf', bytes: problematicPdf() });
    const bytes = await buildReportPdf(report, {
      version: '1.0.0',
      path: '/tmp/problemes.pdf',
      generatedAt: new Date('2026-01-12T09:30:00Z'),
    });
    const head = Buffer.from(bytes.slice(0, 5)).toString('latin1');
    expect(head).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(2000);

    const { PDFDocument } = await import('pdf-lib');
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBeGreaterThan(0);
    expect(reloaded.getTitle()).toContain('problemes.pdf');
  });
});
