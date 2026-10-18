import { build } from 'esbuild';
import { mkdir, writeFile, rename } from 'node:fs/promises';

await mkdir('lib', { recursive: true });
await build({
  entryPoints: ['src/server.js'], outfile: 'lib/server.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: false,
});
const client = await build({
  entryPoints: ['src/client.jsx'], bundle: true, write: false,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  loader: { '.css': 'text' }, sourcemap: false,
});
const code = `window.__ModuleLoader__.load({\n  id: 'ds-cover',\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${client.outputFiles[0].text}\n    return module.exports;\n  }\n});\n`;
await writeFile('lib/client.js.tmp', code);
await rename('lib/client.js.tmp', 'lib/client.js');
console.log('Built ds-cover host and native web client.');
