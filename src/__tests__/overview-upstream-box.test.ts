// Az Attekinto upstream-doboza (kanban 37489d5e / #66) HAROM szamot igert:
// hany uj fejlesztes van az upstreamben, ezekbol hany utkozik, es hany huzhato
// at tisztan. Az elso ketto mert ertek. A harmadik nem volt az.
//
// Merve 2026-08-16, a valodi store/upstream-sync-status.json-bol:
//   behindCount = 63   (COMMIT)
//   conflictCount = 4  (FAJL)
//   cleanFileCount = null
// es a felulet `behind - conflicts`-et szamolt: 63 commitbol kivont 4 fajlt, es
// az igy kapott 59-et "konfliktusmentesen athuzhato" nevvel mutatta a Bossnak.
// Ket kulonbozo mertekegyseg kulonbsege nem szam, hanem talalgatas -- es a
// felulet tenykent allitotta.
//
// A kartya munkaja teszt nelkul kerult a varakozo oszlopba: ez a fajl potolja.
// A rogzitett szabaly: a harmadik szam vagy MERT (cleanFileCount), vagy nincs.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const app = readFileSync(join(WEB, 'app.js'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

/**
 * A doboz rajzolo fuggvenye, kapcsos-zarojel szerint kivagva.
 *
 * A `code` valtozat a magyarazo sorok nelkul all elo. A javitas ugyanis a sajat
 * kommentjeben IDEZI a regi `behind - conflicts` keplet -- ha a tiltast a nyers
 * szovegre engednem ra, a teszt a magyarazatot buktatna meg a hiba helyett, es
 * a helyes megoldas ugy nezne ki, mintha nem irhatna le, mit javitott.
 */
function stripComments(src: string): string {
  return src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n')
}

function renderer(): string {
  const start = app.indexOf('function renderOverviewUpstreamSync')
  expect(start, 'renderOverviewUpstreamSync nincs a web/app.js-ben').toBeGreaterThan(-1)
  let depth = 0
  for (let i = app.indexOf('{', start); i < app.length; i++) {
    if (app[i] === '{') depth++
    else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1)
  }
  throw new Error('parositatlan kapcsos zarojel a renderOverviewUpstreamSync utan')
}

