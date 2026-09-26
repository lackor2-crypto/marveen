// #406, 1. pont -- OSZTOTT NEZET: bal oldalt a chat, jobb oldalt az ELO
// munkadarab. A felulet tenyleges kimenetet merjuk (web/workbench.js fut).
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody, untranslatedHungarian, PROJECT } from './helpers/workbench-harness.js'

const ITEM = { id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft', current_version_id: 'v1' }

function detailBody(parts: unknown[] = []) {
  return { item: ITEM, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts, project: PROJECT }
}

async function openWith(h: ReturnType<typeof workbenchHarness>, items: unknown[]) {
  h.respond((url) => {
    if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source', message: 'Még üres.' } }
    if (url.includes('/api/workbench/items/w1')) return { status: 200, body: detailBody() }
    return { status: 200, body: itemsBody(items) }
  })
  h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  // A lista BETOLTESET varjuk meg, nem az elso (meg ures) rajzolast.
  await vi.waitFor(() => expect(h.html()).toMatch(items.length ? /wb-items/ : /workbench\.empty\.title/))
}

describe('osztott nezet (#406, 1. pont)', () => {
  it('ALAPBOL osztott: a chat BAL oldalt, a munkadarab JOBB oldalt all', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    const html = h.html()
    const split = html.indexOf('class="wb-split"')
    const chat = html.indexOf('class="wb-split-chat"')
    const work = html.indexOf('class="wb-split-work"')
    expect(split).toBeGreaterThan(-1)
    expect(chat).toBeGreaterThan(split)
    expect(work).toBeGreaterThan(chat)
    // A chat a bal oszlopban van, a szerkeszto a jobb oszlopban.
    expect(html.slice(chat, work)).toContain('id="wbChat"')
    expect(html.slice(work)).toContain('wb-panel-editor')
    // Semmi nem veszett el: a lista es a reszletek is kint vannak.
    expect(html).toContain('wb-panel-items')
    expect(html).toContain('wb-panel-context')
  })

  it('jobb oldalt kivalasztas nelkul is van mit tenni: a munkadarabok egy kattintasra ott vannak', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    const work = h.html().slice(h.html().indexOf('class="wb-split-work"'))
    expect(work).toContain('workbench.split.none')
    expect(work).toContain('data-wb-item="w1"')
    expect(work).toContain('data-wb-act="new"')
  })

  it('FRISS TELEPITES: ures projektben is ertelmes a jobb oldal (uj munkadarab gomb, nem hiba)', async () => {
    const h = workbenchHarness()
    await openWith(h, [])
    const work = h.html().slice(h.html().indexOf('class="wb-split-work"'))
    expect(work).toContain('workbench.split.none')
    expect(work).toContain('data-wb-act="new"')
    expect(h.html()).not.toContain('depo-bad')
  })

  it('kivalasztas utan jobb oldalt a munkadarab elonezete all', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-editor-head'))
    const work = h.html().slice(h.html().indexOf('class="wb-split-work"'))
    expect(work).toContain('Ajánlat')
    expect(work).toContain('wb-preview')
  })

  it('a valto gomb harom panelre valt, es a valasztas megmarad a bongeszoben', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    expect(h.html()).toContain('workbench.layout.to_classic')
    h.click({ 'data-wb-act': 'layout-toggle' })
    expect(h.html()).not.toContain('class="wb-split"')
    expect(h.html()).toContain('class="wb-grid wb-grid-chatfirst"')
    // Boss, 2026-09-26 (TG 6552): harom panelben BAL oldalt a chat, kozepen a
    // munka, jobbra a kontextus; a munkadarab-lista alul.
    const html = h.html()
    const chat = html.indexOf('class="wb-grid-chat"')
    const editor = html.indexOf('wb-panel-editor')
    const ctx = html.indexOf('wb-panel-context')
    const below = html.indexOf('class="wb-grid-below"')
    expect(chat).toBeGreaterThan(-1)
    expect(editor).toBeGreaterThan(chat)
    expect(ctx).toBeGreaterThan(editor)
    expect(below).toBeGreaterThan(ctx)
    expect(html.slice(below)).toContain('wb-panel-items')
    expect(html.slice(chat, editor)).toContain('id="wbChat"')
    expect(h.html()).toContain('workbench.layout.to_split')
    expect(h.storage['marveen.workbench.layout']).toBe('classic')

    // Egy uj oldalbetoltes (uj peldany) a mentett valasztassal indul.
    const h2 = workbenchHarness({ storage: { 'marveen.workbench.layout': 'classic' } })
    await openWith(h2, [ITEM])
    expect(h2.html()).not.toContain('class="wb-split"')
  })

  it('ELO: ha az agens munkadarab-eszkoze SIKERESEN lefut, a jobb oldal a valasz vege ELOTT frissul', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-editor-head'))
    const previews = () => h.fetchCalls.filter((c) => c.url.includes('/preview')).length
    const before = previews()

    let finish: (v?: unknown) => void = () => {}
    const hold = new Promise((r) => { finish = r })
    h.respond((url) => {
      if (url.includes('/agent/message')) {
        return { status: 200, body: null, stream: { chunks: ['data: {"type":"tool","name":"workItem.addPart","status":"ok"}\n\n'], hold } }
      }
      if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'parts' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: detailBody([{ id: 'x', kind: 'text', text: 'Friss sor', position: 1 }]) }
      return { status: 200, body: itemsBody([ITEM]) }
    })
    h.inputs.wbChatInput = { value: 'írj bele egy sort', focus() {} }
    h.click({ 'data-wb-act': 'chat-send' })

    // A folyam MEG NYITVA (a `hold` nem teljesult), megis frissul a jobb oldal.
    await vi.waitFor(() => expect(previews()).toBeGreaterThan(before), { timeout: 3000 })
    await vi.waitFor(() => expect(h.html()).toContain('Friss sor'))
    expect(h.win.MarvinWorkbench.isOpen()).toBe(true)
    finish()
  })

  it('SIKERTELEN vagy nem munkadarab-eszkoz NEM kavarja fel a jobb oldalt', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-editor-head'))
    let finish: (v?: unknown) => void = () => {}
    const hold = new Promise((r) => { finish = r })
    h.respond((url) => {
      if (url.includes('/agent/message')) {
        return { status: 200, body: null, stream: { chunks: [
          'data: {"type":"tool","name":"workItem.addPart","status":"error"}\n\n',
          'data: {"type":"tool","name":"project.get","status":"ok"}\n\n',
        ], hold } }
      }
      return { status: 200, body: detailBody() }
    })
    const before = h.fetchCalls.length
    h.inputs.wbChatInput = { value: 'mi a projekt neve?', focus() {} }
    h.click({ 'data-wb-act': 'chat-send' })
    await new Promise((r) => setTimeout(r, 700))
    const after = h.fetchCalls.slice(before).map((c) => c.url)
    expect(after.some((u) => u.includes('/preview'))).toBe(false)
    finish()
  })
})

describe('ketnyelvuseg (#406, 1. pont)', () => {
  it('az osztott nezet minden sajat szovege a t()-n megy at', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat'])).toBe('')
  })
})
