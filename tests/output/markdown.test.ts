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

it('renders the canonical title and preserves a distinct original title in metadata', () => {
  const record = historyRecord({
    title: 'Canonical title',
    original_title: 'Original title',
  });
  const markdown = renderHistoryRecord(record);

  expect(markdown).toContain('[Canonical title](https://example.com/)');
  expect(markdown).not.toContain('[Original title](');
  expect(markdown).toContain(
    `  <!-- obsidian-browser-sync:original-title:${Buffer.from('Original title').toString('base64url')} -->`,
  );
  expect(parseMarkdownDocument(newNote('2026-08', [markdown.trimEnd()])).document.records[0])
    .toEqual(record);
});

it.each([
  '',
  "apostrophe's title",
  'Café 東京 🚀',
])('round-trips present original_title metadata %j', (original_title) => {
  const record = historyRecord({ original_title, sync: undefined });
  const markdown = renderHistoryRecord(record);
  const payload = Buffer.from(original_title).toString('base64url');

  expect(markdown).toContain(
    `  <!-- obsidian-browser-sync:original-title:${payload} -->`,
  );
  expect(parseMarkdownDocument(newNote('2026-08', [markdown.trimEnd()])).document.records[0])
    .toEqual(record);
});

it.each([
  ['https://example.com/a b', 'https://example.com/a%20b'],
  ['https://example.com/café', 'https://example.com/caf%C3%A9'],
])('keeps canonical URL spellings distinct for %s and %s', (rawUrl, encodedUrl) => {
  const rawRecord = historyRecord({ url: rawUrl, sync: undefined });
  const encodedRecord = historyRecord({ url: encodedUrl, sync: undefined });
  const rawMarkdown = renderHistoryRecord(rawRecord);
  const encodedMarkdown = renderHistoryRecord(encodedRecord);

  expect(rawMarkdown).toContain(
    `  <!-- obsidian-browser-sync:original-url:${Buffer.from(rawUrl).toString('base64url')} -->`,
  );
  expect(encodedMarkdown).not.toContain('obsidian-browser-sync:original-url:');
  expect(parseMarkdownDocument(newNote('2026-08', [rawMarkdown.trimEnd()])).document.records[0])
    .toEqual(rawRecord);
  expect(parseMarkdownDocument(newNote('2026-08', [encodedMarkdown.trimEnd()])).document.records[0])
    .toEqual(encodedRecord);
});

it('writes generated metadata in deterministic order', () => {
  const record = historyRecord({
    title: '',
    original_title: '',
    url: 'https://example.com/a b',
  });
  const lines = renderHistoryRecord(record).trimEnd().split('\n');

  expect(lines.slice(1)).toEqual([
    `  <!-- obsidian-browser-sync:${record.sync?.browser}:${record.sync?.id} -->`,
    '  <!-- obsidian-browser-sync:title-empty -->',
    '  <!-- obsidian-browser-sync:original-title: -->',
    `  <!-- obsidian-browser-sync:original-url:${Buffer.from(record.url).toString('base64url')} -->`,
  ]);
  expect(parseMarkdownDocument(
    newNote('2026-08', [renderHistoryRecord(record).trimEnd()]),
  ).document.records[0]).toEqual(record);
});

it('round-trips slash-bearing browser and profile labels unambiguously', () => {
  const record = historyRecord({
    browser: 'Chrome / Beta',
    profile: 'Work / Personal',
    sync: undefined,
  });
  const markdown = renderHistoryRecord(record);

  expect(markdown).toContain('— Chrome &#47; Beta / Work &#47; Personal\n');
  expect(parseMarkdownDocument(newNote('2026-08', [markdown.trimEnd()])).document.records[0])
    .toEqual(record);
});

it('rejects a pre-existing visit line with ambiguous browser/profile separators', () => {
  const content = `${newNote('2026-08', [])}- 2026-08-03T15:34:56+03:00 [Example](https://example.com/) — Chrome / Beta / Default\n`;
  const parsed = parseMarkdownDocument(content);

  expect(parsed.document.records).toEqual([]);
  expect(parsed.hasUnrecognizedContent).toBe(true);
});