describe('Attekinto: upstream-szinkron doboz', () => {
  const fn = renderer()
  const code = stripComments(fn)

  it('a tisztan athuzhato szamot NEM szamolja ki commit minusz fajl modon', () => {
    // Pontosan ez volt a hiba. Barmilyen alaku `behind - conflict` kivonas
    // ugyanazt a hamis szamot allitja elo, ezert a mintat magat tiltjuk.
    expect(code).not.toMatch(/behind\s*-\s*conflicts/)
    expect(code).not.toMatch(/behindCount\s*-\s*conflict/)
    // A `Math.max(0, ...)` a regi keplet bura volt: elrejtette, hogy a kivonas
    // ertelmetlen, mert a negativ eredmenyt nullara vagta.
    expect(code).not.toMatch(/Math\.max\(0,\s*behind/)
  })

  it('a harmadik szam a MERT mezobol jon', () => {
    // Nem a kommentbol, hanem a tenylegesen futo sorbol.
    expect(code).toContain('upstreamSync.cleanFileCount')
  })

  it('ha nincs meres, gondolatjel all ott, nem nulla es nem talalgatas', () => {
    // A nulla a legrosszabb helyettesites: azt allitana, hogy SEMMI sem
    // huzhato at tisztan -- ez hatarozott, es hatarozottan hamis.
    expect(code).toMatch(/'–'|"–"/)
    // A `?? 0` ugyanezt a hazugsagot csempeszne vissza a mert mezore.
    expect(code).not.toMatch(/cleanFileCount\s*\?\?\s*0/)
  })

  it('az ismeretlen allapotnak van emberi magyarazata, mindket nyelven', () => {
    expect(code).toContain('overview.upstream.clean_unmeasured')
    for (const lang of [hu, en]) {
      expect(lang).toContain('overview.upstream.clean_unmeasured')
    }
  })

  it('a cimkek kiirjak a mertekegyseget (commit vs fajl)', () => {
    // Enelkul harom egyforma szamnak latszik, es a Boss maga vonna ki oket
    // egymasbol -- ugyanabba a hibaba futva, amit a kod most mar nem kovet el.
    // #379 ota a ket kulso szam cimkeje a Boss sajat szava ("utkozes nelkul
    // athuzhato: N", "utkozo: N"); a mertekegyseget a kozvetlenul alattuk allo
    // commit-sor mondja ki, a fajl-szavval.
    for (const lang of [hu, en]) {
      expect(lang).toContain("'overview.upstream.out_clean'")
      expect(lang).toContain("'overview.upstream.out_conflicts'")
    }
    expect(hu).toMatch(/'overview\.upstream\.commits':\s*'[^']*fájl/)
    expect(en).toMatch(/'overview\.upstream\.commits':\s*'[^']*file/)
    expect(code).toContain("t('overview.upstream.commits', { c: behind })")
  })

  it('nincs doboz, ha egyaltalan nincs meres', () => {
    expect(code).toMatch(/box\.hidden = true/)
  })

  // ★ A NULLA KET DOLGOT JELENTHET. 2026-08-23-an a doboz csupa nullat mutatott
  //    ("0 fajl / 0 utkozes / 0 commit"), es a Boss joggal kerdezte, hogy "ures!
  //    hogy lehet ez??" -- a meres valojaban HELYES volt (a merge behuzta az
  //    egeszet), de a doboz ugyanugy nezett ki, mintha el sem ert volna az
  //    upstreamig. Ez a harom teszt tartja szet a ket nullat.
  it('a nulla behind KIMONDJA, hogy naprakeszek vagyunk -- nem nullakat sorol', () => {
    expect(code).toMatch(/if \(behind === 0\)/)
    expect(code).toContain('overview.upstream.uptodate')
    for (const lang of [hu, en]) expect(lang).toContain("'overview.upstream.uptodate'")
  })

  it('halozat nelkul NEM allitunk naprakeszseget', () => {
    // fetchOk === false mellett a nulla csak az utoljara letoltott allapotra
    // igaz. Ha ezt osszemosnank, a doboz pont akkor nyugtatna meg a Bosst,
    // amikor a legkevesbe kellene.
    expect(code).toContain('overview.upstream.uptodate_stale')
    for (const lang of [hu, en]) expect(lang).toContain("'overview.upstream.uptodate_stale'")
  })

  it('elhasalt meresnel az OK latszik, es nem talalgatjuk', () => {
    // A mero szkript sajat hibakodja utazik ki (`error`), es a doboz azt
    // forditja emberi mondatra. Ismeretlen kodra a nyers kod megy ki -- kitalalt
    // ok rosszabb a semminel.
    expect(code).toMatch(/upstreamSync\.error/)
    expect(code).toContain('overview.upstream.failed')
    for (const key of ['fetch-failed', 'no-upstream-remote', 'no-upstream-branch', 'no-local-branch']) {
      for (const lang of [hu, en]) expect(lang).toContain(`'overview.upstream.err.${key}'`)
    }
  })

  it('visszavont behuzas utan a behuzas ELOTTI allapotbol merunk', () => {
    // 2026-08-23: a `git revert -m 1` visszaadta a tartalmat, de a behuzo merge
    // ELOZMENY maradt -- a git szerint azt a 137 commitot mar behuztuk, ezert a
    // doboz 1 commit / 2 fajlt mutatott, holott az upstream tartalmabol semmi
    // nem volt nalunk. A mero azota a behuzas elotti pontbol nez (COMPARE_FROM),
    // es a felulet kimondja, miert.
    const sh = readFileSync(join(__dirname, '..', '..', 'scripts', 'upstream-divergence-check.sh'), 'utf8')
    expect(sh).toContain('COMPARE_FROM')
    // A visszalepes csak VALODI merge-re szolhat, es csak ha az upstreambol jott
    // -- kulonben egy egyszeru revert is elmozditana a viszonyitasi pontot.
    expect(sh).toContain('This reverts commit')
    expect(sh).toContain('merge-base --is-ancestor')
    // A commit-lista ugyanabbol a pontbol keszul, kulonben a kartya es a
    // teteles lista mashogy szamolna ugyanazt.
    // 2026-09-18 ota a pont egy kozos modulbol jon (src/upstream-refs.ts), amit
    // az elv-kapu is hasznal: a lista es a kapu ugyanazokat a commitokat nezi.
    const cl = readFileSync(join(__dirname, '..', '..', 'scripts', 'upstream-changelog.ts'), 'utf8')
    expect(cl).toContain('upstreamBase(git, local, upstream)')
    const refs = readFileSync(join(__dirname, '..', 'upstream-refs.ts'), 'utf8')
    expect(refs).toContain('This reverts commit')
    expect(refs).toContain("'merge-base', '--is-ancestor'")
    // Es a doboz nem hagyhatja magyarazat nelkul, hogy a szam 1-rol 137-re ugrott.
    expect(code).toContain('upstreamSync.revertedMerge')
    expect(code).toContain('overview.upstream.reverted')
    for (const lang of [hu, en]) expect(lang).toContain("'overview.upstream.reverted'")
  })

  it('az utkozo fajlok NEVE nem a dobozban all', () => {
    // Harmincnegy sornyi utvonal elnyomta a harom szamot, ami miatt a doboz
    // letezik (Boss, 2026-08-23: "csak nem akarom latni ezt a sok felsorolast
    // itt"). A nevek helye a "Mi valtozott?" teteles lista fajl-nezete.
    expect(code).not.toContain('upstream-conflict-files')
    // De a szam nem maradhat kapaszkodo nelkul: a badge megmondja, hol
    // lathatoak a nevek -- kulonben a 34-bol nem vezet ut sehova.
    expect(code).toContain('overview.upstream.conflicts_where')
    for (const lang of [hu, en]) expect(lang).toContain("'overview.upstream.conflicts_where'")
    // Es a fajl-nezet tenyleg letezik, kulonben ures igeret a tooltip.
    expect(app).toContain('function renderUpstreamFiles')
  })

  it('a magyarazat tenyleg a harmadik szamhoz tapad, nem a dobozhoz', () => {
    // A tooltip csak akkor er valamit, ha azon a spanon ul, amin a gondolatjel
    // all. Ha a doboz szelere kerulne, a Boss sose talalna meg.
    expect(code).toMatch(/upstream-stat"\$\{cleanTitle\}.*\$\{clean\}/)
  })
})

