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
    expect(hu).toMatch(/'overview\.upstream\.conflicts':\s*'[^']*fájl/)
    expect(hu).toMatch(/'overview\.upstream\.clean':\s*'[^']*fájl/)
    expect(en).toMatch(/'overview\.upstream\.conflicts':\s*'[^']*files/)
    expect(en).toMatch(/'overview\.upstream\.clean':\s*'[^']*files/)
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

  it('visszavont behuzas utan a commit-szamlalo nem mondhat naprakeszet', () => {
    // 2026-08-23: a `git revert -m 1` visszaadta a tartalmat, de a merge commit
    // ELOZMENY maradt -- a mero ezutan `behindCount: 1, cleanFileCount: 2`-t
    // irt, holott 681 fajl tartalma tert el. A commit-tavolsag onmagaban tehat
    // nem elegendo bizonyitek a naprakeszsegre.
    expect(code).toContain('contentDiffCount')
    // A dontes mert szamok osszevetese, nem tippelt kuszob.
    expect(code).toMatch(/contentDiff > trackedFiles/)
    expect(code).toContain('overview.upstream.diverged')
    for (const key of ['overview.upstream.diverged', 'overview.upstream.diverged_why']) {
      for (const lang of [hu, en]) expect(lang).toContain(`'${key}'`)
    }
    // Es a teteles lista gombja ilyenkor nem nyilhat meg: a commit-oldali
    // meresbol epul, tehat alabecsulne.
    const at = code.indexOf('contentDiff > trackedFiles')
    expect(code.slice(at, at + 900)).toMatch(/changesBtn\.hidden = true/)
  })

  it('a magyarazat tenyleg a harmadik szamhoz tapad, nem a dobozhoz', () => {
    // A tooltip csak akkor er valamit, ha azon a spanon ul, amin a gondolatjel
    // all. Ha a doboz szelere kerulne, a Boss sose talalna meg.
    expect(code).toMatch(/upstream-stat"\$\{cleanTitle\}.*\$\{clean\}/)
  })
})
