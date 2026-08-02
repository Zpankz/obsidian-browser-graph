import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migratePersistedData } from '../src/settings';

describe('migratePersistedData', () => {
  it('uses the approved defaults for missing data', () => {
    expect(migratePersistedData(undefined)).toEqual({
      version: 1,
      settings: DEFAULT_SETTINGS,
      cursors: {},
    });
    expect(DEFAULT_SETTINGS.outputFolder).toBe('Browser History');
    expect(DEFAULT_SETTINGS.layout).toBe('tiered');
    expect(DEFAULT_SETTINGS.period).toBe('month');
  });

  it('sanitizes legacy and malformed persisted fields', () => {
    const result = migratePersistedData({
      settings: { outputFolder: '../outside', layout: 'wide', period: 'hour' },
      cursors: { firefox: { visitedAtMs: 'bad' } },
    });
    expect(result.settings.outputFolder).toBe('Browser History');
    expect(result.settings.layout).toBe('tiered');
    expect(result.settings.period).toBe('month');
    expect(result.cursors).toEqual({});
  });
});
