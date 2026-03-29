import { readdir, stat } from 'fs/promises';
import { join } from 'path';

export interface DocEntry {
  path: string;
  category: string;
  lastModified: string;
  sizeBytes: number;
}

const SCAN_TARGETS: { pattern: string; category: string; dir: string }[] = [
  { pattern: 'STATUS.md', category: 'status', dir: '' },
  { pattern: 'SESSION-SUMMARY-', category: 'sessions', dir: 'sessions' },
  { pattern: 'FUTURE-GOALS.md', category: 'architecture', dir: 'architecture' },
];

export async function listDocs(
  docsRoot: string,
  category: string = 'all',
): Promise<DocEntry[]> {
  const entries: DocEntry[] = [];

  for (const target of SCAN_TARGETS) {
    if (category !== 'all' && category !== target.category) continue;

    const dir = join(docsRoot, target.dir);

    try {
      if (target.dir === '') {
        // Single file at docs root
        const filePath = join(dir, target.pattern);
        const s = await stat(filePath);
        entries.push({
          path: filePath,
          category: target.category,
          lastModified: s.mtime.toISOString(),
          sizeBytes: s.size,
        });
      } else {
        // Scan directory for matching files
        const files = await readdir(dir);
        for (const file of files) {
          if (!file.startsWith(target.pattern)) continue;
          const filePath = join(dir, file);
          const s = await stat(filePath);
          entries.push({
            path: filePath,
            category: target.category,
            lastModified: s.mtime.toISOString(),
            sizeBytes: s.size,
          });
        }
      }
    } catch {
      // Directory or file doesn't exist, skip
    }
  }

  return entries.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}
