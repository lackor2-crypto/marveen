// #406, 3. pont -- BEHUZAS ES FELTOLTES (telefonrol is): a szerver-oldal
// (fajlbol uj munkadarab) es a felulet (huzas, gomb, beillesztes).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, setProjectArchived } from '../projects.js'
import { listWorkItems } from '../workbench.js'
import { workItemTypeForFile, titleFromFileName } from '../workbench-upload.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

describe('fajl -> munkadarab-fajta es nev', () => {
  it('a fajtat a fajl NEVE donti el, a bongeszo tipusa csak tartalek', () => {
    expect(workItemTypeForFile('foto.JPG')).toBe('image')
    expect(workItemTypeForFile('klip.mp4')).toBe('video')
    expect(workItemTypeForFile('logo.svg')).toBe('graphic')
    expect(workItemTypeForFile('jegyzet.md')).toBe('note')
    expect(workItemTypeForFile('ajanlat.docx')).toBe('document')
    expect(workItemTypeForFile('szerzodes.pdf')).toBe('document')
    // Telefon: ismeretlen kiterjesztes, de a bongeszo szerint kep.
    expect(workItemTypeForFile('IMG_0001', 'image/heic')).toBe('image')
    expect(workItemTypeForFile('valami.xyz')).toBe('document')
  })

  it('a nev a fajlnevbol, kiterjesztes nelkul', () => {
    expect(titleFromFileName('ajanlat_kovacs v2.docx')).toBe('ajanlat kovacs v2')
    expect(titleFromFileName('C:\\\\Users\\\\x\\\\foto.jpg')).toBe('foto')
    expect(titleFromFileName('.env')).toBe('.env')
  })
})

describe('POST /api/workbench/items/upload', () => {
  let depot = ''
  let pid = ''

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-up-'))
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    const p = createProject({ name: 'Kovács weboldal' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function useDepot() {
    process.env['MARVEEN_DEPOT'] = depot
    const up = updateProject(pid, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('projektmappa: ' + up.code)
  }

  it('a fajl a projekt mappajaba kerul, es uj munkadarab lesz belole, aminek ez a forrasa', async () => {
    useDepot()
    const r = await callWorkbench(`/api/workbench/items/upload?project=${pid}&name=${encodeURIComponent('nyári fotó.jpg')}&type=image/jpeg`, 'POST', Buffer.from('JPEGBYTES'))
    expect(r.status).toBe(201)
    expect(r.body.item.type).toBe('image')
    expect(r.body.item.title).toBe('nyári fotó')
    expect(r.body.item.source_path).toBe('Projektek/teszt/nyári fotó.jpg')
    expect(r.body.versions[0].source_path).toBe('Projektek/teszt/nyári fotó.jpg')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'nyári fotó.jpg'), 'utf-8')).toBe('JPEGBYTES')
    expect(listWorkItems(pid)).toHaveLength(1)
  })

  it('SOSE ir felul: foglalt nevnel uj nevet kap, es ezt ki is mondja', async () => {
    useDepot()
    writeFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat.docx'), 'EREDETI')
    const r = await callWorkbench(`/api/workbench/items/upload?project=${pid}&name=ajanlat.docx`, 'POST', Buffer.from('UJ'))
    expect(r.status).toBe(201)
    expect(r.body.renamed).toBe(true)
    expect(r.body.name).not.toBe('ajanlat.docx')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat.docx'), 'utf-8')).toBe('EREDETI')
    expect(readdirSync(join(depot, 'Projektek', 'teszt'))).toHaveLength(2)
  })

  it('FRISS TELEPITES (nincs Raktar / nincs projektmappa): emberi mondat a teendovel, nem gepi kod', async () => {
    delete process.env['MARVEEN_DEPOT']
    const r = await callWorkbench(`/api/workbench/items/upload?project=${pid}&name=a.pdf`, 'POST', Buffer.from('%PDF'))
    expect(r.status).toBe(400)
    expect(['upload_no_depot', 'upload_no_folder']).toContain(r.body.error)
    expect(r.body.message).toMatch(/Raktár|mapp/)
    expect(listWorkItems(pid)).toHaveLength(0)
  })

  it('ures fajl, ismeretlen projekt, archivalt projekt: kulon-kulon ertheto valasz', async () => {
    useDepot()
    const empty = await callWorkbench(`/api/workbench/items/upload?project=${pid}&name=a.pdf`, 'POST', Buffer.alloc(0))
    expect(empty.status).toBe(400)
    expect(empty.body.error).toBe('upload_empty')
    expect((await callWorkbench('/api/workbench/items/upload?project=nincs&name=a.pdf', 'POST', Buffer.from('x'))).status).toBe(404)
    setProjectArchived(pid, true)
    const arch = await callWorkbench(`/api/workbench/items/upload?project=${pid}&name=a.pdf`, 'POST', Buffer.from('x'))
    expect(arch.status).toBe(409)
    expect(arch.body.error).toBe('project_archived')
  })

  it('tul nagy fajl: a bejelentett meretbol mar a beolvasas elott elutasit', async () => {
    useDepot()
    const r = await callWorkbench(`/api/workbench/items/upload?project=${pid}&name=a.mp4`, 'POST', Buffer.from('x'), { 'content-length': String(500 * 1024 * 1024) })
    expect(r.status).toBe(413)
    expect(r.body.error).toBe('upload_too_large')
    expect(r.body.message).toMatch(/MB/)
  })
})

