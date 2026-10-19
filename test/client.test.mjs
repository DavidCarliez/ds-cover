import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { loadClientModule } from './client-harness.mjs';

const { act } = TestRenderer;
const h = React.createElement;
const BASE_POLICY = 'listen: 127.0.0.1:18318\nupstream: https://api.deepseek.com\n';
let clientModule;
let clientCleanup;

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

before(async () => {
  const loaded = await loadClientModule();
  clientModule = loaded.module;
  clientCleanup = loaded.cleanup;
});

after(async () => { await clientCleanup?.(); });

function installDocument() {
  const previous = globalThis.document;
  globalThis.document = {
    head: { append() {} },
    createElement() { return { dataset: {}, textContent: '', remove() {} }; },
  };
  return () => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  };
}

function generationSource(id = 1) {
  let snapshot = { id, host: { home: '/tmp/ds-cover-client-test' } };
  const listeners = new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    set(nextId) { snapshot = { id: nextId, host: snapshot.host }; listeners.forEach(listener => listener()); },
  };
}

function statusValue(provider, overrides = {}) {
  return {
    enabled: true,
    autoFallback: false,
    running: true,
    busy: false,
    policyState: 'active',
    restartRequired: false,
    checkedAt: 1700000000000,
    coverage: provider ? 'protected' : 'unknown',
    provider: provider ?? null,
    routerURL: 'http://127.0.0.1:18319',
    baseURL: 'http://127.0.0.1:18318',
    upstream: 'https://api.deepseek.com',
    activeRequests: 0,
    ...overrides,
  };
}

const reply = value => ({ ok: true, json: async () => ({ ok: true, value }) });
const failureReply = (code, message) => ({ ok: true, json: async () => ({ ok: false, error: { code, message } }) });

function createApi(handlers = {}) {
  const calls = [];
  const api = {
    calls,
    handlers: {
      status: payload => reply(statusValue(payload.provider)),
      setup: () => reply({ checks: [] }),
      policy: () => reply(BASE_POLICY),
      savePolicy: () => reply({ ok: true, output: 'Policy saved.' }),
      activity: () => reply([]),
      action: () => reply({ ok: true, output: 'ok' }),
      liveStart: () => reply('view-1'),
      livePoll: () => reply({ events: [], error: null }),
      liveStop: () => reply(null),
      ...handlers,
    },
    set(endpoint, handler) { api.handlers[endpoint] = handler; },
    count(endpoint) { return calls.filter(call => call.endpoint === endpoint).length; },
    async fetch(url, init) {
      const endpoint = String(url).split('/').at(-1);
      const payload = init?.body ? JSON.parse(init.body) : {};
      calls.push({ endpoint, payload });
      const handler = api.handlers[endpoint];
      if (!handler) throw new Error(`Unexpected Cover endpoint: ${endpoint}`);
      return handler(payload, calls);
    },
  };
  return api;
}

function deferred() {
  let resolve;
  const promise = new Promise(resolver => { resolve = resolver; });
  return { promise, resolve };
}

async function settle(turns = 10) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
  }
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object') return '';
  return (node.children || []).map(textOf).join('');
}

const allText = root => textOf(root);

function buttonByText(root, label) {
  return root.findAll(node => node.type === 'button' && textOf(node).trim() === label)[0];
}

async function click(element) {
  assert.ok(element, 'expected element');
  await act(async () => { element.props.onClick(); });
  await settle(3);
}

async function clickTab(host, name) {
  const tab = host.tree.root.findAll(node => node.type === 'button' && node.props.role === 'tab' && textOf(node) === name)[0];
  await click(tab);
}

async function openPanel(host) {
  await settle();
  const lock = host.tree.root.findAll(node => node.type === 'button' && node.props['aria-haspopup'] === 'dialog')[0];
  await click(lock);
}

async function closePanel(host) {
  const close = host.tree.root.findAll(node => node.type === 'button' && node.props['aria-label'] === 'Close Cover settings')[0];
  await click(close);
}

function dialog(host) {
  return host.tree.root.findAll(node => node.type === 'div' && node.props.role === 'dialog')[0];
}

function alertDialog(host) {
  return host.tree.root.findAll(node => node.type === 'section' && node.props.role === 'alertdialog')[0];
}

function lockButton(host) {
  return host.tree.root.findAll(node => node.type === 'button' && node.props['aria-haspopup'] === 'dialog')[0];
}

function policyEditor(host) {
  return host.tree.root.findAll(node => node.type === 'textarea')[0];
}

