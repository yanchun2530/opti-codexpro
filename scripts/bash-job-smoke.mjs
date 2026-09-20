import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function encode(message) { return JSON.stringify(message) + '\n'; }

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
      const msg = JSON.parse(line);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    }
  }
  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }
  close() { this.child.kill('SIGTERM'); }
}

const root = path.resolve('.');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-bash-job-smoke-'));
const bin = path.join(tmp, 'bin');
await fs.mkdir(bin, { recursive: true });
const fakeWorker = path.join(bin, 'batch-worker');
await fs.writeFile(fakeWorker, '#!/bin/bash\nsleep 2\necho BASH_LONG_JOB_PASS\n', { mode: 0o755 });
await fs.writeFile(path.join(tmp, 'fake.job'), 'job fixture\n');

const client = new McpStdioClient(process.execPath, ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'full', '--tool-mode', 'full'], {
  cwd: root,
  env: {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    CODEXPRO_ROOT: tmp,
    CODEXPRO_ALLOWED_ROOTS: tmp,
    CODEXPRO_BASH_MODE: 'full'
  }
});

await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'codexpro-bash-job-smoke', version: '0.1.0' }
});
client.notify('notifications/initialized');

const opened = await client.request('tools/call', {
  name: 'open_current_workspace',
  arguments: { include_tree: false }
});
const workspaceId = opened.structuredContent.workspace_id;

const startedAt = Date.now();
const started = await client.request('tools/call', {
  name: 'bash',
  arguments: {
    workspace_id: workspaceId,
    command: 'batch-worker --batch fake.job',
    timeout_ms: 1000
  }
});
const startLatency = Date.now() - startedAt;
const sc = started.structuredContent;
if (sc.background !== true || sc.state !== 'running' || !sc.job_id) {
  throw new Error(`auto background did not start: ${JSON.stringify(sc)}`);
}
if (startLatency > 1500) {
  throw new Error(`background start blocked too long: ${startLatency} ms`);
}

const status = await client.request('tools/call', {
  name: 'bash_job_status',
  arguments: {
    workspace_id: workspaceId,
    job_id: sc.job_id,
    max_wait_seconds: 6,
    poll_ms: 250,
    tail_bytes: 10000
  }
});
const jc = status.structuredContent;
if (jc.state !== 'completed' || jc.exit_code !== 0) {
  throw new Error(`background job did not complete: ${JSON.stringify(jc)}`);
}
if (!String(jc.stdout ?? '').includes('BASH_LONG_JOB_PASS')) {
  throw new Error(`background stdout missing marker: ${JSON.stringify(jc)}`);
}

console.log('BASH_JOB_SMOKE_PASS', sc.job_id, 'start_ms=' + startLatency, 'duration_ms=' + jc.duration_ms);
client.close();
await fs.rm(tmp, { recursive: true, force: true });
