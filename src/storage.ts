import fs from 'node:fs/promises';
import path from 'node:path';
import type { LawDictionary, UnresolvedRefRecord } from './types.js';

export function unresolvedKey(item: UnresolvedRefRecord): string {
  return `${item.root_law_id}\t${item.from_anchor}\t${item.raw_text}\t${item.href}`;
}

/**
 * 未解決参照配列を重複キーでマージする。
 */
export function mergeUnresolvedRecords(
  existing: UnresolvedRefRecord[],
  incoming: UnresolvedRefRecord[],
): UnresolvedRefRecord[] {
  const seen = new Set(existing.map((item) => unresolvedKey(item)));
  const merged = [...existing];
  for (const item of incoming) {
    const key = unresolvedKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * 指定パスにJSONを保存する。
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

export async function loadDictionary(filePath: string): Promise<LawDictionary> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return JSON.parse(content) as LawDictionary;
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function loadExistingUnresolved(filePath: string): Promise<UnresolvedRefRecord[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is UnresolvedRefRecord => {
      const value = item as Partial<UnresolvedRefRecord>;
      return (
        typeof value.root_law_id === 'string' &&
        typeof value.from_anchor === 'string' &&
        typeof value.raw_text === 'string' &&
        typeof value.href === 'string'
      );
    });
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function appendUnresolved(filePath: string, items: UnresolvedRefRecord[]): Promise<void> {
  const existing = await loadExistingUnresolved(filePath);
  const merged = mergeUnresolvedRecords(existing, items);
  await writeJson(filePath, merged);
}
