// AZ ONELLENORZES OTT SZOLJON, AHOL A HIBA NEMA MARAD.
//
// Boss, 2026-08-22: "ha ker az mcp hitelesitest, akkor az miert nem jelenik
// meg az attekintes onellenorzesben?????? hat ha hiba van akkor az
// onellenorzesnek szolnia kell!!! [...] es minden ehhez hasonlot is kos be!"
// es: "szoljon a rendszer ha van git bekotve es ez az utemezes megsem
// tortenik meg!"
//
// Mind a harom uj check kozos vonasa, hogy a hiba NEM lat semmit magabol: a
// repo ott all a fan (csak regi), a parancs-kartya nem beszelget senkivel, az
// MCP-szerver hianyatol az agens meg vidaman valaszol -- csak eppen nincs meg
// az az egy eszkoze.
import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitPullRows, commandTaskRows, mcpAuthRows, skillSeedRows } from '../web/system-health.js'
import { mkdirSync } from 'node:fs'

const NAP = 86400000
const MOST = Date.parse('2026-08-22T12:00:00Z')
const ELOTTE = (napok: number): string => new Date(MOST - napok * NAP).toISOString()
const VAN_KARTYA = { letezik: true, bekapcsolva: true }
const futas = (napja: number, db: number, errors = 0) => (
  { finishedAt: ELOTTE(napja), results: new Array(db).fill({}), errors }
)

