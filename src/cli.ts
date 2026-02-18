import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { chromium, type Page } from 'playwright';

const DEFAULT_API_BASE = 'https://laws.e-gov.go.jp';
const DEFAULT_DICTIONARY_PATH = 'data/law_dictionary.json';
const DEFAULT_UNRESOLVED_PATH = 'data/unresolved_refs.json';
const DEFAULT_OUTPUT_DIR = 'laws';

interface CliOptions {
  lawId?: string;
  lawTitle?: string;
  buildDictionary: boolean;
  maxDepth: number;
  ifExists: 'overwrite' | 'skip';
  retry: number;
  timeoutMs: number;
  dictionaryPath: string;
  dictionaryAutoupdate: boolean;
  unresolvedPath: string;
  outputDir: string;
  apiBaseUrl: string;
}

interface LawCandidate {
  law_id?: string;
  law_num?: string;
  law_title: string;
  promulgation_date?: string;
}

interface LawDictionaryEntry {
  title: string;
  safe_title: string;
  file_name: string;
  updated_at: string;
}

type LawDictionary = Record<string, LawDictionaryEntry>;

interface UnresolvedRefRecord {
  timestamp: string;
  root_law_id: string;
  root_law_title: string;
  from_anchor: string;
  raw_text: string;
  href: string;
  reason: 'target_not_built' | 'unknown_format' | 'depth_limit';
}

interface SegmentText {
  type: 'text';
  text: string;
}

interface SegmentLink {
  type: 'link';
  text: string;
  href: string;
}

type ParagraphSegment = SegmentText | SegmentLink;

interface ArticleParagraph {
  anchor: string;
  segments: ParagraphSegment[];
}

interface ArticleBlock {
  id: string;
  heading: string;
  paragraphs: ArticleParagraph[];
}

export interface ScrapedLawDocument {
  lawId: string;
  title: string;
  sourceUrl: string;
  blocks: ArticleBlock[];
}

interface QueueItem {
  lawId: string;
  titleHint?: string;
  depth: number;
}

interface ProcessContext {
  rootLawId: string;
  rootLawTitle: string;
  unresolved: UnresolvedRefRecord[];
  unresolvedSeen: Set<string>;
}

interface ExistingReferenceScanResult {
  referencedLawIds: string[];
}

interface LawDataResponse {
  law_info?: Record<string, unknown>;
  revision_info?: Record<string, unknown>;
}

