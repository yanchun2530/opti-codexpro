import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

export type WebOptiLLMAction = "list" | "health" | "start" | "submit" | "state" | "cancel";
export type WebOptiLLMApproach = "auto" | "re2" | "bon" | "mars" | "cot_reflection" | "self_consistency" | "plansearch" | "z3" | "rto" | "leap" | "moa" | "cepo";
export type WebOptiLLMDifficulty = "easy" | "medium" | "hard";
export type WebOptiLLMBudget = "fast" | "adaptive" | "deep";
export type MarsAssessment = "CORRECT" | "INCORRECT" | "INCOMPLETE";

export interface OptiLLMRuntimeInput {
  action: WebOptiLLMAction;
  approach?: WebOptiLLMApproach;
  difficulty?: WebOptiLLMDifficulty;
  budget?: WebOptiLLMBudget;
  strategy_hint?: Exclude<WebOptiLLMApproach, "auto">;
  task?: string;
  system_prompt?: string;
  n?: number;
  runtime_id?: string;
  answer?: string;
  rating?: number;
  ratings?: number[];
  selected_index?: number;
  need_more?: boolean;
  assessment?: MarsAssessment;
  confidence?: number;
  report?: string;
  issues?: string[];
}

interface Re2Session {
  id: string;
  approach: "re2";
  task: string;
  systemPrompt: string;
  stage: "answer" | "done";
  answer?: string;
  createdAt: number;
}

interface BonSession {
  id: string;
  approach: "bon";
  task: string;
  systemPrompt: string;
  n: number;
  budget: WebOptiLLMBudget;
  minCandidates: number;
  maxCandidates: number;
  stage: "generate" | "judge" | "rate" | "done";
  candidates: string[];
  ratings: number[];
  judgeRounds: number;
  createdAt: number;
}

interface MarsVerification {
  assessment: MarsAssessment;
  confidence: number;
  report: string;
  issues: string[];
}

interface MarsSession {
  id: string;
  approach: "mars";
  task: string;
  systemPrompt: string;
  budget: WebOptiLLMBudget;
  minAgents: number;
  maxAgents: number;
  stage: "explore" | "joint_verify" | "verify" | "improve" | "synthesize" | "done";
  solutions: string[];
  verifications: MarsVerification[];
  jointVerification?: MarsVerification;
  improvementQueue: number[];
  improvements: Record<number, string>;
  improveCursor: number;
  finalAnswer?: string;
  createdAt: number;
}

type ExtendedApproach = "cot_reflection" | "self_consistency" | "plansearch" | "z3" | "rto" | "leap" | "moa" | "cepo";

interface ExtendedSession {
  id: string;
  approach: ExtendedApproach;
  task: string;
  systemPrompt: string;
  stage: string;
  n: number;
  budget: WebOptiLLMBudget;
  items: string[];
  data: Record<string, any>;
  result?: string;
  createdAt: number;
}

type Session = Re2Session | BonSession | MarsSession | ExtendedSession;

export interface OptiLLMRuntimeResult {
  ok: boolean;
  action: WebOptiLLMAction;
  runtime_id?: string;
  approach?: WebOptiLLMApproach;
  status?: "needs_model" | "complete" | "cancelled";
  stage?: string;
  directive?: string;
  prompt?: {
    system: string;
    user: string;
  };
  result?: string;
  candidates?: string[];
  ratings?: number[];
  selected_index?: number;
  source_reference?: string;
  [key: string]: unknown;
}

const sessions = new Map<string, Session>();
const MAX_SESSIONS = 512;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const MARS_TEMPERATURES = [0.3, 0.6, 1.0] as const;
const MARS_EFFORTS = ["low", "medium", "high"] as const;
const MARS_SYSTEM_PROMPT = `You are a reasoning expert participating in a multi-agent problem-solving system. Your goal is to provide rigorous, step-by-step solutions to complex problems.

Key principles:
1. Logical rigor: Provide complete, logically sound reasoning
2. Step-by-step approach: Break down complex problems into manageable steps
3. Verification: Double-check your work and identify potential errors
4. Clarity: Explain your reasoning clearly and precisely
5. Completeness: Ensure your solution addresses all aspects of the problem

For analytical problems, focus on complete analysis, rigorous justification, edge cases, and clear structure. When applicable, format the final answer clearly.`;

function cleanSessions(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(id);
  }
  if (sessions.size <= MAX_SESSIONS) return;
  const ordered = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const session of ordered.slice(0, sessions.size - MAX_SESSIONS)) {
    sessions.delete(session.id);
  }
}

function requireTask(input: OptiLLMRuntimeInput): string {
  const task = String(input.task ?? "").trim();
  if (!task) throw new Error("action=start requires task");
  return task;
}