describe('napi git-lehuzas: a nema elavulas', () => {
  it('friss futas utan ZOLD sort ad, a szamokkal', () => {
    const r = gitPullRows(MOST, futas(0, 9), VAN_KARTYA, true)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('git_pull_ok')
    expect(r[0].status).toBe('ok')
    expect(r[0].params).toMatchObject({ n: 9 })
  })

  it('a lehuzasi hibat PIROSSAL mondja meg', () => {
    // 2026-08-22: hatbol ot repo hasalt el rossz kulcs miatt. A szam ott allt
    // az allapotfajlban, es senki nem nezte meg.
    const r = gitPullRows(MOST, futas(0, 6, 5), VAN_KARTYA, true)
    const e = r.find((x) => x.id === 'git_pull_errors')
    expect(e?.status).toBe('bad')
    expect(e?.params).toMatchObject({ n: 5, all: 6 })
    // Hiba mellett NINCS zold sor: az ket egymasnak ellentmondo allitas volna.
    expect(r.some((x) => x.id === 'git_pull_ok')).toBe(false)
  })

  // A SZAM ONMAGABAN NEM TEENDO.
  //
  // Boss, 2026-08-23: "miert keres plusz 5 git tarolot? hiszen nincsennek!"
  // -- dehogynem voltak: hat ceges repo allt a fan. Csak a sor nem mondta meg,
  // MELYIK otrol beszel, es kozben egy TIPPELT okot allitott ("hianyzo vagy
  // rossz kulcs"), holott mind az ot hiba `Could not resolve host` volt.
  const hibas = (rel: string, message: string) => ({ rel, state: 'error', message })
  const futasHibakkal = (...h: Array<{ rel: string; state: string; message: string }>) => ({
    finishedAt: ELOTTE(0),
    results: [...h, { rel: 'Sajat/ok', state: 'current', message: 'Naprakesz.' }],
    errors: h.length,
  })

  it('MEGNEVEZI a hibas tarolokat', () => {
    const r = gitPullRows(MOST, futasHibakkal(
      hibas('Cegek/X/GIT_REPOS/docs', 'fatal: unable to access: Could not resolve host: github.com'),
      hibas('Cegek/X/GIT_REPOS/freeber-classic', 'fatal: unable to access: Could not resolve host: github.com'),
    ), VAN_KARTYA, true)
    const e = r.find((x) => x.id.startsWith('git_pull_errors'))
    expect(e?.params).toMatchObject({ n: 2, all: 3, names: 'docs, freeber-classic' })
  })

  it('a HALOZATI hibat nem mondja kulcs-hibanak', () => {
    const r = gitPullRows(MOST, futasHibakkal(
      hibas('a/docs', 'fatal: unable to access: Could not resolve host: github.com'),
    ), VAN_KARTYA, true)
    expect(r[0].id).toBe('git_pull_errors_net')
  })

  it('a KULCS-hibat kulcs-hibanak mondja', () => {
    const r = gitPullRows(MOST, futasHibakkal(
      hibas('a/docs', 'fatal: Authentication failed for https://github.com/x/docs.git/'),
    ), VAN_KARTYA, true)
    expect(r[0].id).toBe('git_pull_errors_auth')
  })

  it('ismeretlen okra NEM talal ki okot', () => {
    const r = gitPullRows(MOST, futasHibakkal(
      hibas('a/docs', 'fatal: valami egeszen mas'),
    ), VAN_KARTYA, true)
    expect(r[0].id).toBe('git_pull_errors_named')
  })

  it('vegyes oknal sem allit egyetlen okot', () => {
    const r = gitPullRows(MOST, futasHibakkal(
      hibas('a/docs', 'Could not resolve host: github.com'),
      hibas('a/masik', 'Authentication failed'),
    ), VAN_KARTYA, true)
    expect(r[0].id).toBe('git_pull_errors_named')
  })

  it('hosszu listat rovidit -- a kartya ket sorra van meretezve', () => {
    const sok = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => hibas('x/' + n, 'Could not resolve host'))
    const r = gitPullRows(MOST, futasHibakkal(...sok), VAN_KARTYA, true)
    expect(r[0].params?.names).toBe('a, b, c, d, +2')
  })

  it('az elakadt utemezest a KORABOL veszi eszre, nem a kartyabol', () => {
    expect(gitPullRows(MOST, futas(1, 9), VAN_KARTYA, true)[0].id).toBe('git_pull_ok')
    const kesik = gitPullRows(MOST, futas(5, 9), VAN_KARTYA, true)[0]
    expect(kesik.id).toBe('git_pull_stale')
    expect(kesik.status).toBe('warn')
    expect(kesik.params).toMatchObject({ d: 5 })
    // Ket het utan mar nem "kesik", hanem all.
    expect(gitPullRows(MOST, futas(20, 9), VAN_KARTYA, true)[0].status).toBe('bad')
  })

  // A BEJARHATATLAN DEPO-GYOKER NEM AZONOS A "NINCS BEKOTVE GIT"-TEL.
  //
  // Boss, 2026-08-23: "remelem akik ujonnan telepitik a marveent azoknak ez
  // nem fog elojonni. azoknak sem."
  //
  // Ez volt a nemabb testver-hiba: ha a depo egy Windows-meghajton ul es a
  // csatolas elall, a bejaras NULLA repot talal. Az onellenorzes ezt eddig
  // ugy latta, mint egy friss telepitest, ahol meg nincs git -- es HALLGATOTT.
  // Kozben minden repo elavult. Egy friss telepitesnel a csend a helyes
  // valasz, egy elallt csatolasnal a leghangosabb sor.

  it('az elerhetetlen gyokerrol AKKOR is szol, ha nem latszik bekotott git', () => {
    const r = gitPullRows(
      MOST,
      { finishedAt: ELOTTE(0), results: [], errors: 0, rootError: 'EIO: i/o error, scandir' },
      VAN_KARTYA,
      false,
    )
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('git_pull_root_unreachable')
    expect(r[0].status).toBe('bad')
  })

  it('FRISS TELEPITESEN csendben marad -- ott tenyleg nincs mirol szolni', () => {
    // Nulla repo, nulla token, ep gyoker: ez nem hiba, hanem egy uj gep.
    expect(gitPullRows(MOST, { finishedAt: ELOTTE(0), results: [], errors: 0 }, VAN_KARTYA, false)).toEqual([])
    expect(gitPullRows(MOST, null, { letezik: false, bekapcsolva: false }, false)).toEqual([])
  })

  it('a KIKAPCSOLT kartya a legsulyosabb eset', () => {
    // A `startGitSync()` csak azt nezi, LETEZIK-e a kartya fajlja. Egy
    // kikapcsolt kartya tehat a tartalek hat-oras idozitot is elnemitja:
    // onnantol semmi nem huz le, teljesen csendben.
    const r = gitPullRows(MOST, futas(0, 9), { letezik: true, bekapcsolva: false }, true)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('git_pull_disabled')
    expect(r[0].status).toBe('bad')
    // Git nelkul ugyanez csak figyelmeztetes -- nincs mit elveszteni.
    expect(gitPullRows(MOST, null, { letezik: true, bekapcsolva: false }, false)[0].status).toBe('warn')
  })

  it('bekotott git mellett a "meg soha nem futott" is hiba', () => {
    const r = gitPullRows(MOST, null, VAN_KARTYA, true)
    expect(r[0].id).toBe('git_pull_never')
    expect(r[0].status).toBe('warn')
  })

  it('git nelkul HALLGAT', () => {
    // Zaj nelkul: akinek nincs bekotott taroloja, annak nincs mirol szolni.
    expect(gitPullRows(MOST, null, VAN_KARTYA, false)).toEqual([])
    expect(gitPullRows(MOST, futas(30, 0), VAN_KARTYA, false)).toEqual([])
  })

  it('a hibas datumot nem hiszi el', () => {
    const r = gitPullRows(MOST, { finishedAt: 'nem datum', results: [{}] }, VAN_KARTYA, true)
    expect(r[0].id).toBe('git_pull_never')
    // Es a jovobeli datumbol sem lesz negativ nap.
    const jovo = gitPullRows(MOST, futas(-3, 9), VAN_KARTYA, true)[0]
    expect(jovo.id).toBe('git_pull_ok')
    expect(jovo.params).toMatchObject({ d: 0 })
  })
})

