// Custom folder icons backup/restore (kanban fc904177, second round).
//
// Boss set a folder's icon to the yellow one, saved, changed it, restored -- and
// the icon stayed changed (2026-08-11). Correctly so: a folder's custom icon is
// NOT registry data. It lives in a hidden desktop.ini INSIDE the folder:
//
//   [.ShellClassInfo]
//   IconResource=C:\Windows\System32\SHELL32.dll,137
//
// (verified on Boss's own D: drive). The registry side of this feature stores
// folder VIEWS -- icon size, sort order, columns -- which is a different thing
// that happens to sound the same. So this module handles the file side, and Boss
// asked for the whole machine: "az egész számítógépen, ami van meghajtó,
// mindent pásztázz végig, és vissza kell állítani mindegyiket".
//
// Two details decide whether a restore actually shows anything, and both were
// worth finding out before writing code rather than after Boss reported it
// silently doing nothing (which is how the evening went twice already):
//   - desktop.ini must keep its hidden+system attributes, or Explorer ignores it.
//   - the FOLDER must be marked read-only (or system), or Explorer never looks
//     for a desktop.ini in it at all.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

/** Where the collected desktop.ini copies and their manifest live. */
export const FOLDER_ICONS_DIR = join(PROJECT_ROOT, 'store', 'folder-icons')
const MANIFEST_NAME = 'manifest.json'

/**
 * Paths never scanned. These hold Windows' own desktop.ini files, which the OS
 * writes and owns: copying them is pointless (they never change) and writing
 * them back is both permission-denied and a way to break shell folders. Boss's
 * own customisations are never in here.
 */
const SKIP_SEGMENTS = [
  '/windows/',
  '/program files/',
  '/program files (x86)/',
  '/programdata/',
  '/$recycle.bin/',
  '/appdata/',
  '/system volume information/',
  '/onedrivetemp/',
]

/** A desktop.ini only matters to us when it actually sets an icon. */
const ICON_KEY_RE = /^\s*(IconResource|IconFile)\s*=/im

export interface FolderIconEntry {
  /** Windows path of the folder (what the user sees). */
  folderWindows: string
  /** WSL path of the desktop.ini, used for reading/writing. */
  iniWsl: string
  /** File name the copy is stored under (folder path, flattened). */
  storedAs: string
  /** The icon line, kept in the manifest so a human can read what was saved. */
  icon: string
  updatedAt: number
}

/**
 * A full-machine scan takes minutes, not seconds -- measured on Boss's C: drive,
 * where the /mnt 9p mount makes traversal slow. It therefore never runs inside a
 * request: the save endpoint kicks it off and returns, and the status endpoint
 * reports progress. Blocking the click for ten minutes would look like a hang,
 * and an HTTP timeout would leave Boss with no idea whether it worked.
 */
let scanRunning = false
let lastScanError: string | null = null

export function isScanRunning(): boolean { return scanRunning }
export function getLastScanError(): string | null { return lastScanError }

/** Start a scan without waiting for it. A second call while one runs is a no-op. */
export function startFolderIconScan(): boolean {
  if (scanRunning) return false
  scanRunning = true
  lastScanError = null
  void scanFolderIcons()
    .catch(err => {
      lastScanError = String((err as Error).message ?? err)
      logger.warn({ err }, 'folder-icons: background scan failed')
    })
    .finally(() => { scanRunning = false })
  return true
}

export interface FolderIconsManifest {
  scannedAt: number
  drives: string[]
  entries: FolderIconEntry[]
}

/** Drives visible from WSL (/mnt/c, /mnt/d, ...), excluding WSL's own mounts. */
export function listDrives(): string[] {
  try {
    return readdirSync('/mnt')
      .filter(name => /^[a-z]$/.test(name))
      .map(name => `/mnt/${name}`)
      .filter(p => {
        try { return statSync(p).isDirectory() } catch { return false }
      })
  } catch {
    return []
  }
}

function isSkipped(path: string): boolean {
  const lower = path.toLowerCase()
  return SKIP_SEGMENTS.some(seg => lower.includes(seg))
}

/** Translate a WSL path to its Windows form without spawning wslpath per file. */
function toWindowsPath(wslPath: string): string | null {
  const m = wslPath.match(/^\/mnt\/([a-z])\/(.*)$/)
  if (!m) return null
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
}

/**
 * Find every customised folder on the machine and copy its desktop.ini aside.
 *
 * `find` is used rather than a recursive walk in Node: the /mnt drives are a
 * 9p mount where per-file syscalls from Node are slow, and one find process
 * doing the traversal natively is the difference between seconds and minutes.
 */
