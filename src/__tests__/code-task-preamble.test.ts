// A KOD-HID ELOHANGJA (#222) -- mit allithat magarol a dispatcher, es mit nem.
//
// A bug, amibol szuletett: minden regisztralt VS Code chat ful EGY mappaban all,
// es az nem a Marveen mappaja. Egy Marveen-feladat igy olyan sessionbe erkezik,
// aminek a munkakonyvtara mashol van, es a session a routingra kerdezett vissza
// ahelyett, hogy dolgozott volna (d234aa7f).
//
// Amit ezek a tesztek oriznek:
//   * a routing-mondat MINDIG ott van (ez a tenylegesen mert javitas);
//   * az elohang SOSE allit olyat a vegrehajto gepevel, amit nem mertunk meg:
//     UNC ut csak WSL-en, es ott is kimondva, hogy MERETLEN javaslat;
//   * ha a session MAR a repoban all, a "itt van a forras" bekezdes elmarad
//     (zaj), de a "nem tudom lefordítani az utat" NEM szamit "mar ott van"-nak;
//   * a tarolt feladat-sor VALTOZATLAN marad: az elohang csak a valaszban van.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase } from '../db.js'
import { buildCodeTaskPreamble, withCodeTaskPreamble } from '../web/code-task-preamble.js'
import {
  resetCodeBridgeTablesForTests, upsertCodeSession, enqueueCodeTask, getCodeTask,
} from '../web/code-bridge-store.js'
import { tryHandleCode } from '../web/routes/code.js'

const ROOT = '/srv/marveen'
const OUTSIDE = 'F:\\Valami\\Mas\\Projekt'
const SID = 'aaaaaaaa-0000-4000-8000-000000000001'

describe('elohang: a routing-mondat', () => {
  it('MINDEN esetben ott van, meg akkor is, ha a session mar a repoban all', () => {
    for (const ws of [OUTSIDE, ROOT, '']) {
      const text = buildCodeTaskPreamble({ workspacePath: ws, hostKind: 'unix', projectRoot: ROOT, lang: 'hu' })
      expect(text).toContain('FELADAT SZOVEGE')
      expect(text).toContain('ne allj le rakerdezni a routingra')
    }
  })

  it('angolul teljes a szoveg, nem csuszik at bele magyar mondat', () => {
    const en = buildCodeTaskPreamble({ workspacePath: OUTSIDE, hostKind: 'wsl', projectRoot: ROOT, lang: 'en' })
    // Mind a negy bekezdes angolul all, es a magyar valtozat egyetlen
    // horgonyszava sem maradt benne.
    expect(en).toContain('decided by the TASK TEXT')
    expect(en).toContain("Marveen's own source")
    expect(en).toContain('isolated git worktree')
    expect(en).toContain('do NOT guess')
    expect(en).not.toMatch(/feladat|mappa|elohang|javaslat/i)
  })
})

describe('elohang: a vegrehajto gepere SOSE allitunk meretlent', () => {
  it('nem-WSL telepitesen egyaltalan nincs UNC ut a szovegben', () => {
    const text = buildCodeTaskPreamble({ workspacePath: OUTSIDE, hostKind: 'unix', projectRoot: ROOT, lang: 'hu' })
    expect(text).not.toContain('wsl.localhost')
    expect(text).toContain(ROOT)
  })

  it('WSL-en ott az UNC alak, DE kimondva, hogy meretlen javaslat', () => {
    const text = buildCodeTaskPreamble({
      workspacePath: OUTSIDE, hostKind: 'wsl', projectRoot: ROOT, distro: 'Debian', lang: 'hu',
    })
    expect(text).toContain('\\\\wsl.localhost\\Debian\\srv\\marveen')
    expect(text).toContain('SENKI NEM MERTE MEG')
    expect(text).toContain('javaslat, nem parancs')
  })

  it('ha a disztro nevet nem latjuk, azt is kimondja -- nem adja ki tenynek', () => {
    const text = buildCodeTaskPreamble({
      workspacePath: OUTSIDE, hostKind: 'wsl', projectRoot: ROOT, distro: null, lang: 'hu',
    })
    expect(text).toContain('a disztro nevet innen nem latjuk')
  })

  it('Windows-telepitesen csak az UGYANEZEN a gepen ervenyes alakot allitja', () => {
    const text = buildCodeTaskPreamble({ workspacePath: OUTSIDE, hostKind: 'windows', projectRoot: ROOT, lang: 'hu' })
    expect(text).toContain('\\srv\\marveen')
    expect(text).toContain('MASIK gepen')
    expect(text).not.toContain('wsl.localhost')
  })
})

