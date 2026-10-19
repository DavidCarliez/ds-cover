import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeepSeekAdapter, DeepSeekFileStore, DeepSeekFilesClient, DeepSeekUploadIndex,
  resolveAdapterOptions,
} from '@deepseek-ai/dsh-llm-deepseek';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { join } from 'node:path';
import {
  BASE_POLICY, capture, extractText, finishStream, messageStart, sse,
  startHarness, textBlock, waitFor, withTimeout,
} from './helpers.mjs';

const VISION_MODEL = 'vision-fixture';

function createAdapter(router, { auth, files, attachment } = {}) {
  const options = resolveAdapterOptions({
    baseURL: `${router.baseURL}/anthropic`,
    models: [
      { id: 'fixture', inputModalities: ['text'] },
      { id: VISION_MODEL, inputModalities: ['text', 'image'] },
    ],
    maxTokens: 4096,
  });
  return new DeepSeekAdapter({
    options: () => options,
    resolveAuth: async () => ({ headers: auth }),
    resolveUserId: () => 'native-user',
    ...(files === undefined ? {} : { resolveFiles: () => files }),
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    ...(attachment === undefined ? {} : {
      resolveAttachments: () => attachment.store,
      resolveImageAccess: () => undefined,
    }),
  });
}

function nativeStream(adapter, { message, model = 'fixture', sessionId, signal } = {}) {
  return adapter.stream({
    provider: 'deepseek-official',
    model,
    sessionId,
    signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: message }] }],
  });
}

function isolatedFiles(home) {
  return new DeepSeekFileStore({
    index: new DeepSeekUploadIndex(join(home, 'llm-deepseek', 'files.json')),
  });
}

async function collect(stream) {
  const chunks = [];
  let text = '';
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  return {
    chunks,
    text,
    finish: chunks.at(-1)?.type === 'finish' ? chunks.at(-1) : undefined,
    usage: chunks.find(chunk => chunk.type === 'usage'),
  };
}

test('native adapter restores text split across SSE events and streamed tool arguments before a tool-calls finish', async t => {
  const original = 'original-ToolSecret4902';
  const { captured, router, home } = await startHarness(t, {
    handler: capturedRequests => async (req, res) => {
      const record = await capture(req, capturedRequests);
      const fake = extractText(record.body);
      const text = `reply:${fake}:end`;
      const split = 6 + Math.floor(fake.length / 2);
      const argumentsText = JSON.stringify({ target: fake, note: 'safe' });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let output = messageStart();
      output += sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      output += sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, split) } });
      output += sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(split) } });
      output += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
      output += sse('content_block_start', {
        type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: 'toolu_fixture', name: 'run_command', input: {} },
      });
      for (let offset = 0; offset < argumentsText.length; offset += 5) {
        output += sse('content_block_delta', {
          type: 'content_block_delta', index: 1,
          delta: { type: 'input_json_delta', partial_json: argumentsText.slice(offset, offset + 5) },
        });
      }
      output += sse('content_block_stop', { type: 'content_block_stop', index: 1 });
      res.end(output + finishStream('tool_use'));
    },
  });

  const adapter = createAdapter(router, { auth: { 'x-api-key': 'native-api-key' }, files: isolatedFiles(home) });
  const result = await collect(nativeStream(adapter, { message: original, sessionId: 'tool-session' }));

  assert.equal(result.text, `reply:${original}:end`);
  const textEnd = result.chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text');
  assert.equal(textEnd.block.text, `reply:${original}:end`);
  const toolDeltas = result.chunks.filter(chunk => chunk.type === 'tool-call-delta' && chunk.argumentsDelta.length > 0);
  assert.ok(toolDeltas.length >= 2, 'tool arguments must be restored across multiple deltas');
  assert.deepEqual(JSON.parse(toolDeltas.map(chunk => chunk.argumentsDelta).join('')), { target: original, note: 'safe' });
  const toolEnd = result.chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
  assert.equal(toolEnd.block.id, 'toolu_fixture');
  assert.equal(toolEnd.block.name, 'run_command');
  assert.deepEqual(JSON.parse(toolEnd.block.arguments), { target: original, note: 'safe' });
  assert.equal(result.finish.reason.kind, 'tool-calls');
  assert.equal(result.usage.usage.outputTokens, 1);
  assert.equal(captured[0].body.messages[0].content[0].text.includes(original), false);
  assert.equal(captured[0].headers['x-cover-session'], undefined);
});

