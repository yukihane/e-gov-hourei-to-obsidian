import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { chromium } from 'playwright';
import { extractLawDocumentFromPage, renderMarkdownForTest } from './index.js';

test('fixture: 保存済みHTMLからMarkdown生成できる', async (t) => {
  const html = await fs.readFile('tests/fixtures/scrape_dumps/334AC0000000121/page.html', 'utf8');
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    t.skip(`Playwright起動不可のためスキップ: ${String(error)}`);
    return;
  }
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const doc = await extractLawDocumentFromPage(
      page,
      '334AC0000000121',
      'https://laws.e-gov.go.jp/law/334AC0000000121',
    );
    const markdown = renderMarkdownForTest(doc);

    assert.match(markdown, /law_id:\s*334AC0000000121/);
    assert.match(markdown, /title:/);
    assert.match(markdown, /source_url:/);
    assert.match(markdown, /fetched_at:/);
    assert.match(markdown, /第一条/);
    assert.match(markdown, /\[\[#/);
  } finally {
    await browser.close();
  }
});
