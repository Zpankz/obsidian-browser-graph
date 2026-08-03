import { createHash } from 'node:crypto';
import type { NormalizedVisit } from '../domain';

const MARKER_LINE = /^ {0,3}<!-- obsidian-browser-sync:([a-z0-9-]+):([a-f0-9]{24}) -->[ ]*$/;

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

function safeLabel(label: string): string {
  return escapeMarkdownInline(escapeHtml(
    replaceControlCharacters(label, ' ').replace(/\s+/g, ' ').trim(),
  ));
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
    const destination = escapeMarkdownDestination(normalized.toString());
    return {
      clickable: true,
      destination,
      display: safeTitle(normalized.toString()),
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
  const url = safeUrl(visit.url);
  const title = safeTitle(visit.title) || url.display || 'Untitled visit';
  const visibleVisit = url.clickable
    ? `[${title}](${url.destination})`
    : title === url.display || url.display.length === 0
      ? title
      : `${title} — ${url.display}`;
  const markerSource = visit.browserId;
  const browserName = safeLabel(visit.browserName);
  const profileName = safeLabel(visit.profileName);
  return `- ${formatLocalIsoTimestamp(visit.visitedAt)} ${visibleVisit} — ${browserName} / ${profileName}\n  <!-- obsidian-browser-sync:${markerSource}:${stableVisitId(visit)} -->\n`;
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
    if (marker) {
      importedIds.add(marker[2]);
    }
  }
  return importedIds;
}

export function newNote(periodLabel: string, entries: string[]): string {
  const body = entries.length === 0 ? '' : `${entries.join('\n')}\n`;
  return `---\nbrowser-sync: true\nperiod: ${periodLabel}\n---\n# Browser history\n\n${body}`;
}
