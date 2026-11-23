import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFObject, type PDFRef } from 'pdf-lib';
import { buildEnv, colorSpaceName, pageContentStreams, scanContent } from './content';
import { asStream, collectPages, get, loadPdf, nameOf, numOf, resolve } from './pdfdoc';
import { THRESHOLDS } from './thresholds';
import { humanBytes, toArrayBuffer } from './utils';

export type OptimizeMode = 'compress' | 'raster';

export interface RenderPage {
  jpeg: Uint8Array;
  widthPt: number;
  heightPt: number;
}

export interface OptimizeOptions {
  mode: OptimizeMode;
  /** Max effective resolution kept when recompressing images (compression mode). */
  imageDpi?: number;
  /** Target resolution for rasterisation. */
  rasterDpi?: number;
  /** JPEG quality 0–1. */
  quality?: number;
  stripMetadata?: boolean;
  removeActiveContent?: boolean;
  renderPage?: (pageIndex: number, dpi: number, quality: number) => Promise<RenderPage>;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Milliseconds to wait between pages, lets the UI breathe. */
  yieldMs?: number;
}

export interface OptimizeResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  notes: string[];
}

function isJpegFilter(dict: PDFDict, ctx: PDFDocument['context']): boolean {
  const filter = get(ctx, dict, 'Filter');
  const single = nameOf(filter);
  if (single) return single === 'DCTDecode' || single === 'DCT';
  return false;
}

function canvasToJpeg(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  quality: number,
): Promise<Uint8Array> {
  const draw = async (canvas: OffscreenCanvas | HTMLCanvasElement) => {
    const context2d = canvas.getContext('2d') as
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!context2d) throw new Error('Canvas 2D indisponible');
    context2d.fillStyle = '#ffffff';
    context2d.fillRect(0, 0, width, height);
    context2d.imageSmoothingEnabled = true;
    context2d.imageSmoothingQuality = 'high';
    context2d.drawImage(bitmap, 0, 0, width, height);
    if ('convertToBlob' in canvas) {
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      return new Uint8Array(await blob.arrayBuffer());
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((value) => resolve(value), 'image/jpeg', quality),
    );
    if (!blob) throw new Error('Encodage JPEG impossible');
    return new Uint8Array(await blob.arrayBuffer());
  };

  if (typeof OffscreenCanvas !== 'undefined') {
    return draw(new OffscreenCanvas(width, height));
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return draw(canvas);
}

async function decodeJpeg(bytes: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([toArrayBuffer(bytes)], { type: 'image/jpeg' });
  return createImageBitmap(blob);
}

interface PlacementInfo {
  dpi: number;
  width: number;
  height: number;
}

function imagePlacements(doc: PDFDocument): Map<PDFObject, PlacementInfo> {
  const ctx = doc.context;
  const pages = collectPages(ctx, doc.catalog);
  const map = new Map<PDFObject, PlacementInfo>();
  for (const page of pages) {
    const env = buildEnv(ctx, page.resources);
    const scan = scanContent(ctx, pageContentStreams(ctx, page.dict), page.index, env);
    for (const placement of scan.placements) {
      if (placement.dpi === null) continue;
      const existing = map.get(placement.raw);
      if (!existing || placement.dpi < existing.dpi) {
        map.set(placement.raw, {
          dpi: placement.dpi,
          width: placement.width,
          height: placement.height,
        });
      }
    }
  }
  return map;
}

