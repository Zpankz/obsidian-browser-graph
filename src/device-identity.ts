import { createHash, randomBytes } from 'node:crypto';

export const DEVICE_IDENTITY_STORAGE_KEY = 'browser-history-sync:device-identity';
const DEVICE_TOKEN = /^[a-f0-9]{64}$/;

export interface DeviceIdentityPort {
  read(): string | null;
  write(token: string): void;
}

export class LocalStorageDeviceIdentityPort implements DeviceIdentityPort {
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>,
    private readonly key = DEVICE_IDENTITY_STORAGE_KEY,
  ) {}

  read(): string | null {
    return this.storage.getItem(this.key);
  }

  write(token: string): void {
    this.storage.setItem(this.key, token);
  }
}

export function hashDeviceIdentityToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function resolveDeviceIdentity(
  port: DeviceIdentityPort,
  createToken: () => string = () => randomBytes(32).toString('hex'),
): string {
  let token = port.read();
  if (token === null || !DEVICE_TOKEN.test(token)) {
    token = createToken();
    if (!DEVICE_TOKEN.test(token)) {
      throw new Error('Browser Sync could not create a valid local device identity.');
    }
    port.write(token);
  }
  return hashDeviceIdentityToken(token);
}
