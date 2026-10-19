import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cache = join(here, '..', 'node_modules', '.cache');

// Compile the real client entry point with the same automatic JSX, CSS text
// loader and primitive boundary the production build uses. React stays
// external so the test renderer and the client share one React instance.
export async function loadClientModule() {
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'ds-cover-client-'));
  const outfile = join(directory, 'client.mjs');
  try {
    await build({
      entryPoints: [join(here, '..', 'src/client.jsx')],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      jsx: 'automatic',
      loader: { '.css': 'text' },
      external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
      logLevel: 'silent',
      plugins: [{
        name: 'ds-cover-test-primitives',
        setup(builder) {
          builder.onResolve({ filter: /^@deepseek-ai\/dsh-client-ui-primitives$/ }, () => ({ path: join(here, 'modal-adapter.mjs') }));
        },
      }],
    });
    const module = await import(pathToFileURL(outfile).href);
    return { module, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
