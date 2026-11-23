import { describe, expect, it } from 'vitest';
import { analyzePdf } from '../src/core/analyze';
import { detectCode } from '../src/core/code';
import { brokenPdf, cleanPdf, problematicPdf } from './fixtures';

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
