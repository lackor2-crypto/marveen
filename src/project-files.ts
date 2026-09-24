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
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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

/** A projekt mappajanak almappai, a MELYEBBEK is ('Media/Fotok'), relativ
 *  utkent -- a "hova keruljon" valasztohoz es a javasolt helyhez. Korlatos
 *  bejaras (melyseg, darabszam). Kimarad: a rejtett mappa (`.git`, `.kuka`),
 *  a `node_modules`, es a git-tarolo (abba nem irunk -- git-guard). */
export const SUBFOLDER_MAX_DEPTH = 4
export const SUBFOLDER_MAX = 400

export function projectSubfolders(p: ProjectRow): string[] {
  const t = projectFileTarget(p, '')
  if (!t.ok) return []
  const out: string[] = []
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > SUBFOLDER_MAX_DEPTH || out.length >= SUBFOLDER_MAX) return
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    const dirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .sort((a, b) => a.name.localeCompare(b.name, 'hu'))
    for (const d of dirs) {
      if (out.length >= SUBFOLDER_MAX) return
      const childAbs = join(abs, d.name)
      if (existsSync(join(childAbs, '.git'))) continue
      const childRel = rel ? `${rel}/${d.name}` : d.name
      out.push(childRel)
      walk(childAbs, childRel, depth + 1)
    }
  }
  walk(t.dirAbs, '', 1)
  return out
}

export type MkdirOutcome = { ok: true; sub: string; created: boolean } | { ok: false; code: FileErrorCode | 'folder_name'; message?: string }

/** Uj almappa a projektben -- CSAK a felhasznalo "Rendben" gombjara hivodik.
 *  `parent`: meglevo almappa ('' = a projekt fomappaja); `name`: egy vagy tobb
 *  szint ('Media/Fotok'). A projekt mappajan kivulre nem vezethet, git-taroloba
 *  nem ir; ha mar letezik, azt hasznaljuk (nem hiba). */
export function makeProjectFolder(p: ProjectRow, parent: unknown, name: unknown): MkdirOutcome {
  const par = projectFileTarget(p, parent)
  if (!par.ok) return par
  const segs = String(name ?? '').replace(/\\/g, '/').split('/').map((x) => x.trim()).filter(Boolean)
  if (!segs.length || segs.length > 4) return { ok: false, code: 'folder_name' }
  const clean = segs.map((x) => safeLifeName(x))
  if (clean.some((x, i) => !x || x === '_' || x.startsWith('.') || x.length > 120 || x !== segs[i])) return { ok: false, code: 'folder_name' }
  const parentSub = parent === undefined || parent === null || String(parent).trim() === '' ? '' : (cleanFolderRel(parent) ?? '')
  const sub = parentSub ? `${parentSub}/${clean.join('/')}` : clean.join('/')
  const base = projectFileTarget(p, '')
  if (!base.ok) return base
  const abs = join(par.dirAbs, ...clean)
  if (!abs.startsWith(base.dirAbs + sep)) return { ok: false, code: 'bad_folder' }
  const rel = `${par.dirRel}/${clean.join('/')}`
  const blocked = writeBlockReason(rel)
  if (blocked) return { ok: false, code: 'repo_inside', message: blocked }
  if (existsSync(abs)) {
    try { if (!statSync(abs).isDirectory()) return { ok: false, code: 'bad_folder' } } catch { return { ok: false, code: 'unreachable' } }
    return { ok: true, sub, created: false }
  }
  try { mkdirSync(abs, { recursive: true }) } catch (e) {
    return { ok: false, code: 'write_failed', message: e instanceof Error ? e.message : String(e) }
  }
  return { ok: true, sub, created: true }
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

// ---- Fajlok ful: mapparendszer + kereso (kanban #359) ----------------------
//
// A Fajlok ful eddig a legutobb modositott fajlokat ONTOTTE egy lapos listaba
// -- egy MetaTrader-mappanal (mt4/tester/*.set, history/*.hst) ez
// atlathatatlan. Most a projekt mappaja szintenkent jon (a felulet
// lenyitaskor kerdezi le a kovetkezo szintet), es van egy kereso, ami CSAK a
// projekt mappajaban keres. Csak OLVAS: se irni, se torolni nem tud.

export const TREE_DIR_MAX = 1000
export const FIND_MAX_HITS = 200
export const FIND_MAX_VISIT = 20000
export const FIND_MAX_DEPTH = 12

export type TreeEntry = { name: string; sub: string; kind: 'dir' | 'file'; at: number; size?: number; children?: number }
export type DirListing = { ok: true; sub: string; entries: TreeEntry[]; truncated: boolean } | { ok: false; code: FileErrorCode }

const hiddenEntry = (name: string): boolean => name.startsWith('.') || name === 'node_modules'
  // A Windows mappa-segedfajljai nem a felhasznalo fajljai (lasd #370).
  || /^(desktop\.ini|thumbs\.db)$/i.test(name)

/** A projekt mappajanak (vagy egy almappajanak) EGY szintje: elol a mappak,
 *  utana a fajlok, mindketto nev szerint. A mappanal a kozvetlen tartalom
 *  darabszama is jon, hogy a felulet ki tudja irni ("12 elem"). */
export function listProjectDir(p: ProjectRow, sub: unknown): DirListing {
  const t = projectFileTarget(p, sub)
  if (!t.ok) return { ok: false, code: t.code }
  const subRel = sub === undefined || sub === null || String(sub).trim() === '' ? '' : (cleanFolderRel(sub) ?? '')
  let entries: import('node:fs').Dirent[]
  try { entries = readdirSync(t.dirAbs, { withFileTypes: true }) } catch { return { ok: false, code: 'unreachable' } }
  const out: TreeEntry[] = []
  for (const e of entries) {
    if (hiddenEntry(e.name)) continue
    const full = join(t.dirAbs, e.name)
    const childSub = subRel ? `${subRel}/${e.name}` : e.name
    let st: import('node:fs').Stats
    try { st = statSync(full) } catch { continue /* eltunt kozben, vagy torott link */ }
    if (st.isDirectory()) {
      let children = 0
      try { children = readdirSync(full).filter((n) => !hiddenEntry(n)).length } catch { /* nem olvashato: 0 marad */ }
      out.push({ name: e.name, sub: childSub, kind: 'dir', at: st.mtimeMs, children })
    } else if (st.isFile()) {
      out.push({ name: e.name, sub: childSub, kind: 'file', at: st.mtimeMs, size: st.size })
    }
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'hu', { numeric: true }) : a.kind === 'dir' ? -1 : 1))
  return { ok: true, sub: subRel, entries: out.slice(0, TREE_DIR_MAX), truncated: out.length > TREE_DIR_MAX }
}

