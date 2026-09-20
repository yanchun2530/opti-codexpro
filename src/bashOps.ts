import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface BashResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  bashSessionId?: string;
}

export type BashExecutionMode = "auto" | "foreground" | "background";
export type BashJobState = "running" | "completed" | "failed" | "lost";

export interface BashJobStartResult {
  jobId: string;
  state: "running";
  pid: number;
  command: string;
  cwd: string;
  startedAtMs: number;
  stdoutPath: string;
  stderrPath: string;
  bashSessionId?: string;
}

export interface BashJobStatusResult {
  jobId: string;
  state: BashJobState;
  pid: number;
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  stdoutPath: string;
  stderrPath: string;
  bashSessionId?: string;
}

const LONG_RUNNING_BATCH_HINT = /(?:--?batch\b|--?files?\b|-f\s+\S+|\b(?:build|compile|benchmark|pipeline|workflow|regression)\b)/i;
const QUICK_COMMAND_PROBE = /(?:command\s+-v|which\s+|where\s+|--?version\b|\s-W(?:\s|$)|\bhelp\b)/i;

export function shouldAutoBackgroundBash(command: string, timeoutMs?: number): boolean {
  const normalized = compact(command);
  if (QUICK_COMMAND_PROBE.test(normalized)) return false;
  if ((timeoutMs ?? 0) >= 120_000) return true;
  return LONG_RUNNING_BATCH_HINT.test(normalized);
}

const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "tsc",
  "npx tsc",
  "eslint",
  "npx eslint",
  "biome check",
  "npx biome check"
];

const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)['"]?-exec(?:['"]|\s|$)/,
  /(^|\s)['"]?-execdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-delete(?:['"]|\s|$)/,
  /(^|\s)['"]?-ok(?:['"]|\s|$)/,
  /(^|\s)['"]?-okdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprint0?(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprintf(?:['"]|\s|$)/,
  /(^|\s)['"]?-fls(?:['"]|\s|$)/,
  /(^|\s)['"]?--output(?:=|['"]|\s|$)/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  /[;&|<>`]/,
  /[\r\n]/
];

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function startsWithAllowedPrefix(command: string): boolean {
  const normalized = compact(command);
  return isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern =
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|typecheck|lint|build|check)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/;
  return packageScriptPattern.test(command);
}

function assertSafeCommand(config: CodexProConfig, command: string): void {
  if (config.bashMode === "off") {
    throw new CodexProError("bash tool is disabled. Start with CODEXPRO_BASH_MODE=safe or CODEXPRO_BASH_MODE=full to enable it.");
  }
  if (config.bashMode === "full") return;

  const raw = command.trim();
  const normalized = compact(command);
  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      throw new CodexProError(
        `Command is blocked in CODEXPRO_BASH_MODE=safe: ${normalized}\n` +
          "Use separate read/search/git tools, or restart with CODEXPRO_BASH_MODE=full only for trusted repos."
      );
    }
  }
  if (!startsWithAllowedPrefix(normalized)) {
    throw new CodexProError(
      `Command is not in the safe bash allowlist: ${normalized}\n` +
        "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use CODEXPRO_BASH_MODE=full for trusted local automation."
    );
  }
}

function assertBashSession(config: CodexProConfig, sessionId?: string): string | undefined {
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new CodexProError("bash session guard is enabled but no server bash session id is configured.");
    }
    return undefined;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new CodexProError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return config.bashSessionId;
  }
  if (requested !== config.bashSessionId) {
    throw new CodexProError(`bash session id mismatch. This CodexPro server accepts session_id="${config.bashSessionId}".`);
  }
  return config.bashSessionId;
}

function isUsableAbsoluteDir(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined;
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  if (!path.isAbsolute(trimmed) && !path.win32.isAbsolute(trimmed)) return undefined;
  try {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
  } catch {
    // Ignore unreadable candidates and keep searching.
  }
  return undefined;
}

/** Resolve a usable absolute home for restricted child processes. Rejects relative junk like "=". */
export function resolveUsableHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    isUsableAbsoluteDir(env.USERPROFILE) ??
    isUsableAbsoluteDir(env.HOME) ??
    isUsableAbsoluteDir(os.homedir()) ??
    path.resolve(os.homedir())
  );
}

