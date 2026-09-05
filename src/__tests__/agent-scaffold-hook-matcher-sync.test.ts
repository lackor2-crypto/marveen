import { describe, it, expect } from 'vitest'
import { syncAgentHookMatchers } from '../web/agent-scaffold.js'

// Regression cover for kanban d345eb2c / #207 (2026-09-05): PR #17 widened the
// template's SessionStart matcher for taskstate-replay.py from "compact|resume"
// to "startup|compact|resume" so a plain restart also replays pending work, not
// just a compact/resume. ensureAgentHooks' add-pass dedups by exact command
// string, so a command that already exists (just under the old matcher) was
// never touched -- the live fleet kept the stale matcher through every restart
// since. This is syncAgentPromptHooks' matcher reconciliation, generalized from
// `type: "agent"` prompt hooks to `type: "command"` hooks.

describe('syncAgentHookMatchers', () => {
  it('moves a command hook from its stale matcher into the template matcher', () => {
    const existing = {
      SessionStart: [{ matcher: 'compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py', timeout: 15 }] }],
    }
    const tpl = {
      SessionStart: [{ matcher: 'startup|compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py', timeout: 15 }] }],
    }
    expect(syncAgentHookMatchers(existing, tpl)).toBe(true)
    expect(existing.SessionStart).toHaveLength(1)
    expect(existing.SessionStart[0].matcher).toBe('startup|compact|resume')
    expect(existing.SessionStart[0].hooks).toEqual([{ type: 'command', command: 'python3 /taskstate-replay.py', timeout: 15 }])
  })

  it('is idempotent once the matcher already matches', () => {
    const existing = {
      SessionStart: [{ matcher: 'startup|compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py' }] }],
    }
    const tpl = {
      SessionStart: [{ matcher: 'startup|compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py' }] }],
    }
    expect(syncAgentHookMatchers(existing, tpl)).toBe(false)
  })

  it('leaves a sibling command in the stale group alone when the template does not claim it', () => {
    const existing = {
      SessionStart: [{
        matcher: 'compact|resume',
        hooks: [
          { type: 'command', command: 'python3 /taskstate-replay.py' },
          { type: 'command', command: 'python3 /someone-elses-hook.py' },
        ],
      }],
    }
    const tpl = {
      SessionStart: [{ matcher: 'startup|compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py' }] }],
    }
    expect(syncAgentHookMatchers(existing, tpl)).toBe(true)
    expect(existing.SessionStart).toHaveLength(2)
    const stale = existing.SessionStart.find((e) => e.matcher === 'compact|resume')!
    expect(stale.hooks).toEqual([{ type: 'command', command: 'python3 /someone-elses-hook.py' }])
    const widened = existing.SessionStart.find((e) => e.matcher === 'startup|compact|resume')!
    expect(widened.hooks).toEqual([{ type: 'command', command: 'python3 /taskstate-replay.py' }])
  })

  it('merges into an existing group that already carries the target matcher instead of duplicating it', () => {
    const existing = {
      SessionStart: [
        { matcher: 'compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py' }] },
        { matcher: 'startup|compact|resume', hooks: [{ type: 'command', command: 'python3 /other-already-wide.py' }] },
      ],
    }
    const tpl = {
      SessionStart: [{ matcher: 'startup|compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py' }] }],
    }
    expect(syncAgentHookMatchers(existing, tpl)).toBe(true)
    expect(existing.SessionStart).toHaveLength(1)
    expect(existing.SessionStart[0].matcher).toBe('startup|compact|resume')
    expect(existing.SessionStart[0].hooks).toEqual([
      { type: 'command', command: 'python3 /other-already-wide.py' },
      { type: 'command', command: 'python3 /taskstate-replay.py' },
    ])
  })

  it('drops a group left empty after its only hook moved out', () => {
    const existing = {
      SessionStart: [{ matcher: 'compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py' }] }],
    }
    const tpl = {
      SessionStart: [{ matcher: 'startup|compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py' }] }],
    }
    syncAgentHookMatchers(existing, tpl)
    expect(existing.SessionStart.some((e) => e.matcher === 'compact|resume')).toBe(false)
  })

  it('leaves matcher-less groups alone when the template also declares no matcher for that command', () => {
    const existing = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'python3 /pending-work-replay.py' }] }],
    }
    const tpl = {
      SessionStart: [{ hooks: [{ type: 'command', command: 'python3 /pending-work-replay.py' }] }],
    }
    expect(syncAgentHookMatchers(existing, tpl)).toBe(false)
  })

  it('leaves events the template says nothing about untouched', () => {
    const existing = { SessionEnd: [{ matcher: 'x', hooks: [{ type: 'command', command: 'python3 /y.py' }] }] }
    expect(syncAgentHookMatchers(existing, { SessionStart: [{ matcher: 'startup', hooks: [{ command: 'python3 /z.py' }] }] })).toBe(false)
    expect(existing.SessionEnd[0].matcher).toBe('x')
  })

  it('ignores hooks with no command (handled by syncAgentPromptHooks instead)', () => {
    const existing = { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'X' }] }] }
    expect(syncAgentHookMatchers(existing, { PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'agent', prompt: 'X' }] }] })).toBe(false)
  })

  // The exact live-fleet shape (2026-09-05): taskstate-replay.py under the stale
  // matcher, broker-role.py and pending-work-replay.py matcher-less and already
  // correct -- only the first should move.
  it('reproduces the live SessionStart shape: widens only the stale entry', () => {
    const existing = {
      SessionStart: [
        { matcher: 'compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py', timeout: 15 }] },
        { hooks: [{ type: 'command', command: "bash -c '[ -f /broker-role.py ] && exec python3 /broker-role.py; exit 0'", timeout: 10 }] },
        { hooks: [{ type: 'command', command: "bash -c '[ -f /pending-work-replay.py ] && exec python3 /pending-work-replay.py; exit 0'", timeout: 15 }] },
      ],
    }
    const tpl = {
      SessionStart: [
        { matcher: 'startup|compact|resume', hooks: [{ type: 'command', command: 'python3 /taskstate-replay.py', timeout: 15 }] },
        {
          hooks: [
            { type: 'command', command: "bash -c '[ -f /broker-role.py ] && exec python3 /broker-role.py; exit 0'", timeout: 10 },
            { type: 'command', command: "bash -c '[ -f /pending-work-replay.py ] && exec python3 /pending-work-replay.py; exit 0'", timeout: 15 },
          ],
        },
      ],
    }
    expect(syncAgentHookMatchers(existing, tpl)).toBe(true)
    const widened = existing.SessionStart.find((e) => (e.hooks ?? []).some((h) => h.command === 'python3 /taskstate-replay.py'))!
    expect(widened.matcher).toBe('startup|compact|resume')
    expect(existing.SessionStart.some((e) => e.matcher === 'compact|resume')).toBe(false)
    // Matcher-less groups for the other two scripts are untouched (no matcher key added).
    const untouchedGroups = existing.SessionStart.filter((e) => e.matcher === undefined)
    expect(untouchedGroups).toHaveLength(2)
  })
})