function requireSession(input: OptiLLMRuntimeInput): Session {
  const id = String(input.runtime_id ?? "").trim();
  if (!id) throw new Error("runtime_id is required");
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown or expired OptiLLM runtime_id: ${id}`);
  return session;
}

function defaultSystemPrompt(input: OptiLLMRuntimeInput): string {
  const value = String(input.system_prompt ?? "").trim();
  return value || "Solve the user's task carefully and return the best final answer.";
}

function resolveBudget(input: OptiLLMRuntimeInput, routedDifficulty?: WebOptiLLMDifficulty): WebOptiLLMBudget {
  if (input.budget) return input.budget;
  const difficulty = input.difficulty ?? routedDifficulty;
  if (difficulty === "easy") return "fast";
  if (difficulty === "hard") return "adaptive";
  return "adaptive";
}

function budgetLimits(budget: WebOptiLLMBudget): {
  bonMin: number;
  bonMax: number;
  scMin: number;
  scMax: number;
  marsMin: number;
  marsMax: number;
} {
  if (budget === "fast") return { bonMin: 2, bonMax: 2, scMin: 3, scMax: 3, marsMin: 2, marsMax: 2 };
  if (budget === "deep") return { bonMin: 3, bonMax: 5, scMin: 5, scMax: 7, marsMin: 3, marsMax: 3 };
  return { bonMin: 2, bonMax: 4, scMin: 3, scMax: 5, marsMin: 2, marsMax: 3 };
}

function canonicalAnswer(text: string): string {
  const boxed = [...text.matchAll(/\\boxed\s*\{([^{}]{1,200})\}/g)];
  if (boxed.length) return boxed[boxed.length - 1][1].trim().toLowerCase();

  const finalPatterns = [
    /(?:final answer|answer|答案|结果|所以|因此)\s*(?:is|=|:|：)?\s*([^\n]{1,120})/gi,
    /\b([A-D])\s*$/gi
  ];
  for (const pattern of finalPatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length) {
      return matches[matches.length - 1][1]
        .replace(/[\s*_$]+/g, " ")
        .replace(/[。.!]+$/g, "")
        .trim()
        .toLowerCase();
    }
  }

  const numbers = [...text.matchAll(/(?<![\w.])-?\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?/g)];
  if (numbers.length) return numbers[numbers.length - 1][0].trim().toLowerCase();

  const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? text;
  return last.replace(/[\s*_$]+/g, " ").replace(/[。.!]+$/g, "").trim().toLowerCase().slice(0, 160);
}

function consensusStats(responses: string[]): {
  keys: string[];
  winner: string;
  winnerCount: number;
  secondCount: number;
  representativeIndex: number;
} {
  const keys = responses.map(canonicalAnswer);
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const winner = ordered[0]?.[0] ?? "";
  return {
    keys,
    winner,
    winnerCount: ordered[0]?.[1] ?? 0,
    secondCount: ordered[1]?.[1] ?? 0,
    representativeIndex: Math.max(0, keys.findIndex((key) => key === winner))
  };
}

function guaranteedConsensus(responses: string[], maxSamples: number): boolean {
  if (!responses.length) return false;
  const stats = consensusStats(responses);
  const remaining = Math.max(0, maxSamples - responses.length);
  return stats.winnerCount > stats.secondCount + remaining;
}

function strongConsensus(responses: string[]): boolean {
  if (responses.length < 2) return false;
  const stats = consensusStats(responses);
  if (!stats.winner) return false;
  if (responses.length === 2) return stats.winnerCount === 2;
  return stats.winnerCount / responses.length >= 0.75;
}

function routeAuto(input: OptiLLMRuntimeInput, task: string): {
  difficulty: WebOptiLLMDifficulty;
  selected: Exclude<WebOptiLLMApproach, "auto">;
  reason: string;
} {
  if (input.strategy_hint) {
    return {
      difficulty: input.difficulty ?? "medium",
      selected: input.strategy_hint,
      reason: `webpage-model strategy_hint=${input.strategy_hint}`
    };
  }
  if (input.difficulty) {
    const selected = input.difficulty === "easy" ? "re2" : input.difficulty === "medium" ? "bon" : "mars";
    return {
      difficulty: input.difficulty,
      selected,
      reason: `webpage-model difficulty=${input.difficulty}`
    };
  }

  // Deterministic fallback only when the webpage model omitted difficulty.
  // Keep it conservative: short/simple prompts -> RE2, obviously long or proof-heavy -> MARS,
  // otherwise BoN. The preferred path is for the current webpage model to supply difficulty.
  const lower = task.toLowerCase();
  const hardMarkers = [
    "prove", "proof", "derive", "rigorous", "optimize", "counterexample", "theorem",
    "multi-step", "case analysis", "all possible", "necessary and sufficient",
    "证明", "推导", "严格", "反例", "定理", "分类讨论", "所有情况", "充要条件"
  ];
  const easyMarkers = [
    "what is", "define", "meaning of", "translate", "convert", "calculate",
    "是什么", "什么意思", "翻译", "换算", "计算"
  ];
  const hardHits = hardMarkers.filter((marker) => lower.includes(marker)).length;
  const easyHits = easyMarkers.filter((marker) => lower.includes(marker)).length;

  if (task.length >= 1200 || hardHits >= 2) {
    return { difficulty: "hard", selected: "mars", reason: "deterministic fallback: long/proof-heavy task" };
  }
  if (task.length <= 180 && easyHits > 0 && hardHits === 0) {
    return { difficulty: "easy", selected: "re2", reason: "deterministic fallback: short/simple task" };
  }
  return { difficulty: "medium", selected: "bon", reason: "deterministic fallback: medium complexity" };
}

function re2Directive(session: Re2Session): OptiLLMRuntimeResult {
  return {
    ok: true,
    action: "start",
    runtime_id: session.id,
    approach: "re2",
    status: "needs_model",
    stage: "answer",
    source_reference: "~/Agent_open/OptiLLM/optillm/reread.py",
    directive:
      "WEB-NATIVE RE2. Answer the supplied prompt using the current webpage model itself. " +
      "Do not call any backend model or Codex CLI. Think normally, then call optillm_runtime " +
      "action=submit with runtime_id and only the complete final answer in answer.",
    prompt: {
      system: session.systemPrompt,
      user: `${session.task}\nRead the question again: ${session.task}`
    }
  };
}

function bonGenerateDirective(session: BonSession): OptiLLMRuntimeResult {
  const index = session.candidates.length;
  return {
    ok: true,
    action: index === 0 ? "start" : "submit",
    runtime_id: session.id,
    approach: "bon",
    status: "needs_model",
    stage: "generate",
    candidate_index: index,
    candidate_number: index + 1,
    candidate_count: session.maxCandidates,
    min_candidates: session.minCandidates,
    max_candidates: session.maxCandidates,
    budget: session.budget,
    source_reference: "~/Agent_open/OptiLLM/optillm/bon.py",
    directive:
      `WEB-NATIVE adaptive BoN candidate ${index + 1}/${session.maxCandidates}. Solve the original task with the current webpage model. ` +
      "Treat this as a fresh candidate and do not merely copy a previous candidate. " +
      "Do not call any backend model or Codex CLI. After reasoning, call optillm_runtime action=submit " +
      "with runtime_id and the complete candidate answer in answer.",
    prompt: {
      system: session.systemPrompt,
      user: session.task
    }
  };
}

function bonJudgeDirective(session: BonSession): OptiLLMRuntimeResult {
  session.stage = "judge";
  session.judgeRounds += 1;
  const candidateText = session.candidates
    .map((candidate, index) => `Candidate ${index + 1}:\n${candidate}`)
    .join("\n\n");
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "bon",
    status: "needs_model",
    stage: "judge",
    judge_round: session.judgeRounds,
    candidate_count: session.candidates.length,
    max_candidates: session.maxCandidates,
    budget: session.budget,
    source_reference: "~/Agent_open/OptiLLM/optillm/bon.py",
    directive:
      "WEB-NATIVE adaptive BoN joint judge. Compare ALL candidates in one pass. " +
      "Call action=submit with selected_index (0-based), ratings[] (0-10 for every candidate), confidence (1-10), " +
      "and need_more=true only if the current candidates are too close/uncertain and another candidate would materially help.",
    prompt: {
      system:
        session.systemPrompt +
        "\nAct as a strict Best-of-N judge. Evaluate correctness first, then relevance, coherence, completeness, and helpfulness.",
      user:
        `Original task:\n${session.task}\n\n${candidateText}\n\n` +
        "Select the best candidate. Internally compare them carefully. Report one selected candidate, a 0-10 score for each, " +
        "a confidence from 1-10, and whether one more independent candidate is materially needed."
    },
    candidates: session.candidates
  };
}

function bonRateDirective(session: BonSession): OptiLLMRuntimeResult {
  const index = session.ratings.length;
  const candidate = session.candidates[index];
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "bon",
    status: "needs_model",
    stage: "rate",
    rating_index: index,
    rating_number: index + 1,
    rating_count: session.candidates.length,
    source_reference: "~/Agent_open/OptiLLM/optillm/bon.py",
    directive:
      `WEB-NATIVE BoN rating ${index + 1}/${session.candidates.length}. ` +
      "Using the current webpage model, rate ONLY the candidate below from 0 to 10. " +
      "Follow native OptiLLM criteria: relevance, coherence, and helpfulness. " +
      "Think internally, then call optillm_runtime action=submit with runtime_id and numeric rating only.",
    prompt: {
      system:
        session.systemPrompt +
        "\nRate the following response on a scale from 0 to 10, where 0 is poor and 10 is excellent. " +
        "Consider factors such as relevance, coherence, and helpfulness. Respond with only a number.",
      user: `Original task:\n${session.task}\n\nCandidate response:\n${candidate}\n\nRate the above response:`
    },
    candidate
  };
}

function marsExploreDirective(session: MarsSession): OptiLLMRuntimeResult {
  const index = session.solutions.length;
  const temp = MARS_TEMPERATURES[index];
  const effort = MARS_EFFORTS[index];
  return {
    ok: true,
    action: index === 0 ? "start" : "submit",
    runtime_id: session.id,
    approach: "mars",
    status: "needs_model",
    stage: "explore",
    agent_id: index,
    agent_number: index + 1,
    agent_count: session.maxAgents,
    min_agents: session.minAgents,
    max_agents: session.maxAgents,
    budget: session.budget,
    temperature_reference: temp,
    reasoning_effort_reference: effort,
    source_reference: "~/Agent_open/OptiLLM/optillm/mars/agent.py",
    directive:
      `WEB-MARS adaptive solver Agent ${index + 1}/${session.maxAgents}. Produce an independent solution using the current webpage model. ` +
      "Do not use, quote, compare, or infer previous agents' solutions. The temperature/effort values are " +
      "faithful role references from native MARS, not backend API settings. Do not call Codex CLI or any backend model. " +
      "Submit the complete candidate in answer.",
    prompt: {
      system: session.systemPrompt ? `${MARS_SYSTEM_PROMPT}\n\nAdditional system instruction:\n${session.systemPrompt}` : MARS_SYSTEM_PROMPT,
      user:
        `You are Agent ${index} in a collaborative reasoning system.\n\n` +
        "Your task: Solve the following problem independently, bringing your unique perspective and approach.\n\n" +
        `Temperature setting reference: ${temp} (${effort} exploration role)\n\nProblem: ${session.task}\n\n` +
        "Provide a complete solution with: initial analysis, step-by-step reasoning, verification of the answer, " +
        "and identification of assumptions or constraints."
    }
  };
}

function marsJointVerifyDirective(session: MarsSession): OptiLLMRuntimeResult {
  session.stage = "joint_verify";
  const candidateText = session.solutions
    .map((solution, index) => `Agent ${index + 1} solution:\n${solution}`)
    .join("\n\n");
  const consensus = consensusStats(session.solutions);
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "mars",
    status: "needs_model",
    stage: "joint_verify",
    agent_count: session.solutions.length,
    budget: session.budget,
    consensus_key: consensus.winner,
    consensus_count: consensus.winnerCount,
    source_reference: "~/Agent_open/OptiLLM/optillm/mars/prompts.py",
    directive:
      "WEB-MARS adaptive joint verifier. Compare and verify ALL solver candidates in one pass, then produce the best corrected final answer. " +
      "Call action=submit with answer=the complete final answer, assessment (CORRECT/INCORRECT/INCOMPLETE), confidence 1-10, " +
      "selected_index (0-based best source candidate), report, issues[], and need_more=true only if another independent solver is materially needed.",
    prompt: {
      system: MARS_SYSTEM_PROMPT,
      user:
        `Original Problem:\n${session.task}\n\n${candidateText}\n\n` +
        "Act as a strict joint verifier and synthesizer. Compare the candidates directly, check computations and logic, resolve disagreements, " +
        "and produce one self-contained corrected final answer. Also judge whether the current evidence is sufficient or another independent solver is materially needed."
    },
    candidates: session.solutions
  };
}

function marsVerifyDirective(session: MarsSession): OptiLLMRuntimeResult {
  const index = session.verifications.length;
  const solution = session.solutions[index];
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "mars",
    status: "needs_model",
    stage: "verify",
    solution_index: index,
    solution_number: index + 1,
    solution_count: session.solutions.length,
    source_reference: "~/Agent_open/OptiLLM/optillm/mars/prompts.py",
    directive:
      `WEB-MARS verification ${index + 1}/${session.solutions.length}. Rigorously verify only this candidate. ` +
      "Return your internal verification judgment to CC by calling action=submit with assessment " +
      "(CORRECT/INCORRECT/INCOMPLETE), confidence 1-10, a concise report, and issues[]. " +
      "Do not call any backend model or Codex CLI.",
    prompt: {
      system: MARS_SYSTEM_PROMPT,
      user:
        "You are a verification expert. Rigorously verify the correctness of the proposed solution.\n\n" +
        `Original Problem: ${session.task}\n\nProposed Solution:\n${solution}\n\n` +
        "Check logical consistency, computations, completeness, gaps/errors, and the final answer. " +
        "Determine an overall assessment (CORRECT/INCORRECT/INCOMPLETE), confidence 1-10, " +
        "specific issues, and suggestions for improvement."
    },
    candidate: solution
  };
}

function marsImproveDirective(session: MarsSession): OptiLLMRuntimeResult {
  const solutionIndex = session.improvementQueue[session.improveCursor];
  const verification = session.verifications[solutionIndex] ?? session.jointVerification ?? {
    assessment: "INCOMPLETE" as MarsAssessment,
    confidence: 5,
    report: "Improve the selected candidate using the joint verifier feedback.",
    issues: []
  };
  const currentSolution = session.solutions[solutionIndex];
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "mars",
    status: "needs_model",
    stage: "improve",
    solution_index: solutionIndex,
    improvement_number: session.improveCursor + 1,
    improvement_count: session.improvementQueue.length,
    source_reference: "~/Agent_open/OptiLLM/optillm/mars/prompts.py",
    directive:
      "WEB-MARS improvement. Improve the candidate using the verification feedback with the current webpage model. " +
      "Preserve correct elements, fix errors/gaps, and submit the complete improved solution in answer. " +
      "Do not call any backend model or Codex CLI.",
    prompt: {
      system: MARS_SYSTEM_PROMPT,
      user:
        `Original Problem: ${session.task}\n\nCurrent Solution:\n${currentSolution}\n\n` +
        `Verification Feedback:\n${verification.report}\n\nIssues to Address:\n` +
        (verification.issues.length ? verification.issues.map((x) => `- ${x}`).join("\n") : "- No explicit issue list; address the verifier assessment.") +
        "\n\nProvide an improved solution that addresses all identified concerns while preserving correct elements."
    }
  };
}

function marsSynthesisDirective(session: MarsSession): OptiLLMRuntimeResult {
  const finalSolutions = session.solutions.map((solution, index) => session.improvements[index] ?? solution);
  const agentSolutions = finalSolutions
    .map((solution, index) => `Agent ${index} solution:\n${solution}`)
    .join("\n\n");
  const verificationResults = session.verifications.length
    ? session.verifications
        .map(
          (v, index) =>
            `Agent ${index}: assessment=${v.assessment}, confidence=${v.confidence}/10\n` +
            `Report: ${v.report}\nIssues: ${v.issues.length ? v.issues.join("; ") : "none"}`
        )
        .join("\n\n")
    : session.jointVerification
      ? `Joint verification: assessment=${session.jointVerification.assessment}, confidence=${session.jointVerification.confidence}/10\n` +
        `Report: ${session.jointVerification.report}\nIssues: ${session.jointVerification.issues.length ? session.jointVerification.issues.join("; ") : "none"}`
      : "No explicit verification record.";

  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "mars",
    status: "needs_model",
    stage: "synthesize",
    source_reference: "~/Agent_open/OptiLLM/optillm/mars/prompts.py",
    directive:
      "WEB-MARS final synthesis. Using the current webpage model, synthesize the best final answer from all candidates " +
      "and verification results. Submit the complete self-contained final answer in answer. Do not call any backend model or Codex CLI.",
    prompt: {
      system: MARS_SYSTEM_PROMPT,
      user:
        "You are tasked with synthesizing multiple solution attempts into a final, optimal solution.\n\n" +
        `Original Problem: ${session.task}\n\nAgent Solutions:\n${agentSolutions}\n\nVerification Results:\n${verificationResults}\n\n` +
        "Analyze all solutions and verification results, identify the strongest correct elements, resolve disagreements, " +
        "and produce one rigorous, complete, self-contained final solution. If multiple agents extracted the same final answer, " +
        "give that agreement appropriate weight but still check correctness."
    },
    candidates: finalSolutions,
    verifications: session.verifications
  };
}


function extendedModelStep(
  session: ExtendedSession,
  stage: string,
  user: string,
  directive: string,
  sourceReference: string,
  extra: Record<string, unknown> = {}
): OptiLLMRuntimeResult {
  session.stage = stage;
  return {
    ok: true,
    action: session.items.length === 0 && Object.keys(session.data).length === 0 ? "start" : "submit",
    runtime_id: session.id,
    approach: session.approach,
    status: "needs_model",
    stage,
    directive,
    prompt: { system: session.systemPrompt, user },
    source_reference: sourceReference,
    ...extra
  };
}

function completeExtended(session: ExtendedSession, result: string, fidelity: string): OptiLLMRuntimeResult {
  session.result = result;
  session.stage = "done";
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: session.approach,
    status: "complete",
    stage: "done",
    result,
    fidelity,
    provider_calls: 0,
    backend_model_calls: 0,
    execution_engine: "current_webpage_model"
  };
}

function normalizeForSimilarity(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenJaccard(a: string, b: string): number {
  const aa = new Set(normalizeForSimilarity(a));
  const bb = new Set(normalizeForSimilarity(b));
  if (!aa.size && !bb.size) return 1;
  let inter = 0;
  for (const token of aa) if (bb.has(token)) inter += 1;
  return inter / Math.max(1, aa.size + bb.size - inter);
}

function selfConsistencyRepresentative(responses: string[], threshold = 0.8): { result: string; cluster_sizes: number[] } {
  const clusters: string[][] = [];
  for (const response of responses) {
    let placed = false;
    for (const cluster of clusters) {
      if (tokenJaccard(response, cluster[0]) >= threshold) {
        cluster.push(response);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([response]);
  }
  clusters.sort((a, b) => b.length - a.length);
  return {
    result: clusters[0]?.[0] ?? "No consistent answer found.",
    cluster_sizes: clusters.map((cluster) => cluster.length)
  };
}

function extractCodeBlock(text: string): string {
  const match = text.match(/```(?:[\w-]+)?\s*\n?([\s\S]*?)```/);
  return (match?.[1] ?? text).trim();
}

function extractJsonArray(text: string): any[] {
  const cleaned = text
    .replace(/<output>/gi, "")
    .replace(/<\/output>/gi, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function executeNativeZ3(code: string): string {
  const home = process.env.HOME || homedir();
  const python = process.env.CODEXPRO_OPTILLM_PYTHON || `${home}/.local/share/codexpro-optillm-py/bin/python`;
  const optillmRoot = process.env.CODEXPRO_OPTILLM_ROOT || `${home}/Agent_open/OptiLLM`;
  const runner = [
    "import os, sys, types, importlib.util",
    "root=os.environ.get('CODEXPRO_OPTILLM_ROOT') or os.path.expanduser('~/Agent_open/OptiLLM')",
    "stub=types.ModuleType('optillm')",
    "stub.conversation_logger=None",
    "sys.modules['optillm']=stub",
    "spec=importlib.util.spec_from_file_location('optillm_z3_solver', os.path.join(root, 'optillm', 'z3_solver.py'))",
    "mod=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "status, result = mod.execute_code_in_process(sys.stdin.read())",
    "print(result if status == 'success' else 'Error: ' + result)"
  ].join("\n");
  const proc = spawnSync(python, ["-c", runner], {
    input: code,
    encoding: "utf8",
    timeout: 35000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, CODEXPRO_OPTILLM_ROOT: optillmRoot }
  });
  if (proc.error) return `Error: ${proc.error.message}`;
  const stderr = String(proc.stderr ?? "").trim();
  const stdout = String(proc.stdout ?? "").trim();
  if (proc.status !== 0) return `Error: ${stderr || `solver exited ${proc.status}`}`;
  return stdout || (stderr ? `Error: ${stderr}` : "Error: solver produced no output");
}

function startExtended(session: ExtendedSession): OptiLLMRuntimeResult {
  const source = `~/Agent_open/OptiLLM/optillm/${session.approach === "cepo" ? "cepo/" : session.approach + ".py"}`;

  if (session.approach === "cot_reflection") {
    return extendedModelStep(
      session,
      "reflect",
      `Query: ${session.task}\n\nSolve the query carefully. Reason step by step privately, then critically reflect on your reasoning for errors, omissions, edge cases, and possible improvements. Make any necessary corrections. Return only the polished final answer; do not expose private chain-of-thought.`,
      "WEB-NATIVE CoT Reflection: solve, privately reflect, correct, and submit only the final answer in answer.",
      source
    );
  }

  if (session.approach === "self_consistency") {
    return extendedModelStep(
      session,
      "sample",
      session.task,
      `WEB-NATIVE adaptive Self-Consistency sample 1/${session.n}. Solve independently. Submit the complete candidate in answer. Do not copy prior samples. The controller may stop early once consensus is decisive.`,
      source,
      { sample_number: 1, sample_count: session.n, min_samples: session.data.minSamples, max_samples: session.data.maxSamples, budget: session.budget }
    );
  }

  if (session.approach === "plansearch") {
    if (session.budget === "fast") {
      return extendedModelStep(
        session,
        "fast_plan",
        `You are an expert problem solver/programmer. For the task below, privately generate several non-obvious observations and derived insights, then directly produce a rigorous natural-language implementation/solution plan. Do not emit final code yet.\n\nTask:\n${session.task}`,
        "WEB-NATIVE fast PlanSearch: fused observation+derived-observation+planning. Submit the plan in answer.",
        source,
        { budget: session.budget, planned_rounds: 2 }
      );
    }
    if (session.budget === "adaptive") {
      return extendedModelStep(
        session,
        "discover",
        `You are an expert problem solver/programmer. Given the task below, provide 3 useful, non-obvious, correct observations, then derive 2 additional insights from them. Do not write final code yet.\n\nTask:\n${session.task}`,
        "WEB-NATIVE adaptive PlanSearch: fused observation + derived-observation discovery. Submit all discoveries in answer.",
        source,
        { budget: session.budget, planned_rounds: 3 }
      );
    }
    return extendedModelStep(
      session,
      "observations",
      `You are an expert problem solver/programmer. Given the problem below, provide 3 useful, non-obvious, correct observations or hints. Do not write code yet.\n\nProblem:\n${session.task}`,
      "WEB-NATIVE deep PlanSearch observation generation. Submit the observations in answer.",
      source,
      { budget: session.budget, planned_rounds: 4 }
    );
  }

  if (session.approach === "z3") {
    return extendedModelStep(
      session,
      "formulate",
      `Analyze the query and determine whether Z3 or SymPy can solve it. Identify variables, constraints, objectives, and problem type. If applicable, provide executable Python code using only z3 and/or sympy. The code must print the useful solver result.\n\nQuery: ${session.task}\n\nRespond in this format:\nSOLVER_CAN_BE_APPLIED: True/False\nSOLVER_FORMULATION:\n\`\`\`python\n# code\n\`\`\`\nAnalysis: concise explanation.`,
      "WEB-NATIVE Z3 formulation. The current webpage model formulates; CC will execute the native local Z3/SymPy solver. Submit the full formulation in answer.",
      "~/Agent_open/OptiLLM/optillm/z3_solver.py"
    );
  }

  if (session.approach === "rto") {
    return extendedModelStep(
      session,
      "code1",
      session.task,
      "WEB-NATIVE RTO C1: generate the requested code/implementation. Submit the complete code response in answer.",
      source
    );
  }

  if (session.approach === "leap") {
    return extendedModelStep(
      session,
      "extract_examples",
      `Analyze the query below and determine whether it contains few-shot examples with known answers. Return ONLY a JSON array of objects with "question" and "answer" fields. If there are no examples, return [].\n\nQuery:\n${session.task}`,
      "WEB-NATIVE LEAP: extract few-shot examples. Submit the JSON array in answer.",
      source
    );
  }

  if (session.approach === "moa") {
    return extendedModelStep(
      session,
      "candidate",
      session.task,
      `WEB-NATIVE adaptive MoA candidate 1/${session.data.maxCandidates}. Solve independently and submit the complete candidate in answer.`,
      source,
      { candidate_number: 1, candidate_count: session.data.maxCandidates, min_candidates: session.data.minCandidates, budget: session.budget }
    );
  }

  return extendedModelStep(
    session,
    "proposal",
    `Create a detailed step-by-step plan for the task, state confidence/risks for important steps, then produce an initial solution using that plan.\n\nTask:\n${session.task}`,
    `WEB-NATIVE adaptive CePO proposal 1/${session.data.maxProposals}. Submit the plan + initial solution in answer.`,
    "~/Agent_open/OptiLLM/optillm/cepo/cepo.py",
    { proposal_number: 1, proposal_count: session.data.maxProposals, min_proposals: session.data.minProposals, budget: session.budget }
  );
}