// Harmadik gomb (Boss, 2026-09-18, B valtozat): a kizart ES a dontesre varo
// tetelek egy helyen. Az indok itt LATHATO szoveg, nem jelveny-sugo -- a
// felhasznalo nem fog egerrel vadaszni ra.
describe('upstream elv-kapu gomb es nezet', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8')
  const start = app.indexOf('function renderUpstreamGate(')
  const view = app.slice(start, app.indexOf('\nfunction ', start + 1))

  it('EGY gomb nyitja a listat; a kapu-nezet a harmadik ful, nem kulon gomb', () => {
    // Boss, 2026-09-24: a kulon "Kizart es dontesre varo" gomb ugyanazt a
    // haromfules ablakot nyitotta, mint a tetelesen lista gombja.
    expect(html).not.toContain('overviewUpstreamGateBtn')
    expect(app).not.toContain('openUpstreamGate')
    expect(html).toContain('id="upstreamViewGate"')
    expect(html.match(/<button[^>]*upstream-changes-btn/g) || []).toHaveLength(1)
  })

  it('mindket csoportot mutatja, az indokkal lathatoan', () => {
    expect(view).toContain("'exclude'")
    expect(view).toContain("'discuss'")
    expect(view).toContain('upstream-gate-why')
  })

  it('a harom ures allapot kulon mondat: nem futott / nem sikerult / tenyleg nincs', () => {
    expect(view).toMatch(/if \(!run \|\| !run\.ok\)/)
    expect(view).toContain('upstream.gate.none')
    for (const k of ['upstream.changes.open', 'upstream.gate.group_exclude', 'upstream.gate.group_discuss',
      'upstream.gate.none', 'upstream.gate.where', 'upstream.gate.summary_view', 'upstream.view.gate', 'upstream.view.gate_unknown']) {
      for (const lang of [hu, en]) expect(lang).toContain(`'${k}'`)
    }
  })
})

