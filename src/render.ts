import {
  DEFAULT_API_BASE,
  DEFAULT_DICTIONARY_PATH,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_UNRESOLVED_PATH,
} from './config.js';
import { unresolvedKey } from './storage.js';
import type {
  CliOptions,
  LawDictionary,
  LawDictionaryEntry,
  ProcessContext,
  ScrapedLawDocument,
  UnresolvedRefRecord,
} from './types.js';

function escapeYaml(value: string): string {
  return JSON.stringify(value);
}

export function parseLawIdFromHref(href: string): { lawId: string; anchor?: string } | undefined {
  const normalizedHref = href.trim();
  const matched = normalizedHref.match(
    /^(?:https?:\/\/laws\.e-gov\.go\.jp)?\/law\/([A-Za-z0-9]+)\/?(?:#([A-Za-z0-9_-]+))?$/,
  );
  if (!matched) {
    return undefined;
  }
  return { lawId: matched[1], anchor: matched[2] };
}

export function collectReferencedLawIds(doc: ScrapedLawDocument): string[] {
  const ids = new Set<string>();
  for (const block of doc.blocks) {
    for (const paragraph of block.paragraphs) {
      for (const segment of paragraph.segments) {
        if (segment.type !== 'link') {
          continue;
        }
        const parsed = parseLawIdFromHref(segment.href);
        if (parsed) {
          ids.add(parsed.lawId);
        }
      }
    }
  }
  return [...ids];
}

function isFallbackDictionaryEntry(lawId: string, entry: LawDictionaryEntry): boolean {
  return entry.file_name === `law_${lawId}.md`;
}

/**
 * 抽出済み条文データをObsidian向けMarkdownへレンダリングする。
 */
export function renderMarkdown(
  doc: ScrapedLawDocument,
  dictionary: LawDictionary,
  options: CliOptions,
  context: ProcessContext,
  currentDepth: number,
): { markdown: string; referencedLawIds: string[]; dictionaryDirty: boolean } {
  const lines: string[] = [];
  const referencedLawIds: string[] = [];
  const referencedLawIdSet = new Set<string>();
  let dictionaryDirty = false;

  lines.push('---');
  lines.push(`law_id: ${doc.lawId}`);
  lines.push(`title: ${escapeYaml(doc.title)}`);
  lines.push(`source_url: ${doc.sourceUrl}`);
  lines.push(`fetched_at: ${new Date().toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${doc.title}`);
  lines.push('');

  for (const block of doc.blocks) {
    lines.push(`## ${block.heading}`);
    if (block.id) {
      lines.push(`<a id="${block.id}"></a>`);
    }
    lines.push('');

    for (const paragraph of block.paragraphs) {
      const renderedSegments: string[] = [];
      for (const segment of paragraph.segments) {
        if (segment.type === 'text') {
          renderedSegments.push(segment.text);
          continue;
        }

        const href = segment.href.trim();
        const linkText = segment.text || href;

        if (!href) {
          renderedSegments.push(linkText);
          continue;
        }
        if (href.startsWith('#')) {
          const anchor = href.replace(/^#/, '').trim();
          renderedSegments.push(`[[#${anchor}|${linkText}]]`);
          continue;
        }

        const parsed = parseLawIdFromHref(href);
        if (parsed) {
          let entry = dictionary[parsed.lawId];
          if (!entry) {
            entry = {
              title: `law_${parsed.lawId}`,
              safe_title: `law_${parsed.lawId}`,
              file_name: `law_${parsed.lawId}.md`,
              updated_at: new Date().toISOString(),
            };
            dictionary[parsed.lawId] = entry;
            dictionaryDirty = true;

            const unresolved: UnresolvedRefRecord = {
              timestamp: new Date().toISOString(),
              root_law_id: context.rootLawId,
              root_law_title: context.rootLawTitle,
              from_anchor: paragraph.anchor,
              raw_text: linkText,
              href,
              reason: 'target_not_built',
            };
            const key = unresolvedKey(unresolved);
            if (!context.unresolvedSeen.has(key)) {
              context.unresolvedSeen.add(key);
              context.unresolved.push(unresolved);
            }
          }
          if (isFallbackDictionaryEntry(parsed.lawId, entry)) {
            const unresolved: UnresolvedRefRecord = {
              timestamp: new Date().toISOString(),
              root_law_id: context.rootLawId,
              root_law_title: context.rootLawTitle,
              from_anchor: paragraph.anchor,
              raw_text: linkText,
              href,
              reason: 'target_not_built',
            };
            const key = unresolvedKey(unresolved);
            if (!context.unresolvedSeen.has(key)) {
              context.unresolvedSeen.add(key);
              context.unresolved.push(unresolved);
            }
          }

          if (currentDepth + 1 > options.maxDepth) {
            const unresolved: UnresolvedRefRecord = {
              timestamp: new Date().toISOString(),
              root_law_id: context.rootLawId,
              root_law_title: context.rootLawTitle,
              from_anchor: paragraph.anchor,
              raw_text: linkText,
              href,
              reason: 'depth_limit',
            };
            const key = unresolvedKey(unresolved);
            if (!context.unresolvedSeen.has(key)) {
              context.unresolvedSeen.add(key);
              context.unresolved.push(unresolved);
            }
          } else if (!referencedLawIdSet.has(parsed.lawId)) {
            referencedLawIdSet.add(parsed.lawId);
            referencedLawIds.push(parsed.lawId);
          }

          const target = parsed.anchor ? `laws/${entry.file_name}#${parsed.anchor}` : `laws/${entry.file_name}`;
          renderedSegments.push(`[[${target}|${linkText}]]`);
          continue;
        }

        if (href.startsWith('http://') || href.startsWith('https://')) {
          renderedSegments.push(`[${linkText}](${href})`);
          continue;
        }

        const unresolved: UnresolvedRefRecord = {
          timestamp: new Date().toISOString(),
          root_law_id: context.rootLawId,
          root_law_title: context.rootLawTitle,
          from_anchor: paragraph.anchor,
          raw_text: linkText,
          href,
          reason: 'unknown_format',
        };
        const key = unresolvedKey(unresolved);
        if (!context.unresolvedSeen.has(key)) {
          context.unresolvedSeen.add(key);
          context.unresolved.push(unresolved);
        }
        renderedSegments.push(linkText);
      }

      const paragraphText = renderedSegments.join('').replace(/\s+/g, ' ').trim();
      if (paragraphText) {
        lines.push(`<a id="${paragraph.anchor}"></a>`);
        lines.push(paragraphText);
        lines.push('');
      }
    }
  }

  return {
    markdown: `${lines.join('\n').trimEnd()}\n`,
    referencedLawIds,
    dictionaryDirty,
  };
}

/**
 * フィクスチャテスト用に最小コンテキストでMarkdownを生成する。
 */
export function renderMarkdownForTest(doc: ScrapedLawDocument): string {
  const result = renderMarkdown(
    doc,
    {},
    {
      buildDictionary: false,
      maxDepth: 1,
      ifExists: 'overwrite',
      retry: 3,
      timeoutMs: 30_000,
      dictionaryPath: DEFAULT_DICTIONARY_PATH,
      dictionaryAutoupdate: false,
      unresolvedPath: DEFAULT_UNRESOLVED_PATH,
      outputDir: DEFAULT_OUTPUT_DIR,
      apiBaseUrl: DEFAULT_API_BASE,
    },
    {
      rootLawId: doc.lawId,
      rootLawTitle: doc.title,
      unresolved: [],
      unresolvedSeen: new Set(),
    },
    0,
  );
  return result.markdown;
}
