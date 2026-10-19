import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const sourcePaths = ['package.json', 'package-lock.json', 'bundle.yml', 'README.md', 'LICENSE', 'scripts', 'src'];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, { cwd, env }) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})${output ? `:\n${output}` : ''}`);
  }
  return result.stdout;
}

function packResult(stdout) {
  // npm pack --json emits either an array or a name-keyed object, and lifecycle
  // script output may precede it.
  const starts = [...stdout.matchAll(/[[{]/g)].map(match => match.index).sort((left, right) => left - right);
  for (const index of starts) {
    try {
      const parsed = JSON.parse(stdout.slice(index));
      const entries = Array.isArray(parsed)
        ? parsed
        : Object.values(parsed).filter(value => value && typeof value === 'object' && !Array.isArray(value));
      const entry = entries.find(value => typeof value?.filename === 'string' && Array.isArray(value.files));
      if (entry) return entry;
    } catch { /* not the payload yet */ }
  }
  throw new Error(`Unexpected npm pack output:\n${stdout.trim()}`);
}

const temporary = await mkdtemp(join(tmpdir(), 'ds-cover-package-'));
try {
  console.log('Copying tracked and current source into a clean checkout...');
  const listed = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...sourcePaths], { cwd: root });
  const files = listed.split('\0').filter(Boolean);
  const privatePath = /(^|\/)(?:\.env[^/]*|\.config|\.local|private|artifacts)(?:\/|$)|\.(?:key|log)$|(^|\/)(?:config|policy)\.ya?ml$/i;
  assert.ok(files.length > 0, 'No source files were found to package.');
  for (const file of files) {
    assert.ok(!file.startsWith('lib/') && !file.startsWith('node_modules/'), `Refusing to copy generated path ${file}.`);
    assert.ok(!privatePath.test(file), `Refusing to copy private path ${file}.`);
    const destination = join(temporary, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, file), destination);
  }
  assert.ok(!existsSync(join(temporary, 'lib')), 'Clean checkout unexpectedly contains generated lib files.');

  const home = join(temporary, '.home');
  const npmrc = join(temporary, '.npmrc');
  await mkdir(home, { recursive: true });
  await writeFile(npmrc, '');
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    npm_config_cache: join(temporary, '.npm-cache'),
    npm_config_userconfig: npmrc,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    NO_COLOR: '1',
  };
  delete env.COVER_BIN;

  console.log('Installing dependencies without running lifecycle scripts...');
  run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: temporary, env });
  await rm(join(temporary, 'lib'), { recursive: true, force: true });
  assert.ok(!existsSync(join(temporary, 'lib')), 'Dependency installation created generated lib files.');

  console.log('Packing through the prepack lifecycle...');
  const packDir = join(temporary, 'pack');
  await mkdir(packDir);
  const pack = packResult(run(npm, ['pack', '--json', '--pack-destination', packDir, '--loglevel=error'], { cwd: temporary, env }));
  const tarball = join(packDir, pack.filename);
  assert.ok(existsSync(tarball), 'npm pack did not produce a tarball.');

  const required = ['LICENSE', 'README.md', 'bundle.yml', 'lib/client.js', 'lib/server.js', 'package.json'];
  const packed = pack.files.map(file => file.path).sort();
  for (const file of required) assert.ok(packed.includes(file), `Packed tarball is missing ${file}.`);
  const unexpected = packed.filter(file => !required.includes(file));
  assert.deepEqual(unexpected, [], `Packed tarball contains unexpected files: ${unexpected.join(', ')}`);

  console.log('Loading the packed host export and native client factory...');
  const installed = join(temporary, 'node_modules', 'ds-cover');
  await mkdir(installed, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'], { cwd: temporary, env });

  await writeFile(join(temporary, 'verify-package.mjs'), `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const host = await import('ds-cover');
assert.equal(host.name, 'ds-cover');
assert.equal(typeof host.apply, 'function');
assert.ok(Array.isArray(host.inject) && host.inject.includes('llm'), 'Host export has unexpected injection points.');

const clientCode = await readFile(join(process.cwd(), 'node_modules', 'ds-cover', 'lib', 'client.js'), 'utf8');
const registrations = [];
const sandboxWindow = { __ModuleLoader__: { load(registration) { registrations.push(registration); } } };
new Function('window', clientCode)(sandboxWindow);
assert.equal(registrations.length, 1, 'Client bundle did not register exactly one module.');
const [registration] = registrations;
assert.equal(registration.id, 'ds-cover');
assert.equal(typeof registration.factory, 'function');
const require = createRequire(import.meta.url);
const client = registration.factory(id => id === '@deepseek-ai/dsh-client-ui-primitives'
  ? { Modal: () => null }
  : require(id));
assert.equal(typeof client.apply, 'function', 'Client factory did not export apply().');
assert.ok(Array.isArray(client.inject) && client.inject.includes('slots'), 'Client factory has unexpected injection points.');
`);
  run(process.execPath, ['verify-package.mjs'], { cwd: temporary, env });
  console.log(`Clean package check passed for ${pkg.name}@${pkg.version}.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
