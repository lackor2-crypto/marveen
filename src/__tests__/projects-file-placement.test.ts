// Hova keruljon az uj fajl a projektben (kanban #321, Boss 2026-09-19,
// kommentek 1136-1138).
//
// Amit ez a teszt orzi:
//   - a fajl fajtaja a kiterjesztesbol / MIME-bol, a NEV felulirja (szerzodes.pdf = jogi);
//   - a javaslat a projekt SAJAT almappai kozul valaszt, ekezet- es
//     kisbetu-fuggetlenul, a melyebb (konkretabb) mappa nyer;
//   - nincs illo mappa: NEM a fomappa, hanem uj mappanev + szulo (gyujto-mappa,
//     ha van; kulonben a fomappa ala, a gyujtovel egyutt);
//   - ures (friss) projektmappan is ad javaslatot;
//   - a mappavalaszto a melyebb almappakat is kinalja, git-tarolo nelkul;
//   - a mappa CSAK a mkdir-hivasra jon letre, projekten kivulre nem vezethet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// A telepites nyelve (a lemezen levo mappanevek nyelve) itt magyar,
// fuggetlenul a futtato gep .lang fajljatol.
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_LANG: 'hu' }))
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { fileKind, suggestPlacement, placeKey } from '../project-file-placement.js'
import { projectSubfolders, makeProjectFolder, writeProjectFile } from '../project-files.js'
import { tryHandleProjects } from '../web/routes/projects.js'
import type { RouteContext } from '../web/routes/types.js'

describe('a fajl fajtaja', () => {
  it('kiterjesztesbol, MIME-bol, es a nev felulirja', () => {
    expect(fileKind('IMG_0012.JPG')).toBe('photo')
    expect(fileKind('klip.mov')).toBe('video')
    expect(fileKind('interju.m4a')).toBe('audio')
    expect(fileKind('index.html')).toBe('web')
    expect(fileKind('ajanlat.pdf')).toBe('doc')
    expect(fileKind('valami', 'image/png')).toBe('photo')
    expect(fileKind('valami', 'video/mp4')).toBe('video')
    expect(fileKind('Szerződés Kovács.pdf')).toBe('contract')
    expect(fileKind('tavaszi-poszt.png')).toBe('post')
    expect(fileKind('weboldal-szoveg.docx')).toBe('web')
    expect(fileKind('ismeretlen.xyz')).toBe('other')
    // Rovid tipp nem prefix: posta/postas nem 'post', de a poszt marad.
    expect(fileKind('posta-level.pdf')).toBe('doc')
    expect(fileKind('postas.jpg')).toBe('photo')
    expect(fileKind('poszt-tavasz.png')).toBe('post')
    expect(fileKind('szerzodesek.pdf')).toBe('contract')
  })
})

describe('javasolt hely -- tiszta fuggveny', () => {
  it('meglevo almappa, ekezet- es kisbetu-fuggetlenul; a melyebb nyer', () => {
    const subs = ['Média', 'Média/Fotók', 'Média/Videók', 'Jogi', 'Marketing', 'Weboldal']
    expect(suggestPlacement('kep.jpg', null, subs, 'hu')).toEqual({ type: 'existing', kind: 'photo', sub: 'Média/Fotók' })
    expect(suggestPlacement('klip.mp4', null, subs, 'hu')).toEqual({ type: 'existing', kind: 'video', sub: 'Média/Videók' })
    expect(suggestPlacement('szerzodes.pdf', null, subs, 'hu')).toMatchObject({ type: 'existing', sub: 'Jogi' })
    expect(suggestPlacement('poszt.png', null, subs, 'hu')).toMatchObject({ type: 'existing', sub: 'Marketing' })
    expect(suggestPlacement('index.html', null, subs, 'hu')).toMatchObject({ type: 'existing', sub: 'Weboldal' })
    // Angol mappanevekkel is (nincs beegetett projektstruktura).
    expect(suggestPlacement('a.png', null, ['Assets', 'Assets/Photos'], 'en')).toMatchObject({ type: 'existing', sub: 'Assets/Photos' })
    expect(placeKey('Fotók ')).toBe('fotok')
  })

  it('nincs illo mappa: uj mappa a gyujto-mappa ala, vagy gyujtovel egyutt a fomappa ala -- SOHA nem csendben a fomappa', () => {
    expect(suggestPlacement('kep.jpg', null, ['Media', 'Jogi'], 'hu')).toEqual({ type: 'new', kind: 'photo', name: 'Fotók', parent: 'Media' })
    expect(suggestPlacement('kep.jpg', null, ['Jogi'], 'hu')).toEqual({ type: 'new', kind: 'photo', name: 'Média/Fotók', parent: '' })
    expect(suggestPlacement('kep.jpg', null, ['Jogi'], 'en')).toEqual({ type: 'new', kind: 'photo', name: 'Media/Photos', parent: '' })
    expect(suggestPlacement('szerzodes.pdf', null, [], 'hu')).toEqual({ type: 'new', kind: 'contract', name: 'Jogi', parent: '' })
  })

  it('friss, ures projektmappa: minden fajtara van (uj mappa) javaslat', () => {
    for (const n of ['a.jpg', 'a.mp4', 'a.mp3', 'poszt.png', 'a.html', 'szerzodes.pdf', 'a.pdf', 'a.xyz']) {
      const s = suggestPlacement(n, null, [], 'hu')
      expect(s.type).toBe('new')
      expect(s.type === 'new' && s.name.length > 0).toBe(true)
    }
  })
})

