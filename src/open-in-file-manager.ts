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
import { existsSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
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

/**
 * The PowerShell script that opens the FILE itself with whatever Windows opens it with, and
 * writes what happened into `resultWinPath` ("ok ..." or "fail :: <message>", UTF-8).
 *
 * The scheduled task only says it STARTED; Start-Process failing (no program associated,
 * the file gone meanwhile) would otherwise look like a success. A running program that is
 * simply reused (Excel already open) returns no process -- that is not a failure, only the
 * exception is.
 */
export function openFileScript(winPath: string, resultWinPath: string): string {
  const q = (s: string): string => s.replace(/'/g, "''")
  return [
    '$ErrorActionPreference = "Stop"',
    `$p = '${q(winPath)}'`,
    `$r = '${q(resultWinPath)}'`,
    'try {',
    '  $proc = Start-Process -FilePath $p -PassThru',
    '  $name = if ($proc) { $proc.ProcessName } else { "reused" }',
    '  "ok $name" | Set-Content -Encoding UTF8 -LiteralPath $r',
    '} catch {',
    '  "fail :: $($_.Exception.Message)" | Set-Content -Encoding UTF8 -LiteralPath $r',
    '}',
  ].join('\r\n')
}

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/**
 * Remove scheduled tasks by name from the SERVER side. A task cannot delete itself: measured
 * 2026-10-10, Unregister-ScheduledTask from inside the running task fails with "Access is
 * denied" (the old in-script call swallowed it, and every click left a task behind), while
 * the same call from outside succeeds. A trailing `*` in a name is a wildcard.
 */
export async function unregisterTasks(names: string[]): Promise<boolean> {
  const safe = names.filter(n => /^[A-Za-z0-9-]+\*?$/.test(n))
  if (!safe.length) return true
  const cmd = safe.map(n => `Get-ScheduledTask -TaskName '${n}' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue`).join('; ')
  return await new Promise<boolean>(resolve => {
    execFile(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { timeout: 30_000 }, err => resolve(!err))
  })
}

let legacySwept: Promise<void> | null = null

/**
 * Once per process: the tasks and scripts earlier versions left behind (the fixed-name
 * "MarveenOpenFile" task and its two scripts, and per-call tasks that never went away).
 * "MarveenOpenFolder" (#443) is a different feature and is not touched.
 */
function sweepLegacyOpenFile(): Promise<void> {
  if (!legacySwept) {
    legacySwept = (async () => {
      await unregisterTasks(['MarveenOpenFile', 'MarveenOpenFile-*'])
      for (const f of ['marveen-open-file.ps1', 'marveen-open-file-launch.ps1']) {
        try { rmSync(`/mnt/c/Users/Public/${f}`, { force: true }) } catch { /* best effort */ }
      }
    })()
  }
  return legacySwept
}

export type OpenFileOutcome = OpenOutcome | { ok: false; code: 'not_a_file' | 'not_openable' | 'open_unconfirmed' }

/** How long the scheduled task gets to report back before the answer is "not confirmed". */
const OPEN_CONFIRM_MS = 10_000

/** Wait (without blocking the event loop) for the result file; null when it never came. */
async function readOpenResult(wslPath: string, timeoutMs: number): Promise<string | null> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const txt = (await readFile(wslPath, 'utf-8')).replace(/^\ufeff/, '').trim()
      if (txt) return txt
    } catch { /* not there yet */ }
    await new Promise(r => setTimeout(r, 250))
  }
  return null
}

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
    // One name per call: two quick clicks must not read each other's result.
    const id = randomBytes(5).toString('hex')
    const base = `marveen-open-file-${id}`
    const resultWsl = `/mnt/c/Users/Public/${base}.result.txt`
    const resultWin = `C:\\Users\\Public\\${base}.result.txt`
    try { rmSync(resultWsl, { force: true }) } catch { /* nothing there */ }
    await sweepLegacyOpenFile()
    const taskName = `MarveenOpenFile-${id}`
    const started = await runScriptViaTaskScheduler(taskName, base, openFileScript(win, resultWin))
    try {
      if (!started) return { ok: false, code: 'open_failed' }
      const res = await readOpenResult(resultWsl, OPEN_CONFIRM_MS)
      if (res === null) return { ok: false, code: 'open_unconfirmed' }
      return res.startsWith('ok') ? { ok: true } : { ok: false, code: 'open_failed' }
    } finally {
      // Also when nothing was confirmed or the start failed: the task never outlives the call.
      await unregisterTasks([taskName])
      for (const f of [resultWsl, `/mnt/c/Users/Public/${base}.ps1`, `/mnt/c/Users/Public/${base}-launch.ps1`]) {
        try { rmSync(f, { force: true }) } catch { /* best effort */ }
      }
    }
  }
  const ok = await detached(kind === 'macos' ? 'open' : 'xdg-open', [abs])
  return ok ? { ok: true } : { ok: false, code: 'open_failed' }
}
