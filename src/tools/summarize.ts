import { generate } from '../clients/ollama.js';
import { getStatus, formatStatus } from './getStatus.js';

export async function summarize(projectNumber: number): Promise<string> {
  const status = await getStatus(projectNumber);
  const boardState = formatStatus(status);

  const prompt = `Generate a concise project status summary in markdown.

BOARD STATE:
${boardState}

Include: health assessment, active work, blockers, next actions, progress count.
Keep under 300 words.`;

  const result = await generate(prompt);
  return `${result.text}\n\n_Generated in ${(result.durationMs / 1000).toFixed(1)}s by ${result.model} (${result.tokensPerSec} tok/s)_`;
}
