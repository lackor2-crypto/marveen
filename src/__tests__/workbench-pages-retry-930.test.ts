// #930 (Boss TG 6519): the "Pages" switch was ON but the page showed no page lines until the switch was pressed off and on.
// Cause: one failed page measurement (a frozen dashboard, a slow PDF) set an error that every later redraw respected, so
// the measurement was never asked again. Now a failure is retried by itself, and a redraw asks again too.
// The browser code is RUN here (its own text, with the page's helpers stubbed), not only grepped.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
const fromConst = js.indexOf('var DP_PAGES_RETRIES')
const from = fromConst > 0 ? fromConst : js.indexOf('function dpPagesLoad()') // run the real function either way, so a regression fails on behaviour
const to = js.indexOf('/** After a redraw: put the lines back')

type Reply = { ok: boolean; data?: { hash: string; marks: unknown[]; pages: number }; message?: string }

function harness(replies: Reply[]) {
  const timers: Array<() => void> = []
  const toasts: string[] = []
  const calls: string[] = []
  const WB: Record<string, any> = { selectedId: 'item1', detail: { outline: { content_hash: 'h1' } } }
  const body = js.slice(from, to) + '\nreturn { dpPagesLoad: dpPagesLoad, dpPagesSoon: dpPagesSoon }'
  const mk = new Function('WB', 'api', 't', 'window', 'dpPagesOn', 'archived', 'dpPagesRoot', 'dpPagesButtonState', 'dpPagesPaint', 'twPagesAfterRender', 'dpPagesHash', 'setTimeout', 'clearTimeout', body)
  const api = (_m: string, url: string) => { calls.push(url); return Promise.resolve(replies.shift() ?? { ok: true, data: { hash: 'h1', marks: [], pages: 1 } }) }
  const f = mk(WB, api, (k: string) => k, { showToast: (m: string) => toasts.push(m) }, () => true, () => false, () => ({}), () => {}, () => {}, () => {}, () => 'h1', (fn: () => void) => { timers.push(fn); return timers.length }, () => {})
  return { WB, f, timers, toasts, calls }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('a failed page measurement is measured again by itself (#930)', () => {
  it('the source text to run is found', () => {
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
  })

  it('one failure: the error is said once, a new try is scheduled, and the next try draws the lines', async () => {
    const h = harness([{ ok: false, message: 'proba-hiba' }])
    h.f.dpPagesLoad()
    await flush()
    expect(h.WB.dpPagesError).toBe('proba-hiba')
    expect(h.toasts).toEqual(['proba-hiba'])
    expect(h.timers.length).toBe(1) // without the fix nothing asks again until the switch is pressed off and on
    h.timers.pop()!()
    await flush()
    expect(h.calls.length).toBe(2)
    expect(h.WB.dpPages).toMatchObject({ item: 'item1', hash: 'h1' })
    expect(h.WB.dpPagesFails).toBe(0)
  })

  it('repeated failures are said once and the automatic tries stop (no endless loop)', async () => {
    const h = harness(Array.from({ length: 10 }, () => ({ ok: false, message: 'x' })))
    h.f.dpPagesLoad()
    await flush()
    let guard = 0
    while (h.timers.length && guard++ < 20) { h.timers.pop()!(); await flush() }
    expect(h.toasts.length).toBe(1)
    expect(h.calls.length).toBe(5) // the first ask + 4 tries
  })
})