export async function optimizePdf(input: Uint8Array, options: OptimizeOptions): Promise<OptimizeResult> {
  const notes: string[] = [];
  const quality = options.quality ?? 0.82;
  const onProgress = options.onProgress ?? (() => undefined);
  const pause = () => new Promise((resolve) => setTimeout(resolve, options.yieldMs ?? 0));

  if (options.mode === 'raster') {
    return rasterize(input, options, notes);
  }

  const doc = await loadPdf(input);
  const ctx = doc.context;

  if (options.removeActiveContent !== false) {
    const catalog = doc.catalog;
    const removed: string[] = [];
    if (get(ctx, catalog, 'OpenAction')) {
      catalog.delete(PDFName.of('OpenAction'));
      removed.push('action d’ouverture');
    }
    if (get(ctx, catalog, 'AA')) {
      catalog.delete(PDFName.of('AA'));
      removed.push('actions automatiques');
    }
    const names = get(ctx, catalog, 'Names');
    const namesDict = names instanceof PDFDict ? names : undefined;
    if (namesDict) {
      if (get(ctx, namesDict, 'JavaScript')) {
        namesDict.delete(PDFName.of('JavaScript'));
        removed.push('scripts nommés');
      }
      if (get(ctx, namesDict, 'EmbeddedFiles')) {
        namesDict.delete(PDFName.of('EmbeddedFiles'));
        removed.push('fichiers embarqués');
      }
    }

    let cleaned = 0;
    for (const [, object] of ctx.enumerateIndirectObjects()) {
      const dict =
        object instanceof PDFDict ? object : asStream(object as PDFObject)?.dict;
      if (!dict) continue;
      if (dict.has(PDFName.of('JS'))) {
        dict.delete(PDFName.of('JS'));
        cleaned += 1;
      }
      if (dict.has(PDFName.of('AA'))) {
        dict.delete(PDFName.of('AA'));
        cleaned += 1;
      }
      const action = get(ctx, dict, 'A');
      if (action instanceof PDFDict && nameOf(get(ctx, action, 'S')) === 'JavaScript') {
        dict.delete(PDFName.of('A'));
        cleaned += 1;
      }
    }
    if (removed.length || cleaned) {
      notes.push(
        `Contenu actif retiré : ${[...removed, cleaned ? `${cleaned} action(s)` : ''].filter(Boolean).join(', ')}.`,
      );
    }
  }

  if (options.stripMetadata !== false) {
    let stripped = 0;
    const orphans: PDFRef[] = [];
    const objects = ctx.enumerateIndirectObjects();
    for (const [ref, object] of objects) {
      const dict = object instanceof PDFDict ? object : asStream(object as PDFObject)?.dict;
      if (!dict) continue;
      const type = nameOf(get(ctx, dict, 'Type'));
      if (type === 'Metadata' || type === 'Thumb') {
        orphans.push(ref);
        continue;
      }
      if (type === 'OutputIntent') continue;
      for (const key of ['Metadata', 'PieceInfo', 'Thumb', 'LastModified']) {
        if (dict.has(PDFName.of(key))) {
          dict.delete(PDFName.of(key));
          stripped += 1;
        }
      }
    }
    for (const ref of orphans) {
      try {
        ctx.delete(ref);
        stripped += 1;
      } catch {
        /* object already gone */
      }
    }
    if (stripped) notes.push(`Métadonnées et vignettes retirées (${stripped}).`);
  }

  // ---- Image recompression ---------------------------------------------
  const placements = imagePlacements(doc);
  const refs = new Map<PDFObject, PDFRef>();
  for (const [ref, object] of ctx.enumerateIndirectObjects()) refs.set(object, ref);

  const maxDpi = options.imageDpi ?? THRESHOLDS.compress.targetDpi;
  let recompressed = 0;
  let savedBytes = 0;
  let skipped = 0;
  let index = 0;
  const total = placements.size;

  for (const [raw, info] of placements) {
    index += 1;
    onProgress(index, total, `Image ${index}/${total}`);
    if (info.dpi <= maxDpi + THRESHOLDS.compress.toleranceDpi) continue;
    const stream = asStream(raw);
    if (!stream) continue;
    if (stream.contents.length < 120_000) continue;
    const dict = stream.dict;
    if (!isJpegFilter(dict, ctx)) {
      skipped += 1;
      continue;
    }
    if (get(ctx, dict, 'DecodeParms')) {
      skipped += 1;
      continue;
    }
    const colorSpace = colorSpaceName(ctx, get(ctx, dict, 'ColorSpace'));
    const isGray = colorSpace.space === 'DeviceGray' || colorSpace.space === 'ICCBased/Gray';
    const isRgb = colorSpace.space === 'DeviceRGB' || colorSpace.space === 'ICCBased/RGB';
    if (!isGray && !isRgb) {
      skipped += 1;
      continue;
    }
    const ratio = maxDpi / info.dpi;
    const width = Math.min(10000, Math.max(1, Math.round(info.width * ratio)));
    const height = Math.min(10000, Math.max(1, Math.round(info.height * ratio)));
    if (width >= info.width && height >= info.height) continue;

    try {
      const bitmap = await decodeJpeg(stream.contents);
      const jpeg = await canvasToJpeg(bitmap, width, height, quality);
      bitmap.close?.();
      if (jpeg.length >= stream.contents.length * 0.95) {
        skipped += 1;
        continue;
      }
      savedBytes += stream.contents.length - jpeg.length;
      dict.set(PDFName.of('Width'), PDFNumber.of(width));
      dict.set(PDFName.of('Height'), PDFNumber.of(height));
      dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      dict.set(PDFName.of('ColorSpace'), PDFName.of(isGray ? 'DeviceGray' : 'DeviceRGB'));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      dict.delete(PDFName.of('DecodeParms'));
      dict.delete(PDFName.of('Decode'));
      dict.delete(PDFName.of('Length'));
      const ref = refs.get(raw);
      if (!ref) {
        skipped += 1;
        continue;
      }
      ctx.assign(ref, PDFRawStream.of(dict, jpeg));
      recompressed += 1;
    } catch {
      skipped += 1;
    }
    if (index % 4 === 0) await pause();
  }

  if (recompressed > 0) {
    notes.push(
      `${recompressed} image(s) JPEG réencodée(s) à ${maxDpi} dpi — ${humanBytes(savedBytes)} économisés.`,
    );
  }
  if (skipped > 0) notes.push(`${skipped} image(s) laissée(s) intacte(s) (CMJN, JPX, trop petite ou protégée).`);

  onProgress(total, total, 'Écriture du fichier');
  const bytes = await doc.save({
    useObjectStreams: true,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });

  return { bytes, before: input.length, after: bytes.length, notes };
}

