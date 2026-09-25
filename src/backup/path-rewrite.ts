/**
 * Where each archived file goes on THIS machine, and which old-machine paths
 * inside the files are rewritten (#396 Phase 4, plan §6.4).
 *
 * Logical roots -> this machine:
 *   project/store/... -> STORE_DIR/...
 *   project/...       -> PROJECT_ROOT/...
 *   home/...          -> HOME/...
 *   config/<owner>/.. -> the config dir recorded in manifest.roots, re-rooted
 *                        under this machine's PROJECT_ROOT or HOME
 *
 * Claude Code keeps a project's memory under projects/<slug>/, where the slug
 * is the working dir with every `/` and `.` turned into `-` (the same encoding
 * as projectsDirFor() in src/web/active-model.ts). A new PROJECT_ROOT means a
 * new slug: without the rewrite the memories land in a folder Claude Code never
 * reads.
 *
 * Only KNOWN places are rewritten. Anything else that still names the old
 * machine is listed as a warning for the preview -- never rewritten silently.
 */
import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeProjectSlug, type BackupManifest } from './create.js'

export interface RestoreCtx { projectRoot: string; storeDir: string; home: string }

export interface Rewrite { from: string; to: string; what: 'project_root' | 'home' | 'slug' }

export function planPathRewrites(hints: BackupManifest['pathHints'], cur: RestoreCtx): Rewrite[] {
  const out: Rewrite[] = []
  if (hints.PROJECT_ROOT && hints.PROJECT_ROOT !== cur.projectRoot) out.push({ from: hints.PROJECT_ROOT, to: cur.projectRoot, what: 'project_root' })
  if (hints.HOME && hints.HOME !== cur.home) out.push({ from: hints.HOME, to: cur.home, what: 'home' })
  const newSlug = claudeProjectSlug(cur.projectRoot)
  if (hints.projectSlug && hints.projectSlug !== newSlug) out.push({ from: hints.projectSlug, to: newSlug, what: 'slug' })
  return out
}

/** A projects/<slug> directory name, moved to this machine's project slug. */
export function rewriteSlug(slug: string, oldSlug: string, newSlug: string): string {
  if (!oldSlug || oldSlug === newSlug) return slug
  if (slug === oldSlug) return newSlug
  // agents/<name> and other dirs under the project root: "<oldSlug>-agents-x"
  if (slug.startsWith(oldSlug + '-')) return newSlug + slug.slice(oldSlug.length)
  return slug
}

/** Replace old absolute prefixes in a string (project root first: it usually sits under home). */
export function rewriteText(text: string, rewrites: Rewrite[]): string {
  let s = text
  for (const w of rewrites.filter((r) => r.what === 'project_root')) s = s.split(w.from).join(w.to)
  for (const w of rewrites.filter((r) => r.what === 'home')) s = s.split(w.from + '/').join(w.to + '/')
  return s
}

/** The absolute target on this machine for a logical archive path, or null if it cannot be placed. */
export function targetFor(logical: string, manifest: BackupManifest, cur: RestoreCtx): string | null {
  const parts = logical.split('/')
  const root = parts[0]
  if (root === 'project') {
    const rest = parts.slice(1)
    if (rest[0] === 'store') return join(cur.storeDir, ...rest.slice(1))
    return join(cur.projectRoot, ...rest)
  }
  if (root === 'home') return join(cur.home, ...parts.slice(1))
  if (root === 'config') {
    const owner = parts[1]
    const r = manifest.roots?.[`config/${owner}`]
    if (!r || !owner) return null
    let base: string
    if (r.base === 'project') base = join(cur.projectRoot, r.rel)
    else if (r.base === 'home') base = join(cur.home, r.rel)
    else {
      const hints = manifest.pathHints
      if (hints.HOME && r.rel.startsWith(hints.HOME + '/')) base = join(cur.home, r.rel.slice(hints.HOME.length + 1))
      else base = r.rel
    }
    const rest = parts.slice(2)
    if (rest[0] === 'projects' && rest[1]) rest[1] = rewriteSlug(rest[1], manifest.pathHints.projectSlug, claudeProjectSlug(cur.projectRoot))
    return join(base, ...rest)
  }
  return null
}

/** Files whose old-machine paths are rewritten on the way in. */
export function isRewritable(logical: string): boolean {
  return /^project\/\.env$/.test(logical)
    || /^project\/store\/(life-mounts|storages|git-sync|drive-sync|config-overrides|life-tree)\.json$/.test(logical)
    || /^project\/agents\/[^/]+\/(agent-config\.json|\.mcp\.json)$/.test(logical)
}

/**
 * Apply the rewrites to the staged copy: known files get their paths replaced,
 * symlinks pointing at the old machine get re-pointed. Returns the logical
 * paths of OTHER small text files that still mention the old machine.
 */
export function applyPathRewrites(stagingDir: string, manifest: BackupManifest, rewrites: Rewrite[]): { rewritten: string[]; stillOld: string[] } {
  const rewritten: string[] = []
  const stillOld: string[] = []
  const absRewrites = rewrites.filter((r) => r.what !== 'slug')
  if (!absRewrites.length) return { rewritten, stillOld }
  for (const f of manifest.files) {
    const p = join(stagingDir, f.path)
    if (isRewritable(f.path)) {
      const before = readFileSync(p, 'utf8')
      const after = rewriteText(before, absRewrites)
      if (after !== before) { writeFileSync(p, after, { mode: f.mode }); rewritten.push(f.path) }
      continue
    }
    if (f.size > 512 * 1024 || /\.(db|bundle|png|jpg|jpeg|gif|webp|pdf|mbk)$/i.test(f.path)) continue
    if (/^config\/[^/]+\/projects\/|\/memory\//.test(f.path)) continue // prose, not settings
    let text = ''
    try { text = readFileSync(p, 'utf8') } catch { continue }
    if (absRewrites.some((r) => text.includes(r.from + (r.what === 'home' ? '/' : '')))) stillOld.push(f.path)
  }
  for (const l of manifest.links ?? []) {
    const p = join(stagingDir, l.path)
    const next = rewriteText(l.target, absRewrites)
    if (next === l.target) continue
    try {
      if (lstatSync(p).isSymbolicLink() && readlinkSync(p) === l.target) {
        unlinkSync(p)
        symlinkSync(next, p)
        rewritten.push(l.path)
      }
    } catch { /* a missing link is reported by the hash check */ }
  }
  return { rewritten, stillOld: stillOld.slice(0, 50) }
}

/** Sum of the payload's file sizes (the uncompressed size). */
export function payloadBytes(manifest: BackupManifest): number {
  return manifest.files.reduce((n, f) => n + (f.size || 0), 0)
}

