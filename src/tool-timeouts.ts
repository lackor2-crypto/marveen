// Per-tool outgoing HTTP deadline (ms).
// If an external service doesn't respond within the allotted time, the
// request is aborted and the caller receives an Error so it can log and fall
// back gracefully instead of hanging the whole agent session.
export const TOOL_TIMEOUTS = {
  'google-calendar': 5_000,
  'telegram':        10_000,
  'github':          10_000,
  'slack':           10_000,
  // CPU-only Ollama embeds a ~1500-char memory in 40-60s, which overran the
  // former 30s deadline and left large memories permanently un-vectorized
  // (search silently fell back to FTS). 90s covers the slow CPU path.
  'ollama-embedding': 90_000,
  // The CHEAP question ("are you there, and do you have the model?") asked
  // before a backfill run. It must not inherit the 90s embedding deadline: a
  // target that swallows packets would otherwise keep the owner waiting
  // minutes for an answer the probe can give in seconds (kanban 11da9dcb).
  'ollama-probe': 3_000,
} as const

// How many CONSECUTIVE embedding failures end a backfill run. A dead or
// mis-configured server answers the same way to every one of a few hundred
// memories, so the run has nothing left to learn after a handful of tries --
// it would only burn hours (measured: a healthy 138-memory run already takes
// ~3.5 minutes, kanban #134). A single failure does not stop the run: one
// oversized memory must not cancel the rest.
export const OLLAMA_EMBED_FAILFAST = 3
