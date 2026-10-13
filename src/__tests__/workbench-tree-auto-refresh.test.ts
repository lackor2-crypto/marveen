// The Workbench lists follow the disk by themselves (owner, 2026-10-13: "I upload something, or anything else changes:
// refresh every 20 seconds or so"). The real web/workbench.js runs with fake timers; we check what it asks for and shows.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { workbenchHarness, itemsBody, PROJECT } from './helpers/workbench-harness.js'

const ITEM = (id: string, title: string) => ({ id, title, type: 'document', status: 'draft', current_version_id: 'v1' })
const itemsGets = (h: ReturnType<typeof workbenchHarness>) => h.fetchCalls.filter((c) => /\/api\/workbench\/items\?project=/.test(c.url)).length

describe('the Workbench lists are asked for again every 20 seconds', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }) })
  afterEach(() => { vi.useRealTimers() })

  async function opened(list: () => unknown[]) {
    const h = workbenchHarness()
    h.respond((url) => {
      if (/\/api\/workbench\/items\?project=/.test(url)) return { status: 200, body: itemsBody(list()) }
      return { status: 200, body: {} }
    })
    h.win.MarvinWorkbench.open('p1', PROJECT.name)
    await vi.advanceTimersByTimeAsync(500)
    return h
  }

  it('a new work item that appeared outside the page shows within 20 s, without F5', async () => {
    let list = [ITEM('w1', 'Első irat')]
    const h = await opened(() => list)
    expect(h.html()).toContain('Első irat')
    expect(h.html()).not.toContain('Feltöltött új')
    const before = itemsGets(h)
    expect(before).toBeGreaterThan(0)
    list = [ITEM('w1', 'Első irat'), ITEM('w2', 'Feltöltött új')]
    await vi.advanceTimersByTimeAsync(21000)
    expect(itemsGets(h)).toBeGreaterThan(before)
    expect(h.html()).toContain('Feltöltött új')
  })

  it('nothing changed: it asks, but the page is not redrawn under the owner', async () => {
    const list = [ITEM('w1', 'Első irat')]
    const h = await opened(() => list)
    const before = itemsGets(h)
    const html = h.html()
    await vi.advanceTimersByTimeAsync(21000)
    expect(itemsGets(h)).toBeGreaterThan(before)
    expect(h.html()).toBe(html)
  })
})
