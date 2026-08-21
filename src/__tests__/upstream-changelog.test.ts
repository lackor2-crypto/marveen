// "Mi valtozott az upstreamben?" -- a tetelas lista tesztjei.
//
// Boss, 2026-08-19: "csak ezzel az a baj hogy ebbol nem latok semmit sem. azt
// kellene kiirnia hogy mit javitottak rajta!? [...] emberi nyelven. es hogy
// ezek kellenek e nekunk. [...] lesz biztos olyan amit nem akarok hogy
// bekeruljon. [...] javitasokat kulon dobozban."
//
// Amit ez a fajl oriz:
//   - EGYETLEN commit sem eshet ki a listabol (a fel nem ismert formatumu sem);
//   - a javitas es a fejlesztes kulon dobozba kerul;
//   - a modell valaszat sha szerint parositjuk, mert egy elcsuszott sorrendu
//     valasz csendben MAS commithoz irna a magyar szoveget -- pont az a fajta
//     hiba, ami sose derul ki;
//   - egy mar lefordított tetelert nem fizetunk ketszer;
//   - es ha a lista megfagy, azt az Attekintes onellenorzese kimondja.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  classifySubject, kindOfType, groupCommits, buildSummaryPrompt,
  parseSummaryResponse, mergeHungarian, missingSummaryCount,
  buildFileIndex, fileCounts,
  type UpstreamCommit,
} from '../upstream-changelog.js'
import { upstreamRows, UPSTREAM_CHANGES_FILE } from '../web/system-health.js'
import type { UpstreamSyncStatus } from '../web/upstream-sync-status-io.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')

function commit(over: Partial<UpstreamCommit> = {}): UpstreamCommit {
  return {
    sha: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-08-19',
    type: 'fix', scope: null, pr: null, title: 'valami', subject: 'fix: valami',
    files: ['src/a.ts'], touchesConflict: false, hu: null, ...over,
  }
}

describe('a commit targysorat helyesen szedjuk szet', () => {
  it('tipus, hatokor, PR-szam es cim', () => {
    const c = classifySubject('fix(vault): pin 0600 on credential MCP config writes (VAULTMODE818) (#1001)')
    expect(c.type).toBe('fix')
    expect(c.scope).toBe('vault')
    expect(c.pr).toBe(1001)
    expect(c.title).toBe('pin 0600 on credential MCP config writes (VAULTMODE818)')
    expect(c.kind).toBe('javitas')
  })

  it('a torо formatum (feat!) is fejlesztes marad', () => {
    expect(classifySubject('feat(router)!: uj utvonal (#985)').kind).toBe('fejlesztes')
  })

  it('a fel nem ismert forma sem esik ki -- csak "egyeb" lesz', () => {
    // Ez a lenyeg: egy szokatlan targysor miatt nem tunhet el egy valtozas a
    // listarol, kulonben pont az maradna ki, amirol a Boss donteni akar.
    const c = classifySubject('Merge pull request #12 from foo/bar')
    expect(c.type).toBe('egyeb')
    expect(c.title).toBe('Merge pull request #12 from foo/bar')
    expect(c.pr).toBeNull()
  })

  it('a PR-szam csak a sor VEGEROL szamit', () => {
    // "(#12)" a mondat kozepen nem PR-hivatkozas, hanem idezet.
    expect(classifySubject('fix: hivatkozas (#12) a szovegben, javitva (#99)').pr).toBe(99)
  })

  it('a HIANYZO tipus sem dol el -- "egyeb" lesz', () => {
    // Ez dontotte el az egesz listat: egy regebbi (vagy kezzel javitott)
    // store/upstream-changes.json commitjaban nincs `type` mezo, a
    // `type.toLowerCase()` dobott, a dobast a readUpstreamChanges catch-e
    // elnyelte -- es EGY hianyos commit miatt MIND eltunt a feluletrol.
    expect(kindOfType(undefined)).toBe('egyeb')
    expect(kindOfType(null)).toBe('egyeb')
    expect(kindOfType(42 as unknown as string)).toBe('egyeb')
    const be = [
      commit({ sha: '1'.repeat(40), type: 'fix' }),
      { ...commit({ sha: '2'.repeat(40) }), type: undefined as unknown as string },
    ]
    const g = groupCommits(be)
    expect(g.javitas.length + g.fejlesztes.length + g.egyeb.length).toBe(2)
    expect(g.egyeb).toHaveLength(1)
  })

  it('a revert javitas, a chore/docs/test nem', () => {
    expect(kindOfType('revert')).toBe('javitas')
    expect(kindOfType('hotfix')).toBe('javitas')
    expect(kindOfType('feature')).toBe('fejlesztes')
    for (const t of ['chore', 'docs', 'test', 'refactor', 'ci', 'perf', 'build']) {
      expect(kindOfType(t), t).toBe('egyeb')
    }
  })
})

