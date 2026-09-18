/**
 * UJ FAJL A PROJEKT MAPPAJABA (kanban #321, spec 17. pont: "+ Uj" -> "Uj fajl /
 * dokumentum -- az aktualis projekt mappajaba").
 *
 * Ket ut van, mert a Marveenben nincs beepitett dokumentumszerkeszto (spec 21.):
 *   - feltoltes a sajat gepedrol (egy fajl = egy keres, a nyers bajtok jonnek,
 *     a nev a query-ben -- igy az ekezetes fajlnev sem torik el),
 *   - egy uj, ures vagy rovid szoveges jegyzet (.md / .txt).
 *
 * Biztonsag, ugyanazokkal a szabalyokkal, mint az Intezo:
 *   - a cel CSAK a projekt mappaja vagy annak egy almappaja lehet (a Raktaron
 *     belul -- `resolveLifePath` a jelkapcsolaton at kivezeto utat is elkapja),
 *   - git-repo belsejebe nem irunk (git-guard),
 *   - meglevo fajlt SOHA nem irunk felul: ha a nev foglalt, `nev (2).ext` lesz,
 *     es a felulet megmondja, milyen neven mentettuk.
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, sep } from 'node:path'
import { resolveLifePath, toLifeRel, explorerRoot } from './life-explorer.js'
import { safeLifeName } from './life-tree.js'
import { writeBlockReason } from './git-guard.js'
import { cleanFolderRel, type ProjectRow } from './projects.js'

/** Egy feltoltott fajl felso hatara. A nagyobbat a Windows Intezoben kell a
 *  mappaba huzni -- a felulet megmutatja, hova. */
export const PROJECT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024
export const NOTE_MAX_CHARS = 200_000

export type FileErrorCode =
  | 'no_folder' | 'no_depot' | 'missing' | 'unreachable' | 'bad_folder' | 'bad_name' | 'repo_inside' | 'write_failed'

export type FileTarget = { ok: true; dirAbs: string; dirRel: string } | { ok: false; code: FileErrorCode; message?: string }

/** A projekt mappaja (vagy annak `sub` almappaja) mint iras-cel. A mappa
 *  allapotkodjai ugyanazok, mint az Attekintesen (`project-overview.ts`):
 *  "nincs Raktar", "nincs mappa", "nem erem el", "eltunt" -- negy kulon teendo. */
export function projectFileTarget(p: ProjectRow, sub: unknown): FileTarget {
  if (!explorerRoot()) return { ok: false, code: 'no_depot' }
  if (!p.folder_path) return { ok: false, code: 'no_folder' }
  const base = resolveLifePath(p.folder_path)
  if (!base) return { ok: false, code: 'unreachable' }
  if (!existsSync(base)) return { ok: false, code: 'missing' }
  const subRel = sub === undefined || sub === null || String(sub).trim() === '' ? '' : cleanFolderRel(sub)
  if (subRel === null) return { ok: false, code: 'bad_folder' }
  const abs = subRel ? resolveLifePath(`${p.folder_path}/${subRel}`) : base
  // A projekt mappajan KIVULRE nem vezethet egy almappa-nev sem.
  if (!abs || (abs !== base && !abs.startsWith(base + sep))) return { ok: false, code: 'bad_folder' }
  if (!existsSync(abs)) return { ok: false, code: 'bad_folder' }
  try { if (!statSync(abs).isDirectory()) return { ok: false, code: 'bad_folder' } } catch { return { ok: false, code: 'unreachable' } }
  return { ok: true, dirAbs: abs, dirRel: toLifeRel(abs) || (subRel ? `${p.folder_path}/${subRel}` : p.folder_path) }
}

/** A projekt mappajanak kozvetlen almappai (a "hova keruljon" valasztohoz).
 *  A rejtett mappak (`.git`, `.kuka`, ...) nem. */
export function projectSubfolders(p: ProjectRow): string[] {
  const t = projectFileTarget(p, '')
  if (!t.ok) return []
  try {
    return readdirSync(t.dirAbs, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'hu'))
  } catch {
    return []
  }
}

/** Biztonsagos fajlnev: a Windows tiltott jelei nelkul, a kiterjesztes marad. */
export function safeFileName(name: unknown): string | null {
  const raw = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const clean = safeLifeName(raw)
  if (!clean || clean === '_' || clean.startsWith('.')) return null
  return clean.slice(0, 180)
}

/** Szabad nev a mappaban: ha foglalt, `nev (2).ext`, `nev (3).ext`, ... */
export function freeFileName(dirAbs: string, name: string): string {
  if (!existsSync(join(dirAbs, name))) return name
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let i = 2; i < 1000; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!existsSync(join(dirAbs, cand))) return cand
  }
  return `${stem} (${Date.now()})${ext}`
}

export type WriteOutcome =
  | { ok: true; rel: string; name: string; renamed: boolean; bytes: number }
  | { ok: false; code: FileErrorCode; message?: string }

/** Egy fajl kiirasa a projekt mappajaba. Soha nem ir felul. */
export function writeProjectFile(p: ProjectRow, sub: unknown, name: unknown, data: Buffer): WriteOutcome {
  const t = projectFileTarget(p, sub)
  if (!t.ok) return t
  const wanted = safeFileName(name)
  if (!wanted) return { ok: false, code: 'bad_name' }
  const blocked = writeBlockReason(`${t.dirRel}/${wanted}`)
  if (blocked) return { ok: false, code: 'repo_inside', message: blocked }
  const finalName = freeFileName(t.dirAbs, wanted)
  try {
    // `wx`: ha a nev a ket lepes kozott megis foglalt lett, inkabb hiba, mint felulirt fajl.
    writeFileSync(join(t.dirAbs, finalName), data, { flag: 'wx' })
  } catch (e) {
    return { ok: false, code: 'write_failed', message: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, rel: `${t.dirRel}/${finalName}`, name: finalName, renamed: finalName !== wanted, bytes: data.length }
}

/** Uj jegyzet: a nevbol fajlnev, `.md` vagy `.txt` kiterjesztessel. */
export function writeProjectNote(p: ProjectRow, sub: unknown, name: unknown, text: unknown, ext: unknown): WriteOutcome {
  const e = ext === 'txt' ? '.txt' : '.md'
  const base = safeFileName(name)
  if (!base) return { ok: false, code: 'bad_name' }
  const fileName = base.toLowerCase().endsWith(e) ? base : `${base}${e}`
  const body = String(text ?? '').slice(0, NOTE_MAX_CHARS)
  return writeProjectFile(p, sub, fileName, Buffer.from(body, 'utf-8'))
}