function submitExtended(session: ExtendedSession, input: OptiLLMRuntimeInput): OptiLLMRuntimeResult {
  const answer = String(input.answer ?? "").trim();
  const source = `~/Agent_open/OptiLLM/optillm/${session.approach === "cepo" ? "cepo/cepo.py" : session.approach + ".py"}`;

  if (session.approach === "cot_reflection") {
    if (!answer) throw new Error("CoT Reflection submit requires answer");
    return completeExtended(session, answer, "web-native-cot-reflection");
  }

  if (session.approach === "self_consistency") {
    if (!answer) throw new Error("Self-Consistency submit requires answer");
    session.items.push(answer);
    const minSamples = Number(session.data.minSamples ?? Math.min(3, session.n));
    const maxSamples = Number(session.data.maxSamples ?? session.n);
    const stats = consensusStats(session.items);
    const allAgree = session.items.length >= minSamples && stats.winnerCount === session.items.length;
    const locked = session.items.length >= minSamples && guaranteedConsensus(session.items, maxSamples);
    const exhausted = session.items.length >= maxSamples;

    if (allAgree || locked || exhausted) {
      const result = session.items[stats.representativeIndex] ?? session.items[0] ?? "No consistent answer found.";
      const done = completeExtended(session, result, "web-native-self-consistency-adaptive");
      return {
        ...done,
        samples: session.items,
        samples_used: session.items.length,
        min_samples: minSamples,
        max_samples: maxSamples,
        canonical_answers: stats.keys,
        consensus_answer: stats.winner,
        consensus_count: stats.winnerCount,
        early_exit: !exhausted,
        early_exit_reason: allAgree ? "unanimous_consensus" : locked ? "mathematically_locked_majority" : "max_samples_reached"
      };
    }

    return extendedModelStep(
      session,
      "sample",
      session.task,
      `WEB-NATIVE adaptive Self-Consistency sample ${session.items.length + 1}/${maxSamples}. Solve independently. Do not use or quote earlier samples. Submit the complete candidate in answer.`,
      source,
      {
        sample_number: session.items.length + 1,
        sample_count: maxSamples,
        min_samples: minSamples,
        max_samples: maxSamples,
        canonical_answers_so_far: stats.keys,
        consensus_count: stats.winnerCount,
        budget: session.budget
      }
    );
  }

  if (session.approach === "plansearch") {
    if (!answer) throw new Error("PlanSearch submit requires answer");

    if (session.stage === "fast_plan") {
      session.data.solution = answer;
      return extendedModelStep(
        session,
        "implement",
        `Original problem/task:\n${session.task}\n\nFused observation-derived plan:\n${answer}\n\nProduce the final implementation or final answer that follows this plan. If code is requested, return the complete code.`,
        "WEB-NATIVE fast PlanSearch finalization. Submit the final result in answer.",
        source,
        { budget: session.budget, round_number: 2 }
      );
    }

    if (session.stage === "discover") {
      session.data.observations = answer;
      return extendedModelStep(
        session,
        "solution",
        `Problem:\n${session.task}\n\nObservations and derived insights:\n${answer}\n\nUse these discoveries to create a rigorous natural-language solution/implementation plan. For programming tasks, do not emit final code yet.`,
        "WEB-NATIVE adaptive PlanSearch solution planning. Submit the natural-language solution in answer.",
        source,
        { budget: session.budget, round_number: 2 }
      );
    }

    if (session.stage === "observations") {
      session.data.observations = answer;
      return extendedModelStep(
        session,
        "derived",
        `Problem:\n${session.task}\n\nExisting observations:\n${answer}\n\nDerive 2 new, useful, correct observations from these. Do not write code.`,
        "WEB-NATIVE deep PlanSearch derived observations. Submit them in answer.",
        source
      );
    }
    if (session.stage === "derived") {
      session.data.derived = answer;
      return extendedModelStep(
        session,
        "solution",
        `Problem:\n${session.task}\n\nObservations:\n${session.data.observations}\n\nDerived observations:\n${answer}\n\nUse these observations to create a rigorous natural-language solution/implementation plan. For programming tasks, do not emit final code yet.`,
        "WEB-NATIVE deep PlanSearch solution planning. Submit the natural-language solution in answer.",
        source
      );
    }
    if (session.stage === "solution") {
      session.data.solution = answer;
      return extendedModelStep(
        session,
        "implement",
        `Original problem/task:\n${session.task}\n\nValidated plan/solution:\n${answer}\n\nProduce the final implementation or final answer that follows this plan. If code is requested, return the complete code.`,
        "WEB-NATIVE PlanSearch implementation/finalization. Submit the final result in answer.",
        source
      );
    }
    const done = completeExtended(session, answer, `web-native-plansearch-${session.budget}`);
    return { ...done, budget: session.budget };
  }

  if (session.approach === "z3") {
    if (!answer) throw new Error("Z3 submit requires answer");
    if (session.stage === "formulate" || session.stage === "repair") {
      session.data.analysis = answer;
      if (/SOLVER_CAN_BE_APPLIED:\s*False/i.test(answer)) {
        return extendedModelStep(
          session,
          "fallback",
          session.task,
          "Native Z3 analysis says the solver is not applicable. Solve directly with the current webpage model and submit the final answer.",
          "~/Agent_open/OptiLLM/optillm/z3_solver.py"
        );
      }
      const code = extractCodeBlock(answer);
      const solverOutput = executeNativeZ3(code);
      session.data.code = code;
      session.data.solver_output = solverOutput;
      if (solverOutput.startsWith("Error:")) {
        const attempts = Number(session.data.repair_attempts ?? 0);
        if (attempts < 2) {
          session.data.repair_attempts = attempts + 1;
          return extendedModelStep(
            session,
            "repair",
            `Fix this Z3/SymPy formulation. Use only z3 and/or sympy and print the useful result.\n\nOriginal task:\n${session.task}\n\nCode:\n\`\`\`python\n${code}\n\`\`\`\n\nExecution error:\n${solverOutput}\n\nReturn corrected executable Python in a code block plus a concise note.`,
            "WEB-NATIVE Z3 repair: correct the formulation after a real local solver error. Submit the corrected formulation in answer.",
            "~/Agent_open/OptiLLM/optillm/z3_solver.py",
            { solver_error: solverOutput, repair_attempt: attempts + 1 }
          );
        }
        return extendedModelStep(
          session,
          "fallback",
          session.task,
          "Native Z3/SymPy failed after repair attempts. Solve directly with the current webpage model and submit the final answer.",
          "~/Agent_open/OptiLLM/optillm/z3_solver.py",
          { solver_error: solverOutput }
        );
      }
      return extendedModelStep(
        session,
        "explain",
        `Provide a clear final answer to the original query using the formulation and REAL local solver output below.\n\nQuery:\n${session.task}\n\nFormulation/analysis:\n${answer}\n\nSolver output:\n${solverOutput}`,
        "WEB-NATIVE Z3 final response. Explain the real local solver result and submit the final answer.",
        "~/Agent_open/OptiLLM/optillm/z3_solver.py",
        { solver_output: solverOutput }
      );
    }
    return completeExtended(session, answer, session.stage === "fallback" ? "web-native-z3-fallback" : "web-native-z3");
  }

  if (session.approach === "rto") {
    if (!answer) throw new Error("RTO submit requires answer");
    if (session.stage === "code1") {
      session.data.code1 = extractCodeBlock(answer);
      return extendedModelStep(
        session,
        "describe",
        `Summarize or describe the code you just created as an instruction such that, given only the instruction, another implementation can be recreated.\n\nCode:\n\`\`\`\n${session.data.code1}\n\`\`\``,
        "WEB-NATIVE RTO Q2: describe C1 as a reconstruction instruction. Submit the instruction in answer.",
        source
      );
    }
    if (session.stage === "describe") {
      session.data.description = answer;
      return extendedModelStep(
        session,
        "code2",
        answer,
        "WEB-NATIVE RTO C2: regenerate the implementation from the reconstructed instruction only. Submit complete code in answer.",
        source
      );
    }
    if (session.stage === "code2") {
      session.data.code2 = extractCodeBlock(answer);
      const c1 = String(session.data.code1 ?? "").trim();
      const c2 = String(session.data.code2 ?? "").trim();
      if (c1 === c2) return completeExtended(session, c1, "web-native-rto");
      return extendedModelStep(
        session,
        "final",
        `Initial query:\n${session.task}\n\nFirst implementation C1:\n\`\`\`\n${c1}\n\`\`\`\n\nSecond implementation C2:\n\`\`\`\n${c2}\n\`\`\`\n\nGenerate a final optimized implementation resolving any discrepancy. Return only the final code/result.`,
        "WEB-NATIVE RTO C3: reconcile C1 and C2. Submit the final optimized implementation in answer.",
        source
      );
    }
    return completeExtended(session, extractCodeBlock(answer), "web-native-rto");
  }

  if (session.approach === "leap") {
    if (!answer) throw new Error("LEAP submit requires answer");
    if (session.stage === "extract_examples") {
      const examples = extractJsonArray(answer);
      session.data.examples = examples;
      if (!examples.length) {
        return extendedModelStep(
          session,
          "apply",
          session.task,
          "WEB-NATIVE LEAP found no usable few-shot examples. Answer directly and submit the final answer.",
          source
        );
      }
      return extendedModelStep(
        session,
        "mistakes",
        `For each few-shot example below, intentionally construct one plausible but incorrect reasoning path and identify its wrong final answer. This is diagnostic: do not alter the known correct answer. Return a compact structured list.\n\nExamples:\n${JSON.stringify(examples, null, 2)}`,
        "WEB-NATIVE LEAP diagnostic mistake generation. Submit the structured mistakes in answer.",
        source
      );
    }
    if (session.stage === "mistakes") {
      session.data.mistakes = answer;
      return extendedModelStep(
        session,
        "principles",
        `Known examples:\n${JSON.stringify(session.data.examples, null, 2)}\n\nDiagnostic wrong reasoning:\n${answer}\n\nDerive up to 8 general, non-redundant principles that explain how to avoid these mistakes and solve the task family correctly. Return only the principles.`,
        "WEB-NATIVE LEAP principle induction. Submit the learned principles in answer.",
        source
      );
    }
    if (session.stage === "principles") {
      session.data.principles = answer;
      return extendedModelStep(
        session,
        "apply",
        `Apply these learned principles to the original query.\n\nPrinciples:\n${answer}\n\nOriginal query:\n${session.task}\n\nReturn the best final answer.`,
        "WEB-NATIVE LEAP apply learned principles. Submit the final answer.",
        source
      );
    }
    return completeExtended(session, answer, "web-leap-lite");
  }

  if (session.approach === "moa") {
    if (!answer) throw new Error("MoA submit requires answer");
    if (session.stage === "candidate") {
      session.items.push(answer);
      const minCandidates = Number(session.data.minCandidates ?? 2);
      const maxCandidates = Number(session.data.maxCandidates ?? 3);
      if (session.items.length < minCandidates || (session.items.length < maxCandidates && !strongConsensus(session.items))) {
        return extendedModelStep(
          session,
          "candidate",
          session.task,
          `WEB-NATIVE adaptive MoA candidate ${session.items.length + 1}/${maxCandidates}. Solve independently and do not copy prior candidates. Submit the complete candidate in answer.`,
          source,
          { candidate_number: session.items.length + 1, candidate_count: maxCandidates, min_candidates: minCandidates, budget: session.budget }
        );
      }

      const candidateText = session.items.map((item, index) => `Candidate ${index + 1}:\n${item}`).join("\n\n");
      if (session.budget !== "deep") {
        return extendedModelStep(
          session,
          "finalize",
          `Original query:\n${session.task}\n\n${candidateText}\n\nPrivately critique each candidate for correctness, strengths, weaknesses, and missing details, then directly synthesize one final optimized response. Return only the final response.`,
          "WEB-NATIVE adaptive MoA fused critique+synthesis. Submit the final response in answer.",
          source,
          {
            candidates_used: session.items.length,
            max_candidates: maxCandidates,
            early_consensus: strongConsensus(session.items),
            budget: session.budget
          }
        );
      }

      return extendedModelStep(
        session,
        "critique",
        `Original query:\n${session.task}\n\n${candidateText}\n\nAnalyze and critique each candidate separately, including strengths, weaknesses, correctness, and missing details.`,
        "WEB-NATIVE deep MoA critique. Submit the critique of all candidates in answer.",
        source
      );
    }
    if (session.stage === "critique") {
      session.data.critique = answer;
      const candidateText = session.items.map((item, index) => `Candidate ${index + 1}:\n${item}`).join("\n\n");
      return extendedModelStep(
        session,
        "synthesize",
        `Original query:\n${session.task}\n\n${candidateText}\n\nCritiques:\n${answer}\n\nGenerate one final optimized response using the strongest correct parts and fixing the weaknesses.`,
        "WEB-NATIVE deep MoA synthesis. Submit the final response in answer.",
        source
      );
    }
    const done = completeExtended(session, answer, session.budget === "deep" ? "web-native-moa-deep" : "web-native-moa-adaptive-fused");
    return {
      ...done,
      candidates_used: session.items.length,
      max_candidates: session.data.maxCandidates,
      budget: session.budget,
      early_exit: session.items.length < Number(session.data.maxCandidates ?? 3)
    };
  }

  if (!answer) throw new Error("CePO submit requires answer");
  if (session.stage === "proposal") {
    session.items.push(answer);
    const minProposals = Number(session.data.minProposals ?? 2);
    const maxProposals = Number(session.data.maxProposals ?? 3);
    const divergent = session.items.length >= 2 && tokenJaccard(session.items[0], session.items[1]) < 0.45;
    const shouldExpand = session.items.length < minProposals ||
      (session.budget === "deep" && session.items.length < maxProposals) ||
      (session.budget === "adaptive" && divergent && session.items.length < maxProposals);

    if (shouldExpand) {
      return extendedModelStep(
        session,
        "proposal",
        `Create a DIFFERENT detailed step-by-step plan for the task, state confidence/risks for important steps, then produce an initial solution using that plan.\n\nTask:\n${session.task}`,
        `WEB-NATIVE adaptive CePO proposal ${session.items.length + 1}/${maxProposals}. Submit the plan + initial solution in answer.`,
        source,
        {
          proposal_number: session.items.length + 1,
          proposal_count: maxProposals,
          min_proposals: minProposals,
          divergence_detected: divergent,
          budget: session.budget
        }
      );
    }

    const proposalText = session.items.map((item, index) => `Proposal ${index + 1}:\n${item}`).join("\n\n");
    return extendedModelStep(
      session,
      "refine_plan",
      `Original task:\n${session.task}\n\n${proposalText}\n\nReview all proposals, identify inconsistencies and weak steps, and construct one refined final step-by-step plan. Do not merely vote; combine or replace ideas as needed.`,
      "WEB-NATIVE adaptive CePO plan refinement. Submit the refined plan in answer.",
      source,
      {
        proposals_used: session.items.length,
        max_proposals: maxProposals,
        budget: session.budget,
        early_exit: session.items.length < maxProposals
      }
    );
  }
  if (session.stage === "refine_plan") {
    session.data.refined_plan = answer;
    return extendedModelStep(
      session,
      "final",
      `Original task:\n${session.task}\n\nRefined plan:\n${answer}\n\nProduce the final answer by executing this refined plan carefully. Verify the result before finishing.`,
      "WEB-NATIVE adaptive CePO final solution. Submit the final answer.",
      source
    );
  }
  const done = completeExtended(session, answer, "web-cepo-adaptive");
  return {
    ...done,
    proposals_used: session.items.length,
    max_proposals: session.data.maxProposals,
    budget: session.budget,
    early_exit: session.items.length < Number(session.data.maxProposals ?? 3)
  };
}

