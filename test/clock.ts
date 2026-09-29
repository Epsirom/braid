import type { TestContext } from "node:test";

// Runtime deadlines use both setTimeout and performance.now(). Freeze both so
// asynchronous workspace preparation never consumes a test's time budget.
// TestContext restores the mocks after each test; the test's own timeout stays real.
export function mockClock(t: TestContext) {
  let now = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(performance, "now", () => now);
  // Node 22.0's MockTimers dereferences undefined in clearTimeout, unlike the
  // real API. Unlimited deadlines legitimately have no timer to clear.
  const clearTimer = globalThis.clearTimeout;
  t.mock.method(globalThis, "clearTimeout", (timer: Parameters<typeof clearTimeout>[0]) => {
    if (timer !== undefined) clearTimer(timer);
  });
  return {
    advance(ms: number) {
      now += ms;
      t.mock.timers.tick(ms);
    },
    // Model an event loop that has not yet delivered expired timer callbacks.
    advanceWithoutTimers(ms: number) {
      now += ms;
    },
  };
}
