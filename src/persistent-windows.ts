// PersistentWindows integration (kanban 45c3cfad's sibling: card 79 / a22c536c).
//
// PersistentWindows is a Windows-only tray app that saves and restores window
// positions per monitor layout. Boss wants it driven from the dashboard instead
// of from the tray menu, so that a freshly installed machine can get the old
// layout back without hunting through a system tray.
//
// Marveen runs inside WSL2, so everything here reaches the Windows side through
// the /mnt/c mount and WSL's interop (calling a .exe directly works and inherits
// the interactive desktop session, which is what makes a GUI-touching tool like
// this usable at all). On a machine without that mount -- a plain Linux install,
// a container -- every function degrades to "not supported" rather than throwing,
// because the dashboard is one build shared across installs.
//
// The flag names below were read out of the INSTALLED binary (strings on
// PersistentWindows.exe, v5.76), not copied from documentation, so they match
// the executable this code will actually run.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

/** Windows user profiles as seen from WSL. */
const WINDOWS_USERS_DIR = '/mnt/c/Users'

/** Profile folders Windows ships that never belong to a person. */
const NON_HUMAN_PROFILES = new Set(['All Users', 'Default', 'Default User', 'Public', 'desktop.ini'])

/** Where PersistentWindows keeps the layout database (LiteDB) under a profile. */
const PW_DATA_SUBPATH = 'AppData/Local/PersistentWindows'

/**
 * The data folder for a profile, built from the profile name -- used by the
 * GitHub-restore path when there is no layout DB on disk yet to derive the
 * folder from (a fresh machine restoring its first backup).
 */
export function PW_DATA_DIR_FALLBACK(windowsUser: string | null): string {
  return join(WINDOWS_USERS_DIR, windowsUser ?? '', PW_DATA_SUBPATH)
}

/** winget drops a launcher shim here; the real exe lives under Packages/. */
const PW_LINK_SUBPATH = 'AppData/Local/Microsoft/WinGet/Links/PersistentWindows.exe'
const PW_PACKAGES_SUBPATH = 'AppData/Local/Microsoft/WinGet/Packages'

/** Layout-database copies taken before a capture overwrites the live one. */
export const PW_BACKUP_DIR = join(PROJECT_ROOT, 'store', 'persistent-windows-backups')

/**
 * A capture/restore either finishes quickly or is stuck: PersistentWindows is a
 * tray app, so a flag it does not recognise leaves a resident process behind
 * rather than failing. Anything past this is killed, so a dashboard click can
 * never leak a hung Windows process (or hold an HTTP request open).
 */
export const PW_COMMAND_TIMEOUT_MS = 25_000

export interface PwLayoutFile {
  /** WSL path of the layout database. */
  path: string
  sizeBytes: number
  /** Unix seconds of the last write -- "when did we last save a layout". */
  updatedAt: number
}

export interface PwStatus {
  /** False on a non-WSL install: nothing here can work, and that is not an error. */
  supported: boolean
  installed: boolean
  /** WSL path of the executable, null when not installed. */
  exePath: string | null
  /** Windows profile name the install belongs to (informational). */
  windowsUser: string | null
  /** Layout databases found, newest first. Empty means nothing captured yet. */
  layouts: PwLayoutFile[]
  /** How many pre-capture backups we hold. */
  backups: number
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try { return statSync(path) } catch { return null }
}

function listWindowsProfiles(): string[] {
  try {
    return readdirSync(WINDOWS_USERS_DIR).filter(name => {
      if (NON_HUMAN_PROFILES.has(name)) return false
      const s = safeStat(join(WINDOWS_USERS_DIR, name))
      return s?.isDirectory() ?? false
    })
  } catch {
    return []
  }
}

/**
 * Resolve the executable inside a winget package directory. The package folder
 * name carries a version-independent id, but we glob rather than hardcode it so
 * an upgrade (or a differently-sourced install) still resolves.
 */
function findExeInPackages(profileDir: string): string | null {
  const packages = join(profileDir, PW_PACKAGES_SUBPATH)
  let entries: string[]
  try { entries = readdirSync(packages) } catch { return null }
  for (const entry of entries) {
    if (!entry.toLowerCase().includes('persistentwindows')) continue
    const exe = join(packages, entry, 'PersistentWindows.exe')
    if (existsSync(exe)) return exe
  }
  return null
}

/**
 * Locate the install and its layout data. Multiple Windows profiles can exist on
 * one machine; the one that owns a PersistentWindows install wins, and among
 * those the one that also has layout data, since that is the profile actually
 * using it. Pure filesystem probing -- no process is started, so this is safe to
 * call on every status poll.
 */
