import { describe, expect, it } from 'vitest';
import {
  DEVICE_IDENTITY_STORAGE_KEY,
  LocalStorageDeviceIdentityPort,
} from '../src/device-identity';

describe('LocalStorageDeviceIdentityPort', () => {
  it('stores the durable raw token only under the plugin-specific local key', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const port = new LocalStorageDeviceIdentityPort(storage);

    expect(port.read()).toBeNull();
    port.write('local-secret-token');

    expect(port.read()).toBe('local-secret-token');
    expect([...values.entries()]).toEqual([
      [DEVICE_IDENTITY_STORAGE_KEY, 'local-secret-token'],
    ]);
    expect(DEVICE_IDENTITY_STORAGE_KEY).toContain('browser-history-sync');
  });
});
