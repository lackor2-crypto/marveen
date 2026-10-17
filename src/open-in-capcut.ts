/**
 * "Open in CapCut" convenience bridge (#670, Boss TG 9298 option 3).
 *
 * CapCut is a desktop video editor, so it only exists on a machine with a desktop: found here on Windows (seen from
 * WSL) and macOS, never on a server or a plain Linux box. The Workbench shows the button ONLY when this probe finds
 * the program (an extra: its absence is silent, never a failure).
 *
 * MEASURED, not assumed (2026-10-17, CapCut 9.1 on Windows): `CapCut.exe "<file>.mp4"` starts the program and ignores
 * the file argument -- it opens on its own start screen and imports nothing. So the bridge does NOT pretend to pass the
 * video: it starts CapCut AND opens the folder of the finished video in the file manager with the file selected, so the
 * video is one drag away. The answer says so (`file_passed: false`).
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { isWsl } from './web/scheduled-tasks-io.js'
import { PLATFORM } from './platform.js'
import { runScriptViaTaskScheduler } from './windows-settings.js'
import { openInFileManager, readOpenResult, toWindowsPath, unregisterTasks } from './open-in-file-manager.js'

export interface CapcutInstall { kind: 'windows' | 'macos'; path: string }

/** Where this machine has CapCut, or null. `MARVEEN_CAPCUT` (a full path) overrides the search; `none` switches the bridge off. */
export function findCapcut(): CapcutInstall | null {
  const forced = (process.env['MARVEEN_CAPCUT'] || '').trim()
  if (forced.toLowerCase() === 'none') return null
  if (isWsl()) {
    const cands: string[] = []
    if (forced) cands.push(forced)
    try {
      for (const u of readdirSync('/mnt/c/Users')) cands.push(`/mnt/c/Users/${u}/AppData/Local/CapCut/Apps/CapCut.exe`)
    } catch { /* no Windows drive mounted: no CapCut to find */ }
    cands.push('/mnt/c/Program Files/CapCut/CapCut.exe', '/mnt/c/Program Files (x86)/CapCut/CapCut.exe')
    for (const c of cands) {
      try { if (statSync(c).isFile()) return { kind: 'windows', path: c } } catch { /* next */ }
    }
    return null
  }
  if (PLATFORM === 'macos') {
    for (const c of [forced, '/Applications/CapCut.app', join(process.env['HOME'] || '', 'Applications/CapCut.app')]) {
      if (c && existsSync(c)) return { kind: 'macos', path: c }
    }
  }
  return null
}

/** The PowerShell that starts CapCut (no file argument, see above) and reports "ok" or "fail :: <message>". */
export function capcutLaunchScript(exeWin: string, resultWinPath: string): string {
  const q = (s: string): string => s.replace(/'/g, "''")
  return [
    '$ErrorActionPreference = "Stop"',
    `$e = '${q(exeWin)}'`,
    `$r = '${q(resultWinPath)}'`,
    'try {',
    '  $proc = Start-Process -FilePath $e -PassThru',
    '  $name = if ($proc) { $proc.ProcessName } else { "reused" }',
    '  "ok $name" | Set-Content -Encoding UTF8 -LiteralPath $r',
    '} catch {',
    '  "fail :: $($_.Exception.Message)" | Set-Content -Encoding UTF8 -LiteralPath $r',
    '}',
  ].join('\r\n')
}

export type CapcutOutcome =
  | { ok: true; file_passed: false }
  | { ok: false; code: 'no_capcut' | 'not_found' | 'open_failed' | 'open_unconfirmed' }

function spawnDetached(cmd: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('spawn', () => { child.unref(); resolve(true) })
    } catch { resolve(false) }
  })
}

/** Start CapCut and show `abs` (a finished video) in the file manager, selected. */
export async function openInCapcut(abs: string): Promise<CapcutOutcome> {
  const cap = findCapcut()
  if (!cap) return { ok: false, code: 'no_capcut' }
  if (!existsSync(abs)) return { ok: false, code: 'not_found' }
  if (cap.kind === 'macos') {
    const started = await spawnDetached('open', ['-a', cap.path])
    if (!started) return { ok: false, code: 'open_failed' }
    await openInFileManager(abs)
    return { ok: true, file_passed: false }
  }
  const exeWin = await toWindowsPath(cap.path)
  if (!exeWin) return { ok: false, code: 'open_failed' }
  const id = randomBytes(5).toString('hex')
  const base = `marveen-open-capcut-${id}`
  const resultWsl = `/mnt/c/Users/Public/${base}.result.txt`
  const resultWin = `C:\\Users\\Public\\${base}.result.txt`
  const taskName = `MarveenOpenCapcut-${id}`
  try { rmSync(resultWsl, { force: true }) } catch { /* nothing there */ }
  const started = await runScriptViaTaskScheduler(taskName, base, capcutLaunchScript(exeWin, resultWin))
  try {
    if (!started) return { ok: false, code: 'open_failed' }
    const res = await readOpenResult(resultWsl, 10_000)
    if (res === null) return { ok: false, code: 'open_unconfirmed' }
    if (!res.startsWith('ok')) return { ok: false, code: 'open_failed' }
  } finally {
    void unregisterTasks([taskName])
    for (const f of [resultWsl, `/mnt/c/Users/Public/${base}.ps1`, `/mnt/c/Users/Public/${base}-launch.ps1`]) {
      try { rmSync(f, { force: true }) } catch { /* best effort */ }
    }
  }
  // The folder is the half that always works: the video selected, one drag from the CapCut window.
  await openInFileManager(abs)
  return { ok: true, file_passed: false }
}
