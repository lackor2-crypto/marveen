// The retired `Média` type folders (kanban #464, Boss 2026-10-03).
//
// Boss: "a média alatt a videókat megszüntetni. ne is generálja le [...] és a
// videókból tedd át a videókat a fotók alá a megfelelő családhoz", then for the
// rest: the sound goes with the event's photos, the scans are paperwork. The
// photos, videos and recordings of one event belong together (Vállóper, Amerika,
// Ismerkedés), so `Fotók` is the one shared home and `Videók`, `Audió`,
// `Szkennek` are no longer planned (see MEDIA_KINDS in life-tree.ts).
//
// Installs that already have those folders keep them on disk: nothing here
// deletes. This module only OFFERS (and, on the owner's click, performs) the
// move of the files that still sit in `Videók` and `Audió` into the matching
// place under `Fotók` -- `Videók/Mykael család/x.mp4` -> `Fotók/Mykael család/x.mp4`.
//
// `Szkennek` is only COUNTED, never moved: a scanned letter or contract is a
// document that has to be filed by category (the Beérkező sorter does that), so
// guessing a folder for it here would be wrong.
//
// Rules, same as the Explorer's own move:
//  - never overwrite: a same-name file stays where it is and is reported;
//  - never delete: the (then empty) legacy folders are left for the owner;
//  - labels / archived marks / the paper register follow the file, because the
//    move goes through `moveLife()` itself.
import { existsSync, mkdirSync, readdirSync, type Dirent } from 'node:fs'
import { dirname } from 'node:path'
import { APP_LANG } from './config.js'
import { lifeName, loadLifeConfig, planLifeTree, type LifeConfig } from './life-tree.js'
import { moveLife, resolveLifePath } from './life-explorer.js'
import { logger } from './logger.js'

/** One file that would move: both are paths relative to the life-tree root. */
export interface FileMove { from: string; to: string }

export interface LegacyMediaPlan {
  /** Files that can move now. */
  moves: FileMove[]
  /** Files whose target name is already taken: they stay, nothing is overwritten. */
  clashes: FileMove[]
  /** The legacy folders that still hold files that can move (relative paths). */
  folders: string[]
  /**
   * Folders directly under `Fotók` that do not exist yet and would be created
   * (e.g. a group name spelled differently from the existing folder): the
   * preview shows them so a near-duplicate never appears silently.
   */
  newFolders: string[]
  /** Files still inside a legacy `Szkennek` folder: paperwork, reported only. */
  scans: number
  /** True when the walk stopped at the safety cap: run it again after the move. */
  truncated: boolean
}

/** Type folders whose files move under `Fotók`. */
const MOVE_KINDS = ['videos', 'audio'] as const

/** Safety cap per plan: a huge legacy folder is moved in several rounds. */
const MAX_FILES = 20000

/** Windows / macOS housekeeping files: never moved, never counted. */
const IGNORED = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

function ignorable(name: string): boolean {
  return name.startsWith('.') || IGNORED.has(name.toLowerCase())
}

/**
 * Every file still inside a legacy `Média/Videók` or `Média/Audió` folder and
 * where it goes, plus the count of files left in `Média/Szkennek`. Reads the
 * disk only; nothing is touched. The folders are located through the same plan
 * the tree is built from, so a person or company added later is covered with no
 * hand-kept list.
 */