/**
 * CLI引数を解釈し、処理に必要なオプションを構築する。
 * 対話入力を行わない前提のため、曖昧な引数はここで早期に弾く。
 */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
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
  };

  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--law-id') {
      options.lawId = argv[++i];
      continue;
    }
    if (arg === '--build-dictionary') {
      options.buildDictionary = true;
      continue;
    }
    if (arg === '--max-depth') {
      options.maxDepth = Number(argv[++i]);
      continue;
    }
    if (arg === '--if-exists') {
      const v = argv[++i];
      if (v !== 'overwrite' && v !== 'skip') {
        throw new Error(`--if-exists は overwrite または skip を指定してください: ${v}`);
      }
      options.ifExists = v;
      continue;
    }
    if (arg === '--retry') {
      options.retry = Number(argv[++i]);
      continue;
    }
    if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++i]);
      continue;
    }
    if (arg === '--dictionary') {
      options.dictionaryPath = argv[++i];
      continue;
    }
    if (arg === '--dictionary-autoupdate') {
      options.dictionaryAutoupdate = true;
      continue;
    }
    if (arg === '--unresolved-path') {
      options.unresolvedPath = argv[++i];
      continue;
    }
    if (arg === '--output-dir') {
      options.outputDir = argv[++i];
      continue;
    }
    if (arg === '--api-base-url') {
      options.apiBaseUrl = argv[++i];
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`未対応オプションです: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    options.lawTitle = positional.join(' ');
  }

  if (!options.buildDictionary && !options.lawId && !options.lawTitle) {
    throw new Error('法令名または --law-id を指定してください');
  }
  if (options.maxDepth < 0 || Number.isNaN(options.maxDepth)) {
    throw new Error('--max-depth は0以上の整数にしてください');
  }
  if (options.retry <= 0 || Number.isNaN(options.retry)) {
    throw new Error('--retry は1以上の整数にしてください');
  }
  if (options.timeoutMs <= 0 || Number.isNaN(options.timeoutMs)) {
    throw new Error('--timeout-ms は1以上の整数にしてください');
  }

  return options;
}

/**
 * 指定URLのJSONを取得する。
 * APIの一時失敗を吸収するため、指数バックオフ付きで再試行する。
 */
async function fetchJson(url: string, retry: number): Promise<unknown> {
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLawSiteBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/api\/2\/?$/, '').replace(/\/$/, '');
}

/**
 * 本文ルートがSPA描画で遅延するため、複数候補セレクタのいずれかが現れるまで待機する。
 */
async function waitForProvisionRoot(page: Page, timeoutMs: number): Promise<void> {
  const selectors = ['#MainProvision', '#provisionview', 'main.main-content'];
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = await page.evaluate((candidates) => {
      return candidates.some((selector) => document.querySelector(selector) !== null);
    }, selectors);
    if (found) {
      return;
    }
    await wait(200);
  }
  throw new Error('本文セレクタ未検出');
}

/**
 * 法令候補検索API `/api/2/laws` の結果を候補配列へ変換する。
 * Swagger定義に合わせ、`law_info` と `revision_info` から必要情報のみを抜き出す。
 */
function parseLawCandidates(payload: unknown): LawCandidate[] {
  const root = payload as { laws?: Array<{ law_info?: Record<string, unknown>; revision_info?: Record<string, unknown> }> };
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
 * 候補が複数ある場合は非対話でJSONを出力し、終了コード2で呼び出し元に判断を委ねる。
 */
async function resolveLawIdByTitle(options: CliOptions, lawTitle: string): Promise<LawCandidate> {
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
async function buildDictionary(options: CliOptions): Promise<void> {
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
 * `--dictionary-autoupdate` 用で、取得失敗時はフォールバック名を返す。
 */
async function fetchLawTitleById(options: CliOptions, lawId: string): Promise<string | undefined> {
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

/**
 * 指定パスにJSONを保存する。
 * 親ディレクトリを先に作成して、初回実行でも失敗しないようにする。
 */
async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function loadDictionary(filePath: string): Promise<LawDictionary> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content) as LawDictionary;
    return parsed;
  } catch (error) {
    const maybeNodeError = error as NodeJS.ErrnoException;
    if (maybeNodeError.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

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

function getFileName(lawId: string, title: string): string {
  const safeTitle = toSafeTitle(title);
  return `${safeTitle}_${lawId}.md`;
}

/**
 * e-Govの法令ページをスクレイピングし、条文単位の構造化データへ変換する。
 * HTML断片ではなく実DOMを使うのは、リンク情報を欠落させないため。
 */
async function scrapeLawDocument(lawId: string, options: CliOptions): Promise<ScrapedLawDocument> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const sourceUrl = `${getLawSiteBaseUrl(options.apiBaseUrl)}/law/${lawId}`;

  try {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs });
    await page.waitForLoadState('networkidle', { timeout: options.timeoutMs }).catch(() => undefined);
    await waitForProvisionRoot(page, options.timeoutMs);
    return extractLawDocumentFromPage(page, lawId, sourceUrl);
  } finally {
    await browser.close();
  }
}

/**
 * 既に読み込まれたページDOMから本文構造を抽出する。
 * テストではローカル保存HTMLを `page.setContent` したページにも再利用する。
 */
export async function extractLawDocumentFromPage(
  page: Page,
  lawId: string,
  sourceUrl: string,
): Promise<ScrapedLawDocument> {
  const result = await page.evaluate(() => {
    const provisionRoot =
      document.querySelector('#MainProvision') ??
      document.querySelector('#provisionview') ??
      document.querySelector('main.main-content');
    if (!provisionRoot) {
      throw new Error('本文セレクタ未検出');
    }

    const title =
      document.querySelector('h1')?.textContent?.trim() ??
      document.title.replace(' | e-Gov 法令検索', '').trim() ??
      '無題法令';

    const articleNodes = Array.from(provisionRoot.querySelectorAll<HTMLElement>('article.article[id]'));
    const fallbackArticleNodes =
      articleNodes.length > 0
        ? articleNodes
        : Array.from(
            provisionRoot.querySelectorAll<HTMLElement>(
              '[id^="Mp-"], [id^="Sup-"], [id^="App-"], [id^="Ap-"], [id^="Enf-"]',
            ),
          );

    const blocks = fallbackArticleNodes.map((article) => {
      const heading =
        article.querySelector<HTMLElement>('.articleheading, .paragraphtitle, .istitle')?.innerText.trim() ??
        article.getAttribute('id') ??
        '条文';

      const paragraphNodes = Array.from(article.querySelectorAll<HTMLElement>('p.sentence'));
      const paragraphs = paragraphNodes.map((p, index) => {
        const anchor = p.getAttribute('id') ?? `${article.id}-p${index + 1}`;
        const segments: ParagraphSegment[] = [];

        // a[href]以外の参照文言は推測リンク化せず、テキストのまま保持する。
        const collect = (node: Node): void => {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent ?? '';
            if (text) {
              segments.push({ type: 'text', text });
            }
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
          }
          const element = node as HTMLElement;
          if (element.tagName.toLowerCase() === 'a' && element.hasAttribute('href')) {
            segments.push({
              type: 'link',
              text: element.textContent?.trim() ?? '',
              href: element.getAttribute('href') ?? '',
            });
            return;
          }
          for (const child of Array.from(element.childNodes)) {
            collect(child);
          }
        };
        for (const child of Array.from(p.childNodes)) {
          collect(child);
        }

        return { anchor, segments };
      });

      return {
        id: article.getAttribute('id') ?? '',
        heading,
        paragraphs,
      };
    });

    return { title, blocks };
  });

  return {
    lawId,
    title: result.title,
    sourceUrl,
    blocks: result.blocks,
  };
}

/**
 * 法令ページ取得を再試行付きで実行する。
 * SPA表示遅延や一時的なナビゲーション失敗を吸収し、計画書のバックオフ方針に合わせる。
 */
async function scrapeLawDocumentWithRetry(lawId: string, options: CliOptions): Promise<ScrapedLawDocument> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.retry; attempt += 1) {
    try {
      return await scrapeLawDocument(lawId, options);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < options.retry) {
        await wait(2 ** attempt * 1000);
      }
    }
  }
  throw lastError;
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

function unresolvedKey(item: UnresolvedRefRecord): string {
  return `${item.root_law_id}\t${item.from_anchor}\t${item.raw_text}\t${item.href}`;
}

function collectReferencedLawIds(doc: ScrapedLawDocument): string[] {
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
 * 同時に参照先law_idを抽出して、再帰取得キューに渡す。
 */
function renderMarkdown(
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

          const target = parsed.anchor
            ? `laws/${entry.file_name}#${parsed.anchor}`
            : `laws/${entry.file_name}`;
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
 * 本番処理と同じレンダラを通すことで、差分を出さない検証を行う。
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

function escapeYaml(value: string): string {
  return JSON.stringify(value);
}

async function ensureOutputDir(outputDir: string): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
}

