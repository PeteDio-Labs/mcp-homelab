/**
 * Code-agent tools for Claude Code MCP.
 *
 * Exposes two primitives:
 *   - code_op   — direct file/kubectl/git/gh operations with risk-tier gating
 *   - code_plan — execute a step-by-step plan. Preferred: Claude writes the plan
 *                 and passes it via the `plan` parameter (no Ollama, no latency).
 *                 Fallback: pass `task` without `plan` to generate via Ollama
 *                 (gemma4:e2b for simple tasks, gemma4:e4b for complex).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const execFileAsync = promisify(execFile);

const WORKSPACE_ROOT = '/home/pedro/PeteDio-Labs';
const ALLOWED_PATH_PREFIX = WORKSPACE_ROOT;
const MAX_OUTPUT_CHARS = 8000;

// ── Model routing ─────────────────────────────────────────────────────────────

const COMPLEX_KEYWORDS = [
  'fix', 'implement', 'add', 'refactor', 'debug', 'write', 'create',
  'update', 'migrate', 'deploy', 'build', 'change', 'modify', 'setup',
  'configure', 'remove', 'delete', 'replace', 'integrate', 'wire', 'connect',
];
const SIMPLE_WORDS = [
  'read', 'check', 'list', 'show', 'what', 'how', 'describe', 'get',
  'status', 'view', 'find', 'inspect', 'look', 'is', 'are', 'does', 'which',
];

export function classifyTaskComplexity(task: string): 'simple' | 'complex' {
  const lower = task.toLowerCase();
  if (COMPLEX_KEYWORDS.some((k) => lower.includes(k))) return 'complex';
  if (SIMPLE_WORDS.some((k) => lower.split(/\s+/).includes(k))) return 'simple';
  return task.length > 120 ? 'complex' : 'simple';
}

function resolveModel(task: string, baseModel: string): string {
  if (!baseModel.includes('e4b') && !baseModel.includes(':4b')) return baseModel;
  const complexity = classifyTaskComplexity(task);
  return complexity === 'simple'
    ? baseModel.replace('e4b', 'e2b').replace(':4b', ':2b')
    : baseModel;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n… [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
}

function guardPath(path: string): string | null {
  if (!path.startsWith(ALLOWED_PATH_PREFIX)) {
    return `Path "${path}" is outside allowed area (${ALLOWED_PATH_PREFIX})`;
  }
  if (path.includes('..')) return 'Path traversal (../) not allowed';
  return null;
}

async function spawn(
  cmd: string,
  args: string[],
  timeoutMs = 15_000,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
    cwd,
  });
  return { stdout, stderr };
}

// ── code_op implementation ────────────────────────────────────────────────────

export type CodeOpAction =
  | 'read_file' | 'write_file'
  | 'kubectl_get' | 'kubectl_describe' | 'kubectl_logs' | 'kubectl_exec'
  | 'kubectl_apply' | 'kubectl_delete'
  | 'gh_pr_list' | 'gh_pr_create' | 'gh_run_list' | 'gh_run_view'
  | 'git_commit' | 'git_push';

const DESTRUCTIVE_ACTIONS: Set<CodeOpAction> = new Set([
  'write_file', 'kubectl_apply', 'kubectl_delete',
  'gh_pr_create', 'git_commit', 'git_push',
]);

export interface CodeOpArgs {
  action: CodeOpAction;
  confirmed?: boolean;
  // file ops
  path?: string;
  content?: string;
  // kubectl
  namespace?: string;
  resource?: string;
  name?: string;
  container?: string;
  lines?: number;
  exec_command?: string[];
  manifest_path?: string;
  // gh
  repo?: string;
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  run_id?: string;
  // git
  message?: string;
  paths?: string[];
  remote?: string;
  branch?: string;
  cwd?: string;
}

export async function codeOp(args: CodeOpArgs): Promise<string> {
  const { action } = args;

  if (DESTRUCTIVE_ACTIONS.has(action) && !args.confirmed) {
    return `BLOCKED: "${action}" is a DESTRUCTIVE operation. Set confirmed=true to proceed.`;
  }

  try {
    switch (action) {
      // ── READ_ONLY ────────────────────────────────────────────
      case 'read_file': {
        if (!args.path) return 'error: path required';
        const err = guardPath(args.path);
        if (err) return `error: ${err}`;
        const content = await readFile(args.path, 'utf-8');
        return truncate(content);
      }

      case 'kubectl_get': {
        if (!args.resource) return 'error: resource required';
        const a = ['get', args.resource];
        if (args.name) a.push(args.name);
        if (args.namespace) a.push('-n', args.namespace); else a.push('-A');
        a.push('-o', 'wide');
        const { stdout } = await spawn('kubectl', a);
        return truncate(stdout);
      }

      case 'kubectl_describe': {
        if (!args.resource || !args.name) return 'error: resource and name required';
        const a = ['describe', args.resource, args.name];
        if (args.namespace) a.push('-n', args.namespace);
        const { stdout } = await spawn('kubectl', a);
        return truncate(stdout);
      }

      case 'kubectl_logs': {
        if (!args.name) return 'error: name required';
        const a = ['logs', args.name, `--tail=${args.lines ?? 100}`];
        if (args.namespace) a.push('-n', args.namespace);
        if (args.container) a.push('-c', args.container);
        const { stdout } = await spawn('kubectl', a, 30_000);
        return truncate(stdout);
      }

      case 'kubectl_exec': {
        if (!args.name || !args.exec_command?.length) return 'error: name and exec_command required';
        const a = ['exec', args.name];
        if (args.namespace) a.push('-n', args.namespace);
        a.push('--', ...args.exec_command);
        const { stdout, stderr } = await spawn('kubectl', a, 30_000);
        return truncate(stdout || stderr);
      }

      case 'gh_pr_list': {
        const a = ['pr', 'list', '--limit', '20', '--json',
          'number,title,state,headRefName,baseRefName,createdAt'];
        if (args.repo) a.push('--repo', args.repo);
        const { stdout } = await spawn('gh', a);
        return stdout;
      }

      case 'gh_run_list': {
        const a = ['run', 'list', '--limit', '10', '--json',
          'databaseId,name,status,conclusion,headBranch,createdAt'];
        if (args.repo) a.push('--repo', args.repo);
        const { stdout } = await spawn('gh', a);
        return stdout;
      }

      case 'gh_run_view': {
        if (!args.run_id) return 'error: run_id required';
        const a = ['run', 'view', args.run_id, '--log-failed'];
        if (args.repo) a.push('--repo', args.repo);
        const { stdout } = await spawn('gh', a, 30_000);
        return truncate(stdout);
      }

      // ── DESTRUCTIVE ──────────────────────────────────────────
      case 'write_file': {
        if (!args.path || args.content === undefined) return 'error: path and content required';
        const err = guardPath(args.path);
        if (err) return `error: ${err}`;
        await mkdir(dirname(args.path), { recursive: true });
        await writeFile(args.path, args.content, 'utf-8');
        return `wrote ${Buffer.byteLength(args.content, 'utf-8')} bytes to ${args.path}`;
      }

      case 'kubectl_apply': {
        if (!args.manifest_path) return 'error: manifest_path required';
        const { stdout } = await spawn('kubectl', ['apply', '-f', args.manifest_path]);
        return truncate(stdout);
      }

      case 'kubectl_delete': {
        if (args.manifest_path) {
          const { stdout } = await spawn('kubectl', ['delete', '-f', args.manifest_path]);
          return truncate(stdout);
        }
        if (!args.resource || !args.name) return 'error: resource and name (or manifest_path) required';
        const a = ['delete', args.resource, args.name];
        if (args.namespace) a.push('-n', args.namespace);
        const { stdout } = await spawn('kubectl', a);
        return truncate(stdout);
      }

      case 'gh_pr_create': {
        if (!args.title || !args.head) return 'error: title and head required';
        const a = ['pr', 'create', '--title', args.title, '--base', args.base ?? 'main', '--head', args.head];
        if (args.body) a.push('--body', args.body);
        if (args.repo) a.push('--repo', args.repo);
        const { stdout } = await spawn('gh', a, 30_000);
        return stdout.trim();
      }

      case 'git_commit': {
        if (!args.message) return 'error: message required';
        const workDir = args.cwd ?? WORKSPACE_ROOT;
        const stagePaths = args.paths?.length ? args.paths : ['.'];
        await spawn('git', ['add', ...stagePaths], 15_000, workDir);
        const { stdout } = await spawn('git', ['commit', '-m', args.message], 15_000, workDir);
        return truncate(stdout);
      }

      case 'git_push': {
        const workDir = args.cwd ?? WORKSPACE_ROOT;
        const a = ['push', args.remote ?? 'origin'];
        if (args.branch) a.push(args.branch);
        const { stdout, stderr } = await spawn('git', a, 30_000, workDir);
        return truncate(stdout || stderr);
      }

      default:
        return `error: unknown action "${action}"`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error (${action}): ${msg}`;
  }
}

// ── code_plan implementation ──────────────────────────────────────────────────

const PLAN_SYSTEM_PROMPT = `You are a coding agent planner for the PeteDio Labs monorepo.

Given a task, output ONLY a valid JSON array of steps. No explanation outside the JSON.

Each step must have:
- "step": integer (1-based)
- "description": short human-readable description
- "tool": always "code_op"
- "args": object matching code_op args (action + relevant params)
- "risk_tier": "READ_ONLY" | "SAFE_MUTATE" | "DESTRUCTIVE"

Rules:
- Always start with READ_ONLY steps to gather context before proposing changes
- Set confirmed=true in args for all DESTRUCTIVE steps
- Keep plans short (3-8 steps max)
- READ_ONLY: read_file, kubectl_get, kubectl_describe, kubectl_logs, kubectl_exec, gh_pr_list, gh_run_list, gh_run_view
- DESTRUCTIVE: write_file, kubectl_apply, kubectl_delete, gh_pr_create, git_commit, git_push
- Full self-modification flow: read_file → write_file → git_commit → git_push → gh_pr_create

Repo conventions: Bun runtime, Express v5, TypeScript, native fetch (no axios).
Workspace root: /home/pedro/PeteDio-Labs

Example:
[
  {"step":1,"description":"Read current file","tool":"code_op","args":{"action":"read_file","path":"/home/pedro/PeteDio-Labs/apps/blog/blog-agent/src/services/pipeline.ts"},"risk_tier":"READ_ONLY"},
  {"step":2,"description":"Write updated file","tool":"code_op","args":{"action":"write_file","path":"/home/pedro/PeteDio-Labs/apps/blog/blog-agent/src/services/pipeline.ts","content":"...","confirmed":true},"risk_tier":"DESTRUCTIVE"},
  {"step":3,"description":"Commit and push","tool":"code_op","args":{"action":"git_commit","message":"fix: update pipeline","confirmed":true},"risk_tier":"DESTRUCTIVE"}
]`;

export interface PlanStep {
  step: number;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  risk_tier: 'READ_ONLY' | 'SAFE_MUTATE' | 'DESTRUCTIVE';
}

export async function codePlan(
  task: string,
  ollamaHost: string,
  baseModel: string,
  /** Pre-written plan from Claude (JSON string or PlanStep[]). When provided,
   *  Ollama is skipped entirely — Claude plans, this tool executes. */
  prewrittenPlan?: string | PlanStep[],
): Promise<string> {
  let steps: PlanStep[];

  if (prewrittenPlan !== undefined) {
    // Fast path: Claude already wrote the plan — parse and validate, no Ollama
    try {
      const raw = typeof prewrittenPlan === 'string' ? prewrittenPlan : JSON.stringify(prewrittenPlan);
      const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      steps = JSON.parse(jsonStr) as PlanStep[];
      if (!Array.isArray(steps)) throw new Error('Expected JSON array');
    } catch {
      return `Failed to parse provided plan. Ensure it is a valid JSON array of PlanStep objects.`;
    }
  } else {
    // Fallback: generate plan via Ollama (slower, use only when Claude is not planning)
    const model = resolveModel(task, baseModel);
    const complexity = classifyTaskComplexity(task);

    const payload = {
      model,
      messages: [
        { role: 'system', content: PLAN_SYSTEM_PROMPT },
        { role: 'user', content: `Task: ${task}` },
      ],
      stream: false,
    };

    const res = await fetch(`${ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      throw new Error(`Ollama returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as { message?: { content?: string } };
    const raw = data.message?.content?.trim() ?? '';
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    try {
      steps = JSON.parse(jsonStr) as PlanStep[];
      if (!Array.isArray(steps)) throw new Error('Expected JSON array');
    } catch {
      return `Failed to parse plan. Raw output:\n${raw.substring(0, 500)}`;
    }

    void complexity; // used by resolveModel above
  }

  // Ensure all DESTRUCTIVE steps have confirmed=true
  for (const step of steps) {
    if (step.risk_tier === 'DESTRUCTIVE') step.args.confirmed = true;
  }

  const source = prewrittenPlan !== undefined ? 'claude (no Ollama)' : `ollama/${resolveModel(task, baseModel)}`;
  const lines = [
    `Plan ready (source: ${source})`,
    `Task: ${task}`,
    '',
    ...steps.map((s) => {
      const tier = s.risk_tier === 'DESTRUCTIVE' ? '🔴' : s.risk_tier === 'SAFE_MUTATE' ? '🟡' : '🟢';
      return `${tier} Step ${s.step}: ${s.description}\n   args: ${JSON.stringify(s.args)}`;
    }),
    '',
    JSON.stringify(steps, null, 2),
  ];

  return lines.join('\n');
}
