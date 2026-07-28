export function createCompactionGate(onRelease: () => void) {
  let generation = 0;
  let active = false;

  function end(expectedGeneration = generation): void {
    if (!active || expectedGeneration !== generation) return;

    // session_compact fires before Pi reconnects persistence.
    setTimeout(() => {
      if (expectedGeneration !== generation) return;
      active = false;
      generation += 1;
      onRelease();
    }, 0);
  }

  return {
    isActive: () => active,
    begin(signal?: AbortSignal): void {
      const currentGeneration = ++generation;
      active = true;
      signal?.addEventListener("abort", () => end(currentGeneration), { once: true });
    },
    end,
    reset(): void {
      active = false;
      generation += 1;
    },
    tryDeliver(deliver: () => void): boolean {
      if (active) return false;
      deliver();
      return true;
    },
  };
}
