import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, mkdir, rename, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

const exec = promisify(execFile);
const MAX_TEXT = 256 * 1024;
const commands = {
  start: ['start', '--detach'], stop: ['stop'], restart: ['restart'],
  doctor: ['doctor', '--json'], test: ['test'], version: ['version', '--json'],
  models: ['models', 'status'], 'models-pull': ['models', 'pull'],
  update: ['update'], rollback: ['update', '--rollback'],
};

export class CoverController {
  constructor({ home = join(homedir(), '.local/share/ds-cover'), binary = process.env.COVER_BIN || 'cover', port = 18318, upstream = 'https://api.deepseek.com', sourcePolicy = join(homedir(), '.config/cover/config.yaml') } = {}) {
    if (!isAbsolute(home)) throw new Error('Cover home must be an absolute path.');
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid Cover port.');
    this.home = home;
    this.binary = binary;
    this.port = port;
    this.upstream = upstream;
    this.sourcePolicy = sourcePolicy;
    this.configPath = join(home, '.config/cover/config.yaml');
    this.statePath = join(home, 'plugin.json');
    this.baseURL = `http://127.0.0.1:${port}`;
    this.env = { ...process.env, HOME: home, COVER_NO_BANNER: '1' };
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
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await readFile(this.configPath, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      let policy = {};
      try { policy = YAML.parse(await readFile(this.sourcePolicy, 'utf8')) || {}; }
      catch (sourceError) { if (sourceError.code !== 'ENOENT') throw sourceError; }
      Object.assign(policy, {
        listen: `127.0.0.1:${this.port}`, upstream: this.upstream,
        log_file: join(this.home, '.local/share/cover/redactions.log'),
        network: { allow_remote: false },
        pseudonymization: { key_file: join(this.home, '.config/cover/pseudonym.key') },
        mappings: { ...policy.mappings, session_header: 'X-Cover-Session' },
      });
      // Router aliases from another client must not redirect native DeepSeek calls.
      delete policy.upstream_paths;
      await writeFile(this.configPath, YAML.stringify(policy), { mode: 0o600, flag: 'wx' });
    }
    this.validatePolicy(await this.policy());
    return this;
  }

  async run(args, { timeout = 15000, allowFailure = false, env = this.env, signal } = {}) {
    try {
      const { stdout, stderr } = await exec(this.binary, args, { env, timeout, signal, maxBuffer: 2 * 1024 * 1024 });
      return { ok: true, output: stdout.trim(), diagnostic: stderr.trim() };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (allowFailure && typeof error.code === 'number') return { ok: false, output: String(error.stdout || '').trim(), diagnostic: String(error.stderr || '').trim() };
      throw new Error(error.code === 'ENOENT' ? 'Cover executable not found. Install Cover or configure its binary path.' : 'Cover command failed or timed out. Check the local daemon log.');
    }
  }

  async health({ signal } = {}) {
    try {
      const response = await fetch(`${this.baseURL}/__cover/health`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1500)]) : AbortSignal.timeout(1500), redirect: 'error' });
      if (!response.ok) return false;
      const health = await response.json();
      return health.service === 'cover';
    } catch { return false; }
  }

  async status({ signal } = {}) {
    let daemon = { running: false };
    let error;
    try { daemon = JSON.parse((await this.run(['status', '--json'], { signal })).output); }
    catch (failure) { error = failure.message; }
    signal?.throwIfAborted();
    const running = daemon.running === true && await this.health({ signal });
    return { ...this.state, running, busy: this.busy, baseURL: this.baseURL, home: this.home, configPath: this.configPath, error, upstream: this.upstream };
  }

  async setState(change, { signal } = {}) {
    signal?.throwIfAborted();
    if (Object.keys(change).some(key => !['enabled', 'autoFallback'].includes(key)) || Object.values(change).some(value => typeof value !== 'boolean')) throw new Error('Invalid protection settings.');
    if (this.busy) throw new Error('Another Cover operation is running.');
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
    if (!Object.hasOwn(commands, name)) throw new Error('Unknown Cover action.');
    if (this.busy) throw new Error('Another Cover operation is running.');
    this.busy = true;
    try {
      return await this.run(commands[name], { timeout: ['models-pull', 'update', 'rollback'].includes(name) ? 600000 : 45000, allowFailure: true, signal });
    } finally { this.busy = false; }
  }

  async policy() { return readFile(this.configPath, 'utf8'); }

  validatePolicy(text) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT) throw new Error('Policy must be at most 256 KiB.');
    const config = YAML.parse(text);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Policy must be a YAML object.');
    if (config.listen !== `127.0.0.1:${this.port}` || config.upstream !== this.upstream || config.network?.allow_remote !== false) throw new Error('Keep the dedicated loopback listener, upstream, and network boundary unchanged.');
    if (config.mappings?.session_header !== 'X-Cover-Session') throw new Error('Keep X-Cover-Session as the mapping session header.');
    if (config.pseudonymization?.key_file !== join(this.home, '.config/cover/pseudonym.key') || config.log_file !== join(this.home, '.local/share/cover/redactions.log')) throw new Error('Keep the private key and metadata log in the dedicated Cover home.');
    if (config.upstream_paths && Object.keys(config.upstream_paths).length) throw new Error('DeepSeek does not require upstream path aliases.');
    return config;
  }

  async savePolicy(text, { signal } = {}) {
    this.validatePolicy(text);
    if (this.busy) throw new Error('Another Cover operation is running.');
    this.busy = true;
    let directory;
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    try {
      directory = await mkdtemp(join(tmpdir(), 'ds-cover-policy-'));
      await mkdir(join(directory, '.config/cover'), { recursive: true, mode: 0o700 });
      await writeFile(join(directory, '.config/cover/config.yaml'), text, { mode: 0o600 });
      const request = join(directory, 'request.json');
      await writeFile(request, '{"messages":[{"role":"user","content":""}]}', { mode: 0o600 });
      const check = await this.run(['inspect', request], { env: { ...this.env, HOME: directory }, allowFailure: true, signal });
      if (!check.ok) throw new Error(`Cover rejected the policy: ${check.diagnostic}`);
      await writeFile(temporary, text, { mode: 0o600, signal });
      await rename(temporary, this.configPath);
      return { ok: true, output: 'Policy saved. Restart Cover to apply it to model requests.' };
    } finally {
      this.busy = false;
      await rm(temporary, { force: true });
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }

  async inspect(text, { signal } = {}) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_TEXT) throw new Error('Preview input must be at most 256 KiB.');
    const request = JSON.parse(text);
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Enter a JSON request object.');
    const directory = await mkdtemp(join(tmpdir(), 'ds-cover-inspect-'));
    try {
      const path = join(directory, 'request.json');
      await writeFile(path, text, { mode: 0o600, signal });
      const result = await this.run(['inspect', path], { allowFailure: true, signal });
      if (!result.ok) throw new Error(result.diagnostic || 'Cover rejected this preview.');
      return JSON.parse(result.output);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async activity({ signal } = {}) {
    try { await access(join(this.home, '.local/share/cover/redactions.log')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = await this.run(['monitor', '--json', '--follow=false', '--lines', '40'], { allowFailure: true, signal });
    if (!result.ok) throw new Error('Cover could not read the activity log.');
    return result.output.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  startLive() {
    if (this.live.size >= 4) throw new Error('Close an existing sensitive live view first.');
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
    if (!view) throw new Error('Live view expired. Enable it again to reconnect.');
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