function start(input: OptiLLMRuntimeInput): OptiLLMRuntimeResult {
  cleanSessions();
  const requestedApproach = input.approach ?? "auto";
  const supportedApproaches: WebOptiLLMApproach[] = ["auto", "re2", "bon", "mars", "cot_reflection", "self_consistency", "plansearch", "z3", "rto", "leap", "moa", "cepo"];
  if (!supportedApproaches.includes(requestedApproach)) {
    throw new Error(`Unsupported web-native OptiLLM approach: ${requestedApproach}`);
  }

  const task = requireTask(input);
  const route = requestedApproach === "auto"
    ? routeAuto(input, task)
    : {
        difficulty: input.difficulty,
        selected: requestedApproach as Exclude<WebOptiLLMApproach, "auto">,
        reason: "explicit approach override"
      };
  const approach = route.selected;
  const budget = resolveBudget(input, route.difficulty);
  const limits = budgetLimits(budget);
  const id = "ow_" + randomUUID().replace(/-/g, "").slice(0, 20);
  const systemPrompt = defaultSystemPrompt(input);

  const withRoute = (result: OptiLLMRuntimeResult): OptiLLMRuntimeResult => ({
    ...result,
    requested_approach: requestedApproach,
    auto_difficulty: requestedApproach === "auto" ? route.difficulty : undefined,
    auto_selected_approach: requestedApproach === "auto" ? approach : undefined,
    routing_reason: route.reason,
    budget
  });

  if (approach === "re2") {
    const session: Re2Session = { id, approach, task, systemPrompt, stage: "answer", createdAt: Date.now() };
    sessions.set(id, session);
    return withRoute(re2Directive(session));
  }

  if (approach === "bon") {
    const requestedN = Number(input.n ?? limits.bonMax);
    const maxCandidates = Math.max(limits.bonMin, Math.min(Number.isFinite(requestedN) ? Math.floor(requestedN) : limits.bonMax, 8));
    const minCandidates = Math.min(limits.bonMin, maxCandidates);
    const session: BonSession = {
      id,
      approach,
      task,
      systemPrompt,
      n: maxCandidates,
      budget,
      minCandidates,
      maxCandidates,
      stage: "generate",
      candidates: [],
      ratings: [],
      judgeRounds: 0,
      createdAt: Date.now()
    };
    sessions.set(id, session);
    return withRoute(bonGenerateDirective(session));
  }

  if (approach === "mars") {
    const session: MarsSession = {
      id,
      approach,
      task,
      systemPrompt,
      budget,
      minAgents: limits.marsMin,
      maxAgents: limits.marsMax,
      stage: "explore",
      solutions: [],
      verifications: [],
      improvementQueue: [],
      improvements: {},
      improveCursor: 0,
      createdAt: Date.now()
    };
    sessions.set(id, session);
    return withRoute(marsExploreDirective(session));
  }

  const defaultN = approach === "self_consistency" ? limits.scMax : 3;
  const requestedN = Number(input.n ?? defaultN);
  const n = Math.max(2, Math.min(Number.isFinite(requestedN) ? Math.floor(requestedN) : defaultN, 8));
  const session: ExtendedSession = {
    id,
    approach: approach as ExtendedApproach,
    task,
    systemPrompt,
    stage: "init",
    n,
    budget,
    items: [],
    data: approach === "self_consistency"
      ? { minSamples: Math.min(limits.scMin, n), maxSamples: n }
      : approach === "moa"
        ? { minCandidates: budget === "deep" ? 3 : 2, maxCandidates: 3 }
        : approach === "cepo"
          ? { minProposals: budget === "deep" ? 3 : 2, maxProposals: 3 }
          : {},
    createdAt: Date.now()
  };
  sessions.set(id, session);
  return withRoute(startExtended(session));
}

