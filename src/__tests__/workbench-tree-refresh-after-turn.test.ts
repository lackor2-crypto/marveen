// The folder tree on the left follows what the agent did with COMMANDS (owner, 2026-10-13: the agent said "the folder is
// linked", the tree did not show it until F5). A folder link or a move is not a work-item tool, so the page has to ask
// the server again when the turn ends. The real web/workbench.js runs; we check what it asks for.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody, PROJECT } from './helpers/workbench-harness.js'

const STATUS = { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
const ASK = { role: 'user', content: 'kösd be a mappát' }
const sse = (events: unknown[]): string[] => events.map((e) => `data: ${JSON.stringify(e)}\n\n`)

function setup(tools: Array<{ name: string; status: string }>) {
  const h = workbenchHarness()
  h.respond((url) => {
    if (url.includes('/api/workbench/agent/status')) return STATUS
    if (url.includes('/api/workbench/agent/message')) {
      return { status: 200, body: null, stream: { chunks: sse([...tools.map((t) => ({ type: 'tool', ...t })), { type: 'text', text: 'KÉSZ' }, { type: 'done', model: null }]) } }
    }
    if (url.includes('/api/workbench/agent/session')) return { status: 200, body: { session: { id: 's1' }, running: false, toolCalls: [], messages: [] } }
    return { status: 200, body: itemsBody([]) }
  })
  return h
}

const itemsGets = (h: ReturnType<typeof workbenchHarness>) => h.fetchCalls.filter((c) => /\/api\/workbench\/items\?project=/.test(c.url)).length

async function turn(tools: Array<{ name: string; status: string }>) {
  const h = setup(tools)
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-items|wb-empty|workbench/))
  await vi.waitFor(() => expect(itemsGets(h)).toBeGreaterThan(0))
  const before = itemsGets(h)
  h.inputs.wbChatInput = { value: ASK.content, focus() {} }
  h.click({ 'data-wb-act': 'chat-send' })
  return { h, before }
}

describe('the folder tree is asked for again after an agent turn that ran commands', () => {
  it('a successful command (Bash) makes the page load the tree again, without F5', async () => {
    const { h, before } = await turn([{ name: 'Bash', status: 'ok' }])
    await vi.waitFor(() => expect(itemsGets(h)).toBeGreaterThan(before), { timeout: 3000 })
  })

  it('a turn without any successful tool does not reload the tree', async () => {
    const { h, before } = await turn([{ name: 'Bash', status: 'error' }])
    await new Promise((r) => setTimeout(r, 700))
    expect(before).toBeGreaterThan(0)
    expect(itemsGets(h)).toBe(before)
  })
})
