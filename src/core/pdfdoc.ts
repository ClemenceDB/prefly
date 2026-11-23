import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  PDFString,
} from 'pdf-lib';
import { inflateSync, unzlibSync } from 'fflate';
import { latin1 } from './utils';

export const nm = (key: string) => PDFName.of(key);

export function resolve(ctx: PDFContext, obj: PDFObject | undefined | null): PDFObject | undefined {
  if (obj === undefined || obj === null) return undefined;
  try {
    return ctx.lookup(obj as PDFObject);
  } catch {
    return undefined;
  }
}

export function get(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined;
  const raw = dict.get(nm(key));
  return resolve(ctx, raw);
}

export function asDict(obj: PDFObject | undefined): PDFDict | undefined {
  return obj instanceof PDFDict ? obj : undefined;
}

export function asArray(obj: PDFObject | undefined): PDFArray | undefined {
  return obj instanceof PDFArray ? obj : undefined;
}

export function nameOf(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFName) {
    try {
      return obj.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function numOf(obj: PDFObject | undefined): number | undefined {
  if (obj instanceof PDFNumber) return obj.asNumber();
  return undefined;
}

export function boolOf(obj: PDFObject | undefined): boolean | undefined {
  if (obj instanceof PDFBool) return obj.asBoolean();
  return undefined;
}

export function strOf(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    try {
      return obj.decodeText();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function dictKeyNames(dict: PDFDict): string[] {
  const names: string[] = [];
  for (const [key] of dict.entries()) names.push(key.decodeText());
  return names;
}

/** Resolved entries of a dict: name -> object (refs already followed). */
export function entriesOf(ctx: PDFContext, dict: PDFDict | undefined): Map<string, PDFObject> {
  const map = new Map<string, PDFObject>();
  if (!dict) return map;
  for (const [key, value] of dict.entries()) {
    const resolved = resolve(ctx, value);
    if (resolved !== undefined) map.set(key.decodeText(), resolved);
  }
  return map;
}

export interface StreamLike {
  dict: PDFDict;
  contents: Uint8Array;
}

export function asStream(obj: PDFObject | undefined): StreamLike | null {
  if (!obj) return null;
  const candidate = obj as unknown as { dict?: unknown; contents?: unknown };
  if (candidate.dict instanceof PDFDict && candidate.contents instanceof Uint8Array) {
    return { dict: candidate.dict, contents: candidate.contents };
  }
  return null;
}

export function streamByteLength(obj: PDFObject | undefined): number {
  const stream = asStream(obj);
  return stream ? stream.contents.length : 0;
}

function ascii85Decode(input: Uint8Array): Uint8Array | null {
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  let i = 0;
  if (input[0] === 0x3c && input[1] === 0x7e) i = 2;
  for (; i < input.length; i += 1) {
    const c = input[i];
    if (c === 0x7e) break;
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) continue;
    if (c === 0x7a && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) continue;
    tuple = tuple * 85 + (c - 33);
    count += 1;
    if (count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let k = count; k < 5; k += 1) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Uint8Array.from(out);
}

function asciiHexDecode(input: Uint8Array): Uint8Array | null {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
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
  return Uint8Array.from(out);
}

function runLengthDecode(input: Uint8Array): Uint8Array | null {
  const out: number[] = [];
  let i = 0;
  while (i < input.length) {
    const length = input[i];
    i += 1;
    if (length === 128) break;
    if (length < 128) {
      for (let k = 0; k <= length && i < input.length; k += 1) out.push(input[i++]);
    } else {
      const byte = input[i++];
      for (let k = 0; k < 257 - length; k += 1) out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

function filterNames(filterObj: PDFObject | undefined): string[] {
  const single = nameOf(filterObj);
  if (single) return [single];
  const array = asArray(filterObj);
  if (!array) return [];
  const names: string[] = [];
  for (let i = 0; i < array.size(); i += 1) {
    const name = nameOf(array.get(i));
    if (name) names.push(name);
  }
  return names;
}

/** Decode a stream we need to read as text (content streams, XMP, files). */
export function decodeStream(obj: PDFObject | undefined): Uint8Array | null {
  const stream = asStream(obj);
  if (!stream) return null;
  const filterObj = get(stream.dict.context, stream.dict, 'Filter');
  const filters = filterNames(filterObj);
  let data = stream.contents;
  for (const filter of filters) {
    const next = applyFilter(filter, data);
    if (!next) return null;
    data = next;
  }
  return data;
}

function applyFilter(filter: string, data: Uint8Array): Uint8Array | null {
  try {
    switch (filter) {
      case 'FlateDecode':
      case 'Fl':
        try {
          return unzlibSync(data);
        } catch {
          try {
            return inflateSync(data);
          } catch {
            return null;
          }
        }
      case 'ASCIIHexDecode':
      case 'AHx':
        return asciiHexDecode(data);
      case 'ASCII85Decode':
      case 'A85':
        return ascii85Decode(data);
      case 'RunLengthDecode':
      case 'RL':
        return runLengthDecode(data);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function streamText(obj: PDFObject | undefined): string {
  const decoded = decodeStream(obj);
  if (!decoded) return '';
  return latin1(decoded);
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function parseBox(value: PDFObject | undefined): Box | undefined {
  const array = asArray(value);
  if (!array || array.size() < 4) return undefined;
  const nums: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const n = numOf(array.get(i));
    if (n === undefined) return undefined;
    nums.push(n);
  }
  const [x1, y1, x2, y2] = nums;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

export interface PageInfo {
  index: number;
  dict: PDFDict;
  resources?: PDFDict;
  mediaBox: Box;
  cropBox?: Box;
  trimBox?: Box;
  bleedBox?: Box;
  rotate: number;
}

interface Inherited {
  resources?: PDFDict;
  mediaBox?: Box;
  cropBox?: Box;
  rotate?: number;
}

export function collectPages(ctx: PDFContext, catalog: PDFDict | undefined): PageInfo[] {
  const pages: PageInfo[] = [];
  if (!catalog) return pages;
  const root = asDict(get(ctx, catalog, 'Pages'));
  if (!root) return pages;

  const seen = new Set<PDFDict>();

  const walk = (node: PDFDict, inherited: Inherited, depth: number) => {
    if (depth > 64 || seen.has(node)) return;
    seen.add(node);

    const type = nameOf(get(ctx, node, 'Type'));
    const kids = asArray(get(ctx, node, 'Kids'));
    const resources = asDict(get(ctx, node, 'Resources')) ?? inherited.resources;
    const mediaBox = parseBox(get(ctx, node, 'MediaBox')) ?? inherited.mediaBox;
    const cropBox = parseBox(get(ctx, node, 'CropBox')) ?? inherited.cropBox;
    const rotateValue = numOf(get(ctx, node, 'Rotate'));
    const rotate = rotateValue === undefined ? inherited.rotate ?? 0 : rotateValue;

    if (type === 'Pages' || (kids && type !== 'Page')) {
      if (!kids) return;
      const next: Inherited = { resources, mediaBox, cropBox, rotate };
      for (let i = 0; i < kids.size(); i += 1) {
        const kid = asDict(resolve(ctx, kids.get(i)));
        if (kid) walk(kid, next, depth + 1);
      }
      return;
    }

    pages.push({
      index: pages.length + 1,
      dict: node,
      resources,
      mediaBox: mediaBox ?? { x: 0, y: 0, width: 595.28, height: 841.89 },
      cropBox,
      trimBox: parseBox(get(ctx, node, 'TrimBox')),
      bleedBox: parseBox(get(ctx, node, 'BleedBox')),
      rotate: ((rotate % 360) + 360) % 360,
    });
  };

  walk(root, {}, 0);
  return pages;
}

export function pagesHaveContent(ctx: PDFContext, page: PageInfo): boolean {
  const contents = get(ctx, page.dict, 'Contents');
  if (!contents) return false;
  const array = asArray(contents);
  if (array) {
    for (let i = 0; i < array.size(); i += 1) {
      const stream = asStream(resolve(ctx, array.get(i)));
      if (stream) return true;
    }
    return false;
  }
  return asStream(contents) !== null;
}

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, {
    ignoreEncryption: true,
    updateMetadata: false,
    throwOnInvalidObject: false,
  });
}

export function documentInfoDict(ctx: PDFContext): PDFDict | undefined {
  return asDict(resolve(ctx, ctx.trailerInfo.Info));
}
