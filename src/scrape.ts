import { chromium, type Page } from 'playwright';
import { getLawSiteBaseUrl, wait } from './utils.js';
import type { CliOptions, ParagraphSegment, ScrapedLawDocument } from './types.js';

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
 * 既に読み込まれたページDOMから本文構造を抽出する。
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
 * 法令ページ取得を再試行付きで実行する。
 */
export async function scrapeLawDocumentWithRetry(lawId: string, options: CliOptions): Promise<ScrapedLawDocument> {
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
