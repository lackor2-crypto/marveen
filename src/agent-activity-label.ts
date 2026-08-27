// Per-agent "what is it doing right now" label used by GET /api/agents/activity
// (src/web/routes/agents.ts) and, through it, the Agents page's Terminal-button
// tint and the sidebar's global working badge.
//
// Kept in its own module, separate from the large routes/agents.ts, for the
// same reason pane-state.ts is: a small dependency graph (only pane-state.js)
// means this can be unit-tested directly against pane-text fixtures, instead
// of only being reachable through the whole HTTP route and its transitive
// imports.
import { detectPaneState, paneShowsLimitBlock, detectsBackgroundAgentActivity } from './pane-state.js'

// Remembers each agent's pane text from the previous /api/agents/activity poll,
// so the "working" label can go green on ANY visible change -- not only the
// specific patterns detectPaneState/detectsBackgroundAgentActivity recognize.
// Boss, 2026-08-17 (5th report of the same complaint): "mindegy mi folyik a
// terminalban, ha folyik valami akkor zoldet kell hogy mutasson [...] ha
// tomorites van az is zold, ha fingik egyet az is zold". Display-only: read by
// computeAgentActivityLabel below, never by detectPaneState/BUSY_INDICATORS
// (the message-delivery gate).
const lastPaneSeen = new Map<string, { pane: string; changedAt: number }>()
// A change caught on the previous poll still reads as "just happened" for one
// more tick, so a real update landing right between two 3s polls doesn't
// flicker back to idle before the next capture confirms it settled.
const PANE_CHANGE_GRACE_MS = 4000

export function paneRecentlyChanged(key: string, pane: string): boolean {
  const prev = lastPaneSeen.get(key)
  const now = Date.now()
  if (!prev || prev.pane !== pane) {
    lastPaneSeen.set(key, { pane, changedAt: now })
    return true
  }
  return now - prev.changedAt < PANE_CHANGE_GRACE_MS
}

// `key` identifies the agent for the pane-change cache above (MAIN_AGENT_ID
// for the main agent, the agent name for everyone else).
//
// `quotaExhausted` is the DURABLE limit signal, computed by the caller from the
// account's rate-limit snapshot (snapshotShowsQuotaExhausted). It exists
// because the pane banner is transient: Boss saw the main agent read
// "várakozik" while the Szakértő on the SAME weekly-out state read "keret
// elfogyott" (2026-08-27). The only difference was that Marvin's session had
// been restarted, so its "You've hit your weekly limit" banner had scrolled
// away and paneShowsLimitBlock no longer matched -- while the snapshot still
// knew 7d=100%. Passing the snapshot verdict in fixes that blind spot without
// pulling snapshot I/O into this pure, fixture-testable module.
export function computeAgentActivityLabel(running: boolean, pane: string | null, key: string, quotaExhausted = false): string {
  if (!running) return 'stopped'
  if (pane === null) return 'unknown'
  // An exhausted account does nothing until its window rolls over, however
  // busy the pane looks. Checked FIRST: Boss found the main agent's Terminal
  // button glowing green ("working") while its pane read "You've hit your
  // weekly limit -- resets Aug 14" (2026-08-11). Either the live banner OR the
  // durable snapshot verdict is enough -- the snapshot covers the case where a
  // restart wiped the banner (2026-08-27).
  if (paneShowsLimitBlock(pane) || quotaExhausted) return 'limited'
  const s = detectPaneState(pane)
  // 'busy' is the model actually generating or running a tool.
  if (s === 'busy') return 'working'
  // A backgrounded sub-agent task can still be ticking (elapsed time +
  // token counter in the FleetView tail below the footer) even once the
  // parent's own turn has ended and its prompt box is free -- that counts
  // as something happening.
  if (detectsBackgroundAgentActivity(pane)) return 'working'
  // Boss, 2026-08-17 (the 5th time he reported this exact problem): "mindegy
  // mi folyik a terminalban, ha folyik valami akkor zoldet kell hogy
  // mutasson" -- ANY visible change in the pane counts as "something is
  // happening", not only the specific patterns the two checks above
  // recognize (compaction progress, a plain `run_in_background` command's
  // own output, a thinking-spinner tick, anything). Display-only: this
  // never touches detectPaneState/BUSY_INDICATORS, so the message-delivery
  // gate that caused the 94-retry starvation incident stays untouched.
  // Excluded from 'typing': parked/pasted text is static once it lands, so
  // it would only trip this on the single tick it appeared, and treating a
  // stuck paste as "working" is exactly what lit the button on a dead agent
  // before (see the 'typing' comment below).
  if ((s === 'idle' || s === 'unknown' || s === 'error') && paneRecentlyChanged(key, pane)) return 'working'
  // 'typing' means TEXT IS PARKED IN THE INPUT BOX, which is not work: it is
  // usually a prompt nobody submitted, or a stuck line left behind. Treating
  // it as "working" is what lit the button green on a dead agent.
  if (s === 'idle' || s === 'typing') return 'idle'
  return s // 'unknown' | 'error'
}
