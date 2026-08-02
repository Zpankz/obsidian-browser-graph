import { expect, it } from 'vitest';
import {
  extractImportedIds,
  newNote,
  renderVisit,
  stableVisitId,
} from '../../src/output/markdown';
import { visit } from '../helpers/visits';

it('keeps repeated URL visits distinct and IDs deterministic', () => {
  const first = visit({
    sourceVisitId: '10',
    url: 'https://example.com',
    visitedAt: new Date('2026-08-03T10:00:00Z'),
  });
  const second = visit({
    sourceVisitId: '11',
    url: 'https://example.com',
    visitedAt: new Date('2026-08-03T10:05:00Z'),
  });
  expect(stableVisitId(first)).toBe(stableVisitId(first));
  expect(stableVisitId(first)).not.toBe(stableVisitId(second));
});

it('renders escaped text and a recoverable hidden marker', () => {
  const input = visit({
    title: '[unsafe]\n# heading',
    url: 'https://example.com/a b',
  });
  const markdown = renderVisit(input);
  expect(markdown).not.toContain('\n# heading');
  expect(extractImportedIds(markdown)).toEqual(new Set([stableVisitId(input)]));
  expect(markdown).toContain('[\\[unsafe\\] # heading](https://example.com/a%20b)');
});

it('writes a new note with required frontmatter and a single blank line', () => {
  expect(newNote('2026-08', ['- entry one', '- entry two'])).toBe(
    '---\nbrowser-sync: true\nperiod: 2026-08\n---\n# Browser history\n\n- entry one\n- entry two\n',
  );
});

it('does not add another blank line when a new note has no entries', () => {
  expect(newNote('2026-08', [])).toBe(
    '---\nbrowser-sync: true\nperiod: 2026-08\n---\n# Browser history\n\n',
  );
});

it('uses the URL as the link label when the title is blank', () => {
  const markdown = renderVisit(visit({ title: '', url: 'https://example.com/a b' }));
  expect(markdown).toContain('[https://example.com/a%20b](https://example.com/a%20b)');
});

it('extracts only valid sync markers', () => {
  expect(
    extractImportedIds(
      '<!-- obsidian-browser-sync:chrome:1234567890abcdef12345678 -->\n' +
        '<!-- obsidian-browser-sync:chrome:NOT-VALID -->',
    ),
  ).toEqual(new Set(['1234567890abcdef12345678']));
});
