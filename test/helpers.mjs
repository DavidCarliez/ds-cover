import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoverController } from '../src/controller.js';
import { CoverRouter } from '../src/router.js';

export const BASE_POLICY = `detectors:
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

export async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

export async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

export async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

export function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function messageStart() {
  return sse('message_start', {
    type: 'message_start',
    message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 1, output_tokens: 0 } },
  });
}

export function textBlock(text, { index = 0, chunkSize = 3 } = {}) {
  let output = sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  for (let offset = 0; offset < text.length; offset += chunkSize) {
    output += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(offset, offset + chunkSize) } });
  }
  return output + sse('content_block_stop', { type: 'content_block_stop', index });
}

export function finishStream(stopReason = 'end_turn') {
  return sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } })
    + sse('message_stop', { type: 'message_stop' });
}

export function extractText(body) {
  const content = body?.messages?.at(-1)?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => typeof block?.text === 'string' ? block.text : '').join('');
  return '';
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  return { raw, body: raw.length === 0 ? {} : JSON.parse(raw.toString('utf8')) };
}

export async function capture(req, captured) {
  const { raw, body } = await readJson(req);
  const record = { method: req.method, url: req.url, headers: req.headers, body, raw };
  captured.push(record);
  return record;
}

export function defaultUpstream(captured) {
  return async (req, res) => {
    const record = await capture(req, captured);
    const text = extractText(record.body);
    if (record.body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(messageStart() + textBlock(text) + finishStream());
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
    }
  };
}

export async function startHarness(t, { handler = defaultUpstream, sourcePolicy = BASE_POLICY } = {}) {
  const captured = [];
  const effectiveHandler = handler(captured);
  const upstream = http.createServer((req, res) => void effectiveHandler(req, res));
  const upstreamPort = await listen(upstream);
  const home = await mkdtemp(join(tmpdir(), 'ds-cover-test-'));
  const policyPath = join(home, 'source.yaml');
  await writeFile(policyPath, sourcePolicy);
  const controller = await new CoverController({
    home,
    port: await freePort(),
    upstream: `http://127.0.0.1:${upstreamPort}`,
    sourcePolicy: policyPath,
  }).init();
  const router = new CoverRouter(controller, { port: 0 });
  await router.start();
  t.after(async () => {
    try { controller.dispose(); } catch { /* Cleanup is best effort. */ }
    try { await controller.action('stop'); } catch { /* The daemon may already be stopped. */ }
    try { await router.dispose(); } catch { /* The router may already be closed. */ }
    try { await close(upstream); } catch { /* The upstream may already be closed. */ }
    await rm(home, { recursive: true, force: true });
  });
  const result = await controller.action('start');
  if (!result.ok) throw new Error(`Cover failed to start: ${result.diagnostic || result.output}`);
  const send = (content, extra = {}, headers = {}, options = {}) => fetch(`${router.baseURL}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'fixture-auth',
      'x-deepseek-harness-session-id': 'fixture-session',
      ...headers,
    },
    body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content }], ...extra }),
    ...options,
  });
  return { controller, router, captured, upstream, home, send };
}

export async function* readEventStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        for (const frame of buffer.split(/\r?\n\r?\n/u)) {
          const event = parseEvent(frame);
          if (event) yield event;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.search(/\r?\n\r?\n/u)) !== -1) {
        const match = /\r?\n\r?\n/u.exec(buffer.slice(end));
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + match[0].length);
        const event = parseEvent(frame);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(frame) {
  const data = frame.split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  if (!data) return undefined;
  return JSON.parse(data);
}

export async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

export function withTimeout(promise, ms = 2000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for asynchronous fixture.')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