async function createHost(api) {
  const restoreDocument = installDocument();
  const slots = [];
  const disposers = [];
  const source = generationSource(1);
  const selection = { status: 'ready', routable: true, current: { provider: 'deepseek-official' } };
  const directory = { subscribe: () => () => {}, getSnapshot: () => selection };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = api.fetch;
  try {
    clientModule.apply({
      effect(fn) {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
      slots: {
        inject(_name, callback) { callback(); },
        register(def, component) { slots.push({ def, component }); return { dispose() {} }; },
      },
      connection: { generation: source },
      modelDirectories: { directoryFor: () => ({ store: directory, load: async () => {} }) },
    });
    const coverSlot = slots.find(slot => slot.def.id === 'ds-cover-footer');
    const providerSlot = slots.find(slot => slot.def.id === 'ds-cover-provider');
    assert.ok(coverSlot, 'shell.bottom registration');
    assert.ok(providerSlot, 'provider registration');
    let tree;
    await act(async () => {
      tree = TestRenderer.create(h(React.Fragment, null,
        h(coverSlot.component, coverSlot.def.inject('session-test')),
        h(providerSlot.component, providerSlot.def.inject('session-test')),
      ));
    });
    await settle();
    return {
      tree,
      source,
      api,
      dispose: async () => {
        await act(async () => { tree.unmount(); });
        globalThis.fetch = previousFetch;
        for (const dispose of disposers.reverse()) await dispose?.();
        restoreDocument();
      },
    };
  } catch (error) {
    globalThis.fetch = previousFetch;
    for (const dispose of disposers.reverse()) await dispose?.();
    restoreDocument();
    throw error;
  }
}

test('policy draft survives tab switches and dirty dismissal asks before discarding', async () => {
  const host = await createHost(createApi());
  try {
    await openPanel(host);
    assert.equal(host.api.count('policy'), 0, 'policy stays unmounted until its tab is opened');
    await clickTab(host, 'Policy');
    assert.equal(host.api.count('policy'), 1);
    assert.equal(policyEditor(host).props.value, BASE_POLICY);

    await act(async () => {
      policyEditor(host).props.onChange({ target: { value: 'policy: edited\n' } });
    });
    await settle(3);
    assert.match(allText(host.tree.root), /Unsaved changes/);

    await clickTab(host, 'Overview');
    await clickTab(host, 'Policy');
    assert.equal(host.api.count('policy'), 1, 'policy remains mounted after the first visit');
    assert.equal(policyEditor(host).props.value, 'policy: edited\n', 'draft preserved across tabs');

    await closePanel(host);
    assert.ok(dialog(host), 'modal remains open while confirmation is pending');
    assert.ok(alertDialog(host), 'accessible in-panel confirmation');
    assert.match(allText(alertDialog(host)), /Discard unsaved policy changes\?/);
    assert.equal(policyEditor(host).props.value, 'policy: edited\n');

    await click(buttonByText(host.tree.root, 'Keep editing'));
    assert.equal(alertDialog(host), undefined);
    assert.equal(policyEditor(host).props.value, 'policy: edited\n', 'cancellation preserves the draft');
    const selected = host.tree.root.findAll(node => node.type === 'button' && node.props.role === 'tab' && node.props['aria-selected'] === true)[0];
    assert.equal(textOf(selected), 'Policy');

    await closePanel(host);
    await click(buttonByText(host.tree.root, 'Discard changes & close'));
    assert.equal(dialog(host), undefined);
    assert.equal(host.api.count('savePolicy'), 0, 'discard does not save');
  } finally {
    await host.dispose();
  }
});

test('a delayed save cannot overwrite newer policy edits', async () => {
  const save = deferred();
  const api = createApi({ savePolicy: () => save.promise });
  const host = await createHost(api);
  try {
    await openPanel(host);
    await clickTab(host, 'Policy');
    await act(async () => {
      policyEditor(host).props.onChange({ target: { value: 'policy: first\n' } });
    });
    await settle(2);
    await click(buttonByText(host.tree.root, 'Save policy'));
    assert.equal(api.count('savePolicy'), 1);
    assert.equal(api.calls.find(call => call.endpoint === 'savePolicy').payload.text, 'policy: first\n');

    await act(async () => {
      policyEditor(host).props.onChange({ target: { value: 'policy: second\n' } });
    });
    await settle(2);
    save.resolve(reply({ ok: true, output: 'Policy saved.' }));
    await settle();

    assert.equal(policyEditor(host).props.value, 'policy: second\n');
    assert.match(allText(host.tree.root), /Unsaved changes/);
    assert.match(allText(host.tree.root), /Policy saved\. Your newer edits remain unsaved\./);
  } finally {
    await host.dispose();
  }
});

test('safe backend errors stay useful without clearing a healthy lock, while status failures do invalidate', async () => {
  const api = createApi({
    status: payload => reply(statusValue(payload.provider, { error: 'Cover status command failed.' })),
    action: () => failureReply('cover/operation-failed', 'Cover command failed or timed out. Check the local daemon log.'),
  });
  const host = await createHost(api);
  try {
    await openPanel(host);
    assert.match(allText(host.tree.root), /Cover status:\s*Cover status command failed\./);
    assert.match(lockButton(host).props['aria-label'], /^Cover: Protected/);

    let held = false;
    api.set('status', payload => {
      if (held) return new Promise(() => {});
      return reply(statusValue(payload.provider, { error: 'Cover status command failed.' }));
    });
    held = true;
    await click(buttonByText(host.tree.root, 'Doctor'));
    assert.match(allText(host.tree.root), /Cover command failed or timed out\. Check the local daemon log\./);
    assert.match(lockButton(host).props['aria-label'], /^Cover: Protected/, 'non-status failure does not clear protection');

    held = false;
    api.set('status', () => failureReply('cover/operation-failed', 'Cover status is unavailable.'));
    await click(buttonByText(host.tree.root, 'Refresh status'));
    await settle(3);
    assert.match(lockButton(host).props['aria-label'], /^Cover: Status unknown/);
    assert.match(allText(host.tree.root), /Live status could not be verified\./);
    assert.match(allText(host.tree.root), /Cover status is unavailable\./);
  } finally {
    await host.dispose();
  }
});

test('a hung status refresh cannot extend the previous healthy status lifetime', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = createApi();
  const host = await createHost(api);
  try {
    await openPanel(host);
    assert.match(lockButton(host).props['aria-label'], /^Cover: Protected/);

    api.set('status', () => new Promise(() => {}));
    await click(buttonByText(host.tree.root, 'Refresh status'));
    assert.match(lockButton(host).props['aria-label'], /^Cover: Protected/, 'an unresolved refresh leaves the old record visible');

    await act(async () => { t.mock.timers.tick(9000); });
    await settle(3);
    assert.match(lockButton(host).props['aria-label'], /^Cover: Status unknown/);
    assert.match(allText(host.tree.root), /Live status has not refreshed\. Protection could not be verified\./);
  } finally {
    await host.dispose();
  }
});

