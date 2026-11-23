import { PDFArray, PDFDict, type PDFContext, type PDFObject } from 'pdf-lib';
import { asArray, asDict, asStream, boolOf, decodeStream, get, nameOf, numOf, resolve } from './pdfdoc';
import { latin1 } from './utils';

export type Operand =
  | number
  | boolean
  | null
  | { kind: 'name'; value: string }
  | { kind: 'string'; bytes: Uint8Array }
  | { kind: 'dict' }
  | Operand[];

interface Markers {
  arrayStart: object;
  dict: object;
}

const MARKER: Markers = { arrayStart: { marker: 'array' }, dict: { marker: 'dict' } };

const isWhitespace = (c: number) =>
  c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;

const isDelimiter = (c: number) =>
  c === 0x28 ||
  c === 0x29 ||
  c === 0x3c ||
  c === 0x3e ||
  c === 0x5b ||
  c === 0x5d ||
  c === 0x7b ||
  c === 0x7d ||
  c === 0x2f ||
  c === 0x25;

function readLiteralString(bytes: Uint8Array, start: number): { bytes: Uint8Array; next: number } {
  let i = start + 1;
  let depth = 1;
  const out: number[] = [];
  while (i < bytes.length) {
    const c = bytes[i];
    i += 1;
    if (c === 0x5c) {
      const e = bytes[i];
      i += 1;
      switch (e) {
        case 0x6e:
          out.push(0x0a);
          break;
        case 0x72:
          out.push(0x0d);
          break;
        case 0x74:
          out.push(0x09);
          break;
        case 0x62:
          out.push(0x08);
          break;
        case 0x66:
          out.push(0x0c);
          break;
        case 0x28:
          out.push(0x28);
          break;
        case 0x29:
          out.push(0x29);
          break;
        case 0x5c:
          out.push(0x5c);
          break;
        case 0x0d:
          if (bytes[i] === 0x0a) i += 1;
          break;
        case 0x0a:
          break;
        default:
          if (e >= 0x30 && e <= 0x37) {
            let value = e - 0x30;
            for (let k = 0; k < 2; k += 1) {
              const d = bytes[i];
              if (d >= 0x30 && d <= 0x37) {
                value = value * 8 + (d - 0x30);
                i += 1;
              } else break;
            }
            out.push(value & 0xff);
          } else if (e !== undefined) {
            out.push(e);
          }
      }
      continue;
    }
    if (c === 0x28) {
      depth += 1;
      out.push(c);
      continue;
    }
    if (c === 0x29) {
      depth -= 1;
      if (depth === 0) break;
      out.push(c);
      continue;
    }
    out.push(c);
  }
  return { bytes: Uint8Array.from(out), next: i };
}

function readHexString(bytes: Uint8Array, start: number): { bytes: Uint8Array; next: number } {
  let i = start + 1;
  const out: number[] = [];
  let hi = -1;
  while (i < bytes.length) {
    const c = bytes[i];
    i += 1;
    if (c === 0x3e) break;
    let value = -1;
    if (c >= 0x30 && c <= 0x39) value = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) value = c - 0x37;
    else if (c >= 0x61 && c <= 0x66) value = c - 0x57;
    else continue;
    if (hi < 0) hi = value;
    else {
      out.push((hi << 4) | value);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi << 4);
  return { bytes: Uint8Array.from(out), next: i };
}

function readName(bytes: Uint8Array, start: number): { value: string; next: number } {
  let i = start + 1;
  let raw = '';
  while (i < bytes.length) {
    const c = bytes[i];
    if (isWhitespace(c) || isDelimiter(c)) break;
    raw += String.fromCharCode(c);
    i += 1;
  }
  const value = raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  return { value, next: i };
}

