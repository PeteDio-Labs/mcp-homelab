import { $ } from 'bun';

const GITHUB_ORG = process.env.GITHUB_ORG || 'PeteDio-Labs';

export interface ProjectItem {
  id: string;
  title: string;
  status: string;
  project: string;
  priority: string;
  url: string;
  labels: string[];
  repository: string;
  number: number;
}

export interface FieldOption {
  id: string;
  name: string;
}

export interface ProjectField {
  id: string;
  name: string;
  type: string;
  options?: FieldOption[];
}

// Cache field metadata per project to avoid repeated API calls
const fieldCache = new Map<number, ProjectField[]>();

export interface CreatedIssue {
  url: string;
  number: number;
  title: string;
}

/**
 * List all items on a GitHub Project board
 */
export async function listProjectItems(projectNumber: number): Promise<ProjectItem[]> {
  const result = await $`gh project item-list ${projectNumber} --owner ${GITHUB_ORG} --format json --limit 200`.quiet().text();
  const parsed = JSON.parse(result);

  return (parsed.items || []).map((item: any) => ({
    id: item.id,
    title: item.title,
    status: item.status || 'No Status',
    project: item.project || '',
    priority: item.priority || '',
    url: item.content?.url || '',
    labels: item.labels || [],
    repository: item.content?.repository || '',
    number: item.content?.number || 0,
  }));
}

/**
 * Get project metadata (ID, fields, etc.)
 */
export async function getProjectId(projectNumber: number): Promise<string> {
  const result = await $`gh project view ${projectNumber} --owner ${GITHUB_ORG} --format json`.quiet().text();
  const parsed = JSON.parse(result);
  return parsed.id;
}

/**
 * Create a draft item directly on the project board (no repo needed)
 */
export async function createDraftItem(
  projectNumber: number,
  title: string,
  body: string,
): Promise<{ id: string; title: string }> {
  const result = await $`gh project item-create ${projectNumber} --owner ${GITHUB_ORG} --title ${title} --body ${body} --format json`.quiet().text();
  const parsed = JSON.parse(result);
  return { id: parsed.id, title };
}

/**
 * Create a GitHub issue in a repo (use when you need repo-level tracking)
 */
export async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[],
): Promise<CreatedIssue> {
  const args = ['issue', 'create', '--repo', repo, '--title', title, '--body', body];
  for (const label of labels) {
    args.push('--label', label);
  }

  const result = await $`gh ${args}`.quiet().text();
  const url = result.trim();

  const match = url.match(/\/issues\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;

  return { url, number, title };
}

/**
 * Ensure labels exist on a repo (create if missing)
 */
export async function ensureLabels(repo: string, labels: string[]): Promise<void> {
  for (const label of labels) {
    try {
      await $`gh label create ${label} --repo ${repo} --force`.quiet();
    } catch {
      // Label may already exist, that's fine
    }
  }
}

/**
 * Add an issue to a GitHub Project board
 */
export async function addItemToProject(projectNumber: number, issueUrl: string): Promise<string> {
  const result = await $`gh project item-add ${projectNumber} --owner ${GITHUB_ORG} --url ${issueUrl} --format json`.quiet().text();
  const parsed = JSON.parse(result);
  return parsed.id;
}

/**
 * List field metadata for a project (cached)
 */
export async function listProjectFields(projectNumber: number): Promise<ProjectField[]> {
  const cached = fieldCache.get(projectNumber);
  if (cached) return cached;

  const result = await $`gh project field-list ${projectNumber} --owner ${GITHUB_ORG} --format json`.quiet().text();
  const parsed = JSON.parse(result);
  const fields: ProjectField[] = (parsed.fields || []).map((f: any) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    options: f.options,
  }));

  fieldCache.set(projectNumber, fields);
  return fields;
}

/**
 * Resolve a field name + option name to their IDs
 */
export async function resolveFieldOption(
  projectNumber: number,
  fieldName: string,
  optionName: string,
): Promise<{ fieldId: string; optionId: string } | null> {
  const fields = await listProjectFields(projectNumber);
  const field = fields.find((f) => f.name.toLowerCase() === fieldName.toLowerCase());
  if (!field || !field.options) return null;

  const option = field.options.find((o) => o.name.toLowerCase() === optionName.toLowerCase());
  if (!option) return null;

  return { fieldId: field.id, optionId: option.id };
}

/**
 * Update a project item's field value
 */
export async function updateProjectItemField(
  projectId: string,
  itemId: string,
  fieldId: string,
  optionId: string,
): Promise<void> {
  await $`gh project item-edit --project-id ${projectId} --id ${itemId} --field-id ${fieldId} --single-select-option-id ${optionId}`.quiet();
}

/**
 * Set custom fields (Project, Priority, Status) on a project item
 */
export async function setItemFields(
  projectNumber: number,
  itemId: string,
  fields: { project?: string; priority?: string; status?: string },
): Promise<void> {
  const projectId = await getProjectId(projectNumber);

  const updates: Promise<void>[] = [];

  for (const [fieldName, value] of Object.entries(fields)) {
    if (!value) continue;
    const resolved = await resolveFieldOption(projectNumber, fieldName, value);
    if (resolved) {
      updates.push(updateProjectItemField(projectId, itemId, resolved.fieldId, resolved.optionId));
    }
  }

  await Promise.all(updates);
}
