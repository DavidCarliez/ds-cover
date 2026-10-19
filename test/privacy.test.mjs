import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capture, extractText, finishStream, messageStart, readEventStream,
  sse, startHarness,
} from './helpers.mjs';

const ACTION_CASES = [
  {
    value: 'original-Private4902',
    action: 'pseudonymize',
    assert(value) {
      assert.match(value, /^alias-[a-z0-9]+$/u);
      assert.notEqual(value, 'original-Private4902');
    },
  },
  {
    value: 'placeholder-private',
    action: 'placeholder',
    assert(value) {
      assert.match(value, /^⟦RG:[0-9a-f]{8}⟧$/u);
    },
  },
  {
    value: 'masked-private',
    action: 'mask',
    assert(value) {
      assert.equal(value.length, 'masked-private'.length);
      assert.ok(value.startsWith('ma'));
      assert.ok(value.endsWith('te'));
      assert.match(value.slice(2, -2), /^\*+$/u);
    },
  },
  {
    value: 'redacted-private',
    action: 'redact',
    assert(value) {
      assert.equal(value, '[REDACTED]');
    },
  },
  {
    value: 'original-PublicExample',
    action: 'allow',
    assert(value) {
      assert.equal(value, 'original-PublicExample');
    },
  },
  {
    value: 'BLOCK-ME',
    action: 'block',
    assert(value, preview) {
      assert.equal(value, '[BLOCKED]');
      assert.equal(preview.blocked, true);
    },
  },
];

test('real Cover streams before EOF, restores split SSE, and preserves native auth and attribution', async t => {
  let releaseUpstream;
  let released = false;
  const held = new Promise(resolve => {
    releaseUpstream = () => {
      released = true;
      resolve();
    };
  });
  const original = 'PUBLIC-PREFIX-4902 original-Private4902 trailing-suffix';

  const { captured, send } = await startHarness(t, {
    handler: capturedRequests => async (req, res) => {
      const record = await capture(req, capturedRequests);
      const transformed = extractText(record.body);
      if (!record.body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ content: [{ type: 'text', text: transformed }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(messageStart());
      res.write(sse('content_block_start', {
        type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
      }));
      // The provider holds its response open until the client has consumed a
      // downstream delta. Two deltas are sent first because Cover must see the
      // next fragment before it can release a restored prefix.
      const pseudonymAt = transformed.indexOf('alias-');
      const safeEnd = pseudonymAt > 0 ? pseudonymAt : transformed.length;
      const firstBreak = Math.min(10, safeEnd - 1);
      res.write(sse('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: transformed.slice(0, firstBreak) },
      }));
      res.write(sse('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: transformed.slice(firstBreak, safeEnd) },
      }));
      await held;
      for (let offset = safeEnd; offset < transformed.length; offset += 3) {
        res.write(sse('content_block_delta', {
          type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: transformed.slice(offset, offset + 3) },
        }));
      }
      res.end(sse('content_block_stop', { type: 'content_block_stop', index: 0 }) + finishStream());
    },
  });

  const response = await send(original, { stream: true }, { 'x-deepseek-harness-session-id': 'stream-session' }, { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  let restored = '';
  let sawDeltaBeforeRelease = false;
  for await (const event of readEventStream(response.body)) {
    if (event.type === 'content_block_delta') {
      if (!released) {
        sawDeltaBeforeRelease = true;
        releaseUpstream();
      }
      restored += event.delta.text;
    }
    if (event.type === 'message_stop') break;
  }
  assert.equal(sawDeltaBeforeRelease, true, 'the first downstream delta must arrive while the provider is still streaming');
  assert.equal(released, true);
  assert.equal(restored, original);

  const second = await send(original);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).content[0].text, original);
  assert.equal(captured[0].headers['x-api-key'], 'fixture-auth');
  assert.equal(captured[0].headers['x-deepseek-harness-session-id'], 'stream-session');
  assert.equal(captured[0].headers['x-cover-session'], undefined);
  assert.equal(captured[1].headers['x-deepseek-harness-session-id'], 'fixture-session');
  assert.notEqual(captured[0].body.messages[0].content, original);
  assert.equal(captured[1].body.messages[0].content, captured[0].body.messages[0].content);
});

