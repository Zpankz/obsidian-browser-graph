import { createHash } from 'node:crypto';
import type { BrowserId, NormalizedVisit } from '../domain';
import type {
  BrowserHistoryDocument,
  BrowserHistoryRecord,
  ManagedDocumentParse,
} from './document';
import {
  recordFromVisit,
  validateBrowserHistoryDocument,
  validateBrowserHistoryRecord,
} from './document';

const MARKER_LINE = /^ {0,3}<!-- obsidian-browser-sync:([a-z0-9-]+):([a-f0-9]{24}) -->[ ]*$/;
const GENERATED_MARKER_LINE = /^ {2}<!-- obsidian-browser-sync:(safari|firefox|chrome|edge|brave|chromium|vivaldi):([a-f0-9]{24}) -->$/;
const TITLE_EMPTY_MARKER_LINE = '  <!-- obsidian-browser-sync:title-empty -->';
const ORIGINAL_TITLE_MARKER_LINE = /^ {2}<!-- obsidian-browser-sync:original-title:([A-Za-z0-9_-]*) -->$/;
const ORIGINAL_URL_MARKER_LINE = /^ {2}<!-- obsidian-browser-sync:original-url:([A-Za-z0-9_-]*) -->$/;
const VISIT_LINE = /^- (\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d[+-](?:[01]\d|2[0-3]):[0-5]\d) (.+)$/;
const MANAGED_ENVELOPE_LINES = [
  '---',
  'browser-sync: true',
] as const;

export function formatLocalIsoTimestamp(date: Date): string {
  const pad = (part: number, length = 2): string => part.toString().padStart(length, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;

  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offsetSign}${pad(offsetHours)}:${pad(offsetRemainder)}`;
}

function replaceControlCharacters(value: string, replacement: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
      ? replacement
      : character;
  }).join('');
}

function safeTitle(title: string): string {
  return safeLabel(title);
}

function safeLabel(label: string, encodeSlash = false): string {
  const html = escapeHtml(
    replaceControlCharacters(label, ' ').replace(/\s+/g, ' ').trim(),
  );
  return escapeMarkdownInline(encodeSlash ? html.replace(/\//g, '&#47;') : html);
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/([\\`*_[\]{}()!])/g, '\\$1');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeMarkdownDestination(url: string): string {
  const encodedDelimiters: Record<string, string> = {
    '\\': '%5C',
    '(': '%28',
    ')': '%29',
    '[': '%5B',
    ']': '%5D',
    '<': '%3C',
    '>': '%3E',
  };
  return Array.from(url, (character) => encodedDelimiters[character] ?? character).join('');
}

