import { parseArgs } from './args.js';
import { buildDictionary, resolveLawIdByTitle } from './api.js';
import { processLawGraph } from './process.js';
import { loadDictionary, mergeUnresolvedRecords } from './storage.js';

export { extractLawDocumentFromPage } from './scrape.js';
export { renderMarkdownForTest, parseLawIdFromHref } from './render.js';
export {
  buildExistingNoteIndex,
  resolveExistingNotePath,
  scanReferencedLawIdsFromMarkdown,
  toSafeTitle,
} from './notes.js';
export { mergeUnresolvedRecords };

/**
 * CLIのメイン処理を実行する。
 */
export async function runCli(argv: string[]): Promise<void> {
  const options = parseArgs(argv);

  if (options.buildDictionary) {
    await buildDictionary(options);
    return;
  }

  const dictionary = await loadDictionary(options.dictionaryPath);

  let rootLawId = options.lawId;
  let rootTitle = options.lawTitle;

  if (!rootLawId && rootTitle) {
    const resolved = await resolveLawIdByTitle(options, rootTitle);
    if (!resolved.law_id) {
      throw new Error(`law_id がありません: ${rootTitle}`);
    }
    rootLawId = resolved.law_id;
    rootTitle = resolved.law_title;
  }

  if (!rootLawId) {
    throw new Error('law_id がありません');
  }

  await processLawGraph(options, rootLawId, rootTitle ?? `law_${rootLawId}`, dictionary);
}
