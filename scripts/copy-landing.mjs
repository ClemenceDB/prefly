import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await cp('landing', 'dist', { recursive: true });
console.log('landing → dist/');
