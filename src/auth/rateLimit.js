/**
 * createRateLimiter({ windowMs, max, now? })
 * Returns a function `hit(key) => boolean`:
 *   true  — request allowed
 *   false — rate limit exceeded
 *
 * Uses a sliding-window counter stored in memory.
 */
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  // key → array of timestamps (ms) within the current window
  const windows = new Map();

  return function hit(key) {
    const ts = now();
    const cutoff = ts - windowMs;

    let hits = windows.get(key) ?? [];
    // Drop timestamps outside the window
    hits = hits.filter(t => t > cutoff);

    if (hits.length >= max) {
      windows.set(key, hits);
      return false;
    }

    hits.push(ts);
    windows.set(key, hits);
    return true;
  };
}
