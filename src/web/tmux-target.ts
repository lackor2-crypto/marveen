// Exact-match tmux targets. Dependency-free on purpose: every module that talks
// to tmux (including the pure `tmux-keys` mapper) can import this without
// dragging in child_process/fs.
//
// tmux resolves a `-t` target LOOSELY: exact name first, then fnmatch, then an
// unambiguous PREFIX. Measured on tmux 3.4 with only `probe9` alive,
// `send-keys -t probe` succeeds and the keys land in probe9. In this fleet that
// is a live hazard -- `nemotronnano` and `nemotronnano9` are both configured
// agents, so a message, a /clear, an Escape, a capture or a kill-session aimed
// at the stopped `agent-nemotronnano` would hit the RUNNING `agent-nemotronnano9`
// instead. (Run-state detection was never affected: agentRunState compares whole
// lines of `list-sessions` output, see sessionInList.)
//
// `=name` forces an exact match, but bare `=name` is rejected by the pane
// commands (`send-keys`/`capture-pane`: "can't find pane: =name"). The one form
// every command accepts -- session, window and pane targets alike -- is `=name:`
// (measured OK: has-session, kill-session, rename-session, respawn-pane,
// list-panes, display-message, set/show-option, send-keys, capture-pane).
const BARE_TARGET_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** Exact-match tmux target for a session name. Idempotent. */
export function exactTmuxTarget(target: string): string {
  // Already exact, or an id-style target (%pane, $session) tmux resolves exactly.
  if (target.startsWith('=') || target.startsWith('%') || target.startsWith('$')) return target
  // `session:window[.pane]` -- only the session half is looked up loosely.
  const colon = target.indexOf(':')
  if (colon > 0) return BARE_TARGET_RE.test(target.slice(0, colon)) ? `=${target}` : target
  return BARE_TARGET_RE.test(target) ? `=${target}:` : target
}

/**
 * Rewrite every `-t <target>` in a tmux argv to its exact-match form. Scanning
 * stops at `--`, after which tmux treats everything as data (`send-keys -l --
 * -t` sends the literal text `-t`, it does not start a target).
 */
export function normalizeTmuxTargetArgs(args: readonly string[]): string[] {
  const out = [...args]
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '--') break
    if (out[i] !== '-t') continue
    const value = out[i + 1]
    if (typeof value === 'string' && value.length > 0) out[i + 1] = exactTmuxTarget(value)
    i++
  }
  return out
}