export function readPwStatus(): PwStatus {
  const base: PwStatus = {
    supported: existsSync(WINDOWS_USERS_DIR),
    installed: false,
    exePath: null,
    windowsUser: null,
    layouts: [],
    backups: countBackups(),
  }
  if (!base.supported) return base

  const candidates: Array<{ user: string; exePath: string; layouts: PwLayoutFile[] }> = []
  for (const user of listWindowsProfiles()) {
    const profileDir = join(WINDOWS_USERS_DIR, user)
    const link = join(profileDir, PW_LINK_SUBPATH)
    // Prefer the real executable over the winget shim: the shim is a launcher
    // stub, and passing flags through it is one indirection we do not need.
    const exePath = findExeInPackages(profileDir) ?? (existsSync(link) ? link : null)
    if (!exePath) continue
    candidates.push({ user, exePath, layouts: readLayouts(join(profileDir, PW_DATA_SUBPATH)) })
  }
  if (candidates.length === 0) return base

  candidates.sort((a, b) => {
    const an = a.layouts.length > 0 ? 1 : 0
    const bn = b.layouts.length > 0 ? 1 : 0
    if (an !== bn) return bn - an
    return (b.layouts[0]?.updatedAt ?? 0) - (a.layouts[0]?.updatedAt ?? 0)
  })
  const best = candidates[0]
  return { ...base, installed: true, exePath: best.exePath, windowsUser: best.user, layouts: best.layouts }
}

/** Layout databases in a PersistentWindows data folder, newest first. */
export function readLayouts(dataDir: string): PwLayoutFile[] {
  let names: string[]
  try { names = readdirSync(dataDir) } catch { return [] }
  const files: PwLayoutFile[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.db')) continue
    const path = join(dataDir, name)
    const s = safeStat(path)
    if (!s?.isFile()) continue
    files.push({ path, sizeBytes: Number(s.size), updatedAt: Math.floor(Number(s.mtimeMs) / 1000) })
  }
  return files.sort((a, b) => b.updatedAt - a.updatedAt)
}

function countBackups(): number {
  try {
    return readdirSync(PW_BACKUP_DIR).filter(f => f.endsWith('.db')).length
  } catch {
    return 0
  }
}

/**
 * Copy the live layout databases aside before anything overwrites them.
 *
 * A capture is destructive in the only way that matters here: it replaces the
 * saved layout with whatever the desktop looks like right now. If that fires by
 * accident -- a stray click, a scheduled job at a bad moment -- the previous
 * arrangement is gone, and it is the thing the whole feature exists to protect.
 * Copies are kept OUTSIDE the Windows data folder so PersistentWindows never
 * sees them as extra layouts of its own.
 *
 * Returns the backup paths written (empty when there was nothing to back up).
 */
export function backupLayouts(layouts: PwLayoutFile[], nowMs: number = Date.now()): string[] {
  if (layouts.length === 0) return []
  mkdirSync(PW_BACKUP_DIR, { recursive: true })
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  const written: string[] = []
  for (const layout of layouts) {
    const base = layout.path.split('/').pop() ?? 'layout.db'
    const target = join(PW_BACKUP_DIR, `${stamp}__${base}`)
    copyFileSync(layout.path, target)
    written.push(target)
  }
  return written
}

export type PwAction = 'capture' | 'restore'

/**
 * Flags taken from the installed binary (v5.76). The exe exposes BOTH
 * -restore_from_disk and -restore_disk_capture; the UI strings next to them read
 * "Restore windows from disk" for the former, which is the tray command Boss
 * would otherwise click, so that is the one wired to the dashboard button.
 */
export const PW_ACTION_FLAGS: Record<PwAction, string> = {
  capture: '-capture_to_disk',
  restore: '-restore_from_disk',
}

export interface PwRunResult {
  ok: boolean
  action: PwAction
  /** Exit code, or null when the process had to be killed on timeout. */
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** Backups taken before the action (capture only). */
  backups: string[]
  /** True when this call had to start PersistentWindows before acting. */
  startedTool: boolean
  /**
   * Capture only: did the layout database actually gain a newer write? null for
   * restore, which changes windows rather than files and so cannot be verified
   * this way.
   */
  layoutChanged?: boolean
}

/** How long to wait for the capture's database write to land. */
const PW_LAYOUT_WRITE_TIMEOUT_MS = 10_000

const TASKLIST = '/mnt/c/Windows/System32/tasklist.exe'
/** How long to wait for a freshly started PersistentWindows to show up. */
const PW_START_TIMEOUT_MS = 20_000
/**
 * Grace period after the process appears. The tray app has to finish setting up
 * the channel its own command-line flags talk to; firing the flag the millisecond
 * the PID exists gets it dropped on the floor.
 */
const PW_START_SETTLE_MS = 3_000

