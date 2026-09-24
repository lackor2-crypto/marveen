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

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
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
    expect(en).toContain('not a fleet agent')
    expect(en).not.toMatch(/feladat|mappa|elohang|javaslat/i)
  })
})

describe('elohang: a jelentesi ut (a task-result a jelentes, nem Telegram/inter-agent) -- #274', () => {
  it('HU: minden esetben ott a vedosor, hogy NE probaljon Telegram/inter-agent uzenetet', () => {
    for (const ws of [OUTSIDE, ROOT, '']) {
      const text = buildCodeTaskPreamble({ workspacePath: ws, hostKind: 'unix', projectRoot: ROOT, lang: 'hu' })
      expect(text).toContain('A JELENTESED a task EREDMENYE')
      expect(text).toContain('NE probalj Telegram')
      expect(text).toContain('nem')
      expect(text).toContain('flotta-agens')
      expect(text).toContain('a Marveen dashboard')
    }
  })

  it('EN: minden esetben ott a vedosor angolul', () => {
    for (const ws of [OUTSIDE, ROOT, '']) {
      const text = buildCodeTaskPreamble({ workspacePath: ws, hostKind: 'unix', projectRoot: ROOT, lang: 'en' })
      expect(text).toContain('YOUR REPORT is the task RESULT')
      expect(text).toContain('Do NOT try to send Telegram')
      expect(text).toContain('not a fleet agent')
      expect(text).toContain('Marveen dashboard notifies the owner')
    }
  })

  it('a vedosor a ZARO OSSZEFOGLALO utan all (a jelentesi ut a legvegen zar)', () => {
    const text = buildCodeTaskPreamble({ workspacePath: OUTSIDE, hostKind: 'unix', projectRoot: ROOT, lang: 'hu' })
    expect(text.indexOf('ZARO OSSZEFOGLALOT'))
      .toBeLessThan(text.indexOf('A JELENTESED a task EREDMENYE'))
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

// ---------------------------------------------------------------------------
// KARTYA 3837120e (#273): a 3. pont MAR NEM TANACS, hanem TENY.
//
// A kartya pont azt allapitotta meg, hogy egy tanacsado mondat ("dolgozz izolalt
// worktree-ben") nem strukturalis javitas. Mostantol a dispatcher MAR athelyezte
// a munkakonyvtarat, es az elohang harom, egymastol elvalaszthatatlan allapot
// kozul MONDJA KI a helyeset. A legrosszabb allapot a NEMA: ha a vegrehajto azt
// hiszi, izolaltan all, holott az elo faban -- ezert van sajat, hangos agа.
// ---------------------------------------------------------------------------
describe('elohang 3. pont: hol all TENYLEGESEN a vegrehajto (#273)', () => {
  it('atiranyitva: kimondja hogy MAR worktree-ben all, a branch-csel, es tiltja az elo fat', () => {
    const hu = buildCodeTaskPreamble({
      workspacePath: `${ROOT}/.worktrees/code-3837120e`,
      hostKind: 'unix', projectRoot: ROOT, lang: 'hu',
      worktree: { redirected: true, branch: 'work/code-3837120e', reason: null, wasLiveTree: true },
    })
    expect(hu).toContain('MAR EGY IZOLALT GIT WORKTREE')
    expect(hu).toContain('work/code-3837120e')
    expect(hu).toContain('NE valts at az elo')
    // A verifikacios kotelem nem eshet ki az uj agbol.
    expect(hu).toContain('npx vitest run')
    expect(hu).toContain('npx tsc --noEmit')
    expect(hu).toContain('land-pr.sh')
    // Es NE mondja neki, hogy nyisson worktree-t: mar benne all.
    expect(hu).not.toContain('agent-worktree.sh')
  })

  it('atiranyitva, angolul: ugyanaz, magyar szo nelkul', () => {
    const en = buildCodeTaskPreamble({
      workspacePath: `${ROOT}/.worktrees/code-1`,
      hostKind: 'unix', projectRoot: ROOT, lang: 'en',
      worktree: { redirected: true, branch: 'work/code-1', reason: null, wasLiveTree: true },
    })
    expect(en).toContain('ALREADY AN ISOLATED GIT WORKTREE')
    expect(en).toContain('work/code-1')
    expect(en).toContain('do NOT switch to the live')
    expect(en).not.toMatch(/worktree-ben|elo checkout|hibauzenet/i)
  })

  it('BUKOTT atiranyitas: hangosan megmondja, hogy az ELO faban all, a git SAJAT hibajaval', () => {
    const hu = buildCodeTaskPreamble({
      workspacePath: ROOT,
      hostKind: 'unix', projectRoot: ROOT, lang: 'hu',
      worktree: {
        redirected: false, branch: null, wasLiveTree: true,
        reason: "fatal: 'work/code-1' is already checked out at '/srv/marveen/.worktrees/code-1'",
      },
    })
    expect(hu).toContain('FIGYELEM')
    expect(hu).toContain('ELO CHECKOUTBAN')
    // A git szo szerinti mondata -- ez az, amibol a vegrehajto tudja, mi a baj.
    expect(hu).toContain('is already checked out at')
    expect(hu).toContain('NE szerkessz')
    // Itt IGENIS mondja meg, hogyan nyisson magatol worktree-t.
    expect(hu).toContain('agent-worktree.sh')
  })

  it('BUKOTT atiranyitas hibauzenet NELKUL: nem ures mondatot ad, hanem kimondja hogy nincs uzenet', () => {
    // A NULLA KET DOLGOT JELENT: a "nincs hibauzenet" nem ugyanaz, mint a
    // "nincs hiba". Ha csak kihagynank, a mondat felreerthetove valna.
    const hu = buildCodeTaskPreamble({
      workspacePath: ROOT, hostKind: 'unix', projectRoot: ROOT, lang: 'hu',
      worktree: { redirected: false, branch: null, reason: null, wasLiveTree: true },
    })
    expect(hu).toContain('FIGYELEM')
    expect(hu).toContain('nem all rendelkezesre')
  })

  it('NEM az elo fa (mas projekt): a regi, tanacsado mondat marad ervenyben', () => {
    const hu = buildCodeTaskPreamble({
      workspacePath: OUTSIDE, hostKind: 'unix', projectRoot: ROOT, lang: 'hu',
      worktree: { redirected: false, branch: null, reason: null, wasLiveTree: false },
    })
    expect(hu).toContain('izolalt git worktree')
    expect(hu).toContain('agent-worktree.sh')
    expect(hu).not.toContain('FIGYELEM')
  })

  it('worktree-informacio NELKUL (regi hivo) sem veszik el a 3. pont', () => {
    const hu = buildCodeTaskPreamble({ workspacePath: OUTSIDE, hostKind: 'unix', projectRoot: ROOT, lang: 'hu' })
    expect(hu).toContain('izolalt git worktree')
    expect(hu).toContain('land-pr.sh')
  })
})

// ---------------------------------------------------------------------------
// A HUZAL VEGE (#273): a claim VALASZA tenylegesen mas munkakonyvtarat ad, ha a
// bekotott session EZ a telepites.
//
// Ez a resz nem forraskodot egyeztet: VALODI `git worktree`-t nyit ennek a
// checkoutnak a `.worktrees/` mappajaban (ami gitignore-olt), majd el is
// takaritja. Igy a teszt akkor is fog, ha valaki a resolver hivasat kiveszi a
// claim-bol -- pontosan az a regresszio, amiert a kartya szuletett.
// ---------------------------------------------------------------------------
describe('claim: a MARVEEN-feladat nem az elo checkoutban indul (#273)', () => {
  // A worktree neve a feladatbol szarmazik, ezert a takaritas csak a futas utan
  // tudja, MIT kell elszedni. (Kanban kartya nelkul a task id eleje adja a
  // nevet -- ez maga is fontos allitas: kartya nelkul SEM fut az elo faban.)
  let made: { dir: string; branch: string } | null = null
  const git = (...args: string[]): void => { spawnSync('git', ['-C', PROJECT_ROOT, ...args], { encoding: 'utf8' }) }

  beforeEach(() => {
    initDatabase(':memory:')
    resetCodeBridgeTablesForTests()
  })

  afterAll(() => {
    // Nyomtalan munka: amit a teszt letrehozott, azt a teszt szedi el.
    if (!made) return
    git('worktree', 'remove', '--force', made.dir)
    git('worktree', 'prune')
    git('branch', '-D', made.branch)
  })

  it('az elo checkoutba bekotott session feladata IZOLALT worktree utjat kapja', async () => {
    upsertCodeSession({ project: 'marveen', workspacePath: PROJECT_ROOT, sessionId: SID, pinned: true })
    const queued = enqueueCodeTask({ project: 'marveen', prompt: 'Javitsd a dashboardot.' })
    expect('task' in queued).toBe(true)
    const id = (queued as { task: { id: string } }).task.id

    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'WINPC' })
    expect(claimed.body.task.id).toBe(id)

    const name = `code-${id.slice(0, 8)}`
    const dir = join(PROJECT_ROOT, '.worktrees', name)
    made = { dir, branch: `work/${name}` }

    // EZ A KARTYA LENYEGE: nem az elo fa megy ki a workernek.
    expect(claimed.body.task.workspacePath).not.toBe(PROJECT_ROOT)
    expect(claimed.body.task.workspacePath).toBe(dir)
    // Es tenyleg ott van, tenyleg worktree (a git mondja meg, nem mi).
    expect(existsSync(dir)).toBe(true)
    expect(spawnSync('git', ['-C', PROJECT_ROOT, 'worktree', 'list'], { encoding: 'utf8' }).stdout).toContain(dir)

    // Az elohang MAR tenyt allit, nem tanacsot ad.
    expect(claimed.body.task.prompt).toContain('MAR EGY IZOLALT GIT WORKTREE')
    expect(claimed.body.task.prompt).toContain(made.branch)

    // Frissen nyitott worktree-ben nincs mit folytatni: uj beszelgetes indul,
    // kulonben a `--resume` egy olyan szalat keresne, ami ott nem letezik.
    expect(claimed.body.task.startFresh).toBe(true)

    // A TAROLT sor is a valosagot mutatja -- a felulet es a tema-folytatas ebbol
    // olvassa, hol dolgozik a vegrehajto.
    expect(getCodeTask(id)!.workspacePath).toBe(dir)
    // A tulajdonos szovege viszont valtozatlan marad.
    expect(getCodeTask(id)!.prompt).toBe('Javitsd a dashboardot.')
  })

  it('MAS projekt feladata valtozatlanul a sajat mappajaban indul', async () => {
    upsertCodeSession({ project: 'tozsde', workspacePath: OUTSIDE, sessionId: SID, pinned: true })
    const queued = enqueueCodeTask({ project: 'tozsde', prompt: 'Nezd meg az EA-t.' })
    const id = (queued as { task: { id: string } }).task.id

    const claimed = await call('POST', '/api/code/tasks/claim', { host: 'WINPC' })
    expect(claimed.body.task.workspacePath).toBe(OUTSIDE)
    expect(claimed.body.task.prompt).toContain('agent-worktree.sh')
    expect(claimed.body.task.prompt).not.toContain('MAR EGY IZOLALT GIT WORKTREE')
    expect(getCodeTask(id)!.workspacePath).toBe(OUTSIDE)
  })
})

// #358 utan: az elohang "Kanban kartyat ne mozgass" mondata felulirta a
// kanban-approval-workflow skillt, es a landolt #358/#359 'in_progress'-ben
// ragadt. A 7. pont most kimondja: testing -> waiting, csak elore, done soha.
describe('elohang: a kartya oszlopa a vegrehajto dolga (#358 utan)', () => {
  it('a tilto mondat SEHOL nem szerepel, egyik allapotban es nyelven sem', () => {
    for (const lang of ['hu', 'en'] as const) {
      for (const worktree of [
        undefined,
        { redirected: true, branch: 'work/x', reason: null, wasLiveTree: true },
        { redirected: false, branch: null, reason: 'boom', wasLiveTree: true },
      ]) {
        const text = buildCodeTaskPreamble({ workspacePath: ROOT, hostKind: 'unix', projectRoot: ROOT, lang, worktree })
        expect(text).not.toMatch(/ne mozgass|do not move kanban/i)
      }
    }
  })

  it('HU: testing, majd waiting; elore csak, done soha; a sajat cim es token-ut', () => {
    const hu = buildCodeTaskPreamble({ workspacePath: ROOT, hostKind: 'unix', projectRoot: ROOT, lang: 'hu', webPort: 4999 })
    expect(hu).toContain('7. HA A FELADAT KANBAN KARTYARA SZOL')
    expect(hu).toContain('"testing"-be')
    expect(hu).toContain('"waiting"-be')
    expect(hu).toContain('SOHA ne huzd')
    expect(hu).toContain('"done"-ba soha ne tedd')
    expect(hu).toContain('http://localhost:4999/api/kanban/card-ids')
    expect(hu).toContain(`${ROOT}/store/.dashboard-token`)
  })

  it('EN: ugyanez angolul, magyar horgonyszo nelkul', () => {
    const en = buildCodeTaskPreamble({ workspacePath: ROOT, hostKind: 'unix', projectRoot: ROOT, lang: 'en', webPort: 4999 })
    expect(en).toContain('7. IF THE TASK IS ABOUT A KANBAN CARD')
    expect(en).toContain('move the card to "testing"')
    expect(en).toContain('move it to "waiting" RIGHT AWAY')
    expect(en).toContain('never put it in "done"')
    expect(en).not.toMatch(/kartya|tulajdonos|hibauzenet/i)
  })
})
