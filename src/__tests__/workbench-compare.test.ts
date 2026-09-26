// #406, 5. pont -- VERZIOK EGYMAS MELLETT (kepnel csuszka) + EGYGOMBOS
// VISSZAVONAS: a szerver (egy verzio reszei) es a felulet.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, addWorkItemPart, createWorkItemVersion, updateWorkItemPart, listWorkItemParts } from '../workbench.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

describe('GET .../versions/:vid/parts', () => {
  let itemId = ''
  let v1 = ''
  let v2 = ''
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Kovács weboldal' })
    if (!p.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: p.project.id, title: 'Poszt', type: 'composite' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    v1 = w.version.id
    addWorkItemPart({ work_item_id: itemId, kind: 'text', text: 'régi szöveg' })
    const nv = createWorkItemVersion(itemId, {})
    if (!nv.ok) throw new Error('verzio')
    v2 = nv.version.id
    const live = listWorkItemParts(itemId)
    updateWorkItemPart(live[0].id, { text: 'új szöveg' }, itemId)
  })

  it('a regi verzio a SAJAT pillanatkepet adja, a mostani az elo reszeket', async () => {
    const old = await callWorkbench(`/api/workbench/items/${itemId}/versions/${v1}/parts`, 'GET')
    expect(old.status).toBe(200)
    expect(old.body.parts.map((p: any) => p.text)).toEqual(['régi szöveg'])
    const cur = await callWorkbench(`/api/workbench/items/${itemId}/versions/${v2}/parts`, 'GET')
    expect(cur.body.parts.map((p: any) => p.text)).toEqual(['új szöveg'])
  })

  it('ismeretlen verzio 404, MASIK munkadarab verzioja 409 -- nem ures lista', async () => {
    expect((await callWorkbench(`/api/workbench/items/${itemId}/versions/nincs/parts`, 'GET')).status).toBe(404)
    const p = createProject({ name: 'Másik' })
    if (!p.ok) throw new Error('p')
    const other = createWorkItem({ project_id: p.project.id, title: 'Idegen', type: 'note' })
    if (!other.ok) throw new Error('o')
    const r = await callWorkbench(`/api/workbench/items/${itemId}/versions/${other.version.id}/parts?lang=en`, 'GET')
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('version_mismatch')
  })
})