describe('mappak a lemezen', () => {
  let depot: string
  let saved: string | undefined
  beforeEach(() => {
    initDatabase(':memory:')
    saved = process.env.MARVEEN_DEPOT
    depot = mkdtempSync(join(tmpdir(), 'marveen-prjplace-'))
    process.env.MARVEEN_DEPOT = depot
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.MARVEEN_DEPOT
    else process.env.MARVEEN_DEPOT = saved
    rmSync(depot, { recursive: true, force: true })
  })
  function project() {
    mkdirSync(join(depot, 'Projektek', 'Web'), { recursive: true })
    const r = createProject({ name: 'Web', folder_path: 'Projektek/Web' })
    if (!r.ok) throw new Error(r.code)
    return r.project
  }
  function call(method: string, path: string, body: unknown) {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead(s: number) { out.status = s; return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
    const buf = Buffer.from(JSON.stringify(body))
    const req: any = { headers: { 'content-length': String(buf.length) }, on(ev: string, cb: (b?: Buffer) => void) { if (ev === 'data') cb(buf); if (ev === 'end') cb(); return req }, destroy() {} }
    const url = new URL('http://localhost:3420' + path)
    return tryHandleProjects({ req, res, path: url.pathname, method, url } as RouteContext).then(() => out)
  }

  it('a valaszto a melyebb almappakat is kinalja; rejtett, node_modules es git-tarolo nelkul', () => {
    const p = project()
    const w = join(depot, 'Projektek', 'Web')
    for (const d of ['Media/Fotok', 'Media/Videok', 'Fejlesztes/Tudasbazis', '.kuka', 'node_modules/x', 'Kod/.git']) mkdirSync(join(w, ...d.split('/')), { recursive: true })
    expect(projectSubfolders(p)).toEqual(['Fejlesztes', 'Fejlesztes/Tudasbazis', 'Media', 'Media/Fotok', 'Media/Videok'])
    // A melyebb almappaba irhato is.
    expect(writeProjectFile(p, 'Media/Fotok', 'a.jpg', Buffer.from('x'))).toMatchObject({ ok: true })
    expect(writeProjectFile(p, '../..', 'a.jpg', Buffer.from('x'))).toMatchObject({ ok: false, code: 'bad_folder' })
  })

  it('a mappa CSAK a mkdir-re jon letre; szulo ala, tobb szinttel is; projekten kivulre nem', async () => {
    const p = project()
    const w = join(depot, 'Projektek', 'Web')
    // A javaslat semmit nem hoz letre.
    const sug = await call('POST', `/api/projects/${p.id}/placement?lang=hu`, { name: 'kep.jpg', mime: 'image/jpeg' })
    expect(sug.body.placement).toEqual({ type: 'new', kind: 'photo', name: 'Média/Fotók', parent: '' })
    expect(existsSync(join(w, 'Média'))).toBe(false)
    // Angol felulet + magyar telepites: a lemezre kerulo nev a telepitese.
    const en = await call('POST', `/api/projects/${p.id}/placement?lang=en`, { name: 'kep.jpg', mime: 'image/jpeg' })
    expect(en.body.placement).toEqual({ type: 'new', kind: 'photo', name: 'Média/Fotók', parent: '' })
    const made = await call('POST', `/api/projects/${p.id}/mkdir?lang=hu`, { parent: '', name: 'Média/Fotók' })
    expect(made.body).toEqual({ ok: true, sub: 'Média/Fotók', created: true })
    expect(existsSync(join(w, 'Média', 'Fotók'))).toBe(true)
    // Masodszor: mar megvan, nem hiba.
    expect((await call('POST', `/api/projects/${p.id}/mkdir`, { parent: 'Média', name: 'Fotók' })).body).toMatchObject({ ok: true, created: false, sub: 'Média/Fotók' })
    // Most mar a meglevot javasolja.
    expect((await call('POST', `/api/projects/${p.id}/placement`, { name: 'b.png' })).body.placement).toMatchObject({ type: 'existing', sub: 'Média/Fotók' })
    // Rossz nevek, kivezeto utak, nem letezo szulo -- emberi hibauzenettel.
    for (const bad of ['..', '../kint', '.rejtett', 'a:b', '', 'a/b/c/d/e']) {
      const r = await call('POST', `/api/projects/${p.id}/mkdir?lang=hu`, { parent: '', name: bad })
      expect(r.status, bad).toBe(400)
      expect(typeof r.body.message).toBe('string')
    }
    expect((await call('POST', `/api/projects/${p.id}/mkdir`, { parent: '../..', name: 'x' })).body.error).toBe('bad_folder')
    expect((await call('POST', `/api/projects/${p.id}/mkdir`, { parent: 'Nincs', name: 'x' })).body.error).toBe('bad_folder')
    expect(existsSync(join(depot, 'Projektek', 'kint'))).toBe(false)
    // Git-tarolo belsejebe nem.
    mkdirSync(join(w, 'Kod', '.git'), { recursive: true })
    expect(makeProjectFolder(p, 'Kod', 'uj')).toMatchObject({ ok: false, code: 'repo_inside' })
  })
})
