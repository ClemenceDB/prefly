const LATIN1 = new TextDecoder('latin1');

export function latin1(bytes: Uint8Array): string {
  if (bytes.length < 0x8000) return LATIN1.decode(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += LATIN1.decode(bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  }
  return out;
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace('.', ',')} ${units[unit]}`;
}

export function humanNumber(n: number): string {
  return new Intl.NumberFormat('fr-FR').format(Math.round(n));
}

export function round(n: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function ptToMm(pt: number): number {
  return (pt * 25.4) / 72;
}

/** Millimètres avec une décimale, virgule française. */
export function formatMm(mm: number): string {
  const rounded = Math.round(mm * 10) / 10;
  return `${String(rounded).replace('.', ',')} mm`;
}

export function formatPageSize(wPt: number, hPt: number): string {
  const w = Math.round(ptToMm(wPt));
  const h = Math.round(ptToMm(hPt));
  return `${w} × ${h} mm`;
}

/** Best-effort name normalisation for BaseFont values (subset prefix, encoding suffix). */
export function cleanFontName(raw: string): string {
  let name = raw.replace(/^[A-Z]{6}\+/, '');
  name = name.replace(/,(Bold|Italic|BoldItalic|Regular|Medium|Light|Black|Semibold)$/i, ' $1');
  name = name.replace(/-/g, ' ');
  return name.replace(/\s+/g, ' ').trim();
}

export function isSubsetName(raw: string): boolean {
  return /^[A-Z]{6}\+/.test(raw);
}

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export function truncate(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function yieldToUi(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Copy into a fresh ArrayBuffer so the bytes can cross Blob / worker boundaries. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
