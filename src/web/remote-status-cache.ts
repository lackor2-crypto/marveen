// Short-TTL cache for remote-agent status so the synchronous dashboard
// endpoints (`/api/agents`, polled on load; `/api/agents/activity`, polled every
// 3s) do not issue a fresh blocking ssh call on every request. A remote ssh
// round-trip against a sleeping laptop can take up to the ConnectTimeout/
// ServerAlive bound (~5s), and Node's event loop is single-threaded, so an
// uncached call would freeze the dashboard for ALL agents (local included).
//
// With a few-second TTL each remote agent is probed at most once per window;
// every other poll reads the cache and returns instantly. NOTE: the miss path
// fetches SYNCHRONOUSLY -- a cold miss against a sleeping laptop blocks that one
// request for the full ssh timeout (~5-8s). The TTL bounds this to once per
// window per agent (the dominant fix), so the dashboard is not frozen on every
// poll, but it is not non-blocking. A throwing fetch (host unreachable) never
// escapes: the last-known value is returned if we have one, otherwise the
// caller-supplied fallback. Local agents are never cached -- their tmux calls
// are sub-millisecond, so they always fetch fresh.
//
// (Fully async/non-blocking refresh via child_process.spawn is a deferred idea.)
export class RemoteStatusCache<T> {
  private store = new Map<string, { value: T; at: number }>()

  constructor(private readonly ttlMs: number) {}

  /**
   * Return a fresh-enough cached value, or call `fetch()` once, cache, and
   * return it. If `fetch` throws, return the last-known value when present, else
   * `fallback` (when provided) -- the error never propagates to the HTTP layer.
   */
  getOrRefresh(key: string, nowMs: number, fetch: () => T, fallback?: T): T {
    const entry = this.store.get(key)
    if (entry && nowMs - entry.at < this.ttlMs) return entry.value
    try {
      const value = fetch()
      this.store.set(key, { value, at: nowMs })
      return value
    } catch {
      if (entry) return entry.value
      return fallback as T
    }
  }

  /** Drop a key (e.g. when an agent is deleted or its remote config cleared). */
  invalidate(key: string): void {
    this.store.delete(key)
  }
}

/**
 * The deferred idea above, delivered (2026-08-12). Same short-TTL shape, but the
 * refresh happens OFF the event loop: a stale entry is served immediately and a
 * promise is kicked to replace it. Only the very first call for a key pays a
 * synchronous fetch, so a polled endpoint never forks a child process while a
 * request is waiting on it.
 *
 * Boss reported the dashboard as frozen; /api/agents/activity was spending
 * 131 ms of every 3-second poll inside synchronous tmux captures, and that time
 * is time the whole server answers nobody.
 */
export class BackgroundCache<T> {
  private store = new Map<string, { value: T; at: number }>()
  private inFlight = new Set<string>()

  constructor(private readonly ttlMs: number) {}

  /**
   * Last known value, refreshed in the background when stale. `coldFetch` runs
   * synchronously exactly once per key (the first ever call) so a fresh process
   * still answers with real data instead of a placeholder. A rejected refresh
   * keeps the previous value and is retried on the next call.
   */
  get(key: string, nowMs: number, refresh: () => Promise<T>, coldFetch: () => T): T {
    const entry = this.store.get(key)
    if (!entry) {
      let value: T
      try { value = coldFetch() } catch { value = undefined as T }
      this.store.set(key, { value, at: nowMs })
      return value
    }
    if (nowMs - entry.at >= this.ttlMs && !this.inFlight.has(key)) {
      this.inFlight.add(key)
      void refresh()
        .then((value) => { this.store.set(key, { value, at: Date.now() }) })
        .catch(() => { /* keep the last known value; retried next call */ })
        .finally(() => { this.inFlight.delete(key) })
    }
    return entry.value
  }

  invalidate(key: string): void {
    this.store.delete(key)
  }
}