function inertCodeSpan(value: string): string {
  const text = replaceControlCharacters(value, ' ').replace(/\s+/g, ' ').trim();
  const longestBacktickRun = [...text.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const delimiter = '`'.repeat(longestBacktickRun + 1);
  const content = text || 'invalid URL';
  const padded = content.startsWith('`') || content.endsWith('`')
    ? ` ${content} `
    : content;
  return `${delimiter}${padded}${delimiter}`;
}

interface SafeUrl {
  clickable: boolean;
  destination?: string;
  display: string;
}

function safeUrl(url: string): SafeUrl {
  try {
    const normalized = new URL(url);
    if (normalized.protocol !== 'http:' && normalized.protocol !== 'https:') {
      return { clickable: false, display: inertCodeSpan(url) };
    }
    const normalizedUrl = normalized.toString();
    const destination = escapeMarkdownDestination(normalizedUrl);
    return {
      clickable: true,
      destination,
      display: safeTitle(normalizedUrl),
    };
  } catch {
    return { clickable: false, display: inertCodeSpan(url) };
  }
}

export function stableVisitId(visit: NormalizedVisit): string {
  return createHash('sha256')
    .update(
      [
        visit.browserId,
        visit.profileId,
        visit.sourceVisitId,
        visit.visitedAt.toISOString(),
        visit.url,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 24);
}

export function renderVisit(visit: NormalizedVisit): string {
  return renderHistoryRecord(recordFromVisit(visit));
}

export function renderHistoryRecord(input: BrowserHistoryRecord): string {
  const record = validateBrowserHistoryRecord(input);
  const metadata = generatedMetadataLines(record);
  return `${renderedVisitLine(record)}\n${metadata.map((line) => `${line}\n`).join('')}`;
}

function renderedVisitLine(record: BrowserHistoryRecord): string {
  const url: SafeUrl = record.representation === 'markdown_link'
    ? safeUrl(record.url)
    : { clickable: false, display: inertCodeSpan(record.url) };
  const title = safeTitle(record.title)
    || url.display
    || 'Untitled visit';
  const visibleVisit = url.clickable
    ? `[${title}](${url.destination})`
    : title === url.display || url.display.length === 0
      ? title
      : `${title} — ${url.display}`;
  const browserName = safeLabel(record.browser, true);
  const profileName = safeLabel(record.profile, true);
  return `- ${record.timestamp} ${visibleVisit} — ${browserName} / ${profileName}`;
}

function generatedMetadataLines(record: BrowserHistoryRecord): string[] {
  const lines: string[] = [];
  if (record.sync) {
    lines.push(
      `  <!-- obsidian-browser-sync:${record.sync.browser}:${record.sync.id} -->`,
    );
  }
  if (record.title === '') {
    lines.push(TITLE_EMPTY_MARKER_LINE);
  }
  if (record.original_title !== undefined) {
    lines.push(metadataLine('original-title', record.original_title));
  }
  const originalUrlMarker = originalUrlMarkerLine(record);
  if (originalUrlMarker) {
    lines.push(originalUrlMarker);
  }
  return lines;
}

function metadataLine(field: 'original-title' | 'original-url', value: string): string {
  return `  <!-- obsidian-browser-sync:${field}:${encodeMetadataValue(value)} -->`;
}

function originalUrlMarkerLine(record: BrowserHistoryRecord): string | undefined {
  if (record.representation !== 'markdown_link') {
    return undefined;
  }
  const rendered = safeUrl(record.url);
  return rendered.clickable && rendered.destination !== record.url
    ? metadataLine('original-url', record.url)
    : undefined;
}

function encodeMetadataValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function extractImportedIds(markdown: string): Set<string> {
  const importedIds = new Set<string>();
  let fence: { character: '`' | '~'; length: number } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const closingFence = new RegExp(
        `^ {0,3}${fence.character}{${fence.length},}[ ]*$`,
      );
      if (closingFence.test(line)) {
        fence = undefined;
      }
      continue;
    }

    const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (openingFence) {
      fence = {
        character: openingFence[1][0] as '`' | '~',
        length: openingFence[1].length,
      };
      continue;
    }

    const marker = MARKER_LINE.exec(line);
    if (marker && marker[1] !== 'original-title' && marker[1] !== 'original-url') {
      importedIds.add(marker[2]);
    }
  }
  return importedIds;
}

export function newNote(periodLabel: string, entries: string[]): string {
  const body = entries.length === 0 ? '' : `${entries.join('\n')}\n`;
  return `---\nbrowser-sync: true\nperiod: ${periodLabel}\n---\n# Browser history\n\n${body}`;
}

export function serializeMarkdownDocument(document: BrowserHistoryDocument): string {
  const validated = validateBrowserHistoryDocument(document);
  return newNote(
    validated.metadata.period,
    validated.records.map((record) => renderHistoryRecord(record).trimEnd()),
  );
}

