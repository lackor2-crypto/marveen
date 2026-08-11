// Windows settings backup/restore (kanban fc904177).
//
// Boss wanted more than window positions: desktop icon placement, folder view
// styles, theme, taskbar -- "minden, ahogy eddig jól működött" (2026-08-11). All
// of that lives in the registry under HKCU, not in any application's files, so
// this is a separate mechanism from src/persistent-windows.ts (which stays as-is
// and keeps owning window layout -- Boss's call: "ne dobd ki, az jó úgy").
//
// Deliberately narrow. Exporting all of HKCU would sweep up credentials, app
// state and machine-specific junk, and importing it back onto a different
// machine would be a genuinely destructive act. Instead there is an explicit
// allowlist of keys below, each one chosen because it holds a setting Boss
// named, and each restore is preceded by a backup of the same keys.
//
// reg.exe works from WSL (unlike GUI apps -- see the wsl-windows-gui-command
// skill): it is a console program, so it inherits the calling user's HKCU and
// needs no scheduled-task detour. Restarting Explorer to apply the settings DOES
// touch the desktop, so that part goes through the scheduler.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

const REG_EXE = '/mnt/c/Windows/System32/reg.exe'
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
/** Scheduled task used to bring Explorer back after a restore. */
const EXPLORER_TASK_NAME = 'MarveenExplorerRestart'
const EXPLORER_SCRIPT_WSL = '/mnt/c/Users/Public/marveen-explorer-restart.ps1'
const EXPLORER_SCRIPT_WIN = 'C:\\Users\\Public\\marveen-explorer-restart.ps1'
/** Windows-visible scratch dir for the .reg files reg.exe reads and writes. */
const WIN_WORK_WSL = '/mnt/c/Users/Public/marveen-winsettings'
const WIN_WORK_WIN = 'C:\\Users\\Public\\marveen-winsettings'

/** Where exported settings are staged and kept between pushes. */
export const WIN_SETTINGS_DIR = join(PROJECT_ROOT, 'store', 'windows-settings')
/** Copies of the live registry taken before a restore overwrites it. */
export const WIN_SETTINGS_BACKUP_DIR = join(PROJECT_ROOT, 'store', 'windows-settings-backups')

export interface WindowsSettingGroup {
  /** Stable file name (also the i18n-free label the UI falls back to). */
  id: string
  /** What Boss would call this, in one phrase. */
  label: string
  /** Registry key, reg.exe syntax. */
  key: string
}

/**
 * The allowlist. Every entry is user-scoped (HKCU), so nothing here needs admin
 * rights and nothing here can break another account or the machine itself.
 *
 * Not included on purpose: anything under HKLM (machine state, not Boss's
 * settings), Run keys (startup programs are software, not preferences), and the
 * broader HKCU\Software tree (application data, tokens, licences).
 */
