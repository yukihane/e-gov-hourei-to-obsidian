import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLawIdFromHref, scanReferencedLawIdsFromMarkdown, toSafeTitle } from './cli.js';

test('parseLawIdFromHref: 相対URLを解析できる', () => {
  const parsed = parseLawIdFromHref('/law/334AC0000000121#Mp-At_1');
  assert.deepEqual(parsed, { lawId: '334AC0000000121', anchor: 'Mp-At_1' });
});

test('parseLawIdFromHref: 絶対URLを解析できる', () => {
  const parsed = parseLawIdFromHref('https://laws.e-gov.go.jp/law/345AC0000000082');
  assert.deepEqual(parsed, { lawId: '345AC0000000082', anchor: undefined });
});

test('parseLawIdFromHref: 非法令URLは未解釈', () => {
  assert.equal(parseLawIdFromHref('https://example.com/x'), undefined);
  assert.equal(parseLawIdFromHref('/api/2/laws'), undefined);
});

test('toSafeTitle: ファイル名禁則文字を置換し80文字に制限する', () => {
  const raw = '法/令:*?"<>| テスト';
  assert.equal(toSafeTitle(raw), '法_令_______ テスト');

  const long = 'あ'.repeat(120);
  assert.equal(toSafeTitle(long).length, 80);
});

test('scanReferencedLawIdsFromMarkdown: Obsidianリンクからlaw_idを抽出', () => {
  const markdown = [
    '[[laws/特許法_334AC0000000121.md|特許法]]',
    '[[laws/law_345AC0000000082.md#Mp-At_1|地方道路公社法]]',
    '[[laws/特許法_334AC0000000121.md#TOC|重複]]',
  ].join('\n');
  const scanned = scanReferencedLawIdsFromMarkdown(markdown);
  assert.deepEqual(scanned.referencedLawIds.sort(), ['334AC0000000121', '345AC0000000082']);
});
