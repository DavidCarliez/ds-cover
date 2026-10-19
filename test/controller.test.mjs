import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { CoverController } from '../src/controller.js';
import { CoverError } from '../src/errors.js';

const VALID_SOURCE = `network:
  allow_remote: true
mappings:
  session_header: imported-header
  max_sessions: 7
  max_entries_per_session: 11
detectors:
  regex:
    enabled: false
rules:
  credential:
    pattern: 'original-[A-Za-z0-9]+'
    action: pseudonymize
    generator: alias
  forbidden:
    pattern: 'BLOCK-ME'
    action: block
`;

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function makeController(t, { source = VALID_SOURCE, binary } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'ds-cover-controller-'));
  const sourcePolicy = join(home, 'source.yaml');
  if (source !== null) await writeFile(sourcePolicy, source);
  const controller = new CoverController({ home, binary, port: await freePort(), sourcePolicy });
  t.after(async () => {
    controller.dispose();
    try { await controller.action('stop'); } catch { /* The fake or missing binary cannot stop anything. */ }
    await rm(home, { recursive: true, force: true });
  });
  return { controller, home, sourcePolicy };
}

async function waitForStatus(controller, predicate) {
  let status = await controller.status();
  for (let attempt = 0; attempt < 30 && !predicate(status); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    status = await controller.status();
  }
  return status;
}

test('invalid imported policy is rejected before the private config is written', async t => {
  const source = `network:\n  allow_remote: false\nunknown_private_setting: 'PRIVATE-IMPORT-VALUE'\n`;
  const { controller, home } = await makeController(t, { source });
  await assert.rejects(controller.init(), error => {
    assert.ok(error instanceof CoverError);
    assert.equal(error.code, 'cover/policy-invalid');
    assert.doesNotMatch(error.message, /PRIVATE-IMPORT-VALUE|unknown_private_setting|yaml: unmarshal|Usage:/u);
    return true;
  });
  await assert.rejects(access(join(home, '.config/cover/config.yaml')), { code: 'ENOENT' });
});

test('imported nested settings survive boundary overrides and the source policy is untouched', async t => {
  const { controller, sourcePolicy } = await makeController(t);
  await controller.init();
  const config = YAML.parse(await controller.policy());
  assert.equal(config.listen, `127.0.0.1:${controller.port}`);
  assert.equal(config.upstream, 'https://api.deepseek.com');
  assert.equal(config.network.allow_remote, false);
  assert.equal(config.mappings.session_header, 'X-Cover-Session');
  assert.equal(config.mappings.max_sessions, 7);
  assert.equal(config.mappings.max_entries_per_session, 11);
  assert.equal(config.detectors.regex.enabled, false);
  assert.equal(config.rules.credential.pattern, 'original-[A-Za-z0-9]+');
  assert.equal(config.pseudonymization.key_file, join(controller.home, '.config/cover/pseudonym.key'));
  assert.equal(config.log_file, join(controller.home, '.local/share/cover/redactions.log'));
  assert.equal(await readFile(sourcePolicy, 'utf8'), VALID_SOURCE);
});

