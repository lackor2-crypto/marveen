// MINDEN helyorzot MINDEN telepito ki kell cserelnie.
//
// 2026-08-22: a napi git-lehuzas kartyaja a vezerlopult portjat helyorzobol
// veszi. A ket telepito es a frissito HAROM kulon `sed`-listat tart karban --
// es a frissitobol pont a `{{WEB_PORT}}` hianyzott. Friss telepitesen mukodott
// volna, a mar meglevo gepeken viszont a kartya `curl`-je a szo szerinti
// "http://127.0.0.1:{{WEB_PORT}}/..." cimre ment volna, oroken at, csendben.
//
// Ezert nem egy konkret helyorzot ellenorzunk itt, hanem a SZABALYT: ami a
// sablonokban elofordul, azt mind a harom szkriptnek ismernie kell.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const GYOKER = join(__dirname, '..', '..')
const SEED_DIR = join(GYOKER, 'seed-scheduled-tasks')

/** A sablonfaban tenylegesen hasznalt helyorzok. */
function helyorzok(dir: string, out = new Set<string>()): Set<string> {
  for (const n of readdirSync(dir)) {
    const teljes = join(dir, n)
    if (statSync(teljes).isDirectory()) { helyorzok(teljes, out); continue }
    let sz: string
    try { sz = readFileSync(teljes, 'utf-8') } catch { continue }
    for (const m of sz.matchAll(/{{[A-Z_]+}}/g)) out.add(m[0])
  }
  return out
}

/**
 * A sablon-masolo `sed` helyettesitesi listaja -- CSAK az.
 *
 * Az egesz fajlban keresni nem er: a `{{WEB_PORT}}` mashol (a CLAUDE.md
 * rendereleseben) is szerepel, es az elso valtozatom eppen ezert engedte at a
 * hianyt, amit meg kellett volna fognia.
 */
function sedLista(forras: string): string {
  const i = forras.indexOf('SEED_SCHED_DIR')
  if (i < 0) throw new Error('nincs seed-scheduled-tasks hurok')
  const s = forras.indexOf('sed -e', i)
  const v = forras.indexOf('> "$target/$rel"', s)
  if (s < 0 || v < 0) throw new Error('nem talalom a helyettesitesi listat')
  return forras.slice(s, v)
}

const HASZNALT = [...helyorzok(SEED_DIR)].sort()
const SZKRIPTEK = ['install-linux.sh', 'install-macos.sh', 'update.sh']

describe('a telepitok minden helyorzot ismernek', () => {
  it('van egyaltalan mit ellenorizni', () => {
    expect(HASZNALT.length).toBeGreaterThan(0)
  })

  for (const szkript of SZKRIPTEK) {
    const forras = readFileSync(join(GYOKER, szkript), 'utf-8')
    it(szkript + ' mindet kicsereli', () => {
      // A kicsereletlen helyorzo nem hibaval all meg: a feladat letrejon, jonak
      // latszik, es sose csinal semmit.
      const hianyzo = HASZNALT.filter((h) => !sedLista(forras).includes(h))
      expect(hianyzo).toEqual([])
    })
  }
})

describe('a napi git-lehuzas kartyaja telepul is', () => {
  it('a sablon-hurok maga szedi ossze a mappakat, nem beegetett lista', () => {
    // Enelkul minden uj kartyat harom szkriptben kellene bejelenteni -- es a
    // git-pull pont az a kartya, aminek a hianyat senki nem venne eszre.
    for (const szkript of SZKRIPTEK) {
      const forras = readFileSync(join(GYOKER, szkript), 'utf-8')
      expect(forras).toContain('SEED_SCHED_DIR')
    }
    expect(readdirSync(SEED_DIR)).toContain('git-pull')
  })
})
