import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const source = 'node_modules/pdfjs-dist';
if (!existsSync(source)) {
  console.error('pdfjs-dist absent — lancez `npm install`.');
  process.exit(1);
}

await rm('public/pdfjs', { recursive: true, force: true });
await mkdir('public/pdfjs', { recursive: true });
await cp(`${source}/cmaps`, 'public/pdfjs/cmaps', { recursive: true });
await cp(`${source}/standard_fonts`, 'public/pdfjs/standard_fonts', { recursive: true });
console.log('pdfjs assets → public/pdfjs (cmaps, standard_fonts)');
