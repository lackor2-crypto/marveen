// The retired `Média/Videók` folder (kanban #464, Boss 2026-10-03).
//
// Boss: "a média alatt a videókat megszüntetni. ne is generálja le [...] és a
// videókból tedd át a videókat a fotók alá a megfelelő családhoz." The photos
// and the videos of one event belong together (Vállóper, Amerika, Ismerkedés),
// so `Fotók` is now the shared home of both and `Videók` is no longer planned
// (see MEDIA_KINDS in life-tree.ts).
//
// Installs that already have a `Videók` folder keep it on disk: nothing here
// deletes. This module only OFFERS (and, on the owner's click, performs) the
// move of the files that still sit in it into the matching place under
// `Fotók` -- `Videók/Mykael család/x.mp4` -> `Fotók/Mykael család/x.mp4`.
//
// Rules, same as the Explorer's own move:
//  - never overwrite: a same-name file stays where it is and is reported;
//  - never delete: the (then empty) `Videók` folders are left for the owner;
//  - labels / archived marks / the paper register follow the file, because the
//    move goes through `moveLife()` itself.
import { existsSync, mkdirSync, readdirSync, type Dirent } from 'node:fs'
import { dirname } from 'node:path'
import { APP_LANG } from './config.js'
import { lifeName, loadLifeConfig, planLifeTree, type LifeConfig } from './life-tree.js'
import { moveLife, resolveLifePath } from './life-explorer.js'
import { logger } from './logger.js'

/** One file that would move: both are paths relative to the life-tree root. */
export interface VideoMove { from: string; to: string }

export interface LegacyVideosPlan {
  /** Files that can move now. */
  moves: VideoMove[]
  /** Files whose target name is already taken: they stay, nothing is overwritten. */
  clashes: VideoMove[]
  /** The legacy `Videók` folders that still hold files (relative paths). */
  folders: string[]
  /**
   * Folders directly under `Fotók` that do not exist yet and would be created
   * (e.g. a group name spelled differently from the existing folder): the
   * preview shows them so a near-duplicate never appears silently.
   */
  newFolders: string[]
  /** True when the walk stopped at the safety cap: run it again after the move. */
  truncated: boolean
}

/** Safety cap per plan: a huge legacy folder is moved in several rounds. */
const MAX_FILES = 20000

/** Windows / macOS housekeeping files: never moved, never counted. */
const IGNORED = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

function ignorable(name: string): boolean {
  return name.startsWith('.') || IGNORED.has(name.toLowerCase())
}

/**
 * Every file still inside a legacy `Média/Videók` folder, and where it goes.
 * Reads the disk only; nothing is touched. The folders are located through the
 * same plan the tree is built from, so a person or company added later is
 * covered with no hand-kept list.
 */
export function planLegacyVideos(
  cfg: LifeConfig = loadLifeConfig(),
  lang: string = APP_LANG,
): LegacyVideosPlan {
  const out: LegacyVideosPlan = { moves: [], clashes: [], folders: [], newFolders: [], truncated: false }
  let seen = 0
  const videosName = lifeName('videos', lang)
  const photosName = lifeName('photos', lang)

  for (const node of planLifeTree(cfg, lang)) {
    if (node.kind !== 'category' || node.key !== 'media') continue
    const legacyRel = `${node.rel}/${videosName}`
    const photosRel = `${node.rel}/${photosName}`
    const legacyAbs = resolveLifePath(legacyRel)
    if (!legacyAbs || !existsSync(legacyAbs)) continue

    let hadFiles = false
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
        hadFiles = true
        const to = `${photosRel}/${childRel.slice(legacyRel.length + 1)}`
        const toAbs = resolveLifePath(to)
        if (toAbs && existsSync(toAbs)) { out.clashes.push({ from: childRel, to }); continue }
        out.moves.push({ from: childRel, to })
        // The first folder under Fotók on the way to the file: new?
        const first = childRel.slice(legacyRel.length + 1).split('/')
        if (first.length > 1) {
          const topRel = `${photosRel}/${first[0]}`
          const topAbs = resolveLifePath(topRel)
          if (topAbs && !existsSync(topAbs) && !out.newFolders.includes(topRel)) out.newFolders.push(topRel)
        }
      }
    }
    walk(legacyRel)
    if (hadFiles) out.folders.push(legacyRel)
  }
  return out
}

export interface LegacyVideosResult {
  ok: boolean
  moved: number
  /** Same-name files that were left in place (nothing was overwritten). */
  skipped: VideoMove[]
  failed: Array<{ rel: string; error: string }>
  message: string
}

/**
 * Move the legacy videos under `Fotók`, file by file, through `moveLife()`.
 * A failure of one file does not stop the others; the end says what did not go.
 */
export function moveLegacyVideos(
  cfg: LifeConfig = loadLifeConfig(),
  lang: string = APP_LANG,
  msgLang: string = lang,
): LegacyVideosResult {
  const hu = msgLang !== 'en'
  const plan = planLegacyVideos(cfg, lang)
  const skipped: VideoMove[] = [...plan.clashes]
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
  logger.info({ moved, skipped: skipped.length, failed: failed.length }, '[eletfa] regi Videok mappa tartalma a Fotok ala')
  return { ok: failed.length === 0, moved, skipped, failed, message }
}
