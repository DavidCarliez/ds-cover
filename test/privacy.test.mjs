import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoverController } from '../src/controller.js';
import { CoverRouter } from '../src/router.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function freePort() {
  const server = http.createServer(); const port = await listen(server); await close(server); return port;
}

async function setup(t) {
  const captured = [];
  const upstream = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : {};
    captured.push({ path: req.url, headers: req.headers, body });
    const text = body.messages?.at(-1)?.content || '';
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: ' + JSON.stringify({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }) + '\n\n');
      res.write('event: content_block_start\ndata: ' + JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + '\n\n');
      for (let offset = 0; offset < text.length; offset += 3) res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(offset, offset + 3) } }) + '\n\n');
      res.end('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    }
  });
  const upstreamPort = await listen(upstream);
  const home = await mkdtemp(join(tmpdir(), 'ds-cover-test-'));
  const sourcePolicy = join(home, 'source.yaml');
  await writeFile(sourcePolicy, `detectors:\n  regex:\n    enabled: false\nrules:\n  credential:\n    pattern: 'original-[A-Za-z0-9]+'\n    action: pseudonymize\n    generator: alias\n  forbidden:\n    pattern: 'BLOCK-ME'\n    action: block\n`);
  const controller = await new CoverController({ home, port: await freePort(), upstream: `http://127.0.0.1:${upstreamPort}`, sourcePolicy }).init();
  const router = new CoverRouter(controller, { port: 0 });
  await router.start();
  t.after(async () => { controller.dispose(); await controller.action('stop'); await router.dispose(); await close(upstream); await rm(home, { recursive: true, force: true }); });
  const result = await controller.action('start');
  assert.equal(result.ok, true, result.diagnostic);
  const send = (text, extra = {}) => fetch(`${router.baseURL}/anthropic/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-auth', 'x-deepseek-harness-session-id': 'fixture-session' },
    body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: text }], ...extra }),
  });
  return { controller, router, captured, send };
}

test('real Cover protects outbound text, restores split SSE, and preserves native auth and attribution', async t => {
  const { captured, send } = await setup(t);
  const original = 'original-Private4902';
  const response = await send(original, { stream: true });
  assert.equal(response.status, 200);
  const stream = await response.text();
  const text = stream.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(event => event.type === 'content_block_delta').map(event => event.delta.text || '').join('');
  assert.equal(text, original);
  assert.notEqual(captured[0].body.messages[0].content, original);
  assert.equal(captured[0].headers['x-api-key'], 'fixture-auth');
  assert.equal(captured[0].headers['x-deepseek-harness-session-id'], 'fixture-session');
  assert.equal(captured[0].headers['x-cover-session'], undefined);
  const second = await send(original);
  assert.equal((await second.json()).content[0].text, original);
  assert.equal(captured[1].body.messages[0].content, captured[0].body.messages[0].content);
});

test('policy blocks never reach upstream, including with direct fallback enabled', async t => {
  const { controller, captured, send } = await setup(t);
  await controller.setState({ autoFallback: true });
  const response = await send('BLOCK-ME original-Private4902');
  assert.equal(response.status, 403);
  assert.equal(captured.length, 0);
});

test('stopped daemon fails closed; explicit fallback and off route directly without replay', async t => {
  const { controller, captured, send } = await setup(t);
  await controller.action('stop');
  const blocked = await send('original-Private4902');
  assert.equal(blocked.status, 502);
  assert.equal(captured.length, 0);
  await controller.setState({ autoFallback: true });
  assert.equal((await send('original-Fallback4902')).status, 200);
  assert.equal(captured[0].body.messages[0].content, 'original-Fallback4902');
  await controller.setState({ enabled: false, autoFallback: false });
  assert.equal((await send('original-Disabled4902')).status, 200);
  assert.equal(captured[1].body.messages[0].content, 'original-Disabled4902');
});

test('browser-origin requests cannot use the native router and invalid policies do not replace configuration', async t => {
  const { controller, router, captured } = await setup(t);
  const response = await fetch(`${router.baseURL}/anthropic/v1/messages`, { method: 'POST', headers: { origin: 'https://example.com' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal(captured.length, 0);
  const policy = await controller.policy();
  await assert.rejects(controller.savePolicy(policy + '\nunknown_configuration_field: true\n'), /rejected/);
  assert.equal(await controller.policy(), policy);
});

test('all six Cover actions remain available through the policy editor and local preview', async t => {
  const { controller, captured, send } = await setup(t);
  const policy = (await controller.policy()).replace(
    '  credential:',
    "  placeholder_value:\n    pattern: 'placeholder-private'\n    action: placeholder\n  masked_value:\n    pattern: 'masked-private'\n    action: mask\n  redacted_value:\n    pattern: 'redacted-private'\n    action: redact\n  allowed_value:\n    pattern: 'original-PublicExample'\n    action: allow\n    priority: 1000\n  credential:",
  );
  await controller.savePolicy(policy);
  for (const [value, action] of [
    ['original-Private4902', 'pseudonymize'], ['placeholder-private', 'placeholder'],
    ['masked-private', 'mask'], ['redacted-private', 'redact'],
    ['original-PublicExample', 'allow'], ['BLOCK-ME', 'block'],
  ]) {
    const preview = await controller.inspect(JSON.stringify({ messages: [{ role: 'user', content: value }] }));
    if (action === 'block') assert.equal(preview.blocked, true);
    else if (action === 'allow') assert.equal(preview.transformed_request.messages[0].content, value);
    else assert.notEqual(preview.transformed_request.messages[0].content, value);
  }
  assert.equal(captured.length, 0, 'preview must never contact the upstream');
  await controller.action('restart');
  const response = await send('placeholder-private');
  assert.equal((await response.json()).content[0].text, 'placeholder-private');
  assert.notEqual(captured[0].body.messages[0].content, 'placeholder-private');
});
