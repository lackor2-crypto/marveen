// #462 -- the Workbench has two looks: Manual (the technical screen as it
// was) and Simple (the planned one-question screen). The switch is per
// browser, defaults to Manual, and nothing is lost in either state.
// Real output of web/workbench.js is measured (no source-text grepping).
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody, untranslatedHungarian, PROJECT } from './helpers/workbench-harness.js'

const ITEM = { id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft', current_version_id: 'v1' }
const DOC = { id: 'd1', title: 'Beadvány', type: 'document', status: 'draft', current_version_id: 'v1' }
const KEY = 'marveen.workbench.view'

function detailBody(item: Record<string, unknown>) {
  return { item, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project: PROJECT }
}

async function openWith(h: ReturnType<typeof workbenchHarness>, items: Record<string, unknown>[]) {
  h.respond((url) => {
    if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source', message: 'Még üres.' } }
    const hit = items.find((i) => url.includes('/api/workbench/items/' + i.id))
    if (hit) return { status: 200, body: detailBody(hit) }
    return { status: 200, body: itemsBody(items) }
  })
  h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  // Egyszerű nézetben a lista a ⋮ mögött van: a betöltést a hálózati hívások lecsengése jelzi.
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-root-simple|wb-items|workbench\.empty\.title/))
  await new Promise((r) => setTimeout(r, 30))
}

