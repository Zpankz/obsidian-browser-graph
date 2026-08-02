import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  deriveMachineNamespace,
  migratePersistedData,
} from '../src/settings';

const MACHINE_A = 'a'.repeat(32);
const MACHINE_B = 'b'.repeat(32);

describe('migratePersistedData', () => {
  it('uses the approved defaults for missing data', () => {
    expect(migratePersistedData(undefined, MACHINE_A)).toEqual({
      version: 2,
      machineNamespace: MACHINE_A,
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
    }, MACHINE_A);
    expect(result.settings.outputFolder).toBe('Browser History');
    expect(result.settings.layout).toBe('tiered');
    expect(result.settings.period).toBe('month');
    expect(result.cursors).toEqual({});
  });

  it('retains cursors only for versioned state from this machine namespace', () => {
    const saved = {
      version: 2,
      machineNamespace: MACHINE_A,
      settings: DEFAULT_SETTINGS,
      cursors: {
        'chrome:same-path': {
          visitedAtMs: Date.parse('2026-08-03T12:00:00Z'),
          sourceVisitId: '42',
        },
      },
    };

    expect(migratePersistedData(saved, MACHINE_A).cursors)
      .toEqual(saved.cursors);
    expect(migratePersistedData(saved, MACHINE_B)).toMatchObject({
      version: 2,
      machineNamespace: MACHINE_B,
      cursors: {},
    });
    expect(migratePersistedData({ ...saved, version: 1 }, MACHINE_A).cursors)
      .toEqual({});
  });

  it('derives a stable privacy-preserving namespace from injected local identity', () => {
    const identity = {
      platform: 'linux',
      hostname: 'private-workstation-name',
      homeDir: '/home/private-user',
    };
    const namespace = deriveMachineNamespace(identity);

    expect(namespace).toMatch(/^[a-f0-9]{32}$/);
    expect(deriveMachineNamespace(identity)).toBe(namespace);
    expect(deriveMachineNamespace({ ...identity, hostname: 'second-machine' }))
      .not.toBe(namespace);
    expect(namespace).not.toContain(identity.hostname);
    expect(namespace).not.toContain(identity.homeDir);
  });
});