function skipDict(bytes: Uint8Array, start: number): number {
  let i = start;
  let depth = 0;
  while (i < bytes.length) {
    const c = bytes[i];
    if (c === 0x28) {
      i = readLiteralString(bytes, i).next;
      continue;
    }
    if (c === 0x3c && bytes[i + 1] === 0x3c) {
      depth += 1;
      i += 2;
      continue;
    }
    if (c === 0x3e && bytes[i + 1] === 0x3e) {
      depth -= 1;
      i += 2;
      if (depth <= 0) return i;
      continue;
    }
    if (c === 0x3c) {
      i = readHexString(bytes, i).next;
      continue;
    }
    i += 1;
  }
  return i;
}

function skipInlineImage(bytes: Uint8Array, start: number): number {
  let i = start;
  // Find the ID keyword that ends the inline image dictionary.
  while (i < bytes.length) {
    while (i < bytes.length && isWhitespace(bytes[i])) i += 1;
    const tokenStart = i;
    while (i < bytes.length && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i += 1;
    if (i === tokenStart) {
      i += 1;
      continue;
    }
    const token = latin1(bytes.subarray(tokenStart, i));
    if (token === 'ID') {
      i += 1;
      break;
    }
  }
  // Locate EI bounded by whitespace on both sides.
  while (i < bytes.length - 1) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x49 &&
      (i === 0 || isWhitespace(bytes[i - 1])) &&
      (i + 2 >= bytes.length || isWhitespace(bytes[i + 2]) || isDelimiter(bytes[i + 2]))
    ) {
      return i + 2;
    }
    i += 1;
  }
  return bytes.length;
}

export function parseContentStream(
  bytes: Uint8Array,
  onOperator: (op: string, operands: Operand[]) => void,
): void {
  let i = 0;
  const n = bytes.length;
  let operands: Operand[] = [];

  while (i < n) {
    const c = bytes[i];
    if (isWhitespace(c)) {
      i += 1;
      continue;
    }
    if (c === 0x25) {
      while (i < n && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1;
      continue;
    }
    if (c === 0x28) {
      const result = readLiteralString(bytes, i);
      operands.push({ kind: 'string', bytes: result.bytes });
      i = result.next;
      continue;
    }
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        i = skipDict(bytes, i);
        operands.push({ kind: 'dict' });
        continue;
      }
      const result = readHexString(bytes, i);
      operands.push({ kind: 'string', bytes: result.bytes });
      i = result.next;
      continue;
    }
    if (c === 0x5b) {
      operands.push(MARKER.arrayStart as unknown as Operand);
      i += 1;
      continue;
    }
    if (c === 0x5d) {
      const items: Operand[] = [];
      while (operands.length > 0 && operands[operands.length - 1] !== (MARKER.arrayStart as unknown as Operand)) {
        items.unshift(operands.pop() as Operand);
      }
      if (operands.length > 0) operands.pop();
      operands.push(items);
      i += 1;
      continue;
    }
    if (c === 0x2f) {
      const result = readName(bytes, i);
      operands.push({ kind: 'name', value: result.value });
      i = result.next;
      continue;
    }
    if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) {
      const start = i;
      i += 1;
      while (i < n) {
        const d = bytes[i];
        if ((d >= 0x30 && d <= 0x39) || d === 0x2e || d === 0x2b || d === 0x2d || d === 0x45 || d === 0x65) {
          i += 1;
        } else break;
      }
      const value = Number(latin1(bytes.subarray(start, i)));
      operands.push(Number.isFinite(value) ? value : 0);
      continue;
    }

    const start = i;
    while (i < n && !isWhitespace(bytes[i]) && !isDelimiter(bytes[i])) i += 1;
    if (i === start) {
      i += 1;
      continue;
    }
    const word = latin1(bytes.subarray(start, i));
    if (word === 'true' || word === 'false') {
      operands.push(word === 'true');
      continue;
    }
    if (word === 'null') {
      operands.push(null);
      continue;
    }
    if (word === 'BI') {
      i = skipInlineImage(bytes, i);
      onOperator('BI', []);
      continue;
    }
    onOperator(word, operands);
    operands = [];
  }
}