describe('elohang: a "hol a forras" bekezdes csak akkor kell, ha tenyleg kell', () => {
  it('a repon BELUL allo session nem kap ut-bekezdest (zaj lenne)', () => {
    const text = buildCodeTaskPreamble({
      workspacePath: `${ROOT}/.worktrees/valaki`, hostKind: 'wsl', projectRoot: ROOT, lang: 'hu',
    })
    expect(text).not.toContain('Ha a feladat a Marveen sajat forrasat erinti')
  })

  it('a repon KIVUL allo session megkapja', () => {
    const text = buildCodeTaskPreamble({ workspacePath: OUTSIDE, hostKind: 'wsl', projectRoot: ROOT, lang: 'hu' })
    expect(text).toContain('Ha a feladat a Marveen sajat forrasat erinti')
  })

  it('a NEM lefordithato ut nem szamit "mar ott van"-nak -- tobbet mond, nem kevesebbet', () => {
    // Halozati megosztas: a toLocalWorkspacePath nem tudja lefordítani. Ez
    // "nem latok oda", nem "a repoban all" -- a ketto nem ugyanaz.
    const text = buildCodeTaskPreamble({
      workspacePath: '\\\\nas\\share\\projekt', hostKind: 'wsl', projectRoot: ROOT, lang: 'hu',
    })
    expect(text).toContain('Ha a feladat a Marveen sajat forrasat erinti')
  })

  it('a hasonlo nevu szomszed mappa NEM szamit a repon belulinek', () => {
    const text = buildCodeTaskPreamble({ workspacePath: `${ROOT}-masik`, hostKind: 'unix', projectRoot: ROOT, lang: 'hu' })
    expect(text).toContain('Ha a feladat a Marveen sajat forrasat erinti')
  })
})

describe('elohang: gepfuggetlen', () => {
  it('a modulban nincs beegetett abszolut ut vagy disztro-fuggo felteves', () => {
    const src = readFileSync(new URL('../web/code-task-preamble.ts', import.meta.url), 'utf8')
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    expect(code).not.toMatch(/['"`]\/home\//)
    expect(code).not.toMatch(/['"`]\/mnt\/[a-z]\//)
  })

  it('a kimenetben a kapott gyoker szerepel, nem a fejlesztoe', () => {
    const text = buildCodeTaskPreamble({ workspacePath: OUTSIDE, hostKind: 'unix', projectRoot: '/opt/valami', lang: 'hu' })
    expect(text).toContain('/opt/valami')
    expect(text).not.toContain('/home/')
  })
})

// --- a huzal: a claim valasza kapja meg, a TAROLT sor nem -------------------

interface Captured { status: number; body: any }

async function call(method: string, path: string, body?: unknown): Promise<Captured> {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from([Buffer.from(payload)]) as unknown as http.IncomingMessage
  ;(req as any).socket = { remoteAddress: '127.0.0.1' }
  ;(req as any).headers = { 'content-type': 'application/json' }
  const out: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: any) { if (chunk) { try { out.body = JSON.parse(String(chunk)) } catch { out.body = String(chunk) } } },
  } as unknown as http.ServerResponse
  const handled = await tryHandleCode({
    req, res, path, method, url: new URL('http://127.0.0.1:3420' + path),
  } as any)
  expect(handled).toBe(true)
  return out
}

describe('claim: az elohang a valaszban van, az adatbazisban nem', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    resetCodeBridgeTablesForTests()
  })

  it('a vegrehajto elohanggal kapja, a tarolt sor a tulajdonos szovege marad', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: OUTSIDE, sessionId: SID, pinned: true })
    const queued = enqueueCodeTask({ project: 'tozsde', prompt: 'Javitsd az EA stop-lossat.' })
    expect('task' in queued).toBe(true)
    const id = (queued as { task: { id: string } }).task.id

    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'WINPC' })
    expect(claimed.body.task.id).toBe(id)
    expect(claimed.body.task.prompt).toContain('KOD-HID ELOHANG')
    expect(claimed.body.task.prompt).toContain('Javitsd az EA stop-lossat.')
    // A sorrend szamit: az elohang ELOL van, kulonben a session a feladat vegen
    // talalna ra, amikor a routing-kerdes mar megszuletett.
    expect(claimed.body.task.prompt.indexOf('KOD-HID ELOHANG'))
      .toBeLessThan(claimed.body.task.prompt.indexOf('Javitsd az EA'))

    expect(getCodeTask(id)!.prompt).toBe('Javitsd az EA stop-lossat.')
  })

  it('ures sorbol nem keletkezik elohang (nincs mit dekoralni)', async () => {
    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'WINPC' })
    expect(claimed.body.task).toBeNull()
  })
})

describe('withCodeTaskPreamble', () => {
  it('elvalasztoval fuzi ossze, hogy a ket resz ne folyjon egybe', () => {
    const out = withCodeTaskPreamble('A FELADAT', { workspacePath: OUTSIDE, hostKind: 'unix', projectRoot: ROOT, lang: 'hu' })
    expect(out).toMatch(/\n\n---\n\nA FELADAT$/)
  })
})
