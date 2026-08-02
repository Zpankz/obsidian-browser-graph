import { createHash } from 'node:crypto';
import type { NormalizedVisit } from '../domain';

const MARKER = /<!-- obsidian-browser-sync:([a-z0-9-]+):([a-f0-9]{24}) -->/g;

function localTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => part.toString().padStart(2, '0'))
    .join(':');
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
  return safeLabel(title)
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function safeLabel(label: string): string {
  return replaceControlCharacters(label, ' ').replace(/\s+/g, ' ').trim();
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

function safeUrl(url: string): string {
  try {
    return escapeMarkdownDestination(new URL(url).toString());
  } catch {
    return escapeMarkdownDestination(
      replaceControlCharacters(url, ' ').replace(/\s/g, encodeURIComponent),
    );
  }
}

export function stableVisitId(visit: NormalizedVisit): string {
  return createHash('sha256')
    .update(
      [
        visit.sourceKey,
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
  const title = safeTitle(visit.title) || url;
  const markerSource = visit.browserId;
  const browserName = safeLabel(visit.browserName);
  const profileName = safeLabel(visit.profileName);
  return `- ${localTime(visit.visitedAt)} [${title}](${url}) — ${browserName} / ${profileName}\n  <!-- obsidian-browser-sync:${markerSource}:${stableVisitId(visit)} -->\n`;
}

export function extractImportedIds(markdown: string): Set<string> {
  const importedIds = new Set<string>();
  MARKER.lastIndex = 0;
  let match = MARKER.exec(markdown);
  while (match !== null) {
    importedIds.add(match[2]);
    match = MARKER.exec(markdown);
  }
  return importedIds;
}

export function newNote(periodLabel: string, entries: string[]): string {
  const body = entries.length === 0 ? '' : `${entries.join('\n')}\n`;
  return `---\nbrowser-sync: true\nperiod: ${periodLabel}\n---\n# Browser history\n\n${body}`;
}
