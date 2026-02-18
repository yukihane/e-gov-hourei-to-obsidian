import { chromium } from 'playwright';

async function main() {
  const lawId = process.argv[2] ?? '334AC0000000121';
  const url = `https://laws.e-gov.go.jp/law/${lawId}`;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);

  const info = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    const title = document.title;
    const anchors = Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 20)
      .map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '');

    const keywords = ['第一条', '特許法', '附則', '第1条', '第２条'];
    const hits = keywords
      .map((k) => ({ k, found: text.includes(k) }))
      .filter((x) => x.found)
      .map((x) => x.k);

    return {
      title,
      textLength: text.length,
      hrefCount: document.querySelectorAll('a[href]').length,
      sampleHrefs: anchors,
      keywordHits: hits,
      bodySnippet: text.slice(0, 500),
    };
  });

  console.log(JSON.stringify({ url, ...info }, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
