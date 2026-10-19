import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import { randomUUID } from 'node:crypto';

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
const MESSAGE_PATH = '/anthropic/v1/messages';

function headersWithoutHop(headers) {
  const excluded = new Set([...HOP_HEADERS, ...String(headers.connection || '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase())));
}

function fail(response, status, message) {
  if (response.writableEnded || response.destroyed) return;
  if (response.headersSent) { response.destroy(); return; }
  try {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ type: 'error', error: { type: 'ds_cover', message } }));
  } catch { response.destroy(); }
}

export class CoverRouter {
  constructor(controller, { port = 18319, upstream = controller.upstream } = {}) {
    this.controller = controller;
    this.port = port;
    this.upstream = upstream;
    this.baseURL = `http://127.0.0.1:${port}`;
    this.lastRoute = 'blocked';
    this.active = 0;
    this.server = http.createServer((request, response) => {
      // Every handler rejection must become one local response, never an
      // unhandled rejection that can terminate the harness process.
      Promise.resolve().then(() => this.handle(request, response))
        .catch(() => fail(response, 502, 'Cover routing failed. Request was not sent directly.'));
    });
    this.server.requestTimeout = 300000;
    this.server.headersTimeout = 15000;
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    this.port = this.server.address().port;
    this.baseURL = `http://127.0.0.1:${this.port}`;
  }

  async handle(request, response) {
    const deny = (status, message) => fail(response, status, message);
    let url;
    try { url = new URL(request.url, this.baseURL); }
    catch { return deny(400, 'Invalid request target.'); }
    // This endpoint is for the local Node transport, never browser requests.
    if (request.headers.origin || request.headers.host !== `127.0.0.1:${this.port}`) return deny(403, 'Local harness requests only.');
    const files = /^\/anthropic\/v1\/files(?:\/[a-zA-Z0-9_-]+)?$/.test(url.pathname);
    const models = url.pathname === '/models' && request.method === 'GET';
    if (!(url.pathname === MESSAGE_PATH && request.method === 'POST') && !files && !models) return deny(404, 'Unsupported inference route.');
    if (files && !['GET', 'POST', 'DELETE'].includes(request.method)) return deny(405, 'Unsupported Files method.');
    const state = { ...this.controller.state };
    let protectedRoute = state.enabled;
    let active = false;
    const release = () => { if (active) { active = false; this.active--; } };
    try {
      // Select once. Never replay a failed or policy-blocked request directly.
      if (protectedRoute && state.autoFallback && !await this.controller.health()) protectedRoute = false;
      this.lastRoute = protectedRoute ? 'protected' : state.enabled ? 'fallback' : 'off';
      const target = new URL(url.pathname + url.search, protectedRoute ? this.controller.baseURL : this.upstream);
      const headers = headersWithoutHop(request.headers);
      delete headers['x-cover-session'];
      if (protectedRoute) {
        const session = request.headers['x-deepseek-harness-session-id'];
        headers['x-cover-session'] = typeof session === 'string' && session.length <= 128 ? session : randomUUID();
      }
      this.active++;
      active = true;
      let outgoing;
      try {
        outgoing = (target.protocol === 'https:' ? https : http).request(target, { method: request.method, headers }, incoming => {
          try {
            response.writeHead(incoming.statusCode, headersWithoutHop(incoming.headers));
            pipeline(incoming, response, () => {});
          } catch {
            outgoing.destroy();
            deny(502, protectedRoute ? 'Cover is unavailable. Request was not sent directly.' : 'The upstream connection failed.');
          }
        });
      } catch {
        release();
        return deny(502, protectedRoute ? 'Cover is unavailable. Request was not sent directly.' : 'The upstream connection failed.');
      }
      outgoing.on('error', () => { release(); this.lastRoute = protectedRoute ? 'blocked' : this.lastRoute; deny(502, protectedRoute ? 'Cover is unavailable. Request was not sent directly.' : 'The upstream connection failed.'); });
      outgoing.on('close', release);
      outgoing.setTimeout(300000, () => outgoing.destroy(new Error('Idle timeout')));
      response.on('close', () => outgoing.destroy());
      request.on('aborted', () => outgoing.destroy());
      pipeline(request, outgoing, error => { if (error) outgoing.destroy(); });
    } catch {
      release();
      deny(502, 'Cover routing failed. Request was not sent directly.');
    }
  }

  async dispose() {
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }
}