function submitRe2(session: Re2Session, input: OptiLLMRuntimeInput): OptiLLMRuntimeResult {
  if (session.stage === "done") {
    return {
      ok: true,
      action: "submit",
      runtime_id: session.id,
      approach: "re2",
      status: "complete",
      stage: "done",
      result: session.answer,
      source_reference: "~/Agent_open/OptiLLM/optillm/reread.py"
    };
  }
  const answer = String(input.answer ?? "").trim();
  if (!answer) throw new Error("RE2 submit requires answer");
  session.answer = answer;
  session.stage = "done";
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "re2",
    status: "complete",
    stage: "done",
    result: answer,
    source_reference: "~/Agent_open/OptiLLM/optillm/reread.py",
    provider_calls: 0,
    backend_model_calls: 0,
    execution_engine: "current_webpage_model"
  };
}

function submitBon(session: BonSession, input: OptiLLMRuntimeInput): OptiLLMRuntimeResult {
  if (session.stage === "generate") {
    const answer = String(input.answer ?? "").trim();
    if (!answer) throw new Error("BoN candidate submit requires answer");
    session.candidates.push(answer);
    if (session.candidates.length < session.minCandidates) return bonGenerateDirective(session);
    return bonJudgeDirective(session);
  }

  if (session.stage === "judge") {
    const providedRatings = Array.isArray(input.ratings)
      ? input.ratings.map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x <= 10)
      : [];
    if (providedRatings.length === session.candidates.length) session.ratings = providedRatings;

    let selectedIndex = Number(input.selected_index);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= session.candidates.length) {
      if (session.ratings.length === session.candidates.length) {
        selectedIndex = 0;
        for (let i = 1; i < session.ratings.length; i += 1) {
          if (session.ratings[i] > session.ratings[selectedIndex]) selectedIndex = i;
        }
      } else if (strongConsensus(session.candidates)) {
        selectedIndex = consensusStats(session.candidates).representativeIndex;
      } else {
        throw new Error("BoN joint judge submit requires selected_index, or a complete ratings[] array");
      }
    }

    const confidence = Number(input.confidence);
    const threshold = session.budget === "deep" ? 8 : session.budget === "adaptive" ? 7 : 5;
    const lowConfidence = Number.isFinite(confidence) ? confidence < threshold : false;
    const wantsMore = input.need_more === true || lowConfidence;

    if (wantsMore && session.candidates.length < session.maxCandidates) {
      session.stage = "generate";
      return bonGenerateDirective(session);
    }

    session.stage = "done";
    return {
      ok: true,
      action: "submit",
      runtime_id: session.id,
      approach: "bon",
      status: "complete",
      stage: "done",
      result: session.candidates[selectedIndex],
      selected_index: selectedIndex,
      selected_candidate_number: selectedIndex + 1,
      candidates: session.candidates,
      ratings: session.ratings,
      confidence: Number.isFinite(confidence) ? confidence : undefined,
      candidates_used: session.candidates.length,
      min_candidates: session.minCandidates,
      max_candidates: session.maxCandidates,
      judge_rounds: session.judgeRounds,
      early_exit: session.candidates.length < session.maxCandidates,
      early_exit_reason: session.candidates.length < session.maxCandidates ? "joint_judge_confident" : "max_candidates_reached",
      budget: session.budget,
      source_reference: "~/Agent_open/OptiLLM/optillm/bon.py",
      fidelity: "web-native-bon-adaptive-joint-judge",
      provider_calls: 0,
      backend_model_calls: 0,
      execution_engine: "current_webpage_model"
    };
  }

  // Backward-compatible legacy per-candidate rating path for an in-flight older session.
  if (session.stage === "rate") {
    const rating = Number(input.rating);
    if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
      throw new Error("BoN rating submit requires numeric rating in [0, 10]");
    }
    session.ratings.push(rating);
    if (session.ratings.length < session.candidates.length) return bonRateDirective(session);
    session.stage = "done";
  }

  let bestIndex = 0;
  for (let i = 1; i < session.ratings.length; i += 1) {
    if (session.ratings[i] > session.ratings[bestIndex]) bestIndex = i;
  }
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "bon",
    status: "complete",
    stage: "done",
    result: session.candidates[bestIndex],
    selected_index: bestIndex,
    selected_candidate_number: bestIndex + 1,
    candidates: session.candidates,
    ratings: session.ratings,
    source_reference: "~/Agent_open/OptiLLM/optillm/bon.py",
    fidelity: "web-native-bon-legacy-rating",
    provider_calls: 0,
    backend_model_calls: 0,
    execution_engine: "current_webpage_model"
  };
}