describe('a csoportositas egyetlen tetelt sem veszit el', () => {
  const be = [
    commit({ sha: '1'.repeat(40), type: 'fix', date: '2026-08-01' }),
    commit({ sha: '2'.repeat(40), type: 'feat', date: '2026-08-05' }),
    commit({ sha: '3'.repeat(40), type: 'docs', date: '2026-08-03' }),
    commit({ sha: '4'.repeat(40), type: 'egyeb', date: '2026-08-09' }),
    commit({ sha: '5'.repeat(40), type: 'fix', date: '2026-08-11' }),
  ]

  it('a harom doboz osszege = a bemenet', () => {
    const g = groupCommits(be)
    expect(g.javitas.length + g.fejlesztes.length + g.egyeb.length).toBe(be.length)
    expect(g.javitas).toHaveLength(2)
    expect(g.fejlesztes).toHaveLength(1)
    expect(g.egyeb).toHaveLength(2)
  })

  it('dobozon belul a legfrissebb all elol', () => {
    expect(groupCommits(be).javitas.map(c => c.date)).toEqual(['2026-08-11', '2026-08-01'])
  })
})

describe('a modell valasza sha szerint parosodik', () => {
  const shas = ['1'.repeat(40), '2'.repeat(40)]

  it('a jo valaszt beolvassa, kodkerites ide vagy oda', () => {
    const raw = '```json\n[{"sha":"' + shas[0] + '","hu":"Elso"},{"sha":"' + shas[1] + '","hu":"Masodik"}]\n```'
    expect(parseSummaryResponse(raw, shas)).toEqual({ [shas[0]]: 'Elso', [shas[1]]: 'Masodik' })
  })

  it('IDEGEN sha-t nem fogad el', () => {
    // Ha a modell kitalal egy azonositot, a szoveg nem kerulhet senkihez.
    const raw = '[{"sha":"' + 'f'.repeat(40) + '","hu":"Nem ide valo"}]'
    expect(parseSummaryResponse(raw, shas)).toEqual({})
  })

  it('romlott valaszra ures eredmenyt ad, nem dol el', () => {
    expect(parseSummaryResponse('bocsanat, nem sikerult', shas)).toEqual({})
    expect(parseSummaryResponse('[{"sha": "csonka"', shas)).toEqual({})
    expect(parseSummaryResponse('', shas)).toEqual({})
  })

  it('a tul hosszu szoveget levagja', () => {
    const raw = JSON.stringify([{ sha: shas[0], hu: 'x'.repeat(900) }])
    expect(parseSummaryResponse(raw, shas)[shas[0]]).toHaveLength(400)
  })

  it('a feladatban minden ker sha ott van, es magyar valaszt ker', () => {
    const p = buildSummaryPrompt([{ sha: shas[0], subject: 's', body: 'b', files: ['a.ts'] }])
    expect(p).toContain(shas[0])
    expect(p.toLowerCase()).toContain('magyar')
    expect(p).toContain('"sha"')
  })
})

describe('egy tetelt nem forditunk le ketszer', () => {
  it('a korabbi magyar szoveg sha szerint atkerul', () => {
    const regi = [commit({ sha: '1'.repeat(40), hu: 'Mar keszen volt' })]
    const uj = [commit({ sha: '1'.repeat(40) }), commit({ sha: '2'.repeat(40) })]
    const out = mergeHungarian(uj, regi)
    expect(out[0].hu).toBe('Mar keszen volt')
    expect(out[1].hu).toBeNull()
    expect(missingSummaryCount(out)).toBe(1)
  })

  it('ami kiesett az upstreambol, az a listabol is kiesik', () => {
    // A lista a MOSTANI eltereest mutatja, nem gyujtemeny: egy visszavont ag
    // tetelei nem allhatnak ott dontesre varva.
    const regi = [commit({ sha: '9'.repeat(40), hu: 'Regi tetel' })]
    const out = mergeHungarian([commit({ sha: '1'.repeat(40) })], regi)
    expect(out).toHaveLength(1)
    expect(out[0].sha).toBe('1'.repeat(40))
  })
})

