import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A NEMA ELAVULAS ORE.
 *
 * A MERT ESET (2026-09-11/12). A `032aa826` kartya javitasa landolt: a
 * `marvin-code-worker.ps1` megkapta a `startFresh` agat, vagyis cimzes nelkul
 * UJ, ures beszelgetest kellett volna nyitnia a projekt "aktualis" fule
 * helyett. A javitas megis SOHA nem lepett eletbe. Ok: a `440abbd` commit a
 * szkript TORZSET atirta, de a `$script:WorkerVersion` sorhoz NEM nyult.
 *
 * A szkript a felhasznalo gepen egy MASOLATBAN fut
 * (`%USERPROFILE%\marvin-code-worker\`), es maga frissiti magat -- de csak
 * akkor, ha a ket verziojeloles eltér (`Invoke-SelfUpdate`):
 *
 *     if ($Expected -eq $script:WorkerVersion) { return $false }
 *
 * Azonos verzioszam mellett tehat a frissites ELMARAD, a "elavult vegrehajto"
 * egeszseg-sor (`code_bridge_worker_stale`) pedig szinten NEM tud megszolalni,
 * mert az is ugyanezt a ket szamot veti ossze. A telepitett peldany igy
 * 2026-08-30-i maradt, es minden cim nelkuli feladat tovabbra is a tulaj SAJAT
 * beszelgetesebe futott -- pontosan az, amit a kartya kizarni akart.
 *
 * A hiba tehat nem a vedelemben volt: a vedelem MEGVOLT, csak kikerultek.
 * Ez az egyetlen olyan fajl a repoban, aminel a tartalom megvaltoztatasa
 * ONMAGABAN nem eleg -- a verziosort is emelni KELL, kulonben a valtozas nem
 * jut el a futo geplig.
 *
 * EZERT NEM ELEG EGY KOMMENT. A szkript tetejen eddig is ott allt, hogy "Ha itt
 * valtozik valami, amit a szervernek is tudnia kell, EZT A SORT is emelni
 * kell" -- es pont ezt nezte el valaki. Egy komment nem bukik meg; egy teszt
 * igen.
 *
 * HOGYAN OR. Az ujjlenyomat a szkript torzserol keszul, a verziosor ERTEKET
 * helyorzore cserelve. Igy:
 *   - a torzs barmely modositasa elbuktatja ezt a tesztet;
 *   - a verzio puszta emelese NEM buktatja el (nem kell feleslegesen ujra
 *     szamolni);
 *   - a javitas egyetlen utja az, hogy a ket allandot EGYUTT frissiti az, aki
 *     a szkriptet atirta -- es akkor a verzio is uj lesz.
 *
 * A sorvegeket normalizaljuk: a Windows-oldali masolat CRLF-fel el, a repoban
 * LF van, es egy sorvegvaltas nem "uj worker".
 */

const ROOT = join(__dirname, '..', '..')
const PS1_PATH = join(ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1')
const VERSION_RX = /(\$script:WorkerVersion\s*=\s*')([^']{1,40})(')/

/** A mostani torzs ujjlenyomata. AKI A SZKRIPTET ATIRJA, ezt is es a
 *  verziosort is frissiti -- a ketto egyutt jar. */
const BODY_FINGERPRINT = '8fa9653ed58161375f95005a44425c0ffe60f0c8c79157f2a579975d93d4d620'

/** Ami a `BODY_FINGERPRINT`-hez tartozik. Ezt a szkriptbol olvassuk vissza,
 *  hogy a ket fajl ne tudjon szetcsuszni. */
const EXPECTED_VERSION = '2026-09-12.4'

function bodyFingerprint(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(VERSION_RX, '$1<VERSION>$3')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

describe('worker-szkript: a torzs nem valtozhat a verziosor emelese nelkul', () => {
  const ps1 = readFileSync(PS1_PATH, 'utf8')

  it('a verziosor megvan es kiolvashato', () => {
    const m = VERSION_RX.exec(ps1)
    expect(m, 'a $script:WorkerVersion sor eltunt a szkriptbol').toBeTruthy()
    expect(m![2]).toBe(EXPECTED_VERSION)
  })

  it('a torzs ujjlenyomata egyezik -- kulonben a verziot is emelni kell', () => {
    const now = bodyFingerprint(ps1)
    expect(
      now,
      'A marvin-code-worker.ps1 TORZSE megvaltozott.\n'
        + 'A telepitett peldany a felhasznalo gepen CSAK akkor frissul, ha a\n'
        + "$script:WorkerVersion sor is uj erteket kap -- kulonben a valtozas\n"
        + 'nemaan sosem lep eletbe (ez tortent 2026-09-10-en a 032aa826 kartyaval).\n'
        + '\n'
        + 'TEENDO, a ketto EGYUTT:\n'
        + "  1. scripts/windows/marvin-code-worker.ps1 -> $script:WorkerVersion = '<ma>.1'\n"
        + '  2. ebben a fajlban: EXPECTED_VERSION = ugyanaz, BODY_FINGERPRINT = ' + now + '\n',
    ).toBe(BODY_FINGERPRINT)
  })

  it('a verzio puszta emelese NEM buktatja el az ujjlenyomatot', () => {
    const bumped = ps1.replace(VERSION_RX, "$1" + "9999-12-31.9" + "$3")
    expect(bumped).not.toBe(ps1)
    expect(bodyFingerprint(bumped)).toBe(bodyFingerprint(ps1))
  })

  it('a 032aa826 javitasa (startFresh ag) benne van a szkriptben', () => {
    // Ez a konkret javitas az, amelyik a verzioemelés elmaradasa miatt nem
    // jutott el a gepig. Ha barmikor kiesne, a teszt szoljon rola.
    expect(ps1).toContain('$Task.startFresh')
    // A friss ag NEM resume-olhat: az adna vissza pontosan a regi hibat.
    const i = ps1.indexOf('if ($Task.startFresh)')
    expect(i).toBeGreaterThan(0)
    const branch = ps1.slice(i, ps1.indexOf('} else {', i))
    expect(branch).not.toContain('--resume')
  })

  it('a verzio NEM maradhat a hibas 2026-08-30.1 ertéken', () => {
    // Az a verzio azonositja azt a telepitett peldanyt, amelyik a startFresh
    // agat meg nem ismerte. Amig a repo is ezt hirdeti, a self-update nem indul.
    expect(VERSION_RX.exec(ps1)![2]).not.toBe('2026-08-30.1')
  })
})
