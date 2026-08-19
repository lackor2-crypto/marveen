// Az upstream-doboz szamai MERT ertekek-e, es latszik-e rajtuk, hogy regiek.
//
// Elozmeny (2026-08-19, a Boss szurta ki): a doboz azt allitotta, hogy
// "63 uj fejlesztes az upstreamben / 4 utkozo fajl / 110 tisztan athuzhato
// fajl". A store/upstream-sync-status.json-t megnyitva kiderult, hogy azt a
// fajlt SENKI nem irta: nem volt hozza sem script, sem utemezett feladat (a
// scheduled_tasks tabla ures volt ra), a `lastRunType` "manual" allt benne, es
// a datum 2026-08-10-en megfagyott.
//
// Gitbol visszameres az AKKORI allapotra:
//     behindCount    63    <- helyes
//     conflictCount   4    <- helyes, es a negy fajlnev is pontosan stimmelt
//     cleanFileCount 110   <- a valos ertek 108; semmilyen szamolassal nem jon ki
//     aheadCount      95   <- a valos ertek 87; egyetlen helyi agra sem igaz
//
// Vagyis a kartya ket kitalalt szamot mutatott tenykent, es kilenc nap alatt a
// valosag is elment mellole (a 63-bol 111 lett). Ez a fajl azt orzi, hogy
// (1) a szamokat egy script meri, nem ember gepeli be, es (2) a felulet
// megmondja, mihez kepest es mikor mertuk.

import { describe, it, expect } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ageInDays, STALE_AFTER_DAYS, readUpstreamSyncStatus } from '../web/upstream-sync-status-io.js'
import { upstreamRows, systemHealth, UPSTREAM_WRITER } from '../web/system-health.js'
import type { UpstreamSyncStatus } from '../web/upstream-sync-status-io.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const script = readFileSync(join(ROOT, 'scripts', 'upstream-divergence-check.sh'), 'utf8')
const backup = readFileSync(join(ROOT, 'scripts', 'backup.sh'), 'utf8')
const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const hu = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')

