const OLLAMA_URL = process.env.OLLAMA_URL || 'http://192.168.50.59:11434';
const MODEL = process.env.OLLAMA_MODEL || 'petedio-planner'; // 3B

interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_duration?: number;
  eval_count?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  durationMs: number;
  tokensPerSec: number;
}

export async function generate(
  prompt: string,
  opts?: { json?: boolean; system?: string },
): Promise<GenerateResult> {
  const body: Record<string, unknown> = {
    model: MODEL,
    prompt,
    stream: false,
  };
  if (opts?.json) body.format = 'json';
  if (opts?.system) body.system = opts.system;

  const start = performance.now();

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as OllamaResponse;
  const wallMs = Math.round(performance.now() - start);

  // Ollama returns durations in nanoseconds
  const evalMs = data.eval_duration ? Math.round(data.eval_duration / 1_000_000) : wallMs;
  const tokensPerSec = data.eval_count && data.eval_duration
    ? Math.round((data.eval_count / data.eval_duration) * 1_000_000_000 * 100) / 100
    : 0;

  return {
    text: data.response,
    model: MODEL,
    durationMs: evalMs,
    tokensPerSec,
  };
}

function extractJSON(response: string): string {
  try { JSON.parse(response); return response; } catch {}
  const codeBlock = response.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) return codeBlock[1].trim();
  const first = response.indexOf('{');
  const last = response.lastIndexOf('}');
  if (first !== -1 && last > first) return response.slice(first, last + 1);
  return response;
}

export async function generateJSON<T>(prompt: string): Promise<{ data: T; timing: GenerateResult }> {
  const result = await generate(prompt, { json: true });
  const data = JSON.parse(extractJSON(result.text)) as T;
  return { data, timing: result };
}
