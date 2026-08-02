import { expect, it } from 'vitest';
import { destinationPath, periodFor } from '../../src/output/periods';

const local = (value: string) => new Date(`${value}T12:00:00`);

it('uses the approved default monthly tier', () => {
  expect(
    destinationPath(
      { outputFolder: 'Browser History', layout: 'tiered', period: 'month' },
      local('2026-08-03'),
    ),
  ).toBe('Browser History/2026/2026-08.md');
});

it('files a crossing ISO week by its Monday', () => {
  expect(periodFor(local('2026-01-01'), 'week').key).toBe('2026-W01');
  expect(
    destinationPath(
      { outputFolder: 'History', layout: 'tiered', period: 'day' },
      local('2026-01-01'),
    ),
  ).toBe('History/2025/2025-12/2026-W01/2026-01-01.md');
});

it('places all period filenames directly in flat mode', () => {
  expect(
    destinationPath(
      { outputFolder: 'History', layout: 'flat', period: 'week' },
      local('2026-08-03'),
    ),
  ).toBe('History/2026-W32.md');
});

it('uses the ISO Monday year and month as the tier for weekly notes', () => {
  expect(
    destinationPath(
      { outputFolder: 'History', layout: 'tiered', period: 'week' },
      local('2026-01-01'),
    ),
  ).toBe('History/2025/2025-12/2026-W01.md');
});

it('uses a POSIX vault path when the configured folder uses backslashes', () => {
  expect(
    destinationPath(
      { outputFolder: 'History\\Imported', layout: 'tiered', period: 'year' },
      local('2026-08-03'),
    ),
  ).toBe('History/Imported/2026.md');
});
