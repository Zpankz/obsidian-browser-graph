import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '../../src/domain';
import { normalizeVisit } from '../../src/browsers/reader';

const profile: BrowserProfile = {
  sourceKey: 'chrome:local-path-hash',
  browserId: 'chrome',
  browserName: 'Google Chrome',
  profileId: 'Default',
  profileName: 'Personal',
  databasePath: '/synthetic/History',
  readerKind: 'chromium',
};

describe('normalizeVisit timestamp boundary', () => {
  const now = Date.parse('2026-08-03T12:00:00Z');

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    8_640_000_000_000_001,
    Date.parse('2030-01-01T00:00:00Z'),
  ])('rejects unsafe timestamp %s before a visit escapes the reader', (timestamp) => {
    expect(normalizeVisit(
      profile,
      '1',
      timestamp,
      'Unsafe',
      'https://example.com',
      now,
    )).toBeUndefined();
  });

  it('accepts a small clock skew without accepting implausible future history', () => {
    expect(normalizeVisit(
      profile,
      '1',
      now + 60_000,
      'Safe',
      'https://example.com',
      now,
    )?.visitedAt).toEqual(new Date(now + 60_000));
  });

  it('normalizes valid sub-millisecond precision to a representable Date', () => {
    expect(normalizeVisit(
      profile,
      '1',
      now - 1_000 + 0.875,
      'Precise',
      'https://example.com',
      now,
    )?.visitedAt).toEqual(new Date(now - 1_000));
  });
});
