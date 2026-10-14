export type Branch = "human" | "machine";

/** Caps concurrent Claude calls; queued human-layer calls start before machine-layer ones. */
// @spec PIPE-CALL-007, PIPE-CALL-008
export class Scheduler {
  private active = 0;
  private queue: { branch: Branch; start: () => void }[] = [];

  constructor(readonly cap: number) {}

  async run<T>(branch: Branch, fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((start) => {
      this.queue.push({ branch, start });
      this.drain();
    });
    try {
      return await fn();
    } finally {
      this.active--;
      this.drain();
    }
  }

  private drain() {
    while (this.active < this.cap && this.queue.length) {
      const i = this.queue.findIndex((q) => q.branch === "human");
      const [next] = this.queue.splice(i >= 0 ? i : 0, 1);
      this.active++;
      next.start();
    }
  }
}

/** An unlimited scheduler, for calls that are not counted against the cap. */
export const unlimited = { run: <T>(_b: Branch, fn: () => Promise<T>) => fn() };
