import { readFile } from 'fs/promises';
import { join } from 'path';

export interface StatusFocus {
  name: string;
  status: string;
  completed?: string;
}

export interface RecentUpdate {
  date: string;
  items: string[];
}

export interface StatusContext {
  lastUpdated: string;
  currentFocus: StatusFocus[];
  previousMilestones: { name: string; completed: string }[];
  knownIssues: string[];
  nextUp: string[];
  upcoming: string[];
  recentUpdates: RecentUpdate[];
}

/**
 * Parse the <!-- MCP-CONTEXT ... --> block from STATUS.md.
 * Falls back to empty defaults if the block is missing.
 */
export async function readStatus(docsRoot: string): Promise<StatusContext> {
  const filePath = join(docsRoot, 'STATUS.md');
  const content = await readFile(filePath, 'utf-8');

  const match = content.match(/<!--\s*MCP-CONTEXT\s*\n([\s\S]*?)-->/);
  if (!match) {
    return {
      lastUpdated: '',
      currentFocus: [],
      previousMilestones: [],
      knownIssues: [],
      nextUp: [],
      upcoming: [],
      recentUpdates: [],
    };
  }

  const yaml = match[1];
  return parseStatusYaml(yaml);
}

function parseStatusYaml(yaml: string): StatusContext {
  const result: StatusContext = {
    lastUpdated: '',
    currentFocus: [],
    previousMilestones: [],
    knownIssues: [],
    nextUp: [],
    upcoming: [],
    recentUpdates: [],
  };

  result.lastUpdated = extractScalar(yaml, 'last_updated');

  // Parse current_focus list
  const focusBlock = extractListBlock(yaml, 'current_focus');
  for (const item of focusBlock) {
    result.currentFocus.push({
      name: extractInlineField(item, 'name'),
      status: extractInlineField(item, 'status'),
      completed: extractInlineField(item, 'completed') || undefined,
    });
  }

  // Parse previous_milestones
  const milestonesBlock = extractListBlock(yaml, 'previous_milestones');
  for (const item of milestonesBlock) {
    result.previousMilestones.push({
      name: extractInlineField(item, 'name'),
      completed: extractInlineField(item, 'completed'),
    });
  }

  // Parse simple string lists
  result.knownIssues = extractStringList(yaml, 'known_issues');
  result.nextUp = extractStringList(yaml, 'next_up');
  result.upcoming = extractStringList(yaml, 'upcoming');

  // Parse recent_updates (nested list with date + items)
  const updatesBlock = extractListBlock(yaml, 'recent_updates');
  for (const item of updatesBlock) {
    const date = extractInlineField(item, 'date');
    const itemLines = item.match(/^\s+-\s+"([^"]+)"/gm) || [];
    const items = itemLines
      .map(line => {
        const m = line.match(/^\s+-\s+"([^"]+)"/);
        return m ? m[1] : '';
      })
      .filter(Boolean);
    if (date) {
      result.recentUpdates.push({ date, items });
    }
  }

  return result;
}

/** Extract a top-level scalar value like `key: "value"` or `key: value` */
function extractScalar(yaml: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, 'm');
  const m = yaml.match(re);
  return m ? m[1].trim() : '';
}

/** Extract a block of list items under a key (items start with `  - `) */
function extractListBlock(yaml: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*\\n((?:(?:  .*)\\n?)*)`, 'm');
  const m = yaml.match(re);
  if (!m) return [];

  const block = m[1];
  const items: string[] = [];
  let current = '';

  for (const line of block.split('\n')) {
    if (/^  - /.test(line)) {
      if (current) items.push(current);
      current = line;
    } else if (/^    /.test(line) && current) {
      current += '\n' + line;
    } else if (line.trim() === '') {
      continue;
    } else {
      break;
    }
  }
  if (current) items.push(current);

  return items;
}

/** Extract a simple string list like `key:\n  - "value1"\n  - "value2"` */
function extractStringList(yaml: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+"[^"]*"\\n?)*)`, 'm');
  const m = yaml.match(re);
  if (!m) return [];

  return (m[1].match(/"([^"]+)"/g) || []).map(s => s.replace(/"/g, ''));
}

/** Extract an inline field from a YAML list item like `name: "value"` */
function extractInlineField(item: string, field: string): string {
  const re = new RegExp(`${field}:\\s*"?([^"\\n]+)"?`);
  const m = item.match(re);
  return m ? m[1].trim() : '';
}
