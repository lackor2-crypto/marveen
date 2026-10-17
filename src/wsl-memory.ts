// Is the WSL virtual machine's memory limit set on THIS machine? (card #683)
//
// Why it is on the Overview self-check: on 2026-10-17 a 10 GB WSL VM ran out of
// memory and swap, froze, and took the whole fleet with it for ~7 minutes after
// the Windows restart. WSL decides the VM size from C:\Users\<name>\.wslconfig;
// without `memory=` / `swap=` there it uses its own defaults (half of the host
// RAM, a small swap), which a busy fleet outgrows. Nothing on the install says
// so, because a missing limit produces no error -- only a freeze later.
//
// "Not WSL" and "could not look" are different answers and stay different
// (the NULL rule): only a measured, readable file counts as `ok`, and a machine
// that is not WSL at all is `not_applicable`, so the item is simply not shown.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type WslMemoryState =
  /** Not a WSL install: there is nothing to configure, the item is hidden. */
  | 'not_applicable'
  /** .wslconfig found and it sets a swap size (the memory limit is left to the owner / WSL default). */
  | 'ok'
  /** .wslconfig found (or measurably absent) but no swap size is set. */
  | 'missing'
  /** WSL, but the Windows profile could not be read from here: unknown, not "fine". */
  | 'unreadable'

export interface WslMemoryReport {
  state: WslMemoryState
  /** Windows path as seen from WSL (/mnt/c/Users/<name>/.wslconfig), when found. */
  path?: string
  memoryGb?: number
  swapGb?: number
}

export function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true
  try { return /microsoft|wsl/i.test(readFileSync('/proc/version', 'utf-8')) } catch { return false }
}

/** "10GB" / "8192MB" / "4G" / "0" -> GB (number), or undefined when not a size. */
export function parseSizeGb(raw: string): number | undefined {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(tb|gb|mb|kb|t|g|m|k|b)?\s*$/i.exec(raw)
  if (!m) return undefined
  const n = parseFloat(m[1])
  const unit = (m[2] ?? 'b').toLowerCase()
  const toGb: Record<string, number> = {
    tb: 1024, t: 1024, gb: 1, g: 1, mb: 1 / 1024, m: 1 / 1024, kb: 1 / 1048576, k: 1 / 1048576, b: 1 / 1073741824,
  }
  return Math.round(n * toGb[unit] * 100) / 100
}

/** The [wsl2] memory / swap values of a .wslconfig text (comments and other sections ignored). */
export function parseWslConfig(text: string): { memoryGb?: number; swapGb?: number } {
  let section = ''
  const out: { memoryGb?: number; swapGb?: number } = {}
  for (const line of text.split(/\r?\n/)) {
    const l = line.replace(/[#;].*$/, '').trim()
    if (!l) continue
    const sec = /^\[([^\]]+)\]$/.exec(l)
    if (sec) { section = sec[1].trim().toLowerCase(); continue }
    if (section !== 'wsl2') continue
    const kv = /^([A-Za-z0-9_.]+)\s*=\s*(.*)$/.exec(l)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    if (key === 'memory') out.memoryGb = parseSizeGb(kv[2])
    if (key === 'swap') out.swapGb = parseSizeGb(kv[2])
  }
  return out
}

/** Pure classification of a readable .wslconfig text. */
export function classifyWslConfig(text: string | null): WslMemoryReport['state'] {
  if (text === null) return 'missing'
  const c = parseWslConfig(text)
  // Owner decision (card #683): the recommendation is swap=2GB; the memory value
  // stays whatever the owner / WSL default has, so only the swap is required.
  return c.swapGb !== undefined ? 'ok' : 'missing'
}

/** Real Windows profile folders under /mnt/c/Users (Public / Default / All Users are not profiles). */
function windowsProfileDirs(): string[] {
  try {
    const skip = new Set(['public', 'default', 'default user', 'all users', 'desktop.ini'])
    return readdirSync('/mnt/c/Users').filter((n) => !skip.has(n.toLowerCase())).map((n) => join('/mnt/c/Users', n))
  } catch { return [] }
}

// Plain directory reads only (no cmd.exe call): this runs inside the dashboard
// request that builds the Overview, where a blocking child process would stall
// the event loop.
export function measureWslMemory(): WslMemoryReport {
  if (!isWsl()) return { state: 'not_applicable' }
  const profiles = windowsProfileDirs()
  const withFile = profiles.find((d) => existsSync(join(d, '.wslconfig')))
  if (withFile) {
    const path = join(withFile, '.wslconfig')
    let text: string
    try { text = readFileSync(path, 'utf-8') } catch { return { state: 'unreadable', path } }
    return { state: classifyWslConfig(text), path, ...parseWslConfig(text) }
  }
  // No profile has the file. With exactly one profile that is a measured "not there";
  // with none readable, or several, we cannot tell whose it would be: unknown.
  if (profiles.length === 1) return { state: 'missing', path: join(profiles[0], '.wslconfig') }
  return { state: 'unreadable' }
}