// Csak a vegrehajtott sorok. A kommentek idezik a regi hibas ertekeket, es a
// tiltasok kulonben a magyarazatot buktatnak meg a hiba helyett.
function code(src: string): string {
  return src
    .split('\n')
    .filter(l => !l.trim().startsWith('#') && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
}

describe('upstream-divergence-check.sh: a szamok merve vannak', () => {
  const sh = code(script)

  it('a script letezik es futtathato', () => {
    const mode = statSync(join(ROOT, 'scripts', 'upstream-divergence-check.sh')).mode
    // A vegrehajtasi bit tobbszor esett le attol, hogy a fajlt a Windows-oldali
    // UNC utvonalon szerkesztettuk; a systemd `bash <script>`-tel indit, de egy
    // kezi `./scripts/...` hivas enelkul "Permission denied".
    expect(mode & 0o111, 'hianyzik a futtathato bit').toBeGreaterThan(0)
  })

  it('mind a negy szamot gitbol veszi', () => {
    expect(sh).toContain('git rev-list --count')     // ahead/behind
    expect(sh).toContain('git merge-base')           // a kozos os
    expect(sh).toContain('git diff --name-only')     // az erintett fajlok
    expect(sh).toContain('git merge-tree')           // a valodi utkozes-proba
  })

  it('a fajl-listat a KOZOS OSBOL nezi, nem ket-pontos diffel', () => {
    // A `git diff LOCAL UPSTREAM` a sajat valtozasainkat is beleszamolna: itt
    // merve 234 fajlt adott a valos 112 helyett. A BASE valtozon keresztul kell
    // mennie.
    expect(sh).toMatch(/git diff --name-only "\$\{BASE\}"/)
  })

  it('a refeket ELOTTE ellenorzi, mert a merge-tree hibara is 1-gyel lep ki', () => {
    // Merve: `git merge-tree --write-tree --name-only main nincs-ilyen-ref`
    // kilepokodja 1 -- pontosan ugyanaz, mint amikor valodi utkozest talal. Ref
    // -ellenorzes nelkul egy elgepelt agnev "van egy utkozesunk"-kent jelenne meg.
    expect(sh).toContain('git rev-parse --verify')
    expect(sh).toMatch(/MT_RC.*-eq 0|MT_RC\}" -eq 0/s)
    expect(sh).toMatch(/MT_RC.*-eq 1|MT_RC\}" -eq 1/s)
  })

  it('a tisztan athuzhato szam halmaz-kulonbseg, nem kivonas', () => {
    expect(sh).toContain('comm -23')
    expect(sh).not.toMatch(/CLEAN=.*\$\(\(.*-.*CONFLICTS/)
  })

  it('nem nyul a munkakonyvtarhoz', () => {
    // Ez a script utemezetten fut, mikozben ugynokok dolgoznak a repoban. Egy
    // checkout/reset/merge/clean ott azonnal karos lenne.
    expect(sh).not.toMatch(/git checkout/)
    expect(sh).not.toMatch(/git reset/)
    expect(sh).not.toMatch(/git clean/)
    expect(sh).not.toMatch(/git stash/)
    // A merge-tree kivetel: az csak objektumot ir, indexet/worktree-t nem.
    expect(sh).not.toMatch(/git merge (?!-tree)/)
  })

  it('halozat nelkul sem fagy meg es sem hazudik frisseseget', () => {
    expect(sh).toContain('GIT_TERMINAL_PROMPT=0')   // ne varjon jelszora
    expect(sh).toContain('timeout 180 git fetch')   // ne logjon vegtelenul
    expect(sh).toContain('FETCH_OK')                // es mondja meg, ha nem sikerult
  })

  it('az upstream agat nem drotozza be main-re', () => {
    // Ezen a forkon a refs/remotes/upstream/HEAD a develop-ra mutat, es a ketto
    // kozott most 23 commit a kulonbseg -- egy bedrotozott "upstream/main" nem
    // rossz szamot adna, hanem MAS kerdesre valaszolna.
    expect(sh).toContain('refs/remotes/upstream/HEAD')
  })

  it('a JSON-t atomosan irja, hogy a dashboard sose lasson fel fajlt', () => {
    expect(sh).toContain('os.replace(tmp, out)')
  })
})

describe('a meres kora', () => {
  const NAP = 86_400_000

  it('a napokat lefele kerekiti', () => {
    const most = Date.parse('2026-08-19T12:00:00+02:00')
    expect(ageInDays('2026-08-19T11:00:00+02:00', most)).toBe(0)
    expect(ageInDays('2026-08-18T11:00:00+02:00', most)).toBe(1)
    expect(ageInDays('2026-08-10T03:21:00+02:00', most)).toBe(9)
  })

  it('a jovobeli idobelyeg nem lesz negativ kor', () => {
    // Az orak elcsuszasa (WSL felebredes utan tipikus) kulonben -1 napot adna,
    // amibol a felulet "friss"-et olvasna ki -- pont a rossz iranyba tevedve.
    const most = Date.parse('2026-08-19T12:00:00+02:00')
    expect(ageInDays('2026-08-20T12:00:00+02:00', most)).toBe(0)
  })

  it('hianyzo vagy ertelmezhetetlen datumbol nincs kor', () => {
    expect(ageInDays(null, Date.now())).toBeNull()
    expect(ageInDays('tegnap', Date.now())).toBeNull()
  })

  it('a kuszob ket kihagyott heti futasnal huzodik', () => {
    // Heti idozito: 10 nap = ket elmaradt futas. Ha egy hetnel rovidebb lenne,
    // a doboz a normalis ritmustol is elavultat kialtana.
    expect(STALE_AFTER_DAYS).toBeGreaterThan(7)
    expect(STALE_AFTER_DAYS).toBeLessThanOrEqual(14)
  })
})

describe('a doboz megmondja, mikor es mihez kepest mertunk', () => {
  const fn = (() => {
    const start = app.indexOf('function renderOverviewUpstreamSync')
    let depth = 0
    for (let i = app.indexOf('{', start); i < app.length; i++) {
      if (app[i] === '{') depth++
      else if (app[i] === '}' && --depth === 0) return app.slice(start, i + 1)
    }
    throw new Error('parositatlan kapcsos zarojel')
  })()
  const c = code(fn)

  it('a datum mellett ott a kor is', () => {
    expect(c).toContain('overview.upstream.age')
  })

  it('a regi merest elavultnak jeloli', () => {
    expect(c).toContain('overview.upstream.stale')
    expect(c).toContain('upstream-meta-stale')
  })

  it('kiirja, melyik ket agat vetettuk ossze', () => {
    expect(c).toContain('overview.upstream.pair')
    expect(c).toContain('upstreamSync.upstreamRef')
  })

  it('szol, ha a meres nem ert el a halozathoz', () => {
    expect(c).toContain('overview.upstream.no_fetch')
    // Szigoruan `=== false`: a regi, mezo nelkuli pillanatkepeknel az
    // `undefined` nem szabad, hogy "nem volt halozat"-nak latszodjon.
    expect(c).toMatch(/fetchOk === false/)
  })

  it('a magyarazat kimondja, hogy a commit es a fajl mas mertekegyseg', () => {
    expect(c).toContain('overview.upstream.explain')
    for (const [nev, lang] of [['hu', hu], ['en', en]] as const) {
      expect(lang, `${nev}: hianyzik a magyarazat`).toContain('overview.upstream.explain')
      // A magyarazat csak akkor er valamit, ha MINDHAROM szamot elhelyezi.
      for (const p of ['{c}', '{f}', '{x}', '{k}']) {
        expect(lang, `${nev}: a(z) ${p} hely nincs a magyarazatban`).toMatch(
          new RegExp(`overview\\.upstream\\.explain[^\\n]*\\${p}`),
        )
      }
    }
  })

  it('a magyarazat nem all ki kitalalt osszegre', () => {
    // Ha a tiszta szam nincs merve, nincs mit osszeadni: ilyenkor a magyarazo
    // sor is elmarad, kulonben egy `null`-bol keszult osszeget magyaraznank.
    // (Regen tooltip volt; azota LATHATO sor -- lasd lentebb.)
    expect(c).toMatch(/const explain = cleanKnown/)
    expect(c).toMatch(/upstream-sync-explain/)
  })

  it('minden uj kulcs megvan mindket nyelven', () => {
    for (const k of ['age', 'age_today', 'stale', 'pair', 'no_fetch', 'explain']) {
      expect(hu, `hu: overview.upstream.${k}`).toContain(`overview.upstream.${k}`)
      expect(en, `en: overview.upstream.${k}`).toContain(`overview.upstream.${k}`)
    }
  })

  it('a cimke kiirja, hogy az elso szam COMMIT', () => {
    // A Boss pont ezen akadt fenn: "63 fejlesztesbol 110 tisztan athuzhato???
    // fizikailag lehetetlen". Nem az volt, de amig a mertekegyseg csak a masik
    // ket cimkeben allt ott, a sor olvashatatlan volt.
    expect(hu).toMatch(/'overview\.upstream\.new':\s*'[^']*commit/i)
    expect(en).toMatch(/'overview\.upstream\.new':\s*'[^']*commit/i)
  })
})

describe('a mentes viszi a systemd unitokat', () => {
  it('a unit fajlokat, a drop-inokat es a bekapcsolt allapotot is', () => {
    // Merve 2026-08-19: a mentes a macOS launchd plisteket vitte, a Linux
    // systemd unitokat nem -- pedig ez az install Linuxon fut, 30+ kezzel irt
    // unittel. Egy visszaallitas utan az adat megvolt volna, de SEMMI nem
    // futott volna: sem a dashboard, sem a watchdogok, sem az az idozito,
    // amelyik a kovetkezo mentest keszitene.
    const b = code(backup)
    expect(b).toContain('.config/systemd/user')
    expect(b).toMatch(/\$\{MAIN_AGENT_ID\}-\*\.service/)
    expect(b).toMatch(/\$\{MAIN_AGENT_ID\}-\*\.timer/)
    // A drop-in .conf fajlok szabad nevuek (override.conf, cooldown.conf), ezert
    // -path kell hozzajuk, nem -name.
    expect(b).toMatch(/-path "\.config\/systemd\/user\/\$\{MAIN_AGENT_ID\}-\*\.d\/\*\.conf"/)
    // A *.wants/ symlinkek nelkul a unitok megvannak, de egyik sincs bekapcsolva.
    expect(b).toMatch(/-path "\.config\/systemd\/user\/\*\.wants\/\$\{MAIN_AGENT_ID\}-\*"/)
  })

})

describe('az iro es az olvaso ugyanarrol a fajlrol beszel', () => {
  it('a script oda ir, ahonnan a dashboard olvas', () => {
    // Ket helyen le van irva ugyanaz az utvonal (shell script + TS modul). Ez a
    // fajta duplikacio pont ugy csuszik szet eszrevetlenul, mint a mentesnel:
    // az iro tovabb dolgozik, az olvaso a regi helyet nezi, es a kartya
    // hetekig egy megfagyott szamot mutat -- ez volt az EREDETI hiba.
    const io = readFileSync(join(ROOT, 'src', 'web', 'upstream-sync-status-io.ts'), 'utf8')
    expect(io).toContain("join(PROJECT_ROOT, 'store', 'upstream-sync-status.json')")
    expect(script).toContain('store/upstream-sync-status.json')
  })

  it('a script minden mezot kitolt, amit az olvaso var', () => {
    const io = readFileSync(join(ROOT, 'src', 'web', 'upstream-sync-status-io.ts'), 'utf8')
    for (const mezo of ['checkedAt', 'aheadCount', 'behindCount', 'conflictingFiles',
                        'conflictCount', 'cleanFileCount', 'localRef', 'upstreamRef', 'fetchOk']) {
      expect(io, `az olvaso nem ismeri: ${mezo}`).toContain(mezo)
      expect(script, `a script nem irja ki: ${mezo}`).toContain(`'${mezo}'`)
    }
  })
})

// ===========================================================================
// Boss, 2026-08-19: "ha elromlik tudni akarok rola. az attekintesbe
// onellenorzesbe tedd bele. ha baj van szoljon ez is."
//
// A javitas onmagaban nem eleg: a mereset vegzo scriptet at lehet nevezni, a
// heti idozito le tud allni, es akkor pontosan az EREDETI hiba all vissza --
// egy magabiztos szam a kartyan, ami mogott mar senki nem mer semmit. Ezek a
// tesztek azt orzik, hogy ilyenkor az Onellenorzes MEGSZOLAL.
// ===========================================================================
describe('az onellenorzes eszreveszi, ha a meres elromlik', () => {
  const MOST = Date.parse('2026-08-19T12:00:00Z')
  const nap = 86_400_000
  const allapot = (napja: number, extra: Partial<UpstreamSyncStatus> = {}): UpstreamSyncStatus => ({
    checkedAt: new Date(MOST - napja * nap).toISOString(),
    aheadCount: 241, behindCount: 112, conflictingFiles: [], conflictCount: 22,
    cleanFileCount: 169, localRef: 'main', upstreamRef: 'upstream/develop',
    fetchOk: true, ageDays: napja, ...extra,
  })

  it('friss mereskor zold sor all ki (nem nema "rendben")', () => {
    const rows = upstreamRows(MOST, allapot(2))
    const ok = rows.find(r => r.id === 'upstream_ok')
    expect(ok, 'ket napos meresre nem all ki zold sor').toBeTruthy()
    expect(ok!.status).toBe('ok')
    expect(ok!.params!.d).toBe(2)
  })

  it('ket kihagyott heti futas utan FIGYELMEZTET', () => {
    const rows = upstreamRows(MOST, allapot(STALE_AFTER_DAYS + 3))
    const stale = rows.find(r => r.id === 'upstream_stale')
    expect(stale, 'elavult meresre nem szol').toBeTruthy()
    expect(stale!.status).toBe('warn')
    expect(Number(stale!.params!.d)).toBe(STALE_AFTER_DAYS + 3)
  })

  it('egy honap nema idozito mar HIBA, nem figyelmeztetes', () => {
    expect(upstreamRows(MOST, allapot(45)).find(r => r.id === 'upstream_stale')!.status).toBe('bad')
  })

  it('ha soha senki nem merte meg, azt is kimondja', () => {
    // Ez volt a 2026-08-10 elotti allapot: fajl van, iro nincs.
    expect(upstreamRows(MOST, null).map(r => r.id)).toContain('upstream_unmeasured')
    expect(upstreamRows(MOST, allapot(3, { checkedAt: null, ageDays: null })).map(r => r.id))
      .toContain('upstream_unmeasured')
  })

  it('halozat nelkuli meresre szol, hogy a szam a regi letoltesre igaz', () => {
    const rows = upstreamRows(MOST, allapot(1, { fetchOk: false }))
    expect(rows.map(r => r.id)).toContain('upstream_no_fetch')
    expect(rows.map(r => r.id)).not.toContain('upstream_ok')
  })

  it('ha eltunik a merest vegzo script, az HIBA', () => {
    // A legalattomosabb eset: a fajl megmarad, a szam ott all a kartyan, es
    // soha tobbe nem frissul. Pontosan ez volt az eredeti bug.
    const rows = upstreamRows(MOST, allapot(1), false)
    const nw = rows.find(r => r.id === 'upstream_no_writer')
    expect(nw, 'eltunt iro eseten nem szol').toBeTruthy()
    expect(nw!.status).toBe('bad')
    expect(nw!.params!.f).toBe('scripts/upstream-divergence-check.sh')
  })

  it('a merest vegzo script tenyleg a helyen van', () => {
    expect(UPSTREAM_WRITER).toBe('scripts/upstream-divergence-check.sh')
    expect(statSync(join(ROOT, UPSTREAM_WRITER)).isFile()).toBe(true)
  })

  it('az upstream-sorok tenylegesen bekerulnek az Attekintes onellenorzesebe', () => {
    const health = readFileSync(join(ROOT, 'src', 'web', 'system-health.ts'), 'utf8')
    expect(health).toMatch(/backupRows\(now\), \.\.\.upstreamRows\(now\)/)
    const ids = systemHealth().map(r => r.id)
    expect(ids.some(i => i.startsWith('upstream_')), 'a systemHealth nem ad upstream sort').toBe(true)
  })

  it('mind az ot allapotnak van magyar ES angol szovege, teendovel egyutt', () => {
    for (const id of ['upstream_ok', 'upstream_stale', 'upstream_unmeasured',
                      'upstream_no_writer', 'upstream_no_fetch']) {
      for (const [nev, forras] of [['hu', hu], ['en', en]] as const) {
        expect(forras, `${nev}: hianyzik health.${id}`).toContain(`'health.${id}'`)
        expect(forras, `${nev}: hianyzik health.${id}_action`).toContain(`'health.${id}_action'`)
      }
    }
    expect(hu).toMatch(/'health\.upstream_stale':\s*'[^']*\{d\}/)
    expect(hu).toMatch(/'health\.upstream_no_writer':\s*'[^']*\{f\}/)
  })

  it('a zold osszefoglaloban is ott van a friss meres', () => {
    expect(app).toContain("health.find(h => h.id === 'upstream_ok')")
    expect(app).toContain("t('health.upstream_ok'")
  })
})

