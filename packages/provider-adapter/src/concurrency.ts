export function createSemaphore(max: number) {
  let running = 0;
  const waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (err: Error) => void;
    signal: AbortSignal | undefined;
  }> = [];

  function release() {
    running--;
    const next = waiters.shift();
    if (next) {
      if (next.signal?.aborted) {
        next.reject(new Error("ABORTED"));
        release();
      } else {
        running++;
        next.resolve(release);
      }
    }
  }

  return {
    acquire(signal?: AbortSignal): Promise<() => void> {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("ABORTED"));
          return;
        }
        if (running < max) {
          running++;
          resolve(release);
          return;
        }
        waiters.push({ resolve, reject, signal });
      });
    },
  };
}
