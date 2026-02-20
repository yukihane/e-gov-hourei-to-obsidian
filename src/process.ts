import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchLawTitleById } from './api.js';
import {
  addExistingNoteIndex,
  buildExistingNoteIndex,
  getFileName,
  notePath,
  resolveExistingNotePath,
  scanReferencedLawIdsFromMarkdown,
  toSafeTitle,
} from './notes.js';
import { collectReferencedLawIds, renderMarkdown } from './render.js';
import { scrapeLawDocumentWithRetry } from './scrape.js';
import { appendUnresolved, writeJson } from './storage.js';
import type { CliOptions, ExistingNoteIndex, LawDictionary, ProcessContext, QueueItem } from './types.js';

async function ensureOutputDir(outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
}

async function removeOldNoteIfRenamed(
  outputDir: string,
  oldFileName: string,
  newFileName: string,
  existingIndex: ExistingNoteIndex,
  lawId: string,
): Promise<void> {
  if (!oldFileName || oldFileName === newFileName) {
    return;
  }
  const oldPath = notePath(outputDir, oldFileName);
  try {
    await fs.unlink(oldPath);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== 'ENOENT') {
      throw error;
    }
  }
  const current = existingIndex.get(lawId) ?? [];
  const filtered = current.filter((candidate) => path.basename(candidate) !== oldFileName);
  if (filtered.length > 0) {
    existingIndex.set(lawId, filtered);
  } else {
    existingIndex.delete(lawId);
  }
}

/**
 * BFSで法令を取得し、Markdownへ変換して保存する。
 */
export async function processLawGraph(
  options: CliOptions,
  rootLawId: string,
  rootLawTitle: string,
  dictionary: LawDictionary,
): Promise<void> {
  await ensureOutputDir(options.outputDir);
  const existingIndex: ExistingNoteIndex =
    options.ifExists === 'skip' ? await buildExistingNoteIndex(options.outputDir) : new Map();

  const queue: QueueItem[] = [{ lawId: rootLawId, titleHint: rootLawTitle, depth: 0 }];
  const visited = new Set<string>();
  const context: ProcessContext = {
    rootLawId,
    rootLawTitle,
    unresolved: [],
    unresolvedSeen: new Set(),
  };

  while (queue.length > 0) {
    const item = queue.shift() as QueueItem;
    if (item.depth > options.maxDepth) {
      continue;
    }
    if (visited.has(item.lawId)) {
      continue;
    }
    visited.add(item.lawId);

    const dictEntry = dictionary[item.lawId] ?? {
      title: item.titleHint ?? `law_${item.lawId}`,
      safe_title: toSafeTitle(item.titleHint ?? `law_${item.lawId}`),
      file_name: getFileName(item.lawId, item.titleHint ?? `law_${item.lawId}`),
      updated_at: new Date().toISOString(),
    };
    dictionary[item.lawId] = dictEntry;

    if (options.ifExists === 'skip') {
      const existingNotePath = await resolveExistingNotePath(
        options.outputDir,
        item.lawId,
        dictEntry.file_name,
        existingIndex,
      );
      if (existingNotePath) {
        const existingMarkdown = await fs.readFile(existingNotePath, 'utf8');
        const scan = scanReferencedLawIdsFromMarkdown(existingMarkdown);
        for (const lawId of scan.referencedLawIds) {
          queue.push({ lawId, depth: item.depth + 1 });
        }
        const existingFileName = path.basename(existingNotePath);
        if (dictEntry.file_name !== existingFileName) {
          dictionary[item.lawId] = {
            ...dictEntry,
            file_name: existingFileName,
            updated_at: new Date().toISOString(),
          };
        }
        process.stdout.write(`skip existing: ${existingFileName}\n`);
        continue;
      }
    }

    process.stdout.write(`取得中: ${dictEntry.title} (${item.lawId}) depth=${item.depth}\n`);

    const scraped = await scrapeLawDocumentWithRetry(item.lawId, options);
    const previousFileName = dictEntry.file_name;

    const freshFileName = getFileName(item.lawId, scraped.title);
    dictionary[item.lawId] = {
      title: scraped.title,
      safe_title: toSafeTitle(scraped.title),
      file_name: freshFileName,
      updated_at: new Date().toISOString(),
    };

    const referencedIds = collectReferencedLawIds(scraped);
    for (const referencedLawId of referencedIds) {
      if (dictionary[referencedLawId]) {
        continue;
      }
      if (options.dictionaryAutoupdate) {
        try {
          const resolvedTitle = await fetchLawTitleById(options, referencedLawId);
          if (resolvedTitle) {
            const safeTitle = toSafeTitle(resolvedTitle);
            dictionary[referencedLawId] = {
              title: resolvedTitle,
              safe_title: safeTitle,
              file_name: `${safeTitle}_${referencedLawId}.md`,
              updated_at: new Date().toISOString(),
            };
            continue;
          }
        } catch {
          // API障害時はフォールバック名で継続する。処理停止より欠損最小化を優先する。
        }
      }
      dictionary[referencedLawId] = {
        title: `law_${referencedLawId}`,
        safe_title: `law_${referencedLawId}`,
        file_name: `law_${referencedLawId}.md`,
        updated_at: new Date().toISOString(),
      };
    }

    const rendered = renderMarkdown(scraped, dictionary, options, context, item.depth);
    if (rendered.dictionaryDirty) {
      await writeJson(options.dictionaryPath, dictionary);
    }

    const freshFilePath = notePath(options.outputDir, freshFileName);
    await fs.writeFile(freshFilePath, rendered.markdown, 'utf8');
    await removeOldNoteIfRenamed(
      options.outputDir,
      previousFileName,
      freshFileName,
      existingIndex,
      item.lawId,
    );
    addExistingNoteIndex(existingIndex, item.lawId, freshFilePath);

    for (const lawId of rendered.referencedLawIds) {
      queue.push({ lawId, depth: item.depth + 1 });
    }
  }

  await writeJson(options.dictionaryPath, dictionary);
  await appendUnresolved(options.unresolvedPath, context.unresolved);
}
