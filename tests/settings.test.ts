import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  hashDeviceIdentityToken,
  isSafeVaultFolder,
  migratePersistedData,
  resolveDeviceIdentity,
} from '../src/settings';

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);
const DEVICE_A = hashDeviceIdentityToken(TOKEN_A);
const DEVICE_B = hashDeviceIdentityToken(TOKEN_B);
const NOW = Date.parse('2026-08-03T12:00:00Z');

describe('migratePersistedData', () => {
  it('uses the approved defaults for missing data', () => {
    expect(migratePersistedData(undefined, DEVICE_A, NOW)).toEqual({
      version: 3,
      deviceIdentityHash: DEVICE_A,
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
    }, DEVICE_A, NOW);
    expect(result.settings.outputFolder).toBe('Browser History');
    expect(result.settings.layout).toBe('tiered');
    expect(result.settings.period).toBe('month');
    expect(result.cursors).toEqual({});
  });

  it('retains cursors only for versioned state from this device identity', () => {
    const saved = {
      version: 3,
      deviceIdentityHash: DEVICE_A,
      settings: DEFAULT_SETTINGS,
      cursors: {
        'chrome:same-path': {
          visitedAtMs: Date.parse('2026-08-03T12:00:00Z'),
          sourceVisitId: '42',
        },
      },
    };

    expect(migratePersistedData(saved, DEVICE_A, NOW).cursors)
      .toEqual(saved.cursors);
    expect(migratePersistedData(saved, DEVICE_B, NOW)).toMatchObject({
      version: 3,
      deviceIdentityHash: DEVICE_B,
      cursors: {},
    });
    expect(migratePersistedData({ ...saved, version: 2 }, DEVICE_A, NOW).cursors)
      .toEqual({});
  });

  it('rejects persisted cursors with unsafe timestamps', () => {
    const unsafeTimestamps = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      8_640_000_000_000_001,
      Date.parse('2030-01-01T00:00:00Z'),
      NOW - 1_000 + 0.875,
    ];
    const cursors = Object.fromEntries(unsafeTimestamps.map((visitedAtMs, index) => [
      `chrome:${index}`,
      { visitedAtMs, sourceVisitId: String(index + 1) },
    ]));

    expect(migratePersistedData({
      version: 3,
      deviceIdentityHash: DEVICE_A,
      settings: DEFAULT_SETTINGS,
      cursors,
    }, DEVICE_A, NOW).cursors).toEqual({});
  });

  it('rejects non-canonical and out-of-range persisted SQLite visit IDs', () => {
    const cursors = {
      leadingZero: { visitedAtMs: NOW, sourceVisitId: '01' },
      tooLarge: {
        visitedAtMs: NOW,
        sourceVisitId: '9223372036854775808',
      },
    };

    expect(migratePersistedData({
      version: 3,
      deviceIdentityHash: DEVICE_A,
      settings: DEFAULT_SETTINGS,
      cursors,
    }, DEVICE_A, NOW).cursors).toEqual({});
  });

  it('uses distinct durable tokens for devices with otherwise identical machine metadata', () => {
    const writesA: string[] = [];
    const writesB: string[] = [];
    const identityA = resolveDeviceIdentity({
      read: () => null,
      write: (token) => writesA.push(token),
    }, () => TOKEN_A);
    const identityB = resolveDeviceIdentity({
      read: () => null,
      write: (token) => writesB.push(token),
    }, () => TOKEN_B);

    expect(identityA).toBe(DEVICE_A);
    expect(identityB).toBe(DEVICE_B);
    expect(identityA).not.toBe(identityB);
    expect(writesA).toEqual([TOKEN_A]);
    expect(writesB).toEqual([TOKEN_B]);

    const copiedState = {
      version: 3,
      deviceIdentityHash: identityA,
      settings: DEFAULT_SETTINGS,
      cursors: {
        'chrome:same-path': {
          visitedAtMs: NOW,
          sourceVisitId: '42',
        },
      },
    };

    expect(migratePersistedData(copiedState, identityB, NOW).cursors).toEqual({});
    expect(JSON.stringify(migratePersistedData(copiedState, identityA, NOW)))
      .not.toContain(TOKEN_A);
  });
});

describe('isSafeVaultFolder', () => {
  it.each([
    'History.',
    'History ',
    'History/<private>',
    'History/bad\u0001name',
    'History/bad\u007fname',
    'C:relative',
    'CON',
    'con.txt',
    'AUX.log',
    'PRN',
    'NUL.md',
    'COM1.history',
    'LPT9.txt',
    'COM¹',
    'com².log',
    'LPT³.txt',
    '.obsidian.',
    '.obsidian ',
    '.obsidian./plugins',
  ])('rejects Windows-unsafe or config-alias folder %s on every host', (folder) => {
    expect(isSafeVaultFolder(folder, '.obsidian')).toBe(false);
  });

  it('keeps ordinary portable vault folders valid', () => {
    expect(isSafeVaultFolder('History/Imported Notes')).toBe(true);
    expect(isSafeVaultFolder('History\\Imported Notes')).toBe(true);
  });

  it('uses the vault configuration folder instead of assuming its name', () => {
    expect(isSafeVaultFolder('.settings/plugins', '.settings')).toBe(false);
    expect(isSafeVaultFolder('.obsidian/notes', '.settings')).toBe(true);
  });
});
