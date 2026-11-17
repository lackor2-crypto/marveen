// Owner TG 4518: a work item the assistant creates must OPEN in the middle, not only show up in the tree.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SRC = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')

function build(WB: any, selected: string[]) {
  const a = SRC.indexOf('  function agentWatchStart()')
  const b = SRC.indexOf('  function load(projectId)')
  expect(a).toBeGreaterThan(0)
  const body = SRC.slice(a, b)
  const selectItem = (id: string) => { selected.push(id); WB.selectedId = id }
  // eslint-disable-next-line no-new-func
  return new Function('WB', 'selectItem', body + '\nreturn { agentWatchStart, openAgentCreated }')(WB, selectItem)
}

describe('agent-created work item opens', () => {
  it('opens the new item once, and not an old one', () => {
    const WB: any = { projectId: 'p', selectedId: null, items: [{ id: 'a', created_at: '2026-01-01' }] }
    const sel: string[] = []
    const f = build(WB, sel)
    f.agentWatchStart()
    f.openAgentCreated()
    expect(sel).toEqual([])
    WB.items = [{ id: 'a', created_at: '2026-01-01' }, { id: 'n', created_at: '2026-11-02' }]
    f.openAgentCreated()
    expect(sel).toEqual(['n'])
    f.openAgentCreated()
    expect(sel).toEqual(['n'])
  })
  it('does not yank the owner away from an item they chose meanwhile', () => {
    const WB: any = { projectId: 'p', selectedId: null, items: [] }
    const sel: string[] = []
    const f = build(WB, sel)
    f.agentWatchStart()
    WB.selectedId = 'mine'
    WB.items = [{ id: 'n', created_at: '2026-11-02' }]
    f.openAgentCreated()
    expect(sel).toEqual([])
  })
  // Measured in a real browser (#844 check): the swap refresh that runs WHILE the turn streams opened the new item at once,
  // the chat column switched to that item's empty chat and showed "idle" while the turn was still running.
  it('does not switch the middle and the chat while the turn still streams; opens at the turn end', () => {
    const WB: any = { projectId: 'p', selectedId: null, chatStreaming: true, items: [] }
    const sel: string[] = []
    const f = build(WB, sel)
    f.agentWatchStart()
    WB.items = [{ id: 'n', created_at: '2026-11-02' }]
    f.openAgentCreated()
    expect(sel).toEqual([])
    WB.chatStreaming = false
    f.openAgentCreated()
    expect(sel).toEqual(['n'])
  })
  it('an item seen during turn 1 still opens when a queued turn 2 starts right behind it', () => {
    const WB: any = { projectId: 'p', selectedId: null, chatStreaming: true, items: [] }
    const sel: string[] = []
    const f = build(WB, sel)
    f.agentWatchStart()
    WB.items = [{ id: 'n', created_at: '2026-11-02' }]
    f.openAgentCreated() // deferred: the turn is still streaming
    f.agentWatchStart() // turn 2 starts at once (flushChatQueue), the list already holds the new item
    f.openAgentCreated()
    expect(sel).toEqual([])
    WB.chatStreaming = false
    f.openAgentCreated()
    expect(sel).toEqual(['n'])
  })
  it('is wired into load, refreshTree and the chat turn start', () => {
    expect(SRC).toMatch(/openAgentCreated\(\)\n\s+render\(\)/g)
    expect((SRC.match(/openAgentCreated\(\)/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(SRC).toMatch(/WB\.chatStreaming = true\n\s+agentWatchStart\(\)/)
  })
})
