// GitHub backup/restore for the PersistentWindows layout database (kanban 79).
//
// Boss wants his desktop window arrangement saved off the machine and brought
// back with one click, and chose GitHub over Drive, on the lackor2 account, in
// a repo SEPARATE from the Marvin fork (Boss 2026-08-10). This module owns that
// git side; src/persistent-windows.ts owns the Windows side (finding the DB,
// capture/restore). The layout DB is tiny (~57 KB LiteDB), so a plain git repo
// holding the file plus a manifest is the whole mechanism -- no LFS, no API.
//
// Auth rides on the gh credential helper already configured for github.com, so
// nothing here embeds a token. On a machine where PersistentWindows is not
// present every call still runs (the repo is host-independent); it just has no
// layout to push.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { PROJECT_ROOT, WINDOW_BACKUP_REPO_URL } from './config.js'
import { logger } from './logger.js'
import { readPwStatus, backupLayouts, runPwAction, PW_DATA_DIR_FALLBACK, type PwStatus, type PwRunResult } from './persistent-windows.js'
import { WIN_SETTINGS_DIR } from './windows-settings.js'

/**
 * The dedicated, private backup repo (NOT the Marveen fork).
 *
 * Which repo receives the backup is per-install, not per-author. As a baked-in
 * literal it pointed every install at ONE operator's private repo: on anybody
 * else's machine the push either fails outright or, worse, aims at a stranger's
 * backups. It comes from WINDOW_BACKUP_REPO_URL in .env instead; empty means
 * the feature was never configured on this host, and ensureRepo() says exactly
 * that rather than guessing a URL.
 */
export const BACKUP_REPO_URL = WINDOW_BACKUP_REPO_URL
const REPO_DIR = join(PROJECT_ROOT, 'store', 'window-layout-repo')
const LAYOUTS_SUBDIR = 'layouts'
const MANIFEST_NAME = 'manifest.json'
const GIT_TIMEOUT_MS = 60_000

export interface LayoutManifestFile {
  name: string
  sizeBytes: number
  /** Unix seconds of the DB's last write when it was pushed. */
  updatedAt: number
}
export interface LayoutManifest {
  windowsUser: string | null
  /** Unix seconds when this backup was pushed. */
  capturedAt: number
  files: LayoutManifestFile[]
}

interface GitResult { code: number; stdout: string; stderr: string }