describe('gepi kartyak: parancs, ami nem beszel senkivel', () => {
  it('a bukott kartyakat nevvel sorolja fel', () => {
    const r = commandTaskRows({
      'git-pull': { lastStatus: 'fail' },
      mentes: { lastStatus: 'ok' },
      takaritas: { lastStatus: 'fail' },
    })
    expect(r).toHaveLength(1)
    expect(r[0].status).toBe('warn')
    expect(r[0].params).toMatchObject({ n: 2 })
    expect(String(r[0].params?.names)).toContain('git-pull')
    expect(String(r[0].params?.names)).toContain('takaritas')
  })

  it('ha minden rendben, nem szol', () => {
    expect(commandTaskRows({ 'git-pull': { lastStatus: 'ok' } })).toEqual([])
    expect(commandTaskRows(null)).toEqual([])
  })

  it('a lemezrol jott nevet MEGTISZTITJA', () => {
    // A kliens a params-t escape NELKUL rendereli. A kartya neve viszont egy
    // konyvtarnev a lemezen -- vagyis kivulrol jovo adat.
    const r = commandTaskRows({ 'rossz<img onerror=x>': { lastStatus: 'fail' } })
    const nevek = String(r[0].params?.names)
    expect(nevek).not.toContain('<')
    expect(nevek).not.toContain('>')
    expect(nevek).not.toContain('=')
  })
})

describe('MCP: hitelesitesre varo kapcsolat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-mcp-'))
  const ir = (nev: string, tartalom: unknown): string => {
    const p = join(dir, nev)
    writeFileSync(p, JSON.stringify(tartalom))
    return p
  }

  it('a varakozo kapcsolatot kiirja', () => {
    const p = ir('a.json', { 'google-drive': { timestamp: MOST - 1000 } })
    const r = mcpAuthRows(MOST, [p])
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('mcp_needs_auth')
    expect(r[0].status).toBe('warn')
    expect(r[0].params).toMatchObject({ n: 1, names: 'google-drive' })
  })

  it('az ures gyorsitotar = nincs teendo', () => {
    // Sikeres hitelesites utan a bejegyzes TORLODIK -- ezert ures fajl eseten
    // valoban nincs mirol szolni.
    expect(mcpAuthRows(MOST, [ir('b.json', {})])).toEqual([])
    expect(mcpAuthRows(MOST, [join(dir, 'nincs-ilyen.json')])).toEqual([])
  })

  it('a lejart bejegyzes nem szamit', () => {
    const p = ir('c.json', { regi: { timestamp: MOST - 10000, ttlMs: 5000 } })
    expect(mcpAuthRows(MOST, [p])).toEqual([])
    // ...de amig el, igen.
    expect(mcpAuthRows(MOST - 9000, [p])).toHaveLength(1)
  })

  it('tobb agens ugyanazt a szervert varja: egyszer mondja', () => {
    const a = ir('d.json', { drive: { timestamp: MOST } })
    const b = ir('e.json', { drive: { timestamp: MOST }, jira: { timestamp: MOST } })
    const r = mcpAuthRows(MOST, [a, b])
    expect(r[0].params).toMatchObject({ n: 2, names: 'drive, jira' })
  })

  it('a szervernevet is MEGTISZTITJA', () => {
    const p = ir('f.json', { 'x<b>y': { timestamp: MOST } })
    expect(String(mcpAuthRows(MOST, [p])[0].params?.names)).not.toContain('<')
  })
})

