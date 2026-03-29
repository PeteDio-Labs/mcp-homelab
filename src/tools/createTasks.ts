import {
  createDraftItem,
  createIssue,
  ensureLabels,
  addItemToProject,
  setItemFields,
  type CreatedIssue,
} from '../clients/github.js';

export interface TaskInput {
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  project?: string;
  dependsOn?: string[];
}

export interface CreatedItem {
  id: string;
  title: string;
  url?: string;
  number?: number;
}

export interface CreateTasksResult {
  created: CreatedItem[];
  failed: { title: string; error: string }[];
}

export async function createTasks(
  tasks: TaskInput[],
  projectNumber: number,
  projectName?: string,
  repo?: string,
): Promise<CreateTasksResult> {
  const created: CreatedItem[] = [];
  const failed: { title: string; error: string }[] = [];

  // If targeting a repo, ensure labels exist
  if (repo) {
    const allLabels = new Set<string>();
    for (const task of tasks) {
      allLabels.add(`priority-${task.priority}`);
    }
    await ensureLabels(repo, Array.from(allLabels));
  }

  for (const task of tasks) {
    try {
      // Build issue body
      const bodyParts: string[] = [task.description];
      if (task.dependsOn && task.dependsOn.length > 0) {
        bodyParts.push('', '### Dependencies', ...task.dependsOn.map((d) => `- ${d}`));
      }
      const body = bodyParts.join('\n');

      let itemId: string;

      if (repo) {
        // Create as repo issue, then add to board
        const labels: string[] = [`priority-${task.priority}`];
        const issue = await createIssue(repo, task.title, body, labels);
        itemId = await addItemToProject(projectNumber, issue.url);
        created.push({ id: itemId, title: task.title, url: issue.url, number: issue.number });
      } else {
        // Create as draft item directly on the board (no repo needed)
        const draft = await createDraftItem(projectNumber, task.title, body);
        itemId = draft.id;
        created.push({ id: itemId, title: task.title });
      }

      // Set custom fields (Project, Priority, Status)
      const resolvedProject = task.project || projectName;
      await setItemFields(projectNumber, itemId, {
        project: resolvedProject,
        priority: task.priority,
        status: 'Todo',
      });
    } catch (err) {
      failed.push({
        title: task.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { created, failed };
}

export function formatCreateResult(result: CreateTasksResult): string {
  const lines: string[] = [];

  if (result.created.length > 0) {
    lines.push(`### Created ${result.created.length} item(s)`);
    for (const item of result.created) {
      if (item.url) {
        lines.push(`- [#${item.number}](${item.url}) ${item.title}`);
      } else {
        lines.push(`- ${item.title} (draft)`);
      }
    }
  }

  if (result.failed.length > 0) {
    lines.push('', `### Failed (${result.failed.length})`);
    for (const f of result.failed) {
      lines.push(`- ${f.title}: ${f.error}`);
    }
  }

  return lines.join('\n');
}
