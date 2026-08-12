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

  // A different matcher is a different hook: 'manual' must not be overwritten
  // by the template's 'auto' entry.
  it('does not cross matcher boundaries', () => {
    const existing = { PreCompact: [{ matcher: 'manual', hooks: [{ type: 'agent', prompt: 'MANUAL' }] }] }
    expect(syncAgentPromptHooks(existing, tpl('NEW'))).toBe(true)
    expect(existing.PreCompact[0].hooks[0].prompt).toBe('MANUAL')
    expect(existing.PreCompact).toHaveLength(2)
  })

  it('ignores events the agent does not have (the add pass seeds those)', () => {
    const existing = { SessionStart: [{ matcher: 'compact', hooks: [{ command: 'python3 /y.py' }] }] }
    expect(syncAgentPromptHooks(existing, tpl('NEW'))).toBe(false)
  })
})