export function makeRestrictedBashEnv(
  config: CodexProConfig,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...env, NO_COLOR: "1", CI: env.CI ?? "1" };
  }
  const home = resolveUsableHomeDir(env);
  const restricted: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    USER: env.USER ?? env.USERNAME ?? "",
    SHELL: env.SHELL ?? "/bin/bash",
    TMPDIR: isUsableAbsoluteDir(env.TMPDIR) ?? isUsableAbsoluteDir(env.TMP) ?? os.tmpdir(),
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1"
  };
  if (process.platform === "win32") {
    restricted.USERPROFILE = home;
    const appData = isUsableAbsoluteDir(env.APPDATA);
    const localAppData = isUsableAbsoluteDir(env.LOCALAPPDATA);
    if (appData) restricted.APPDATA = appData;
    if (localAppData) restricted.LOCALAPPDATA = localAppData;
    if (env.USERNAME) restricted.USERNAME = env.USERNAME;
    if (env.HOMEDRIVE && env.HOMEPATH && path.win32.isAbsolute(path.win32.join(env.HOMEDRIVE, env.HOMEPATH))) {
      restricted.HOMEDRIVE = env.HOMEDRIVE;
      restricted.HOMEPATH = env.HOMEPATH;
    }
  }
  return restricted;
}

function makeEnv(config: CodexProConfig): NodeJS.ProcessEnv {
  return makeRestrictedBashEnv(config);
}

function bashExecutable(): string {
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const sliced = buffer.subarray(0, maxBytes).toString("utf8");
  return { value: `${sliced}\n...[output truncated to ${maxBytes} bytes]`, truncated: true };
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    // Windows does not provide Unix-style cooperative signals to process trees.
    // Force the full tree while the parent PID still identifies its descendants;
    // otherwise the shell can exit first and orphan an output-heavy grandchild.
    const args = ["/pid", String(child.pid), "/t", "/f"];
    const result = spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true });
    if (result.status !== 0) child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

export async function runBash(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: { cwd?: string; timeoutMs?: number; sessionId?: string } = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new CodexProError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, config.maxBashTimeoutMs));
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(bashExecutable(), ["-lc", command], {
      cwd,
      env: makeEnv(config),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let closed = false;
    let terminationStarted = false;
    let killTimer: NodeJS.Timeout | undefined;
    let observedOutputBytes = 0;
    const retainedOutputBytes = config.maxOutputBytes + 1;

    const terminate = (signal: NodeJS.Signals) => {
      if (closed) return;
      terminationStarted = true;
      terminateProcessTree(child, signal);
    };
    const terminateWithEscalation = () => {
      if (terminationStarted || closed) return;
      terminate("SIGTERM");
      killTimer = setTimeout(() => terminate("SIGKILL"), 1_500);
      killTimer.unref();
    };
    const appendBounded = (current: string, chunk: unknown) => {
      const bytes = Buffer.from(String(chunk), "utf8");
      observedOutputBytes += bytes.byteLength;
      const remaining = retainedOutputBytes - Buffer.byteLength(stdout, "utf8") - Buffer.byteLength(stderr, "utf8");
      if (remaining <= 0) return current;
      return current + bytes.subarray(0, remaining).toString("utf8");
    };

    const timer = setTimeout(() => {
      killedByTimeout = true;
      terminateWithEscalation();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
      if (observedOutputBytes > config.maxOutputBytes) terminateWithEscalation();
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
      if (observedOutputBytes > config.maxOutputBytes) terminateWithEscalation();
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (killedByTimeout) {
        stderr += `\n[codexpro] Command timed out after ${timeoutMs} ms.`;
      }
      const out = trimOutput(redactSensitiveText(stdout), config.maxOutputBytes);
      const err = trimOutput(redactSensitiveText(stderr), config.maxOutputBytes);
      resolve({
        command,
        cwd: path.relative(workspace.root, cwd) || ".",
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: out.value,
        stderr: err.value,
        truncated: out.truncated || err.truncated,
        ...(bashSessionId ? { bashSessionId } : {})
      });
    });
  });
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function bashJobRoot(config: CodexProConfig, workspace: Workspace): string {
  return path.join(workspace.root, config.contextDir, "bash-jobs");
}

function assertBashJobId(jobId: string): string {
  const value = jobId.trim();
  if (!/^job_[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw new CodexProError("Invalid bash job id.");
  }
  return value;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readTail(filePath: string, maxBytes: number): { value: string; truncated: boolean } {
  try {
    const stat = fs.statSync(filePath);
    const bytes = Math.min(stat.size, maxBytes);
    if (bytes <= 0) return { value: "", truncated: false };
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(bytes);
      fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes));
      return {
        value: redactSensitiveText(buffer.toString("utf8")),
        truncated: stat.size > bytes
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: "", truncated: false };
    throw error;
  }
}

interface BashJobMetadata {
  jobId: string;
  pid: number;
  command: string;
  cwd: string;
  startedAtMs: number;
  stdoutPath: string;
  stderrPath: string;
  exitCodePath: string;
  endedAtPath: string;
  bashSessionId?: string;
}

