import { build } from 'esbuild';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function writeAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

await mkdir('lib', { recursive: true });

const server = await build({
  entryPoints: ['src/server.js'], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: false,
});
const client = await build({
  entryPoints: ['src/client.jsx'], bundle: true, write: false,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  loader: { '.css': 'text' }, sourcemap: false,
});

const clientCode = `window.__ModuleLoader__.load({\n  id: 'ds-cover',\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${client.outputFiles[0].text}\n    return module.exports;\n  }\n});\n`;

// Build both artifacts before replacing either file, then move each into
// place atomically. A failed build leaves the previous pair usable.
await writeAtomic('lib/server.js', server.outputFiles[0].text);
await writeAtomic('lib/client.js', clientCode);
console.log('Built ds-cover host and native web client.');
