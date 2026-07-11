export class AdminMutationMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => turn, () => turn);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const adminMutationMutex = new AdminMutationMutex();

export class AdminRecoveryState {
  private message?: string;

  get() {
    return this.message;
  }

  requireRecovery(message: string) {
    this.message = message;
  }
}

export const adminRecoveryState = new AdminRecoveryState();