describe('a felulet doboznkent mutatja, es kimondja az egyseget', () => {
  it('harom doboz van, a javitas kulon', () => {
    expect(app).toContain("['javitas', 'upstream.changes.fixes'")
    expect(app).toContain("['fejlesztes', 'upstream.changes.feats'")
    expect(app).toContain("['egyeb', 'upstream.changes.other'")
  })

  it('a bevezeto kimondja, hogy a lista egysege a valtozas, nem a fajl', () => {
    expect(hu).toMatch(/'upstream\.changes\.intro':[^\n]*commit/)
    expect(en).toMatch(/'upstream\.changes\.intro':[^\n]*commit/)
  })

  it('minden uj szoveg megvan mindket nyelven', () => {
    for (const k of ['title', 'open', 'intro', 'fixes', 'feats', 'other', 'files',
                     'conflict', 'nohu', 'none', 'nomatch', 'loading']) {
      expect(hu, `hu: upstream.changes.${k}`).toContain(`'upstream.changes.${k}'`)
      expect(en, `en: upstream.changes.${k}`).toContain(`'upstream.changes.${k}'`)
    }
  })

  it('az utkozo fajlt erinto tetel meg van jelolve', () => {
    // Ezeket nem lehet csak ugy athuzni -- ha nem latszik, a Boss olyat
    // valasztana ki, ami utana kezi munkat jelent.
    expect(app).toContain('upstream-change-conflict')
    expect(app).toContain('c.touchesConflict')
  })

  it('az eredeti angol targysor is latszik (a forditas ellenorizheto)', () => {
    expect(app).toContain('upstream-change-en')
    expect(app).toContain('escapeHtml(c.subject)')
  })
})

describe('ha a lista megfagy, az onellenorzes szol', () => {
  const MOST = Date.parse('2026-08-19T12:00:00Z')
  const nap = 86_400_000
  const friss: UpstreamSyncStatus = {
    checkedAt: new Date(MOST - nap).toISOString(),
    aheadCount: 241, behindCount: 112, conflictingFiles: [], conflictCount: 22,
    cleanFileCount: 169, localRef: 'main', upstreamRef: 'upstream/develop',
    fetchOk: true, ageDays: 1,
  }

  it('friss szamok + friss lista = nincs panasz', () => {
    const ids = upstreamRows(MOST, friss, true, MOST - nap).map(r => r.id)
    expect(ids).toContain('upstream_ok')
    expect(ids.some(i => i.startsWith('upstream_changes'))).toBe(false)
  })

  it('friss szamok mellett is szol, ha a LISTA regi', () => {
    // Ez a fajta hiba a legalattomosabb: a kartya frissnek latszik, es kozben
    // regi tetelekbol dontenenk.
    const rows = upstreamRows(MOST, friss, true, MOST - 40 * nap)
    const r = rows.find(x => x.id === 'upstream_changes_stale')
    expect(r, 'a megfagyott listara nem szol').toBeTruthy()
    expect(Number(r!.params!.d)).toBe(40)
  })

  it('hianyzo listara is szol', () => {
    expect(upstreamRows(MOST, friss, true, null).map(r => r.id)).toContain('upstream_changes_missing')
  })

  it('a ket uj allapotnak van magyar es angol szovege', () => {
    for (const id of ['upstream_changes_missing', 'upstream_changes_stale']) {
      expect(hu).toContain(`'health.${id}'`)
      expect(hu).toContain(`'health.${id}_action'`)
      expect(en).toContain(`'health.${id}'`)
      expect(en).toContain(`'health.${id}_action'`)
    }
  })

  it('a lista utvonala egy helyen van leirva', () => {
    expect(UPSTREAM_CHANGES_FILE).toBe('store/upstream-changes.json')
    const io = readFileSync(join(ROOT, 'src', 'web', 'upstream-changes-io.ts'), 'utf8')
    expect(io).toContain("join(PROJECT_ROOT, 'store', 'upstream-changes.json')")
    const gen = readFileSync(join(ROOT, 'scripts', 'upstream-changelog.ts'), 'utf8')
    expect(gen).toContain("join(ROOT, 'store', 'upstream-changes.json')")
  })
})

