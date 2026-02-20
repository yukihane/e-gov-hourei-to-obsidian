import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { ExistingNoteIndex, ExistingReferenceScanResult } from './types.js';

export function toSafeTitle(title: string): string {
  const normalized = title
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= 80) {
    return normalized || 'law';
  }
  return normalized.slice(0, 80).trim() || 'law';
}

export function getFileName(lawId: string, title: string): string {
  const safeTitle = toSafeTitle(title);
  return `${safeTitle}_${lawId}.md`;
}

export function notePath(outputDir: string, fileName: string): string {
  return path.join(outputDir, fileName);
}

function parseLawIdFromNoteFileName(fileName: string): string | undefined {
  const matched = fileName.match(/_([A-Za-z0-9]+)\.md$/);
  if (!matched) {
    return undefined;
  }
  return matched[1];
}

export function addExistingNoteIndex(index: ExistingNoteIndex, lawId: string, filePath: string): void {
  const paths = index.get(lawId) ?? [];
  if (!paths.includes(filePath)) {
    paths.push(filePath);
    paths.sort((a, b) => a.localeCompare(b));
    index.set(lawId, paths);
  }
}

/**
 * `laws` 配下を走査し、`law_id -> 既存ノートパス一覧` の索引を構築する。
 */
export async function buildExistingNoteIndex(outputDir: string): Promise<ExistingNoteIndex> {
  const index: ExistingNoteIndex = new Map();
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return index;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const lawId = parseLawIdFromNoteFileName(entry.name);
    if (!lawId) {
      continue;
    }
    addExistingNoteIndex(index, lawId, path.join(outputDir, entry.name));
  }
  return index;
}

/**
 * skip判定用に既存ノートの実体パスを解決する。
 */
export async function resolveExistingNotePath(
  outputDir: string,
  lawId: string,
  dictFileName: string,
  existingIndex: ExistingNoteIndex,
): Promise<string | undefined> {
  const dictPath = notePath(outputDir, dictFileName);
  try {
    await fs.access(dictPath);
    return dictPath;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }
  const candidates = existingIndex.get(lawId) ?? [];
  return candidates[0];
}

/**
 * 既存Markdown中のObsidianリンクから参照先law_idを抽出する。
 */
export function scanReferencedLawIdsFromMarkdown(markdown: string): ExistingReferenceScanResult {
  const ids = new Set<string>();
  const re = /\[\[laws\/[^\]]*?_([A-Za-z0-9]+)\.md(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    ids.add(match[1]);
  }
  return { referencedLawIds: [...ids] };
}