// ===========================================================================
// Boss, 2026-08-19: "van x osszesen!!! es ebbol az x bol 22 utkozik es 169 nem.
// [...] de akkor a legelso szamnak kellene lennie a legnagyobbnak." es
// "112 meg 22 az nem egyenlo 169-el! hogy jon ez a szam ki?"
//
// A doboz harom szamot tett egy sorba ugy, mintha egy halmaz reszei lennenek,
// kozben az elso COMMIT volt, a masik ketto FAJL. Ettol a sor osszeadhatonak
// latszott, es nem jott ki. A sorrend most: osszeg -> ket resze; a commit-szam
// kulon sorba kerult, sajat mondattal.
// ===========================================================================
describe('a kartya nem kever ossze ket mertekegyseget', () => {
  it('az elso szam a fajlok OSSZEGE, nem a commit-szam', () => {
    expect(app).toContain('const total = cleanKnown ? String(conflicts + cleanNum)')
    const sor = app.slice(app.indexOf('<div class="upstream-sync-row">'))
    const eleje = sor.slice(0, sor.indexOf('</div>'))
    expect(eleje.indexOf('${total}'), 'nem a vegosszeg all elol').toBeLessThan(eleje.indexOf('${conflicts}'))
    expect(eleje.indexOf('${conflicts}')).toBeLessThan(eleje.indexOf('${clean}'))
    expect(eleje).not.toContain('${behind}')
  })

  it('a commit-szam kulon sorban all, es kimondja, hogy mas mertekegyseg', () => {
    expect(app).toContain("t('overview.upstream.commits', { c: behind })")
    for (const [nev, forras] of [['hu', hu], ['en', en]] as const) {
      expect(forras, `${nev}: hianyzik a commits kulcs`).toContain("'overview.upstream.commits'")
      expect(forras, `${nev}: hianyzik a total kulcs`).toContain("'overview.upstream.total'")
    }
    expect(hu).toMatch(/'overview\.upstream\.commits':\s*'[^']*\{c\}[^']*mértékegység/)
  })

  it('a magyarazat LATHATO szoveg, nem tooltip', () => {
    // Tooltipben allt: a Boss keperolvason es telefonon soha nem latta volna.
    expect(app).toContain('<div class="upstream-sync-explain">')
    expect(app).not.toContain('const rowTitle')
  })
})