export const WINDOWS_SETTING_GROUPS: WindowsSettingGroup[] = [
  // Desktop icon positions. Stored per resolution (ItemPos1920x1080), which is
  // exactly why this does not always survive a move to a different monitor --
  // the key exists, but the entry for the new resolution does not.
  { id: 'desktop-icons', label: 'Asztali ikonok helye', key: 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Bags\\1\\Desktop' },
  // Per-folder view state (icon size, sort, layout) and the folder-visit index
  // it is keyed by. BagMRU without Bags is meaningless, hence both.
  { id: 'folder-views', label: 'Mappa nézetek és stílusok', key: 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\BagMRU' },
  { id: 'folder-view-data', label: 'Mappa nézet adatok', key: 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\Bags' },
  // Hidden files, file extensions, navigation pane, and the rest of the Explorer
  // options dialog.
  { id: 'explorer-options', label: 'Explorer beállítások', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced' },
  // Light/dark mode and accent-colour usage.
  { id: 'theme', label: 'Téma (világos/sötét)', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' },
  // Wallpaper path and fit, screen-saver, and desktop metrics.
  { id: 'desktop', label: 'Háttérkép és asztal', key: 'HKCU\\Control Panel\\Desktop' },
  { id: 'colors', label: 'Színek', key: 'HKCU\\Control Panel\\Colors' },
  // Taskbar position, size, auto-hide.
  { id: 'taskbar', label: 'Tálca elhelyezkedése', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3' },
  // Pinned taskbar items.
  { id: 'taskbar-pinned', label: 'Tálcára tűzött elemek', key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Taskband' },
]

const REG_TIMEOUT_MS = 60_000

function reg(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise(resolve => {
    execFile(REG_EXE, args, { timeout: REG_TIMEOUT_MS }, (err, _stdout, stderr) => {
      resolve({ ok: !err, stderr: String(stderr ?? '') })
    })
  })
}

export interface WindowsSettingsFile {
  id: string
  label: string
  path: string
  sizeBytes: number
  updatedAt: number
}

export interface WindowsSettingsStatus {
  /** False when this is not a WSL/Windows host. */
  supported: boolean
  /** Exported groups currently held locally, newest first by group order. */
  files: WindowsSettingsFile[]
  /** Unix seconds of the most recent export, null when never saved. */
  lastSavedAt: number | null
  /** How many pre-restore backups exist. */
  backups: number
}

export function readWindowsSettingsStatus(): WindowsSettingsStatus {
  const supported = existsSync(REG_EXE)
  const files: WindowsSettingsFile[] = []
  for (const group of WINDOWS_SETTING_GROUPS) {
    const path = join(WIN_SETTINGS_DIR, `${group.id}.reg`)
    let s: ReturnType<typeof statSync>
    try { s = statSync(path) } catch { continue }
    if (!s.isFile()) continue
    files.push({ id: group.id, label: group.label, path, sizeBytes: Number(s.size), updatedAt: Math.floor(Number(s.mtimeMs) / 1000) })
  }
  const lastSavedAt = files.length ? Math.max(...files.map(f => f.updatedAt)) : null
  let backups = 0
  try { backups = readdirSync(WIN_SETTINGS_BACKUP_DIR).length } catch { /* none yet */ }
  return { supported, files, lastSavedAt, backups }
}

export interface WindowsSettingsSaveResult {
  ok: boolean
  saved: string[]
  /** Groups whose key could not be exported, with the reason. */
  failed: Array<{ id: string; error: string }>
}

/**
 * Export every allowlisted key to its own .reg file.
 *
 * One file per group rather than one big export: a single failing key (a folder
 * Boss has never opened, a Windows version that moved a key) then costs exactly
 * that one setting instead of the whole backup, and the restore side can skip
 * what is missing just as granularly.
 */
export async function saveWindowsSettings(): Promise<WindowsSettingsSaveResult> {
  const result: WindowsSettingsSaveResult = { ok: false, saved: [], failed: [] }
  if (!existsSync(REG_EXE)) {
    result.failed.push({ id: '*', error: 'not a Windows host' })
    return result
  }
  mkdirSync(WIN_SETTINGS_DIR, { recursive: true })
  mkdirSync(WIN_WORK_WSL, { recursive: true })

  for (const group of WINDOWS_SETTING_GROUPS) {
    // reg.exe writes to a Windows path; the file is then moved into the repo
    // area, which lives on the Linux side.
    const winTarget = `${WIN_WORK_WIN}\\${group.id}.reg`
    const wslTarget = join(WIN_WORK_WSL, `${group.id}.reg`)
    const exported = await reg(['export', group.key, winTarget, '/y'])
    if (!exported.ok || !existsSync(wslTarget)) {
      result.failed.push({ id: group.id, error: exported.stderr.trim() || 'export failed' })
      continue
    }
    copyFileSync(wslTarget, join(WIN_SETTINGS_DIR, `${group.id}.reg`))
    rmSync(wslTarget, { force: true })
    result.saved.push(group.id)
  }
  result.ok = result.saved.length > 0
  logger.info({ saved: result.saved.length, failed: result.failed.length }, 'windows-settings: exported')
  return result
}

export interface WindowsSettingsRestoreResult {
  ok: boolean
  restored: string[]
  failed: Array<{ id: string; error: string }>
  /** Backup directory written before importing, null when nothing was backed up. */
  backupDir: string | null
  explorerRestarted: boolean
}

/**
 * Import the saved keys back, after backing up the live ones.
 *
 * The backup is not optional politeness: a registry import overwrites values in
 * place with no undo, and these keys decide what Boss's desktop looks like. The
 * copy taken here is the only way back if a restore turns out to be wrong.
 */
export async function restoreWindowsSettings(): Promise<WindowsSettingsRestoreResult> {
  const result: WindowsSettingsRestoreResult = { ok: false, restored: [], failed: [], backupDir: null, explorerRestarted: false }
  if (!existsSync(REG_EXE)) {
    result.failed.push({ id: '*', error: 'not a Windows host' })
    return result
  }
  const status = readWindowsSettingsStatus()
  if (status.files.length === 0) {
    result.failed.push({ id: '*', error: 'nothing saved yet' })
    return result
  }

  // Back up the CURRENT state of exactly the keys about to be overwritten.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(WIN_SETTINGS_BACKUP_DIR, stamp)
  mkdirSync(backupDir, { recursive: true })
  mkdirSync(WIN_WORK_WSL, { recursive: true })
  for (const file of status.files) {
    const group = WINDOWS_SETTING_GROUPS.find(g => g.id === file.id)
    if (!group) continue
    const winTarget = `${WIN_WORK_WIN}\\backup-${group.id}.reg`
    const wslTarget = join(WIN_WORK_WSL, `backup-${group.id}.reg`)
    const exported = await reg(['export', group.key, winTarget, '/y'])
    if (exported.ok && existsSync(wslTarget)) {
      copyFileSync(wslTarget, join(backupDir, `${group.id}.reg`))
      rmSync(wslTarget, { force: true })
    }
  }
  result.backupDir = backupDir

  for (const file of status.files) {
    const winSource = `${WIN_WORK_WIN}\\import-${file.id}.reg`
    const wslSource = join(WIN_WORK_WSL, `import-${file.id}.reg`)
    copyFileSync(file.path, wslSource)
    const imported = await reg(['import', winSource])
    rmSync(wslSource, { force: true })
    if (imported.ok) result.restored.push(file.id)
    else result.failed.push({ id: file.id, error: imported.stderr.trim() || 'import failed' })
  }

  result.ok = result.restored.length > 0
  // Unconditionally, not only on success: if some imports failed, Explorer has
  // still been killed by this point, and skipping the start would leave Boss
  // staring at a black desktop as the consequence of a PARTIAL failure -- the
  // worst possible time to also take away the taskbar.
  result.explorerRestarted = await restartExplorer()
  logger.info({ restored: result.restored.length, failed: result.failed.length, explorer: result.explorerRestarted }, 'windows-settings: restored')
  return result
}

/**
 * Restart Explorer so the imported values take effect.
 *
 * KILL AND START, never kill alone. Explorer draws the desktop, the icons and
 * the taskbar; killed with /F it does NOT come back on its own, and the screen
 * is left as a black nothing with no way for the user to launch anything. That
 * is exactly what happened to Boss on the first real restore (2026-08-11):
 * "az asztal egy nagy feketeség lett... minden eltűnt". Worse, the undo button
 * appeared broken for the same reason -- it wrote the old values back correctly
 * and then killed Explorer again, so the screen stayed empty and it looked like
 * the restore had destroyed everything. Nothing was ever lost; there was simply
 * nobody left to draw it.
 *
 * The start goes through a scheduled task with LogonType Interactive, because a
 * process spawned straight from WSL never reaches the desktop session (see the
 * wsl-windows-gui-command skill) -- which is also why the naive approach here
 * could not have worked even if it had tried to start it.
 */
async function restartExplorer(): Promise<boolean> {
  // Remember which folders are open BEFORE killing Explorer, so they can be
  // reopened afterwards. Boss lost his place mid-task the first time this ran
  // ("bezárta a böngészőt, és újra ki kellett keresnem ezt a helyet",
  // 2026-08-11) -- the restart is unavoidable, but making him hunt for the
  // folder again is not.
  const openFolders = await listOpenExplorerFolders()
  const killed = await new Promise<boolean>(resolve => {
    execFile(
      '/mnt/c/Windows/System32/taskkill.exe',
      ['/F', '/IM', 'explorer.exe'],
      { timeout: 30_000 },
      err => resolve(!err),
    )
  })
  // Start it back even if the kill reported failure: Explorer may already have
  // been down (a previous run that stopped here), and leaving the desktop blank
  // is far worse than a redundant start.
  const started = await startExplorer()
  if (!started) {
    logger.error({ killed }, 'windows-settings: Explorer could not be restarted -- the desktop may be blank')
    return false
  }
  if (openFolders.length > 0) await reopenExplorerFolders(openFolders)
  return true
}

/**
 * Paths of the folder windows currently open, via the Shell COM automation
 * object. Failure is not fatal anywhere: not reopening a window is an
 * inconvenience, while refusing to restore over it would be a regression.
 */
async function listOpenExplorerFolders(): Promise<string[]> {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$shell = New-Object -ComObject Shell.Application',
    '$shell.Windows() | ForEach-Object {',
    '  $p = $_.Document.Folder.Self.Path',
    // Skip Control Panel and other virtual namespaces: they have no filesystem
    // path, and handing their display name back to explorer.exe opens nothing.
    '  if ($p -and (Test-Path -LiteralPath $p)) { $p }',
    '}',
  ].join('\r\n')
  const out = await runPowerShellScript('marveen-list-explorer-windows', script)
  if (out == null) return []
  return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
}

/**
 * Reopen the folder windows that were open before the restart.
 *
 * Through a scheduled task, not Start-Process: a PowerShell run from WSL is not
 * in the interactive desktop session, so `Start-Process explorer.exe <path>`
 * returns success and opens nothing at all -- verified the hard way here after
 * the first attempt restored everything correctly and still left Boss without
 * his window (2026-08-11). Same lesson as starting the tray app; the desktop is
 * only reachable through a task running as the logged-in user.
 */
async function reopenExplorerFolders(paths: string[]): Promise<void> {
  // Explorer needs a moment after starting before it will accept these.
  await new Promise(r => setTimeout(r, 2_000))
  const lines = ['$ErrorActionPreference = "SilentlyContinue"']
  for (const p of paths) {
    lines.push(`Start-Process explorer.exe -ArgumentList '"${p.replace(/'/g, "''")}"'`)
    lines.push('Start-Sleep -Milliseconds 500')
  }
  const ok = await runScriptViaTaskScheduler('MarveenReopenFolders', 'marveen-reopen-explorer-windows', lines.join('\r\n'))
  logger.info({ count: paths.length, ok }, 'windows-settings: reopened Explorer folders')
}

/**
 * Write a PowerShell script and run it inside the interactive desktop session
 * via a scheduled task. Anything that has to touch the desktop goes this way.
 */
async function runScriptViaTaskScheduler(taskName: string, fileName: string, script: string): Promise<boolean> {
  const wslPath = `/mnt/c/Users/Public/${fileName}.ps1`
  const winPath = `C:\\Users\\Public\\${fileName}.ps1`
  try {
    writeFileSync(wslPath, '\ufeff' + script, 'utf-8')
  } catch (err) {
    logger.warn({ err, fileName }, 'windows-settings: could not write the task script')
    return false
  }
  const launcher = [
    '$ErrorActionPreference = "Stop"',
    '$id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    `$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File ${winPath}'`,
    '$principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive',
    `Register-ScheduledTask -TaskName '${taskName}' -Action $action -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${taskName}'`,
  ].join('\r\n')
  const launcherWsl = `/mnt/c/Users/Public/${fileName}-launch.ps1`
  const launcherWin = `C:\\Users\\Public\\${fileName}-launch.ps1`
  try {
    writeFileSync(launcherWsl, '\ufeff' + launcher, 'utf-8')
  } catch (err) {
    logger.warn({ err }, 'windows-settings: could not write the task launcher')
    return false
  }
  return await new Promise<boolean>(resolve => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherWin],
      { timeout: 120_000 },
      err => resolve(!err),
    )
  })
}

/**
 * Write a PowerShell script (UTF-8 BOM -- 5.1 reads BOM-less files as ANSI and
 * mangles accented paths) and run it, returning stdout or null on failure.
 */
async function runPowerShellScript(name: string, script: string): Promise<string | null> {
  const wslPath = `/mnt/c/Users/Public/${name}.ps1`
  const winPath = `C:\\Users\\Public\\${name}.ps1`
  try {
    writeFileSync(wslPath, '\ufeff' + script, 'utf-8')
  } catch (err) {
    logger.warn({ err, name }, 'windows-settings: could not write helper script')
    return null
  }
  return await new Promise<string | null>(resolve => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winPath],
      { timeout: 60_000 },
      (err, stdout) => resolve(err ? null : String(stdout ?? '')),
    )
  })
}

