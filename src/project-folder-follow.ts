// A PROJEKT MAPPA-UTJA KOVETI AZ ELETFA ATRENDEZESET (kanban #359, mellekhiba).
//
// A szemelyek "Csalad" gyujtomappaja (#270) atkoltozteti a szemelyek mappait
// (`Korpás László/...` -> `Család/Korpás László/...`), es vele koltoznek a
// csatolasok, cimkek, archiv-jelek -- de a projektek `folder_path`-ja NEM.
// Mert: 2026-09-24-en az OSSZES projekt Fajlok fule "a projekt mappaja nincs
// meg" allapotba esett, mert a projekt a regi, mar nem letezo helyre mutatott.
//
// Ket resz:
//   - `moveProjectFoldersPrefix`: a koltoztetes resze, a tobbi tarolo mellett;
//   - `healProjectFoldersForPersonsGroup`: inditaskor javitja azt, ami MAR
//     elcsuszott. Csak akkor ir, ha a regi hely NINCS meg es az uj hely PONTOSAN
//     megvan (a szemely a beallitasban szerepel) -- semmit nem talalgat.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './db.js'
import { ensureProjectTables } from './projects.js'
import { lifeRoot, loadLifeConfig, personRel, safeLifeName } from './life-tree.js'
import { logger } from './logger.js'

function remap(path: string, from: string, to: string): string | null {
  if (path === from) return to
  if (path.startsWith(from + '/')) return to + path.slice(from.length)
  return null
}

/** Minden projekt, amelyik `from` alatt (vagy pontosan ott) van, `to` ala kerul.
 *  Visszaadja, hany projekt valtozott. */
export function moveProjectFoldersPrefix(from: string, to: string): number {
  if (!from || !to || from === to) return 0
  ensureProjectTables()
  const db = getDb()
  const rows = db.prepare('SELECT id, folder_path FROM projects WHERE folder_path IS NOT NULL').all() as { id: string; folder_path: string }[]
  const upd = db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?')
  let n = 0
  for (const r of rows) {
    const next = remap(r.folder_path, from, to)
    if (next === null) continue
    upd.run(next, r.id)
    n++
  }
  return n
}

export type HealResult = { root: string | null; fixed: { id: string; from: string; to: string }[] }

/** Inditaskori javitas: a projekt a szemely REGI (gyujtomappa elotti) helyere
 *  mutat, az mar nincs meg, az uj (`personRel`) viszont pontosan megvan. */
export function healProjectFoldersForPersonsGroup(): HealResult {
  const root = lifeRoot()
  if (!root) return { root: null, fixed: [] }
  const cfg = loadLifeConfig()
  const moves = cfg.persons
    .map((p) => ({ from: safeLifeName(p.name), to: personRel(cfg, p.name) }))
    .filter((m) => m.from && m.from !== m.to)
  if (!moves.length) return { root, fixed: [] }
  ensureProjectTables()
  const db = getDb()
  const rows = db.prepare('SELECT id, folder_path FROM projects WHERE folder_path IS NOT NULL').all() as { id: string; folder_path: string }[]
  const abs = (rel: string) => join(root, ...rel.split('/'))
  const upd = db.prepare('UPDATE projects SET folder_path = ? WHERE id = ?')
  const fixed: HealResult['fixed'] = []
  for (const r of rows) {
    if (existsSync(abs(r.folder_path))) continue
    for (const m of moves) {
      const next = remap(r.folder_path, m.from, m.to)
      if (next === null || !existsSync(abs(next))) continue
      upd.run(next, r.id)
      fixed.push({ id: r.id, from: r.folder_path, to: next })
      break
    }
  }
  if (fixed.length) logger.info({ fixed }, '[projects] a projekt mappa-utja kovette a szemelyek gyujtomappajat')
  return { root, fixed }
}