function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      resolve({
        code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

/** Clone the backup repo on first use; make sure the remote is the right one. */
async function ensureRepo(): Promise<void> {
  if (!BACKUP_REPO_URL) {
    throw new Error(
      'A Windows-mentes celrepoja nincs beallitva ezen a gepen. '
      + 'Vedd fel a .env-be: WINDOW_BACKUP_REPO_URL=https://github.com/<fiok>/<repo>.git',
    )
  }
  if (existsSync(join(REPO_DIR, '.git'))) {
    await git(['remote', 'set-url', 'origin', BACKUP_REPO_URL], REPO_DIR)
    return
  }
  mkdirSync(dirname(REPO_DIR), { recursive: true })
  const cloned = await git(['clone', BACKUP_REPO_URL, REPO_DIR], PROJECT_ROOT)
  if (cloned.code !== 0) throw new Error(`repo clone failed: ${cloned.stderr.slice(0, 300)}`)
  // Commit identity for this machine's backups; local to the repo only.
  await git(['config', 'user.email', 'marveen@localhost'], REPO_DIR)
  await git(['config', 'user.name', 'Marveen'], REPO_DIR)
}

/** Adopt whatever is on the remote's main branch, tolerating an empty repo. */
async function syncFromRemote(): Promise<void> {
  await git(['fetch', 'origin'], REPO_DIR)
  // reset (not pull) so a locally-copied-in DB never causes a merge conflict --
  // the remote is the source of truth for a restore.
  await git(['reset', '--hard', 'origin/main'], REPO_DIR)
}

export interface PushResult {
  pushed: boolean
  manifest: LayoutManifest
}

/**
 * Copy the live layout DB(s) into the repo, write a manifest, commit and push.
 * Does NOT capture the current desktop first -- that is a separate, destructive
 * step the caller decides on. This just publishes whatever PersistentWindows has
 * already saved to disk.
 */
export async function pushWindowLayout(status: PwStatus = readPwStatus()): Promise<PushResult> {
  if (!status.supported) throw new Error('not a WSL/Windows host -- nothing to back up')
  if (status.layouts.length === 0) throw new Error('no saved layout on disk yet -- capture one first')
  await ensureRepo()
  await syncFromRemote()

  const layoutsDir = join(REPO_DIR, LAYOUTS_SUBDIR)
  mkdirSync(layoutsDir, { recursive: true })
  const files: LayoutManifestFile[] = []
  for (const l of status.layouts) {
    copyFileSync(l.path, join(layoutsDir, basename(l.path)))
    files.push({ name: basename(l.path), sizeBytes: l.sizeBytes, updatedAt: l.updatedAt })
  }
  const manifest: LayoutManifest = { windowsUser: status.windowsUser, capturedAt: Math.floor(Date.now() / 1000), files }
  writeFileSync(join(REPO_DIR, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n')

  await git(['add', '-A'], REPO_DIR)
  const commit = await git(['commit', '-m', `layout backup ${new Date().toISOString()} (${status.windowsUser ?? 'unknown'})`], REPO_DIR)
  const nothingToCommit = commit.code !== 0 && /nothing to commit/i.test(commit.stdout + commit.stderr)
  if (commit.code !== 0 && !nothingToCommit) throw new Error(`commit failed: ${(commit.stderr || commit.stdout).slice(0, 300)}`)
  const push = await git(['push', 'origin', 'HEAD:main'], REPO_DIR)
  if (push.code !== 0) throw new Error(`push failed: ${push.stderr.slice(0, 300)}`)
  logger.info({ files: files.length, nothingToCommit }, 'window-layout: pushed backup')
  return { pushed: !nothingToCommit, manifest }
}

export interface PulledLayout {
  manifest: LayoutManifest
  layoutsDir: string
}

/** Bring the newest backup down from the repo. Throws if none exists yet. */
export async function pullWindowLayout(): Promise<PulledLayout> {
  await ensureRepo()
  await syncFromRemote()
  const manifestPath = join(REPO_DIR, MANIFEST_NAME)
  if (!existsSync(manifestPath)) throw new Error('no backup in the repo yet -- save one first')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as LayoutManifest
  return { manifest, layoutsDir: join(REPO_DIR, LAYOUTS_SUBDIR) }
}

export interface RestoreResult {
  manifest: LayoutManifest
  copied: string[]
  action: PwRunResult
}

/**
 * Pull the backup, drop the DB back into the PersistentWindows data folder (the
 * live one is copied aside first), then ask PersistentWindows to apply it. This
 * rearranges the real desktop, so it is only ever run on an explicit click.
 */
export async function restoreWindowLayout(status: PwStatus = readPwStatus()): Promise<RestoreResult> {
  if (!status.supported) throw new Error('not a WSL/Windows host')
  if (!status.installed) throw new Error('PersistentWindows is not installed on this machine')
  const { manifest, layoutsDir } = await pullWindowLayout()

  const dataDir = status.layouts[0]
    ? dirname(status.layouts[0].path)
    : join(PW_DATA_DIR_FALLBACK(status.windowsUser))
  backupLayouts(status.layouts)
  mkdirSync(dataDir, { recursive: true })
  const copied: string[] = []
  for (const f of manifest.files) {
    const src = join(layoutsDir, f.name)
    if (existsSync(src)) { copyFileSync(src, join(dataDir, f.name)); copied.push(f.name) }
  }
  const action = await runPwAction('restore', readPwStatus())
  return { manifest, copied, action }
}

export interface SyncInfo {
  cloned: boolean
  /** Unix seconds of the last backup commit, null when nothing pushed yet. */
  lastBackupAt: number | null
  remoteUrl: string
}

/** Cheap status for the Settings panel: has anything been backed up, and when. */
export async function windowLayoutSyncInfo(): Promise<SyncInfo> {
  if (!existsSync(join(REPO_DIR, '.git'))) {
    return { cloned: false, lastBackupAt: null, remoteUrl: BACKUP_REPO_URL }
  }
  const log = await git(['log', '-1', '--format=%ct'], REPO_DIR)
  const lastBackupAt = log.code === 0 && log.stdout.trim() ? Number(log.stdout.trim()) : null
  return { cloned: true, lastBackupAt, remoteUrl: BACKUP_REPO_URL }
}

/** Twice a day, which is what Boss asked for ("naponta egyszer vagy kétszer"). */
const AUTO_PUSH_INTERVAL_MS = 12 * 60 * 60 * 1000
/** Let the dashboard finish booting before the first git call. */
const AUTO_PUSH_FIRST_DELAY_MS = 5 * 60 * 1000

/**
 * Keep the GitHub copy fresh on a timer.
 *
 * It PUSHES but never CAPTURES, and that distinction is the whole design: a
 * capture would overwrite the stored arrangement with whatever happens to be on
 * screen when the timer fires, quietly destroying the deliberate layout this
 * feature exists to preserve. PersistentWindows maintains the DB on its own, so
 * pushing alone is enough to keep the off-machine copy current -- and if Boss
 * has never saved anything there is simply nothing to send, which is not an
 * error worth waking anyone over.
 */
export function startWindowLayoutSyncTask(intervalMs = AUTO_PUSH_INTERVAL_MS): NodeJS.Timeout {
  const push = () => {
    const status = readPwStatus()
    if (!status.supported || status.layouts.length === 0) return
    pushWindowLayout(status)
      .then(r => { if (r.pushed) logger.info('window-layout: scheduled backup pushed') })
      .catch(err => logger.warn({ err }, 'window-layout: scheduled backup failed'))
  }
  setTimeout(push, AUTO_PUSH_FIRST_DELAY_MS).unref()
  return setInterval(push, intervalMs).unref()
}

/** Subdirectory in the backup repo holding the exported Windows settings. */
const WIN_SETTINGS_SUBDIR = 'windows-settings'

/**
 * Publish the exported registry settings to the same private repo the window
 * layout uses (kanban fc904177). One repo, two folders: they are backups of the
 * same machine and there is no reason to make Boss keep track of two places.
 */
export async function pushWindowsSettings(): Promise<{ pushed: boolean; files: number }> {
  await ensureRepo()
  await syncFromRemote()
  const targetDir = join(REPO_DIR, WIN_SETTINGS_SUBDIR)
  mkdirSync(targetDir, { recursive: true })
  let files = 0
  for (const name of readdirSync(WIN_SETTINGS_DIR)) {
    if (!name.endsWith('.reg')) continue
    copyFileSync(join(WIN_SETTINGS_DIR, name), join(targetDir, name))
    files++
  }
  if (files === 0) return { pushed: false, files: 0 }
  await git(['add', '-A'], REPO_DIR)
  const commit = await git(['commit', '-m', `windows settings backup ${new Date().toISOString()}`], REPO_DIR)
  const nothingToCommit = commit.code !== 0 && /nothing to commit/i.test(commit.stdout + commit.stderr)
  if (commit.code !== 0 && !nothingToCommit) throw new Error(`commit failed: ${(commit.stderr || commit.stdout).slice(0, 300)}`)
  const push = await git(['push', 'origin', 'HEAD:main'], REPO_DIR)
  if (push.code !== 0) throw new Error(`push failed: ${push.stderr.slice(0, 300)}`)
  logger.info({ files }, 'windows-settings: pushed backup')
  return { pushed: !nothingToCommit, files }
}
