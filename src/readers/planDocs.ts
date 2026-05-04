import { readFile } from 'fs/promises';
import { resolve } from 'path';

const DOCS_ROOT = process.env.DOCS_ROOT || '/home/pedro/PeteDio-Labs/docs';

export async function readPlanDoc(planFile: string): Promise<string> {
  // Allow relative paths from docs root or absolute paths
  const fullPath = planFile.startsWith('/')
    ? planFile
    : resolve(DOCS_ROOT, planFile);

  return readFile(fullPath, 'utf-8');
}

export async function readContextDocs(): Promise<string> {
  const files = [
    resolve(DOCS_ROOT, 'STATUS.md'),
    resolve(DOCS_ROOT, 'architecture/FUTURE-GOALS.md'),
  ];

  const parts: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8');
      parts.push(`--- ${file} ---\n${content}`);
    } catch {
      // File may not exist, skip
    }
  }

  return parts.join('\n\n');
}