function readBashJobMetadata(config: CodexProConfig, workspace: Workspace, jobId: string): BashJobMetadata {
  const safeId = assertBashJobId(jobId);
  const metaPath = path.join(bashJobRoot(config, workspace), safeId, "meta.json");
  let raw: string;
  try {
    raw = fs.readFileSync(metaPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodexProError(`Unknown bash job: ${safeId}`);
    }
    throw error;
  }
  const parsed = JSON.parse(raw) as BashJobMetadata;
  if (parsed.jobId !== safeId || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
    throw new CodexProError(`Invalid bash job metadata for ${safeId}.`);
  }
  return parsed;
}

export function startBashJob(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: { cwd?: string; sessionId?: string } = {}
): BashJobStartResult {
  if (!command?.trim()) throw new CodexProError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const startedAtMs = Date.now();
  const jobId = `job_${startedAtMs.toString(36)}_${randomBytes(5).toString("hex")}`;
  const root = bashJobRoot(config, workspace);
  const jobDir = path.join(root, jobId);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });

  const stdoutPath = path.join(jobDir, "stdout.log");
  const stderrPath = path.join(jobDir, "stderr.log");
  const exitCodePath = path.join(jobDir, "exit_code");
  const endedAtPath = path.join(jobDir, "ended_at_ms");

  const stdoutFd = fs.openSync(stdoutPath, "a", 0o600);
  const stderrFd = fs.openSync(stderrPath, "a", 0o600);
  const child = spawn(bashExecutable(), ["-lc", command], {
    cwd,
    env: makeEnv(config),
    stdio: ["ignore", stdoutFd, stderrFd],
    detached: process.platform !== "win32",
    windowsHide: true
  });
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);
  if (!child.pid) throw new CodexProError("Failed to start background bash job.");
  let completionRecorded = false;
  const recordCompletion = (exitCode: number | null): void => {
    if (completionRecorded) return;
    completionRecorded = true;
    try {
      fs.writeFileSync(exitCodePath, String(exitCode ?? -1) + "\n", { mode: 0o600 });
      fs.writeFileSync(endedAtPath, String(Date.now()) + "\n", { mode: 0o600 });
    } catch (error) {
      console.error(`[CodexPro] failed to persist bash job completion: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  child.once("error", () => recordCompletion(null));
  child.once("close", (exitCode) => recordCompletion(exitCode));
  child.unref();

  const relativeJobDir = path.relative(workspace.root, jobDir) || ".";
  const meta: BashJobMetadata = {
    jobId,
    pid: child.pid,
    command,
    cwd: path.relative(workspace.root, cwd) || ".",
    startedAtMs,
    stdoutPath: path.join(relativeJobDir, "stdout.log"),
    stderrPath: path.join(relativeJobDir, "stderr.log"),
    exitCodePath,
    endedAtPath,
    ...(bashSessionId ? { bashSessionId } : {})
  };
  fs.writeFileSync(path.join(jobDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });

  return {
    jobId,
    state: "running",
    pid: child.pid,
    command,
    cwd: meta.cwd,
    startedAtMs,
    stdoutPath: meta.stdoutPath,
    stderrPath: meta.stderrPath,
    ...(bashSessionId ? { bashSessionId } : {})
  };
}

export function getBashJobStatus(
  config: CodexProConfig,
  workspace: Workspace,
  jobId: string,
  tailBytes = 20_000
): BashJobStatusResult {
  const meta = readBashJobMetadata(config, workspace, jobId);
  const boundedTail = Math.max(1_000, Math.min(tailBytes, config.maxOutputBytes));
  let exitCode: number | null = null;
  try {
    const raw = fs.readFileSync(meta.exitCodePath, "utf8").trim();
    if (/^-?\d+$/.test(raw)) exitCode = Number(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let endedAtMs: number | null = null;
  try {
    const raw = fs.readFileSync(meta.endedAtPath, "utf8").trim();
    if (/^\d+$/.test(raw)) endedAtMs = Number(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const alive = processIsAlive(meta.pid);
  // Allow a short visibility grace after process exit before declaring a job lost.
  const finishingGrace = !alive && exitCode === null && Date.now() - meta.startedAtMs < 2_000;
  const state: BashJobState =
    exitCode !== null ? (exitCode === 0 ? "completed" : "failed") : alive || finishingGrace ? "running" : "lost";
  const stdout = readTail(path.join(workspace.root, meta.stdoutPath), boundedTail);
  const stderr = readTail(path.join(workspace.root, meta.stderrPath), boundedTail);
  return {
    jobId: meta.jobId,
    state,
    pid: meta.pid,
    command: meta.command,
    cwd: meta.cwd,
    exitCode,
    durationMs: Math.max(0, (endedAtMs ?? Date.now()) - meta.startedAtMs),
    stdout: stdout.value,
    stderr: stderr.value,
    truncated: stdout.truncated || stderr.truncated,
    stdoutPath: meta.stdoutPath,
    stderrPath: meta.stderrPath,
    ...(meta.bashSessionId ? { bashSessionId: meta.bashSessionId } : {})
  };
}
