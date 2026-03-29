import { gatherContext, formatContextForWriter } from './gatherContext.js';

export interface TriggerResult {
  success: boolean;
  runId?: string;
  status?: string;
  error?: string;
}

export async function triggerPipeline(
  docsRoot: string,
  blogAgentUrl: string,
  contentType: string,
  topic?: string,
  providedContext?: Record<string, unknown>,
): Promise<TriggerResult> {
  // If no context provided, gather it automatically
  let projectDocs: string;
  if (providedContext?.projectDocs) {
    projectDocs = typeof providedContext.projectDocs === 'string'
      ? providedContext.projectDocs
      : JSON.stringify(providedContext.projectDocs);
  } else {
    const ctx = await gatherContext(docsRoot);
    projectDocs = formatContextForWriter(ctx);
  }

  const body = {
    contentType,
    ...(topic && { topic }),
    context: {
      projectDocs,
    },
  };

  const url = `${blogAgentUrl.replace(/\/$/, '')}/api/v1/generate`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `Blog agent responded with ${response.status}: ${text}`,
      };
    }

    const data = await response.json() as Record<string, unknown>;
    return {
      success: true,
      runId: data.id as string,
      status: data.status as string,
    };
  } catch (err) {
    return {
      success: false,
      error: `Failed to reach blog agent at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