/**
 * Is PersistentWindows resident right now?
 *
 * This is not a detail -- it is the thing that made the first version silently
 * do nothing (Boss, 2026-08-11: "csináltam egy mentést... és nem csinált
 * semmit"). The -capture_to_disk / -restore_from_disk flags are instructions for
 * an ALREADY RUNNING instance: launched with no instance up, the process exits 0
 * without touching the layout database, so every call looked like a success while
 * the stored layout kept its old timestamp.
 */
export async function isPwRunning(): Promise<boolean> {
  if (!existsSync(TASKLIST)) return false
  return await new Promise<boolean>(resolve => {
    execFile(
      TASKLIST,
      ['/FI', 'IMAGENAME eq PersistentWindows.exe', '/FO', 'CSV', '/NH'],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) { resolve(false); return }
        resolve(/persistentwindows\.exe/i.test(String(stdout ?? '')))
      },
    )
  })
}

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
/** Scheduled task that owns starting the tray app -- also the auto-start entry. */
export const PW_TASK_NAME = 'MarveenPersistentWindows'
/** Public folder is writable from WSL and readable by the scheduled task. */
const scriptPathWsl = (taskName: string) => `/mnt/c/Users/Public/${taskName}.ps1`
const scriptPathWin = (taskName: string) => `C:\\Users\\Public\\${taskName}.ps1`

/** Translate a /mnt/c path into the C:\ form the Windows side needs. */
function toWindowsPath(wslPath: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('wslpath', ['-w', wslPath], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? '').trim() || null)
    })
  })
}

/**
 * Start PersistentWindows through a scheduled task running as the logged-in user
 * with LogonType Interactive.
 *
 * Launching the exe straight from WSL does NOT work, and fails in the most
 * confusing way available: the process exits 0 immediately and never appears in
 * the task list (verified on Boss's machine, 2026-08-11). A tray app needs the
 * interactive desktop session, which a WSL-spawned process does not get. The
 * scheduled task is the same pattern the windows-desktop-input skill already uses
 * on this machine for exactly this reason.
 *
 * The task is registered with an AtLogOn trigger as well, so this doubles as the
 * auto-start Boss asked for: after the first click the tool comes back by itself
 * on every login, and the whole feature stops depending on someone remembering
 * to start it. No admin rights are involved -- the task runs as the user, at the
 * user's own privilege level.
 */
async function startViaTaskScheduler(exePath: string): Promise<boolean> {
  return await runViaTaskScheduler(exePath, '-splash=0', PW_TASK_NAME, true)
}

/**
 * Run PersistentWindows with the given arguments through a scheduled task.
 *
 * EVERY invocation goes this way, not just the initial start. A process spawned
 * from WSL exits 0 instantly without doing anything -- with or without flags --
 * because a tray app cannot attach to the desktop from there. That is what made
 * the first working-looking version save nothing at all: the capture flag was
 * handed to a process that died before it could act, and the exit code said 0
 * (Boss's machine, 2026-08-11; the layout DB kept a 12-hour-old timestamp
 * through every click, and only started updating once the same flag was
 * delivered through a task with LogonType Interactive).
 *
 * `withLogonTrigger` also registers an AtLogOn trigger, which is how the tool
 * comes back on its own after a reboot -- the auto-start Boss asked for.
 */