export async function scanFolderIcons(): Promise<FolderIconsManifest> {
  const drives = listDrives()
  const entries: FolderIconEntry[] = []
  mkdirSync(FOLDER_ICONS_DIR, { recursive: true })

  for (const drive of drives) {
    const found = await findDesktopInis(drive)
    for (const iniWsl of found) {
      if (isSkipped(iniWsl)) continue
      let content: string
      try {
        // desktop.ini is often UTF-16; read as binary and strip NULs so the
        // regex works for both encodings without guessing.
        content = readFileSync(iniWsl).toString('utf-8').replace(/\0/g, '')
      } catch { continue }
      const iconLine = content.split(/\r?\n/).find(l => ICON_KEY_RE.test(l))
      if (!iconLine) continue
      const folderWsl = dirname(iniWsl)
      const folderWindows = toWindowsPath(folderWsl)
      if (!folderWindows) continue
      const storedAs = folderWindows.replace(/[\\:]/g, '_') + '.ini'
      try {
        copyFileSync(iniWsl, join(FOLDER_ICONS_DIR, storedAs))
      } catch (err) {
        logger.warn({ err, iniWsl }, 'folder-icons: could not copy desktop.ini')
        continue
      }
      let updatedAt = 0
      try { updatedAt = Math.floor(Number(statSync(iniWsl).mtimeMs) / 1000) } catch { /* keep 0 */ }
      entries.push({ folderWindows, iniWsl, storedAs, icon: iconLine.trim(), updatedAt })
    }
  }

  const manifest: FolderIconsManifest = { scannedAt: Math.floor(Date.now() / 1000), drives, entries }
  writeFileSync(join(FOLDER_ICONS_DIR, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n')
  logger.info({ drives: drives.length, entries: entries.length }, 'folder-icons: scan complete')
  return manifest
}

/**
 * List every desktop.ini on a drive, using WINDOWS to do the walking.
 *
 * This is not a style choice, it is the difference between usable and not:
 * `find /mnt/c` over the 9p mount ran for 35+ MINUTES on Boss's machine without
 * finishing, while `dir C:\desktop.ini /s /b /a` returned all 152 hits in 24
 * SECONDS (measured 2026-08-11). Same filesystem, ~90x apart, because every
 * directory entry crossed the WSL boundary in the first version.
 *
 * `chcp 65001` first: cmd defaults to an OEM code page, which mangles accented
 * folder names -- and Boss's paths are full of them.
 */
function findDesktopInis(drive: string): Promise<string[]> {
  const letter = drive.replace('/mnt/', '').toUpperCase()
  return new Promise(resolve => {
    execFile(
      '/mnt/c/Windows/System32/cmd.exe',
      ['/c', `chcp 65001 >nul & dir ${letter}:\\desktop.ini /s /b /a`],
      { timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        // dir exits 1 when a drive has no matches at all; that is not an error.
        if (err && !stdout) { resolve([]); return }
        const paths = String(stdout ?? '')
          .split(/\r?\n/)
          .map(l => l.trim())
          .filter(l => /^[A-Za-z]:\\/.test(l))
          .map(toWslPath)
          .filter((p): p is string => p !== null)
        resolve(paths)
      },
    )
  })
}

/** C:\dir\file -> /mnt/c/dir/file */
function toWslPath(windowsPath: string): string | null {
  const m = windowsPath.match(/^([A-Za-z]):\\(.*)$/)
  if (!m) return null
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

export function readFolderIconsManifest(): FolderIconsManifest | null {
  try {
    return JSON.parse(readFileSync(join(FOLDER_ICONS_DIR, MANIFEST_NAME), 'utf-8')) as FolderIconsManifest
  } catch {
    return null
  }
}

export interface FolderIconsRestoreResult {
  ok: boolean
  restored: string[]
  /** Folders that no longer exist, or could not be written. */
  failed: Array<{ folder: string; error: string }>
}

/**
 * Write every saved desktop.ini back and re-apply the attributes Explorer needs.
 *
 * Restoring the file alone is not enough and would look like another silent
 * no-op: Explorer only reads desktop.ini from a folder marked read-only or
 * system, and only honours the file itself when it is hidden+system.
 */
export async function restoreFolderIcons(): Promise<FolderIconsRestoreResult> {
  const result: FolderIconsRestoreResult = { ok: false, restored: [], failed: [] }
  const manifest = readFolderIconsManifest()
  if (!manifest || manifest.entries.length === 0) {
    result.failed.push({ folder: '*', error: 'nothing scanned yet' })
    return result
  }

  const attribTargets: string[] = []
  for (const entry of manifest.entries) {
    const stored = join(FOLDER_ICONS_DIR, entry.storedAs)
    if (!existsSync(stored)) {
      result.failed.push({ folder: entry.folderWindows, error: 'saved copy missing' })
      continue
    }
    const folderWsl = dirname(entry.iniWsl)
    if (!existsSync(folderWsl)) {
      // The folder was moved or deleted since the scan -- expected over time,
      // and not something to shout about.
      result.failed.push({ folder: entry.folderWindows, error: 'folder no longer exists' })
      continue
    }
    try {
      copyFileSync(stored, entry.iniWsl)
      attribTargets.push(entry.folderWindows)
      result.restored.push(entry.folderWindows)
    } catch (err) {
      result.failed.push({ folder: entry.folderWindows, error: String((err as Error).message ?? err) })
    }
  }

  if (attribTargets.length > 0) await applyFolderAttributes(attribTargets)
  result.ok = result.restored.length > 0
  logger.info({ restored: result.restored.length, failed: result.failed.length }, 'folder-icons: restore complete')
  return result
}

/** Re-apply hidden+system on desktop.ini and read-only on its folder. */
async function applyFolderAttributes(folders: string[]): Promise<void> {
  const lines = ['$ErrorActionPreference = "SilentlyContinue"']
  for (const folder of folders) {
    const escaped = folder.replace(/'/g, "''")
    lines.push(`attrib +h +s '${escaped}\\desktop.ini'`)
    // Read-only on the FOLDER is what makes Explorer look for desktop.ini at
    // all. It does not make the folder's contents read-only -- this is the
    // documented Windows mechanism for customised folders, not a lockdown.
    lines.push(`attrib +r '${escaped}'`)
  }
  const wslPath = '/mnt/c/Users/Public/marveen-folder-attribs.ps1'
  const winPath = 'C:\\Users\\Public\\marveen-folder-attribs.ps1'
  try {
    writeFileSync(wslPath, '\ufeff' + lines.join('\r\n'), 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'folder-icons: could not write the attribute script')
    return
  }
  await new Promise<void>(resolve => {
    execFile(
      '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winPath],
      { timeout: 5 * 60_000 },
      err => {
        if (err) logger.warn({ err }, 'folder-icons: attribute pass reported an error')
        resolve()
      },
    )
  })
}