describe('a felulet', () => {
  const ITEM = { id: 'w1', title: 'Poszt', type: 'composite', status: 'draft', current_version_id: 'v3' }
  const VERSIONS = [
    { id: 'v3', version_no: 3, created_at: 3 },
    { id: 'v2', version_no: 2, created_at: 2 },
    { id: 'v1', version_no: 1, created_at: 1 },
  ]

  function setup(opts: { versions?: unknown[]; previews?: Record<string, unknown>; parts?: Record<string, unknown[]>; archived?: boolean } = {}) {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Kovács weboldal', archived: !!opts.archived }
    const versions = opts.versions || VERSIONS
    h.respond((url, init) => {
      if (url.includes('/restore') && init?.method === 'POST') {
        return { status: 201, body: { ok: true, item: { ...ITEM, current_version_id: 'v4' }, version: { id: 'v4', version_no: 4 }, versions: [{ id: 'v4', version_no: 4, created_at: 4 }, ...versions] } }
      }
      const pm = url.match(/\/versions\/(v\d)\/parts/)
      if (pm) return { status: 200, body: { parts: (opts.parts || {})[pm[1]] || [] } }
      const vm = url.match(/\/preview\?version=(v\d)/)
      if (vm) return { status: 200, body: (opts.previews || {})[vm[1]] || { available: true, kind: 'parts' } }
      if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'parts' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: ITEM, versions, parts: [], project } }
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    return h
  }

  async function select(h: ReturnType<typeof workbenchHarness>) {
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-editor-head'))
  }

  it('EGY KATTINTAS visszavonas: a mostani elotti verziot allitja vissza, kerdes nelkul', async () => {
    const h = setup()
    await select(h)
    expect(h.html()).toContain('data-wb-act="version-undo"')
    expect(h.html()).toContain('workbench.cmp.undo:{"n":2}')
    let asked = false
    h.win.confirm = () => { asked = true; return true }
    h.click({ 'data-wb-act': 'version-undo' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.cmp.undone'))
    expect(asked).toBe(false)
    const post = h.fetchCalls.find((c) => c.url.includes('/restore'))!
    expect(post.url).toContain('/versions/v2/restore')
    expect(h.toasts.join(' ')).toContain('"from":3')
    expect(h.toasts.join(' ')).toContain('"n":4')
  })

  it('egyetlen verzional nincs visszavonas es osszehasonlitas (nincs mire)', async () => {
    const h = setup({ versions: [{ id: 'v3', version_no: 3, created_at: 3 }] })
    await select(h)
    expect(h.html()).not.toContain('data-wb-act="version-undo"')
    expect(h.html()).not.toContain('data-wb-act="compare-open"')
  })

  it('archivalt projektben nincs visszavonas, de osszehasonlitani lehet (az olvasas)', async () => {
    const h = setup({ archived: true })
    await select(h)
    expect(h.html()).not.toContain('data-wb-act="version-undo"')
    expect(h.html()).toContain('data-wb-act="compare-open"')
  })

  it('SZOVEG egymas mellett: elotte = az elozo, utana = a mostani; a torolt es az uj szo kiemelve', async () => {
    const h = setup({ parts: { v2: [{ id: 'a', kind: 'text', text: 'Nyári akció minden termékre' }], v3: [{ id: 'b', kind: 'text', text: 'Őszi akció minden termékre' }] } })
    await select(h)
    h.click({ 'data-wb-act': 'compare-open' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-cmp-cols'))
    const html = h.html()
    expect(html).toMatch(/id="wbCmpLeft"[^]*?<option value="v2" selected>/)
    expect(html).toMatch(/id="wbCmpRight"[^]*?<option value="v3" selected>/)
    expect(html).toContain('<del class="wb-cmp-del">Nyári</del>')
    expect(html).toContain('<ins class="wb-cmp-ins">Őszi</ins>')
    expect(html).not.toContain('<del class="wb-cmp-del">akció</del>')
    // A kivalasztott "elotte" verzio vissza is allithato innen.
    expect(html).toContain('data-wb-act="version-restore" data-wb-version="v2"')
  })

  it('KEP: csuszka; huzasra csak a vagas valtozik, a kep NEM rajzolodik ujra', async () => {
    const img = (n: string) => ({ available: true, kind: 'image', url: `/api/life/file?rel=P%2F${n}.png`, name: n + '.png' })
    const h = setup({ previews: { v2: img('regi'), v3: img('uj') } })
    await select(h)
    h.click({ 'data-wb-act': 'compare-open' })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbCmpSlider"'))
    const html = h.html()
    // Alul az UJ, folotte a REGI, felig kivagva.
    expect(html.indexOf('uj.png')).toBeLessThan(html.indexOf('regi.png'))
    expect(html).toContain('clip-path: inset(0 50% 0 0)')
    const top = { style: {} as Record<string, string> }
    const line = { style: {} as Record<string, string> }
    h.inputs.wbCmpTop = top as any
    h.inputs.wbCmpLine = line as any
    const renders = h.renders.length
    h.fire('input', { target: { id: 'wbCmpSlider', value: '80' } })
    expect(top.style.clipPath).toBe('inset(0 20% 0 0)')
    expect(line.style.left).toBe('80%')
    expect(h.renders.length).toBe(renders)
  })

  it('a verzio-valasztoval mas verziot lehet mellé tenni, es az betoltodik', async () => {
    const h = setup()
    await select(h)
    h.click({ 'data-wb-act': 'compare-open' })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbCmpLeft"'))
    h.change('wbCmpLeft', [], 'v1')
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/versions/v1/parts'))).toBe(true))
    expect(h.fetchCalls.some((c) => c.url.includes('/preview?version=v1'))).toBe(true)
  })

  it('ha egy verzio nem toltheto be, azt KIMONDJA a szerver mondataval', async () => {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/versions/v2/parts')) return { status: 404, body: { error: 'version_not_found', message: 'Ez a verzió nincs meg.' } }
      if (url.includes('/versions/')) return { status: 200, body: { parts: [] } }
      if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'parts' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: ITEM, versions: VERSIONS, parts: [] } }
      return { status: 200, body: itemsBody([ITEM]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    await select(h)
    h.click({ 'data-wb-act': 'compare-open' })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.cmp.error'))
    expect(h.html()).toContain('Ez a verzió nincs meg.')
  })

  it('minden sajat szoveg a t()-n megy at', async () => {
    const h = setup({ parts: { v2: [{ id: 'a', kind: 'text', text: 'egy' }], v3: [{ id: 'b', kind: 'text', text: 'kettő' }] } })
    await select(h)
    h.click({ 'data-wb-act': 'compare-open' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-cmp-cols'))
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'kettő'])).toBe('')
  })
})