async function runViaTaskScheduler(
  exePath: string,
  args: string,
  taskName: string,
  withLogonTrigger: boolean,
): Promise<boolean> {
  const winExe = await toWindowsPath(exePath)
  if (!winExe) {
    logger.warn({ exePath }, 'PersistentWindows: could not translate the exe path for Windows')
    return false
  }
  // Written to a file rather than passed as -Command: the WSL -> PowerShell
  // quoting chain mangles embedded quotes, which the skill notes cost a silent
  // "Exit code 2" once already.
  const register = withLogonTrigger
    ? `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Principal $principal -Trigger $trigger -Force | Out-Null`
    : `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Principal $principal -Force | Out-Null`
  const script = [
    '$ErrorActionPreference = "Stop"',
    `$exe = '${winExe.replace(/'/g, "''")}'`,
    '$id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    `$action = New-ScheduledTaskAction -Execute $exe -Argument '${args.replace(/'/g, "''")}'`,
    '$principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive',
    ...(withLogonTrigger ? ['$trigger = New-ScheduledTaskTrigger -AtLogOn -User $id'] : []),
    register,
    `Start-ScheduledTask -TaskName '${taskName}'`,
  ].join('\r\n')
  try {
    // The BOM is load-bearing. Windows PowerShell 5.1 reads a BOM-less file as
    // ANSI, so the accented Windows profile name in the path ("László") came back
    // mangled and the scheduled task failed with 0x80070002 FILE_NOT_FOUND -- a
    // launch failure that looks nothing like an encoding bug from the outside
    // (Boss's machine, 2026-08-11).
    writeFileSync(scriptPathWsl(taskName), '﻿' + script, 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'PersistentWindows: could not write the start script')
    return false
  }
  return await new Promise<boolean>(resolve => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPathWin(taskName)],
      { timeout: 45_000 },
      (err, _stdout, stderr) => {
        if (err) {
          logger.warn({ err, stderr: String(stderr ?? '').slice(0, 300) }, 'PersistentWindows: scheduled-task start failed')
          resolve(false)
          return
        }
        resolve(true)
      },
    )
  })
}

/**
 * Make sure the tray app is up, starting it if needed.
 *
 * Returns whether it had to start it. The process is deliberately detached and
 * unref'd: it must outlive this HTTP request (it is a resident tray app), and it
 * must not keep the dashboard's event loop alive.
 */
export async function ensurePwRunning(status: PwStatus = readPwStatus()): Promise<{ running: boolean; started: boolean }> {
  if (!status.installed || !status.exePath) return { running: false, started: false }
  if (await isPwRunning()) return { running: true, started: false }

  const launched = await startViaTaskScheduler(status.exePath)
  if (!launched) return { running: false, started: true }
  logger.info({ exe: status.exePath }, 'PersistentWindows was not running -- started it via Task Scheduler')

  const deadline = Date.now() + PW_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    if (await isPwRunning()) {
      await new Promise(r => setTimeout(r, PW_START_SETTLE_MS))
      return { running: true, started: true }
    }
  }
  return { running: false, started: true }
}

/**
 * Run one capture/restore. Both touch the live desktop, so this is deliberately
 * a single narrow door: one action per call, a hard timeout, and a backup taken
 * first for the destructive one.
 */
export async function runPwAction(action: PwAction, status: PwStatus = readPwStatus()): Promise<PwRunResult> {
  const result: PwRunResult = { ok: false, action, exitCode: null, timedOut: false, stdout: '', stderr: '', backups: [], startedTool: false }
  if (!status.installed || !status.exePath) {
    result.stderr = 'PersistentWindows is not installed on this machine'
    return result
  }
  // The flags below only mean anything to a resident instance -- see isPwRunning.
  const { running, started } = await ensurePwRunning(status)
  result.startedTool = started
  if (!running) {
    result.stderr = 'PersistentWindows could not be started'
    return result
  }
  if (action === 'capture') {
    try {
      result.backups = backupLayouts(status.layouts)
    } catch (err) {
      // Refuse rather than capture blind: without a backup an accidental capture
      // is unrecoverable, which is the exact failure this guards.
      logger.warn({ err }, 'PersistentWindows: layout backup failed, capture aborted')
      result.stderr = 'Layout backup failed -- capture aborted'
      return result
    }
  }
  const flag = PW_ACTION_FLAGS[action]
  const beforeMtime = status.layouts[0]?.updatedAt ?? 0
  // Through the scheduler, for the same reason the start is: a WSL-spawned copy
  // of this exe never reaches the desktop, so the flag would go nowhere.
  const dispatched = await runViaTaskScheduler(
    status.exePath as string,
    `-splash=0 ${flag}`,
    `${PW_TASK_NAME}${action === 'capture' ? 'Capture' : 'Restore'}`,
    false,
  )
  result.exitCode = dispatched ? 0 : null
  result.ok = dispatched
  if (!dispatched) {
    result.stderr = 'Could not dispatch the command to PersistentWindows'
    return result
  }

  // A capture must be able to PROVE it saved something. Exit code 0 does not:
  // the very first version returned a green tick on every click while the layout
  // database kept its hours-old timestamp, because the command had gone to a
  // process that was not there (Boss, 2026-08-11). The database write is what
  // the feature actually promises, so that is what gets checked -- and the write
  // lands a moment after the process returns, hence the short poll.
  if (action === 'capture' && result.ok) {
    result.layoutChanged = await waitForLayoutWrite(status, beforeMtime)
    if (!result.layoutChanged) {
      result.ok = false
      result.stderr = 'PersistentWindows reported success but did not update the saved layout'
      logger.warn({ beforeMtime }, 'PersistentWindows capture did not touch the layout database')
    }
  }
  return result
}

/** Poll for the layout DB gaining a newer mtime than `beforeMtime`. */
async function waitForLayoutWrite(status: PwStatus, beforeMtime: number): Promise<boolean> {
  const deadline = Date.now() + PW_LAYOUT_WRITE_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500))
    const dataDir = status.layouts[0]
      ? status.layouts[0].path.split('/').slice(0, -1).join('/')
      : PW_DATA_DIR_FALLBACK(status.windowsUser)
    const newest = readLayouts(dataDir)[0]
    if (newest && newest.updatedAt > beforeMtime) return true
  }
  return false
}
