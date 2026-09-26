// #406 (Boss TG 6642/6653) -- KOZOSSEGI POSZT ELONEZET: a vegyes munkadarab
// ugy latszik, mint a valodi poszt (nev, szoveg a "Tovabbiak" levagassal, kep a
// platform aranyaban, reakcio-sor), platform- es nezet-valasztoval. A felulet
// tenyleges kimenetet merjuk (web/workbench.js fut).
import { describe, it, expect, vi } from 'vitest'
import { workbenchHarness, itemsBody, untranslatedHungarian, PROJECT } from './helpers/workbench-harness.js'

const COMPOSITE = { id: 'w1', title: 'Poszt', type: 'composite', status: 'draft', current_version_id: 'v1' }
const NOTE = { ...COMPOSITE, type: 'note' }
const TEXT = { id: 'pt1', kind: 'text', text: 'Nyitottunk!\nGyere el hozzank.', position: 0 }
const IMAGE = { id: 'pi1', kind: 'image', asset_path: 'Projektek/p1/kep.jpg', caption: '', position: 1 }

async function openItem(item: Record<string, unknown>, parts: unknown[]) {
  const h = workbenchHarness()
  h.respond((url) => {
    if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'parts' } }
    if (url.includes('/api/workbench/items/w1')) {
      return { status: 200, body: { item, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts, project: PROJECT } }
    }
    return { status: 200, body: itemsBody([item]) }
  })
  h.win.MarvinWorkbench.open('p1', PROJECT.name)
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.html()).toContain('wb-editor-head'))
  return h
}

describe('kozossegi poszt elonezet (#406)', () => {
  it('vegyes munkadarabon ott a gomb, de alapbol csukva (a meglevo nezet nem valtozik)', async () => {
    const h = await openItem(COMPOSITE, [TEXT, IMAGE])
    const html = h.html()
    expect(html).toContain('data-wb-act="post-toggle"')
    expect(html).toContain('workbench.post.intro')
    expect(html).not.toContain('wb-post-card')
  })

  it('nem vegyes munkadarabon nincs poszt-elonezet', async () => {
    const h = await openItem(NOTE, [TEXT])
    expect(h.html()).not.toContain('post-toggle')
  })

  it('kinyitva: nev a projektbol, szoveg levagva, kep 4:5 aranyban, reakcio-sor', async () => {
    const h = await openItem(COMPOSITE, [TEXT, IMAGE])
    h.click({ 'data-wb-act': 'post-toggle' })
    const html = h.html()
    expect(html).toContain('wb-post-card')
    expect(html).toContain('Kovács weboldal')
    expect(html).toContain('>K<') // semleges kor a kezdobetuvel, nem logo
    expect(html).toContain('Nyitottunk!')
    expect(html).toContain('wb-post-clamp')
    expect(html).toContain('--wb-post-lines:3')
    expect(html).toContain('aspect-ratio:1080 / 1350')
    expect(html).toContain('/api/life/file?rel=' + encodeURIComponent(IMAGE.asset_path))
    expect(html).toContain('wb-post-reactions')
    // mind a 11 platform valaszthato
    expect((html.match(/workbench\.post\.pf\./g) || []).length).toBe(11)
    expect(untranslatedHungarian(html, ['Kovács weboldal', 'Nyitottunk!', 'Gyere el hozzank.', 'Poszt'])).toBe('')
  })

  it('platform-valtas: az Instagram story 9:16, biztonsagi savokkal', async () => {
    const h = await openItem(COMPOSITE, [TEXT, IMAGE])
    h.click({ 'data-wb-act': 'post-toggle' })
    h.change('wbPostPlatform', [], 'ig_story')
    const html = h.html()
    expect(html).toContain('aspect-ratio:1080 / 1920')
    expect(html).toContain('wb-post-safe-top')
    expect(html).toContain('workbench.post.story_hint')
  })

  it('ismeretlen platform-ertek nem torik el: az alapertelmezett marad', async () => {
    const h = await openItem(COMPOSITE, [TEXT, IMAGE])
    h.click({ 'data-wb-act': 'post-toggle' })
    h.change('wbPostPlatform', [], '<script>')
    expect(h.html()).toContain('aspect-ratio:1080 / 1350')
  })

  it('asztali nezet es "Tovabbiak": tobb sor, majd a teljes szoveg', async () => {
    const h = await openItem(COMPOSITE, [TEXT, IMAGE])
    h.click({ 'data-wb-act': 'post-toggle' })
    h.click({ 'data-wb-act': 'post-view', 'data-wb-view': 'desktop' })
    expect(h.html()).toContain('--wb-post-lines:5')
    expect(h.html()).toContain('wb-post-desktop')
    h.click({ 'data-wb-act': 'post-more' })
    expect(h.html()).not.toContain('wb-post-clamp')
    expect(h.html()).toContain('workbench.post.less')
  })

  it('friss, ures munkadarab: emberi mondat a kep es a szoveg helyen, nem hiba', async () => {
    const h = await openItem(COMPOSITE, [])
    h.click({ 'data-wb-act': 'post-toggle' })
    const html = h.html()
    expect(html).toContain('workbench.post.no_image')
    expect(html).toContain('workbench.post.no_text')
  })

  it('letoltes: JPG/PNG/PDF gomb a platform meretevel; kep nelkul a kep-gombok tiltva, emberi mondattal', async () => {
    const h = await openItem(COMPOSITE, [TEXT, IMAGE])
    h.click({ 'data-wb-act': 'post-toggle' })
    let html = h.html()
    expect(html).toContain('data-wb-act="post-dl" data-wb-fmt="jpg"')
    expect(html).toContain('data-wb-fmt="png"')
    expect(html).toContain('data-wb-act="post-pdf"')
    expect(html).toContain('workbench.post.dl_hint')
    expect(html).not.toMatch(/data-wb-fmt="jpg" disabled/)
    const e = await openItem(COMPOSITE, [TEXT])
    e.click({ 'data-wb-act': 'post-toggle' })
    html = e.html()
    expect(html).toMatch(/data-wb-fmt="jpg" disabled/)
    expect(html).toContain('workbench.post.dl_no_image')
    expect(html).not.toMatch(/data-wb-act="post-pdf" disabled/)
  })

  it('kivagas: ugyanaz, mint az elonezet object-fit:cover + huzott pozicio', async () => {
    const h = workbenchHarness()
    const crop = h.win.MarvinWorkbench._post.crop
    // 4000x3000 fekvo kep -> 1080x1350 allo: a teljes magassag, kozepen
    const c = crop(4000, 3000, 1080, 1350, 50, 50)
    expect(c.sh).toBeCloseTo(3000)
    expect(c.sw).toBeCloseTo(2400)
    expect(c.sx).toBeCloseTo(800)
    expect(c.sy).toBeCloseTo(0)
    // bal szelre huzva
    expect(crop(4000, 3000, 1080, 1350, 0, 50).sx).toBeCloseTo(0)
    expect(crop(4000, 3000, 1080, 1350, 100, 50).sx).toBeCloseTo(1600)
    // a kimenet aranya mindig a platform arany
    const s = crop(1000, 2000, 1200, 630, 50, 30)
    expect(s.sw / s.sh).toBeCloseTo(1200 / 630)
    expect(crop(0, 0, 1080, 1080, 50, 50)).toBeNull()
    expect(h.win.MarvinWorkbench._post.maxBytes).toBe(5 * 1024 * 1024)
  })
})
