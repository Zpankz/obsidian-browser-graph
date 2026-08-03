import type { NotePeriod, PluginSettings } from '../domain';
import { formatOutputFileName } from './file-name';

export interface PeriodDescriptor {
  key: string;
  label: string;
  isoMonday: Date;
}

function localNoon(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoWeek(date: Date): { weekYear: number; week: number; monday: Date } {
  const normalized = localNoon(date);
  const weekday = normalized.getDay() || 7;
  const thursday = new Date(normalized);
  thursday.setDate(normalized.getDate() + 4 - weekday);

  const weekYear = thursday.getFullYear();
  const firstThursday = new Date(weekYear, 0, 4, 12);
  const firstThursdayWeekday = firstThursday.getDay() || 7;
  firstThursday.setDate(firstThursday.getDate() + 4 - firstThursdayWeekday);
  const calendarDay = (value: Date): number =>
    Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  const week =
    Math.floor(
      (calendarDay(thursday) - calendarDay(firstThursday)) / 604_800_000,
    ) + 1;

  const monday = new Date(normalized);
  monday.setDate(normalized.getDate() - weekday + 1);
  return { weekYear, week, monday };
}

export function periodFor(date: Date, period: NotePeriod): PeriodDescriptor {
  const normalized = localNoon(date);
  const week = isoWeek(normalized);

  switch (period) {
    case 'day':
      return { key: dateKey(normalized), label: dateKey(normalized), isoMonday: week.monday };
    case 'week': {
      const key = `${week.weekYear}-W${pad(week.week)}`;
      return { key, label: key, isoMonday: week.monday };
    }
    case 'month': {
      const key = `${normalized.getFullYear()}-${pad(normalized.getMonth() + 1)}`;
      return { key, label: key, isoMonday: week.monday };
    }
    case 'year': {
      const key = normalized.getFullYear().toString();
      return { key, label: key, isoMonday: week.monday };
    }
  }
}

function vaultSegments(folder: string): string[] {
  return folder.replace(/\\/g, '/').split('/').filter(Boolean);
}

export function destinationPath(
  settings: Pick<
    PluginSettings,
    'outputFolder' | 'fileNameTemplate' | 'layout' | 'period'
  >,
  date: Date,
): string {
  const descriptor = periodFor(date, settings.period);
  const segments = vaultSegments(settings.outputFolder);
  const fileName = formatOutputFileName(settings.fileNameTemplate, descriptor.key);

  if (settings.layout === 'flat') {
    return [...segments, fileName].join('/');
  }

  if (settings.period === 'year') {
    return [...segments, fileName].join('/');
  }

  if (settings.period === 'month') {
    return [...segments, descriptor.key.slice(0, 4), fileName].join('/');
  }

  const monday = descriptor.isoMonday;
  const weekKey = periodFor(monday, 'week').key;
  const weekTier = [
    monday.getFullYear().toString(),
    `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}`,
  ];

  if (settings.period === 'week') {
    return [...segments, ...weekTier, fileName].join('/');
  }

  return [...segments, ...weekTier, weekKey, fileName].join('/');
}
