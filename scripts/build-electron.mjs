import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
mkdirSync(new URL('../electron/dist', import.meta.url), { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'info',
  define: {
    'process.env.PREFLY_VERSION': JSON.stringify(pkg.version),
  },
};

await build({
  ...shared,
  entryPoints: ['electron/main.ts'],
  outfile: 'electron/dist/main.cjs',
});

await build({
  ...shared,
  entryPoints: ['electron/preload.ts'],
  outfile: 'electron/dist/preload.cjs',
});
