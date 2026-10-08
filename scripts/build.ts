import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');

const builds: esbuild.BuildOptions[] = [
  // Browser dashboard, served at /app.js.
  {
    entryPoints: [path.join(root, 'src/web/app.ts')],
    outfile: path.join(root, 'dist/public/app.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    sourcemap: true,
  },
  // Laptop connector, downloaded by install.sh as a single self-contained file.
  {
    entryPoints: [path.join(root, 'src/connector/connector.ts')],
    outfile: path.join(root, 'dist/connector.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.5',
  },
];

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
  console.log('Watching src/web and src/connector for changes…');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  console.log('Built dist/public/app.js and dist/connector.js');
}
