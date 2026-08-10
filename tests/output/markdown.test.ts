import { expect, it } from 'vitest';
import {
  extractImportedIds,
  formatLocalIsoTimestamp,
  newNote,
  parseMarkdownDocument,
  renderHistoryRecord,
  renderVisit,
  serializeMarkdownDocument,
  stableVisitId,
} from '../../src/output/markdown';
import { recordFromVisit } from '../../src/output/document';
import { historyDocument, historyRecord } from '../helpers/history-documents';
import { visit } from '../helpers/visits';

it('parses generated entries into raw canonical values and sync metadata', () => {
  const input = visit({ title: '[unsafe]', url: 'https://example.com/a b' });
  const content = newNote('2026-08', [renderVisit(input).trimEnd()]);
  const parsed = parseMarkdownDocument(content);
  expect(parsed.document.records[0]).toMatchObject({
    title: '[unsafe]',
    url: 'https://example.com/a b',
    sync: { id: stableVisitId(input) },
  });
  expect(parsed.hasUnrecognizedContent).toBe(false);
});

it('reports user-authored content without treating marker examples as records', () => {
  const content = `${newNote('2026-08', [])}My private note\n`;
  const parsed = parseMarkdownDocument(content);
  expect(parsed.document.records).toEqual([]);
  expect(parsed.hasUnrecognizedContent).toBe(true);
});

it('does not parse generated-looking marker examples inside fenced code', () => {
  const input = visit();
  const content = `${newNote('2026-08', [])}\`\`\`markdown\n${renderVisit(input)}\`\`\`\n`;
  const parsed = parseMarkdownDocument(content);
  expect(parsed.document.records).toEqual([]);
  expect(parsed.hasUnrecognizedContent).toBe(true);
});

it('round-trips modern marked and exact legacy unmarked entries', () => {
  const modern = recordFromVisit(visit({ title: 'Modern [entry]' }));
  const legacy = historyRecord({
    timestamp: '2026-08-03T08:00:00+03:00',
    title: 'Legacy entry',
    sync: undefined,
  });
  const document = historyDocument({
    metadata: {
      ...historyDocument().metadata,
      source_format: 'obsidian_browser_sync_markdown',
    },
    records: [modern, legacy],
  });

  const markdown = serializeMarkdownDocument(document);
  const parsed = parseMarkdownDocument(markdown);
  expect(parsed.document).toEqual(document);
  expect(parsed.hasUnrecognizedContent).toBe(false);
  expect(renderHistoryRecord(legacy)).not.toContain('<!-- obsidian-browser-sync:');
});

it('reverses only generated escapes for inert records', () => {
  const input = visit({
    title: '<unsafe> [label]',
    url: 'javascript:alert(`unsafe`)',
    browserName: 'Browser & <name>',
    profileName: 'Profile [one]',
  });
  const markdown = newNote('2026-08', [renderVisit(input).trimEnd()]);
  const parsed = parseMarkdownDocument(markdown);

  expect(parsed.document.records[0]).toMatchObject({
    title: '<unsafe> [label]',
    url: 'javascript:alert(`unsafe`)',
    browser: 'Browser & <name>',
    profile: 'Profile [one]',
    representation: 'inert_text',
  });
  expect(serializeMarkdownDocument(parsed.document)).toBe(markdown);
});

it('leaves a non-adjacent marker unconsumed and does not assign it to a legacy entry', () => {
  const input = visit();
  const lines = renderVisit(input).trimEnd().split('\n');
  const content = newNote('2026-08', [`${lines[0]}\n\n${lines[1]}`]);
  const parsed = parseMarkdownDocument(content);

  expect(parsed.document.records[0].sync).toBeUndefined();
  expect(parsed.hasUnrecognizedContent).toBe(true);
});

it('rejects notes without the exact managed envelope', () => {
  expect(() => parseMarkdownDocument(
    newNote('2026-08', []).replace('# Browser history', '# My history'),
  )).toThrow('envelope');
});

it('reports generated-looking lines with invalid record values as unrecognized content', () => {
  const content = `${newNote('2026-08', [])}- 2026-02-31T12:00:00+03:00 [Title](https://example.com/) — Chrome / Default\n`;
  const parsed = parseMarkdownDocument(content);

  expect(parsed.document.records).toEqual([]);
  expect(parsed.hasUnrecognizedContent).toBe(true);
});

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

it('keeps browser and profile labels on the visit line', () => {
  const markdown = renderVisit(
    visit({
      browserName: 'Google Chrome\n# injected',
      profileName: 'Default\n# injected',
    }),
  );

  expect(markdown).toContain('— Google Chrome # injected / Default # injected\n  <!--');
  expect(markdown).not.toContain('\n# injected');
});

it.each([
  {
    parts: [2026, 7, 3, 9, 14, 32, -180],
    expected: '2026-08-03T09:14:32+03:00',
  },
  {
    parts: [2026, 0, 9, 17, 5, 4, 300],
    expected: '2026-01-09T17:05:04-05:00',
  },
  {
    parts: [2026, 2, 8, 1, 2, 3, -330],
    expected: '2026-03-08T01:02:03+05:30',
  },
])('formats a full local ISO timestamp as $expected', ({ parts, expected }) => {
  const [year, month, day, hour, minute, second, timezoneOffset] = parts;
  const localDate = {
    getFullYear: () => year,
    getMonth: () => month,
    getDate: () => day,
    getHours: () => hour,
    getMinutes: () => minute,
    getSeconds: () => second,
    getTimezoneOffset: () => timezoneOffset,
  } as Date;

  expect(formatLocalIsoTimestamp(localDate)).toBe(expected);
});