// Az "Ujrameres" a tetelesen listat is frissiti -- kulonben a kapu-nezet a
// feluletrol soha nem kap friss dontest (friss telepitesen egyaltalan nem).
describe('ujrameres frissiti a tetelesen listat', () => {
  const sh = readFileSync(join(__dirname, '..', '..', 'scripts', 'upstream-divergence-check.sh'), 'utf8')

  it('a mero szkript a meres utan ujrairja a listat, fordito API-hivas nelkul', () => {
    expect(sh).toMatch(/upstream-changelog\.ts" --no-llm/)
    // a lista hibaja kimondott, nem nema
    expect(sh).toContain('a tetelesen lista NEM frissult')
  })

  it('a felulet a meres vegen eldobja a memoriaban tartott regi listat', () => {
    expect(app).toMatch(/_upstreamMeasureButtonBusy\(false\)\n\s*\/\/[^\n]*\n[^\n]*\n\s*upstreamChangesCache = null/)
  })
})

// Boss, 2026-09-18 (kepernyokep): "nincs egy sorban a gombok". A gombonkenti
// margin-top miatt az uj gomb (amin nem volt) kilogott a sorbol.
describe('az upstream gombok egy magassagban', () => {
  const css = readFileSync(join(WEB, 'style.css'), 'utf8')
  it('a gombok kozos szabalyt kapnak, gombonkenti felso margo nelkul', () => {
    expect(css).toMatch(/\.upstream-changes-btn,\s*\.upstream-measure-btn \{[^}]*margin: 0/)
    expect(css).not.toMatch(/\.upstream-(?:changes|gate|measure)-btn \{[^}]*margin-top/)
  })
})

// #379 (Boss): a "osszes erintett", a "mar behuzva" es a "szandekosan kihagyva"
// a Reszletek ablak KET UJ FULERE kerult; a kihagyottnal fajlonkent az ok.
describe('Reszletek ablak: Mar behuzva / Szandekosan kihagyva ful (#379)', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8')
  const fnBody = (name: string): string => {
    const start = app.indexOf(`function ${name}(`)
    expect(start, `${name} nincs a web/app.js-ben`).toBeGreaterThan(-1)
    return app.slice(start, app.indexOf('\nfunction ', start + 1))
  }

  it('a ket ful ott van az ablakban, es kattinthato', () => {
    expect(html).toContain('id="upstreamViewAbsorbed"')
    expect(html).toContain('id="upstreamViewSkipped"')
    expect(app).toContain("setUpstreamChangesView('behuzva')")
    expect(app).toContain("setUpstreamChangesView('kihagyva')")
  })

  it('kint mar nincs osszeg, behuzott es kihagyott szam', () => {
    const row = app.slice(app.indexOf('<div class="upstream-sync-row">'))
    const eleje = row.slice(0, row.indexOf('</div>'))
    for (const gone of ['${total}', 'absorbedNum', 'skippedNum']) expect(eleje).not.toContain(gone)
  })

  it('a kihagyott fajlnal latszik az ok es a fajta (halasztott / vegleges)', () => {
    const v = fnBody('renderUpstreamSkipped')
    expect(v).toContain("'deferred'")
    expect(v).toContain("'decided'")
    expect(v).toContain('f.reason')
  })

  it('friss telepites: ures lista nyugodt mondat; nem mert lista kulon mondat', () => {
    for (const name of ['renderUpstreamSkipped', 'renderUpstreamAbsorbed']) {
      expect(fnBody(name)).toContain('upstream.split.unmeasured')
    }
    expect(fnBody('renderUpstreamSkipped')).toContain('upstream.skipped.none')
    expect(fnBody('renderUpstreamAbsorbed')).toContain('upstream.absorbed.none')
    expect(hu).toMatch(/'upstream\.skipped\.none':\s*'Nincs szándékosan kihagyott fájl/)
    for (const k of ['upstream.view.absorbed', 'upstream.view.skipped', 'upstream.view.absorbed_unknown',
      'upstream.view.skipped_unknown', 'upstream.split.unmeasured', 'upstream.absorbed.intro', 'upstream.absorbed.none',
      'upstream.skipped.intro', 'upstream.skipped.none', 'upstream.skipped.no_reason',
      'upstream.skipped.group_deferred', 'upstream.skipped.group_decided']) {
      for (const lang of [hu, en]) expect(lang).toContain(`'${k}'`)
    }
  })

  it('a ket ful a teteles lista nelkul is megnyilik (a meresbol el, nem a listabol)', () => {
    const r = fnBody('renderUpstreamChanges')
    expect(r.indexOf("'kihagyva'")).toBeLessThan(r.indexOf('!data.available'))
    const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'overview.ts'), 'utf8')
    expect(route).toContain('{ available: false, split }')
  })
})
