// #462: the right side after an agent turn. Whatever the agent changed on the OPEN
// work item must show without reopening it (owner, 2026-10-02: "you write that you
// are done, yet I do not see the presentation with ten slides on the right"). The
// slides were saved; the right side still showed the empty deck it had loaded before
// the turn. The real web/workbench.js runs; we check what it asks for and shows.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { workbenchHarness, itemsBody, PROJECT } from './helpers/workbench-harness.js'

const PRES = { id: 'w1', title: 'Közgyűlés', type: 'presentation', status: 'draft', current_version_id: 'v1', source_path: 'x/a.deck.json' }
const VIDEO = { id: 'w1', title: 'Bemutató', type: 'video', status: 'draft', current_version_id: 'v1' }
const STATUS = { status: 200, body: { provider: { available: true, model: 'm' }, usage: { usedPct: 1, measured: true }, allowed: true } }
const ASK = { role: 'user', content: 'készíts tíz diát' }
const ANSWER = { role: 'assistant', content: 'KÉSZ A TÍZ DIA' }
const TEN = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10']

const TIMELINE = {
  timeline: { version: 1, aspect: '16:9', clip_volume: 1, clips: [], subtitles: [], music: null, overlays: [] }, exists: false, duration: 0, offsets: [],
  limits: { aspects: ['16:9', '9:16', '1:1'] }, current: true, draft: null, history: { can_undo: false, can_redo: false }, orphans: [], last_render: null,
}

const slide = (id: string) => ({ id, notes: '', canvas: { version: 1, width: 1920, height: 1080, background: '#ffffff', objects: [] } })
const deckBody = (ids: string[]) => ({
  deck: { version: 1, size: '16:9', slides: ids.map(slide) }, exists: ids.length > 0, limits: { sizes: ['16:9', '4:3'] }, current: true, draft: null,
  history: { can_undo: false, can_redo: false }, orphans: [], rel: 'x/a.deck.json', name: 'a.deck.json', version_id: 'v1', version_no: 1,
})
const sse = (events: unknown[]): string[] => events.map((e) => `data: ${JSON.stringify(e)}\n\n`)

interface State { slides: string[]; running: boolean; answered: boolean }
type Message = { chunks: string[]; hold?: Promise<unknown> }

function serve(h: ReturnType<typeof workbenchHarness>, state: State, message: () => Message, item: Record<string, unknown> = PRES) {
  h.respond((url) => {
    if (url.includes('/api/workbench/agent/status')) return STATUS
    if (url.includes('/api/workbench/agent/message')) return { status: 200, body: null, stream: message() }
    if (url.includes('/api/workbench/agent/session')) {
      return { status: 200, body: { session: { id: 's1' }, running: state.running, toolCalls: [], messages: state.answered ? [ASK, ANSWER] : [] } }
    }
    if (url.includes('/deck')) return { status: 200, body: deckBody(state.slides) }
    if (url.includes('/items/w1/timeline')) return { status: 200, body: TIMELINE }
    if (url.includes('/api/workbench/media')) return { status: 200, body: { files: [] } }
    if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'deck' } }
    if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project: PROJECT } }
    return { status: 200, body: itemsBody([item]) }
  })
}

/** Opens the presentation with an EMPTY deck: the state the owner had before the turn. */
async function openEmptyDeck(state: State, message: () => Message) {
  const h = workbenchHarness()
  serve(h, state, message)
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.html()).toContain('workbench.deck.none_title'))
  expect(h.html()).not.toContain('wb-deck-strip')
  return h
}

function send(h: ReturnType<typeof workbenchHarness>) {
  h.inputs.wbChatInput = { value: ASK.content, focus() {} }
  h.click({ 'data-wb-act': 'chat-send' })
}

const deckGets = (h: ReturnType<typeof workbenchHarness>) => h.fetchCalls.filter((c) => /\/items\/w1\/deck\?/.test(c.url)).length