/** Ekezet- es kisbetu-fuggetlen osszehasonlitashoz. */
export function foldName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

export type FindResult =
  | { ok: true; q: string; hits: TreeEntry[]; truncated: boolean }
  | { ok: false; code: FileErrorCode | 'query_short' }

/** Fajl- es mappanev-kereses CSAK a projekt mappajaban (a Raktar tobbi resze
 *  nem jon elo). A `truncated` kulon mondja ki, ha a bejaras a korlatba
 *  utkozott -- igy a "0 talalat" nem keverheto ossze azzal, hogy "nem neztem
 *  vegig mindent". */
export function findProjectFiles(p: ProjectRow, q: unknown): FindResult {
  const query = String(q ?? '').trim()
  if (query.length < 2) return { ok: false, code: 'query_short' }
  const t = projectFileTarget(p, '')
  if (!t.ok) return { ok: false, code: t.code }
  const needle = foldName(query)
  const hits: TreeEntry[] = []
  let visited = 0
  let truncated = false // korlatba utkoztunk: a bejaras leallt
  let tooDeep = false // egy agat a melyseg-korlat miatt nem neztunk vegig
  const walk = (abs: string, rel: string, depth: number): void => {
    if (truncated) return
    if (depth > FIND_MAX_DEPTH) { tooDeep = true; return }
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'hu', { numeric: true }))
    for (const e of entries) {
      if (hiddenEntry(e.name)) continue
      if (++visited > FIND_MAX_VISIT) { truncated = true; return }
      const full = join(abs, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const isDir = e.isDirectory()
      if (foldName(e.name).includes(needle)) {
        if (hits.length >= FIND_MAX_HITS) { truncated = true; return }
        try {
          const st = statSync(full)
          hits.push(isDir
            ? { name: e.name, sub: childRel, kind: 'dir', at: st.mtimeMs }
            : { name: e.name, sub: childRel, kind: 'file', at: st.mtimeMs, size: st.size })
        } catch { /* eltunt kozben */ }
      }
      if (isDir) walk(full, childRel, depth + 1)
      if (truncated) return
    }
  }
  walk(t.dirAbs, '', 1)
  return { ok: true, q: query, hits, truncated: truncated || tooDeep }
}