function completeMarsAdaptive(
  session: MarsSession,
  result: string,
  extra: Record<string, unknown> = {}
): OptiLLMRuntimeResult {
  session.finalAnswer = result;
  session.stage = "done";
  return {
    ok: true,
    action: "submit",
    runtime_id: session.id,
    approach: "mars",
    status: "complete",
    stage: "done",
    result,
    agent_count: session.solutions.length,
    min_agents: session.minAgents,
    max_agents: session.maxAgents,
    improved_solution_indices: Object.keys(session.improvements).map(Number),
    budget: session.budget,
    source_reference: "~/Agent_open/OptiLLM/optillm/mars/",
    fidelity: "web-mars-adaptive",
    provider_calls: 0,
    backend_model_calls: 0,
    execution_engine: "current_webpage_model",
    ...extra
  };
}

function submitMars(session: MarsSession, input: OptiLLMRuntimeInput): OptiLLMRuntimeResult {
  if (session.stage === "explore") {
    const answer = String(input.answer ?? "").trim();
    if (!answer) throw new Error("MARS exploration submit requires answer");
    session.solutions.push(answer);
    if (session.solutions.length < session.minAgents) return marsExploreDirective(session);

    const consensus = strongConsensus(session.solutions);
    if (!consensus && session.solutions.length < session.maxAgents) {
      return marsExploreDirective(session);
    }
    return marsJointVerifyDirective(session);
  }

  if (session.stage === "joint_verify") {
    const assessment = input.assessment;
    if (!assessment || !["CORRECT", "INCORRECT", "INCOMPLETE"].includes(assessment)) {
      throw new Error("MARS joint verification requires assessment=CORRECT|INCORRECT|INCOMPLETE");
    }
    const confidence = Number(input.confidence);
    if (!Number.isFinite(confidence) || confidence < 1 || confidence > 10) {
      throw new Error("MARS joint verification requires confidence in [1, 10]");
    }
    const report = String(input.report ?? "").trim() || "Joint verification completed.";
    const issues = Array.isArray(input.issues)
      ? input.issues.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
      : [];
    session.jointVerification = { assessment, confidence, report, issues };

    let selectedIndex = Number(input.selected_index);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= session.solutions.length) {
      selectedIndex = consensusStats(session.solutions).representativeIndex;
    }
    const proposedFinal = String(input.answer ?? "").trim() || session.solutions[selectedIndex];

    if (input.need_more === true && session.solutions.length < session.maxAgents) {
      session.stage = "explore";
      return marsExploreDirective(session);
    }

    const threshold = session.budget === "deep" ? 9 : session.budget === "adaptive" ? 8 : 6;
    if (assessment === "CORRECT" && confidence >= threshold) {
      return completeMarsAdaptive(session, proposedFinal, {
        joint_verify_confidence: confidence,
        joint_verify_assessment: assessment,
        selected_index: selectedIndex,
        early_exit: true,
        early_exit_reason: "joint_verifier_confident",
        consensus: consensusStats(session.solutions)
      });
    }

    if (assessment !== "CORRECT") {
      session.improvementQueue = [selectedIndex];
      session.improveCursor = 0;
      session.stage = "improve";
      return marsImproveDirective(session);
    }

    if (session.solutions.length < session.maxAgents) {
      session.stage = "explore";
      return marsExploreDirective(session);
    }

    if (session.budget === "fast") {
      return completeMarsAdaptive(session, proposedFinal, {
        joint_verify_confidence: confidence,
        joint_verify_assessment: assessment,
        selected_index: selectedIndex,
        early_exit: true,
        early_exit_reason: "fast_budget_exhausted"
      });
    }

    session.stage = "synthesize";
    return marsSynthesisDirective(session);
  }

  // Backward-compatible legacy per-solution verification path.
  if (session.stage === "verify") {
    const assessment = input.assessment;
    if (!assessment || !["CORRECT", "INCORRECT", "INCOMPLETE"].includes(assessment)) {
      throw new Error("MARS verification submit requires assessment=CORRECT|INCORRECT|INCOMPLETE");
    }
    const confidence = Number(input.confidence);
    if (!Number.isFinite(confidence) || confidence < 1 || confidence > 10) {
      throw new Error("MARS verification submit requires confidence in [1, 10]");
    }
    const report = String(input.report ?? "").trim();
    if (!report) throw new Error("MARS verification submit requires report");
    const issues = Array.isArray(input.issues)
      ? input.issues.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
      : [];
    session.verifications.push({ assessment, confidence, report, issues });

    if (session.verifications.length < session.solutions.length) return marsVerifyDirective(session);

    session.improvementQueue = session.verifications
      .map((v, index) => (v.assessment === "CORRECT" ? -1 : index))
      .filter((index) => index >= 0);
    if (session.improvementQueue.length) {
      session.stage = "improve";
      session.improveCursor = 0;
      return marsImproveDirective(session);
    }
    session.stage = "synthesize";
    return marsSynthesisDirective(session);
  }

  if (session.stage === "improve") {
    const answer = String(input.answer ?? "").trim();
    if (!answer) throw new Error("MARS improvement submit requires answer");
    const solutionIndex = session.improvementQueue[session.improveCursor];
    session.improvements[solutionIndex] = answer;
    session.improveCursor += 1;
    if (session.improveCursor < session.improvementQueue.length) return marsImproveDirective(session);

    if (session.jointVerification && session.budget !== "deep") {
      return completeMarsAdaptive(session, answer, {
        joint_verify_confidence: session.jointVerification.confidence,
        joint_verify_assessment: session.jointVerification.assessment,
        selected_index: solutionIndex,
        early_exit: true,
        early_exit_reason: "single_refinement_completed"
      });
    }

    session.stage = "synthesize";
    return marsSynthesisDirective(session);
  }

  if (session.stage === "synthesize") {
    const answer = String(input.answer ?? "").trim();
    if (!answer) throw new Error("MARS synthesis submit requires answer");
    return completeMarsAdaptive(session, answer, {
      early_exit: false,
      early_exit_reason: "synthesis_required"
    });
  }

  return completeMarsAdaptive(session, session.finalAnswer ?? session.solutions[0] ?? "");
}