test('policy blocks never reach upstream, including with direct fallback enabled', async t => {
  const { controller, captured, send } = await startHarness(t);
  await controller.setState({ autoFallback: true });
  const response = await send('BLOCK-ME original-Private4902');
  assert.equal(response.status, 403);
  const body = await response.text();
  assert.ok(!body.includes('BLOCK-ME'));
  assert.ok(!body.includes('original-Private4902'));
  assert.equal(captured.length, 0, 'a blocked request must not be retried directly');
});

test('stopped daemon fails closed; explicit fallback and off route directly without replay', async t => {
  const { controller, captured, send } = await startHarness(t);
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
  assert.equal(captured.length, 2, 'fallback must select a route once and never replay the failed request');
});

test('browser-origin requests cannot use the native router and invalid policies do not replace configuration', async t => {
  const { controller, router, captured, send } = await startHarness(t);
  const response = await fetch(`${router.baseURL}/anthropic/v1/messages`, { method: 'POST', headers: { origin: 'https://example.com' }, body: '{}' });
  assert.equal(response.status, 403);
  assert.equal(captured.length, 0);
  const policy = await controller.policy();
  await assert.rejects(controller.savePolicy(policy + '\nunknown_configuration_field: true\n'), /rejected/);
  assert.equal(await controller.policy(), policy);
  assert.equal((await send('BLOCK-ME')).status, 403);
});

test('all six actions are semantically distinct in preview and protected forwarding', async t => {
  const { controller, captured, send } = await startHarness(t);
  const policy = (await controller.policy()).replace('  credential:', `  placeholder_value:
    pattern: 'placeholder-private'
    action: placeholder
  masked_value:
    pattern: 'masked-private'
    action: mask
  redacted_value:
    pattern: 'redacted-private'
    action: redact
  allowed_value:
    pattern: 'original-PublicExample'
    action: allow
    priority: 1000
  credential:`);
  await controller.savePolicy(policy);
  await controller.action('restart');

  const previews = new Map();
  for (const testCase of ACTION_CASES) {
    const request = JSON.stringify({ messages: [{ role: 'user', content: testCase.value }] });
    const preview = await controller.inspect(request);
    const transformed = preview.transformed_request.messages[0].content;
    const match = preview.matches.find(item => item.action === testCase.action);
    assert.ok(match, `preview must report the ${testCase.action} action`);
    assert.ok(preview.categories.includes(match.category));
    testCase.assert(transformed, preview);
    const repeated = await controller.inspect(request);
    assert.equal(repeated.transformed_request.messages[0].content, transformed, `${testCase.action} must be stable`);
    previews.set(testCase.value, transformed);
  }
  assert.equal(captured.length, 0, 'preview must never contact the upstream');

  const outbound = [];
  for (const testCase of ACTION_CASES.slice(0, 5)) {
    const response = await send(testCase.value);
    assert.equal(response.status, 200, testCase.value);
    outbound.push(captured.at(-1).body.messages[0].content);
  }
  const expectedOutbound = ACTION_CASES.slice(0, 5).map(testCase => previews.get(testCase.value));
  assert.deepEqual(outbound, expectedOutbound);
  for (let index = 0; index < ACTION_CASES.length - 1; index++) {
    assert.notEqual(outbound[index], outbound[index + 1], 'each action must have a distinct wire effect');
  }

  const blocked = await send('BLOCK-ME');
  assert.equal(blocked.status, 403);
  assert.equal(captured.length, 5, 'the block action must never reach upstream');

  // The pseudonym key is durable in the Cover home, so the same original keeps
  // the same alias after the daemon restarts.
  const beforeRestart = outbound[0];
  await controller.action('restart');
  const stable = await send('original-Private4902');
  assert.equal(stable.status, 200);
  assert.equal(captured.at(-1).body.messages[0].content, beforeRestart);
});