/** Launch Explorer in the interactive desktop session. */
async function startExplorer(): Promise<boolean> {
  const lines = [
    '$ErrorActionPreference = "Stop"',
    '$id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name',
    '$action = New-ScheduledTaskAction -Execute "C:\\Windows\\explorer.exe"',
    '$principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive',
    `Register-ScheduledTask -TaskName '${EXPLORER_TASK_NAME}' -Action $action -Principal $principal -Force | Out-Null`,
    `Start-ScheduledTask -TaskName '${EXPLORER_TASK_NAME}'`,
  ]
  try {
    // BOM: Windows PowerShell 5.1 reads a BOM-less file as ANSI (same trap as
    // the PersistentWindows start script).
    writeFileSync(EXPLORER_SCRIPT_WSL, '\ufeff' + lines.join('\r\n'), 'utf-8')
  } catch (err) {
    logger.error({ err }, 'windows-settings: could not write the Explorer start script')
    return false
  }
  const launched = await new Promise<boolean>(resolve => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', EXPLORER_SCRIPT_WIN],
      { timeout: 60_000 },
      err => resolve(!err),
    )
  })
  if (!launched) return false
  // Confirm it is actually up rather than trusting the launch call -- a blank
  // desktop is the one outcome that must never pass silently.
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await isExplorerRunning()) return true
  }
  return false
}

