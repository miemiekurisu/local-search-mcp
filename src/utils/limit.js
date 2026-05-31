export async function mapLimit(items, concurrency, fn, { timeoutMs } = {}) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      if (timeoutMs) {
        results[i] = await Promise.race([
          fn(items[i], i),
          new Promise((_, reject) => setTimeout(
            () => reject(Object.assign(new Error(`mapLimit item timed out after ${timeoutMs}ms`), { code: 'MAP_LIMIT_TIMEOUT' })),
            timeoutMs
          ))
        ]);
      } else {
        results[i] = await fn(items[i], i);
      }
    }
  });
  await Promise.all(workers);
  return results;
}