// Boss, 2026-08-20: "hol vanak leirva mind a 169 tetel hogy azok mik?"
//
// A valtozas-lista egysege a commit, de a kerdes a fajlok felol jon. Ez a
// blokk azt orzi, hogy a fajl-nezet SOSE mondhasson mast, mint a kartya:
// ugyanaz a 191 = 22 + 169, es egyetlen elteres fajl sem eshet ki belole.
describe('fajl-nezet: melyik fajl valtozott es mi tortent benne', () => {
  const c1 = commit({ sha: 's1', files: ['src/a.ts', 'web/style.css'], hu: 'Javult az A.' })
  const c2 = commit({ sha: 's2', files: ['src/a.ts'], hu: 'Meg egy javitas az A-ban.' })
  const diff = ['src/a.ts', 'web/style.css', 'package.json']

  it('MINDEN elteres fajl bekerul, pontosan egyszer', () => {
    const files = buildFileIndex(diff, ['web/style.css'], [c1, c2])
    expect(files.map(f => f.path).sort()).toEqual([...diff].sort())
    expect(new Set(files.map(f => f.path)).size).toBe(files.length)
  })

  it('a szamok kiadjak a kartya szamait: osszes = utkozo + tiszta', () => {
    const files = buildFileIndex(diff, ['web/style.css'], [c1, c2])
    const fc = fileCounts(files)
    expect(fc.total).toBe(3)
    expect(fc.conflict).toBe(1)
    expect(fc.clean).toBe(2)
    expect(fc.conflict + fc.clean).toBe(fc.total)
  })

  it('a fajlhoz a ot erinto commitok tartoznak', () => {
    const files = buildFileIndex(diff, [], [c1, c2])
    const a = files.find(f => f.path === 'src/a.ts')!
    expect(a.shas).toEqual(['s1', 's2'])
  })

  it('a csak osszefesuleskor valtozott fajl is ott van, ures listaval', () => {
    // A merge commitok nem sorolnak fel fajlokat: a package.json egyetlen
    // commit fajl-listajaban sem szerepel. Ha a nezet a commitok uniojabol
    // keszulne, ez a fajl NYOMTALANUL eltunne -- es a szam sem stimmelne.
    const files = buildFileIndex(diff, [], [c1, c2])
    const pkg = files.find(f => f.path === 'package.json')
    expect(pkg, 'a csak merge-ben valtozott fajl nem eshet ki').toBeTruthy()
    expect(pkg!.shas).toEqual([])
  })

  it('a lista a MERT elterest koveti, nem a commitok uniojat', () => {
    // Egy commit erinthet olyan fajlt, ami a vegso diffben mar nem szerepel
    // (kesobb visszaallt). Az ilyen nem kerulhet a listaba, kulonben tobbet
    // mutatnank, mint amennyi tenylegesen elter.
    const extra = commit({ sha: 's3', files: ['torolt.txt'] })
    const files = buildFileIndex(diff, [], [c1, c2, extra])
    expect(files.map(f => f.path)).not.toContain('torolt.txt')
    expect(files).toHaveLength(3)
  })

  it('elol az utkozok, azon belul abecében', () => {
    const files = buildFileIndex(['z.ts', 'a.ts', 'm.ts'], ['m.ts', 'z.ts'], [])
    expect(files.map(f => f.path)).toEqual(['m.ts', 'z.ts', 'a.ts'])
  })

  it('a duplan erkezo fajlnev egyszer szerepel', () => {
    const files = buildFileIndex(['src/a.ts', 'src/a.ts'], [], [c1])
    expect(files).toHaveLength(1)
  })

  it('a felulet a fajl-nezetet a fajl-listabol rajzolja, nem a commitokbol', () => {
    expect(app).toContain('function renderUpstreamFiles')
    expect(app).toContain("upstreamChangesView === 'fajl'")
    // A "csak merge-ben valtozott" eset ki van irva, nem elhallgatva.
    expect(app).toContain('upstream.files.merge_only')
  })

  it('a fajl-sor sajat jelvenyt ir, nem a commit-nezetet (mert onmagara mutatna)', () => {
    const kezdet = app.indexOf('function upstreamFileRow')
    expect(kezdet, 'nincs meg a fajl-sor rajzoloja').toBeGreaterThan(-1)
    const torzs = app.slice(kezdet, app.indexOf('function renderUpstreamFiles'))
    expect(torzs).toContain('upstream.files.conflict_badge')
    // Ez volt a hiba: a kozos kulcstol '.gitignore utkozo fajlt erint' lett.
    expect(torzs).not.toContain('upstream.changes.conflict')
  })

  it('a ket ful szamot is mutat, mert pont a szamok keveredtek ossze', () => {
    expect(app).toContain('upstream.view.changes')
    expect(app).toContain('upstream.view.files')
    expect(app).toContain('function labelUpstreamViewTabs')
  })

  it('a fajl-nezet minden szovege megvan magyarul es angolul', () => {
    for (const k of ['upstream.view.changes', 'upstream.view.files', 'upstream.files.intro',
                     'upstream.files.conflicting', 'upstream.files.clean', 'upstream.files.more',
                     'upstream.files.merge_only', 'upstream.files.pending', 'upstream.files.conflict_badge']) {
      expect(hu, `hianyzik magyarul: ${k}`).toContain(`'${k}'`)
      expect(en, `hianyzik angolul: ${k}`).toContain(`'${k}'`)
    }
  })

  it('a gyarto szkript a diffbol veszi a fajlokat, es kiirja oket', () => {
    const gen = readFileSync(join(ROOT, 'scripts', 'upstream-changelog.ts'), 'utf8')
    expect(gen).toContain("git(['diff', '--name-only', base, upstream])")
    expect(gen).toContain('buildFileIndex(diffFiles')
    expect(gen).toContain('files,')
  })
})