function isExplorerRunning(): Promise<boolean> {
  return new Promise(resolve => {
    execFile(
      '/mnt/c/Windows/System32/tasklist.exe',
      ['/FI', 'IMAGENAME eq explorer.exe', '/FO', 'CSV', '/NH'],
      { timeout: 15_000 },
      (err, stdout) => resolve(!err && /explorer\.exe/i.test(String(stdout ?? ''))),
    )
  })
}

export interface SettingsBackup {
  /** Folder name, which is the ISO timestamp the backup was taken at. */
  id: string
  /** Unix seconds. */
  takenAt: number
  groups: string[]
}

/** Pre-restore backups, newest first. */
export function listSettingsBackups(): SettingsBackup[] {
  let names: string[]
  try { names = readdirSync(WIN_SETTINGS_BACKUP_DIR) } catch { return [] }
  const out: SettingsBackup[] = []
  for (const name of names) {
    const dir = join(WIN_SETTINGS_BACKUP_DIR, name)
    let s: ReturnType<typeof statSync>
    try { s = statSync(dir) } catch { continue }
    if (!s.isDirectory()) continue
    let groups: string[] = []
    try { groups = readdirSync(dir).filter(f => f.endsWith('.reg')).map(f => f.replace(/\.reg$/, '')) } catch { /* empty */ }
    if (groups.length === 0) continue
    out.push({ id: name, takenAt: Math.floor(Number(s.mtimeMs) / 1000), groups })
  }
  return out.sort((a, b) => b.takenAt - a.takenAt)
}