function submit(input: OptiLLMRuntimeInput): OptiLLMRuntimeResult {
  const session = requireSession(input);
  if (session.approach === "re2") return submitRe2(session, input);
  if (session.approach === "bon") return submitBon(session, input);
  if (session.approach === "mars") return submitMars(session, input);
  return submitExtended(session as ExtendedSession, input);
}

function state(input: OptiLLMRuntimeInput): OptiLLMRuntimeResult {
  const session = requireSession(input);
  if (session.approach === "re2") {
    return {
      ok: true,
      action: "state",
      runtime_id: session.id,
      approach: session.approach,
      status: session.stage === "done" ? "complete" : "needs_model",
      stage: session.stage,
      result: session.answer,
      source_reference: "~/Agent_open/OptiLLM/optillm/reread.py"
    };
  }

  if (session.approach === "bon") {
    return {
      ok: true,
      action: "state",
      runtime_id: session.id,
      approach: session.approach,
      status: session.stage === "done" ? "complete" : "needs_model",
      stage: session.stage,
      n: session.n,
      budget: session.budget,
      min_candidates: session.minCandidates,
      max_candidates: session.maxCandidates,
      candidate_count: session.candidates.length,
      judge_rounds: session.judgeRounds,
      rating_count: session.ratings.length,
      candidates: session.stage === "done" ? session.candidates : undefined,
      ratings: session.stage === "done" ? session.ratings : undefined,
      source_reference: "~/Agent_open/OptiLLM/optillm/bon.py"
    };
  }

  if (session.approach !== "mars") {
    const ext = session as ExtendedSession;
    return {
      ok: true,
      action: "state",
      runtime_id: ext.id,
      approach: ext.approach,
      status: ext.stage === "done" ? "complete" : "needs_model",
      stage: ext.stage,
      n: ext.n,
      budget: ext.budget,
      item_count: ext.items.length,
      result: ext.result,
      provider_calls: 0,
      backend_model_calls: 0,
      execution_engine: "current_webpage_model"
    };
  }

  return {
    ok: true,
    action: "state",
    runtime_id: session.id,
    approach: "mars",
    status: session.stage === "done" ? "complete" : "needs_model",
    stage: session.stage,
    agent_count: session.solutions.length,
    budget: session.budget,
    min_agents: session.minAgents,
    max_agents: session.maxAgents,
    solutions_completed: session.solutions.length,
    verifications_completed: session.verifications.length,
    joint_verification_completed: Boolean(session.jointVerification),
    improvements_required: session.improvementQueue.length,
    improvements_completed: Object.keys(session.improvements).length,
    result: session.finalAnswer,
    fidelity: "web-mars-adaptive",
    source_reference: "~/Agent_open/OptiLLM/optillm/mars/"
  };
}

