/**
 * Blog API Client for direct draft management.
 * Bypasses blog-agent — used as a fallback or for direct Claude Code writes.
 */

import type { BlogPostRequest, BlogPostResponse } from '@petedio/shared';
export type { BlogPostRequest, BlogPostResponse };

const BLOG_API_URL = process.env.BLOG_API_URL || 'http://localhost:8080';

export async function createPost(post: BlogPostRequest): Promise<BlogPostResponse> {
  const res = await fetch(`${BLOG_API_URL}/api/v1/admin/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(post),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Blog API POST /admin/posts failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<BlogPostResponse>;
}

export async function updatePost(id: number, update: Partial<BlogPostRequest>): Promise<BlogPostResponse> {
  const res = await fetch(`${BLOG_API_URL}/api/v1/admin/posts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Blog API PUT /admin/posts/${id} failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<BlogPostResponse>;
}

export async function listPosts(status?: string): Promise<BlogPostResponse[]> {
  const params = new URLSearchParams({ size: '50' });
  if (status) params.set('status', status);

  const res = await fetch(`${BLOG_API_URL}/api/v1/admin/posts?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Blog API GET /admin/posts failed (${res.status}): ${body}`);
  }

  const data = await res.json() as { content: BlogPostResponse[] };
  return data.content;
}

export async function healthCheck(): Promise<boolean> {
  try {
    const res = await fetch(`${BLOG_API_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