/**
 * Put back the state captured immediately before the last restore.
 *
 * Boss asked the right question -- "hol van a visszaállító gomb?" (2026-08-11).
 * The safety copy existed from the start, but only I could reach it, from a
 * shell. A backup nobody can restore without calling me is not a safety net, it
 * is a story about one. This is the undo button behind it.
 */
export async function undoWindowsSettings(backupId?: string): Promise<WindowsSettingsRestoreResult> {
  const result: WindowsSettingsRestoreResult = { ok: false, restored: [], failed: [], backupDir: null, explorerRestarted: false }
  if (!existsSync(REG_EXE)) {
    result.failed.push({ id: '*', error: 'not a Windows host' })
    return result
  }
  const backups = listSettingsBackups()
  const chosen = backupId ? backups.find(b => b.id === backupId) : backups[0]
  if (!chosen) {
    result.failed.push({ id: '*', error: 'no backup to undo to' })
    return result
  }
  const dir = join(WIN_SETTINGS_BACKUP_DIR, chosen.id)
  result.backupDir = dir
  mkdirSync(WIN_WORK_WSL, { recursive: true })

  for (const group of chosen.groups) {
    const source = join(dir, `${group}.reg`)
    if (!existsSync(source)) continue
    const winSource = `${WIN_WORK_WIN}\\undo-${group}.reg`
    const wslSource = join(WIN_WORK_WSL, `undo-${group}.reg`)
    copyFileSync(source, wslSource)
    const imported = await reg(['import', winSource])
    rmSync(wslSource, { force: true })
    if (imported.ok) result.restored.push(group)
    else result.failed.push({ id: group, error: imported.stderr.trim() || 'import failed' })
  }
  result.ok = result.restored.length > 0
  // Always bring Explorer back, even if every import failed: the desktop must
  // never be left blank because of this code path.
  result.explorerRestarted = await restartExplorer()
  logger.info({ backup: chosen.id, restored: result.restored.length }, 'windows-settings: undo applied')
  return result
}
