// One `tmux list-sessions` per window, shared by every local caller.
//
// Why this exists (2026-08-12): agentRunState() ran its own `tmux list-sessions`
// per agent, and the dashboard polls /api/agents/activity every 3 seconds. With
// 14 agents that is 14 forks every 3 seconds for one piece of information --
// the list is IDENTICAL for all of them, it is the whole tmux server's session
// list. Every fork happens on the single event loop, so the page stops answering
// for the duration; measured at 125 ms per poll with one agent up, and the same
// forks are what turned a memory-starved VM into an unresponsive one.
//
// The cache is deliberately dumb: a value and a timestamp. It is invalidated
// explicitly whenever this process starts or stops a session, so a caller that
// acts and immediately re-reads sees the truth rather than its own stale
// "before" picture. TTL only bounds staleness caused by SOMEONE ELSE (a person
// in tmux, another agent, a crash).
export class SessionListCache {
  private value: string | null = null
  private at = 0

  constructor(private readonly ttlMs: number) {}

  /**
   * Fresh-enough cached listing, or `fetch()` once and cache it. A throwing
   * fetch (`no server running` when the fleet is fully stopped) is NOT cached
   * and propagates: callers already classify that exit status, and caching an
   * error would keep reporting "stopped" for a whole TTL after tmux comes back.
   */
  get(nowMs: number, fetch: () => string): string {
    if (this.value !== null && nowMs - this.at < this.ttlMs) return this.value
    const value = fetch()
    this.value = value
    this.at = nowMs
    return value
  }

  /** Forget the listing -- call after starting or stopping a session. */
  invalidate(): void {
    this.value = null
    this.at = 0
  }
}
