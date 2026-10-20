/**
 * Serializes async work for a key (e.g. a tab id) so concurrent callers
 * never interleave mutations on the same resource.
 */
export class MutexQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.tails.get(key) === next) {
          this.tails.delete(key);
        }
      });
    this.tails.set(key, next);
    return next;
  }

  pendingKeys(): string[] {
    return [...this.tails.keys()];
  }
}