test('semantically invalid saves fail without replacing the persisted policy', async t => {
  const { controller } = await makeController(t);
  await controller.init();
  const policy = await controller.policy();
  const invalid = policy.replace('action: pseudonymize', 'action: explode');
  assert.notEqual(invalid, policy);
  await assert.rejects(controller.savePolicy(invalid), error => {
    assert.ok(error instanceof CoverError);
    assert.equal(error.code, 'cover/policy-invalid');
    assert.doesNotMatch(error.message, /explode|rule "|yaml: unmarshal|Usage:/u);
    return true;
  });
  assert.equal(await controller.policy(), policy);
});

test('applied policy tracking distinguishes save, start no-op, restart, and controller reload', async t => {
  const { controller, home, sourcePolicy } = await makeController(t);
  await controller.init();
  const started = await controller.action('start');
  assert.equal(started.ok, true, started.diagnostic);

  let status = await waitForStatus(controller, value => value.running);
  assert.equal(status.policyState, 'active');
  assert.equal(status.restartRequired, false);
  assert.ok(Number.isInteger(status.checkedAt) && status.checkedAt > 0);
  const setup = await controller.setup();
  assert.equal(setup.checks[1].state, 'ok');
  assert.match(setup.checks[1].message, /owns/u);
  const applied = JSON.parse(await readFile(controller.appliedPath, 'utf8'));
  assert.equal(applied.version, 1);
  assert.equal(applied.port, controller.port);
  assert.match(applied.policyHash, /^[a-f0-9]{64}$/u);

  const policy = await controller.policy();
  const changed = policy.replace('pattern: original-[A-Za-z0-9]+', 'pattern: original-[A-Za-z0-9]{2,}');
  assert.notEqual(changed, policy);
  await controller.savePolicy(changed);
  status = await controller.status();
  assert.equal(status.policyState, 'pending');
  assert.equal(status.restartRequired, true);

  const external = (await controller.policy()).replace('pattern: BLOCK-ME', 'pattern: BLOCK-ME2');
  assert.notEqual(external, await controller.policy());
  await writeFile(controller.configPath, external);
  status = await controller.status();
  assert.equal(status.policyState, 'pending', 'external policy edits must not appear active');

  const noop = await controller.action('start');
  assert.equal(noop.ok, false, 'starting an already-running daemon must not claim a reload');
  status = await controller.status();
  assert.equal(status.policyState, 'pending');
  assert.equal(status.restartRequired, true);

  const reloaded = await new CoverController({
    home, binary: controller.binary, port: controller.port, upstream: controller.upstream, sourcePolicy,
  }).init();
  t.after(() => reloaded.dispose());
  status = await reloaded.status();
  assert.equal(status.policyState, 'pending', 'a new controller must read persisted applied-policy metadata');

  const restarted = await reloaded.action('restart');
  assert.equal(restarted.ok, true, restarted.diagnostic);
  status = await reloaded.status();
  assert.equal(status.policyState, 'active');
  assert.equal(status.restartRequired, false);
});

test('missing or foreign applied metadata reports unknown and stop clears tracking', async t => {
  const { controller } = await makeController(t);
  await controller.init();
  const started = await controller.run(['start', '--detach']);
  assert.equal(started.ok, true, started.diagnostic);

  let status = await waitForStatus(controller, value => value.running);
  assert.equal(status.policyState, 'unknown', 'an externally started daemon has no verified applied policy');
  assert.equal(status.restartRequired, true);

  const { daemon } = await controller.daemonStatus();
  await writeFile(controller.appliedPath, JSON.stringify({
    version: 1, policyHash: '0'.repeat(64), pid: daemon.pid + 1, port: controller.port, startedAt: Date.now(),
  }) + '\n', { mode: 0o600 });
  status = await controller.status();
  assert.equal(status.policyState, 'unknown', 'an unrelated daemon PID must not be trusted');
  assert.equal(status.restartRequired, true);

  const stopped = await controller.action('stop');
  assert.equal(stopped.ok, true, stopped.diagnostic);
  status = await controller.status();
  assert.equal(status.running, false);
  assert.equal(status.policyState, 'pending');
  assert.equal(status.restartRequired, false);
  await assert.rejects(access(controller.appliedPath), { code: 'ENOENT' });
});

test('setup reports binary and dedicated-port checks without starting a daemon', async t => {
  const { controller } = await makeController(t);
  await controller.init();
  const before = await controller.status();
  assert.equal(before.running, false);
  const result = await controller.setup();
  assert.deepEqual(result.checks.map(check => check.id), ['binary', 'daemon-port']);
  for (const check of result.checks) {
    assert.ok(typeof check.label === 'string' && check.label.length > 0);
    assert.ok(['ok', 'warning', 'error'].includes(check.state));
    assert.ok(typeof check.message === 'string' && check.message.length > 0);
  }
  assert.equal(result.checks[0].state, 'ok');
  assert.match(result.checks[0].message, /Cover \d+\.\d+\.\d+ is installed/u);
  assert.equal(result.checks[1].state, 'ok');
  assert.match(result.checks[1].message, /available|owns/u);
  assert.equal((await controller.status()).running, false, 'setup must not start the daemon');
});

test('status and setup remain usable when init did not run and the config is missing', async t => {
  const home = await mkdtemp(join(tmpdir(), 'ds-cover-controller-missing-'));
  const controller = new CoverController({
    home, binary: join(home, 'missing-cover'), port: await freePort(), sourcePolicy: join(home, 'source.yaml'),
  });
  t.after(async () => { controller.dispose(); await rm(home, { recursive: true, force: true }); });
  const status = await controller.status();
  assert.equal(status.running, false);
  assert.equal(status.policyState, 'pending');
  assert.equal(status.restartRequired, false);
  assert.ok(Number.isInteger(status.checkedAt) && status.checkedAt > 0);
  const result = await controller.setup();
  assert.equal(result.checks[0].id, 'binary');
  assert.equal(result.checks[0].state, 'error');
  assert.match(result.checks[0].message, /Install Cover/u);
  assert.equal(result.checks[1].id, 'daemon-port');
  assert.equal(result.checks[1].state, 'ok');
});

test('live monitor views expire and can be stopped explicitly', async t => {
  const { controller } = await makeController(t);
  await controller.init();
  const expiring = controller.startLive();
  const view = controller.live.get(expiring);
  assert.ok(view);
  clearTimeout(view.timer);
  view.timer = setTimeout(() => controller.stopLive(expiring), 10);
  view.timer.unref();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.throws(() => controller.touchLive(expiring), error => {
    assert.ok(error instanceof CoverError);
    assert.equal(error.code, 'cover/live-unavailable');
    return true;
  });

  const stopped = controller.startLive();
  controller.stopLive(stopped);
  assert.equal(controller.live.has(stopped), false);
  assert.throws(() => controller.touchLive(stopped), { code: 'cover/live-unavailable' });
});