it.each([
  (originalTitle: string, originalUrl: string) =>
    `\n\n  <!-- obsidian-browser-sync:original-title:${originalTitle} -->\n` +
      `  <!-- obsidian-browser-sync:original-url:${originalUrl} -->`,
  (originalTitle: string, originalUrl: string) =>
    `\n\`\`\`html\n  <!-- obsidian-browser-sync:original-title:${originalTitle} -->\n` +
      `  <!-- obsidian-browser-sync:original-url:${originalUrl} -->\n\`\`\``,
])('ignores fenced or non-adjacent value metadata', (suffixFor) => {
  const visibleRecord = historyRecord({
    url: 'https://example.com/a%20b',
    sync: undefined,
  });
  delete visibleRecord.sync;
  const suffix = suffixFor(
    Buffer.from('User-authored title').toString('base64url'),
    Buffer.from('https://example.com/a b').toString('base64url'),
  );
  const content = newNote(
    '2026-08',
    [`${renderHistoryRecord(visibleRecord).trimEnd()}${suffix}`],
  );
  const parsed = parseMarkdownDocument(content);

  expect(parsed.document.records[0]).toEqual(visibleRecord);
  expect(parsed.hasUnrecognizedContent).toBe(true);
});

it('leaves invalid adjacent value metadata unrecognized without throwing', () => {
  const record = historyRecord({ sync: undefined });
  delete record.sync;
  const content = newNote('2026-08', [
    `${renderHistoryRecord(record).trimEnd()}\n` +
      '  <!-- obsidian-browser-sync:original-title:_w -->',
  ]);
  const parsed = parseMarkdownDocument(content);

  expect(parsed.document.records[0]).toEqual(record);
  expect(parsed.hasUnrecognizedContent).toBe(true);
});

it('round-trips a blank modern title with exact metadata after the sync marker', () => {
  const record = historyRecord({ title: '' });
  const document = historyDocument({
    metadata: {
      ...historyDocument().metadata,
      source_format: 'obsidian_browser_sync_markdown',
    },
    records: [record],
  });

  const markdown = serializeMarkdownDocument(document);
  expect(markdown).toContain(
    `  <!-- obsidian-browser-sync:${record.sync?.browser}:${record.sync?.id} -->\n` +
      '  <!-- obsidian-browser-sync:title-empty -->\n',
  );
  expect(parseMarkdownDocument(markdown).document).toEqual(document);
});

it('round-trips a blank legacy title with exact metadata after the visit line', () => {
  const record = historyRecord({ title: '', sync: undefined });
  const document = historyDocument({
    metadata: {
      ...historyDocument().metadata,
      source_format: 'obsidian_browser_sync_markdown',
    },
    records: [record],
  });

  const markdown = serializeMarkdownDocument(document);
  expect(renderHistoryRecord(record)).toMatch(
    /\n {2}<!-- obsidian-browser-sync:title-empty -->\n$/,
  );
  expect(parseMarkdownDocument(markdown).document).toEqual(document);
});

it('preserves original title spelling when blank-title metadata requires it', () => {
  const record = historyRecord({
    title: '',
    original_title: 'Archived [source] title',
    sync: undefined,
  });
  const document = historyDocument({
    metadata: {
      ...historyDocument().metadata,
      source_format: 'obsidian_browser_sync_markdown',
    },
    records: [record],
  });

  expect(parseMarkdownDocument(serializeMarkdownDocument(document)).document).toEqual(document);
});

it('keeps a genuine title equal to the URL fallback nonblank', () => {
  const record = historyRecord({ title: 'https://example.com/' });
  const document = historyDocument({
    metadata: {
      ...historyDocument().metadata,
      source_format: 'obsidian_browser_sync_markdown',
    },
    records: [record],
  });

  const markdown = serializeMarkdownDocument(document);
  expect(markdown).not.toContain('obsidian-browser-sync:title-empty');
  expect(parseMarkdownDocument(markdown).document).toEqual(document);
});

it.each([
  '\n\n  <!-- obsidian-browser-sync:title-empty -->',
  '\n```html\n  <!-- obsidian-browser-sync:title-empty -->\n```',
])('does not apply fenced or non-adjacent blank-title metadata %j', (suffix) => {
  const record = historyRecord({
    title: 'https://example.com/',
    sync: undefined,
  });
  const content = newNote('2026-08', [`${renderHistoryRecord(record).trimEnd()}${suffix}`]);
  const parsed = parseMarkdownDocument(content);

  expect(parsed.document.records[0].title).toBe('https://example.com/');
  expect(parsed.hasUnrecognizedContent).toBe(true);
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
    '— &lt;script&gt;alert\\(2\\)&lt;&#47;script&gt; / Work &amp; &lt;admin&gt;',
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
        '<!-- obsidian-browser-sync:chrome:NOT-VALID -->\n' +
        '  <!-- obsidian-browser-sync:title-empty -->\n' +
        '<!-- obsidian-browser-sync:original-title:aaaaaaaaaaaaaaaaaaaaaaaa -->\n' +
        '<!-- obsidian-browser-sync:original-url:bbbbbbbbbbbbbbbbbbbbbbbb -->',
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