describe('a felulet: huzas, gomb, beillesztes', () => {
  const ITEM = { id: 'w1', title: 'Poszt', type: 'composite', status: 'draft', current_version_id: 'v1' }

  function setup(opts: { archived?: boolean } = {}) {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Kovács weboldal', archived: !!opts.archived }
    h.respond((url, init) => {
      if (url.includes('/api/workbench/items/upload')) {
        const name = decodeURIComponent((url.match(/name=([^&]*)/) || [])[1] || '')
        if (name === 'rossz.bin') return { status: 400, body: { error: 'upload_no_folder', message: 'Ehhez a projekthez nincs mappa.' } }
        return { status: 201, body: { ok: true, item: { id: 'n-' + name, title: name, type: 'image', status: 'draft' }, versions: [] } }
      }
      if (url.includes('/parts/image') || url.includes('/document')) return { status: 201, body: { ok: true, parts: [], item: ITEM, versions: [] } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [] } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      void init
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    return h
  }

  const file = (name: string, type = '') => ({ name, type, size: 3 })
  const posts = (h: ReturnType<typeof workbenchHarness>) => h.fetchCalls.filter((c) => c.init && c.init.method === 'POST').map((c) => c.url)
  const inside = { closest: (sel: string) => (sel === '.wb-root' ? {} : null) }

  it('a lista alatt ott a feltolto: huzd ide + "Fajlok kivalasztasa" gomb (telefonon ez a fo ut), tobb fajlra', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    expect(h.html()).toContain('workbench.upload.drop_new')
    expect(h.html()).toMatch(/<input type="file" id="wbUploadNew"[^>]*multiple/)
    expect(h.html()).toContain('data-wb-drop="new"')
  })

  it('a gombbal valasztott fajlokbol EGYMAS UTAN uj munkadarab lesz, a hiba a SZERVER mondataval jon', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.change('wbUploadNew', [file('a.jpg', 'image/jpeg'), file('rossz.bin'), file('c.pdf', 'application/pdf')])
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.upload.done_new'))
    const up = posts(h).filter((u) => u.includes('/items/upload'))
    expect(up).toHaveLength(3)
    expect(up[0]).toContain('project=p1')
    expect(up[0]).toContain('name=a.jpg')
    expect(up[0]).toContain('lang=hu')
    expect(h.toasts.join(' ')).toContain('rossz.bin: Ehhez a projekthez nincs mappa.')
    expect(h.toasts.join(' ')).toContain('"n":2')
  })

  it('EGY fajl feltoltese utan az uj munkadarab nyilik meg', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.change('wbUploadNew', [file('logo.png', 'image/png')])
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/items/n-logo.png'))).toBe(true))
  })

  it('HUZAS a listara: uj munkadarab; a megnyitott munkadarabra: kep -> resz, mas -> uj verzio', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    // Huzas kozben a bongeszo alapviselkedeset (fajl megnyitasa) meg kell akadalyozni.
    let prevented = false
    h.fire('dragover', { target: inside, dataTransfer: { types: ['Files'] }, preventDefault() { prevented = true } })
    expect(prevented).toBe(true)

    const onList = { closest: (sel: string) => (sel === '.wb-root' ? {} : sel === '[data-wb-drop]' ? { getAttribute: () => 'new' } : null) }
    h.fire('drop', { target: onList, dataTransfer: { types: ['Files'], files: [file('uj.pdf')] }, preventDefault() {} })
    await vi.waitFor(() => expect(posts(h).some((u) => u.includes('/items/upload') && u.includes('name=uj.pdf'))).toBe(true))

    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-drop="item"'))
    expect(h.html()).toContain('workbench.upload.drop_item')
    const onItem = { closest: (sel: string) => (sel === '.wb-root' ? {} : sel === '[data-wb-drop]' ? { getAttribute: () => 'item' } : null) }
    h.fire('drop', { target: onItem, dataTransfer: { types: ['Files'], files: [file('kep.png', 'image/png'), file('szerzodes.docx')] }, preventDefault() {} })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.upload.done_item'))
    const p = posts(h)
    expect(p.some((u) => u.includes('/items/w1/parts/image') && u.includes('name=kep.png'))).toBe(true)
    expect(p.some((u) => u.includes('/items/w1/document') && u.includes('name=szerzodes.docx'))).toBe(true)
  })

  it('a Munkapadon KIVULI huzasba nem szol bele (a bongeszo tobbi oldala zavartalan)', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    let prevented = false
    h.fire('dragover', { target: { closest: () => null }, dataTransfer: { types: ['Files'] }, preventDefault() { prevented = true } })
    expect(prevented).toBe(false)
  })

  it('BEILLESZTES (Ctrl+V): a vagolapon levo kep feltoltodik; sima szoveg-beillesztesbe nem szol bele', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    let prevented = false
    h.fire('paste', { clipboardData: { files: [] }, preventDefault() { prevented = true } })
    expect(prevented).toBe(false)
    h.fire('paste', { clipboardData: { files: [file('image.png', 'image/png')] }, preventDefault() { prevented = true } })
    expect(prevented).toBe(true)
    await vi.waitFor(() => expect(posts(h).some((u) => u.includes('/items/upload') && u.includes('name=image.png'))).toBe(true))
  })

  it('ARCHIVALT projekt: nincs feltolto, es a behuzas sem tolt fel semmit', async () => {
    const h = setup({ archived: true })
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    expect(h.html()).not.toContain('id="wbUploadNew"')
    h.fire('drop', { target: inside, dataTransfer: { types: ['Files'], files: [file('a.png')] }, preventDefault() {} })
    await new Promise((r) => setTimeout(r, 30))
    expect(posts(h)).toHaveLength(0)
  })

  it('minden sajat szoveg a t()-n megy at', async () => {
    const h = setup()
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal'])).toBe('')
  })
})