describe('the right side follows what the agent did on the open work item (#462)', () => {
  it('the full agent (code bridge) made the slides: they show when its answer arrives, without reopening', async () => {
    const state: State = { slides: [], running: false, answered: false }
    const h = await openEmptyDeck(state, () => ({
      chunks: sse([
        { type: 'session', sessionId: 's1' },
        { type: 'notice', code: 'code_bridge_handed_off', message: 'x' },
        { type: 'tool', name: 'code-bridge', status: 'running' },
        { type: 'tool', name: 'code-bridge', status: 'ok' },
        { type: 'text', text: ANSWER.content },
        { type: 'done', model: null },
      ]),
    }))
    // The full agent works on the files and the API by itself: by the time it answers, the deck is saved.
    state.slides = TEN
    send(h)
    await vi.waitFor(() => expect(h.html()).toContain('/deck/slide/d10.svg'), { timeout: 3000 })
    expect(h.html()).toContain(ANSWER.content)
    expect(h.html()).not.toContain('workbench.deck.none_title')
  })

  it('a full agent that stopped half way still shows what it left behind', async () => {
    const state: State = { slides: [], running: false, answered: false }
    const h = await openEmptyDeck(state, () => ({
      chunks: sse([
        { type: 'tool', name: 'code-bridge', status: 'running' },
        { type: 'tool', name: 'code-bridge', status: 'error' },
        { type: 'error', code: 'code_bridge_error', message: 'megszakadt' },
      ]),
    }))
    state.slides = ['d1', 'd2', 'd3']
    send(h)
    await vi.waitFor(() => expect(h.html()).toContain('/deck/slide/d3.svg'), { timeout: 3000 })
  })

  it('the built-in agent changed the deck (deck.edit): the slides show BEFORE the answer ends', async () => {
    const state: State = { slides: [], running: false, answered: false }
    let finish: (v?: unknown) => void = () => {}
    const hold = new Promise((r) => { finish = r })
    const h = await openEmptyDeck(state, () => ({ chunks: sse([{ type: 'tool', name: 'deck.edit', status: 'ok' }]), hold }))
    state.slides = TEN
    send(h)
    // The stream is still open (`hold` has not resolved), yet the right side is fresh.
    await vi.waitFor(() => expect(h.html()).toContain('/deck/slide/d10.svg'), { timeout: 3000 })
    finish()
  })

  it('a video timeline changed by the agent (timeline.edit) is asked for again', async () => {
    const state: State = { slides: [], running: false, answered: false }
    let finish: (v?: unknown) => void = () => {}
    const hold = new Promise((r) => { finish = r })
    const h = workbenchHarness()
    serve(h, state, () => ({ chunks: sse([{ type: 'tool', name: 'timeline.edit', status: 'ok' }]), hold }), VIDEO)
    h.win.MarvinWorkbench.open('p1', PROJECT.name)
    await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
    h.click({ 'data-wb-item': 'w1' })
    const timelines = () => h.fetchCalls.filter((c) => /\/items\/w1\/timeline\?/.test(c.url)).length
    await vi.waitFor(() => expect(timelines()).toBeGreaterThan(0))
    const before = timelines()
    send(h)
    await vi.waitFor(() => expect(timelines()).toBeGreaterThan(before), { timeout: 3000 })
    finish()
  })

  it('a tool that only READS, or one that failed, does not redraw the editor under the owner', async () => {
    const state: State = { slides: ['d1'], running: false, answered: false }
    let finish: (v?: unknown) => void = () => {}
    const hold = new Promise((r) => { finish = r })
    const h = workbenchHarness()
    serve(h, state, () => ({
      chunks: sse([
        { type: 'tool', name: 'deck.get', status: 'ok' },
        { type: 'tool', name: 'file.read', status: 'ok' },
        { type: 'tool', name: 'doc.outline', status: 'ok' },
        { type: 'tool', name: 'document.pages', status: 'ok' },
        { type: 'tool', name: 'deck.edit', status: 'error' },
        { type: 'tool', name: 'code-bridge', status: 'running' },
      ]),
      hold,
    }))
    h.win.MarvinWorkbench.open('p1', PROJECT.name)
    await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-deck-strip'))
    const before = deckGets(h)
    // The counter sees the deck request of the opening: a zero below is "none happened", not "could not see".
    expect(before).toBeGreaterThan(0)
    send(h)
    await new Promise((r) => setTimeout(r, 700))
    expect(deckGets(h)).toBe(before)
    finish()
  })

  describe('the answer arrived while the browser was not listening', () => {
    const HANDED = sse([
      { type: 'session', sessionId: 's1' },
      { type: 'notice', code: 'code_bridge_handed_off', message: 'x' },
      { type: 'tool', name: 'code-bridge', status: 'running' },
    ])

    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
    afterEach(() => { vi.useRealTimers() })

    it('the stream closed without "done" and the answer is already saved: the slides are loaded with it', async () => {
      const state: State = { slides: [], running: false, answered: false }
      const h = await openEmptyDeck(state, () => ({ chunks: HANDED }))
      send(h)
      state.slides = TEN
      state.answered = true
      await vi.advanceTimersByTimeAsync(50)
      await vi.waitFor(() => expect(h.html()).toContain(ANSWER.content))
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(h.html()).toContain('/deck/slide/d10.svg'))
    })

    it('the answer was still being made, the chat waited for it: when it is done the slides are loaded too', async () => {
      const state: State = { slides: [], running: false, answered: false }
      const h = await openEmptyDeck(state, () => ({ chunks: HANDED }))
      send(h)
      state.running = true
      await vi.advanceTimersByTimeAsync(50)
      await vi.waitFor(() => expect(h.html()).toContain('workbench.chat.resumed_running'))
      expect(h.html()).toContain('workbench.deck.none_title')
      state.running = false
      state.answered = true
      state.slides = TEN
      await vi.advanceTimersByTimeAsync(3100)
      await vi.waitFor(() => expect(h.html()).toContain(ANSWER.content))
      await vi.advanceTimersByTimeAsync(500)
      await vi.waitFor(() => expect(h.html()).toContain('/deck/slide/d10.svg'))
    })
  })
})
