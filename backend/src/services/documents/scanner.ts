import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { sha256 } from '../../utils/hash.js';

export interface ScannedFile {
  relativePath: string;
  absolutePath: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  contentHash: string;
  lastModifiedAt: Date;
  oversized: boolean;
}

const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx']);
const MAX_FILES = 300;
const MAX_DEPTH = 4;

async function walk(
  root: string,
  current: string,
  depth: number,
  results: Array<{ relativePath: string; absolutePath: string; stat: import('node:fs').Stats }>,
): Promise<void> {
  if (depth > MAX_DEPTH || results.length >= MAX_FILES) return;
  const entries = await fs.readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= MAX_FILES) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const absolutePath = path.join(current, entry.name);
    // Never follow symlinks: the documents folder must not become an arbitrary read surface.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(root, absolutePath, depth + 1, results);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

    const stat = await fs.stat(absolutePath);
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/');
    results.push({ relativePath, absolutePath, stat });
  }
}

export async function scanDocumentsFolder(
  root = env.documentsPath,
): Promise<{ files: ScannedFile[]; rootExists: boolean; truncated: boolean }> {
  const resolvedRoot = path.resolve(root);
  try {
    const stat = await fs.stat(resolvedRoot);
    if (!stat.isDirectory()) return { files: [], rootExists: false, truncated: false };
  } catch {
    return { files: [], rootExists: false, truncated: false };
  }

  const raw: Array<{ relativePath: string; absolutePath: string; stat: import('node:fs').Stats }> = [];
  await walk(resolvedRoot, resolvedRoot, 0, raw);

  const files: ScannedFile[] = [];
  for (const item of raw) {
    // Defence in depth: the resolved path must stay inside the configured root.
    if (!item.absolutePath.startsWith(resolvedRoot + path.sep)) continue;
    const oversized = item.stat.size > env.maxDocumentSizeBytes;
    let contentHash = '';
    if (!oversized) {
      const buffer = await fs.readFile(item.absolutePath);
      contentHash = sha256(buffer);
    }
    files.push({
      relativePath: item.relativePath,
      absolutePath: item.absolutePath,
      filename: path.basename(item.absolutePath),
      extension: path.extname(item.absolutePath).toLowerCase(),
      sizeBytes: item.stat.size,
      contentHash,
      lastModifiedAt: item.stat.mtime,
      oversized,
    });
  }

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, rootExists: true, truncated: raw.length >= MAX_FILES };
}