test('native adapter preserves API-key and account-token auth plus session and user attribution', async t => {
  const { captured, router, home } = await startHarness(t, {
    handler: capturedRequests => async (req, res) => {
      const record = await capture(req, capturedRequests);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(messageStart() + textBlock(extractText(record.body)) + finishStream());
    },
  });

  const files = isolatedFiles(home);
  const apiKeyAdapter = createAdapter(router, { auth: { 'x-api-key': 'native-api-key' }, files });
  const apiKey = await collect(nativeStream(apiKeyAdapter, { message: 'original-ApiKey4902', sessionId: 'api-key-session' }));
  assert.equal(apiKey.text, 'original-ApiKey4902');

  const accountAdapter = createAdapter(router, { auth: { 'x-dsh-auth-token': 'native-account-token' }, files });
  const account = await collect(nativeStream(accountAdapter, { message: 'original-Account4902', sessionId: 'account-session' }));
  assert.equal(account.text, 'original-Account4902');

  assert.equal(captured[0].headers['x-api-key'], 'native-api-key');
  assert.equal(captured[0].headers['x-dsh-auth-token'], undefined);
  assert.equal(captured[0].headers['authorization'], undefined);
  assert.equal(captured[0].headers['x-deepseek-harness-session-id'], 'api-key-session');
  assert.equal(captured[0].headers['x-deepseek-harness-user-id'], 'native-user');
  assert.match(captured[0].headers['user-agent'], /^deepseek-harness\//u);
  assert.equal(captured[0].headers['x-cover-session'], undefined);

  assert.equal(captured[1].headers['x-dsh-auth-token'], 'native-account-token');
  assert.equal(captured[1].headers['x-api-key'], undefined);
  assert.equal(captured[1].headers['authorization'], undefined);
  assert.equal(captured[1].headers['x-deepseek-harness-session-id'], 'account-session');
  assert.equal(captured[1].headers['x-deepseek-harness-user-id'], 'native-user');
  assert.equal(captured[1].headers['x-cover-session'], undefined);
  assert.equal(captured[0].body.messages[0].content[0].text.includes('original-ApiKey4902'), false);
  assert.equal(captured[1].body.messages[0].content[0].text.includes('original-Account4902'), false);
});

test('native Files metadata and delete plus model listing use the real Cover route while opaque uploads are refused', async t => {
  const fileA = { id: 'file_a', type: 'file', mime_type: 'image/png', size_bytes: 3, created_at: '2026-01-01T00:00:00Z', filename: 'a.png' };
  const fileB = { id: 'file_b', type: 'file', mime_type: 'image/png', size_bytes: 4, created_at: '2026-01-02T00:00:00Z', filename: 'b.png' };
  const { captured, router } = await startHarness(t, {
    handler: capturedRequests => async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      capturedRequests.push({ method: req.method, url: req.url, headers: req.headers, raw });
      if (req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'fixture', name: 'Fixture' }] }));
        return;
      }
      if (req.url.startsWith('/anthropic/v1/files?')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [fileA], first_id: 'file_a', last_id: 'file_a', has_more: false }));
        return;
      }
      if (req.method === 'GET' && req.url === '/anthropic/v1/files/file_b') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(fileB));
        return;
      }
      if (req.method === 'DELETE' && req.url === '/anthropic/v1/files/file_b') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'file_b', type: 'file_deleted' }));
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unexpected upstream request' } }));
    },
  });

  const client = new DeepSeekFilesClient({
    baseURL: `${router.baseURL}/anthropic`,
    headers: { 'x-dsh-auth-token': 'files-account-token' },
  });
  const page = await client.list({ limit: 2, after: 'file_a' });
  assert.equal(page.data[0].id, 'file_a');
  assert.equal(page.hasMore, false);
  const retrieved = await client.retrieve('file_b');
  assert.equal(retrieved.filename, 'b.png');
  await client.delete('file_b');

  const models = await fetch(`${router.baseURL}/models`, { headers: { 'x-dsh-auth-token': 'models-account-token' } });
  assert.equal(models.status, 200);
  assert.deepEqual(await models.json(), { data: [{ id: 'fixture', name: 'Fixture' }] });

  const listRecord = captured.find(record => record.url.startsWith('/anthropic/v1/files?'));
  const query = new URL(listRecord.url, 'http://127.0.0.1').searchParams;
  assert.equal(query.get('limit'), '2');
  assert.equal(query.get('after_id'), 'file_a');
  assert.equal(listRecord.headers['x-dsh-auth-token'], 'files-account-token');
  assert.equal(captured.find(record => record.url === '/models').headers['x-dsh-auth-token'], 'models-account-token');
  assert.equal(captured.filter(record => record.method === 'POST').length, 0);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Z7QAAAABJRU5ErkJggg==', 'base64');
  await assert.rejects(client.upload({
    data: png,
    mediaType: 'image/png',
    filename: 'dsh-fixture.png',
    expiresAfterSeconds: 3600,
  }), error => {
    assert.equal(error.name, 'DeepSeekFilesError');
    assert.equal(error.code, 'FILES_API');
    assert.equal(error.failure.status, 422);
    assert.equal(error.message.includes('dsh-fixture.png'), false);
    assert.equal(error.message.includes(png.toString('base64').slice(0, 24)), false);
    return true;
  });
  assert.equal(captured.filter(record => record.method === 'POST').length, 0, 'opaque multipart must not reach upstream');
});