test('generation changes stop and clear sensitive live views even with pending starts and polls', async () => {
  const start = deferred();
  const api = createApi({
    liveStart: () => start.promise,
    livePoll: () => reply({ events: [], error: null }),
  });
  const host = await createHost(api);
  try {
    await openPanel(host);
    await clickTab(host, 'Activity');
    await act(async () => {
      host.tree.root.findAll(node => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
    });
    await settle(2);
    await click(buttonByText(host.tree.root, 'Enable sensitive live view'));

    await act(async () => { host.source.set(2); });
    await settle();
    assert.equal(api.count('livePoll'), 0, 'pending start never polls after generation change');
    start.resolve(reply('view-stale'));
    await settle();
    assert.deepEqual(api.calls.filter(call => call.endpoint === 'liveStop').map(call => call.payload.id), ['view-stale']);
    assert.doesNotMatch(allText(host.tree.root), /Sensitive live view is active/);

    const poll = deferred();
    api.set('liveStart', () => reply('view-active'));
    api.set('livePoll', () => poll.promise);
    await clickTab(host, 'Activity');
    await act(async () => {
      host.tree.root.findAll(node => node.type === 'input' && node.props.type === 'checkbox')[0].props.onChange({ target: { checked: true } });
    });
    await settle(2);
    await click(buttonByText(host.tree.root, 'Enable sensitive live view'));
    assert.match(allText(host.tree.root), /Sensitive live view is active/);
    const pollsBeforeReset = api.count('livePoll');
    assert.equal(pollsBeforeReset, 1);

    await act(async () => { host.source.set(3); });
    await settle();
    assert.deepEqual(api.calls.filter(call => call.endpoint === 'liveStop').map(call => call.payload.id), ['view-stale', 'view-active']);
    poll.resolve(reply({ events: [{ content: 'SECRET-LIVE-CONTENT' }], error: null }));
    await settle();
    // A cancelled poll must not schedule its next 1.5s cycle after the reset.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1700)); });
    await settle();
    assert.equal(api.count('livePoll'), pollsBeforeReset, 'stale poll result does not resume polling');
    assert.doesNotMatch(allText(host.tree.root), /SECRET-LIVE-CONTENT/);
    assert.doesNotMatch(allText(host.tree.root), /Sensitive live view is active/);
  } finally {
    await host.dispose();
  }
});

test('restart, policy state, health time, fallback, setup checks and explicit recheck stay visible', async () => {
  const setupChecks = [
    { id: 'binary', label: 'Cover binary', state: 'ok', message: 'Cover 0.3.0' },
    { id: 'daemon-port', label: 'Daemon port', state: 'warning', message: 'Port check was inconclusive.' },
  ];
  const api = createApi({
    status: payload => reply(statusValue(payload.provider, {
      restartRequired: true,
      policyState: 'pending',
      autoFallback: true,
      error: 'Cover status command failed.',
    })),
    setup: () => reply({ checks: setupChecks }),
  });
  const host = await createHost(api);
  try {
    await openPanel(host);
    const text = allText(host.tree.root);
    assert.match(text, /Restart required\./);
    assert.match(text, /Saved policy changes are not active until Cover restarts\./);
    assert.match(text, /Pending restart/);
    assert.match(text, /Last health check:/);
    assert.match(text, /Cover status:\s*Cover status command failed\./);
    assert.match(text, /Cover binary/);
    assert.match(text, /Cover 0\.3\.0/);
    assert.match(text, /Daemon port/);
    assert.match(text, /Port check was inconclusive\./);
    assert.match(lockButton(host).props['aria-label'], /^Cover: Protected\. Automatic unprotected fallback is on/);
    assert.match(allText(host.tree.root), /Fallback on/);
    assert.match(allText(host.tree.root), /Automatic fallback on: the next request may bypass Cover\./);

    await clickTab(host, 'Policy');
    await click(buttonByText(host.tree.root, 'Restart Cover'));
    assert.match(allText(host.tree.root), /The dedicated daemon will be interrupted\./);
    await click(buttonByText(host.tree.root, 'Cancel'));

    await clickTab(host, 'Overview');
    const setupCalls = api.count('setup');
    assert.equal(setupCalls, 1);
    await click(buttonByText(host.tree.root, 'Refresh status'));
    await settle(3);
    assert.equal(api.count('setup'), setupCalls, 'status polling does not rerun setup checks');
    await click(buttonByText(host.tree.root, 'Recheck setup'));
    await settle(3);
    assert.equal(api.count('setup'), setupCalls + 1);

    api.set('status', payload => reply(statusValue(payload.provider, { policyState: 'unknown' })));
    await click(buttonByText(host.tree.root, 'Refresh status'));
    await settle(3);
    assert.match(allText(host.tree.root), /Policy:\s*Unknown/);
    assert.equal(host.tree.root.findAll(node => node.type === 'button' && textOf(node) === 'Restart Cover').length, 0);
    assert.doesNotMatch(lockButton(host).props['aria-label'], /fallback is on/);
  } finally {
    await host.dispose();
  }
});

test('inspect input clears when the panel closes and when the connection generation resets', async () => {
  const host = await createHost(createApi());
  try {
    await openPanel(host);
    await clickTab(host, 'Inspect');
    const inspectSection = host.tree.root.find(node => node.type === 'section' && allText(node).includes('Inspect a request locally'));
    const editor = inspectSection.findAll(node => node.type === 'textarea')[0];
    await act(async () => { editor.props.onChange({ target: { value: '{"content":"SECRET-INSPECT"}' } }); });
    assert.equal(editor.props.value, '{"content":"SECRET-INSPECT"}');

    await closePanel(host);
    assert.equal(dialog(host), undefined);
    await openPanel(host);
    await clickTab(host, 'Inspect');
    const reopened = host.tree.root.find(node => node.type === 'section' && allText(node).includes('Inspect a request locally'));
    assert.equal(reopened.findAll(node => node.type === 'textarea')[0].props.value, '');

    const activeEditor = reopened.findAll(node => node.type === 'textarea')[0];
    await act(async () => { activeEditor.props.onChange({ target: { value: '{"content":"SECRET-AGAIN"}' } }); });
    await act(async () => { host.source.set(2); });
    await settle();
    await clickTab(host, 'Inspect');
    const resetSection = host.tree.root.find(node => node.type === 'section' && allText(node).includes('Inspect a request locally'));
    assert.equal(resetSection.findAll(node => node.type === 'textarea')[0].props.value, '');
  } finally {
    await host.dispose();
  }
});