export async function runOptiLLMRuntime(input: OptiLLMRuntimeInput): Promise<OptiLLMRuntimeResult> {
  cleanSessions();
  switch (input.action) {
    case "list":
      return {
        ok: true,
        action: "list",
        mode: "web-native",
        core_approaches: ["auto", "re2", "bon", "cot_reflection", "self_consistency", "moa", "plansearch", "rto", "z3", "leap", "cepo", "mars"],
        approach_modes: {
          auto: "task-aware strategy_hint + adaptive compute budget",
          re2: "native-prompt/web-execution",
          bon: "adaptive 2->4 candidates + one joint judge",
          cot_reflection: "native-concept/web-private-reflection",
          self_consistency: "adaptive 3->5 samples by canonical-answer consensus",
          moa: "adaptive 2->3 candidates + fused critique/synthesis",
          plansearch: "fast=2 rounds, adaptive=3, deep=4",
          rto: "C1->description->C2->reconcile",
          z3: "web formulation->native local Z3/SymPy->web explanation",
          leap: "conditional 2/4-round web-leap-lite",
          cepo: "adaptive 2->3 proposals->refined plan->final",
          mars: "adaptive 2->3 solvers + joint verify + conditional refine"
        },
        planned_approaches: ["mcts", "rstar", "pvg"],
        provider_calls: 0,
        backend_model_calls: 0,
        source_references: {
          re2: "~/Agent_open/OptiLLM/optillm/reread.py",
          bon: "~/Agent_open/OptiLLM/optillm/bon.py",
          mars: "~/Agent_open/OptiLLM/optillm/mars/"
        }
      };
    case "health":
      return {
        ok: true,
        action: "health",
        mode: "web-native",
        webpage_model: true,
        codex_cli_used: false,
        backend_model_calls: 0,
        approaches: {
          auto: { available: true, mode: "router", default_budget: "adaptive", mapping: "task-aware strategy_hint; fallback easy->re2, medium->bon, hard->mars" },
          re2: { available: true, mode: "web-native", rounds: 1 },
          bon: { available: true, mode: "adaptive", adaptive_candidates: "2->4", joint_judge: true },
          cot_reflection: { available: true, mode: "web-native", rounds: 1 },
          self_consistency: { available: true, mode: "adaptive", adaptive_samples: "3->5", deep_samples: "5->7" },
          moa: { available: true, mode: "adaptive", adaptive_candidates: "2->3", fused_finalizer: true },
          plansearch: { available: true, mode: "adaptive", fast_rounds: 2, adaptive_rounds: 3, deep_rounds: 4 },
          rto: { available: true, mode: "web-native", rounds: "3->4 conditional" },
          z3: { available: true, mode: "web+native-local-solver", rounds: "2+repair-if-needed" },
          leap: { available: true, mode: "conditional", rounds: "2 or 4" },
          cepo: { available: true, mode: "adaptive", adaptive_proposals: "2->3" },
          mars: {
            available: true,
            mode: "adaptive",
            adaptive_agents: "2->3",
            joint_verifier: true,
            conditional_refine: true,
            native_default_num_agents: 3,
            native_default_verification_passes_required: 2
          }
        }
      };
    case "start":
      return start(input);
    case "submit":
      return submit(input);
    case "state":
      return state(input);
    case "cancel": {
      const session = requireSession(input);
      sessions.delete(session.id);
      return {
        ok: true,
        action: "cancel",
        runtime_id: session.id,
        approach: session.approach,
        status: "cancelled"
      };
    }
    default:
      throw new Error(`Unsupported web-native OptiLLM action: ${String(input.action)}`);
  }
}