test('native adapter image policy blocks opaque multipart before inline fallback and never leaks image bytes', async t => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Z7QAAAABJRU5ErkJggg==', 'base64');
  const attachmentId = `sha256:${'0'.repeat(64)}`;
  const variantId = `sha256:${'1'.repeat(64)}`;
  const ref = { attachmentId, mediaType: 'image/png', bytes: png.length, width: 1, height: 1 };
  const version = {
    variantId, attachment: ref, data: png, mediaType: 'image/png', bytes: png.length,
    width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false,
  };
  const attachment = {
    store: { readImageRequest: async () => version },
  };
  const { captured, router, home } = await startHarness(t, {
    sourcePolicy: `${BASE_POLICY}media:\n  images: block\n`,
    handler: capturedRequests => async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      capturedRequests.push({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"unexpected upstream request"}}');
    },
  });
  const files = isolatedFiles(home);
  const adapter = createAdapter(router, { auth: { 'x-api-key': 'native-api-key' }, files, attachment });
  const stream = adapter.stream({
    provider: 'deepseek-official',
    model: VISION_MODEL,
    sessionId: 'image-session',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'original-ImageSecret4902' },
        { type: 'image', attachment: ref },
      ],
    }],
  });

  await assert.rejects(async () => {
    for await (const _chunk of stream) { /* The protected refusal must be terminal. */ }
  }, error => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.failure.status, 403);
    assert.equal(error.message.includes('original-ImageSecret4902'), false);
    assert.equal(error.message.includes(png.toString('base64').slice(0, 24)), false);
    assert.equal(error.message.includes('dsh-'), false);
    return true;
  });
  assert.equal(captured.length, 0, 'neither multipart upload nor inline image JSON may reach upstream');
});

test('native adapter abort closes the upstream response instead of buffering the stream', async t => {
  let markUpstreamClosed;
  const upstreamClosed = new Promise(resolve => { markUpstreamClosed = resolve; });
  const { captured, router, home } = await startHarness(t, {
    handler: capturedRequests => async (req, res) => {
      const record = await capture(req, capturedRequests);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(messageStart());
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      res.write(sse('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: extractText(record.body) },
      }));
      await new Promise(resolve => res.once('close', resolve));
      markUpstreamClosed(true);
    },
  });
  const adapter = createAdapter(router, { auth: { 'x-api-key': 'native-api-key' }, files: isolatedFiles(home) });
  const abort = new AbortController();
  const iterator = nativeStream(adapter, {
    message: 'original-Cancel4902',
    sessionId: 'cancel-session',
    signal: abort.signal,
  })[Symbol.asyncIterator]();

  const first = await withTimeout(iterator.next(), 5000);
  assert.equal(first.done, false, 'the stream must produce a downstream chunk before completion');
  abort.abort();
  await assert.rejects(iterator.next(), error => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'ABORTED');
    return true;
  });
  await withTimeout(upstreamClosed, 5000);
  await waitFor(() => router.active === 0);
  assert.equal(captured.length, 1);
});
