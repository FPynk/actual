export class ActualAdapterQueue {
  #tail: Promise<void> = Promise.resolve();
  #isClosed = false;

  close(): void {
    this.#isClosed = true;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#isClosed) throw new Error('Adapter queue is closed.');
    let release: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    if (this.#isClosed) {
      release!();
      throw new Error('Adapter queue is closed.');
    }
    try {
      return await operation();
    } finally {
      release!();
    }
  }
}
