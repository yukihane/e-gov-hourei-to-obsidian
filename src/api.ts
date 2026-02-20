import process from 'node:process';
import { toSafeTitle } from './notes.js';
import { writeJson } from './storage.js';
import { wait } from './utils.js';
import type { CliOptions, LawCandidate, LawDataResponse, LawDictionary } from './types.js';

/**
 * 指定URLのJSONを取得する。
 */
export async function fetchJson(url: string, retry: number): Promise<unknown> {
  let lastError: unknown;
  for (let i = 0; i < retry; i += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`APIエラー ${response.status} ${url}: ${body}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (i + 1 < retry) {
        await wait(2 ** i * 1000);
      }
    }
  }
  throw lastError;
}

/**
 * 法令候補検索API `/api/2/laws` の結果を候補配列へ変換する。
 */
export function parseLawCandidates(payload: unknown): LawCandidate[] {
  const root = payload as {
    laws?: Array<{ law_info?: Record<string, unknown>; revision_info?: Record<string, unknown> }>;
  };
  const list = root.laws ?? [];
  const candidates: LawCandidate[] = [];
  for (const item of list) {
    const lawInfo = item.law_info ?? {};
    const revisionInfo = item.revision_info ?? {};
    const lawTitle = typeof revisionInfo.law_title === 'string' ? revisionInfo.law_title : '';
    if (!lawTitle) {
      continue;
    }
    candidates.push({
      law_id: typeof lawInfo.law_id === 'string' ? lawInfo.law_id : undefined,
      law_num: typeof lawInfo.law_num === 'string' ? lawInfo.law_num : undefined,
      law_title: lawTitle,
      promulgation_date: typeof lawInfo.promulgation_date === 'string' ? lawInfo.promulgation_date : undefined,
    });
  }
  return candidates;
}

/**
 * 法令名を law_id に解決する。
 */
export async function resolveLawIdByTitle(options: CliOptions, lawTitle: string): Promise<LawCandidate> {
  const url = new URL('/api/2/laws', options.apiBaseUrl);
  url.searchParams.set('law_title', lawTitle);
  const payload = await fetchJson(url.toString(), options.retry);
  const candidates = parseLawCandidates(payload);

  if (candidates.length === 0) {
    throw new Error(`法令候補を抽出できませんでした: ${lawTitle}`);
  }
  if (candidates.length > 1) {
    process.stdout.write(
      `${JSON.stringify(
        {
          error: 'ambiguous_law_title',
          input: lawTitle,
          candidates,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(2);
  }
  return candidates[0];
}

/**
 * `/api/2/laws` を全件走査し、参照解決用の辞書ファイルを再生成する。
 */
export async function buildDictionary(options: CliOptions): Promise<void> {
  const dictionary: LawDictionary = {};
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = new URL('/api/2/laws', options.apiBaseUrl);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const payload = await fetchJson(url.toString(), options.retry);
    const candidates = parseLawCandidates(payload);
    if (candidates.length === 0) {
      break;
    }

    for (const item of candidates) {
      if (!item.law_id) {
        continue;
      }
      const safeTitle = toSafeTitle(item.law_title);
      dictionary[item.law_id] = {
        title: item.law_title,
        safe_title: safeTitle,
        file_name: `${safeTitle}_${item.law_id}.md`,
        updated_at: new Date().toISOString(),
      };
    }

    offset += limit;
  }

  await writeJson(options.dictionaryPath, dictionary);
  process.stdout.write(`辞書を生成しました: ${options.dictionaryPath} (${Object.keys(dictionary).length}件)\n`);
}

/**
 * `law_id` から法令名を取得し、辞書未登録エントリを補完する。
 */
export async function fetchLawTitleById(options: CliOptions, lawId: string): Promise<string | undefined> {
  const url = new URL(`/api/2/law_data/${lawId}`, options.apiBaseUrl);
  url.searchParams.set('response_format', 'json');
  const payload = (await fetchJson(url.toString(), options.retry)) as LawDataResponse;
  const revisionInfo = payload.revision_info ?? {};
  const title = revisionInfo.law_title;
  if (typeof title === 'string' && title.trim().length > 0) {
    return title.trim();
  }
  return undefined;
}
