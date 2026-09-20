import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function encode(message) {
  return JSON.stringify(message) + '\n';
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
      for (const { reject } of this.pending.values()) reject(new Error('server exited ' + code));
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
      if (!msg.id || !this.pending.has(msg.id)) continue;
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for ' + method)), 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

function requireValue(condition, message, value) {
  if (!condition) throw new Error(message + ': ' + JSON.stringify(value));
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'codexpro-optillm-smoke-'));
const client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'off', '--tool-mode', 'minimal'], {
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
  const tool = tools.tools.find((item) => item.name === 'optillm_runtime');
  requireValue(tool, 'minimal mode missing optillm_runtime', tools.tools.map((item) => item.name));
  requireValue(tools.tools.some((item) => item.name === 'think'), 'minimal mode missing legacy think alias', tools.tools.map((item) => item.name));
  requireValue(tools.tools.some((item) => item.name === 'reasoning_runtime'), 'minimal mode missing legacy reasoning_runtime alias', tools.tools.map((item) => item.name));

  const actions = tool.inputSchema?.properties?.action?.enum ?? [];
  requireValue(
    JSON.stringify(actions) === JSON.stringify(['list', 'health', 'start', 'submit', 'state', 'cancel']),
    'optillm_runtime should expose the web-native state-machine API',
    actions
  );

  const listed = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'list' }
  });
  const core = listed.structuredContent?.core_approaches ?? [];
  requireValue(JSON.stringify(core) === JSON.stringify(['auto', 're2', 'bon', 'cot_reflection', 'self_consistency', 'moa', 'plansearch', 'rto', 'z3', 'leap', 'cepo', 'mars']), 'web-native core approaches mismatch', core);

  const health = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'health' }
  });
  requireValue(health.structuredContent?.codex_cli_used === false, 'web-native runtime must not use Codex CLI', health.structuredContent);
  requireValue(health.structuredContent?.backend_model_calls === 0, 'web-native runtime must not call backend models', health.structuredContent);

  const legacyThinkStart = await client.request('tools/call', {
    name: 'think',
    arguments: { prompt: 'What is 2+2?', difficulty: 'easy' }
  });
  const legacyThinkId = legacyThinkStart.structuredContent?.reasoning_id;
  requireValue(legacyThinkStart.structuredContent?.alias_of === 'optillm_runtime', 'think alias is not wired to OptiLLM', legacyThinkStart.structuredContent);
  requireValue(legacyThinkStart.structuredContent?.approach === 're2' && legacyThinkId, 'think alias did not auto-route to RE2', legacyThinkStart.structuredContent);
  const legacyThinkDone = await client.request('tools/call', {
    name: 'think',
    arguments: { action: 'submit', reasoning_id: legacyThinkId, answer: '4' }
  });
  requireValue(legacyThinkDone.structuredContent?.status === 'complete', 'think alias could not complete via reasoning_id', legacyThinkDone.structuredContent);
  requireValue(legacyThinkDone.structuredContent?.backend_model_calls === 0, 'think alias made backend model calls', legacyThinkDone.structuredContent);

  const legacyReasoningStart = await client.request('tools/call', {
    name: 'reasoning_runtime',
    arguments: { action: 'start', query: 'Compare candidate A and B.', mode: 'bon' }
  });
  const legacyReasoningId = legacyReasoningStart.structuredContent?.reasoning_id;
  requireValue(legacyReasoningStart.structuredContent?.alias_of === 'optillm_runtime', 'reasoning_runtime alias is not wired to OptiLLM', legacyReasoningStart.structuredContent);
  requireValue(legacyReasoningStart.structuredContent?.approach === 'bon' && legacyReasoningId, 'reasoning_runtime alias did not honor BoN mode', legacyReasoningStart.structuredContent);
  const legacyReasoningCancel = await client.request('tools/call', {
    name: 'reasoning_runtime',
    arguments: { action: 'cancel', reasoning_id: legacyReasoningId }
  });
  requireValue(legacyReasoningCancel.structuredContent?.status === 'cancelled', 'reasoning_runtime alias cancel failed', legacyReasoningCancel.structuredContent);

  for (const [difficulty, expected] of [['easy', 're2'], ['medium', 'bon'], ['hard', 'mars']]) {
    const routed = await client.request('tools/call', {
      name: 'optillm_runtime',
      arguments: { action: 'start', approach: 'auto', difficulty, task: 'Route this test task.' }
    });
    requireValue(routed.structuredContent?.auto_difficulty === difficulty, 'auto difficulty mismatch', routed.structuredContent);
    requireValue(routed.structuredContent?.auto_selected_approach === expected, 'auto route mismatch', routed.structuredContent);
    requireValue(routed.structuredContent?.approach === expected, 'auto did not enter selected approach', routed.structuredContent);
    await client.request('tools/call', {
      name: 'optillm_runtime',
      arguments: { action: 'cancel', runtime_id: routed.structuredContent?.runtime_id }
    });
  }

  const fallbackAuto = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'start', task: 'Explain two competing approaches and choose one.' }
  });
  requireValue(fallbackAuto.structuredContent?.requested_approach === 'auto', 'omitted approach must default to auto', fallbackAuto.structuredContent);
  requireValue(fallbackAuto.structuredContent?.auto_selected_approach === 'bon', 'medium fallback should route to BoN', fallbackAuto.structuredContent);
  await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'cancel', runtime_id: fallbackAuto.structuredContent?.runtime_id }
  });

  const re2Start = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'start', approach: 're2', task: 'What is 2+2?' }
  });
  const re2Id = re2Start.structuredContent?.runtime_id;
  requireValue(re2Start.structuredContent?.status === 'needs_model' && re2Id, 'RE2 start failed', re2Start.structuredContent);
  requireValue(
    re2Start.structuredContent?.prompt?.user === 'What is 2+2?\nRead the question again: What is 2+2?',
    'RE2 prompt must match native reread.py',
    re2Start.structuredContent?.prompt
  );
  const re2Done = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'submit', runtime_id: re2Id, answer: '4' }
  });
  requireValue(re2Done.structuredContent?.status === 'complete', 'RE2 did not complete', re2Done.structuredContent);
  requireValue(re2Done.structuredContent?.result === '4', 'RE2 result mismatch', re2Done.structuredContent);
  requireValue(re2Done.structuredContent?.backend_model_calls === 0, 'RE2 made backend model calls', re2Done.structuredContent);

  const bonStart = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'start', approach: 'bon', budget: 'adaptive', task: 'Pick the best answer.' }
  });
  const bonId = bonStart.structuredContent?.runtime_id;
  requireValue(bonStart.structuredContent?.stage === 'generate' && bonId, 'BoN start failed', bonStart.structuredContent);

  let bonStep = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'submit', runtime_id: bonId, answer: 'A' }
  });
  requireValue(bonStep.structuredContent?.stage === 'generate', 'BoN should request candidate 2', bonStep.structuredContent);
  bonStep = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'submit', runtime_id: bonId, answer: 'B' }
  });
  requireValue(bonStep.structuredContent?.stage === 'judge', 'BoN should joint-judge after two adaptive candidates', bonStep.structuredContent);
  bonStep = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: {
      action: 'submit', runtime_id: bonId, selected_index: 1,
      ratings: [3, 9], confidence: 9, need_more: false
    }
  });
  requireValue(bonStep.structuredContent?.status === 'complete', 'BoN did not complete', bonStep.structuredContent);
  requireValue(bonStep.structuredContent?.result === 'B', 'BoN joint judge selected wrong candidate', bonStep.structuredContent);
  requireValue(bonStep.structuredContent?.candidates_used === 2, 'BoN adaptive fast path should use 2 candidates', bonStep.structuredContent);
  requireValue(bonStep.structuredContent?.backend_model_calls === 0, 'BoN made backend model calls', bonStep.structuredContent);

  const bonExpand = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'start', approach: 'bon', budget: 'adaptive', task: 'Ambiguous choice.' }
  });
  const bonExpandId = bonExpand.structuredContent?.runtime_id;
  await client.request('tools/call', { name: 'optillm_runtime', arguments: { action: 'submit', runtime_id: bonExpandId, answer: 'X' } });
  let bonExpandStep = await client.request('tools/call', { name: 'optillm_runtime', arguments: { action: 'submit', runtime_id: bonExpandId, answer: 'Y' } });
  requireValue(bonExpandStep.structuredContent?.stage === 'judge', 'BoN expansion run did not reach judge', bonExpandStep.structuredContent);
  bonExpandStep = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'submit', runtime_id: bonExpandId, selected_index: 0, ratings: [6, 6], confidence: 4, need_more: true }
  });
  requireValue(bonExpandStep.structuredContent?.stage === 'generate' && bonExpandStep.structuredContent?.candidate_number === 3, 'BoN should expand on low confidence', bonExpandStep.structuredContent);
  await client.request('tools/call', { name: 'optillm_runtime', arguments: { action: 'cancel', runtime_id: bonExpandId } });

  const marsStart = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'start', approach: 'mars', budget: 'adaptive', task: 'What is 5+6?' }
  });
  const marsId = marsStart.structuredContent?.runtime_id;
  requireValue(marsStart.structuredContent?.stage === 'explore' && marsId, 'MARS start failed', marsStart.structuredContent);
  requireValue(marsStart.structuredContent?.min_agents === 2 && marsStart.structuredContent?.max_agents === 3, 'MARS adaptive agent limits mismatch', marsStart.structuredContent);

  let marsStep = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'submit', runtime_id: marsId, answer: 'Final answer: 11' }
  });
  requireValue(marsStep.structuredContent?.stage === 'explore', 'MARS should request solver 2', marsStep.structuredContent);
  marsStep = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'submit', runtime_id: marsId, answer: 'After checking, final answer: 11' }
  });
  requireValue(marsStep.structuredContent?.stage === 'joint_verify', 'MARS consensus should enter joint verify after 2 solvers', marsStep.structuredContent);
  marsStep = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: {
      action: 'submit', runtime_id: marsId, answer: '11', assessment: 'CORRECT',
      confidence: 10, selected_index: 0, report: 'Both agree and arithmetic verifies.', issues: [], need_more: false
    }
  });
  requireValue(marsStep.structuredContent?.status === 'complete', 'MARS adaptive fast path did not complete', marsStep.structuredContent);
  requireValue(marsStep.structuredContent?.result === '11', 'MARS result mismatch', marsStep.structuredContent);
  requireValue(marsStep.structuredContent?.agent_count === 2, 'MARS consensus fast path should use 2 solvers', marsStep.structuredContent);
  requireValue(marsStep.structuredContent?.fidelity === 'web-mars-adaptive', 'MARS adaptive fidelity label missing', marsStep.structuredContent);
  requireValue(marsStep.structuredContent?.backend_model_calls === 0, 'MARS made backend model calls', marsStep.structuredContent);

  const marsDisagree = await client.request('tools/call', {
    name: 'optillm_runtime',
    arguments: { action: 'start', approach: 'mars', budget: 'adaptive', task: 'What is 8+5?' }
  });
  const marsDisagreeId = marsDisagree.structuredContent?.runtime_id;
  await client.request('tools/call', { name: 'optillm_runtime', arguments: { action: 'submit', runtime_id: marsDisagreeId, answer: 'Final answer: 13' } });
  let marsDisagreeStep = await client.request('tools/call', { name: 'optillm_runtime', arguments: { action: 'submit', runtime_id: marsDisagreeId, answer: 'Final answer: 14' } });
  requireValue(marsDisagreeStep.structuredContent?.stage === 'explore' && marsDisagreeStep.structuredContent?.agent_number === 3, 'MARS disagreement should add solver 3', marsDisagreeStep.structuredContent);
  await client.request('tools/call', { name: 'optillm_runtime', arguments: { action: 'cancel', runtime_id: marsDisagreeId } });

  console.log('optillm-runtime-smoke: PASS');
} finally {
  client.close();
  await fs.rm(tmp, { recursive: true, force: true });
}
