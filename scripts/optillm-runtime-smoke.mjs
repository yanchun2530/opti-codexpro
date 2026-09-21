import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function requireValue(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const { resolve, reject, timer } = this.pending.get(message.id);
      clearTimeout(timer);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-optillm-smoke-'));
const client = new McpStdioClient(process.execPath, ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--tool-mode', 'minimal'], {
  cwd: path.resolve('.'),
  env: { ...process.env, CODEXPRO_ROOT: tmp, CODEXPRO_ALLOWED_ROOTS: tmp, CODEXPRO_BASH_MODE: 'off' }
});

try {
  await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codexpro-optillm-runtime-smoke', version: '0.1.0' }
  });
  client.notify('notifications/initialized');

  const tools = await client.request('tools/list', {});
  const names = tools.tools.map((item) => item.name);
  const tool = tools.tools.find((item) => item.name === 'optillm_runtime');
  requireValue(tool, 'minimal mode missing optillm_runtime', names);
  requireValue(!names.includes('think') && !names.includes('reasoning_runtime'), 'legacy Opti aliases must not be exposed', names);

  const health = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'health' }
  });
  requireValue(health.structuredContent?.mode === 'web-native', 'unexpected OptiLLM health mode', health.structuredContent);
  requireValue(health.structuredContent?.codex_cli_used === false, 'OptiLLM must not use Codex CLI', health.structuredContent);
  requireValue(health.structuredContent?.backend_model_calls === 0, 'OptiLLM must not call backend models', health.structuredContent);

  const started = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'start', approach: 'auto', difficulty: 'easy', budget: 'fast', task: 'Return the number four.' }
  });
  const runtimeId = started.structuredContent?.runtime_id;
  requireValue(started.structuredContent?.status === 'needs_model' && runtimeId, 'OptiLLM start did not return a model directive', started.structuredContent);

  const completed = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'submit', runtime_id: runtimeId, answer: '4' }
  });
  requireValue(completed.structuredContent?.status === 'complete', 'OptiLLM submit did not complete', completed.structuredContent);
  console.log('optillm runtime smoke passed');
} finally {
  client.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
