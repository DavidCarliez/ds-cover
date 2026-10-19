import { CoverError } from './errors.js';

const MAX_TEXT = 256 * 1024;
// JSON escaping can expand one text byte to six transport bytes.
const MAX_BODY = MAX_TEXT * 6 + 1024;
const ACTIONS = new Set(['start', 'stop', 'restart', 'doctor', 'test', 'version', 'models', 'models-pull', 'update', 'rollback']);
export const CONTROL_ENDPOINTS = ['status', 'setup', 'state', 'action', 'policy', 'savePolicy', 'inspect', 'activity', 'liveStart', 'livePoll', 'liveStop'];

class RequestError extends CoverError {
  constructor(code, message, status = 200) { super(code, message); this.status = status; }
}

function object(payload, allowed, required = allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(payload, key))) {
    throw new RequestError('cover/invalid-payload', 'Invalid Cover request payload.');
  }
  return payload;
}

function text(payload) {
  const { text } = object(payload, ['text']);
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT) {
    throw new RequestError('cover/invalid-payload', 'Text must be at most 256 KiB.');
  }
  return text;
}

async function readPayload(request, signal) {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError('cover/json-required', 'Send a JSON request.', 415);
  }
  const tooLarge = () => new RequestError('cover/request-too-large', 'Request exceeds the control endpoint size limit.', 413);
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new RequestError('cover/invalid-json', 'Enter a valid JSON request.', 400);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const decoder = new TextDecoder();
  let content = '';
  let bytes = 0;
  let done = false;
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!done) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      done = chunk.done;
      if (done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY) throw tooLarge();
      content += decoder.decode(chunk.value, { stream: true });
    }
    content += decoder.decode();
    try { return JSON.parse(content); }
    catch { throw new RequestError('cover/invalid-json', 'Enter a valid JSON request.', 400); }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Owns control-request cancellation and sensitive monitor leases independently
// of the native transport. Authentication remains the native Fetch registry's job.
export class CoverControls {
  constructor(controller, { status, setup, action, signal }) {
    this.controller = controller;
    this.status = status;
    this.setup = setup;
    this.action = action ?? ((name, signal) => controller.action(name, { signal }));
    this.lifetime = new AbortController();
    this.signal = AbortSignal.any([signal, this.lifetime.signal]);
    this.views = new Map();
  }

  stopView(id) {
    const view = this.views.get(id);
    if (!view) return;
    clearTimeout(view.timer);
    this.views.delete(id);
    this.controller.stopLive(id);
  }

  refreshView(id) {
    const view = this.views.get(id);
    clearTimeout(view.timer);
    view.timer = setTimeout(() => this.stopView(id), 15000);
    view.timer.unref();
  }

  ownedView(payload, clientId) {
    const { id } = object(payload, ['id']);
    if (typeof id !== 'string' || id.length > 128 || this.views.get(id)?.clientId !== clientId) {
      throw new RequestError('cover/live-unavailable', 'Live view is unavailable or belongs to another browser.');
    }
    return id;
  }

  async fetch(endpoint, request) {
    const signal = AbortSignal.any([request.signal, this.signal]);
    let newView;
    try {
      signal.throwIfAborted();
      if (!CONTROL_ENDPOINTS.includes(endpoint)) throw new RequestError('cover/unknown-endpoint', 'Unknown Cover endpoint.', 404);
      if (request.method !== 'POST') throw new RequestError('cover/method-not-allowed', 'Use POST for Cover controls.', 405);
      const clientId = request.headers.get('x-ds-cover-client');
      if (!clientId || !/^[a-f0-9-]{36}$/u.test(clientId)) {
        throw new RequestError('cover/client-required', 'Client identifier required.', 400);
      }
      const payload = await readPayload(request, signal);
      let value;
      switch (endpoint) {
        case 'status': {
          const { provider } = object(payload, ['provider']);
          if (provider !== null && (typeof provider !== 'string' || provider.length > 256)) {
            throw new RequestError('cover/invalid-payload', 'Provider must be a string or null.');
          }
          value = await this.status(provider, signal);
          break;
        }
        case 'setup':
          object(payload, []);
          value = await this.setup(signal);
          break;
        case 'state':
          object(payload, ['enabled', 'autoFallback'], []);
          if (Object.values(payload).some(item => typeof item !== 'boolean')) {
            throw new RequestError('cover/invalid-payload', 'Protection settings must be boolean values.');
          }
          value = await this.controller.setState(payload, { signal });
          break;
        case 'action': {
          const { name } = object(payload, ['name']);
          if (!ACTIONS.has(name)) throw new RequestError('cover/invalid-action', 'Unknown Cover action.');
          value = await this.action(name, signal);
          break;
        }
        case 'policy':
          object(payload, []);
          value = await this.controller.policy();
          break;
        case 'savePolicy':
          value = await this.controller.savePolicy(text(payload), { signal });
          break;
        case 'inspect':
          value = await this.controller.inspect(text(payload), { signal });
          break;
        case 'activity':
          object(payload, []);
          value = await this.controller.activity({ signal });
          break;
        case 'liveStart': {
          object(payload, []);
          const id = this.controller.startLive();
          newView = id;
          this.views.set(id, { clientId, timer: null });
          this.refreshView(id);
          value = id;
          break;
        }
        case 'livePoll': {
          const id = this.ownedView(payload, clientId);
          value = this.controller.touchLive(id);
          this.refreshView(id);
          break;
        }
        case 'liveStop':
          this.stopView(this.ownedView(payload, clientId));
          value = null;
          break;
      }
      signal.throwIfAborted();
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (newView) this.stopView(newView);
      const known = error instanceof CoverError;
      return Response.json({
        ok: false,
        error: {
          code: signal.aborted ? 'cover/cancelled' : known ? error.code : 'cover/operation-failed',
          message: signal.aborted ? 'Cover request cancelled.' : known ? error.message : 'Cover operation failed. Check the local daemon diagnostics.',
        },
      }, { status: error instanceof RequestError ? error.status : 200, headers: { 'cache-control': 'no-store' } });
    }
  }

  dispose() {
    this.lifetime.abort();
    for (const id of this.views.keys()) this.stopView(id);
  }
}
