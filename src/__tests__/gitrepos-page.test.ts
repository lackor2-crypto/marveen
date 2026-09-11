// A RAKTAR "Git tarolok" LAPJA.
//
// A lap egyetlen nehez kerdest valaszol meg: ha NINCS mit mutatni, MIERT
// nincs. Ot kulonbozo allapot ad ures listat -- sose futott, nem olvashato a
// naplo, nem jarhato be a tarolo-gyoker, nincs bekotve fiok, vagy fut es
// tenyleg ures --, es ezek kozul CSAK az egyik "minden rendben". Egy friss
// telepitesen a helyes valasz a csend; egy lecsatolt meghajtonal a
// leghangosabb sor kell. A ketto kivulrol ugyanaz a nulla.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type http from 'node:http'

const store = mkdtempSync(join(tmpdir(), 'marveen-gitrepos-'))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

const { lastSyncState } = await import('../git-sync.js')

const STATE_FILE = join(store, 'git-sync.json')

beforeEach(() => {
  rmSync(STATE_FILE, { force: true })
})

describe('lastSyncState -- a nulla ket dolgot jelenthet', () => {
  it('a hianyzo naplot "meg sose futott"-nak mondja, nem hibanak', () => {
    expect(existsSync(STATE_FILE)).toBe(false)
    const st = lastSyncState()
    expect(st.run).toBeNull()
    expect(st.neverRan).toBe(true)
    expect(st.readError).toBe('')
  })

  it('az OLVASHATATLAN naplo NEM ugyanaz, mint a "sose futott"', () => {
    writeFileSync(STATE_FILE, '{ ez nem json', 'utf8')
    const st = lastSyncState()
    expect(st.run).toBeNull()
    // Ez a ketto egyutt a lenyeg: a fajl OTT VAN, tehat futott mar valamikor,
    // csak most nem latok oda. Ha a `neverRan` itt igaz lenne, a felulet egy
    // elromlott allapotra mondana azt, hogy friss telepites.
    expect(st.neverRan).toBe(false)
    expect(st.readError).not.toBe('')
  })

  it('ervenyes naplonal visszaadja a futast, es egyik jelzot sem allitja', () => {
    writeFileSync(STATE_FILE, JSON.stringify({
      startedAt: '2026-09-11T02:30:00.000Z', finishedAt: '2026-09-11T02:32:00.000Z',
      durationSec: 120, results: [], updated: 0, skipped: 0, offline: 0, offlineSince: null, errors: 0,
    }), 'utf8')
    const st = lastSyncState()
    expect(st.neverRan).toBe(false)
    expect(st.readError).toBe('')
    expect(st.run?.durationSec).toBe(120)
  })
})

