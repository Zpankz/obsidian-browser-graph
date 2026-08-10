import { expect, it } from 'vitest';
import {
  recordFromVisit,
  reconcileRecords,
} from '../../src/output/document';
import { stableVisitId } from '../../src/output/markdown';
import { visit } from '../helpers/visits';

it('maps a normalized visit to an unescaped canonical record with sync metadata', () => {
  const input = visit({ title: '[raw] title', url: 'https://example.com/a b' });
  expect(recordFromVisit(input)).toMatchObject({
    title: '[raw] title',
    url: 'https://example.com/a b',
    representation: 'markdown_link',
    sync: {
      namespace: 'obsidian-browser-sync',
      browser: input.browserId,
      id: stableVisitId(input),
    },
  });
});

it('preserves repeated ID-less records by maximum per-document occurrence count', () => {
  const legacy = {
    timestamp: '2024-07-01T08:57:04+03:00',
    title: 'Legacy',
    url: 'https://example.com/',
    browser: 'Safari',
    profile: 'History',
    representation: 'markdown_link' as const,
  };
  expect(reconcileRecords([[legacy, legacy], [legacy]])).toEqual([legacy, legacy]);
});
