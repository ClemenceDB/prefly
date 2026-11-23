import { latin1 } from './utils';

export interface RawScan {
  version: string | null;
  headerOffset: number;
  encrypted: boolean;
  linearized: boolean;
  eofCount: number;
  incremental: number;
  xrefCount: number;
  tokens: Record<string, number>;
}

const TOKENS: Record<string, string> = {
  image: '/Subtype/Image',
  form: '/Subtype/Form',
  ps: '/Subtype/PS',
  type3: '/Subtype/Type3',
  fontFile: '/FontFile',
  javascript: '/JavaScript',
  js: '/JS',
  openAction: '/OpenAction',
  additionalAction: '/AA',
  launch: '/S/Launch',
  gotoR: '/S/GoToR',
  uri: '/S/URI',
  embeddedFile: '/EmbeddedFile',
  fileSpec: '/Filespec',
  richMedia: '/RichMedia',
  threeD: '/Subtype/3D',
  movie: '/Movie',
  sound: '/Sound',
  svg: 'image/svg',
  svgTag: '<svg',
  xmlDecl: '<?xml',
  xmp: 'x:xmpmeta',
  metadata: '/Metadata',
  ocProperties: '/OCProperties',
  acroForm: '/AcroForm',
  encrypt: '/Encrypt',
  objStm: '/ObjStm',
  xrefStm: '/XRefStm',
  outputIntent: '/OutputIntent',
  gtsPdfx: 'GTS_PDFX',
  pdfaId: 'pdfaid',
  icc: '/ICCBased',
  separation: '/Separation',
  deviceN: '/DeviceN',
  deviceRgb: '/DeviceRGB',
  deviceCmyk: '/DeviceCMYK',
  deviceGray: '/DeviceGray',
  jpx: '/JPXDecode',
  jbig2: '/JBIG2Decode',
  dct: '/DCTDecode',
  smask: '/SMask',
  thumb: '/Thumb',
  pieceInfo: '/PieceInfo',
  pattern: '/Pattern',
  shading: '/Shading',
  type3Font: '/Type3',
  formXObject: '/XObject',
  fileName: '/Filespec',
};

function countToken(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Fast byte-level reconnaissance. This pass is deliberately tolerant: it does not
 * depend on a valid xref table, so it still works when a PDF is broken.
 */
export function rawScan(bytes: Uint8Array): RawScan {
  const head = latin1(bytes.subarray(0, Math.min(bytes.length, 2048)));
  const headerMatch = /%PDF-(\d+\.\d+)/.exec(head);
  const version = headerMatch ? headerMatch[1] : null;
  const headerOffset = headerMatch ? headerMatch.index : -1;

  const text = latin1(bytes);
  // Whitespace-free copy makes token counting immune to PDF's optional spacing.
  const squashed = text.replace(/[\s\u0000]+/g, '');

  const tokens: Record<string, number> = {};
  for (const [key, needle] of Object.entries(TOKENS)) {
    tokens[key] = countToken(squashed, needle);
  }

  const eofCount = countToken(squashed, '%%EOF');
  const xrefCount = countToken(squashed, 'startxref');

  return {
    version,
    headerOffset,
    encrypted: tokens.encrypt > 0,
    linearized: countToken(squashed, '/Linearized') > 0,
    eofCount,
    incremental: Math.max(0, eofCount - 1),
    xrefCount,
    tokens,
  };
}