async function rasterize(input: Uint8Array, options: OptimizeOptions, notes: string[]): Promise<OptimizeResult> {
  if (!options.renderPage) throw new Error('Fonction de rendu absente');
  const dpi = options.rasterDpi ?? THRESHOLDS.raster.defaultDpi;
  const quality = options.quality ?? 0.85;
  const onProgress = options.onProgress ?? (() => undefined);
  const pause = () => new Promise((resolve) => setTimeout(resolve, options.yieldMs ?? 0));

  const source = await loadPdf(input);
  const pages = collectPages(source.context, source.catalog);
  const out = await PDFDocument.create();
  out.setProducer('Pré-fly — rasterisation');
  out.setCreator('Pré-fly');

  for (let i = 0; i < pages.length; i += 1) {
    onProgress(i, pages.length, `Rasterisation ${i + 1}/${pages.length}`);
    const rendered = await options.renderPage(i, dpi, quality);
    const image = await out.embedJpg(rendered.jpeg);
    const page = out.addPage([rendered.widthPt, rendered.heightPt]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: rendered.widthPt,
      height: rendered.heightPt,
    });
    if (i % 2 === 0) await pause();
  }

  onProgress(pages.length, pages.length, 'Écriture du fichier');
  const bytes = await out.save({ useObjectStreams: true });
  notes.push(`${pages.length} page(s) rasterisée(s) à ${dpi} dpi (JPEG q${Math.round(quality * 100)}).`);
  notes.push('Le texte n’est plus vectoriel : les polices et tons directs sont aplatis.');
  return { bytes, before: input.length, after: bytes.length, notes };
}

export function suggestName(original: string, mode: OptimizeMode, dpi?: number): string {
  const base = original.replace(/\.pdf$/i, '');
  return mode === 'raster' ? `${base}-raster-${dpi ?? 200}dpi.pdf` : `${base}-compresse.pdf`;
}