export interface ResEnv {
  fonts?: Map<string, PDFDict>;
  xobjects?: Map<string, PDFObject>;
  colorSpaces?: Map<string, PDFObject>;
  extGStates?: Map<string, PDFDict>;
  properties?: Map<string, PDFDict>;
  parent?: ResEnv;
}

function resourcesMap(
  ctx: PDFContext,
  resources: PDFDict | undefined,
  key: string,
): Map<string, PDFDict> {
  const map = new Map<string, PDFDict>();
  const target = asDict(get(ctx, resources, key));
  if (!target) return map;
  for (const [name, value] of target.entries()) {
    const dict = asDict(resolve(ctx, value));
    if (dict) map.set(name.decodeText(), dict);
  }
  return map;
}

/** XObjects may be streams (images, forms) so we keep the raw object around. */
function resourcesObjects(
  ctx: PDFContext,
  resources: PDFDict | undefined,
  key: string,
): Map<string, PDFObject> {
  const map = new Map<string, PDFObject>();
  const target = asDict(get(ctx, resources, key));
  if (!target) return map;
  for (const [name, value] of target.entries()) {
    const resolved = resolve(ctx, value);
    if (resolved) map.set(name.decodeText(), resolved);
  }
  return map;
}

export function buildEnv(
  ctx: PDFContext,
  resources: PDFDict | undefined,
  parent?: ResEnv,
): ResEnv {
  const colorSpaces = new Map<string, PDFObject>();
  const csDict = asDict(get(ctx, resources, 'ColorSpace'));
  if (csDict) {
    for (const [name, value] of csDict.entries()) {
      const resolved = resolve(ctx, value);
      if (resolved) colorSpaces.set(name.decodeText(), resolved);
    }
  }
  const properties = new Map<string, PDFDict>();
  const propsDict = asDict(get(ctx, resources, 'Properties'));
  if (propsDict) {
    for (const [name, value] of propsDict.entries()) {
      const dict = asDict(resolve(ctx, value));
      if (dict) properties.set(name.decodeText(), dict);
    }
  }
  return {
    fonts: resourcesMap(ctx, resources, 'Font'),
    xobjects: resourcesObjects(ctx, resources, 'XObject'),
    colorSpaces,
    extGStates: resourcesMap(ctx, resources, 'ExtGState'),
    properties,
    parent,
  };
}

export function envLookup<T>(env: ResEnv | undefined, kind: keyof ResEnv, name: string): T | undefined {
  let current = env;
  let guard = 0;
  while (current && guard < 32) {
    const map = current[kind] as unknown as Map<string, T> | undefined;
    const value = map?.get(name);
    if (value !== undefined) return value;
    current = current.parent;
    guard += 1;
  }
  return undefined;
}

export interface ColorDescriptor {
  space: string;
  spot?: string;
}

