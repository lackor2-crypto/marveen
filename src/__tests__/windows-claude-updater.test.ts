import { describe, it, expect, vi } from 'vitest'
import {
  updateWindowsClaudeForBridge, parseOutdatedVersions, compareVersions, windowsUpdatePossible,
  type WindowsUpdateDeps,
} from '../windows-claude-updater.js'
import { runCodeBridgeTurn, type CodeBridgeTaskView } from '../workbench-agent/code-bridge-turn.js'
import type { OrchestratorEvent } from '../workbench-agent/orchestrator.js'

const ERR = 'API Error: 400 Claude Code 2.1.226 does not support this model; version 2.1.280 or newer is required'

function deps(over: Partial<WindowsUpdateDeps> & { versions?: string[] } = {}): WindowsUpdateDeps & { ran: string[]; saved: unknown[]; opened: string[] } {
  const versions = over.versions ?? ['2.1.226', '2.1.284']
  const ran: string[] = []
  const saved: unknown[] = []
  const opened: string[] = []
  let state: any = null
  const d: any = {
    now: () => 1_000_000_000_000,
    powershellPath: '/x/powershell.exe',
    exists: () => true,
    runPowershell: async (cmd: string) => {
      ran.push(cmd)
      if (cmd === 'claude --version') return `${versions.shift() ?? versions[0] ?? ''} (Claude Code)\r\n`
      return 'ok'
    },
    level: () => 3,
    loadState: () => state,
    saveState: (s: unknown) => { state = s; saved.push(s) },
    latestApproval: () => undefined,
    openApproval: (desc: string) => { opened.push(desc) },
    ...over,
  }
  d.ran = ran; d.saved = saved; d.opened = opened
  return d
}

describe('windows claude updater (#446)', () => {
  it('parses the versions out of the bridge error', () => {
    expect(parseOutdatedVersions(ERR)).toEqual({ have: '2.1.226', need: '2.1.280' })
    expect(compareVersions('2.1.284', '2.1.280')).toBeGreaterThan(0)
    expect(compareVersions('2.1.226', '2.1.280')).toBeLessThan(0)
  })

  it('updates when Windows is older than the error asks for', async () => {
    const d = deps()
    const r = await updateWindowsClaudeForBridge(ERR, d)
    expect(r.status).toBe('updated')
    expect(r.before).toBe('2.1.226')
    expect(r.after).toBe('2.1.284')
    expect(d.ran).toContain('claude update')
    expect(r.message).toMatch(/2\.1\.226 -> 2\.1\.284/)
    expect(r.messageEn).toMatch(/updated/)
  })

  it('stays silent without Windows PowerShell (fresh Linux install)', async () => {
    const d = deps({ exists: () => false })
    const r = await updateWindowsClaudeForBridge(ERR, d)
    expect(r.status).toBe('not_applicable')
    expect(r.message).toBe('')
    expect(d.ran).toEqual([])
    expect(windowsUpdatePossible(() => false)).toBe(false)
  })

  it('does nothing when the Windows program is already new enough', async () => {
    const d = deps({ versions: ['2.1.284'] })
    const r = await updateWindowsClaudeForBridge(ERR, d)
    expect(r.status).toBe('not_applicable')
    expect(d.ran).not.toContain('claude update')
  })

  it('allows only one attempt per hour and reports a version that did not grow', async () => {
    const d = deps({ versions: ['2.1.226', '2.1.226', '2.1.226'] })
    const first = await updateWindowsClaudeForBridge(ERR, d)
    expect(first.status).toBe('no_change')
    const second = await updateWindowsClaudeForBridge(ERR, d)
    expect(second.status).toBe('too_soon')
    expect(d.ran.filter((c) => c === 'claude update')).toHaveLength(1)
  })

  it('reports a failed update with the real error', async () => {
    const d = deps({ versions: ['2.1.226', '2.1.226'] })
    const base = d.runPowershell
    d.runPowershell = async (c, t) => { if (c === 'claude update') throw new Error('network down'); return base(c, t) }
    const r = await updateWindowsClaudeForBridge(ERR, d)
    expect(r.status).toBe('failed')
    expect(r.message).toMatch(/network down/)
  })

  it('below autonomy level 3 it asks once and does not update', async () => {
    const d = deps({ level: () => 2 })
    const r = await updateWindowsClaudeForBridge(ERR, d)
    expect(r.status).toBe('needs_approval')
    expect(d.opened).toHaveLength(1)
    expect(d.ran).not.toContain('claude update')
  })

  it('below level 3 an approved ticket lets it run, once', async () => {
    const approved: any = { id: 'a1', status: 'approved', requested_at: 1, category: 'package_install', action_payload: '{}' }
    const d = deps({ level: () => 2, latestApproval: () => approved, versions: ['2.1.226', '2.1.284', '2.1.226'] })
    const r = await updateWindowsClaudeForBridge(ERR, d)
    expect(r.status).toBe('updated')
    expect((d.saved[0] as any).usedApprovalId).toBe('a1')
  })
})

describe('code bridge turn repairs an outdated bridge (#446)', () => {
  it('updates, starts the task again and returns the second answer', async () => {
    const tasks: Record<string, CodeBridgeTaskView> = {
      t1: { status: 'error', result: null, summary: null, error: ERR },
      t2: { status: 'done', result: 'Kész.', summary: null, error: null },
    }
    let n = 0
    const enqueue = vi.fn(() => ({ ok: true as const, id: `t${++n}` }))
    const repair = vi.fn(async () => ({ updated: true, notice: 'A Windowsos Claude Code frissült.' }))
    const events: OrchestratorEvent[] = []
    for await (const ev of runCodeBridgeTurn(
      { projectRef: 'p', message: 'hi', lang: 'hu', requestedBy: null },
      { enqueue, getTask: (id) => tasks[id] ?? null, now: () => 0, sleep: async () => {}, repairOutdatedBridge: repair },
    )) events.push(ev)
    expect(repair).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.type === 'text' && (e as any).text === 'Kész.')).toBe(true)
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('does not loop: a second outdated answer ends as the usual outdated error', async () => {
    const enqueue = vi.fn(() => ({ ok: true as const, id: 't' }))
    const repair = vi.fn(async () => ({ updated: true, notice: null }))
    const events: OrchestratorEvent[] = []
    for await (const ev of runCodeBridgeTurn(
      { projectRef: 'p', message: 'hi', lang: 'hu', requestedBy: null },
      { enqueue, getTask: () => ({ status: 'error', result: null, summary: null, error: ERR }), now: () => 0, sleep: async () => {}, repairOutdatedBridge: repair },
    )) events.push(ev)
    expect(repair).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'code_bridge_outdated' })
  })

  it('without an update the old outdated handling stays', async () => {
    const repair = vi.fn(async () => ({ updated: false, notice: null }))
    const events: OrchestratorEvent[] = []
    for await (const ev of runCodeBridgeTurn(
      { projectRef: 'p', message: 'hi', lang: 'hu', requestedBy: null },
      { enqueue: () => ({ ok: true, id: 't' }), getTask: () => ({ status: 'error', result: null, summary: null, error: ERR }), now: () => 0, sleep: async () => {}, repairOutdatedBridge: repair },
    )) events.push(ev)
    expect(events.find((e) => e.type === 'error')).toMatchObject({ code: 'code_bridge_outdated' })
  })
})