function notePath(outputDir: string, fileName: string): string {
  return path.join(outputDir, fileName);
}

/**
 * 既存Markdown中のObsidianリンクから参照先law_idを抽出する。
 * skipモードでも再帰収集を継続するために必要。
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

async function appendUnresolved(filePath: string, items: UnresolvedRefRecord[]): Promise<void> {
  const existing = await loadExistingUnresolved(filePath);
  const seen = new Set(existing.map((item) => unresolvedKey(item)));
  const merged = [...existing];

  for (const item of items) {
    const key = unresolvedKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }

  await writeJson(filePath, merged);
}

/**
 * BFSで法令を取得し、Markdownへ変換して保存する。
 * `--if-exists=skip` の場合は既存ノートを再利用しつつ参照先探索のみ継続する。
 */
async function processLawGraph(
  options: CliOptions,
  rootLawId: string,
  rootLawTitle: string,
  dictionary: LawDictionary,
): Promise<void> {
  await ensureOutputDir(options.outputDir);

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

    const filePath = notePath(options.outputDir, dictEntry.file_name);

    if (options.ifExists === 'skip') {
      try {
        const existingMarkdown = await fs.readFile(filePath, 'utf8');
        const scan = scanReferencedLawIdsFromMarkdown(existingMarkdown);
        for (const lawId of scan.referencedLawIds) {
          queue.push({ lawId, depth: item.depth + 1 });
        }
        process.stdout.write(`skip existing: ${dictEntry.file_name}\n`);
        continue;
      } catch (error) {
        const maybeNodeError = error as NodeJS.ErrnoException;
        if (maybeNodeError.code !== 'ENOENT') {
          throw error;
        }
      }
    }

    process.stdout.write(`取得中: ${dictEntry.title} (${item.lawId}) depth=${item.depth}\n`);

    const scraped = await scrapeLawDocumentWithRetry(item.lawId, options);

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

    await fs.writeFile(notePath(options.outputDir, freshFileName), rendered.markdown, 'utf8');

    for (const lawId of rendered.referencedLawIds) {
      queue.push({ lawId, depth: item.depth + 1 });
    }
  }

  await writeJson(options.dictionaryPath, dictionary);
  await appendUnresolved(options.unresolvedPath, context.unresolved);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