function colorSpaceName(ctx: PDFContext, obj: PDFObject | undefined, depth = 0): ColorDescriptor {
  if (!obj || depth > 8) return { space: 'Inconnu' };
  const direct = nameOf(obj);
  if (direct) {
    if (direct === 'DeviceRGB' || direct === 'RGB') return { space: 'DeviceRGB' };
    if (direct === 'DeviceCMYK' || direct === 'CMYK') return { space: 'DeviceCMYK' };
    if (direct === 'DeviceGray' || direct === 'G') return { space: 'DeviceGray' };
    if (direct === 'Pattern') return { space: 'Pattern' };
    return { space: direct };
  }
  const array = asArray(obj);
  if (!array) {
    const stream = asStream(obj);
    if (stream) {
      const n = numOf(get(ctx, stream.dict, 'N'));
      if (n === 3) return { space: 'ICCBased/RGB' };
      if (n === 4) return { space: 'ICCBased/CMYK' };
      if (n === 1) return { space: 'ICCBased/Gray' };
      return { space: 'ICCBased' };
    }
    return { space: 'Inconnu' };
  }
  const family = nameOf(array.get(0)) ?? 'Inconnu';
  switch (family) {
    case 'Separation':
      return { space: 'Separation', spot: nameOf(array.get(1)) ?? 'Ton direct' };
    case 'DeviceN': {
      const names = asArray(array.get(1));
      const spots: string[] = [];
      if (names) {
        for (let i = 0; i < names.size(); i += 1) {
          const name = nameOf(names.get(i));
          if (name) spots.push(name);
        }
      }
      return { space: 'DeviceN', spot: spots.join(', ') || 'DeviceN' };
    }
    case 'Indexed': {
      const base = colorSpaceName(ctx, array.get(1), depth + 1);
      return { space: `Indexed/${base.space}`, spot: base.spot };
    }
    case 'ICCBased': {
      const stream = asStream(array.get(1));
      if (stream) {
        const n = numOf(get(ctx, stream.dict, 'N'));
        return { space: n === 3 ? 'ICCBased/RGB' : n === 4 ? 'ICCBased/CMYK' : 'ICCBased' };
      }
      return { space: 'ICCBased' };
    }
    case 'Pattern':
      return { space: 'Pattern' };
    case 'CalRGB':
      return { space: 'CalRGB' };
    case 'CalGray':
      return { space: 'CalGray' };
    case 'Lab':
      return { space: 'Lab' };
    default:
      return { space: family };
  }
}

export { colorSpaceName };

function deviceColorSpace(name: string): ColorDescriptor {
  switch (name) {
    case 'DeviceRGB':
    case 'RGB':
      return { space: 'DeviceRGB' };
    case 'DeviceCMYK':
    case 'CMYK':
      return { space: 'DeviceCMYK' };
    case 'DeviceGray':
    case 'G':
      return { space: 'DeviceGray' };
    case 'Pattern':
      return { space: 'Pattern' };
    default:
      return { space: name };
  }
}

export interface ImagePlacement {
  page: number;
  resourceName: string;
  dict: PDFDict;
  raw: PDFObject;
  width: number;
  height: number;
  dpi: number | null;
  placedW: number;
  placedH: number;
  inForm: boolean;
}

export interface PageScan {
  placements: ImagePlacement[];
  fontsUsed: Map<string, PDFDict>;
  colors: ColorDescriptor[];
  transparency: boolean;
  overprint: boolean;
  layers: boolean;
  shading: boolean;
  pattern: boolean;
  inlineImages: number;
  textSamples: string[];
  textLength: number;
  decodedContent: boolean;
  transparencyGroups: number;
}


function nameOperand(operands: Operand[]): string | undefined {
  for (let i = operands.length - 1; i >= 0; i -= 1) {
    const candidate = operands[i];
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      'kind' in candidate &&
      candidate.kind === 'name'
    ) {
      return candidate.value;
    }
  }
  return undefined;
}

function multiply(m: number[], c: number[]): number[] {
  return [
    m[0] * c[0] + m[1] * c[2],
    m[0] * c[1] + m[1] * c[3],
    m[2] * c[0] + m[3] * c[2],
    m[2] * c[1] + m[3] * c[3],
    m[4] * c[0] + m[5] * c[2] + c[4],
    m[4] * c[1] + m[5] * c[3] + c[5],
  ];
}

function decodeUtf16(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }
  return latin1(bytes);
}

function stringOperand(op: Operand): string {
  if (op && typeof op === 'object' && 'kind' in op && op.kind === 'string') {
    return decodeUtf16(op.bytes);
  }
  return '';
}

/** Reject strings that are clearly CID garbage (glyph ids rather than text). */
function printableRatio(text: string): number {
  if (!text.length) return 0;
  let printable = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || (c >= 160 && c <= 0x24f)) {
      printable += 1;
    }
  }
  return printable / text.length;
}

