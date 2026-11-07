export class AccountLockMap {
  private readonly chains = new Map<string, Promise<void>>();

  public async run<T>(accountId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.then(() => gate);
    this.chains.set(accountId, chain);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.chains.get(accountId) === chain) {
        this.chains.delete(accountId);
      }
    }
  }
}
