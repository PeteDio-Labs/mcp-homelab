/**
 * save_draft tool — Direct blog-api write, bypassing blog-agent.
 * Use when: Claude Code writes the post, or the blog-agent pipeline fails at save.
 */

import { createPost, updatePost, type BlogPostResponse } from '../clients/blogApi.js';

export interface SaveDraftResult {
  success: boolean;
  post?: BlogPostResponse;
  error?: string;
}

export async function saveDraft(
  title: string,
  content: string,
  excerpt: string,
  tags: string[],
  status: 'DRAFT' | 'PUBLISHED' = 'DRAFT',
): Promise<SaveDraftResult> {
  try {
    const post = await createPost({ title, content, excerpt, status, tags });
    return { success: true, post };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function publishPost(id: number): Promise<SaveDraftResult> {
  try {
    const post = await updatePost(id, { status: 'PUBLISHED' });
    return { success: true, post };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
