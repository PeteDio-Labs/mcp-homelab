import { listProjectItems, type ProjectItem } from '../clients/github.js';

interface StatusSummary {
  projectNumber: number;
  totalItems: number;
  byStatus: Record<string, ProjectItem[]>;
  inProgress: ProjectItem[];
  blocked: ProjectItem[];
}

export async function getStatus(
  projectNumber: number,
  projectFilter?: string,
): Promise<StatusSummary> {
  let items = await listProjectItems(projectNumber);

  // Filter by Project custom field or labels
  if (projectFilter) {
    const filter = projectFilter.toLowerCase();
    items = items.filter(
      (item) =>
        item.project?.toLowerCase() === filter ||
        item.labels.some((l) => l.toLowerCase().includes(filter)) ||
        item.title.toLowerCase().includes(filter),
    );
  }

  // Group by status
  const byStatus: Record<string, ProjectItem[]> = {};
  for (const item of items) {
    const status = item.status || 'No Status';
    if (!byStatus[status]) byStatus[status] = [];
    byStatus[status].push(item);
  }

  return {
    projectNumber,
    totalItems: items.length,
    byStatus,
    inProgress: items.filter((i) => i.status?.toLowerCase().includes('progress')),
    blocked: items.filter((i) =>
      i.labels.some((l) => l.toLowerCase() === 'blocked'),
    ),
  };
}

export function formatStatus(summary: StatusSummary): string {
  const lines: string[] = [
    `## Project Board #${summary.projectNumber}`,
    `**Total items:** ${summary.totalItems}`,
    '',
  ];

  for (const [status, items] of Object.entries(summary.byStatus)) {
    lines.push(`### ${status} (${items.length})`);
    for (const item of items) {
      const labels = item.labels.length ? ` [${item.labels.join(', ')}]` : '';
      lines.push(`- ${item.title}${labels}${item.url ? ` — ${item.url}` : ''}`);
    }
    lines.push('');
  }

  if (summary.inProgress.length > 0) {
    lines.push(`**In Progress:** ${summary.inProgress.map((i) => i.title).join(', ')}`);
  }

  if (summary.blocked.length > 0) {
    lines.push(`**Blocked:** ${summary.blocked.map((i) => i.title).join(', ')}`);
  }

  return lines.join('\n');
}
