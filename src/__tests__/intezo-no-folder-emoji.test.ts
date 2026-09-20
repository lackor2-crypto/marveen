/**
 * NINCS EMOJI A MAPPANEVEK ELOTT (Boss, 2026-09-20).
 *
 * Boss szava: "torold ki azokat az ikonokat a mappanevek elott. zavaroak. nem
 * mondanak semmit. csak elcsunyitjak a[z] intezot. ... mindenhonnan."
 *
 * Miert kell ra teszt, es miert EZ a ket meres:
 *   1. A frontend oldal: az Intezo listaja ES a mappavalaszto gomb is ugyanabbol
 *      a segedfuggvenybol (`_faIkon`) rakta ki az emojit. Ha valaki barmelyiket
 *      visszateszi, a masik helyen konnyen eszrevetlen marad -- ezert a
 *      FUGGVENY letezeset merjuk, nem egy konkret sort.
 *   2. A szerver oldal: a `/api/life/hints` valasza korabban egy `icons` tablat
 *      is kuldott. Amig azt kuldi, barmelyik kesobbi felulet ujra kirakhatja --
 *      a csend itt nem eleg, a forrast kell elzarni.
 *
 * Ez NEM tiltja az emojit az egesz alkalmazasban (a kanban, a chat es a
 * jelvenyek hasznaljak). Kizarolag az ELETFA MAPPANEVEI elott tiltja.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const app = readFileSync(resolve(root, 'web', 'app.js'), 'utf8')
const lifeRoute = readFileSync(resolve(root, 'src', 'web', 'routes', 'life.ts'), 'utf8')
const naming = readFileSync(resolve(root, 'src', 'naming-conventions.ts'), 'utf8')

describe('Intezo: a mappanev elott nem all emoji', () => {
  it('a frontendben nincs mappa-ikon segedfuggveny', () => {
    expect(app).not.toContain('function _faIkon(')
    expect(app).not.toContain('_faIkonok')
  })

  it('a mappavalaszto gomb a puszta nevet irja ki', () => {
    expect(app).toContain('b.textContent = f.name')
  })

  it('a szerver mar nem kuld ikon-tablat a sugok melle', () => {
    expect(lifeRoute).toContain('send(res, 200, { hints: out })')
    expect(lifeRoute).not.toContain('iconTable')
  })

  it('a nevadasi modulban nincs tobbe ikon-tabla', () => {
    for (const nev of ['iconForKey', 'iconForFolderName', 'keysWithoutIcon', 'iconTable', 'DEFAULT_FOLDER_ICON']) {
      expect(naming, nev).not.toContain(nev)
    }
  })

  it('a sugo tovabbra is megy -- csak az ikon ment el', () => {
    // A magyarazo szoveg a mappa mellett Boss kifejezett kerese volt; ha az is
    // eltunne, az nem tisztitas lenne, hanem regresszio.
    expect(lifeRoute).toContain('lifeHints(hintLang)')
    expect(app).toContain('_faSugokBetolt')
  })
})
