import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { RenderPage } from '../core/optimize';
import type { TextPage } from '../core/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = () => new URL('./pdfjs/', document.baseURI).href;

function loadingTask(bytes: Uint8Array) {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
    cMapUrl: `${assetBase()}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase()}standard_fonts/`,
  });
}

/** Extract page text with the real PDF.js text layer (fonts, encodings, ToUnicode). */
export async function extractText(
  bytes: Uint8Array,
  onPage?: (page: number) => void,
): Promise<TextPage[]> {
  const doc = await loadingTask(bytes).promise;
  const pages: TextPage[] = [];
  try {
    for (let index = 1; index <= doc.numPages; index += 1) {
      const page = await doc.getPage(index);
      let text = '';
      let missingGlyphs = 0;
      try {
        const content = await page.getTextContent();
        let previousY: number | null = null;
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const chunk = item.str ?? '';
          const y = item.transform ? Math.round(item.transform[5]) : null;
          if (previousY !== null && y !== null && Math.abs(y - previousY) > 2) text += '\n';
          text += chunk;
          if (item.hasEOL) text += '\n';
          previousY = y;
          for (const char of chunk) {
            const code = char.codePointAt(0) ?? 0;
            if (code === 0xfffd || code === 0) missingGlyphs += 1;
          }
        }
      } catch {
        /* page text unavailable: analysis continues without it */
      }
      pages.push({ page: index, text, missingGlyphs });
      onPage?.(index);
      page.cleanup();
    }
  } finally {
    await doc.destroy().catch(() => undefined);
  }
  return pages;
}

export interface PageRenderer {
  renderPage: (pageIndex: number, dpi: number, quality: number) => Promise<RenderPage>;
  count: number;
  destroy: () => Promise<void>;
}

const MAX_CANVAS_SIDE = 8000;

export async function createRenderer(bytes: Uint8Array): Promise<PageRenderer> {
  const doc = await loadingTask(bytes).promise;

  const renderPage = async (pageIndex: number, dpi: number, quality: number): Promise<RenderPage> => {
    const page = await doc.getPage(pageIndex + 1);
    const base = page.getViewport({ scale: 1 });
    const requested = dpi / 72;
    const cap = MAX_CANVAS_SIDE / Math.max(base.width, base.height);
    const scale = Math.min(requested, cap);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D indisponible');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport, background: '#ffffff' }).promise;

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((value) => resolve(value), 'image/jpeg', quality),
    );
    if (!blob) throw new Error('Encodage JPEG impossible');
    const jpeg = new Uint8Array(await blob.arrayBuffer());
    const widthPt = viewport.width / scale;
    const heightPt = viewport.height / scale;
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
    return { jpeg, widthPt, heightPt };
  };

  return {
    renderPage,
    count: doc.numPages,
    destroy: () => doc.destroy().catch(() => undefined),
  };
}