export function planLegacyMedia(
  cfg: LifeConfig = loadLifeConfig(),
  lang: string = APP_LANG,
): LegacyMediaPlan {
  const out: LegacyMediaPlan = { moves: [], clashes: [], folders: [], newFolders: [], scans: 0, truncated: false }
  let seen = 0
  const photosName = lifeName('photos', lang)

  /** Calls `onFile` for every real file under `rootRel`; stops at the cap. */
  const eachFile = (rootRel: string, onFile: (fileRel: string) => void): void => {
    const walk = (dirRel: string): void => {
      if (out.truncated) return
      const abs = resolveLifePath(dirRel)
      if (!abs) return
      let entries: Dirent[] = []
      try { entries = readdirSync(abs, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (out.truncated) return
        if (ignorable(e.name)) continue
        const childRel = `${dirRel}/${e.name}`
        if (e.isDirectory()) { walk(childRel); continue }
        // Symlinks and other special entries are not ours to move.
        if (!e.isFile()) continue
        if (++seen > MAX_FILES) { out.truncated = true; return }
        onFile(childRel)
      }
    }
    walk(rootRel)
  }

  for (const node of planLifeTree(cfg, lang)) {
    if (node.kind !== 'category' || node.key !== 'media') continue
    const photosRel = `${node.rel}/${photosName}`

    for (const kind of MOVE_KINDS) {
      const legacyRel = `${node.rel}/${lifeName(kind, lang)}`
      const legacyAbs = resolveLifePath(legacyRel)
      if (!legacyAbs || !existsSync(legacyAbs)) continue

      let hadFiles = false
      eachFile(legacyRel, (childRel) => {
        hadFiles = true
        const sub = childRel.slice(legacyRel.length + 1)
        const to = `${photosRel}/${sub}`
        const toAbs = resolveLifePath(to)
        if (toAbs && existsSync(toAbs)) { out.clashes.push({ from: childRel, to }); return }
        out.moves.push({ from: childRel, to })
        // The first folder under Fotók on the way to the file: new?
        const first = sub.split('/')
        if (first.length > 1) {
          const topRel = `${photosRel}/${first[0]}`
          const topAbs = resolveLifePath(topRel)
          if (topAbs && !existsSync(topAbs) && !out.newFolders.includes(topRel)) out.newFolders.push(topRel)
        }
      })
      if (hadFiles) out.folders.push(legacyRel)
    }

    // Paperwork is only counted: it needs filing by category, not a guess.
    const scansRel = `${node.rel}/${lifeName('scans', lang)}`
    const scansAbs = resolveLifePath(scansRel)
    if (scansAbs && existsSync(scansAbs)) eachFile(scansRel, () => { out.scans++ })
  }
  return out
}

export interface LegacyMediaResult {
  ok: boolean
  moved: number
  /** Same-name files that were left in place (nothing was overwritten). */
  skipped: FileMove[]
  failed: Array<{ rel: string; error: string }>
  message: string
}

/**
 * Move the legacy videos and recordings under `Fotók`, file by file, through
 * `moveLife()`. A failure of one file does not stop the others; the end says
 * what did not go.
 */
export function moveLegacyMedia(
  cfg: LifeConfig = loadLifeConfig(),
  lang: string = APP_LANG,
  msgLang: string = lang,
): LegacyMediaResult {
  const hu = msgLang !== 'en'
  const plan = planLegacyMedia(cfg, lang)
  const skipped: FileMove[] = [...plan.clashes]
  const failed: Array<{ rel: string; error: string }> = []
  let moved = 0

  for (const m of plan.moves) {
    const toAbs = resolveLifePath(m.to)
    if (!toAbs) { failed.push({ rel: m.from, error: 'outside' }); continue }
    try {
      // The target family folder may not exist under Fotók yet.
      mkdirSync(dirname(toAbs), { recursive: true })
    } catch (err: any) {
      failed.push({ rel: m.from, error: String(err?.code || err?.message || err) })
      continue
    }
    const toDirRel = m.to.split('/').slice(0, -1).join('/')
    const r = moveLife(m.from, toDirRel, lang)
    if (r.ok) moved++
    // A name clash that appeared after the plan was read: skipped, not an error.
    else if (r.code === 'exists') skipped.push(m)
    else failed.push({ rel: m.from, error: r.code || r.message })
  }

  const message = failed.length
    ? (hu
      ? `${moved} fájl átkerült a Fotók alá, ${failed.length} nem sikerült. Nézd meg a jogosultságokat.`
      : `${moved} file${moved === 1 ? '' : 's'} moved under Photos, ${failed.length} failed. Check the permissions.`)
    : moved
      ? (hu
        ? `Kész: ${moved} fájl átkerült a Fotók alá.${skipped.length ? ` ${skipped.length} azonos nevű fájlt nem írtam felül.` : ''}`
        : `Done: ${moved} file${moved === 1 ? '' : 's'} moved under Photos.${skipped.length ? ` ${skipped.length} same-name file${skipped.length === 1 ? ' was' : 's were'} left alone.` : ''}`)
      : (hu ? 'Nem volt mit áthelyezni.' : 'There was nothing to move.')
  logger.info({ moved, skipped: skipped.length, failed: failed.length }, '[eletfa] regi Videok/Audio mappak tartalma a Fotok ala')
  return { ok: failed.length === 0, moved, skipped, failed, message }
}
