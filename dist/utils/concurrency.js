/**
 * Bounded-concurrency map (worker pool).
 *
 * Runs `fn` over `items` with at most `concurrency` in flight at once,
 * preserving input order in the returned results. Use this instead of a bare
 * `Promise.all(items.map(...))` whenever the work does network I/O over a
 * user-controlled or unbounded list — an unbounded fan-out can open hundreds of
 * sockets at once and pressure Bun's HTTP thread, while a strictly-serial loop
 * sums latency. A small pool (4–8) gets most of the speedup with neither risk.
 *
 * A rejection from any `fn` rejects the returned promise (after in-flight work
 * settles via the natural unwind); wrap `fn` in try/catch if you need
 * per-item error isolation.
 */
export async function mapWithConcurrency(items, concurrency, fn) {
    const results = new Array(items.length);
    if (items.length === 0)
        return results;
    const workers = Math.min(Math.max(1, concurrency), items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const i = next++;
            if (i >= items.length)
                return;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}
