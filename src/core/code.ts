export type CodeKind =
  | 'svg'
  | 'html'
  | 'xml'
  | 'javascript'
  | 'css'
  | 'python'
  | 'shell'
  | 'json'
  | 'template'
  | 'postscript'
  | 'base64'
  | 'token';

export interface CodeMatch {
  kind: CodeKind;
  label: string;
  snippet: string;
  strong: boolean;
  index: number;
}

interface Rule {
  kind: CodeKind;
  label: string;
  strong: boolean;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { kind: 'svg', label: 'balise <svg>', strong: true, pattern: /<svg[\s>]/i },
  { kind: 'svg', label: 'espace de noms SVG', strong: true, pattern: /xmlns(:[\w-]+)?\s*=\s*["']https?:\/\/www\.w3\.org\/2000\/svg/i },
  { kind: 'svg', label: 'attribut viewBox', strong: true, pattern: /viewBox\s*=\s*["']-?[\d.]+\s+-?[\d.]+/i },
  {
    kind: 'svg',
    label: 'élément de dessin vectoriel',
    strong: true,
    pattern: /<\/?(path|g|rect|circle|ellipse|polygon|polyline|lineargradient|radialgradient|clippath|defs|symbol|use|mask)\b[^>]{0,240}\/?>/i,
  },
  { kind: 'xml', label: 'déclaration XML', strong: true, pattern: /<\?xml\s+version/i },
  { kind: 'xml', label: 'DOCTYPE', strong: true, pattern: /<!DOCTYPE\s+[\w:]/i },
  {
    kind: 'xml',
    label: 'balise XML avec attributs',
    strong: true,
    pattern: /<[a-zA-Z][\w:.-]*\s+[\w:.-]+\s*=\s*["'][^"']{0,200}["'][^<>]{0,200}\/?>/,
  },
  {
    kind: 'html',
    label: 'balise HTML',
    strong: true,
    pattern: /<\/?(html|head|body|div|span|table|thead|tbody|tr|td|ul|ol|li|style|script|meta|link|iframe|section|header|footer|nav|main)\b[^>]{0,240}>/i,
  },
  { kind: 'javascript', label: 'déclaration JavaScript', strong: true, pattern: /\b(function|const|let|var)\s+[\w$]+\s*(=\s*)?(function|async|\()/ },
  { kind: 'javascript', label: 'fonction fléchée', strong: true, pattern: /\(?[\w$,\s]{0,40}\)?\s*=>\s*[{(]/ },
  { kind: 'javascript', label: 'appel console', strong: true, pattern: /\bconsole\.(log|warn|error|info|debug)\s*\(/ },
  { kind: 'javascript', label: 'accès DOM', strong: true, pattern: /\b(document|window)\.(getElementById|querySelector|querySelectorAll|createElement|addEventListener|location)\b/ },
  { kind: 'javascript', label: 'balise <script>', strong: true, pattern: /<\/?script\b/i },
  { kind: 'javascript', label: 'module JS', strong: true, pattern: /\b(module\.exports|require\s*\(\s*["'])/ },
  { kind: 'css', label: 'règle @media', strong: true, pattern: /@media\s+[^{]{0,90}\{/ },
  { kind: 'css', label: 'bloc :root', strong: true, pattern: /:root\s*\{[^}]{0,200}\}/ },
  { kind: 'css', label: 'règle CSS', strong: false, pattern: /[.#][\w-]{2,40}\s*\{[^}]{0,240}:[^}]{0,160};/ },
  { kind: 'python', label: 'définition Python', strong: true, pattern: /\bdef\s+[A-Za-z_]\w*\s*\([^)]{0,120}\):/ },
  { kind: 'python', label: 'import Python', strong: true, pattern: /^\s*(import\s+[\w.]+|from\s+[\w.]+\s+import\s+[\w*,\s]+)$/m },
  { kind: 'shell', label: 'shebang', strong: true, pattern: /^#!\/usr\/bin\/(env\s+)?(ba|z|k)?sh/ },
  { kind: 'shell', label: 'commande shell', strong: false, pattern: /\b(sudo\s+)?(apt-get|brew|npm|pip)\s+(install|run|i)\b/ },
  { kind: 'template', label: 'gabarit {{ }}', strong: true, pattern: /\{\{[^}]{0,120}\}\}/ },
  { kind: 'template', label: 'gabarit <% %>', strong: true, pattern: /<%[-=]?[^%]{0,160}%>/ },
  { kind: 'template', label: 'balise PHP', strong: true, pattern: /<\?php\b/i },
  { kind: 'postscript', label: 'code PostScript', strong: true, pattern: /%!PS-Adobe|\bsetpagedevice\b|\bshowpage\b/ },
  { kind: 'json', label: 'objet JSON', strong: false, pattern: /"[\w-]{1,40}"\s*:\s*("([^"]{0,80})"|-?\d+(\.\d+)?|true|false|null|\[|\{)\s*,?/ },
  { kind: 'base64', label: 'données base64', strong: true, pattern: /data:[\w/+.-]+;base64,[A-Za-z0-9+/=\s]{60,}/ },
];

const MAX_SCAN = 400_000;

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return raw.length > 150 ? `${raw.slice(0, 149)}…` : raw;
}

export function detectCode(input: string): CodeMatch[] {
  const text = input.length > MAX_SCAN ? input.slice(0, MAX_SCAN) : input;
  const matches: CodeMatch[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let hit = re.exec(text);
    let guard = 0;
    while (hit && guard < 4) {
      guard += 1;
      const key = `${rule.kind}:${hit[0].slice(0, 40)}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({
          kind: rule.kind,
          label: rule.label,
          snippet: snippetAround(text, hit.index, hit[0].length),
          strong: rule.strong,
          index: hit.index,
        });
      }
      hit = re.exec(text);
    }
    if (matches.length > 24) break;
  }
  return matches;
}

export function strongCodeKinds(matches: CodeMatch[]): CodeKind[] {
  return Array.from(new Set(matches.filter((m) => m.strong).map((m) => m.kind)));
}

export const CODE_LABEL: Record<CodeKind, string> = {
  svg: 'SVG',
  html: 'HTML',
  xml: 'XML',
  javascript: 'JavaScript',
  css: 'CSS',
  python: 'Python',
  shell: 'Shell',
  json: 'JSON',
  template: 'Gabarit',
  postscript: 'PostScript',
  base64: 'Base64',
  token: 'Chaîne suspecte',
};
