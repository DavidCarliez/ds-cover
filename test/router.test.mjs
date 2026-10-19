import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { CoverRouter } from '../src/router.js';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function setup(t) {
  const captured = [];
  const upstream = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    captured.push({ path: request.url, body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ content: [{ type: 'text', text: body }] }));
  });
  const upstreamPort = await listen(upstream);
  const controller = {
    state: { enabled: false, autoFallback: false },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    baseURL: 'http://127.0.0.1:1',
    health: async () => false,
  };
  const router = new CoverRouter(controller, { port: 0 });
  await router.start();
  t.after(async () => { await router.dispose(); await close(upstream); });
  return { controller, router, captured };
}

function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

function send(router, body = '{}') {
  return fetch(`${router.baseURL}/anthropic/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
}

test('malformed request targets return 400 and the router remains usable', async t => {
  const { router, captured } = await setup(t);
  const response = await rawRequest(router.port, '//[');
  assert.match(response, /^HTTP\/1\.1 400/u);
  assert.equal(router.active, 0);

  const valid = await send(router, 'after-malformed-target');
  assert.equal(valid.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(router.active, 0);
});

test('unexpected handler rejections become one local failure response', async t => {
  const { router, captured } = await setup(t);
  const original = router.handle;
  router.handle = async () => { throw new Error('synthetic handler failure'); };
  try {
    const response = await send(router);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.type, 'ds_cover');
  } finally {
    router.handle = original;
  }
  assert.equal(captured.length, 0);
  assert.equal(router.active, 0);

  const valid = await send(router, 'after-handler-failure');
  assert.equal(valid.status, 200);
  assert.equal(captured.length, 1);
});

test('outgoing creation failure releases the active count and never replays directly', async t => {
  const { router, captured } = await setup(t);
  const original = http.request;
  http.request = () => { throw new Error('synthetic outgoing failure'); };
  try {
    const response = await send(router, 'must-not-be-replayed');
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.type, 'ds_cover');
  } finally {
    http.request = original;
  }
  assert.equal(captured.length, 0, 'a failed outgoing request must not be replayed directly');
  assert.equal(router.active, 0);

  const valid = await send(router, 'after-outgoing-failure');
  assert.equal(valid.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(router.active, 0);
});
