import { readFile } from 'fs/promises';
import { join } from 'path';

export interface GoalDigest {
  number: number;
  name: string;
  status: string;
  completed?: string;
  priority: string;
}

/**
 * Parse goal status markers from FUTURE-GOALS.md.
 * Reads `<!-- goal: N, status: ..., priority: ... -->` HTML comments.
 */
export async function readGoals(docsRoot: string): Promise<GoalDigest[]> {
  const filePath = join(docsRoot, 'architecture', 'FUTURE-GOALS.md');
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const goals: GoalDigest[] = [];
  const markerRe = /<!--\s*goal:\s*(\d+),\s*status:\s*(\w+)(?:,\s*completed:\s*([\d-]+))?(?:,\s*priority:\s*(\w+))?\s*-->/g;

  // Also extract goal names from ## headings
  const headingRe = /^## Goal (\d+):\s*(.+?)(?:\s*✅.*)?$/gm;
  const nameMap = new Map<number, string>();

  let match;
  while ((match = headingRe.exec(content)) !== null) {
    nameMap.set(parseInt(match[1], 10), match[2].trim());
  }

  while ((match = markerRe.exec(content)) !== null) {
    const num = parseInt(match[1], 10);
    goals.push({
      number: num,
      name: nameMap.get(num) || `Goal ${num}`,
      status: match[2],
      completed: match[3] || undefined,
      priority: match[4] || 'medium',
    });
  }

  return goals.sort((a, b) => a.number - b.number);
}
