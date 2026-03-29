import { readStatus, type StatusContext } from '../readers/status.js';
import { readSessions, type SessionDigest } from '../readers/sessions.js';
import { readGoals, type GoalDigest } from '../readers/goals.js';

export interface ProjectContext {
  generatedAt: string;
  currentFocus: string;
  completedThisWeek: string[];
  recentWork: { date: string; headline: string; keyOutcomes: string[] }[];
  activeGoals: { number: number; name: string; status: string; priority: string }[];
  completedGoals: { number: number; name: string; completed?: string }[];
  knownIssues: string[];
  nextUp: string[];
}

export async function gatherContext(
  docsRoot: string,
  sessionCount: number = 2,
  includeGoals: boolean = true,
): Promise<ProjectContext> {
  const [status, sessions, goals] = await Promise.all([
    readStatus(docsRoot),
    readSessions(docsRoot, sessionCount),
    includeGoals ? readGoals(docsRoot) : Promise.resolve([]),
  ]);

  return buildProjectContext(status, sessions, goals);
}

function buildProjectContext(
  status: StatusContext,
  sessions: SessionDigest[],
  goals: GoalDigest[],
): ProjectContext {
  // Build current focus summary
  const focusItems = status.currentFocus
    .map(f => `${f.name} (${f.status}${f.completed ? `, ${f.completed}` : ''})`)
    .join('; ');

  // Collect all key outcomes from recent sessions as "completedThisWeek"
  const completedThisWeek = sessions.flatMap(s => s.keyOutcomes).slice(0, 10);

  // Build session digests
  const recentWork = sessions.map(s => ({
    date: s.date,
    headline: s.topics[0] || 'Session work',
    keyOutcomes: s.keyOutcomes.slice(0, 5),
  }));

  // Split goals into active vs completed
  const activeGoals = goals
    .filter(g => g.status !== 'complete')
    .map(g => ({ number: g.number, name: g.name, status: g.status, priority: g.priority }));

  const completedGoals = goals
    .filter(g => g.status === 'complete')
    .map(g => ({ number: g.number, name: g.name, completed: g.completed }));

  return {
    generatedAt: new Date().toISOString(),
    currentFocus: focusItems || 'No current focus set',
    completedThisWeek,
    recentWork,
    activeGoals,
    completedGoals,
    knownIssues: status.knownIssues,
    nextUp: status.nextUp,
  };
}

/**
 * Format ProjectContext as a human-readable string for the blog-agent writer prompt.
 * Targets ~1000 tokens when serialized.
 */
export function formatContextForWriter(ctx: ProjectContext): string {
  const lines: string[] = [];

  lines.push(`PROJECT CONTEXT (generated ${ctx.generatedAt.split('T')[0]}):`);
  lines.push(`Current focus: ${ctx.currentFocus}`);

  if (ctx.completedThisWeek.length > 0) {
    lines.push('');
    lines.push('Completed this week:');
    for (const item of ctx.completedThisWeek) {
      lines.push(`- ${item}`);
    }
  }

  if (ctx.recentWork.length > 0) {
    lines.push('');
    for (const session of ctx.recentWork) {
      lines.push(`Session ${session.date}: ${session.headline}`);
      for (const outcome of session.keyOutcomes) {
        lines.push(`- ${outcome}`);
      }
    }
  }

  if (ctx.activeGoals.length > 0) {
    lines.push('');
    lines.push('Active goals:');
    for (const g of ctx.activeGoals) {
      lines.push(`- Goal ${g.number}: ${g.name} [${g.status}, ${g.priority}]`);
    }
  }

  if (ctx.completedGoals.length > 0) {
    lines.push('');
    lines.push('Recently completed goals:');
    for (const g of ctx.completedGoals) {
      lines.push(`- Goal ${g.number}: ${g.name}${g.completed ? ` (${g.completed})` : ''}`);
    }
  }

  if (ctx.knownIssues.length > 0) {
    lines.push('');
    lines.push('Known issues:');
    for (const issue of ctx.knownIssues) {
      lines.push(`- ${issue}`);
    }
  }

  if (ctx.nextUp.length > 0) {
    lines.push('');
    lines.push('Next up:');
    for (const item of ctx.nextUp) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join('\n');
}
