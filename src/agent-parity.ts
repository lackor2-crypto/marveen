// Fleet parity: every agent must get every capability, not just the main one.
//
// Why this module exists (Boss, 2026-08-11, after the third occurrence):
// "a rendszer meg mindig ugy gondolkodik mintha egy agent lenne bekotve. at
// kell irni a marveen programot hogy ne igy gondolkodjon! alapbol ha fejleszt
// valamit egy agentnal akor az osszeshez be kell kotni azonnal! nincs ilyen
// hogy az egyik igy fog viselkedni a masik meg ugy! egysegesnek kel lennie az
// agentek tudasanak!"
//
// The concrete failure: the channel image-downscale hook and the rate-limit
// guard were installed by standalone scripts straight into the MAIN agent's
// ~/.claude/settings.json. Sub-agents were never given them, and nothing said
// so -- a Telegram photo sent to a sub-agent quietly burned full-resolution
// context for months, and a sub-agent near its limit never learned to slow
// down. The mistake is invisible by construction: each agent works, just not
// the same way.
//
// The fix is structural. templates/settings.json.template is the ONE source of
// agent-facing hooks: ensureAgentHooks merges it into every agent on every
// dashboard start, so anything in it reaches the whole fleet automatically and
// retroactively (including agents created later). What this module adds is the
// alarm for the other direction: a hook that exists for the main agent but is
// missing from the template is DRIFT, and drift must either be fixed or
// declared main-only WITH A REASON. Silence is what we are outlawing.
//
// Pure by design (no fs, no env): the caller supplies the two inventories, so
// the same logic serves the unit test, the live-install test and the runtime
// startup check.

/** Hooks that DO reach every agent, just not through the template: an
 *  ensure*() routine in agent-scaffold.ts writes them per agent at startup
 *  (usually because the command has to be built per agent). Fleet-wide is
 *  fleet-wide -- what matters is that no agent is left out, not which
 *  mechanism gets it there. */
export const FLEET_WIDE_BY_CODE: ReadonlyArray<{ script: string; why: string }> = [
  {
    script: 'egress-gate.mjs',
    why: 'ensureEgressGate() writes it into every agent (the main one included) on each dashboard start; it stays out of the template because the command embeds the resolved node binary path.',
  },
  {
    script: 'no-stray-files.py',
    why: 'ensureStrayFileGate() writes it into every agent (the main one included) on each dashboard start; it stays out of the template because the command embeds the resolved PROJECT_ROOT, which differs per install and per worktree.',
  },
]

/** Hook scripts that are legitimately the main agent's alone. Every entry
 *  needs a reason -- an undocumented exception is exactly the drift this
 *  module exists to catch, so adding a name here is a decision, not a
 *  formality. */
export const MAIN_ONLY_HOOKS: ReadonlyArray<{ script: string; why: string }> = [
  {
    script: 'inbox-drain.py',
    why: 'The main agent is the only one on the PULL delivery path: the message router injects into sub-agent sessions directly, so a sub-agent has nothing to drain.',
  },
]

/** Hook scripts a sub-agent legitimately has and the main agent does not.
 *  Empty since 2026-08-20: the email-send + self-pace governance hard-gates
 *  that used to live here were removed by the owner's decision (Telegram msg
 *  404) -- routing every delegate's email + scheduling through the main agent
 *  made it a single point of failure. There is no longer any capability a
 *  sub-agent has that the main agent lacks. */
export const SUBAGENT_ONLY_HOOKS: ReadonlyArray<{ script: string; why: string }> = []

/** Extract the script basenames referenced by a settings.json hooks block.
 *  Commands differ in shape between installs (bare `python3 /abs/path.py`, the
 *  fail-open `bash -c '[ -f ... ] && exec ...'` wrapper, a symlinked
 *  ~/.claude/hooks copy), so the basename is the only stable identity. */
export function hookScriptNames(hooks: unknown): Set<string> {
  const out = new Set<string>()
  if (!hooks || typeof hooks !== 'object') return out
  for (const entries of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const list = (entry as { hooks?: unknown })?.hooks
      if (!Array.isArray(list)) continue
      for (const h of list) {
        const command = (h as { command?: unknown })?.command
        if (typeof command !== 'string') continue
        // Last path segment of the first script-looking token.
        for (const m of command.matchAll(/([A-Za-z0-9_.-]+\.(?:py|sh|mjs|js))\b/g)) {
          out.add(m[1])
        }
      }
    }
  }
  return out
}

export interface ParityDrift {
  /** Script the main agent runs that the fleet template does not carry. */
  script: string
  direction: 'main-only' | 'subagent-only'
}

/**
 * Capabilities one side has and the other does not, minus the declared
 * exceptions. An empty array is the only acceptable steady state.
 */
export function findParityDrift(mainScripts: Set<string>, templateScripts: Set<string>): ParityDrift[] {
  const byCode = new Set(FLEET_WIDE_BY_CODE.map(e => e.script))
  const declaredMainOnly = new Set(MAIN_ONLY_HOOKS.map(e => e.script))
  const declaredSubOnly = new Set(SUBAGENT_ONLY_HOOKS.map(e => e.script))
  const drift: ParityDrift[] = []
  for (const script of mainScripts) {
    if (templateScripts.has(script) || byCode.has(script) || declaredMainOnly.has(script)) continue
    drift.push({ script, direction: 'main-only' })
  }
  for (const script of templateScripts) {
    if (mainScripts.has(script) || byCode.has(script) || declaredSubOnly.has(script)) continue
    drift.push({ script, direction: 'subagent-only' })
  }
  return drift.sort((a, b) => a.script.localeCompare(b.script))
}

/** One human sentence per drift entry, for the log line and the owner alert. */
export function describeParityDrift(drift: ParityDrift[]): string {
  return drift
    .map(d => d.direction === 'main-only'
      ? `${d.script}: csak a fo agensnel fut, a tobbi agens nem kapja meg (tedd be a templates/settings.json.template-be, vagy vedd fel MAIN_ONLY_HOOKS-ba indoklassal)`
      : `${d.script}: a sablonban van, de a fo agensnel nem fut (kosd be a fo agensnel is, vagy vedd fel SUBAGENT_ONLY_HOOKS-ba indoklassal)`)
    .join('; ')
}
