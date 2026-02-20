import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLawIdFromHref } from './index.js';

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
