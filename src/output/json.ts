import type { BrowserHistoryDocument, ManagedDocumentParse } from './document';
import { validateBrowserHistoryDocument } from './document';

export function parseJsonDocument(content: string): ManagedDocumentParse {
  const value: unknown = JSON.parse(content);
  const document = validateBrowserHistoryDocument(value);
  return { document, hasUnrecognizedContent: false };
}

export function serializeJsonDocument(document: BrowserHistoryDocument): string {
  const validated = validateBrowserHistoryDocument(document);
  return `${JSON.stringify(validated, null, 2)}\n`;
}
