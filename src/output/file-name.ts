import { normalizeSafeVaultPath } from '../vault-path';
import { codecFor, type OutputFormat } from './codec';

export const DEFAULT_FILE_NAME_TEMPLATE = '{period}';
const PERIOD_TOKEN = '{period}';
const MAX_TEMPLATE_LENGTH = 200;

export function isSafeFileNameTemplate(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_TEMPLATE_LENGTH
    || value.trim() !== value
    || value.endsWith('.')
    || !value.includes(PERIOD_TOKEN)
  ) {
    return false;
  }

  const fixedText = value.split(PERIOD_TOKEN).join('');
  if (/[{}]/.test(fixedText) || /[/\\]/.test(value)) {
    return false;
  }

  const exampleFileName = formatOutputFileName(value, '2000-W01', 'markdown');
  return normalizeSafeVaultPath(exampleFileName) === exampleFileName;
}

export function formatOutputFileName(
  template: string,
  periodKey: string,
  format: OutputFormat,
): string {
  return `${template.split(PERIOD_TOKEN).join(periodKey)}${codecFor(format).extension}`;
}
