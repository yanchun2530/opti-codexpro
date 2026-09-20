import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opti-codexpro-session-ttl-'));
const port = await getFreePort();
const token = randomBytes(32).toString('hex');

const child = spawn(process.execPath, ['dist/http.js'], {
  cwd: repo,
  env: {
    ...process.env,
    CODEXPRO_ROOT: root,
    CODEXPRO_ALLOWED_ROOTS: root,
    CODEXPRO_HOST: '127.0.0.1',
    CODEXPRO_PORT: String(port),
    CODEXPRO_HTTP_TOKEN: token,
    CODEXPRO_HTTP_SESSION_TTL_MS: '60000',
    CODEXPRO_MAX_HTTP_SESSIONS: '8',
    CODEXPRO_BASH_MODE: 'off',
    CODEXPRO_WRITE_MODE: 'off',
    CODEXPRO_TOOL_MODE: 'minimal',
    CODEXPRO_TOOL_CARDS: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

const client = new Client({ name: 'opti-codexpro-session-ttl-smoke', version: '0.0.0' });
const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
);

try {
  await waitForListening(child);
  await client.connect(transport);

  const before = await client.listTools();
  if (!before.tools?.length) throw new Error('initial tools/list returned no tools');

  // The prune timer runs at 60 s for the minimum supported TTL.
  // Keep the GET /mcp stream open beyond that boundary without issuing
  // another MCP request. Old behavior deleted the live session here.
  await new Promise((resolve) => setTimeout(resolve, 65000));

  const after = await client.listTools();
  if (!after.tools?.length) throw new Error('post-TTL tools/list returned no tools');

  if (stderr.includes('pruning idle MCP session')) {
    throw new Error(`active MCP session was pruned:\n${stderr}`);
  }

  console.log('HTTP_SESSION_TTL_SMOKE_PASS');
} finally {
  try { await client.close(); } catch {}
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await fs.rm(root, { recursive: true, force: true });
}