// Boss, 2026-08-20: "A mi valtozott tetel lista gomb nem mukodik."
//
// A gomb jo volt: valodi bongeszoben a lista megnyilt, 112 tetellel. A nyitva
// hagyott lapja futtatta a TEGNAPI app.js-t -- a friss index.html-bol megkapta
// az UJ gombot, a hozza tartozo kodot nem. Nem hibauzenet volt, hanem CSEND.
// Ez a blokk azt orzi, hogy ez ne fordulhasson elo megint eszrevetlenul.
describe('a lap eszreveszi, ha kozben uj valtozat kerult ki', () => {
  const stat = readFileSync(join(ROOT, 'src', 'web', 'routes', 'static.ts'), 'utf8')

  it('a verzio-belyeg mind a negy kiszolgalt eszkozt tartalmazza', () => {
    expect(stat).toContain('export function appShellVersion')
    for (const f of ["'app.js'", "'style.css'", "'lang/hu.js'", "'lang/en.js'"]) {
      expect(stat.slice(stat.indexOf('appShellVersion'))).toContain(f)
    }
  })

  it('a vegpont nem gyorsitotarazhato -- kulonben sose venne eszre semmit', () => {
    const i = stat.indexOf("'/api/app-version'")
    expect(i).toBeGreaterThan(-1)
    expect(stat.slice(i, i + 400)).toContain("'Cache-Control': 'no-store'")
  })

  it('az app.js cimkeje kulon is kimegy, hogy a betoltes pillanatahoz merjen', () => {
    const i = stat.indexOf("'/api/app-version'")
    expect(stat.slice(i, i + 600)).toContain("app: assetVersion(webDir, 'app.js')")
  })

  it('a kliens a sajat script-tagjabol olvassa, mivel indult', () => {
    expect(app).toContain('function loadedAppVersion')
    expect(app).toContain("document.querySelector('script[src*=\"/app.js\"]')")
  })

  it('MAGATOL tolt ujra -- csik es kattintas nelkul', () => {
    // Boss, 2026-08-21: "ez ne jelenjen meg tobbet! ha kell toltse ujra de
    // automatikusan". A fekete csik egy felesleges kattintas volt.
    const i = app.indexOf('function showAppUpdateNotice')
    const blokk = app.slice(i, i + 700)
    expect(blokk).toContain('hardRefresh()')
    expect(blokk).not.toContain('appUpdatedBar')
    expect(app).not.toContain('appUpdatedBar')
  })

  it('de a felig begepelt szoveget nem tapossa le', () => {
    // Ha a kurzor mezoben all, vagy nyitva egy ablak, VAR es ujraprobal.
    const i = app.indexOf('function reloadWouldInterrupt')
    expect(i).toBeGreaterThan(0)
    const blokk = app.slice(i, i + 600)
    expect(blokk).toContain('textarea')
    expect(blokk).toContain('isContentEditable')
    expect(blokk).toContain('modal-overlay')
    const go = app.slice(app.indexOf('function showAppUpdateNotice'), app.indexOf('async function checkAppVersion'))
    expect(go).toContain('reloadWouldInterrupt()')
    expect(go).toContain('setTimeout')
  })

  it('rejtett lapon nem kerdez', () => {
    const ell = app.slice(app.indexOf('async function checkAppVersion'), app.indexOf('const themeToggle'))
    expect(ell).toContain('if (document.hidden) return')
  })

  it('a csik szovegei eltuntek a szotarakbol is', () => {
    // Nem hagyunk arva kulcsot: ami nincs a kepernyon, az ne is alljon a
    // szotarban -- kulonben a kovetkezo olvaso azt hiszi, van meg ilyen csik.
    for (const k of ['app.updated.text', 'app.updated.btn']) {
      expect(hu).not.toContain(`'${k}'`)
      expect(en).not.toContain(`'${k}'`)
    }
  })
})
