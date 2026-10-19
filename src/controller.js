import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, mkdir, rename, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import net from 'node:net';
import YAML from 'yaml';
import { CoverError } from './errors.js';

const exec = promisify(execFile);
const MAX_TEXT = 256 * 1024;
const APPLIED_FILE = 'applied-policy.json';
const MIN_COVER_VERSION = [0, 3, 0];
const commands = {
  start: ['start', '--detach'], stop: ['stop'], restart: ['restart'],
  doctor: ['doctor', '--json'], test: ['test'], version: ['version', '--json'],
  models: ['models', 'status'], 'models-pull': ['models', 'pull'],
  update: ['update'], rollback: ['update', '--rollback'],
};

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const coverEnv = home => ({
  ...process.env, HOME: home, COVER_NO_BANNER: '1',
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
});
const busyError = () => new CoverError('cover/busy', 'Another Cover operation is running.');

function lineHint(message) {
  const match = /\bline\s+(\d+)(?::\s*(\d+))?/iu.exec(String(message || ''));
  return match ? ` at line ${match[1]}${match[2] ? `, column ${match[2]}` : ''}` : '';
}

function yamlError(error) {
  const position = Array.isArray(error?.linePos) ? error.linePos[0] : null;
  if (Number.isInteger(position?.line)) return ` at line ${position.line}${Number.isInteger(position?.col) ? `, column ${position.col}` : ''}`;
  return lineHint(error?.message);
}

function rejection(diagnostic) {
  const hint = lineHint(diagnostic);
  let reason = 'Check detector and rule settings against the installed Cover version.';
  if (/field .+ not found|unknown (?:configuration )?(?:field|key|property)/iu.test(diagnostic)) {
    reason = 'Unknown configuration field. Check the setting names.';
  } else if (/error parsing regexp|invalid .*(?:regexp|regex|pattern)/iu.test(diagnostic)) {
    reason = 'Invalid regular expression. Check your rule patterns.';
  } else if (/(?:unknown|invalid|unsupported) .*(?:action|generator)/iu.test(diagnostic)) {
    reason = 'Unsupported rule action or generator.';
  } else if (/cannot unmarshal|invalid (?:value|type)/iu.test(diagnostic)) {
    reason = 'A setting has an invalid value or the wrong type.';
  }
  return new CoverError('cover/policy-invalid', `Cover rejected the policy${hint}. ${reason}`);
}

// Comments and formatting do not change Cover's behavior, so they must not make
// an otherwise identical policy look pending. Only the parsed configuration is hashed.
function policyHash(text) {
  let canonical = text;
  try { canonical = YAML.stringify(YAML.parse(text)); } catch { /* Validation reports malformed YAML. */ }
  return createHash('sha256').update(canonical).digest('hex');
}

function parseVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(raw || '');
  if (!match) return null;
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] || null };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function probePort(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once('error', error => resolve({ available: false, code: error.code }));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve({ available: true })));
  });
}

export class CoverController {
  constructor({ home = join(homedir(), '.local/share/ds-cover'), binary = process.env.COVER_BIN || 'cover', port = 18318, upstream = 'https://api.deepseek.com', sourcePolicy = join(homedir(), '.config/cover/config.yaml') } = {}) {
    if (!isAbsolute(home)) throw new CoverError('cover/home-invalid', 'Cover home must be an absolute path.');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CoverError('cover/port-invalid', 'Invalid Cover port.');
    this.home = home;
    this.binary = binary;
    this.port = port;
    this.upstream = upstream;
    this.sourcePolicy = sourcePolicy;
    this.configPath = join(home, '.config/cover/config.yaml');
    this.statePath = join(home, 'plugin.json');
    this.appliedPath = join(home, APPLIED_FILE);
    this.baseURL = `http://127.0.0.1:${port}`;
    this.env = coverEnv(home);
    this.state = { enabled: true, autoFallback: false };
    this.live = new Map();
    this.busy = false;
  }

  async init() {
    await mkdir(join(this.home, '.config/cover'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.home, '.local/share/cover'), { recursive: true, mode: 0o700 });
    try {
      const state = JSON.parse(await readFile(this.statePath, 'utf8'));
      if (typeof state.enabled !== 'boolean' || typeof state.autoFallback !== 'boolean') throw new Error('Invalid ds-cover state.');
      this.state = { enabled: state.enabled, autoFallback: state.autoFallback };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new CoverError('cover/state-invalid', 'Saved ds-cover settings are invalid. Reset the plugin settings or restore plugin.json.');
    }
    let config;
    try {
      config = await readFile(this.configPath, 'utf8');
      this.validatePolicy(config);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const imported = YAML.stringify(this.boundaryPolicy(await this.sourcePolicyConfig()));
      this.validatePolicy(imported);
      // Semantic validation happens in an isolated Cover home before the real
      // configuration exists, so an invalid import never becomes persistent.
      await this.verifyPolicySemantics(imported);
      try {
        await writeFile(this.configPath, imported, { mode: 0o600, flag: 'wx' });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') throw writeError;
        config = await readFile(this.configPath, 'utf8');
        this.validatePolicy(config);
      }
    }
    return this;
  }

