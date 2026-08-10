import { expect, it } from 'vitest';
import { destinationPath, periodFor } from '../../src/output/periods';

const local = (value: string) => new Date(`${value}T12:00:00`);

it('uses the approved default monthly tier', () => {
  expect(
    destinationPath(
      {
        outputFolder: 'Browser History',
        fileNameTemplate: '{period}',
        layout: 'tiered',
        period: 'month',
        outputFormat: 'markdown',
      },
      local('2026-08-03'),
    ),
  ).toBe('Browser History/2026/2026-08.md');
});

it('files a crossing ISO week by its Monday', () => {
  expect(periodFor(local('2026-01-01'), 'week').key).toBe('2026-W01');
  expect(
    destinationPath(
      {
        outputFolder: 'History',
        fileNameTemplate: '{period}',
        layout: 'tiered',
        period: 'day',
        outputFormat: 'markdown',
      },
      local('2026-01-01'),
    ),
  ).toBe('History/2025/2025-12/2026-W01/2026-01-01.md');
});

it('places all period filenames directly in flat mode', () => {
  expect(
    destinationPath(
      {
        outputFolder: 'History',
        fileNameTemplate: '{period}',
        layout: 'flat',
        period: 'week',
        outputFormat: 'markdown',
      },
      local('2026-08-03'),
    ),
  ).toBe('History/2026-W32.md');
});

it('uses the ISO Monday year and month as the tier for weekly notes', () => {
  expect(
    destinationPath(
      {
        outputFolder: 'History',
        fileNameTemplate: '{period}',
        layout: 'tiered',
        period: 'week',
        outputFormat: 'markdown',
      },
      local('2026-01-01'),
    ),
  ).toBe('History/2025/2025-12/2026-W01.md');
});

it('uses a POSIX vault path when the configured folder uses backslashes', () => {
  expect(
    destinationPath(
      {
        outputFolder: 'History\\Imported',
        fileNameTemplate: '{period}',
        layout: 'tiered',
        period: 'year',
        outputFormat: 'markdown',
      },
      local('2026-08-03'),
    ),
  ).toBe('History/Imported/2026.md');
});

it('applies fixed text around the period key in customized filenames', () => {
  expect(
    destinationPath(
      {
        outputFolder: 'History',
        fileNameTemplate: 'Browser history - {period}',
        layout: 'tiered',
        period: 'month',
        outputFormat: 'markdown',
      },
      local('2026-08-03'),
    ),
  ).toBe('History/2026/Browser history - 2026-08.md');
});

it('uses the selected format extension in destination paths', () => {
  expect(destinationPath({
    outputFolder: 'Browser History',
    fileNameTemplate: '{period}',
    layout: 'tiered',
    period: 'month',
    outputFormat: 'json',
  }, local('2026-08-03'))).toBe('Browser History/2026/2026-08.json');
});
