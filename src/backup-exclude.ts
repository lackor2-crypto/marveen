/**
 * WHAT A BACKUP LEAVES OUT (card #350).
 *
 * Boss, 2026-09-24: the depot is ~727 GiB, the free cloud space ~310 GiB, so a
 * backup of a branch must be able to skip parts of it: whole sub-folders
 * (course videos, other people's material) and file types (the MetaTrader
 * tester's `.fxt` work files: 46 files, 242 GiB, regenerated on every test).
 *
 * One list per backup, two kinds of entries, written the way a non-programmer
 * would type them:
 *   - a sub-folder, relative to the backed-up branch:  `Projektek/Axxa`
 *   - a file type:                                      `*.fxt`  (or `.fxt`)
 *
 * Shared by the Drive backup and the MEGA backup, so the two never disagree on
 * what "left out" means.
 */

export const MAX_EXCLUDES = 200

export interface ExcludeRules {
  /** Sub-folders (relative to the backup root, `/`-separated, no edge slashes). */
  dirs: string[]
  /** Lower-case extensions without the dot (`fxt`). */
  exts: string[]
}

function normPath(x: string): string {
  return String(x || '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
}

/**
 * Clean a user-typed list. Returns the canonical entries plus the ones that
 * could not be understood, so the UI can say WHICH line was wrong instead of
 * silently dropping it.
 */
export function normalizeExcludes(input: unknown): { list: string[]; invalid: string[] } {
  const raw: string[] = Array.isArray(input)
    ? input.map((x) => String(x ?? ''))
    : String(input ?? '').split(/[\n,;]+/)
  const list: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    const s = r.trim()
    if (!s) continue
    let canon: string | null = null
    const ext = /^\*?\.([A-Za-z0-9_-]{1,16})$/.exec(s)
    if (ext) {
      canon = '*.' + ext[1].toLowerCase()
    } else {
      const p = normPath(s)
      // A folder: no parent hops, no wildcards (we do not pretend to support globs).
      if (p && !p.split('/').some((seg) => seg === '..' || seg === '.') && !/[*?]/.test(p)) canon = p
    }
    if (!canon) { invalid.push(s); continue }
    const key = canon.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    list.push(canon)
    if (list.length >= MAX_EXCLUDES) break
  }
  return { list, invalid }
}

export function excludeRules(list: readonly string[] | undefined): ExcludeRules {
  const dirs: string[] = []
  const exts: string[] = []
  for (const e of list || []) {
    if (e.startsWith('*.')) exts.push(e.slice(2).toLowerCase())
    else dirs.push(normPath(e))
  }
  return { dirs, exts }
}

/** Is this path (relative to the backup root) inside an excluded folder? */
export function isExcludedDir(rules: ExcludeRules, rel: string): boolean {
  const p = normPath(rel).toLowerCase()
  if (!p) return false
  return rules.dirs.some((d) => {
    const dl = d.toLowerCase()
    return p === dl || p.startsWith(dl + '/')
  })
}

/** Is this file (relative to the backup root) left out, by type or by folder? */
export function isExcludedFile(rules: ExcludeRules, rel: string): boolean {
  const p = normPath(rel)
  const dot = p.lastIndexOf('.')
  const slash = p.lastIndexOf('/')
  if (dot > slash) {
    const ext = p.slice(dot + 1).toLowerCase()
    if (rules.exts.includes(ext)) return true
  }
  const dir = slash > -1 ? p.slice(0, slash) : ''
  return dir ? isExcludedDir(rules, dir) : false
}