describe('Munkapad kinézet-kapcsoló (#462)', () => {
  it('ALAPBÓL manuális: a mostani felület változatlan, a kapcsoló látszik', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    const html = h.html()
    expect(html).not.toContain('wb-root-simple')
    expect(html).toContain('wb-split-chat')
    expect(html).toContain('data-wb-act="search-open"')
    expect(html).toContain('data-wb-act="view-set" data-wb-view="manual"')
    expect(html).toContain('data-wb-act="view-set" data-wb-view="simple"')
    expect(html).toContain('wb-view-on" data-wb-act="view-set" data-wb-view="manual"')
  })

  it('átkapcsolás egyszerűre: a választás a böngészőben marad, és vissza is lehet', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    h.click({ 'data-wb-act': 'view-set', 'data-wb-view': 'simple' })
    expect(h.storage[KEY]).toBe('simple')
    expect(h.html()).toContain('wb-root-simple')
    h.click({ 'data-wb-act': 'view-set', 'data-wb-view': 'manual' })
    expect(h.storage[KEY]).toBe('manual')
    expect(h.html()).not.toContain('wb-root-simple')
    expect(h.html()).toContain('data-wb-act="search-open"')
  })

  it('a mentett egyszerű állás újranyitáskor is él', async () => {
    const h = workbenchHarness({ storage: { [KEY]: 'simple' } })
    await openWith(h, [ITEM])
    expect(h.html()).toContain('wb-root-simple')
  })

  it('egyszerű nézet, nincs kijelölt munka: EGY kérdés + az 5 gomb, technikai elem nélkül', async () => {
    const h = workbenchHarness({ storage: { [KEY]: 'simple' } })
    await openWith(h, [ITEM])
    const html = h.html()
    expect(html).toContain('workbench.sh.ask')
    for (const k of ['social_post', 'document', 'court_filing', 'video', 'presentation']) {
      expect(html).toContain('data-wb-kind="' + k + '"')
    }
    // a 10 felső gomb, a csempék és a mappa-lépés a ⋮ mögött van
    for (const a of ['search-open', 'wk-open', 'tl-open', 'dec-open', 'brand-open', 'td-open', 'ho-open', 'caps-open']) {
      expect(html).not.toContain('data-wb-act="' + a + '"')
    }
    expect(html).not.toContain('wb-panel-items')
    expect(html).toContain('data-wb-act="sh-more"')
  })

  it('⋮ megnyitja a Technikai részleteket: semmi nem veszett el', async () => {
    const h = workbenchHarness({ storage: { [KEY]: 'simple' } })
    await openWith(h, [ITEM])
    h.click({ 'data-wb-act': 'sh-more' })
    const html = h.html()
    expect(html).toContain('wbShTech')
    for (const a of ['search-open', 'wk-open', 'tl-open', 'dec-open', 'brand-open', 'td-open', 'ho-open', 'caps-open']) {
      expect(html).toContain('data-wb-act="' + a + '"')
    }
    expect(html).toContain('wb-panel-items')
    expect(html).toContain('wb-panel-context')
    h.click({ 'data-wb-act': 'sh-more' })
    expect(h.html()).not.toContain('wbShTech')
  })

  it('egyszerű nézet, kijelölt munka: felül sáv, balra ikonsáv + panel, középen a lap, jobbra a chat, alul nagyítás, Mentve jelzés', async () => {
    const h = workbenchHarness({ storage: { [KEY]: 'simple' } })
    await openWith(h, [ITEM])
    h.click({ 'data-wb-act': 'view-set', 'data-wb-view': 'simple' })
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-fr-center'))
    const html = h.html()
    // Canva-minta (#462, 2. lépés): felső sáv, bal ikonsáv + panel, közép, jobb chat.
    const top = html.indexOf('wb-fr-top')
    const rail = html.indexOf('wb-fr-rail')
    const center = html.indexOf('wb-fr-center')
    const chat = html.indexOf('wb-fr-chat')
    expect(top).toBeGreaterThan(-1)
    expect(rail).toBeGreaterThan(top)
    expect(center).toBeGreaterThan(rail)
    expect(chat).toBeGreaterThan(center)
    expect(html.slice(chat)).toContain('id="wbChat"')
    for (const tab of ['templates', 'elements', 'text', 'brand', 'uploads', 'tools', 'projects']) expect(html).toContain('data-wb-tab="' + tab + '"')
    expect(html).toContain('id="wbFrZoom"')
    expect(html).toContain('workbench.sh.saved.saved')
    expect(html).toContain('data-wb-act="export-open"')
    // nincs Agent/Manuális kapcsoló a munkadarabon belül, és a chat csak egyszer van
    expect(html.split('id="wbChat"').length).toBe(2)
  })

  it('a chat panel a fejlécből elrejthető, és a menü / fül kattintásra nyílik', async () => {
    const h = workbenchHarness({ storage: { [KEY]: 'simple' } })
    await openWith(h, [ITEM])
    h.click({ 'data-wb-act': 'view-set', 'data-wb-view': 'simple' })
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-fr-center'))
    h.click({ 'data-wb-act': 'fr-chat' })
    expect(h.html()).not.toContain('class="wb-fr-chat"')
    h.click({ 'data-wb-act': 'fr-menu', 'data-wb-m': 'file' })
    expect(h.html()).toContain('wb-fr-menu')
    h.click({ 'data-wb-act': 'fr-tab', 'data-wb-tab': 'tools' })
    expect(h.html()).toContain('workbench.fr.tab.tools')
  })

  it('dokumentum: Vázlat | Előnézet | Források | Hiányok fülek + Piszkozat PDF + Véglegesítés', async () => {
    const h = workbenchHarness({ storage: { [KEY]: 'simple' } })
    await openWith(h, [DOC])
    h.click({ 'data-wb-item': 'd1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-sh-doc-tabs'))
    const html = h.html()
    for (const tab of ['draft', 'preview', 'sources', 'gaps']) expect(html).toContain('data-wb-tab="' + tab + '"')
    h.click({ 'data-wb-act': 'sh-doc-tab', 'data-wb-tab': 'gaps' })
    expect(h.html()).toContain('workbench.sh.doc.gaps_none')
  })

  it('az egyszerű nézet minden szövege lefordított (nincs beégetett magyar)', async () => {
    const h = workbenchHarness({ storage: { [KEY]: 'simple' } })
    await openWith(h, [ITEM])
    expect(untranslatedHungarian(h.html(), ['Ajánlat', 'Kovács'])).toEqual('')
  })

  it('a Beállítások oldal kártyájának belépési pontja létezik', async () => {
    const h = workbenchHarness()
    await openWith(h, [ITEM])
    expect(typeof h.win.MarvinWorkbench.viewSettingCard).toBe('function')
  })

  it('a lap kitölti a vásznat: a stage nem zsugorodhat a lapnál keskenyebbre (levágta a dobozokat)', async () => {
    const { readFileSync } = await import('node:fs')
    const css = readFileSync(new URL('../../web/workbench.css', import.meta.url), 'utf8')
    const rule = css.match(/\.wb-fr-page \.wb-can-stage\s*\{([^}]*)\}/)
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/display:\s*block/)
    expect(rule![1]).toMatch(/width:\s*100%/)
  })
})
