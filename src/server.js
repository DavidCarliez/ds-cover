import z from '@deepseek-ai/schemastery';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { CoverController } from './controller.js';
import { CoverRouter } from './router.js';

export const name = 'ds-cover';
export const inject = ['connection', 'webServer', 'commands', 'llm', 'settings', 'configEditor'];
export const Config = z.object({
  home: z.string(),
  binary: z.string(),
  sourcePolicy: z.string(),
});

const PROVIDERS = new Map([
  ['deepseek-official', { namespace: 'llm-deepseek', module: '@deepseek-ai/dsh-llm-deepseek-api-key' }],
  ['deepseek-account', { namespace: 'llm-deepseek-account', module: '@deepseek-ai/dsh-llm-deepseek-account' }],
]);
const ACTIONS = new Set(['start', 'stop', 'restart', 'doctor', 'test', 'version', 'models', 'models-pull', 'update', 'rollback']);
const HELP = '/cover status | on | off | fallback on/off | start | stop | restart | doctor | test | monitor | models status/pull';
const MAX_TEXT = 256 * 1024;

class RequestError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function payloadObject(payload, allowed, required = allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(payload, key))) {
    throw new RequestError('cover/invalid-payload', 'Invalid Cover request payload.');
  }
  return payload;
}

function textPayload(payload) {
  const { text } = payloadObject(payload, ['text']);
  if (typeof text !== 'string' || text.length > MAX_TEXT || Buffer.byteLength(text) > MAX_TEXT) {
    throw new RequestError('cover/invalid-payload', 'Text must be at most 256 KiB.');
  }
  return text;
}

function matchesURL(value, expected) {
  if (typeof value !== 'string') return false;
  try {
    const actual = new URL(value);
    const target = new URL(expected);
    return !actual.username && !actual.password && !actual.search && !actual.hash
      && actual.origin === target.origin
      && actual.pathname.replace(/\/+$/u, '') === target.pathname.replace(/\/+$/u, '');
  } catch { return false; }
}

// Read current service-owned settings, not the bundle's intended defaults. Raw
// configuration can contain credentials and must never cross the RPC boundary.
function routeIsConfigured(ctx, provider, router) {
  const native = PROVIDERS.get(provider);
  if (!native) return false;
  try {
    const declared = ctx.llm.listConfigurableProviders().find(item => item.provider === provider);
    if (declared?.settingsNs !== native.namespace || declared.settingsPath.length !== 0
      || !ctx.llm.listProviders().some(item => item.id === provider)) return false;
    const descriptor = ctx.settings.describe({ redactSecrets: true }).find(item => item.ns === native.namespace);
    if (!matchesURL(descriptor?.value?.baseURL, `${router.baseURL}/anthropic`)) return false;
    const layers = ctx.configEditor.configuration();
    const row = layers.find(item => item.entry.options.id === native.namespace);
    if (!row || row.entry.disabled || !row.entry.fiber || row.entry.options.name !== native.module) return false;
    const baseURL = row.entry.fiber.config?.baseURL;
    if (!baseURL || typeof baseURL.get !== 'function'
      || !matchesURL(baseURL.get(), `${router.baseURL}/anthropic`)) return false;
    if (provider === 'deepseek-account') {
      const account = layers.find(item => item.entry.options.id === 'deepseek-account');
      if (!account || account.entry.disabled || !account.entry.fiber
        || account.entry.options.name !== '@deepseek-ai/dsh-deepseek-account-platform'
        || !matchesURL(account.entry.fiber.config?.inferenceOrigin, router.baseURL)) return false;
    }
    return true;
  } catch { return false; }
}

function coverageOf(status, provider, configured, ready) {
  if (provider === null) return 'unknown';
  if (!PROVIDERS.has(provider)) return 'unconfigured';
  if (!status.enabled) return 'off';
  if (!ready || !configured) return 'blocked';
  if (status.running) return 'protected';
  return status.autoFallback ? 'fallback' : 'blocked';
}

