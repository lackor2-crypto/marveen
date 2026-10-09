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
import { extname } from 'node:path'
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

// --- a file, in the program this machine opens it with (#529) --------------------------
//
// Owner, 2026-10-10: "marveen intezo miert nem tud megnyitni excelt? csinald meg hogy
// tudja megnyitni az excelt. mint a windows intezo". A click on a document opens it in
// the machine's own program (Excel, Word, the PDF reader), the way a double click does in
// the file manager.
//
// ONLY documents and media. "Open with the default program" RUNS a program or a script
// when the file is one (.exe, .bat, .lnk, .js ...): those are never opened this way, by
// an allowlist of extensions -- not by a list of the dangerous ones, which is never complete.
const OPENABLE = new Set([
  'doc', 'docx', 'odt', 'rtf', 'txt', 'md',
  'xls', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv',
  'ppt', 'pptx', 'odp', 'pdf',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'heic',
  'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mov', 'm4v', 'mkv', 'avi', 'webm',
])

/** Can this file be handed to the machine's own program? By its extension, an allowlist. */
export function openableWithDefaultApp(name: string): boolean {
  return OPENABLE.has(extname(String(name || '')).slice(1).toLowerCase())
}

/** The PowerShell line that opens the FILE itself with whatever Windows opens it with. */
export function openFileScript(winPath: string): string {
  return ['$ErrorActionPreference = "SilentlyContinue"', `Start-Process -FilePath '${winPath.replace(/'/g, "''")}'`].join('\r\n')
}

export type OpenFileOutcome = OpenOutcome | { ok: false; code: 'not_a_file' | 'not_openable' }

/** Open `abs` in the program this machine opens that kind of file with. */
export async function openWithDefaultApp(abs: string): Promise<OpenFileOutcome> {
  try {
    if (!existsSync(abs)) return { ok: false, code: 'not_found' }
    if (!statSync(abs).isFile()) return { ok: false, code: 'not_a_file' }
  } catch { return { ok: false, code: 'not_found' } }
  if (!openableWithDefaultApp(abs)) return { ok: false, code: 'not_openable' }
  const kind = fileManagerKind()
  if (kind === 'none') return { ok: false, code: 'no_file_manager' }
  if (kind === 'windows') {
    const win = await toWindowsPath(abs)
    if (!win) return { ok: false, code: 'open_failed' }
    const ok = await runScriptViaTaskScheduler('MarveenOpenFile', 'marveen-open-file', openFileScript(win))
    return ok ? { ok: true } : { ok: false, code: 'open_failed' }
  }
  const ok = await detached(kind === 'macos' ? 'open' : 'xdg-open', [abs])
  return ok ? { ok: true } : { ok: false, code: 'open_failed' }
}
