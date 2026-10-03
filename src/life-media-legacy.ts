// The retired `Média` type folders (kanban #464, Boss 2026-10-03).
//
// Boss (#464, B valtozat): the media type (photo/video/audio) is a search FILTER,
// not a folder. One event's photos, videos and recordings belong together, so the
// structure is `Média/[ország/]csoport/esemeny` with NO `Fotók`/`Videók`/`Audió`
// level (see MEDIA_KINDS / defaultMediaKinds in life-tree.ts).
//
// Installs that already have those type folders keep them on disk: nothing here
// deletes. This module only OFFERS (and, on the owner's click, performs) moving
// the files still sitting in `Fotók`, `Videók` and `Audió` UP under Média, keeping
// the group/event sub-structure -- `Fotók/Mykael család/x.jpg` -> `Mykael család/x.jpg`
// under Média. On success the saved config switches to the flat model.
//
// `Szkennek` is only COUNTED, never moved: a scanned letter or contract is a
// document that has to be filed by category (via the Beérkező), so guessing a
// folder for it here would be wrong -- the preview tells the owner to move it there.
//
// Rules, same as the Explorer's own move:
//  - never overwrite: a same-name file stays where it is and is reported;
//  - never delete: the (then empty) type folders are left for the owner;
//  - labels / archived marks / the paper register follow the file, because the
//    move goes through `moveLife()` itself; a FOLDER's own mark (an archived or
//    renamed event folder) follows its folder, and an empty event folder is
//    created under Média too, so the structure moves up whole.
//
// An install still on the type-folder model with NOTHING to move (an old, empty
// skeleton) gets the same button: the run then only switches the model.
import { mkdirSync, type Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { APP_LANG } from './config.js'
import { lifeName, loadLifeConfig, saveLifeConfig, planLifeTree, type LifeConfig } from './life-tree.js'
import { moveLife, resolveLifePath } from './life-explorer.js'
import { moveArchivedPrefix } from './life-archived.js'
import { moveDisplayLabels } from './life-labels.js'
import { movePhysical } from './life-documents.js'
import { logger } from './logger.js'

/** One file that would move: both are paths relative to the life-tree root. */
export interface FileMove { from: string; to: string }

export interface LegacyMediaPlan {
  /** Files that can move now. */
  moves: FileMove[]
  /** Files whose target name is already taken: they stay, nothing is overwritten. */
  clashes: FileMove[]
  /**
   * Every sub-folder of a legacy type folder and its place under Média. The run
   * creates each (so an EMPTY event folder moves up too) and carries the folder's
   * own label / archived mark / paper record to it.
   */
  dirs: FileMove[]
  /** The legacy folders that still hold files that can move (relative paths). */
  folders: string[]
  /**
   * Folders directly under Média that do not exist yet and would be created
   * (e.g. a group name spelled differently from the existing folder): the
   * preview shows them so a near-duplicate never appears silently.
   */
  newFolders: string[]
  /** Files still inside a legacy `Szkennek` folder: paperwork, reported only. */
  scans: number
  /** True when the walk stopped at the safety cap: run it again after the move. */
  truncated: boolean
  /**
   * True while a person's saved config still plans the type folders: the run
   * switches it to the flat model even when there is no file to move.
   */
  pending: boolean
}

/** Type folders whose files move UP under Média. `scans` is NOT here (paperwork). */
const MOVE_KINDS = ['photos', 'videos', 'audio'] as const

/** Safety cap per plan: a huge legacy folder is moved in several rounds. */
const MAX_FILES = 20000

/** Windows / macOS housekeeping files: never moved, never counted. */
const IGNORED = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

function ignorable(name: string): boolean {
  return name.startsWith('.') || IGNORED.has(name.toLowerCase())
}

/**
 * Yield to the event loop this often while walking, so a huge tree on a SLOW
 * mount (the life tree can live on a WSL `/mnt` drive) never blocks the dashboard.
 * The old synchronous walk froze every request for minutes on a 14k-photo folder.
 */
const YIELD_EVERY = 400

/**
 * Every file still inside a legacy `Média/Fotók|Videók|Audió` folder and where it
 * goes, plus the count of files left in `Média/Szkennek`. Reads the disk only;
 * nothing is touched. ASYNC and yielding on purpose: the walk must not block the
 * single Node event loop (see YIELD_EVERY). Clash detection reads each TARGET
 * directory ONCE (cached Set), never one `exists` call per file -- on a 14k-file
 * folder that is the difference between a few directory reads and 14k slow stats.
 */
export async function planLegacyMedia(
  cfg: LifeConfig = loadLifeConfig(),
  lang: string = APP_LANG,
): Promise<LegacyMediaPlan> {
  const out: LegacyMediaPlan = {
    moves: [], clashes: [], dirs: [], folders: [], newFolders: [], scans: 0, truncated: false,
    pending: cfg.persons.some((p) => (p.mediaKinds || []).length > 0),
  }
  let seen = 0
  let sinceYield = 0
  const yieldMaybe = async (): Promise<void> => {
    if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; await new Promise((r) => setImmediate(r)) }
  }

  /** A directory's entry-name Set, read once (async). null = the folder does not exist. */
  const dirCache = new Map<string, Set<string> | null>()
  const listing = async (rel: string): Promise<Set<string> | null> => {
    const cached = dirCache.get(rel)
    if (cached !== undefined) return cached
    const abs = resolveLifePath(rel)
    let set: Set<string> | null = null
    if (abs) { try { set = new Set(await readdir(abs)) } catch { set = null } }
    dirCache.set(rel, set)
    return set
  }

  /** Calls `onFile` for every real file (and `onDir` for every sub-folder) under `rootRel`; stops at the cap; yields. */
  const eachFile = async (
    rootRel: string,
    onFile: (fileRel: string) => Promise<void> | void,
    onDir?: (dirRel: string) => void,
  ): Promise<void> => {
    const walk = async (dirRel: string): Promise<void> => {
      if (out.truncated) return
      const abs = resolveLifePath(dirRel)
      if (!abs) return
      let entries: Dirent[] = []
      try { entries = await readdir(abs, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (out.truncated) return
        if (ignorable(e.name)) continue
        const childRel = `${dirRel}/${e.name}`
        if (e.isDirectory()) { onDir?.(childRel); await walk(childRel); continue }
        // Symlinks and other special entries are not ours to move.
        if (!e.isFile()) continue
        if (++seen > MAX_FILES) { out.truncated = true; return }
        await yieldMaybe()
        await onFile(childRel)
      }
    }
    await walk(rootRel)
  }

  for (const node of planLifeTree(cfg, lang)) {
    if (node.kind !== 'category' || node.key !== 'media') continue
    const mediaRel = node.rel // the target base: files move straight under Média
    const mediaListing = await listing(mediaRel) // which top folders already exist under Média

    /** `top` is the first folder under Média on the way to a moved item: note it when it is new. */
    const noteNew = (top: string): void => {
      const topRel = `${mediaRel}/${top}`
      if ((!mediaListing || !mediaListing.has(top)) && !out.newFolders.includes(topRel)) out.newFolders.push(topRel)
    }

    for (const kind of MOVE_KINDS) {
      const legacyRel = `${mediaRel}/${lifeName(kind, lang)}`
      let hadFiles = false
      await eachFile(legacyRel, async (childRel) => {
        hadFiles = true
        const sub = childRel.slice(legacyRel.length + 1)
        const to = `${mediaRel}/${sub}`
        const parts = sub.split('/')
        const name = parts[parts.length - 1]
        const toDirRel = to.slice(0, to.length - name.length - 1)
        // Clash = the target directory already has a file of this name. One cached
        // directory read instead of a stat per file.
        const targetSet = await listing(toDirRel)
        if (targetSet && targetSet.has(name)) { out.clashes.push({ from: childRel, to }); return }
        out.moves.push({ from: childRel, to })
        if (parts.length > 1) noteNew(parts[0])
      }, (dirRel) => {
        const sub = dirRel.slice(legacyRel.length + 1)
        out.dirs.push({ from: dirRel, to: `${mediaRel}/${sub}` })
        noteNew(sub.split('/')[0])
      })
      if (hadFiles) out.folders.push(legacyRel)
    }

    // Paperwork is only counted: it needs filing by category, not a guess.
    await eachFile(`${mediaRel}/${lifeName('scans', lang)}`, () => { out.scans++ })
  }
  return out
}

export interface LegacyMediaResult {
  ok: boolean
  moved: number
  /** Same-name files that were left in place (nothing was overwritten). */
  skipped: FileMove[]
  failed: Array<{ rel: string; error: string }>
  /** True when the saved config was switched to the new flat model. */
  switched: boolean
  message: string
}

/**
 * Switch every person's saved `mediaKinds` to empty, so the tree stops planning
 * the type folders (the flat `Média/[ország/]csoport` model). Returns true when
 * the config actually changed. The disk is NOT touched -- an emptied type folder
 * simply leaves the generated tree.
 */
export function switchToFlatMedia(cfg: LifeConfig): boolean {
  let changed = false
  for (const p of cfg.persons) {
    if (Array.isArray(p.mediaKinds) && p.mediaKinds.length > 0) { p.mediaKinds = []; changed = true }
  }
  if (changed) saveLifeConfig(cfg)
  return changed
}

/**
 * Move the files of the legacy `Fotók`, `Videók` and `Audió` folders up under
 * Média (group/event sub-structure kept), file by file, through `moveLife()`. A
 * failure of one file does not stop the others; the end says what did not go.
 */
export async function moveLegacyMedia(
  cfg: LifeConfig = loadLifeConfig(),
  lang: string = APP_LANG,
  msgLang: string = lang,
): Promise<LegacyMediaResult> {
  const hu = msgLang !== 'en'
  const plan = await planLegacyMedia(cfg, lang)
  const skipped: FileMove[] = [...plan.clashes]
  const failed: Array<{ rel: string; error: string }> = []
  let moved = 0
  let sinceYield = 0

  for (const m of plan.moves) {
    // moveLife is synchronous; yield between files so a big move keeps the
    // dashboard responsive on a slow mount.
    if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; await new Promise((r) => setImmediate(r)) }
    const toAbs = resolveLifePath(m.to)
    if (!toAbs) { failed.push({ rel: m.from, error: 'outside' }); continue }
    try {
      // The target group/event folder may not exist under Média yet.
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

  // The folders themselves: an EMPTY event folder moves up too (created under
  // Média), and a folder's OWN label / archived mark / paper record goes to its new
  // place. `exact`: the marks of the files under it already went with each file (and
  // a same-name file left in place keeps its own), and a mark the target folder
  // already has is never overwritten.
  for (const d of plan.dirs) {
    const toAbs = resolveLifePath(d.to)
    if (!toAbs) { failed.push({ rel: d.from, error: 'outside' }); continue }
    try {
      mkdirSync(toAbs, { recursive: true })
    } catch (err: any) {
      failed.push({ rel: d.from, error: String(err?.code || err?.message || err) })
      continue
    }
    movePhysical(d.from, d.to, true)
    moveDisplayLabels(d.from, d.to, true)
    moveArchivedPrefix(d.from, d.to, true)
  }

  // Switch to the flat model only when nothing failed and the walk saw everything:
  // a half-moved folder must not lose its type level in the plan while files are
  // still stuck in it.
  const switched = failed.length === 0 && !plan.truncated ? switchToFlatMedia(cfg) : false
  const more = plan.truncated
    ? (hu ? ' Még maradt áthelyeznivaló: indítsd újra.' : ' There is more to move: run it again.')
    : ''

  const message = failed.length
    ? (hu
      ? `${moved} fájl átkerült a Média alá, ${failed.length} nem sikerült. Nézd meg a jogosultságokat, és futtasd újra.`
      : `${moved} file${moved === 1 ? '' : 's'} moved under Media, ${failed.length} failed. Check the permissions and run it again.`)
    : moved
      ? (hu
        ? `Kész: ${moved} fájl átkerült a Média alá.${skipped.length ? ` ${skipped.length} azonos nevű fájlt nem írtam felül.` : ''}${plan.scans ? ' A Szkennek mappát nem bántottam.' : ''}${more}`
        : `Done: ${moved} file${moved === 1 ? '' : 's'} moved under Media.${skipped.length ? ` ${skipped.length} same-name file${skipped.length === 1 ? ' was' : 's were'} left alone.` : ''}${plan.scans ? ' The Scans folder was left untouched.' : ''}${more}`)
      : switched
        ? (hu ? 'Nem volt mit áthelyezni; a média mostantól típus-mappa nélkül épül.' : 'There was nothing to move; media is now built without a type level.')
        : (hu ? 'Nem volt mit áthelyezni.' : 'There was nothing to move.')
  logger.info({ moved, skipped: skipped.length, failed: failed.length, switched }, '[eletfa] media tipus-mappak lapitasa a Media ala (#464 B)')
  return { ok: failed.length === 0, moved, skipped, failed, switched, message }
}
