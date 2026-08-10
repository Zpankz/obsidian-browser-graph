export class BrowserSyncOperationAlreadyRunningError extends Error {
  constructor() {
    super('A Browser Sync operation is already running.');
    this.name = 'BrowserSyncOperationAlreadyRunningError';
  }
}

export class ExclusiveOperationGuard {
  private running = false;

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running) {
      throw new BrowserSyncOperationAlreadyRunningError();
    }
    this.running = true;
    try {
      return await operation();
    } finally {
      this.running = false;
    }
  }
}

export const browserSyncOperationGuard = new ExclusiveOperationGuard();