export function parseMarkdownDocument(content: string): ManagedDocumentParse {
  const envelope = parseManagedEnvelope(content);
  const records: BrowserHistoryRecord[] = [];
  const consumed = new Set<number>();
  let fence: { character: '`' | '~'; length: number } | undefined;

  for (let index = 0; index < envelope.bodyLines.length; index += 1) {
    const line = envelope.bodyLines[index];
    if (fence) {
      const closingFence = new RegExp(
        `^ {0,3}${fence.character}{${fence.length},}[ ]*$`,
      );
      if (closingFence.test(line)) {
        fence = undefined;
      }
      continue;
    }
    const openingFence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (openingFence) {
      fence = {
        character: openingFence[1][0] as '`' | '~',
        length: openingFence[1].length,
      };
      continue;
    }
    const record = recordFromGeneratedLine(line);
    if (!record) {
      continue;
    }
    consumed.add(index);
    let metadataIndex = index + 1;
    const marker = GENERATED_MARKER_LINE.exec(envelope.bodyLines[metadataIndex] ?? '');
    if (marker) {
      record.sync = {
        namespace: 'obsidian-browser-sync',
        browser: marker[1] as BrowserId,
        id: marker[2],
      };
      consumed.add(metadataIndex);
      metadataIndex += 1;
    }
    if (envelope.bodyLines[metadataIndex] === TITLE_EMPTY_MARKER_LINE) {
      const visibleTitle = record.title;
      record.title = '';
      if (isExactRenderedLine(record, line)) {
        consumed.add(metadataIndex);
        metadataIndex += 1;
      } else {
        record.title = visibleTitle;
      }
    }
    const originalTitle = metadataValue(
      envelope.bodyLines[metadataIndex] ?? '',
      ORIGINAL_TITLE_MARKER_LINE,
    );
    if (originalTitle !== undefined) {
      record.original_title = originalTitle;
      consumed.add(metadataIndex);
      metadataIndex += 1;
    }
    const originalUrlLine = envelope.bodyLines[metadataIndex] ?? '';
    const originalUrl = metadataValue(originalUrlLine, ORIGINAL_URL_MARKER_LINE);
    if (originalUrl !== undefined) {
      const visibleUrl = record.url;
      record.url = originalUrl;
      if (originalUrlMarkerLine(record) === originalUrlLine
        && isExactRenderedLine(record, line)) {
        consumed.add(metadataIndex);
        metadataIndex += 1;
      } else {
        record.url = visibleUrl;
      }
    }
    index = metadataIndex - 1;
    records.push(validateBrowserHistoryRecord(record));
  }

  const document = validateBrowserHistoryDocument({
    schema_version: 1,
    type: 'browser_history',
    metadata: {
      browser_sync: true,
      period: envelope.period,
      heading: 'Browser history',
      source_format: 'obsidian_browser_sync_markdown',
    },
    records,
  });
  return {
    document,
    hasUnrecognizedContent: envelope.bodyLines.some(
      (line, index) => line.trim() !== '' && !consumed.has(index),
    ),
  };
}

interface ManagedEnvelope {
  period: string;
  bodyLines: string[];
}

function parseManagedEnvelope(content: string): ManagedEnvelope {
  const lines = content.split(/\r?\n/);
  const period = /^period: (.+)$/.exec(lines[2] ?? '')?.[1];
  if (lines[0] !== MANAGED_ENVELOPE_LINES[0]
    || lines[1] !== MANAGED_ENVELOPE_LINES[1]
    || period === undefined
    || lines[3] !== '---'
    || lines[4] !== '# Browser history'
    || lines[5] !== '') {
    throw new Error('Markdown document does not have the exact Browser Sync envelope');
  }
  return { period, bodyLines: lines.slice(6) };
}

