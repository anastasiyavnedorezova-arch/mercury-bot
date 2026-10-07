// Простой ограничитель попыток в памяти процесса (скользящее окно).
// Достаточно для одного сервера; при перезапуске счётчики обнуляются.
export function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map(); // ключ -> массив моментов времени

  function fresh(key) {
    const t = now();
    const arr = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (arr.length) hits.set(key, arr);
    else hits.delete(key);
    return arr;
  }

  const timer = setInterval(() => {
    for (const k of [...hits.keys()]) fresh(k);
  }, Math.max(windowMs, 60_000));
  timer.unref?.();

  return {
    // Сколько секунд ждать; 0 — можно
    retryAfterSec(key) {
      const arr = fresh(key);
      if (arr.length < max) return 0;
      return Math.max(1, Math.ceil((windowMs - (now() - arr[0])) / 1000));
    },
    record(key) {
      const arr = fresh(key);
      arr.push(now());
      hits.set(key, arr);
    },
    clear(key) {
      hits.delete(key);
    },
    size: () => hits.size,
  };
}