describe('a szinkron eredmenye megmondja, MELYIK fiok repoja', () => {
  const src = readFileSync(new URL('../git-sync.ts', import.meta.url), 'utf8')

  it('a SyncResult tipusban ott a fiok mezo', () => {
    expect(src).toMatch(/export interface SyncResult\b[\s\S]*?\baccount: string/)
  })

  it('MINDEN visszateresi ag kitolti -- a hibaag is', () => {
    // A felulet fiokonkent csoportosit. Egy kimaradt ag "ismeretlen fiok"-ba
    // esne, ami kivulrol ugy nezne ki, mintha a repo sehova nem tartozna.
    const bodyStart = src.indexOf('export async function syncRepo(')
    const bodyEnd = src.indexOf('export function lastSyncRun(')
    expect(bodyStart).toBeGreaterThan(-1)
    expect(bodyEnd).toBeGreaterThan(bodyStart)
    const body = src.slice(bodyStart, bodyEnd)
    const returns = body.match(/return \{\s*\n?\s*rel,/g) || []
    const withAccount = body.match(/return \{\s*\n?\s*rel, account,/g) || []
    expect(returns.length).toBeGreaterThan(0)
    expect(withAccount.length).toBe(returns.length)
  })

  it('a syncAllRepos hibaaga is kiszamolja a fiokot', () => {
    expect(src).toMatch(/results\.push\(\{ rel: toLifeRel\(abs\), account: accountOfPath\(abs\)/)
  })
})

describe('a lap felulete', () => {
  const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8')

  it('a Raktar csoportban ott a menupont, es van hozza lap', () => {
    expect(html).toContain('data-page="gitrepos"')
    expect(html).toContain('id="gitreposPage"')
  })

  it('a menupont a Raktar csoportban all, a Fotok mellett', () => {
    const items = html.slice(html.indexOf('id="depotNavItems"'), html.indexOf('id="depotNavItems"') + 3000)
    expect(items).toContain('data-page="photos"')
    expect(items).toContain('data-page="gitrepos"')
  })

  it('a lap betoltodik, amikor odanavigalsz', () => {
    expect(app).toContain("if (pageId === 'gitrepos') loadGitReposPage()")
  })

  it('a Raktar menu KINYILIK, ha ez a lap az aktiv', () => {
    // Enelkul a "hol vagyok" jelzes egy osszecsukott menu mogott marad.
    expect(app).toMatch(/pageId === 'drive' \|\| pageId === 'photos' \|\| pageId === 'gitrepos'/)
  })

  it('a repo a MEGLEVO Intezoben nyilik meg, nem uj klonkent', () => {
    expect(app).toContain("switchPage('intezo')")
    expect(app).toMatch(/_intezoOpen\(rel\)/)
  })

  it('NINCS push/feltoltes gomb a lapon', () => {
    // A szinkron csak lefele huz, es a helyben modositottat kihagyja. Egy
    // feltoltes-gomb olyat igerne, amit a hatter nem csinal meg.
    const page = html.slice(html.indexOf('id="gitreposPage"'), html.indexOf('id="gitreposPage"') + 2500)
    expect(page).not.toMatch(/push|feltölt|feltolt|upload/i)
  })

  it('a betoltesi hiba KULON mondatot kap, nem az ures allapotot', () => {
    expect(app).toContain("t('gitrepos.load_failed'")
  })
})

function extractFn(src: string, name: string): string {
  const start = src.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) throw new Error(`${name}() nincs meg a web/app.js-ben`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`${name}() zarojelei nem stimmelnek`)
}

describe('az ures allapot mind az ot okot kulon mondja ki', () => {
  const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8')
  const hu = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf8')
  const en = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf8')

  // A dontes-fuggveny TENYLEGESEN lefut, homokozoban. Nem azt merjuk, hogy a
  // forrasban ott all-e egy kulcs, hanem hogy melyik bemenetre MELYIK mondat
  // jon ki -- ez az egesz lap lenyege.
  const decide = new Function('t', `${extractFn(app, '_gitreposEmptyState')}
    return _gitreposEmptyState`)((k: string) => k) as (d: any) => { tone: string; text: string } | null

  const RENDBEN = { last: { rootError: '', results: [{ rel: 'a/b', account: 'x', state: 'current', message: 'ok' }] }, neverRan: false, readError: '', accounts: ['x'] }

  it('friss telepites (sose futott): NYUGTATO mondat, nem hiba', () => {
    const v = decide({ ...RENDBEN, last: null, neverRan: true })!
    expect(v.text).toBe('gitrepos.empty.never_ran')
    expect(v.tone).toBe('info')
  })

  it('olvashatatlan naplo: FIGYELMEZTETES -- ez nem friss telepites', () => {
    const v = decide({ ...RENDBEN, last: null, neverRan: false, readError: 'EACCES' })!
    expect(v.text).toBe('gitrepos.empty.read_error')
    expect(v.tone).toBe('warn')
  })

  it('bejarhatatlan tarolo-gyoker: FIGYELMEZTETES, es nem "nincs tarolo"', () => {
    // Ez a nema csapda: a bejaras nulla repot talal, es ez kivulrol pont ugy
    // nez ki, mint egy friss telepites -- kozben minden repo elavul.
    const v = decide({ last: { rootError: 'Input/output error', results: [] }, neverRan: false, readError: '', accounts: ['x'] })!
    expect(v.text).toBe('gitrepos.empty.root_error')
    expect(v.tone).toBe('warn')
  })

  it('nincs bekotve fiok: megmondja, HOL lehet felvenni', () => {
    const v = decide({ last: { rootError: '', results: [] }, neverRan: false, readError: '', accounts: [] })!
    expect(v.text).toBe('gitrepos.empty.no_accounts')
    expect(v.tone).toBe('info')
  })

  it('van fiok, de meg nincs repo: ez sem hiba', () => {
    const v = decide({ last: { rootError: '', results: [] }, neverRan: false, readError: '', accounts: ['x'] })!
    expect(v.text).toBe('gitrepos.empty.no_repos')
    expect(v.tone).toBe('info')
  })

  it('ha VAN mit mutatni, egyaltalan nem szolal meg', () => {
    expect(decide(RENDBEN)).toBeNull()
  })

  it('a hangosabb allitas nyer: elromlott gyoker + ures fiok-lista', () => {
    // Ha a sorrend forditva lenne, egy lecsatolt meghajto "vegyel fel fiokot"
    // tanacsot kapna -- es a felhasznalo a rossz helyen keresne a bajt.
    const v = decide({ last: { rootError: 'I/O', results: [] }, neverRan: false, readError: '', accounts: [] })!
    expect(v.text).toBe('gitrepos.empty.root_error')
  })

  it('mindegyik mondat megvan MAGYARUL es ANGOLUL is', () => {
    const kulcsok = [
      'gitrepos.empty.never_ran', 'gitrepos.empty.read_error', 'gitrepos.empty.root_error',
      'gitrepos.empty.no_accounts', 'gitrepos.empty.no_repos',
      'nav.gitrepos', 'gitrepos.page_title', 'gitrepos.load_failed',
    ]
    for (const k of kulcsok) {
      expect(hu).toContain(`'${k}'`)
      expect(en).toContain(`'${k}'`)
    }
  })
})

describe('a vegpont EGY hivasbol adja meg mind a negy megkulonboztetest', () => {
  // Itt a kezelo TENYLEGESEN lefut: egy sajat RouteContext megy be, es a
  // valasz JSON-jet nezzuk meg. Nem forras-egyeztetes.
  async function getGitSync() {
    const { tryHandleStorages } = await import('../web/routes/storages.js')
    let body = ''
    let status = 0
    const res = {
      statusCode: 0,
      setHeader() { /* nem szamit */ },
      writeHead(code: number) { status = code; return res },
      end(chunk?: any) { if (chunk) body += String(chunk) },
      write(chunk: any) { body += String(chunk); return true },
    } as unknown as http.ServerResponse
    const handled = await tryHandleStorages({
      req: { method: 'GET', headers: {} } as unknown as http.IncomingMessage,
      res,
      path: '/api/storages/git-sync',
      method: 'GET',
      url: new URL('http://x/api/storages/git-sync'),
    })
    return { handled, status: status || (res as any).statusCode, json: body ? JSON.parse(body) : null }
  }

  it('FRISS TELEPITESEN is valaszol, es kimondja, hogy meg sose futott', async () => {
    // A worktree store-ja ures: se git-sync.json, se storages.json. Pontosan
    // ez az az allapot, amiben eddig egy csupasz `null` ment ki, es a felulet
    // nem tudta megkulonboztetni a "sose futott"-at a "nem latok oda"-tol.
    rmSync(STATE_FILE, { force: true })
    const r = await getGitSync()
    expect(r.handled).toBe(true)
    expect(r.json.ok).toBe(true)
    expect(r.json.last).toBeNull()
    expect(r.json.neverRan).toBe(true)
    expect(r.json.readError).toBe('')
    expect(Array.isArray(r.json.accounts)).toBe(true)
  })

  it('elromlott naplonal NEM mondja azt, hogy sose futott', async () => {
    writeFileSync(STATE_FILE, 'nem json', 'utf8')
    const r = await getGitSync()
    expect(r.json.neverRan).toBe(false)
    expect(r.json.readError).not.toBe('')
    expect(r.json.last).toBeNull()
  })

  it('ervenyes naplonal a futast adja vissza, a fiok-mezovel egyutt', async () => {
    writeFileSync(STATE_FILE, JSON.stringify({
      startedAt: '2026-09-11T02:30:00.000Z', finishedAt: '2026-09-11T02:32:00.000Z',
      durationSec: 120, updated: 1, skipped: 0, offline: 0, offlineSince: null, errors: 0,
      results: [{ rel: 'Cegek/X/GIT_REPOS/docs', account: 'valaki', state: 'updated', message: 'Frissitve: 1 uj commit jott le.' }],
    }), 'utf8')
    const r = await getGitSync()
    expect(r.json.neverRan).toBe(false)
    expect(r.json.last.results).toHaveLength(1)
    expect(r.json.last.results[0].account).toBe('valaki')
  })
})

describe('a lista fiokonkent csoportosit, es a figyelmet kero sor all elol', () => {
  const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8')

  // A renderer is TENYLEGESEN lefut: egy minimalis `document` stub adja a
  // befogado elemet, es a kapott HTML-t nezzuk meg.
  function render(results: any[]) {
    const host = { innerHTML: '' }
    const fn = new Function('t', 'escapeHtml', 'escapeAttr', 'document', `
      ${app.slice(app.indexOf('const GITREPOS_STATE_ORDER'), app.indexOf('function _gitreposStateLabel('))}
      ${extractFn(app, '_gitreposStateLabel')}
      ${extractFn(app, '_gitreposRepoName')}
      ${extractFn(app, '_gitreposRenderList')}
      return _gitreposRenderList`)(
      (k: string, p: any = {}) => `«${k}${p && p.n != null ? ':' + p.n : ''}»`,
      (v: string) => String(v ?? ''),
      (v: string) => String(v ?? ''),
      { getElementById: (id: string) => (id === 'gitreposList' ? host : null) },
    )
    fn({ last: { results } })
    return host.innerHTML
  }

  const R = (rel: string, account: string, state: string) => ({ rel, account, state, message: state })

  it('a repo neve a bekotott ut UTOLSO szakasza', () => {
    const html = render([R('Cegek/X/Fejlesztes/GIT_REPOS/freeberforum', 'X', 'current')])
    expect(html).toContain('freeberforum')
    expect(html).not.toContain('Cegek/X/Fejlesztes/GIT_REPOS/freeberforum<')
  })

  it('ket fiok -> ket kulon csoport', () => {
    const html = render([R('a/egy', 'alfa', 'current'), R('b/ketto', 'beta', 'current')])
    expect((html.match(/gitrepos-account-title/g) || []).length).toBe(2)
    expect(html.indexOf('alfa')).toBeLessThan(html.indexOf('beta'))
  })

  it('az ISMERETLEN fiok a vegere kerul, es meg is nevezi magat', () => {
    // Az ures fiok-nev "nem tudom", nem "nincs fiokja". Ha beleolvadna egy
    // valodi fiokba, azt allitanank rola, amit nem tudunk.
    const html = render([R('x/nevtelen', '', 'current'), R('a/egy', 'alfa', 'current')])
    expect(html.indexOf('alfa')).toBeLessThan(html.indexOf('gitrepos.unknown_account'))
    expect(html).toContain('gitrepos.unknown_account_note')
  })

  it('a figyelmet kero allapot all elol, a naprakesz hatul', () => {
    const html = render([
      R('a/naprakesz', 'alfa', 'current'),
      R('a/hibas', 'alfa', 'error'),
      R('a/kimaradt', 'alfa', 'skipped'),
    ])
    expect(html.indexOf('a/hibas'.split('/')[1])).toBeLessThan(html.indexOf('kimaradt'))
    expect(html.indexOf('kimaradt')).toBeLessThan(html.indexOf('naprakesz'))
  })

  it('minden sor a BEKOTOTT utat viszi at az Intezonek', () => {
    const html = render([R('Cegek/X/GIT_REPOS/docs', 'X', 'current')])
    expect(html).toContain('data-gitrepo-open="Cegek/X/GIT_REPOS/docs"')
  })

  it('ures eredmenynel nem hagy ott regi tartalmat', () => {
    expect(render([])).toBe('')
  })

  // Boss, 2026-09-11 (kepernyokep): minden naprakesz sor KETSZER irta ki
  // ("docs Naprakesz. Naprakesz.") -- a badge es a szerver-uzenet ugyanaz volt.
  it('a naprakesz sor NEM ismetli a szerver-uzenetet; a tobbi allapot igen', () => {
    const html = render([
      { rel: 'a/friss', account: 'a', state: 'current', message: 'NAPRAKESZ_UZENET' },
      { rel: 'a/valtozott', account: 'a', state: 'updated', message: 'FRISSULT_UZENET' },
      { rel: 'a/kimaradt', account: 'a', state: 'skipped', message: 'KIHAGYAS_OKA' },
    ])
    // current: a badge eleg, a felesleges uzenet nem jelenik meg
    expect(html).not.toContain('NAPRAKESZ_UZENET')
    // updated / skipped: az uzenet EXTRA infot ad, megjelenik
    expect(html).toContain('FRISSULT_UZENET')
    expect(html).toContain('KIHAGYAS_OKA')
  })
})