  async run(args, { timeout = 15000, allowFailure = false, env = this.env, signal } = {}) {
    try {
      const { stdout, stderr } = await exec(this.binary, args, { env, timeout, signal, maxBuffer: 2 * 1024 * 1024 });
      return { ok: true, output: stdout.trim(), diagnostic: stderr.trim() };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (allowFailure && typeof error.code === 'number') return { ok: false, output: String(error.stdout || '').trim(), diagnostic: String(error.stderr || '').trim() };
      if (error.code === 'ENOENT') throw new CoverError('cover/binary-missing', 'Cover executable not found. Install Cover 0.3.0 or newer, then retry Start.');
      if (error.killed || error.signal || error.code === 'ETIMEDOUT') throw new CoverError('cover/command-timeout', 'Cover command timed out. Check the local daemon log.');
      throw new CoverError('cover/command-failed', 'Cover command failed. Check the local daemon log.');
    }
  }

  async healthInfo({ signal } = {}) {
    try {
      const timeout = AbortSignal.timeout(1500);
      const response = await fetch(`${this.baseURL}/__cover/health`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (!response.ok) return null;
      const health = await response.json();
      if (health.service !== 'cover') return null;
      return { pid: Number.isInteger(health.pid) ? health.pid : null };
    } catch { return null; }
  }

  async health({ signal } = {}) {
    return await this.healthInfo({ signal }) !== null;
  }

  async daemonStatus({ signal } = {}) {
    try {
      const result = await this.run(['status', '--json'], { signal });
      const daemon = JSON.parse(result.output);
      if (!isObject(daemon)) throw new Error('Invalid status.');
      return { daemon, error: null };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return { daemon: null, error: error instanceof CoverError ? error.message : 'Cover status could not be read.' };
    }
  }

  async readApplied() {
    try {
      const applied = JSON.parse(await readFile(this.appliedPath, 'utf8'));
      return isObject(applied) ? applied : null;
    } catch { return null; }
  }

  async writeApplied(policyText, pid, { signal } = {}) {
    const text = typeof policyText === 'string' ? policyText : await this.policy();
    const applied = { version: 1, policyHash: policyHash(text), pid, port: this.port, startedAt: Date.now() };
    const temporary = `${this.appliedPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(applied, null, 2) + '\n', { mode: 0o600, signal });
      await rename(temporary, this.appliedPath);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new CoverError('cover/metadata-failed', 'Cover started, but its applied policy could not be recorded. Restart Cover to verify it.');
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async clearApplied() {
    try { await rm(this.appliedPath, { force: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw new CoverError('cover/metadata-failed', 'Cover daemon state could not be updated. Check permissions for the private Cover home.');
    }
  }

  async verifyStarted(policyText, { signal } = {}) {
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt) {
        await new Promise(resolve => setTimeout(resolve, 100));
        signal?.throwIfAborted();
      }
      const { daemon } = await this.daemonStatus({ signal });
      if (!daemon || daemon.running !== true) continue;
      const identity = await this.healthInfo({ signal });
      if (!identity || !Number.isInteger(identity.pid) || !Number.isInteger(daemon.pid) || daemon.pid !== identity.pid) continue;
      if (daemon.listen && daemon.listen !== `127.0.0.1:${this.port}`) continue;
      await this.writeApplied(policyText, identity.pid, { signal });
      return true;
    }
    return false;
  }

  async assessPolicy(pid, { signal } = {}) {
    if (!Number.isInteger(pid)) return 'unknown';
    let text;
    try { text = await this.policy(); } catch { return 'unknown'; }
    const applied = await this.readApplied();
    if (!applied || applied.version !== 1 || applied.port !== this.port || applied.pid !== pid
      || typeof applied.policyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(applied.policyHash)) return 'unknown';
    signal?.throwIfAborted();
    return applied.policyHash === policyHash(text) ? 'active' : 'pending';
  }

  async status({ signal } = {}) {
    const { daemon, error } = await this.daemonStatus({ signal });
    signal?.throwIfAborted();
    const identity = await this.healthInfo({ signal });
    signal?.throwIfAborted();
    const running = daemon?.running === true && identity !== null;
    let pid = null;
    if (running) {
      const cliPid = Number.isInteger(daemon.pid) ? daemon.pid : null;
      const healthPid = Number.isInteger(identity.pid) ? identity.pid : null;
      // Conflicting process identities cannot verify which daemon loaded the policy.
      pid = cliPid !== null && healthPid !== null && cliPid !== healthPid ? null : (cliPid ?? healthPid);
    }
    let policyState;
    if (running) policyState = await this.assessPolicy(pid, { signal });
    else if (identity !== null) policyState = 'unknown';
    else policyState = 'pending';
    signal?.throwIfAborted();
    return {
      ...this.state, running, busy: this.busy, baseURL: this.baseURL, home: this.home,
      configPath: this.configPath, error, upstream: this.upstream,
      policyState, restartRequired: identity !== null && policyState !== 'active', checkedAt: Date.now(),
    };
  }

  async setState(change, { signal } = {}) {
    signal?.throwIfAborted();
    if (Object.keys(change).some(key => !['enabled', 'autoFallback'].includes(key)) || Object.values(change).some(value => typeof value !== 'boolean')) {
      throw new CoverError('cover/state-invalid', 'Invalid protection settings.');
    }
    if (this.busy) throw busyError();
    this.busy = true;
    const temporary = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      const state = { ...this.state, ...change };
      await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, signal });
      await rename(temporary, this.statePath);
      this.state = state;
    } finally {
      this.busy = false;
      await rm(temporary, { force: true });
    }
    return this.status({ signal });
  }

  async action(name, { signal } = {}) {
    if (!Object.hasOwn(commands, name)) throw new CoverError('cover/action-invalid', 'Unknown Cover action.');
    if (this.busy) throw busyError();
    this.busy = true;
    try {
      let policyText = null;
      if (name === 'start' || name === 'restart') {
        try { policyText = await this.policy(); } catch { /* A missing policy is reported by the action. */ }
      }
      let wasRunning = false;
      if (name === 'start') {
        const { daemon } = await this.daemonStatus({ signal });
        if (daemon?.running === true) wasRunning = await this.health({ signal });
      }
      if (name === 'restart') await this.clearApplied();
      const result = await this.run(commands[name], { timeout: ['models-pull', 'update', 'rollback'].includes(name) ? 600000 : 45000, allowFailure: true, signal });
      if ((name === 'start' || name === 'restart') && result.ok) {
        // A start that merely found an already-running daemon must never
        // claim that newly saved policy is active. Cover normally fails such a
        // start, but the daemon health check keeps this true across versions.
        if (!(name === 'start' && wasRunning)) {
          await this.clearApplied();
          await this.verifyStarted(policyText, { signal });
        }
      }
      if (name === 'stop' && result.ok) await this.clearApplied();
      return {
        ok: result.ok, output: result.ok ? result.output : '',
        diagnostic: result.ok ? result.diagnostic : 'Cover command failed. Check the local daemon log.',
      };
    } finally {
      this.busy = false;
    }
  }

  async policy() {
    try { return await readFile(this.configPath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw new CoverError('cover/policy-missing', 'Cover policy is not available. Install Cover and retry Start.');
      throw new CoverError('cover/policy-unreadable', 'Cover policy could not be read. Check permissions for the private Cover home.');
    }
  }

  validatePolicy(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT) throw new CoverError('cover/policy-invalid', 'Policy must be at most 256 KiB.');
    let config;
    try { config = YAML.parse(text); }
    catch (error) { throw new CoverError('cover/policy-invalid', `Policy YAML is invalid${yamlError(error)}.`); }
    if (!isObject(config)) throw new CoverError('cover/policy-invalid', 'Policy must be a YAML object.');
    if (config.listen !== `127.0.0.1:${this.port}` || config.upstream !== this.upstream || config.network?.allow_remote !== false) {
      throw new CoverError('cover/policy-invalid', 'Keep the dedicated loopback listener, upstream, and network boundary unchanged.');
    }
    if (config.mappings?.session_header !== 'X-Cover-Session') throw new CoverError('cover/policy-invalid', 'Keep X-Cover-Session as the mapping session header.');
    if (config.pseudonymization?.key_file !== join(this.home, '.config/cover/pseudonym.key') || config.log_file !== join(this.home, '.local/share/cover/redactions.log')) {
      throw new CoverError('cover/policy-invalid', 'Keep the private key and metadata log in the dedicated Cover home.');
    }
    if (config.upstream_paths && Object.keys(config.upstream_paths).length) throw new CoverError('cover/policy-invalid', 'DeepSeek does not require upstream path aliases.');
    return config;
  }

  async sourcePolicyConfig() {
    let text;
    try { text = await readFile(this.sourcePolicy, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new CoverError('cover/policy-invalid', 'The existing Cover policy could not be imported. Check its permissions.');
    }
    let config;
    try { config = YAML.parse(text); }
    catch (error) { throw new CoverError('cover/policy-invalid', `The existing Cover policy is invalid YAML${yamlError(error)}.`); }
    if (!isObject(config)) throw new CoverError('cover/policy-invalid', 'The existing Cover policy must be a YAML object.');
    return config;
  }

  boundaryPolicy(imported) {
    const network = isObject(imported.network) ? { ...imported.network } : {};
    network.allow_remote = false;
    const pseudonymization = isObject(imported.pseudonymization) ? { ...imported.pseudonymization } : {};
    pseudonymization.key_file = join(this.home, '.config/cover/pseudonym.key');
    const mappings = isObject(imported.mappings) ? { ...imported.mappings } : {};
    mappings.session_header = 'X-Cover-Session';
    const policy = {
      ...imported,
      listen: `127.0.0.1:${this.port}`,
      upstream: this.upstream,
      log_file: join(this.home, '.local/share/cover/redactions.log'),
      network,
      pseudonymization,
      mappings,
    };
    // Router aliases from another client must not redirect native DeepSeek calls.
    delete policy.upstream_paths;
    return policy;
  }

  async verifyPolicySemantics(text, { signal } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'ds-cover-validate-'));
    try {
      await mkdir(join(directory, '.config/cover'), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, '.config/cover/config.yaml'), text, { mode: 0o600 });
      const request = join(directory, 'request.json');
      await writeFile(request, '{"messages":[{"role":"user","content":""}]}', { mode: 0o600 });
      let result;
      try {
        result = await this.run(['inspect', request], { env: coverEnv(directory), allowFailure: true, signal });
      } catch (error) {
        if (error instanceof CoverError && error.code === 'cover/command-timeout') {
          throw new CoverError('cover/policy-unavailable', 'Cover timed out while validating the policy. Try again.');
        }
        throw error;
      }
      if (!result.ok) throw rejection(result.diagnostic);
      return result;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async savePolicy(text, { signal } = {}) {
    this.validatePolicy(text);
    if (this.busy) throw busyError();
    this.busy = true;
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    try {
      // Full Cover validation finishes before the real policy is touched.
      await this.verifyPolicySemantics(text, { signal });
      signal?.throwIfAborted();
      await writeFile(temporary, text, { mode: 0o600, signal });
      await rename(temporary, this.configPath);
      return { ok: true, output: 'Policy saved. Restart Cover to apply it to model requests.' };
    } finally {
      this.busy = false;
      await rm(temporary, { force: true });
    }
  }

  async inspect(text, { signal } = {}) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT) throw new CoverError('cover/request-invalid', 'Preview input must be at most 256 KiB.');
    let request;
    try { request = JSON.parse(text); }
    catch { throw new CoverError('cover/request-invalid', 'Enter a valid JSON request object.'); }
    if (!isObject(request)) throw new CoverError('cover/request-invalid', 'Enter a JSON request object.');
    const directory = await mkdtemp(join(tmpdir(), 'ds-cover-inspect-'));
    try {
      const path = join(directory, 'request.json');
      await writeFile(path, text, { mode: 0o600, signal });
      const result = await this.run(['inspect', path], { allowFailure: true, signal });
      if (!result.ok) throw new CoverError('cover/inspect-failed', 'Cover could not preview this request. Check the saved policy.');
      try { return JSON.parse(result.output); }
      catch { throw new CoverError('cover/inspect-failed', 'Cover returned an unreadable preview.'); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async activity({ signal } = {}) {
    try { await access(join(this.home, '.local/share/cover/redactions.log')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new CoverError('cover/activity-failed', 'Cover activity metadata could not be read.'); }
    const result = await this.run(['monitor', '--json', '--follow=false', '--lines', '40'], { allowFailure: true, signal });
    if (!result.ok) throw new CoverError('cover/activity-failed', 'Cover could not read the activity log.');
    try { return result.output.split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { throw new CoverError('cover/activity-failed', 'Cover returned unreadable activity metadata.'); }
  }

  async binaryCheck({ signal } = {}) {
    let result;
    try { result = await this.run(['version', '--json'], { timeout: 10000, allowFailure: true, signal }); }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      return { id: 'binary', label: 'Cover executable', state: 'error', message: error instanceof CoverError ? error.message : 'Cover could not be checked.' };
    }
    if (!result.ok) return { id: 'binary', label: 'Cover executable', state: 'error', message: 'Cover did not report a machine-readable version. Install Cover 0.3.0 or newer.' };
    let version = '';
    try {
      const reported = JSON.parse(result.output);
      if (typeof reported?.version === 'string') version = reported.version.trim();
    } catch { /* Unknown development output is handled below. */ }
    const parsed = parseVersion(version);
    if (!parsed) return { id: 'binary', label: 'Cover executable', state: 'warning', message: 'Cover version could not be verified. Development builds must provide Cover 0.3.0 or newer.' };
    if (compareVersions(parsed.parts, MIN_COVER_VERSION) < 0) {
      return { id: 'binary', label: 'Cover executable', state: 'error', message: `Cover ${version} is older than the required 0.3.0. Install Cover 0.3.0 or newer.` };
    }
    if (parsed.prerelease) return { id: 'binary', label: 'Cover executable', state: 'warning', message: `Cover ${version} is a development build; version compatibility could not be verified.` };
    return { id: 'binary', label: 'Cover executable', state: 'ok', message: `Cover ${version} is installed.` };
  }

  async daemonPortCheck({ signal } = {}) {
    const expected = `127.0.0.1:${this.port}`;
    const { daemon } = await this.daemonStatus({ signal });
    const identity = await this.healthInfo({ signal });
    signal?.throwIfAborted();
    if (identity) {
      if (daemon?.running === true) {
        if (Number.isInteger(daemon.pid) && Number.isInteger(identity.pid) && daemon.pid !== identity.pid) {
          return { id: 'daemon-port', label: 'Dedicated daemon port', state: 'error', message: `The dedicated port ${expected} is used by an unexpected Cover process.` };
        }
        if (daemon.listen && daemon.listen !== expected) {
          return { id: 'daemon-port', label: 'Dedicated daemon port', state: 'error', message: `Cover reports a different listener than ${expected}.` };
        }
        return { id: 'daemon-port', label: 'Dedicated daemon port', state: 'ok', message: `The dedicated Cover daemon owns ${expected}.` };
      }
      return { id: 'daemon-port', label: 'Dedicated daemon port', state: 'error', message: `The dedicated port ${expected} is used by a Cover process that is not managed by this installation.` };
    }
    if (daemon?.running === true) {
      return { id: 'daemon-port', label: 'Dedicated daemon port', state: 'warning', message: `Cover reports a running daemon, but ${expected} is not reachable.` };
    }
    const probe = await probePort(this.port);
    signal?.throwIfAborted();
    if (probe.available) return { id: 'daemon-port', label: 'Dedicated daemon port', state: 'ok', message: `${expected} is available for the dedicated daemon.` };
    if (probe.code === 'EADDRINUSE') return { id: 'daemon-port', label: 'Dedicated daemon port', state: 'error', message: `${expected} is already in use by another process.` };
    return { id: 'daemon-port', label: 'Dedicated daemon port', state: 'error', message: `${expected} cannot be used for the dedicated daemon.` };
  }

  async setup({ signal } = {}) {
    const [binary, daemonPort] = await Promise.all([this.binaryCheck({ signal }), this.daemonPortCheck({ signal })]);
    signal?.throwIfAborted();
    return { checks: [binary, daemonPort] };
  }

  startLive() {
    if (this.live.size >= 4) throw new CoverError('cover/live-limit', 'Close an existing sensitive live view first.');
    const id = randomUUID();
    const child = spawn(this.binary, ['monitor', '--show-content', '--json'], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
    const view = { child, events: [], error: null, timer: null };
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { this.stopLive(id); return; }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { view.events.push(JSON.parse(line)); if (view.events.length > 10) view.events.shift(); } catch { /* Ignore incomplete diagnostic lines. */ }
      }
    });
    child.on('error', () => { view.error = 'Live monitor could not start.'; });
    child.on('exit', () => { view.error = 'Live monitor disconnected.'; });
    this.live.set(id, view);
    this.touchLive(id);
    return id;
  }

  touchLive(id) {
    const view = this.live.get(id);
    if (!view) throw new CoverError('cover/live-unavailable', 'Live view expired. Enable it again to reconnect.');
    clearTimeout(view.timer);
    view.timer = setTimeout(() => this.stopLive(id), 15000);
    view.timer.unref();
    return { events: view.events.splice(0), error: view.error };
  }

  stopLive(id) {
    const view = this.live.get(id);
    if (!view) return;
    clearTimeout(view.timer);
    view.child.kill();
    view.events.length = 0;
    this.live.delete(id);
  }

  dispose() { for (const id of this.live.keys()) this.stopLive(id); }
}