// === Helyben ragadt skillek =================================================
//
// Boss, 2026-08-29: "ha nem szemelyes akkor globalisan kell megirni a
// skilleket is!" A ~/.claude/skills/ ala irt skill csak ezen a gepen letezik;
// friss telepitesen a user nem is tud rola. 2026-08-29-en 15 ilyen skill volt.
describe('skillek: ami csak helyben van', () => {
  const gyoker = mkdtempSync(join(tmpdir(), 'marveen-skills-'))
  const home = join(gyoker, 'home')
  const projekt = join(gyoker, 'repo')
  const skill = (hova: string, nev: string, fej = ''): void => {
    mkdirSync(join(hova, nev), { recursive: true })
    writeFileSync(join(hova, nev, 'SKILL.md'), `---\nname: ${nev}\n${fej}---\n\nx\n`)
  }
  const helyi = join(home, '.claude', 'skills')
  const seed = join(projekt, 'seed-skills')

  it('friss telepites: nincs skills-mappa -> HALLGAT', () => {
    expect(skillSeedRows(join(gyoker, 'nincs-ilyen-home'), projekt)).toEqual([])
  })

  it('a seedelt skillrol nem szol, a helyben ragadtrol igen', () => {
    skill(helyi, 'kanban-card-creation')
    skill(helyi, 'csak-itt-van')
    skill(seed, 'kanban-card-creation')
    const r = skillSeedRows(home, projekt)
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('skills_not_seeded')
    expect(r[0].status).toBe('warn')
    expect(r[0].params).toMatchObject({ n: 1, names: 'csak-itt-van' })
  })

  it('a szemelyesnek jelolt skill szandekosan marad helyben', () => {
    skill(helyi, 'sajat-ugy', 'scope: personal\n')
    const nevek = String(skillSeedRows(home, projekt)[0].params?.names)
    expect(nevek).not.toContain('sajat-ugy')
  })

  // A NULLA KET DOLGOT JELENTHET: ha nincs mihez hasonlitani, az nem "tiszta".
  it('hianyzo seed-skills eseten NEM hallgat, hanem megmondja hogy nem lat oda', () => {
    const r = skillSeedRows(home, join(gyoker, 'nincs-ilyen-repo'))
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('skills_seed_missing')
  })

  it('a lemezrol jott nevet MEGTISZTITJA', () => {
    skill(helyi, 'rossz<img onerror=x>')
    const nevek = String(skillSeedRows(home, projekt)[0].params?.names)
    expect(nevek).not.toContain('<')
    expect(nevek).not.toContain('=')
  })
})

// === Az altalanos or ======================================================
//
// Nem eleg egyszer bekotni: a KOVETKEZO check se maradhasson nema. Ha valaki
// uj sort ad a system-health-hez, de elfelejt hozza szoveget irni, a felulet
// a nyers azonositot mutatna ("git_pull_stale") -- vagy semmit.
describe('minden allapotsorhoz van emberi szoveg', () => {
  const FORRAS = readFileSync(join(__dirname, '..', 'web', 'system-health.ts'), 'utf-8')
  const HU = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf-8')
  const EN = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf-8')
  const idk = [...new Set([...FORRAS.matchAll(/id: '([a-z0-9_]+)'/g)].map((m) => m[1]))]

  it('van mit ellenorizni', () => {
    expect(idk.length).toBeGreaterThan(10)
    expect(idk).toContain('git_pull_disabled')
    expect(idk).toContain('mcp_needs_auth')
  })

  it('mindegyikhez van magyar ES angol szoveg, teendovel egyutt', () => {
    const hianyzik: string[] = []
    for (const id of idk) {
      for (const [nyelv, sz] of [['hu', HU], ['en', EN]] as const) {
        if (!sz.includes("'health." + id + "'")) hianyzik.push(nyelv + ':health.' + id)
        if (!sz.includes("'health." + id + "_action'")) hianyzik.push(nyelv + ':health.' + id + '_action')
      }
    }
    expect(hianyzik).toEqual([])
  })
})

