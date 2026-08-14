import { describe, it, expect } from 'vitest'
import { syncAgentPromptHooks } from '../web/agent-scaffold.js'

// Regression cover for the frozen-prompt bug (kanban 55af1bfe, 2026-08-12):
// every merge pass in ensureAgentHooks keyed on hook.command, so a command-less
// `type: "agent"` hook (the PreCompact checkpoint prompt) was copied into an
// agent's settings.json once and then never updated again. Editing the shared
// template -- the documented single source of truth -- changed nothing for the
// whole existing fleet.

const tpl = (prompt: string, timeout = 180) => ({
  PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt, timeout }] }],
})

describe('syncAgentPromptHooks', () => {
  it('rewrites a stale prompt from the template', () => {
    const existing = { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'OLD', timeout: 180 }] }] }
    expect(syncAgentPromptHooks(existing, tpl('NEW'))).toBe(true)
    expect(existing.PreCompact[0].hooks[0].prompt).toBe('NEW')
  })

  it('is idempotent once the prompt matches', () => {
    const existing = { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'NEW', timeout: 180 }] }] }
    expect(syncAgentPromptHooks(existing, tpl('NEW'))).toBe(false)
  })

  it('syncs a changed timeout too', () => {
    const existing = { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'NEW', timeout: 60 }] }] }
    expect(syncAgentPromptHooks(existing, tpl('NEW', 180))).toBe(true)
    expect(existing.PreCompact[0].hooks[0].timeout).toBe(180)
  })

  it('adds the agent hook when the event exists but carries only command hooks', () => {
    const existing = { PreCompact: [{ matcher: 'auto', hooks: [{ command: 'bash /x.sh' }] }] }
    expect(syncAgentPromptHooks(existing, tpl('NEW'))).toBe(true)
    expect(existing.PreCompact).toHaveLength(2)
    expect((existing.PreCompact[1] as { hooks: Array<{ prompt?: string }> }).hooks[0].prompt).toBe('NEW')
  })

  it('leaves command hooks alone', () => {
    const existing = {
      PreCompact: [{ matcher: 'auto', hooks: [{ command: 'bash /x.sh' }, { type: 'agent', prompt: 'OLD' }] }],
    }
    syncAgentPromptHooks(existing, tpl('NEW'))
    expect(existing.PreCompact[0].hooks[0]).toEqual({ command: 'bash /x.sh' })
  })

  // The template owns the matcher set for events it declares a prompt hook in:
  // an agent-type hook under a matcher the template dropped goes away, rather
  // than lingering and firing a second time.
  it('drops an agent hook under a matcher the template no longer declares', () => {
    const existing = { PreCompact: [{ matcher: 'manual', hooks: [{ type: 'agent', prompt: 'STALE' }] }] }
    expect(syncAgentPromptHooks(existing, tpl('NEW'))).toBe(true)
    expect(existing.PreCompact).toHaveLength(1)
    expect(existing.PreCompact[0].matcher).toBe('auto')
    expect(existing.PreCompact[0].hooks[0].prompt).toBe('NEW')
  })

  it('ignores events the agent does not have (the add pass seeds those)', () => {
    const existing = { SessionStart: [{ matcher: 'compact', hooks: [{ command: 'python3 /y.py' }] }] }
    expect(syncAgentPromptHooks(existing, tpl('NEW'))).toBe(false)
  })
})

// Matcher widening (F2, kanban 55af1bfe): the PreCompact checkpoint went from
// matcher 'auto' to 'auto|manual' so a hand-typed /compact also checkpoints. The
// agents' settings still carried the narrow 'auto' entry, and leaving it there
// would have fired the hook twice on every automatic compact.
describe('syncAgentPromptHooks matcher reconciliation', () => {
  it('replaces a narrower matcher instead of adding a second entry', () => {
    const existing = { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'OLD' }] }] }
    expect(syncAgentPromptHooks(existing, { PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'agent', prompt: 'NEW' }] }] })).toBe(true)
    expect(existing.PreCompact).toHaveLength(1)
    expect(existing.PreCompact[0].matcher).toBe('auto|manual')
    expect(existing.PreCompact[0].hooks[0].prompt).toBe('NEW')
  })

  it('keeps command hooks that share the stale matcher entry', () => {
    const existing = {
      PreCompact: [{ matcher: 'auto', hooks: [{ command: 'bash /x.sh' }, { type: 'agent', prompt: 'OLD' }] }],
    }
    syncAgentPromptHooks(existing, { PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'agent', prompt: 'NEW' }] }] })
    expect(existing.PreCompact[0].hooks).toEqual([{ command: 'bash /x.sh' }])
    expect(existing.PreCompact).toHaveLength(2)
  })

  it('leaves events the template says nothing about untouched', () => {
    const existing = { SessionEnd: [{ matcher: 'x', hooks: [{ type: 'agent', prompt: 'MINE' }] }] }
    expect(syncAgentPromptHooks(existing, { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'NEW' }] }] })).toBe(false)
    expect(existing.SessionEnd[0].hooks[0].prompt).toBe('MINE')
  })
})

// Regression cover for kanban #128 (2026-08-14): the PreCompact checkpoint was
// a `type: "agent"` hook, and Claude Code rejects those outside the REPL --
// every Marveen agent runs in a tmux pane, so it failed on EVERY compaction and
// the checkpoint was never written. Fixing it means the template converts the
// hook to `type: "command"`, which empties tplPromptMatchers. The prune pass
// used to be guarded by `tplPromptMatchers.size > 0`, so it went dormant in
// exactly that case and the dead prompt hook would have stayed in all 15 live
// settings.json files, firing (and failing) alongside its own replacement.
describe('syncAgentPromptHooks when the template drops a prompt hook entirely', () => {
  // The template still declares PreCompact -- it just carries a command hook now.
  const tplCommandOnly = {
    PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'command', command: 'python3 /precompact.py', timeout: 20 }] }],
  }

  it('removes the obsolete agent hook', () => {
    const existing = {
      PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'agent', prompt: 'DEAD PROMPT', timeout: 180 }] }],
    }
    expect(syncAgentPromptHooks(existing, tplCommandOnly)).toBe(true)
    expect(existing.PreCompact).toHaveLength(0)
  })

  it('keeps a command hook that shared the entry with the obsolete agent hook', () => {
    const existing = {
      PreCompact: [{
        matcher: 'auto|manual',
        hooks: [{ type: 'command', command: 'python3 /precompact.py' }, { type: 'agent', prompt: 'DEAD PROMPT' }],
      }],
    }
    expect(syncAgentPromptHooks(existing, tplCommandOnly)).toBe(true)
    expect(existing.PreCompact).toHaveLength(1)
    expect(existing.PreCompact[0].hooks).toEqual([{ type: 'command', command: 'python3 /precompact.py' }])
  })

  it('is idempotent once the agent hook is gone', () => {
    const existing = {
      PreCompact: [{ matcher: 'auto|manual', hooks: [{ type: 'command', command: 'python3 /precompact.py' }] }],
    }
    expect(syncAgentPromptHooks(existing, tplCommandOnly)).toBe(false)
  })

  it('still leaves events the template says nothing about alone', () => {
    const existing = { Stop: [{ hooks: [{ type: 'agent', prompt: 'SOMEONE ELSE' }] }] }
    expect(syncAgentPromptHooks(existing, tplCommandOnly)).toBe(false)
    expect(existing.Stop[0].hooks).toHaveLength(1)
  })
})
