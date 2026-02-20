import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeUnresolvedRecords } from './index.js';

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