/**
 * HALOZAT-HIANY: nem hiba, es nem is elhallgatando.
 *
 * A MERT ESET (2026-08-26 reggel). A napi lehuzas 06:49-kor futott,
 * kozvetlenul ebredes utan, amikor a WSL-ben meg nem volt nevfeloldas. Mind
 * a het tavoli tarolo `Could not resolve host: github.com`-mal elhasalt. Egy
 * oraval kesobb a halozat hibatlanul mukodott -- de senki nem merte ujra, es
 * a piros sor ott maradt egesz napra, azt allitva, hogy a tarolok
 * elromlottak. Boss: ``minden rendben van de o szol hogy nincs. ez gaz.``
 *
 * A sor ezert HAROM allapotot ismer, es ezt a harmat rogziti az alabbi
 * harom teszt. Ha barmelyik eldol, a reggeli hamis riasztas visszater.
 */
describe('git-lehuzas: a halozat-hiany nem hiba', () => {
  const ORA = 60 * 60 * 1000
  const NOW = Date.parse('2026-08-26T09:00:00Z')
  const kartya = { letezik: false, bekapcsolva: true }

  function menet(offlineDb: number, oraOta: number) {
    return {
      finishedAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
      results: Array.from({ length: 10 }, (_, i) => ({
        rel: 'a/b/repo' + i,
        state: i < offlineDb ? 'offline' : 'current',
        message: i < offlineDb ? 'Could not resolve host: github.com' : 'Naprakész.',
      })),
      errors: 0,
      offline: offlineDb,
      offlineSince: offlineDb > 0 ? new Date(NOW - oraOta * ORA).toISOString() : null,
    }
  }

  it('friss halozat-hiany: ZOLD marad, mert magatol ujraprobal', () => {
    // Ez a reggeli eset. A gep most ebredt, a DNS meg nem jott fel, es
    // tiz perc mulva minden lejon. Riasztani ezen a ponton hazugsag volna.
    const rows = gitPullRows(NOW, menet(7, 0) as never, kartya, true)
    const sor = rows.find(r => r.id === 'git_pull_offline')
    expect(sor?.status).toBe('ok')
    expect(sor?.params).toMatchObject({ n: 7 })
  })

  it('a zold sor KIIRODIK -- a turelem nem nemasag', () => {
    // Ha a kartyan semmi nem allna, a felhasznalo nem tudna megkulonboztetni
    // a ``rendben van``-t a ``nem is neztem oda``-tol. A CLAUDE.md nulla-szabalya
    // pont ezt tiltja.
    const rows = gitPullRows(NOW, menet(7, 0) as never, kartya, true)
    expect(rows.some(r => r.id === 'git_pull_offline')).toBe(true)
  })

  it('6 ora utan SARGA, 24 ora utan PIROS -- a csend nem tarthat orokke', () => {
    // A fek. Enelkul egy tenylegesen elszakadt halozat orokre nema maradna,
    // es minden tarolo csendben elavulna -- ez a rosszabbik hiba.
    expect(gitPullRows(NOW, menet(7, 7) as never, kartya, true)
      .find(r => r.id === 'git_pull_offline')?.status).toBe('warn')
    expect(gitPullRows(NOW, menet(7, 30) as never, kartya, true)
      .find(r => r.id === 'git_pull_offline')?.status).toBe('bad')
  })

  it('a halozat-hiany NEM szamit bele a hibaszamba', () => {
    // Ez volt a gyoker: az ``elertem es romlott`` es a ``nem lattam oda``
    // egy mezobe kerult, ezert a masodik ugy latszott, mint az elso.
    const rows = gitPullRows(NOW, menet(7, 0) as never, kartya, true)
    expect(rows.some(r => String(r.id).startsWith('git_pull_errors'))).toBe(false)
  })

  it('ha minden lejott, nincs offline sor -- csak a zold osszegzo', () => {
    const rows = gitPullRows(NOW, menet(0, 0) as never, kartya, true)
    expect(rows.some(r => r.id === 'git_pull_offline')).toBe(false)
    expect(rows.some(r => r.id === 'git_pull_ok')).toBe(true)
  })
})
