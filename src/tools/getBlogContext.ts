import {
  listProjectItems,
  getProjectId,
  resolveFieldOption,
  updateProjectItemField,
  type ProjectItem,
} from '../clients/github.js';

export interface BlogContext {
  project: string;
  completedItems: ProjectItem[];
  summary: string;
  generatedAt: string;
  markedAsBlogged: boolean;
}

/**
 * Get blog-ready context for a project by pulling all "Done" items
 * that haven't been blogged yet, then mark them as "Blogged".
 */
export async function getBlogContext(
  projectNumber: number,
  projectFilter: string,
  markAsBlogged: boolean = true,
): Promise<BlogContext> {
  const items = await listProjectItems(projectNumber);

  // Filter: matching project + Done status (not yet Blogged)
  const filter = projectFilter.toLowerCase();
  const completedItems = items.filter(
    (item) =>
      item.status?.toLowerCase() === 'done' &&
      (item.project?.toLowerCase() === filter ||
        item.labels.some((l) => l.toLowerCase().includes(filter)) ||
        item.title.toLowerCase().includes(filter)),
  );

  if (completedItems.length === 0) {
    return {
      project: projectFilter,
      completedItems: [],
      summary: `No completed (unblogged) items found for project "${projectFilter}".`,
      generatedAt: new Date().toISOString(),
      markedAsBlogged: false,
    };
  }

  // Build a structured summary for the blog agent
  const summary = buildBlogSummary(projectFilter, completedItems);

  // Mark items as Blogged so they don't get picked up again
  if (markAsBlogged) {
    await markItemsBlogged(projectNumber, completedItems);
  }

  return {
    project: projectFilter,
    completedItems,
    summary,
    generatedAt: new Date().toISOString(),
    markedAsBlogged: markAsBlogged,
  };
}

function buildBlogSummary(project: string, items: ProjectItem[]): string {
  const lines: string[] = [
    `# What We Built: ${project}`,
    '',
    `## Completed Work (${items.length} items)`,
    '',
  ];

  // Group by priority
  const byPriority: Record<string, ProjectItem[]> = {};
  for (const item of items) {
    const priority = item.priority || 'unset';
    if (!byPriority[priority]) byPriority[priority] = [];
    byPriority[priority].push(item);
  }

  for (const [priority, priorityItems] of Object.entries(byPriority)) {
    lines.push(`### ${priority.charAt(0).toUpperCase() + priority.slice(1)} Priority`);
    for (const item of priorityItems) {
      const labels = item.labels.length ? ` [${item.labels.join(', ')}]` : '';
      lines.push(`- **${item.title}**${labels}`);
    }
    lines.push('');
  }

  lines.push('## Key Takeaways');
  lines.push('');
  lines.push(`- ${items.length} tasks completed for the ${project} project`);
  lines.push(`- Items span ${Object.keys(byPriority).length} priority level(s)`);

  return lines.join('\n');
}

async function markItemsBlogged(
  projectNumber: number,
  items: ProjectItem[],
): Promise<void> {
  const projectId = await getProjectId(projectNumber);
  const resolved = await resolveFieldOption(projectNumber, 'Status', 'Blogged');
  if (!resolved) {
    throw new Error('Could not resolve "Blogged" status option — ensure it exists on the board');
  }

  const updates = items.map((item) =>
    updateProjectItemField(projectId, item.id, resolved.fieldId, resolved.optionId),
  );

  await Promise.all(updates);
}

export function formatBlogContext(ctx: BlogContext): string {
  if (ctx.completedItems.length === 0) {
    return ctx.summary;
  }

  const lines: string[] = [
    ctx.summary,
    '',
    '---',
    '',
    '**Blog Agent Context (JSON):**',
    '```json',
    JSON.stringify(
      {
        contentType: 'how-to',
        topic: `Building the ${ctx.project} project — what we shipped`,
        context: {
          project: ctx.project,
          completedTasks: ctx.completedItems.map((i) => ({
            title: i.title,
            priority: i.priority,
            labels: i.labels,
          })),
          taskCount: ctx.completedItems.length,
          generatedAt: ctx.generatedAt,
        },
      },
      null,
      2,
    ),
    '```',
    '',
    ctx.markedAsBlogged
      ? `*${ctx.completedItems.length} item(s) marked as Blogged on the board.*`
      : `*${ctx.completedItems.length} item(s) found (dry run — not marked as Blogged).*`,
  ];

  return lines.join('\n');
}