function recordFromGeneratedLine(line: string): BrowserHistoryRecord | undefined {
  const visit = VISIT_LINE.exec(line);
  if (!visit) {
    return undefined;
  }
  const candidates: BrowserHistoryRecord[] = [];
  for (const visitSeparator of indexesOf(visit[2], ' — ')) {
    const visible = visit[2].slice(0, visitSeparator);
    const labels = visit[2].slice(visitSeparator + 3);
    for (const profileSeparator of indexesOf(labels, ' / ')) {
      const browser = decodeGeneratedLabel(labels.slice(0, profileSeparator), true);
      const profile = decodeGeneratedLabel(labels.slice(profileSeparator + 3), true);
      const visibleVisit = parseVisibleVisit(visible);
      if (browser === undefined || profile === undefined || !visibleVisit) {
        continue;
      }
      const record: BrowserHistoryRecord = {
        timestamp: visit[1],
        title: visibleVisit.title,
        url: visibleVisit.url,
        browser,
        profile,
        representation: visibleVisit.representation,
      };
      if (isExactRenderedLine(record, line)) {
        candidates.push(record);
      }
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function isExactRenderedLine(record: BrowserHistoryRecord, line: string): boolean {
  try {
    return renderedVisitLine(validateBrowserHistoryRecord(record)) === line;
  } catch {
    return false;
  }
}

interface VisibleVisit {
  title: string;
  url: string;
  representation: BrowserHistoryRecord['representation'];
}

function parseVisibleVisit(value: string): VisibleVisit | undefined {
  const link = parseGeneratedLink(value);
  if (link) {
    return link;
  }

  const standaloneUrl = decodeInertCodeSpan(value);
  if (standaloneUrl !== undefined) {
    return { title: '', url: standaloneUrl, representation: 'inert_text' };
  }

  for (const separator of indexesOf(value, ' — ')) {
    const title = decodeGeneratedLabel(value.slice(0, separator));
    const url = decodeInertCodeSpan(value.slice(separator + 3));
    if (title !== undefined && url !== undefined) {
      return { title, url, representation: 'inert_text' };
    }
  }
  return undefined;
}

function parseGeneratedLink(value: string): VisibleVisit | undefined {
  if (!value.startsWith('[') || !value.endsWith(')')) {
    return undefined;
  }
  for (const separator of indexesOf(value, '](')) {
    const renderedTitle = value.slice(1, separator);
    const destination = value.slice(separator + 2, -1);
    const title = decodeGeneratedLabel(renderedTitle);
    if (title === undefined) {
      continue;
    }
    const renderedUrl = safeUrl(destination);
    if (renderedUrl.clickable && `[${renderedTitle}](${renderedUrl.destination})` === value) {
      return {
        title,
        url: destination,
        representation: 'markdown_link',
      };
    }
  }
  return undefined;
}

function decodeGeneratedLabel(value: string, encodedSlash = false): string | undefined {
  const markdownDecoded = value.replace(/\\([\\`*_[\]{}()!])/g, '$1');
  const decoded = markdownDecoded.replace(
    encodedSlash ? /&(?:amp|lt|gt|quot|#39|#47);/g : /&(?:amp|lt|gt|quot|#39);/g,
    (entity) => ({
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&#39;': "'",
      '&#47;': '/',
    })[entity] as string,
  );
  return safeLabel(decoded, encodedSlash) === value ? decoded : undefined;
}

function metadataValue(value: string, pattern: RegExp): string | undefined {
  const payload = pattern.exec(value)?.[1];
  if (payload === undefined) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    return encodeMetadataValue(decoded) === payload ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function decodeInertCodeSpan(value: string): string | undefined {
  const delimiter = /^`+/.exec(value)?.[0];
  if (!delimiter || !value.endsWith(delimiter) || value.length <= delimiter.length * 2) {
    return undefined;
  }
  let content = value.slice(delimiter.length, -delimiter.length);
  if (content.startsWith(' ') && content.endsWith(' ')
    && (content.slice(1).startsWith('`') || content.slice(0, -1).endsWith('`'))) {
    content = content.slice(1, -1);
  }
  return inertCodeSpan(content) === value ? content : undefined;
}

function indexesOf(value: string, search: string): number[] {
  const indexes: number[] = [];
  let index = value.indexOf(search);
  while (index >= 0) {
    indexes.push(index);
    index = value.indexOf(search, index + 1);
  }
  return indexes;
}
