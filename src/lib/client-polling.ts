"use client";

export type ClientPollContext = {
  isVisible: boolean;
  failures: number;
};

export type ClientPoller = {
  start(): void;
  stop(): void;
  wake(): void;
  isRunning(): boolean;
};

type ClientPollerOptions = {
  task(signal: AbortSignal): Promise<void>;
  isActive(): boolean;
  isVisible(): boolean;
  nextDelayMs(context: ClientPollContext): number | null;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
};

/**
 * Single-flight browser poll scheduler. Unlike setInterval, a new tick is only
 * armed after the previous request settles. Returning null from nextDelayMs
 * pauses the poller until wake() is called (for example when a tab is visible
 * again).
 */
export function createClientPoller(options: ClientPollerOptions): ClientPoller {
  const schedule = options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((timer) => window.clearTimeout(timer as number));

  let stopped = true;
  let timer: unknown = null;
  let controller: AbortController | null = null;
  let wakeAfterRun = false;
  let failures = 0;

  const clearScheduled = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const arm = (delayMs: number) => {
    if (stopped || timer !== null || controller !== null) return;
    timer = schedule(() => {
      timer = null;
      void run();
    }, Math.max(0, delayMs));
  };

  const run = async () => {
    if (stopped || controller !== null) return;
    if (!options.isActive()) return;

    const currentController = new AbortController();
    controller = currentController;
    try {
      await options.task(currentController.signal);
      if (!currentController.signal.aborted) failures = 0;
    } catch (error) {
      if (!currentController.signal.aborted) failures += 1;
    } finally {
      if (controller === currentController) controller = null;
      if (stopped) return;
      if (wakeAfterRun) {
        wakeAfterRun = false;
        arm(0);
        return;
      }
      if (!options.isActive()) return;
      const delayMs = options.nextDelayMs({
        isVisible: options.isVisible(),
        failures,
      });
      if (delayMs !== null) arm(delayMs);
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      failures = 0;
      wakeAfterRun = false;
      arm(0);
    },
    stop() {
      stopped = true;
      wakeAfterRun = false;
      clearScheduled();
      controller?.abort();
      controller = null;
    },
    wake() {
      if (stopped) return;
      if (controller !== null) {
        wakeAfterRun = true;
        return;
      }
      clearScheduled();
      arm(0);
    },
    isRunning() {
      return !stopped;
    },
  };
}