export function scanContent(
  ctx: PDFContext,
  content: Uint8Array[],
  pageNumber: number,
  env: ResEnv,
): PageScan {
  const result: PageScan = {
    placements: [],
    fontsUsed: new Map(),
    colors: [],
    transparency: false,
    overprint: false,
    layers: false,
    shading: false,
    pattern: false,
    inlineImages: 0,
    textSamples: [],
    textLength: 0,
    decodedContent: content.length > 0,
    transparencyGroups: 0,
  };

  const seenForms = new Set<PDFDict>();
  let textBudget = 600_000;

  const run = (bytes: Uint8Array, currentEnv: ResEnv, startCtm: number[], depth: number) => {
    let ctm = startCtm.slice();
    const stack: { ctm: number[]; fill?: ColorDescriptor; stroke?: ColorDescriptor }[] = [];
    let fillSpace: ColorDescriptor | undefined;
    let strokeSpace: ColorDescriptor | undefined;

    parseContentStream(bytes, (op, operands) => {
      switch (op) {
        case 'q':
          stack.push({ ctm: ctm.slice(), fill: fillSpace, stroke: strokeSpace });
          break;
        case 'Q': {
          const restored = stack.pop();
          if (restored) {
            ctm = restored.ctm;
            fillSpace = restored.fill;
            strokeSpace = restored.stroke;
          }
          break;
        }
        case 'cm': {
          const values = operands.slice(-6).map((v) => (typeof v === 'number' ? v : 0));
          if (values.length === 6) ctm = multiply(values, ctm);
          break;
        }
        case 'Tf': {
          const fontName = nameOperand(operands);
          if (fontName) {
            const font = envLookup<PDFDict>(currentEnv, 'fonts', fontName);
            if (font) result.fontsUsed.set(fontName, font);
          }
          break;
        }
        case 'Tj':
        case "'":
        case '"':
          for (const operand of operands) {
            const text = stringOperand(operand);
            if (text) recordText(text);
          }
          break;
        case 'TJ': {
          const array = operands.find((o) => Array.isArray(o));
          if (Array.isArray(array)) {
            for (const item of array) {
              const text = stringOperand(item);
              if (text) recordText(text);
            }
          }
          break;
        }
        case 'Do': {
          const xobjectName = nameOperand(operands);
          if (!xobjectName) break;
          const xobjectRaw = envLookup<PDFObject>(currentEnv, 'xobjects', xobjectName);
          if (!xobjectRaw) break;
          const xobject = asDict(xobjectRaw) ?? asStream(xobjectRaw)?.dict;
          if (!xobject) break;
          const subtype = nameOf(get(ctx, xobject, 'Subtype'));
          if (subtype === 'Image') {
            const width = numOf(get(ctx, xobject, 'Width')) ?? 0;
            const height = numOf(get(ctx, xobject, 'Height')) ?? 0;
            const wPt = Math.hypot(ctm[0], ctm[1]);
            const hPt = Math.hypot(ctm[2], ctm[3]);
            const dpiX = wPt > 0.1 ? (width * 72) / wPt : null;
            const dpiY = hPt > 0.1 ? (height * 72) / hPt : null;
            const dpi =
              dpiX !== null && dpiY !== null ? Math.min(dpiX, dpiY) : dpiX ?? dpiY ?? null;
            result.placements.push({
              page: pageNumber,
              resourceName: xobjectName,
              dict: xobject,
              raw: xobjectRaw,
              width,
              height,
              dpi: dpi === null ? null : Math.round(dpi),
              placedW: Math.round(wPt * 10) / 10,
              placedH: Math.round(hPt * 10) / 10,
              inForm: depth > 0,
            });
          } else if (subtype === 'Form' && depth < 4 && !seenForms.has(xobject)) {
            seenForms.add(xobject);
            const group = asDict(get(ctx, xobject, 'Group'));
            if (nameOf(get(ctx, group, 'S')) === 'Transparency') {
              result.transparency = true;
              result.transparencyGroups += 1;
            }
            const formResources = asDict(get(ctx, xobject, 'Resources'));
            const formEnv = formResources ? buildEnv(ctx, formResources, currentEnv) : currentEnv;
            const matrix = asArray(get(ctx, xobject, 'Matrix'));
            let formCtm = ctm;
            if (matrix && matrix.size() >= 6) {
              const values: number[] = [];
              for (let i = 0; i < 6; i += 1) values.push(numOf(matrix.get(i)) ?? 0);
              formCtm = multiply(values, ctm);
            }
            const formContent = decodeStream(xobjectRaw);
            if (formContent) run(formContent, formEnv, formCtm, depth + 1);
          }
          break;
        }
        case 'gs': {
          const gsName = nameOperand(operands);
          if (!gsName) break;
          const gs = envLookup<PDFDict>(currentEnv, 'extGStates', gsName);
          if (!gs) break;
          const ca = numOf(get(ctx, gs, 'ca'));
          const CA = numOf(get(ctx, gs, 'CA'));
          const bm = nameOf(get(ctx, gs, 'BM'));
          if ((ca !== undefined && ca < 1) || (CA !== undefined && CA < 1) || get(ctx, gs, 'SMask')) {
            result.transparency = true;
          }
          if (bm && bm !== 'Normal' && bm !== 'Compatible') result.transparency = true;
          if (boolTrue(get(ctx, gs, 'OP')) || boolTrue(get(ctx, gs, 'op')) || numOf(get(ctx, gs, 'OPM')) === 1) {
            result.overprint = true;
          }
          break;
        }
        case 'rg':
        case 'RG':
          result.colors.push({ space: 'DeviceRGB' });
          break;
        case 'g':
        case 'G':
          result.colors.push({ space: 'DeviceGray' });
          break;
        case 'k':
        case 'K':
          result.colors.push({ space: 'DeviceCMYK' });
          break;
        case 'cs':
        case 'CS': {
          const spaceName = nameOperand(operands);
          if (!spaceName) break;
          const target = envLookup<PDFObject>(currentEnv, 'colorSpaces', spaceName);
          const descriptor = target ? colorSpaceName(ctx, target) : deviceColorSpace(spaceName);
          if (descriptor.space === 'Pattern' || descriptor.space.startsWith('Pattern')) result.pattern = true;
          if (op === 'cs') fillSpace = descriptor;
          else strokeSpace = descriptor;
          result.colors.push(descriptor);
          break;
        }
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const current = op === 'sc' || op === 'scn' ? fillSpace : strokeSpace;
          if (current) {
            if (current.space === 'Separation' || current.space === 'DeviceN') {
              result.colors.push(current);
            } else if (current.space === 'Pattern') {
              result.pattern = true;
            }
          }
          break;
        }
        case 'sh':
          result.shading = true;
          break;
        case 'BI':
          result.inlineImages += 1;
          break;
        case 'BDC':
        case 'BMC': {
          const tag = nameOperand(operands);
          if (tag === 'OC') result.layers = true;
          break;
        }
        default:
          break;
      }
    });

    function boolTrue(value: PDFObject | undefined): boolean {
      return boolOf(value) === true;
    }

    function recordText(text: string) {
      if (textBudget <= 0) return;
      result.textLength += text.length;
      const ratio = printableRatio(text);
      if (ratio < 0.85) return;
      textBudget -= text.length;
      if (text.length >= 3) result.textSamples.push(text);
    }
  };

  for (const bytes of content) run(bytes, env, [1, 0, 0, 1, 0, 0], 0);
  return result;
}

export function pageContentStreams(ctx: PDFContext, pageDict: PDFDict): Uint8Array[] {
  const contents = get(ctx, pageDict, 'Contents');
  const streams: Uint8Array[] = [];
  const push = (obj: PDFObject | undefined) => {
    const decoded = decodeStream(obj);
    if (decoded) streams.push(decoded);
  };
  const array: PDFArray | undefined = asArray(contents);
  if (array) {
    for (let i = 0; i < array.size(); i += 1) push(resolve(ctx, array.get(i)));
  } else if (contents) {
    push(contents);
  }
  return streams;
}
