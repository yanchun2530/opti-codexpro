import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
    server.on('error', reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for HTTP server\n${stderr}`)), 15000);
    timer.unref();
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.includes('HTTP MCP listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`HTTP server exited before listening: ${code}\n${stderr}`));
    });
  });
}

const repo = path.resolve('.');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opti-codexpro-session-capacity-'));
const port = await getFreePort();
const token = randomBytes(32).toString('hex');
const baseUrl = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['dist/http.js'], {
  cwd: repo,
  env: {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_HTTP_SESSION_TTL_MS: '1800000',
    CODEXPRO_MAX_HTTP_SESSIONS: '1',
    CODEXPRO_BASH_MODE: 'off',
    CODEXPRO_WRITE_MODE: 'off',
    CODEXPRO_TOOL_MODE: 'minimal',
    CODEXPRO_TOOL_CARDS: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

const baseHeaders = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json, text/event-stream',
  'Content-Type': 'application/json'
};

async function post(body, sessionId) {
  const headers = { ...baseHeaders };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { response, text };
}

async function initSession(id) {
  const init = await post({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: `capacity-smoke-${id}`, version: '0.0.0' }
    }
  });
  if (init.response.status !== 200) {
    throw new Error(`initialize ${id} failed: ${init.response.status} ${init.text}`);
  }
  const sessionId = init.response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error(`initialize ${id} returned no Mcp-Session-Id`);
  const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
  if (![200, 202].includes(initialized.response.status)) {
    throw new Error(`initialized ${id} failed: ${initialized.response.status} ${initialized.text}`);
  }
  return sessionId;
}

try {
  await waitForListening(child);

  const session1 = await initSession(1);
  const session2 = await initSession(2);
  if (session1 === session2) throw new Error('expected distinct sessions');

  // With maxHttpSessions=1, the old hard-cap policy pruned session1 immediately
  // when session2 was created. The new policy treats the configured max as a
  // soft cap and preserves recently-used inactive sessions during reconnect bursts.
  const reuse = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, session1);
  if (reuse.response.status !== 200) {
    throw new Error(`recent session was capacity-pruned: ${reuse.response.status} ${reuse.text}\nserver stderr:\n${stderr}`);
  }

  const health = await fetch(`${baseUrl}/healthz`, { headers: { Authorization: `Bearer ${token}` } });
  const healthJson = await health.json();
  if ((healthJson.httpSessions?.total ?? 0) < 2) {
    throw new Error(`expected soft-cap burst to retain both sessions: ${JSON.stringify(healthJson)}`);
  }

  if (stderr.includes('emergency pruning inactive MCP session')) {
    throw new Error(`unexpected emergency pruning:\n${stderr}`);
  }

  console.log('HTTP_SESSION_CAPACITY_SMOKE_PASS');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await fs.rm(root, { recursive: true, force: true });
}
