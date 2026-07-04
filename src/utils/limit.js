export async function mapLimit(items, concurrency, fn, { timeoutMs } = {}) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      if (timeoutMs) {
        let timerId;
        const timeoutPromise = new Promise((_, reject) => {
          timerId = setTimeout(
            () => reject(Object.assign(new Error(`mapLimit item timed out after ${timeoutMs}ms`), { code: 'MAP_LIMIT_TIMEOUT' })),
            timeoutMs
          );
          if (typeof timerId?.unref === 'function') timerId.unref();
        });
        try {
          results[i] = await Promise.race([fn(items[i], i), timeoutPromise]);
        } finally {
          clearTimeout(timerId);
        }
      } else {
        results[i] = await fn(items[i], i);
      }
    }
  });
  await Promise.all(workers);
  return results;
}
