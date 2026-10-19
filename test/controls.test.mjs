import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { CoverController } from '../src/controller.js';
import { CoverControls } from '../src/controls.js';

async function fixture(t, { start = false } = {}) {
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const home = await mkdtemp(join(tmpdir(), 'ds-cover-controls-'));
  const sourcePolicy = join(home, 'source.yaml');
  await writeFile(sourcePolicy, 'detectors:\n  regex:\n    enabled: false\n');
  const controller = new CoverController({ home, port, sourcePolicy, upstream: 'http://127.0.0.1:1' });
  let controls;
  t.after(async () => {
    controls?.dispose();
    controller.dispose();
    await controller.action('stop').catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  await controller.init();
  if (start) {
    const result = await controller.action('start');
    assert.equal(result.ok, true, result.diagnostic);
  }
  controls = new CoverControls(controller, {
    status: (_provider, signal) => controller.status({ signal }),
    setup: signal => controller.setup({ signal }),
    signal: new AbortController().signal,
  });
  const clientId = randomUUID();
  const request = (endpoint, payload = {}, id = clientId) => controls.fetch(endpoint, new Request(`http://localhost/api/ds-cover/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ds-cover-client': id },
    body: JSON.stringify(payload),
  }));
  const call = async (endpoint, payload, id) => (await request(endpoint, payload, id)).json();
  return { controller, controls, request, call, clientId };
}

test('policy endpoint returns safe actionable validation errors and preserves the saved policy', async t => {
  const { controller, call } = await fixture(t);
  const original = await controller.policy();
  const marker = 'synthetic-secret-do-not-echo';
  const malformed = await call('savePolicy', { text: `${original}\ninvalid: [${marker}\n` });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, 'cover/policy-invalid');
  assert.match(malformed.error.message, /YAML|line|column/i);
  assert.equal(JSON.stringify(malformed).includes(marker), false);
  assert.equal(await controller.policy(), original);
  const rejected = await call('savePolicy', { text: original + '\nunknown_configuration_field: true\n' });
  assert.equal(rejected.error.code, 'cover/policy-invalid');
  assert.match(rejected.error.message, /unknown configuration field/i);
  assert.equal(await controller.policy(), original);
});

test('request validation and operation errors do not change protection state or daemon health', async t => {
  const { call } = await fixture(t, { start: true });
  const before = await call('status', { provider: 'deepseek-official' });
  assert.equal(before.value.running, true);
  const invalid = await call('state', { enabled: 'false' });
  assert.equal(invalid.error.code, 'cover/invalid-payload');
  const inspection = await call('inspect', { text: 'not JSON' });
  assert.equal(inspection.error.code, 'cover/request-invalid');
  const after = await call('status', { provider: 'deepseek-official' });
  assert.equal(after.value.running, true);
  assert.equal(after.value.enabled, true);
  assert.equal(after.value.autoFallback, false);
});

test('sensitive live leases reject a different browser and stop permanently on explicit close', async t => {
  const { call, controller } = await fixture(t, { start: true });
  const opened = await call('liveStart');
  assert.equal(opened.ok, true);
  const child = controller.live.get(opened.value).child;
  const exited = once(child, 'exit');
  const foreign = await call('livePoll', { id: opened.value }, randomUUID());
  assert.equal(foreign.error.code, 'cover/live-unavailable');
  assert.equal((await call('livePoll', { id: opened.value })).ok, true);
  assert.equal((await call('liveStop', { id: opened.value })).ok, true);
  await exited;
  assert.equal((await call('livePoll', { id: opened.value })).error.code, 'cover/live-unavailable');
  assert.equal(controller.live.has(opened.value), false);
});

test('abandoned sensitive leases expire and terminate their monitor process', async t => {
  const { call, controller, controls } = await fixture(t, { start: true });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const opened = await call('liveStart');
  assert.equal(opened.ok, true);
  const exited = once(controller.live.get(opened.value).child, 'exit');
  t.mock.timers.tick(15001);
  t.mock.timers.reset();
  await exited;
  assert.equal(controls.views.has(opened.value), false);
  assert.equal(controller.live.has(opened.value), false);
  assert.equal((await call('livePoll', { id: opened.value })).error.code, 'cover/live-unavailable');
});

test('plugin disposal cancels an incomplete request body and closes every sensitive lease', async t => {
  const { controls, call, controller, clientId } = await fixture(t, { start: true });
  const opened = await call('liveStart');
  const exited = once(controller.live.get(opened.value).child, 'exit');
  let cancelled = false;
  let bodyStarted;
  const started = new Promise(resolve => { bodyStarted = resolve; });
  const stream = new ReadableStream({
    pull(c) { c.enqueue(new TextEncoder().encode('{"text":')); bodyStarted(); return new Promise(() => {}); },
    cancel() { cancelled = true; },
  });
  const pending = controls.fetch('inspect', new Request('http://localhost/api/ds-cover/inspect', {
    method: 'POST', duplex: 'half', body: stream,
    headers: { 'content-type': 'application/json', 'x-ds-cover-client': clientId },
  }));
  await started;
  controls.dispose();
  const result = await (await pending).json();
  await exited;
  assert.equal(result.error.code, 'cover/cancelled');
  assert.equal(cancelled, true);
  assert.equal(controller.live.size, 0);
});

test('JSON escaping does not reduce the documented text limit and oversized bodies are bounded', async t => {
  const { request, controls, clientId } = await fixture(t);
  // This transport body exceeds the old 2x cap but its text is within 256 KiB.
  const acceptedTransport = await request('inspect', { text: '\0'.repeat(256 * 1024) });
  assert.equal(acceptedTransport.status, 200);
  assert.equal((await acceptedTransport.json()).error.code, 'cover/request-invalid');
  const tooMuchText = await request('inspect', { text: 'x'.repeat(256 * 1024 + 1) });
  assert.equal((await tooMuchText.json()).error.code, 'cover/invalid-payload');
  let cancelled = false;
  const body = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(256 * 1024 * 6 + 1025)); },
    cancel() { cancelled = true; },
  });
  const tooMuchBody = await controls.fetch('inspect', new Request('http://localhost/api/ds-cover/inspect', {
    method: 'POST', duplex: 'half', body,
    headers: { 'content-type': 'application/json', 'x-ds-cover-client': clientId },
  }));
  assert.equal(tooMuchBody.status, 413);
  assert.equal(cancelled, true);
  assert.equal(tooMuchBody.headers.get('cache-control'), 'no-store');
});
