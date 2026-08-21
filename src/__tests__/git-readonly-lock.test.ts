/**
 * CSAK-OLVASAS ZAR a kolcsonkulccsal lehuzott (nem a mienk) repokra.
 *
 * Boss: "csak olvasni akarom... igy fennal a veszelye hogy beleszerkeszt az
 * egyik agent veletlenul."
 *
 * A helyi szerkesztes onmagaban nem er el a tavoli repohoz -- az csak a
 * FELTOLTESSEL tortenne meg. Ezert nem a fajlokat fagyasztjuk be (azt egy
 * ugynok megkerulne, es kozben a sajat munkajat is ellehetetleniti), hanem a
 * push utjat vagjuk el ott, ahol a git maga nezi.
 *
 * Amit ez a fajl bizonyit:
 *   1. a zar utan a push tenylegesen ELHASAL (nem "elvileg"),
 *   2. a fetch KOZBEN TOVABBRA IS MUKODIK -- kulonben olvasni sem tudnank,
 *   3. a hibauzenet megmondja, MIERT -- a nema hiba ugyanolyan rossz.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  lockRepoReadOnly, unlockRepoReadOnly, isRepoReadOnly,
  setReadOnlyException, isReadOnlyException,
} from '../git-accounts.js'

const G = { encoding: 'utf8' as const, stdio: 'pipe' as const }
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { ...G, cwd }).toString()

let base = ''
let remote = ''
let klon = ''

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'ro-lock-'))
  remote = join(base, 'ceges.git')
  klon = join(base, 'klon')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote], G)
  execFileSync('git', ['clone', '-q', remote, klon], G)
  git(klon, 'config', 'user.email', 't@t')
  git(klon, 'config', 'user.name', 'T')
  writeFileSync(join(klon, 'a.txt'), 'eredeti\n')
  git(klon, 'add', '-A')
  git(klon, 'commit', '-q', '-m', 'elso')
  git(klon, 'push', '-q', 'origin', 'HEAD:main')
})

afterAll(() => { try { rmSync(base, { recursive: true, force: true }) } catch {} })

describe('csak-olvasas zar', () => {
  it('zar elott a push MEG atmegy -- kulonben nem a zart mernenk', () => {
    writeFileSync(join(klon, 'a.txt'), 'zar elott\n')
    git(klon, 'commit', '-qam', 'zar elott')
    expect(() => git(klon, 'push', '-q', 'origin', 'HEAD:main')).not.toThrow()
  })

  it('zar utan a push elhasal, es megmondja miert', async () => {
    expect(await lockRepoReadOnly(klon)).toBe(true)
    expect(await isRepoReadOnly(klon)).toBe(true)

    writeFileSync(join(klon, 'a.txt'), 'veletlen agent-szerkesztes\n')
    git(klon, 'commit', '-qam', 'ezt nem szabad feltolteni')

    let hiba = ''
    try { git(klon, 'push', 'origin', 'HEAD:main') } catch (e: any) {
      hiba = String(e?.stderr || '') + String(e?.stdout || '')
    }
    expect(hiba).toContain('CSAK-OLVASAS')
  })

  it('a tavoli repo tenyleg VALTOZATLAN maradt', () => {
    // Nem eleg, hogy a parancs hibat dobott: azt is meg kell nezni, hogy
    // kozben nem ment-e at valami.
    const fent = git(remote, 'show', 'main:a.txt')
    expect(fent.trim()).toBe('zar elott')
    expect(fent).not.toContain('veletlen agent-szerkesztes')
  })

  it('a cim VISSZAALLITASA utan is elhasal -- a hook fuggetlen reteg', () => {
    // Ez a legfontosabb eset: aki eszreveszi a hamis push-cimet, elsokent azt
    // allitja vissza. Ha egyetlen reteg lenne, itt nyilna ki a repo.
    git(klon, 'remote', 'set-url', '--push', 'origin', remote)

    let hiba = ''
    try { git(klon, 'push', 'origin', 'HEAD:main') } catch (e: any) {
      hiba = String(e?.stderr || '') + String(e?.stdout || '')
    }
    expect(hiba).toContain('ELUTASITVA')
    expect(git(remote, 'show', 'main:a.txt').trim()).toBe('zar elott')
  })

  it('a felig levett zarat NEM jelenti zartnak', async () => {
    // Felig levett zar zartnak latszva rosszabb a nyitottnal: nem nezne
    // utana senki. A cim itt mar vissza van allitva az elozo tesztben.
    expect(await isRepoReadOnly(klon)).toBe(false)
  })

  it('a fetch a zar utan is mukodik -- olvasni tovabbra is lehet', () => {
    expect(() => git(klon, 'fetch', '--quiet', 'origin')).not.toThrow()
  })
})

describe('a zar levetele', () => {
  it('visszaadja a push-t, es MINDKET reteget leveszi', async () => {
    // A zar most nincs fent (az elozo blokk vegen a cim vissza lett allitva,
    // de a hook meg ott van) -- eloszor allitsuk tiszta, zart allapotba.
    expect(await lockRepoReadOnly(klon)).toBe(true)
    expect(await isRepoReadOnly(klon)).toBe(true)

    expect(await unlockRepoReadOnly(klon)).toBe(true)
    expect(await isRepoReadOnly(klon)).toBe(false)

    // Es tenyleg fel is megy: felig levett zar eseten ez elhasalna.
    writeFileSync(join(klon, 'a.txt'), 'zar utan szabad\n')
    git(klon, 'commit', '-qam', 'zar levetele utan')
    expect(() => git(klon, 'push', '-q', 'origin', 'HEAD:main')).not.toThrow()
    expect(git(remote, 'show', 'main:a.txt').trim()).toBe('zar utan szabad')
  })

  it('a dontes TULELI a kovetkezo lehuzast (kivetel-nyilvantartas)', () => {
    // Ez a lenyeg: egy dontes, amit a gep a hatad mogott visszacsinal,
    // rosszabb, mintha meg sem lehetett volna hozni.
    expect(isReadOnlyException('TesztFiok', 'docs')).toBe(false)
    setReadOnlyException('TesztFiok', 'docs', true)
    expect(isReadOnlyException('TesztFiok', 'docs')).toBe(true)
    // ...es csak arra a repora vonatkozik, nem az egesz fiokra
    expect(isReadOnlyException('TesztFiok', 'masik')).toBe(false)
    setReadOnlyException('TesztFiok', 'docs', false)
    expect(isReadOnlyException('TesztFiok', 'docs')).toBe(false)
  })
})
