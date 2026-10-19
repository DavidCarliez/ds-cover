import z from '@deepseek-ai/schemastery';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { CoverController } from './controller.js';
import { CoverRouter } from './router.js';
import { CoverControls, CONTROL_ENDPOINTS } from './controls.js';
import { CoverError } from './errors.js';

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
const HELP = '/cover status | on | off | fallback on/off | start | stop | restart | doctor | test | monitor | models status/pull';

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

// Read current service-owned settings, not the bundle's intended defaults.
// Raw configuration can contain credentials and never crosses this boundary.
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

async function harnessCheck() {
  const check = { id: 'harness', label: 'Harness compatibility', state: 'warning', message: 'Version could not be read. Verified with DeepSeek Harness 0.2.1-rc.2.' };
  try {
    // Resolve from the running CLI, not the plugin's separately installed peers.
    const require = createRequire(await realpath(process.argv[1]));
    const manifest = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'));
    if (typeof manifest.version === 'string') {
      check.state = manifest.version === '0.2.1-rc.2' ? 'ok' : 'warning';
      check.message = `Running ${manifest.version}. ${check.state === 'ok' ? 'Matches the verified integration version.' : 'This plugin is verified with 0.2.1-rc.2; check compatibility before upgrading.'}`;
    }
  } catch { /* Keep an honest unknown-version warning for embedded hosts. */ }
  return check;
}

export async function apply(ctx, config = {}) {
  const controller = new CoverController(config);
  const router = new CoverRouter(controller);
  const lifetime = new AbortController();
  let initialized = false;
  let initializing;
  let initializationError;
  let routerError;
  let controls;
  const ready = () => initialized && router.server.listening && !lifetime.signal.aborted;
  const safeError = error => error instanceof CoverError ? error : new CoverError('cover/setup-failed', 'Cover setup failed. Check the binary, policy, and local directory permissions.');

  ctx.effect(() => async () => {
    lifetime.abort();
    controls?.dispose();
    controller.dispose();
    await router.dispose();
  });

  ctx.on('llm/stream', async function* (options, next) {
    if (PROVIDERS.has(options.provider) && controller.state.enabled
      && (!ready() || !routeIsConfigured(ctx, options.provider, router))) {
      throw new LlmError('Cover blocked this request: the protected route is not ready. Open Cover setup checks or restore the bundle endpoints.', 'COVER_ROUTE_BLOCKED');
    }
    yield* next();
  });

  async function initializeOnce() {
    if (!initialized) {
      try { await controller.init(); initialized = true; initializationError = undefined; }
      catch (error) { initializationError = safeError(error); }
    }
    lifetime.signal.throwIfAborted();
    if (!router.server.listening) {
      try { await router.start(); routerError = undefined; }
      catch (error) {
        routerError = new CoverError('cover/router-unavailable', error.code === 'EADDRINUSE'
          ? 'Router port 18319 is already in use. Stop the conflicting instance, then retry Start.'
          : 'The local router could not start on 127.0.0.1:18319. Check host networking and permissions.');
      }
    }
    if (lifetime.signal.aborted) { await router.dispose(); lifetime.signal.throwIfAborted(); }
  }

  function initialize() {
    initializing ??= initializeOnce().finally(() => { initializing = undefined; });
    return initializing;
  }

  // Keep controls available after a failed setup so the UI can explain it.
  await initialize();

  async function status(provider, signal) {
    const current = await controller.status({ signal });
    signal.throwIfAborted();
    return {
      ...current,
      busy: current.busy || Boolean(initializing),
      error: initializationError?.message || routerError?.message || current.error,
      coverage: coverageOf(current, provider, routeIsConfigured(ctx, provider, router), ready()),
      provider,
      routerURL: router.baseURL,
      activeRequests: router.active,
    };
  }

  async function setup(signal) {
    const result = await controller.setup({ signal });
    result.checks.push({ id: 'router-port', label: 'Router port 18319', state: router.server.listening ? 'ok' : 'error', message: router.server.listening ? 'The plugin owns the loopback router listener.' : routerError?.message || 'The router is not listening. Retry Start.' });
    if (initializationError) result.checks.push({ id: 'policy', label: 'Policy initialization', state: 'error', message: initializationError.message });
    result.checks.push(await harnessCheck());
    signal.throwIfAborted();
    return result;
  }

  async function action(name, signal) {
    if (name === 'start' || name === 'restart') {
      await initialize();
      signal.throwIfAborted();
      if (initializationError) throw initializationError;
      if (routerError) throw routerError;
    }
    return controller.action(name, { signal });
  }

  controls = new CoverControls(controller, { status, setup, action, signal: lifetime.signal });
  // Native owner authentication and Host/Origin checks precede these routes.
  for (const endpoint of CONTROL_ENDPOINTS) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/ds-cover/${endpoint}`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: request => controls.fetch(endpoint, request),
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
          const routes = [...PROVIDERS.keys()].map(provider => `${provider}: ${coverageOf(current, provider, routeIsConfigured(ctx, provider, router), ready())}`);
          return { kind: 'success', text: `Cover ${current.enabled ? 'enabled' : 'off'}; daemon ${current.running ? 'healthy' : 'unavailable'}; fallback ${current.autoFallback ? 'on' : 'off'}.\n${routes.join('\n')}\nActive requests: ${router.active}.${current.restartRequired ? '\nRestart required to verify the saved policy is active.' : ''}` };
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
        const operation = command === 'models status' ? 'models' : command === 'models pull' ? 'models-pull' : command;
        if (!['start', 'stop', 'restart', 'doctor', 'test', 'models', 'models-pull'].includes(operation)
          || (operation === 'models' && command !== 'models status')
          || (operation === 'models-pull' && command !== 'models pull')) {
          return { kind: 'error', text: HELP };
        }
        const result = await action(operation, signal);
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
