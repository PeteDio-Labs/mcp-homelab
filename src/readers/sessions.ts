import { readFile, readdir } from 'fs/promises';
import { join } from 'path';

export interface SessionDigest {
  date: string;
  topics: string[];
  keyOutcomes: string[];
  servicesTouched: string[];
  goalsCompleted: number[];
}

/**
 * Read session summaries with YAML frontmatter.
 * Returns the N most recent sessions sorted by date descending.
 */
export async function readSessions(docsRoot: string, count: number = 2): Promise<SessionDigest[]> {
  const sessionsDir = join(docsRoot, 'sessions');
  const files = await readdir(sessionsDir);

  const sessionFiles = files
    .filter(f => f.match(/^SESSION-SUMMARY-\d{4}-\d{2}-\d{2}\.md$/))
    .sort()
    .reverse()
    .slice(0, count);

  const sessions: SessionDigest[] = [];

  for (const file of sessionFiles) {
    const content = await readFile(join(sessionsDir, file), 'utf-8');
    const session = parseFrontmatter(content, file);
    if (session) sessions.push(session);
  }

  return sessions;
}

function parseFrontmatter(content: string, filename: string): SessionDigest | null {
  // Extract YAML frontmatter between --- delimiters
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    // Fallback: extract date from filename, headline from first ## heading
    const dateMatch = filename.match(/(\d{4}-\d{2}-\d{2})/);
    const headlineMatch = content.match(/^## (.+)$/m);
    return {
      date: dateMatch ? dateMatch[1] : 'unknown',
      topics: headlineMatch ? [headlineMatch[1]] : [],
      keyOutcomes: [],
      servicesTouched: [],
      goalsCompleted: [],
    };
  }

  const yaml = match[1];

  return {
    date: extractScalar(yaml, 'date'),
    topics: extractStringList(yaml, 'topics'),
    keyOutcomes: extractStringList(yaml, 'key_outcomes'),
    servicesTouched: extractStringList(yaml, 'services_touched'),
    goalsCompleted: extractNumberList(yaml, 'goals_completed'),
  };
}

function extractScalar(yaml: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, 'm');
  const m = yaml.match(re);
  return m ? m[1].trim() : '';
}

function extractStringList(yaml: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, 'm');
  const m = yaml.match(re);
  if (!m) return [];

  return m[1]
    .split('\n')
    .filter(line => /^\s+-\s+/.test(line))
    .map(line => {
      const val = line.replace(/^\s+-\s+/, '').trim();
      return val.replace(/^"(.*)"$/, '$1');
    });
}

function extractNumberList(yaml: string, key: string): number[] {
  // First check for inline empty array: `goals_completed: []`
  const inlineRe = new RegExp(`^${key}:\\s*\\[\\]`, 'm');
  if (inlineRe.test(yaml)) return [];

  // Extract the list block under the key
  const blockRe = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)*)`, 'm');
  const m = yaml.match(blockRe);
  if (!m) return [];

  return m[1]
    .split('\n')
    .filter(line => /^\s+-\s+\d+/.test(line))
    .map(line => {
      const num = line.match(/\d+/);
      return num ? parseInt(num[0], 10) : 0;
    })
    .filter(n => n > 0);
}
