'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const METHODS = new Set(['status', 'models', 'generate', 'job', 'wait', 'history', 'save', 'open_folder', 'accounts', 'login_start', 'login_complete', 'login_cancel', 'cancel']);
const RETRYABLE_METHODS = new Set(['status', 'models', 'job', 'wait', 'history', 'accounts', 'generate']);
const defaultBridgePath = path.join(os.homedir(), 'Library', 'Application Support', 'Flow Studio', 'agent-bridge.json');
const appPaths = ['/Applications/Flow Studio.app',path.join(os.homedir(), 'Applications', 'Flow Studio.app')];

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

async function readBridgeFile(filePath) {
  if (!path.isAbsolute(filePath)) throw new BridgeError('BRIDGE_UNSAFE', 'Bridge file path must be absolute.');
  let file;
  try {
    file = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600 || stat.size > 16384) {
      throw new BridgeError('BRIDGE_UNSAFE', 'Bridge file must be a regular file owned by this user with mode 0600.');
    }
    let bridge;
    try { bridge = JSON.parse(await file.readFile('utf8')); }
    catch { throw new BridgeError('BRIDGE_INVALID', 'Bridge file is not valid JSON.'); }
    if (!bridge || bridge.version !== 1 || !Number.isInteger(bridge.port) || bridge.port < 1 || bridge.port > 65535 ||
        !Number.isInteger(bridge.pid) || bridge.pid < 1 || typeof bridge.token !== 'string' || !/^[a-fA-F0-9]{64}$/.test(bridge.token) ||
        (bridge.host !== undefined && bridge.host !== '127.0.0.1')) {
      throw new BridgeError('BRIDGE_INVALID', 'Bridge file has invalid version, port, process, token, or host.');
    }
    return { port: bridge.port, token: bridge.token, pid: bridge.pid };
  } catch (error) {
    if (error.code === 'ELOOP') throw new BridgeError('BRIDGE_UNSAFE', 'Bridge file must not be a symbolic link.');
    throw error;
  } finally {
    await file?.close();
  }
}

class BridgeClient {
  constructor(options = {}) {
    this.bridgePath = options.bridgePath || process.env.FLOW_STUDIO_BRIDGE_FILE || defaultBridgePath;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 90000;
    this.retryDelayMs = options.retryDelayMs ?? 300;
    this.healthTimeoutMs = options.healthTimeoutMs ?? 1500;
    this.fetch = options.fetch || globalThis.fetch;
    this.launch = options.launch || (async () => {
      if (process.env.FLOW_STUDIO_NO_LAUNCH === '1') throw new BridgeError('BRIDGE_UNAVAILABLE', 'Flow Studio is not running.');
      if (process.platform !== 'darwin') throw new BridgeError('APP_UNAVAILABLE', 'Flow Studio auto-launch requires macOS.');
      const candidates=process.env.FLOW_STUDIO_APP_PATH?[process.env.FLOW_STUDIO_APP_PATH]:appPaths;
      let appPath;
      for(const candidate of candidates){try{await fs.access(candidate);appPath=candidate;break;}catch{}}
      if(!appPath)throw new BridgeError('APP_UNAVAILABLE','Install Flow Studio in /Applications or ~/Applications, or set FLOW_STUDIO_APP_PATH.');
      await promisify(execFile)('/usr/bin/open', ['-a', appPath], { timeout: 10000 });
    });
    this.connecting = null;
  }

  async request(bridge, endpoint, body, timeoutMs, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetch(`http://127.0.0.1:${bridge.port}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${bridge.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      let value;
      try { value = JSON.parse(raw); }
      catch { throw new BridgeError('BRIDGE_PROTOCOL', 'Flow Studio returned an invalid JSON response.'); }
      if (!response.ok || value?.error) {
        throw new BridgeError(value?.error?.code || `BRIDGE_HTTP_${response.status}`, value?.error?.message || `Flow Studio bridge returned HTTP ${response.status}.`);
      }
      return value;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (signal?.aborted) throw new BridgeError('REQUEST_CANCELLED', 'Bridge request cancelled. This does not cancel an accepted generation job; use cancel_job.');
      throw new BridgeError(controller.signal.aborted ? 'BRIDGE_TIMEOUT' : 'BRIDGE_TRANSPORT', 'Flow Studio bridge did not respond.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = this.findBridge();
    try { return await this.connecting; }
    finally { this.connecting = null; }
  }

  async findBridge() {
    const deadline = Date.now() + this.startupTimeoutMs;
    let launched = false;
    let lastError;
    do {
      try {
        const bridge = await readBridgeFile(this.bridgePath);
        const health = await this.request(bridge, '/health', undefined, Math.max(1, Math.min(this.healthTimeoutMs, deadline - Date.now())));
        if (health?.ready !== true || health.version !== 1) throw new BridgeError('BRIDGE_PROTOCOL', 'Flow Studio bridge is not ready or uses an unsupported version.');
        return bridge;
      } catch (error) {
        if (error.code === 'BRIDGE_UNSAFE' || error.code === 'EACCES' || error.code === 'EPERM') throw error;
        lastError = error;
      }
      if (!launched) {
        try { await this.launch(); }
        catch (error) {
          if (error instanceof BridgeError) throw error;
          throw new BridgeError('APP_LAUNCH_FAILED', 'Could not launch Flow Studio. Open the installed app and retry.');
        }
        launched = true;
      }
      if (Date.now() < deadline) await delay(Math.min(this.retryDelayMs, deadline - Date.now()));
    } while (Date.now() < deadline);
    throw new BridgeError('BRIDGE_UNAVAILABLE', `Flow Studio did not become available within ${this.startupTimeoutMs / 1000} seconds (${lastError?.code || 'BRIDGE_UNAVAILABLE'}).`);
  }

  async call(method, params, { signal } = {}) {
    if (!METHODS.has(method)) throw new BridgeError('UNKNOWN_METHOD', `Unknown Flow Studio method: ${method}`);
    if (method === 'generate' && (params?.confirmCreditSpend !== true || typeof params.requestId !== 'string' || !params.requestId.trim())) {
      throw new BridgeError('INVALID_ARGUMENTS', 'Generation requires confirmCreditSpend: true and a stable requestId.');
    }
    const body = JSON.stringify({ method, params });
    if (Buffer.byteLength(body, 'utf8') > 512 * 1024) throw new BridgeError('REQUEST_TOO_LARGE', 'Bridge request exceeds 512 KiB; pass local paths, not image data.');
    const timeoutMs = method === 'wait' ? 65000 : ['status', 'models', 'generate', 'accounts', 'login_start', 'login_complete'].includes(method) ? 120000 : 60000;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new BridgeError('REQUEST_CANCELLED', 'Bridge request cancelled.');
      const bridge = await this.connect();
      try {
        const response = await this.request(bridge, '/rpc', body, timeoutMs, signal);
        if (!response || !Object.prototype.hasOwnProperty.call(response, 'result')) throw new BridgeError('BRIDGE_PROTOCOL', 'Flow Studio response has no result.');
        return response.result;
      } catch (error) {
        if (attempt || !RETRYABLE_METHODS.has(method) || !['BRIDGE_TRANSPORT', 'BRIDGE_TIMEOUT'].includes(error.code)) throw error;
        // Reuse the exact serialized request: durable requestId deduplication prevents a second paid job.
      }
    }
  }
}

module.exports = { BridgeClient, BridgeError, readBridgeFile, defaultBridgePath };
