/**
 * Run one rebuild at a time while retaining no more than one dirty rerun.
 * @param {() => Promise<void>} rebuild
 */
export function createSingleFlightRebuilder(rebuild: () => Promise<void>) {
  let stopped = false;
  let running = false;
  let dirty = false;
  let active = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  async function drain() {
    running = true;
    try {
      do {
        dirty = false;
        await rebuild();
      } while (dirty && !stopped);
    } finally {
      running = false;
      dirty = false;
    }
  }

  return {
    request() {
      if (stopped) return;
      dirty = true;
      if (!running) active = drain();
    },
    whenIdle() {
      return active;
    },
    close() {
      stopped = true;
      dirty = false;
      closePromise ??= active;
      return closePromise;
    },
  };
}
