/**
 * Open a folder (or show a file inside it) in the file manager of the machine
 * Marvin runs on -- the Windows Explorer from WSL, Finder on a Mac, the desktop
 * file manager on a Linux box with a display (#443, Boss 2026-09-29: "egy
 * gombnyomas, es mar is ott vagyok a kozos tarban, abban a mappaban").
 *
 * From WSL the window goes through a scheduled task in the interactive desktop
 * session: a process started straight from WSL is not in that session when the
 * distro was started by a boot task, and Explorer then returns success and
 * shows nothing (the same lesson as windows-settings.ts, 2026-08-11).
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { PLATFORM, tryResolveFromPath } from './platform.js'
import { isWsl } from './web/scheduled-tasks-io.js'
import { runScriptViaTaskScheduler } from './windows-settings.js'

export type FileManagerKind = 'windows' | 'macos' | 'linux' | 'none'

/** Which file manager this machine can open, if any. */
export function fileManagerKind(): FileManagerKind {
  if (isWsl()) return 'windows'
  if (PLATFORM === 'macos') return 'macos'
  if (PLATFORM === 'linux-gui' && tryResolveFromPath('xdg-open')) return 'linux'
  return 'none'
}

export type OpenOutcome = { ok: true } | { ok: false; code: 'no_file_manager' | 'open_failed' | 'not_found' }

function toWindowsPath(abs: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile('wslpath', ['-w', abs], { timeout: 10_000 }, (err, stdout) => {
      const out = String(stdout ?? '').trim()
      resolve(err || !out ? null : out)
    })
  })
}

/** The PowerShell line that opens `winPath` (a folder, or a file to select). */
export function explorerScript(winPath: string, select: boolean): string {
  const q = winPath.replace(/'/g, "''")
  const arg = select ? `'/select,"${q}"'` : `'"${q}"'`
  return ['$ErrorActionPreference = "SilentlyContinue"', `Start-Process explorer.exe -ArgumentList ${arg}`].join('\r\n')
}

function detached(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('spawn', () => { child.unref(); resolve(true) })
    } catch { resolve(false) }
  })
}

/**
 * Open `abs` in the file manager. A folder opens as it is; a file opens its
 * folder with the file selected where the file manager can do that.
 */
export async function openInFileManager(abs: string): Promise<OpenOutcome> {
  let isFile = false
  try {
    if (!existsSync(abs)) return { ok: false, code: 'not_found' }
    isFile = statSync(abs).isFile()
  } catch { return { ok: false, code: 'not_found' } }
  const kind = fileManagerKind()
  if (kind === 'none') return { ok: false, code: 'no_file_manager' }
  if (kind === 'windows') {
    const win = await toWindowsPath(abs)
    if (!win) return { ok: false, code: 'open_failed' }
    const ok = await runScriptViaTaskScheduler('MarveenOpenFolder', 'marveen-open-folder', explorerScript(win, isFile))
    return ok ? { ok: true } : { ok: false, code: 'open_failed' }
  }
  if (kind === 'macos') {
    const ok = await detached('open', isFile ? ['-R', abs] : [abs])
    return ok ? { ok: true } : { ok: false, code: 'open_failed' }
  }
  const dir = isFile ? abs.slice(0, abs.lastIndexOf('/')) || '/' : abs
  const ok = await detached('xdg-open', [dir])
  return ok ? { ok: true } : { ok: false, code: 'open_failed' }
}
