// Phase 5, video: the timeline editor on a video work item. The real
// web/workbench.js runs; we check what it shows and what it sends.
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody, untranslatedHungarian, PROJECT } from './helpers/workbench-harness.js'

const VIDEO = { id: 'w1', title: 'Reklam', type: 'video', status: 'draft', current_version_id: 'v1' }
const DOC = {
  version: 1, aspect: '16:9', clip_volume: 1,
  clips: [{ id: 'c1', src: 'Projektek/p1/a.mp4', start: 0, end: 10 }, { id: 'c2', src: 'Projektek/p1/b.mp4', start: 2, end: 6 }],
  subtitles: [{ id: 's1', text: 'Szia', start: 1, end: 3 }],
  music: null, overlays: [],
}
const TL = {
  timeline: DOC, exists: true, duration: 14, offsets: [0, 10],
  limits: { aspects: ['16:9', '9:16', '1:1'] }, current: true, draft: null,
  history: { can_undo: true, can_redo: false }, orphans: [], last_render: null,
}

async function open(extra: Record<string, unknown> = {}) {
  const h = workbenchHarness()
  h.respond((url, init) => {
    if (url.includes('/timeline/autosubtitle')) {
      return { status: 200, body: { ok: true, timeline: DOC, duration: 14, offsets: [0, 10], added: 2, skipped: ['x.mp4'], message: 'Kész az automatikus felirat.' } }
    }
    if (url.includes('/timeline/ops')) {
      return { status: 200, body: { ok: true, timeline: DOC, summary: '', duration: 14, offsets: [0, 10], created: false, ...extra } }
    }
    if (url.includes('/timeline')) return { status: 200, body: TL }
    if (url.includes('/api/workbench/media')) {
      return { status: 200, body: { files: [{ path: 'Projektek/p1/c.mp4', name: 'c.mp4', kind: 'video', bytes: 1 }, { path: 'Projektek/p1/z.mp3', name: 'z.mp3', kind: 'audio', bytes: 1 }], truncated: false } }
    }
    if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'timeline' } }
    if (url.includes('/api/workbench/items/w1')) {
      return { status: 200, body: { item: VIDEO, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project: PROJECT } }
    }
    void init
    return { status: 200, body: itemsBody([VIDEO]) }
  })
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.html()).toContain('workbench.vt.clips'))
  return h
}

describe('video timeline editor (phase 5)', () => {
  it('shows clips, subtitles, aspect buttons and the length; no raw Hungarian text', async () => {
    const h = await open()
    const html = h.html()
    expect(html).toContain('a.mp4')
    expect(html).toContain('b.mp4')
    expect(html).toContain('value="Szia"')
    expect(html).toContain('data-wb-act="vt-aspect" data-wb-v="9:16"')
    expect(html).toContain('workbench.vt.length')
    expect(html).toContain('data-wb-act="vt-render"')
    expect(untranslatedHungarian(html, ['Reklam', 'Szia', 'Kovács weboldal'])).toBe('')
  })

  it('the aspect button sends the same operation the agent uses', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'vt-aspect', 'data-wb-v': '9:16' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/timeline/ops'))).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/timeline/ops'))!
    expect(JSON.parse(String(call.init!.body))).toEqual({ ops: [{ op: 'setAspect', aspect: '9:16' }] })
  })

  it('moving a clip down sends its new position', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'vt-clip-down', 'data-wb-id': 'c1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/timeline/ops'))).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/timeline/ops'))!
    expect(JSON.parse(String(call.init!.body))).toEqual({ ops: [{ op: 'moveClip', id: 'c1', to: 2 }] })
  })

  it('a text that is not a number is refused in plain words and nothing is sent', async () => {
    const h = await open()
    h.inputs['wbVt-start-c1'] = { value: 'abc', focus() {} } as never
    h.click({ 'data-wb-act': 'vt-clip-trim', 'data-wb-id': 'c1' })
    expect(h.toasts).toContain('⟦workbench.vt.not_a_number⟧')
    expect(h.fetchCalls.some((c) => c.url.includes('/timeline/ops'))).toBe(false)
  })

  it('adding a clip without choosing a file asks for a file', async () => {
    const h = await open()
    h.click({ 'data-wb-act': 'vt-clip-add' })
    expect(h.toasts).toContain('⟦workbench.vt.pick_file⟧')
  })

  it('the file lists come from the project media: videos for clips, audio for music', async () => {
    const h = await open()
    await vi.waitFor(() => expect(h.html()).toContain('Projektek/p1/c.mp4'.split('/').slice(-2).join('/')))
    const html = h.html()
    expect(html).toContain('p1/c.mp4')
    expect(html).toContain('p1/z.mp3')
  })

  it('a server error is shown with its own message, the timeline stays', async () => {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/timeline')) return { status: 409, body: { error: 'timeline_no_folder', message: 'Nincs mappa.', detail: 'x' } }
      if (url.includes('/preview')) return { status: 200, body: { available: false } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: VIDEO, versions: [], parts: [], project: PROJECT } }
      return { status: 200, body: itemsBody([VIDEO]) }
    })
    h.win.MarvinWorkbench.open('p1', PROJECT.name)
    await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('Nincs mappa.'))
  })

  it('the automatic subtitle button sends the language and the replace choice, and says how many clips had no sound', async () => {
    const h = await open()
    expect(h.html()).toContain('data-wb-act="vt-autosub"')
    h.inputs['wbVt-auto-lang'] = { value: 'de', focus() {} } as never
    h.inputs['wbVt-auto-replace'] = { value: 'on', checked: false, focus() {} } as never
    h.click({ 'data-wb-act': 'vt-autosub' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/timeline/autosubtitle'))).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/timeline/autosubtitle'))!
    expect(JSON.parse(String(call.init!.body))).toEqual({ language: 'de', replace: false })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.vt.auto_skipped'))
  })

  it('a failed recognition shows the server sentence and the page stays usable', async () => {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/timeline/autosubtitle')) return { status: 503, body: { error: 'autosub_not_installed', message: 'Nincs telepítve a felismerő.', detail: null } }
      if (url.includes('/timeline')) return { status: 200, body: TL }
      if (url.includes('/api/workbench/media')) return { status: 200, body: { files: [] } }
      if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'timeline' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: VIDEO, versions: [], parts: [], project: PROJECT } }
      return { status: 200, body: itemsBody([VIDEO]) }
    })
    h.win.MarvinWorkbench.open('p1', PROJECT.name)
    await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('vt-autosub'))
    h.click({ 'data-wb-act': 'vt-autosub' })
    await vi.waitFor(() => expect(h.html()).toContain('Nincs telepítve a felismerő.'))
    expect(h.html()).toContain('data-wb-act="vt-autosub"')
  })
})
