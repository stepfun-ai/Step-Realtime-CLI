export function raceWithAbort<T>(
  signal: AbortSignal,
  work: Promise<T>,
  onAbort: () => T,
): Promise<T> {
  let removeListener: () => void = () => {};
  const aborted = new Promise<T>((resolve) => {
    const listener = () => {
      removeListener();
      resolve(onAbort());
    };
    if (signal.aborted) {
      listener();
      return;
    }
    signal.addEventListener("abort", listener, { once: true });
    removeListener = () => signal.removeEventListener("abort", listener);
  });

  return Promise.race([work, aborted]).finally(removeListener);
}