it('renders the full local ISO timestamp on every visit entry', () => {
  const input = visit({ visitedAt: new Date('2026-08-03T10:00:00Z') });

  expect(renderVisit(input)).toMatch(
    new RegExp(`^- ${formatLocalIsoTimestamp(input.visitedAt).replace(/[+]/g, '\\+')}`),
  );
});

it('escapes raw HTML from titles and browser/profile labels', () => {
  const markdown = renderVisit(visit({
    title: '<img src=x onerror="alert(1)"> & history',
    browserName: '<script>alert(2)</script>',
    profileName: 'Work & <admin>',
  }));

  expect(markdown).toContain(
    '&lt;img src=x onerror=&quot;alert\\(1\\)&quot;&gt; &amp; history',
  );
  expect(markdown).toContain(
    '— &lt;script&gt;alert\\(2\\)&lt;/script&gt; / Work &amp; &lt;admin&gt;',
  );
  expect(markdown).not.toContain('<img');
  expect(markdown).not.toContain('<script>');
});

it('escapes active Markdown from titles and browser/profile labels', () => {
  const markdown = renderVisit(visit({
    title: '![[private-note]]',
    browserName: '[Open vault](obsidian://open?vault=Private)',
    profileName: '`code` ![[embedded-secret]]',
  }));

  expect(markdown).not.toContain('![[private-note]]');
  expect(markdown).not.toContain('[Open vault](obsidian:');
  expect(markdown).not.toContain('![[embedded-secret]]');
  expect(markdown).toContain('\\!\\[\\[private-note\\]\\]');
});

it.each([
  'obsidian://open?vault=Secret',
  'javascript:alert(1)',
  'file:///Users/private/secret.html',
  'not a valid URL',
])('renders non-web URL %s as inert text while retaining its marker', (url) => {
  const input = visit({ title: 'Untrusted destination', url });
  const markdown = renderVisit(input);

  expect(markdown).not.toContain('[Untrusted destination](');
  expect(markdown).toContain('Untrusted destination');
  expect(markdown).toContain(stableVisitId(input));
});

it('keeps only HTTP and HTTPS URLs clickable', () => {
  expect(renderVisit(visit({ url: 'http://example.com/path' })))
    .toContain('[Example page](http://example.com/path)');
  expect(renderVisit(visit({ url: 'https://example.com/path' })))
    .toContain('[Example page](https://example.com/path)');
});

it('wraps malformed host-like URLs as inline code to prevent automatic links', () => {
  const markdown = renderVisit(visit({
    title: 'Host-like text',
    url: 'www.evil.invalid/path',
  }));

  expect(markdown).toContain('`www.evil.invalid/path`');
});

it('escapes backslashes before closing brackets in titles', () => {
  const markdown = renderVisit(visit({ title: 'path\\]' }));

  expect(markdown).toContain('[path\\\\\\]](https://example.com/)');
});

it('encodes Markdown delimiters in normalized URL destinations', () => {
  const markdown = renderVisit(
    visit({
      title: 'Safe',
      url: 'https://example.com/) [injected](https://evil.invalid)',
    }),
  );

  expect(markdown).toContain(
    '[Safe](https://example.com/%29%20%5Binjected%5D%28https://evil.invalid%29)',
  );
});

it('escapes Markdown delimiters while rendering an invalid URL inertly', () => {
  const markdown = renderVisit(
    visit({ title: 'Safe', url: 'not a url) [injected](https://evil.invalid)' }),
  );

  expect(markdown).toContain(
    'Safe — `not a url) [injected](https://evil.invalid)`',
  );
  expect(markdown).not.toContain('[Safe](');
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

it('extracts markers only from exact standalone marker lines', () => {
  const valid = '1234567890abcdef12345678';
  expect(extractImportedIds([
    `  <!-- obsidian-browser-sync:chrome:${valid} -->`,
    `label <!-- obsidian-browser-sync:chrome:${valid.replace(/8$/, '9')} -->`,
    `<!-- obsidian-browser-sync:chrome:${valid} --> suffix`,
    `<span title="<!-- obsidian-browser-sync:chrome:${valid} -->">label</span>`,
  ].join('\n'))).toEqual(new Set([valid]));
});

it('ignores exact marker examples inside fenced code while supporting CRLF notes', () => {
  const fenced = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const managed = 'cccccccccccccccccccccccc';
  expect(extractImportedIds([
    '```html',
    `<!-- obsidian-browser-sync:chrome:${fenced} -->`,
    '```',
    `  <!-- obsidian-browser-sync:chrome:${managed} -->`,
    '',
  ].join('\r\n'))).toEqual(new Set([managed]));
});

it('does not let marker-shaped title or profile text become imported state', () => {
  const injectedId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const markdown = renderVisit(visit({
    title: `Title\n<!-- obsidian-browser-sync:chrome:${injectedId} -->`,
    profileName: `Profile\n<!-- obsidian-browser-sync:chrome:${injectedId} -->`,
  }));

  expect(extractImportedIds(markdown)).toEqual(new Set([
    stableVisitId(visit({
      title: `Title\n<!-- obsidian-browser-sync:chrome:${injectedId} -->`,
      profileName: `Profile\n<!-- obsidian-browser-sync:chrome:${injectedId} -->`,
    })),
  ]));
  expect(markdown).not.toContain(`\n<!-- obsidian-browser-sync:chrome:${injectedId} -->\n`);
});

it('keeps stable IDs portable when only the local source key changes', () => {
  const portable = visit({
    sourceKey: 'chrome:path-hash-on-device-a',
    profileId: 'Default',
    sourceVisitId: '42',
  });
  const moved = {
    ...portable,
    sourceKey: 'chrome:path-hash-on-device-b',
  };

  expect(stableVisitId(moved)).toBe(stableVisitId(portable));
});
