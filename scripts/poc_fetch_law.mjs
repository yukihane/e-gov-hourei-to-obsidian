import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

async function main() {
  const lawId = process.argv[2] ?? '334AC0000000121';
  const outDir = path.join('data', 'scrape_dumps', lawId);
  const url = `https://laws.e-gov.go.jp/law/${lawId}`;

  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);

  const html = await page.content();
  const summary = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const links = Array.from(document.querySelectorAll('a[href]'));
    return {
      title: document.title,
      textLength: text.length,
      hrefCount: links.length,
      sampleHrefs: links.slice(0, 30).map((a) => a.getAttribute('href') ?? ''),
      keywordHits: ['第一条', '特許法', '附則', '第1条', '第２条'].filter((k) => text.includes(k)),
      bodySnippet: text.slice(0, 1200),
    };
  });

  const result = {
    fetchedAt: new Date().toISOString(),
    url,
    lawId,
    ...summary,
  };

  await fs.writeFile(path.join(outDir, 'page.html'), html, 'utf8');
  await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(result, null, 2), 'utf8');

  console.log(JSON.stringify(result, null, 2));
  console.log(`dumped: ${path.join(outDir, 'page.html')}`);
  console.log(`dumped: ${path.join(outDir, 'summary.json')}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
