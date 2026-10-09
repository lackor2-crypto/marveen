// #406 (Boss TG 6642/6653, 3-4. lepes) -- a poszt platform-kepei: a Munkapad a
// pontos meretre vagott kepet UJ fajlkent elmenti a projekt mappajaba, es a
// betekinto link lapja (szkript nelkul) ezt kinalja letoltesre.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject, updateProject, setProjectArchived } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { imageSize, listPostFiles, postFileName } from '../workbench-post-files.js'
import { requestShare, shareToken, _setShareDeps } from '../workbench-share.js'
import { tryHandleWorkbenchShareView } from '../web/routes/workbench-share-view.js'
import type { RouteContext } from '../web/routes/types.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian, PROJECT } from './helpers/workbench-harness.js'

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}
function jpg(w: number, h: number): Buffer {
  // SOI, APP0 (rovid), SOF0 a merettel
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])
  const sof = Buffer.alloc(19)
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7)
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}

async function view(path: string) {
  const chunks: Buffer[] = []
  const out = { status: 200, headers: {} as Record<string, string> }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const done = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number, h?: Record<string, string>) => { out.status = s; if (h) out.headers = { ...out.headers, ...h }; return res }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  const handled = await tryHandleWorkbenchShareView({ req, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext)
  if (handled) await done
  return { status: out.status, headers: out.headers, body: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf-8') }
}

describe('kep-meret a fejlecbol', () => {
  it('PNG es JPEG merete; ismeretlen -> null', () => {
    expect(imageSize(png(1080, 1350))).toEqual({ w: 1080, h: 1350 })
    expect(imageSize(jpg(1200, 627))).toEqual({ w: 1200, h: 627 })
    expect(imageSize(Buffer.from('nem kep'))).toBeNull()
  })
  it('fajlnev: cim + platform + meret, tiltott karakter nelkul', () => {
    expect(postFileName('Nyitás: 2026/09', 'fb_feed', 'jpg')).toBe('Nyitás 2026 09 - fb_feed 1080x1350.jpg')
    expect(postFileName('', 'ig_story', 'png')).toBe('poszt - ig_story 1080x1920.png')
  })
})

describe('mentes es betekinto link', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const dir = () => join(depot, 'Projektek', 'teszt')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-post-'))
    mkdirSync(dir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/teszt' }).ok) throw new Error('mappa')
    const w = createWorkItem({ project_id: pid, title: 'Nyitás', type: 'composite' })
    if (!w.ok) throw new Error('mu')
    itemId = w.item.id
    _setShareDeps({ level: () => 3 })
  })

  afterEach(() => {
    _setShareDeps()
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const save = (platform: string, bytes: Buffer) =>
    callWorkbench(`/api/workbench/items/${itemId}/post-files?platform=${platform}`, 'POST', bytes, { 'content-type': 'image/jpeg' })

  it('pontos meretu JPG: uj fajl a munkadarab mellett (nem a projekt gyokereben), masodik mentes nem ir felul', async () => {
    const r = await save('fb_feed', jpg(1080, 1350))
    expect(r.status).toBe(201)
    expect(r.body.name).toBe('Nyitás - fb_feed 1080x1350.jpg')
    const again = await save('fb_feed', jpg(1080, 1350))
    expect(again.body.name).toBe('Nyitás - fb_feed 1080x1350 (2).jpg')
    // #496: a mappa nelkuli munkadarab kepei a munkadarabok dobozaba kerulnek, a projekt gyokerebe soha.
    const files = readdirSync(dir(), { withFileTypes: true })
    expect(files.filter((e) => e.isFile())).toEqual([])
    const box = files.find((e) => e.isDirectory())?.name ?? ''
    expect(readdirSync(join(dir(), box)).sort()).toEqual(['Nyitás - fb_feed 1080x1350 (2).jpg', 'Nyitás - fb_feed 1080x1350.jpg'])
    // platformonkent a legujabb latszik
    const list = await callWorkbench(`/api/workbench/items/${itemId}/post-files`, 'GET')
    expect(list.body.files).toHaveLength(1)
    expect(list.body.files[0].name).toBe('Nyitás - fb_feed 1080x1350 (2).jpg')
  })

  it('rossz meret, nem kep, ismeretlen platform: emberi mondat, fajl nem keletkezik', async () => {
    const wrong = await save('fb_feed', jpg(1080, 1080))
    expect(wrong.status).toBe(400)
    expect(wrong.body.error).toBe('post_wrong_size')
    expect(wrong.body.message).toMatch(/mérete nem egyezik/)
    expect((await save('fb_feed', Buffer.from('<svg/>'))).body.error).toBe('post_not_image')
    expect((await save('__proto__', png(1080, 1350))).body.error).toBe('post_bad_platform')
    expect((await save('fb_feed', Buffer.alloc(0))).body.error).toBe('post_empty')
    expect(readdirSync(dir())).toEqual([])
  })

  it('nincs projektmappa: a fajlrendszer mondja meg, nem "kesz"', async () => {
    rmSync(dir(), { recursive: true, force: true })
    const r = await save('ig_square', png(1080, 1080))
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('missing')
  })

  it('archivalt projektben nem ment', async () => {
    setProjectArchived(pid, true)
    expect((await save('ig_square', png(1080, 1080))).status).toBe(409)
  })

  it('betekinto lap: ures allapotban emberi mondat; mentes utan letoltheto, eltunt fajl nem', async () => {
    const s = requestShare({ kind: 'item', project_id: pid, work_item_id: itemId, days: 7, lang: 'hu', actor: 'teszt' })
    if (!s.ok) throw new Error('share')
    const tok = shareToken(s.share.id)
    let v = await view(`/view/${tok}`)
    expect(v.status).toBe(200)
    expect(v.text).toContain('még nincs elmentett platform-méretű kép')
    expect(v.text.toLowerCase()).not.toContain('<script')

    const bytes = jpg(1080, 1920)
    const r = await save('ig_story', bytes)
    expect(r.status).toBe(201)
    v = await view(`/view/${tok}`)
    const f = listPostFiles(itemId)[0]
    expect(v.text).toContain(`/view/${tok}/post/${f.id}`)
    expect(v.text).toContain('Instagram történet')
    expect(v.text).toContain('Mentés PDF-ként')

    const dl = await view(`/view/${tok}/post/${f.id}`)
    expect(dl.status).toBe(200)
    expect(dl.headers['Content-Disposition']).toContain('attachment')
    expect(dl.headers['Content-Type']).toBe('image/jpeg')
    expect(dl.body.equals(bytes)).toBe(true)

    // idegen id, al-ut a /file alatt: nem a mienk
    expect((await view(`/view/${tok}/post/nincs`)).status).toBe(404)
    expect((await view(`/view/${tok}/file/${f.id}`)).status).toBe(404)

    unlinkSync(join(depot, f.rel))
    expect((await view(`/view/${tok}/post/${f.id}`)).status).toBe(404)
    expect((await view(`/view/${tok}`)).text).toContain('még nincs elmentett')
  })

  it('mas munkadarab mentett kepe ezen a linken nem erheto el', async () => {
    const other = createWorkItem({ project_id: pid, title: 'Masik', type: 'composite' })
    if (!other.ok) throw new Error('mu2')
    const r = await callWorkbench(`/api/workbench/items/${other.item.id}/post-files?platform=li_square`, 'POST', png(1080, 1080))
    expect(r.status).toBe(201)
    const s = requestShare({ kind: 'item', project_id: pid, work_item_id: itemId, days: 7, lang: 'en', actor: 'teszt' })
    if (!s.ok) throw new Error('share')
    const tok = shareToken(s.share.id)
    const foreign = listPostFiles(other.item.id)[0]
    expect((await view(`/view/${tok}/post/${foreign.id}`)).status).toBe(404)
    expect((await view(`/view/${tok}`)).text).toContain('No platform-size image has been saved')
  })

  it('nem vegyes munkadarab lapjan nincs poszt-resz', async () => {
    const note = createWorkItem({ project_id: pid, title: 'Jegyzet', type: 'note' })
    if (!note.ok) throw new Error('note')
    const s = requestShare({ kind: 'item', project_id: pid, work_item_id: note.item.id, days: 7, lang: 'hu', actor: 'teszt' })
    if (!s.ok) throw new Error('share')
    expect((await view(`/view/${shareToken(s.share.id)}`)).text).not.toContain('A poszt képei')
  })
})

describe('felulet: mentes a megosztott linkhez', () => {
  const COMPOSITE = { id: 'w1', title: 'Poszt', type: 'composite', status: 'draft', current_version_id: 'v1' }
  const TEXT = { id: 'pt1', kind: 'text', text: 'Nyitottunk!', position: 0 }
  const IMAGE = { id: 'pi1', kind: 'image', asset_path: 'Projektek/p1/kep.jpg', caption: '', position: 1 }

  async function open(files: unknown, parts: unknown[] = [TEXT, IMAGE], filesStatus = 200) {
    const h = workbenchHarness()
    h.respond((url) => {
      if (url.includes('/post-files')) return { status: filesStatus, body: filesStatus === 200 ? { ok: true, files } : { error: 'x', message: 'Nem érem el' } }
      if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'parts' } }
      if (url.includes('/api/workbench/items/w1')) {
        return { status: 200, body: { item: COMPOSITE, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts, project: PROJECT } }
      }
      return { status: 200, body: itemsBody([COMPOSITE]) }
    })
    h.win.MarvinWorkbench.open('p1', PROJECT.name)
    await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-editor-head'))
    h.click({ 'data-wb-act': 'post-toggle' })
    return h
  }

  it('ures lista: emberi mondat, a mentes-gomb ott van', async () => {
    const h = await open([])
    await vi.waitFor(() => expect(h.html()).toContain('workbench.post.files_none'))
    expect(h.html()).toContain('data-wb-act="post-save"')
    expect(h.html()).toContain('workbench.post.save_hint')
  })

  it('elmentett kepek listaja; eltunt fajl kulon mondattal', async () => {
    const h = await open([
      { id: 'f1', platform: 'ig_story', name: 'Poszt - ig_story 1080x1920.jpg', rel: 'Projektek/p1/Poszt - ig_story 1080x1920.jpg', bytes: 9, created_at: 1, available: true },
      { id: 'f2', platform: 'fb_feed', name: 'regi.jpg', rel: 'Projektek/p1/regi.jpg', bytes: 9, created_at: 1, available: false },
    ])
    await vi.waitFor(() => expect(h.html()).toContain('workbench.post.files_title'))
    const html = h.html()
    expect(html).toContain('Poszt - ig_story 1080x1920.jpg')
    expect(html).toContain(encodeURIComponent('Projektek/p1/Poszt - ig_story 1080x1920.jpg'))
    expect(html).toContain('workbench.post.file_missing')
    expect(untranslatedHungarian(html, ['Kovács weboldal', 'Nyitottunk!', 'Poszt'])).toBe('')
  })

  it('a lista nem erheto el: az a "nem latok oda" mondat, nem az ures', async () => {
    const h = await open(null, [TEXT, IMAGE], 500)
    await vi.waitFor(() => expect(h.html()).toContain('workbench.post.files_error'))
    expect(h.html()).not.toContain('workbench.post.files_none')
  })

  it('kep nelkul a mentes-gomb tiltva', async () => {
    const h = await open([], [TEXT])
    expect(h.html()).toMatch(/data-wb-act="post-save" disabled/)
  })
})
