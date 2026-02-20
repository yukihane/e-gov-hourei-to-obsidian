import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildExistingNoteIndex,
  mergeUnresolvedRecords,
  parseLawIdFromHref,
  resolveExistingNotePath,
  scanReferencedLawIdsFromMarkdown,
  toSafeTitle,
} from './cli.js';

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

test('buildExistingNoteIndex: laws配下からlaw_id索引を構築できる', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'laws-index-'));
  await fs.writeFile(path.join(tmp, '特許法_334AC0000000121.md'), '# dummy', 'utf8');
  await fs.writeFile(path.join(tmp, 'note.md'), '# noop', 'utf8');

  const index = await buildExistingNoteIndex(tmp);
  assert.deepEqual(index.get('334AC0000000121'), [path.join(tmp, '特許法_334AC0000000121.md')]);
  assert.equal(index.get('NO_SUCH_ID'), undefined);
});

test('resolveExistingNotePath: 辞書名がなくてもlaw_id一致の既存ノートを返す', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'laws-resolve-'));
  const existingPath = path.join(tmp, '特許法_334AC0000000121.md');
  await fs.writeFile(existingPath, '# dummy', 'utf8');

  const index = await buildExistingNoteIndex(tmp);
  const resolved = await resolveExistingNotePath(tmp, '334AC0000000121', 'law_334AC0000000121.md', index);
  assert.equal(resolved, existingPath);
});

test('mergeUnresolvedRecords: 同一キーを重複追加しない', () => {
  const existing = [
    {
      timestamp: '2026-02-20T00:00:00Z',
      root_law_id: '334AC0000000121',
      root_law_title: '特許法',
      from_anchor: 'Mp-At_1',
      raw_text: '民法',
      href: '/law/129AC0000000089',
      reason: 'target_not_built' as const,
    },
  ];
  const incoming = [
    {
      timestamp: '2026-02-20T01:00:00Z',
      root_law_id: '334AC0000000121',
      root_law_title: '特許法',
      from_anchor: 'Mp-At_1',
      raw_text: '民法',
      href: '/law/129AC0000000089',
      reason: 'target_not_built' as const,
    },
    {
      timestamp: '2026-02-20T01:00:00Z',
      root_law_id: '334AC0000000121',
      root_law_title: '特許法',
      from_anchor: 'Mp-At_2',
      raw_text: '刑法',
      href: '/law/140AC0000000045',
      reason: 'target_not_built' as const,
    },
  ];
  const merged = mergeUnresolvedRecords(existing, incoming);
  assert.equal(merged.length, 2);
});
