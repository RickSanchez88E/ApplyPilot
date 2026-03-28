import { useEffect, type DependencyList } from 'react';

type PollCallback = (signal: AbortSignal) => void | Promise<void>;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function usePolling(callback: PollCallback, intervalMs: number, deps: DependencyList): void {
  useEffect(() => {
    let disposed = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;

    const run = async () => {
      if (disposed) return;
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleNext();
        return;
      }

      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;

      try {
        await callback(controller.signal);
      } catch (error) {
        if (!isAbortError(error)) {
          console.error('Polling callback failed', error);
        }
      } finally {
        if (inFlight === controller) {
          inFlight = null;
        }
      }

      scheduleNext();
    };

    const scheduleNext = () => {
      if (disposed) return;
      timeoutId = setTimeout(run, intervalMs);
    };

    const handleVisibilityChange = () => {
      if (disposed || typeof document === 'undefined' || document.hidden) return;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      void run();
    };

    void run();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      disposed = true;
      if (timeoutId) clearTimeout(timeoutId);
      inFlight?.abort();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