export async function apply(ctx, config = {}) {
  const controller = new CoverController(config);
  const router = new CoverRouter(controller);
  const lifetime = new AbortController();
  const views = new Map();
  let ready = false;

  function stopView(id) {
    const view = views.get(id);
    if (!view) return;
    clearTimeout(view.timer);
    views.delete(id);
    controller.stopLive(id);
  }

  function refreshView(id) {
    const view = views.get(id);
    clearTimeout(view.timer);
    view.timer = setTimeout(() => stopView(id), 15000);
    view.timer.unref();
  }

  ctx.effect(() => async () => {
    ready = false;
    lifetime.abort();
    for (const id of views.keys()) stopView(id);
    controller.dispose();
    await router.dispose();
  });

  // The adapter remains responsible for all JSON, replay and session-log
  // extensions. Nothing is stripped or rewritten at this middleware boundary.
  ctx.on('llm/stream', async function* (options, next) {
    if (PROVIDERS.has(options.provider) && controller.state.enabled
      && (!ready || !routeIsConfigured(ctx, options.provider, router))) {
      throw new LlmError('Cover blocked this request: the native provider is not routed through the local Cover router. Restore the bundle endpoints or explicitly turn protection off.', 'COVER_ROUTE_BLOCKED');
    }
    yield* next();
  });

  await controller.init();
  lifetime.signal.throwIfAborted();
  await router.start();
  if (lifetime.signal.aborted) {
    await router.dispose();
    lifetime.signal.throwIfAborted();
  }
  ready = true;

  async function status(provider, signal) {
    const current = await controller.status({ signal });
    signal.throwIfAborted();
    return {
      ...current,
      coverage: coverageOf(current, provider, routeIsConfigured(ctx, provider, router), ready),
      provider,
      routerURL: router.baseURL,
      activeRequests: router.active,
    };
  }

  function ownedView(payload, clientId) {
    const { id } = payloadObject(payload, ['id']);
    if (typeof id !== 'string' || id.length > 128 || views.get(id)?.clientId !== clientId) {
      throw new RequestError('cover/live-unavailable', 'Live view is unavailable or belongs to another connection.');
    }
    return id;
  }

  async function handle(endpoint, payload, requestSignal, clientId) {
    const signal = AbortSignal.any([requestSignal, lifetime.signal]);
    let newView;
    try {
      signal.throwIfAborted();
      let value;
      switch (endpoint) {
        case 'status': {
          const { provider } = payloadObject(payload, ['provider']);
          if (provider !== null && (typeof provider !== 'string' || provider.length > 256)) {
            throw new RequestError('cover/invalid-payload', 'Provider must be a string or null.');
          }
          value = await status(provider, signal);
          break;
        }
        case 'state': {
          payloadObject(payload, ['enabled', 'autoFallback'], []);
          if (Object.values(payload).some(item => typeof item !== 'boolean')) {
            throw new RequestError('cover/invalid-payload', 'Protection settings must be boolean values.');
          }
          value = await controller.setState(payload, { signal });
          break;
        }
        case 'action': {
          const { name: action } = payloadObject(payload, ['name']);
          if (!ACTIONS.has(action)) throw new RequestError('cover/invalid-action', 'Unknown Cover action.');
          value = await controller.action(action, { signal });
          break;
        }
        case 'policy':
          payloadObject(payload, []);
          value = await controller.policy();
          break;
        case 'savePolicy':
          value = await controller.savePolicy(textPayload(payload), { signal });
          break;
        case 'inspect':
          value = await controller.inspect(textPayload(payload), { signal });
          break;
        case 'activity':
          payloadObject(payload, []);
          value = await controller.activity({ signal });
          break;
        case 'liveStart': {
          payloadObject(payload, []);
          const id = controller.startLive();
          newView = id;
          views.set(id, { clientId, timer: null });
          refreshView(id);
          value = id;
          break;
        }
        case 'livePoll': {
          const id = ownedView(payload, clientId);
          value = controller.touchLive(id);
          refreshView(id);
          break;
        }
        case 'liveStop': {
          stopView(ownedView(payload, clientId));
          value = null;
          break;
        }
        default:
          throw new RequestError('cover/unknown-endpoint', 'Unknown Cover endpoint.');
      }
      signal.throwIfAborted();
      return { ok: true, value };
    } catch (error) {
      if (newView) stopView(newView);
      return {
        ok: false,
        error: {
          code: signal.aborted ? 'cover/cancelled' : error instanceof RequestError ? error.code : 'cover/operation-failed',
          message: signal.aborted ? 'Cover request cancelled.' : error instanceof RequestError ? error.message : 'Cover operation failed. Check the local configuration and daemon diagnostics.',
          details: {},
        },
      };
    }
  }

  // Connection's exact Fetch registry authenticates the host owner and applies
  // the native Host/Origin fence before invoking these handlers.
  for (const endpoint of ['status', 'state', 'action', 'policy', 'savePolicy', 'inspect', 'activity', 'liveStart', 'livePoll', 'liveStop']) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/ds-cover/${endpoint}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return new Response('JSON required.', { status: 415 });
        const clientId = request.headers.get('x-ds-cover-client');
        if (!clientId || !/^[a-f0-9-]{36}$/u.test(clientId)) return new Response('Client identifier required.', { status: 400 });
        const text = await request.text();
        if (Buffer.byteLength(text) > MAX_TEXT * 2) return new Response('Request too large.', { status: 413 });
        let payload;
        try { payload = JSON.parse(text); }
        catch { return new Response('Invalid JSON.', { status: 400 }); }
        return Response.json(await handle(endpoint, payload, request.signal, clientId), { headers: { 'cache-control': 'no-store' } });
      },
    }));
  }

  ctx.commands.register({
    name: 'cover',
    description: 'Control local Cover protection without sending a message to the model.',
    input: { hint: HELP },
    recordInput: false,
    async handler({ rawInput, signal: requestSignal }) {
      const signal = AbortSignal.any([requestSignal, lifetime.signal]);
      try {
        signal.throwIfAborted();
        const command = rawInput.trim().replace(/\s+/gu, ' ') || 'status';
        if (command === 'status') {
          const current = await controller.status({ signal });
          const routes = [...PROVIDERS.keys()].map(provider => `${provider}: ${coverageOf(current, provider, routeIsConfigured(ctx, provider, router), ready)}`);
          return { kind: 'success', text: `Cover ${current.enabled ? 'enabled' : 'off'}; daemon ${current.running ? 'healthy' : 'unavailable'}; fallback ${current.autoFallback ? 'on' : 'off'}.\n${routes.join('\n')}\nActive requests: ${router.active}.` };
        }
        if (['on', 'off', 'fallback on', 'fallback off'].includes(command)) {
          const change = command.startsWith('fallback ')
            ? { autoFallback: command === 'fallback on' } : { enabled: command === 'on' };
          await controller.setState(change, { signal });
          return { kind: 'success', text: command.startsWith('fallback ')
            ? `Automatic fallback ${change.autoFallback ? 'enabled: requests can bypass Cover when its daemon is unavailable' : 'disabled: protection fails closed'}.`
            : `Cover protection ${change.enabled ? 'enabled; requests remain blocked until the route and daemon are ready' : 'off; requests use direct upstream routing'}.` };
        }
        if (command === 'monitor') {
          const events = await controller.activity({ signal });
          return { kind: 'success', text: `Cover returned ${events.length} recent metadata events. Open Cover activity in the settings panel for details. Sensitive live content is never written to this session log.` };
        }
        const action = command === 'models status' ? 'models' : command === 'models pull' ? 'models-pull' : command;
        if (!['start', 'stop', 'restart', 'doctor', 'test', 'models', 'models-pull'].includes(action)
          || (action === 'models' && command !== 'models status')
          || (action === 'models-pull' && command !== 'models pull')) {
          return { kind: 'error', text: HELP };
        }
        const result = await controller.action(action, { signal });
        return {
          kind: result.ok ? 'success' : 'error',
          text: `Cover ${command} ${result.ok ? 'completed successfully' : 'failed'}. Command output is omitted from the session log; use the Cover settings panel for diagnostics.`,
        };
      } catch {
        return { kind: 'error', text: signal.aborted ? 'Cover command cancelled.' : 'Cover command failed. Check the Cover settings panel and local daemon diagnostics.' };
      }
    },
  });
}
