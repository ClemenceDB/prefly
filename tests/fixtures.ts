/**
 * Minimal PDF writer used by the test-suite. Building the bytes by hand gives
 * exact control over the pathologies we want the analyser to catch.
 */
export function buildPdf(
  bodies: string[],
  options: { version?: string; root?: number } = {},
): Uint8Array {
  const version = options.version ?? '1.7';
  const root = options.root ?? 1;
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (text: string) => {
    const buffer = Buffer.from(text, 'latin1');
    chunks.push(buffer);
    offset += buffer.length;
  };

  push(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`);
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets[index] = offset;
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefOffset = offset;
  push(`xref\n0 ${bodies.length + 1}\n`);
  push('0000000000 65535 f \n');
  for (const item of offsets) push(`${String(item).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${bodies.length + 1} /Root ${root} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Uint8Array(Buffer.concat(chunks));
}

export function streamObject(dict: string, data: string): string {
  const bytes = Buffer.from(data, 'latin1');
  const entries = dict.trim() ? `${dict.trim()} /Length ${bytes.length}` : `/Length ${bytes.length}`;
  return `<< ${entries} >>\nstream\n${data}\nendstream`;
}

export const FONT_EMBEDDED = `<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+HelveticaNeue /FirstChar 32 /LastChar 32 /Widths [278] /FontDescriptor 6 0 R >>`;
export const FONT_DESCRIPTOR_EMBEDDED = `<< /Type /FontDescriptor /FontName /ABCDEF+HelveticaNeue /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>`;

export function cleanPdf(): Uint8Array {
  const content = 'BT /F1 12 Tf 72 760 Td (Bonjour, atelier demain matin.) Tj ET';
  return buildPdf([
    `<< /Type /Catalog /Pages 2 0 R /OutputIntents [9 0 R] >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /TrimBox [8.5 8.5 586.78 833.39] /BleedBox [0 0 595.28 841.89] /Contents 4 0 R >>`,
    streamObject('', content),
    FONT_EMBEDDED,
    FONT_DESCRIPTOR_EMBEDDED,
    streamObject('', '\x00\x01\x00\x00'), // stand-in font program
    streamObject('', 'Q'), // placeholder, unused by content
    `<< /Type /OutputIntent /S /GTS_PDFX /OutputConditionIdentifier (FOGRA39) >>`,
  ]);
}

export function problematicPdf(): Uint8Array {
  const content1 = [
    'BT /F1 12 Tf 72 700 Td (Bonjour <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>) Tj ET',
    'BT /F3 10 Tf 72 640 Td (Type trois) Tj ET',
    '/CS1 cs 0.6 scn 20 20 100 100 re f',
    'q 2000 0 0 2000 0 0 cm /Im1 Do Q',
  ].join('\n');

  return buildPdf([
    // 1 catalog with JavaScript open action
    `<< /Type /Catalog /Pages 2 0 R /OpenAction 10 0 R /Names << /EmbeddedFiles 11 0 R >> >>`,
    // 2 pages
    `<< /Type /Pages /Kids [3 0 R 15 0 R] /Count 2 /Resources << /Font << /F1 5 0 R /F3 8 0 R >> /XObject << /Im1 9 0 R >> /ColorSpace << /CS1 [/Separation /PANTONE#20185#20C /DeviceCMYK 14 0 R] >> >> >>`,
    // 3 page A4
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R >>`,
    // 4 content
    streamObject('', content1),
    // 5 non-embedded font
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    // 6,7 unused placeholders (kept so numbers stay stable)
    `<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>`,
    `<< /Producer (InDesign) >>`,
    // 8 Type3 font
    `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << /a 12 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [500] >>`,
    // 9 image 3000px wide drawn at 2000pt -> 108 dpi
    streamObject('/Type /XObject /Subtype /Image /Width 3000 /Height 3000 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode', '\xff\xd8\xff\xd9'),
    // 10 JavaScript action
    `<< /S /JavaScript /JS (app.alert\\(1\\)) >>`,
    // 11 embedded files name tree
    `<< /Names [(logo.svg) 13 0 R] >>`,
    // 12 charproc content
    streamObject('', '500 0 d0 0 0 500 700 re f'),
    // 13 filespec
    `<< /Type /Filespec /F (logo.svg) /UF (logo.svg) /EF << /F 16 0 R >> >>`,
    // 14 tint transform
    `<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>`,
    // 15 second page, different format
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Contents 17 0 R >>`,
    // 16 embedded file stream (SVG)
    streamObject('/Type /EmbeddedFile /Subtype /image#2Fsvg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'),
    // 17 empty content for the second page
    streamObject('', ''),
  ]);
}

export function brokenPdf(): Uint8Array {
  return new Uint8Array(Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'));
}
