import { generateJSON, type GenerateResult } from '../clients/ollama.js';
import { readPlanDoc } from '../readers/planDocs.js';

export interface PlannedTask {
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  dependsOn?: string[];
}

export interface PlannedPhase {
  name: string;
  tasks: PlannedTask[];
}

export interface PlanResult {
  projectName: string;
  phases: PlannedPhase[];
  timing: GenerateResult;
}

export async function planProject(
  planFile: string,
  projectName: string,
): Promise<PlanResult> {
  const planContent = await readPlanDoc(planFile);

  // Extract only the "Implementation Phases" section, strip completed items
  const phasesMatch = planContent.match(/## Implementation Phases\s*([\s\S]*?)(?=\n---|\n## |$)/);
  const phasesSection = phasesMatch ? phasesMatch[1] : planContent;
  const trimmedPlan = phasesSection
    .split('\n')
    .filter((line) => !line.includes('✅'))
    .join('\n')
    .replace(/`/g, '')
    .slice(0, 3000);

  const prompt = `Extract the remaining tasks from these implementation phases for project "${projectName}". Return JSON only.

${trimmedPlan}

JSON format:
{"projectName":"${projectName}","phases":[{"name":"Phase name","tasks":[{"title":"Imperative verb under 80 chars","description":"One sentence","priority":"high|medium|low","dependsOn":["blocking task"]}]}]}

Rules:
- ONLY extract tasks explicitly listed above, do NOT invent new ones
- Skip done/complete items
- high = critical path, medium = important, low = cleanup`;

  const { data, timing } = await generateJSON<{ projectName: string; phases: PlannedPhase[] }>(prompt);

  return { projectName: data.projectName, phases: data.phases, timing };
}

export function formatPlanResult(result: PlanResult): string {
  const lines: string[] = [
    `## Plan: ${result.projectName}`,
    '',
  ];

  let totalTasks = 0;
  for (const phase of result.phases) {
    lines.push(`### ${phase.name} (${phase.tasks.length} tasks)`);
    for (const task of phase.tasks) {
      const priority = `[${task.priority}]`;
      const deps = task.dependsOn?.length ? ` (depends on: ${task.dependsOn.join(', ')})` : '';
      lines.push(`- ${priority} **${task.title}**${deps}`);
      lines.push(`  ${task.description}`);
      totalTasks++;
    }
    lines.push('');
  }

  lines.push(`**Total: ${totalTasks} tasks across ${result.phases.length} phases**`);
  lines.push(`_Generated in ${(result.timing.durationMs / 1000).toFixed(1)}s by ${result.timing.model} (${result.timing.tokensPerSec} tok/s)_`);
  return lines.join('\n');
}
