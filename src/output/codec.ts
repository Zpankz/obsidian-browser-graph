import type { BrowserHistoryDocument, ManagedDocumentParse } from './document';
import { parseCsvDocument, serializeCsvDocument } from './csv';
import { parseJsonDocument, serializeJsonDocument } from './json';
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown';

export type OutputFormat = 'markdown' | 'csv' | 'json';

export interface HistoryCodec {
  format: OutputFormat;
  extension: '.md' | '.csv' | '.json';
  parse(content: string, context?: { period?: string }): ManagedDocumentParse;
  serialize(document: BrowserHistoryDocument): string;
}

const codecs: Record<OutputFormat, HistoryCodec> = {
  markdown: {
    format: 'markdown',
    extension: '.md',
    parse: parseMarkdownDocument,
    serialize: serializeMarkdownDocument,
  },
  csv: {
    format: 'csv',
    extension: '.csv',
    parse: parseCsvDocument,
    serialize: serializeCsvDocument,
  },
  json: {
    format: 'json',
    extension: '.json',
    parse: parseJsonDocument,
    serialize: serializeJsonDocument,
  },
};

export function codecFor(format: OutputFormat): HistoryCodec {
  const codec = codecs[format];
  if (!codec) {
    throw new Error(`Unsupported output format: ${String(format)}`);
  }
  return codec;
}

export function formatForPath(path: string): OutputFormat | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.md')) {
    return 'markdown';
  }
  if (lowerPath.endsWith('.csv')) {
    return 'csv';
  }
  if (lowerPath.endsWith('.json')) {
    return 'json';
  }
  return undefined;
}
