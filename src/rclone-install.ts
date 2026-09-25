// rclone telepitese a FELULETROL (kartya #360, 5. pont: friss telepitesen is).
//
// Eddig, ha az rclone hianyzott, a felulet csak annyit mondott: "futtasd ujra
// a telepitot" -- vagyis terminal kellett hozza. Ez a modul ugyanazt csinalja,
// amit az install-linux.sh `install_rclone` fuggvenye: a hivatalos aktualis
// kiadast tolti le a ~/.local/bin ala, rendszergazdai jog nelkul, a kiado sajat
// SHA256SUMS listajaval ellenorizve. Linuxon es macOS-en egyforman (az rclone
// mindkettore ad zip-et), tehat macOS-en sem kell hozza Homebrew.
//
// Verziot NEM egetunk be: a downloads.rclone.org/version.txt mondja meg.
// Ellenorzo-osszeg nelkul (vagy eltereskor) SEMMI nem kerul a gepre.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const RCLONE_DOWNLOADS = 'https://downloads.rclone.org'

export type RcloneInstallCode =
  | 'unsupported_platform' | 'version_failed' | 'download_failed'
  | 'checksum_missing' | 'checksum_mismatch' | 'unzip_failed' | 'write_failed'

export type RcloneInstallResult =
  | { ok: true; version: string; path: string }
  | { ok: false; code: RcloneInstallCode; detail: string }

export interface RcloneInstallDeps {
  fetchImpl?: typeof fetch
  /** Kicsomagol egy tagot a zip-bol a `dest` mappaba (alapbol: `unzip -j -o`). */
  unzip?: (zip: string, member: string, dest: string) => Promise<{ ok: boolean; detail: string }>
  home?: string
  platform?: NodeJS.Platform
  arch?: string
}

/** A kiado fajlnevenek OS- es processzor-resze; `null` = nincs hozza kiadas. */
export function rcloneTarget(platform: NodeJS.Platform, arch: string): { os: string; arch: string } | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'osx' : null
  const a = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null
  return os && a ? { os, arch: a } : null
}

/** A version.txt elso sora: "rclone v1.75.1". Csak `v<szam>`-mal kezdodot fogadunk el. */
export function parseRcloneVersion(text: string): string | null {
  const m = /rclone\s+(v\d+\.\d+\.\d+)\b/.exec(String(text || ''))
  return m ? m[1] : null
}

/** A SHA256SUMS listabol a megadott fajl osszege; `null`, ha nincs benne. */
export function checksumFor(sums: string, file: string): string | null {
  for (const line of String(sums || '').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim())
    if (m && m[2] === file) return m[1].toLowerCase()
  }
  return null
}

const defaultUnzip: NonNullable<RcloneInstallDeps['unzip']> = (zip, member, dest) =>
  new Promise((resolve) => {
    execFile('unzip', ['-q', '-j', '-o', zip, member, '-d', dest], { timeout: 120_000 }, (err, _out, stderr) => {
      resolve(err ? { ok: false, detail: String(stderr || err.message).trim().slice(-300) } : { ok: true, detail: '' })
    })
  })

export async function installRclone(deps: RcloneInstallDeps = {}): Promise<RcloneInstallResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const unzip = deps.unzip ?? defaultUnzip
  const home = deps.home ?? homedir()
  const target = rcloneTarget(deps.platform ?? process.platform, deps.arch ?? process.arch)
  if (!target) return { ok: false, code: 'unsupported_platform', detail: `${deps.platform ?? process.platform}/${deps.arch ?? process.arch}` }

  const getText = async (url: string): Promise<string> => {
    const r = await fetchImpl(url)
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`)
    return await r.text()
  }

  let version: string | null
  try {
    version = parseRcloneVersion(await getText(`${RCLONE_DOWNLOADS}/version.txt`))
  } catch (e: any) {
    return { ok: false, code: 'version_failed', detail: String(e?.message || e) }
  }
  if (!version) return { ok: false, code: 'version_failed', detail: 'version.txt' }

  const dir = `rclone-${version}-${target.os}-${target.arch}`
  const zipName = `${dir}.zip`
  let sums: string
  let zipBytes: Buffer
  try {
    sums = await getText(`${RCLONE_DOWNLOADS}/${version}/SHA256SUMS`)
    const r = await fetchImpl(`${RCLONE_DOWNLOADS}/${version}/${zipName}`)
    if (!r.ok) throw new Error(`HTTP ${r.status} ${zipName}`)
    zipBytes = Buffer.from(await r.arrayBuffer())
  } catch (e: any) {
    return { ok: false, code: 'download_failed', detail: String(e?.message || e) }
  }
  const want = checksumFor(sums, zipName)
  if (!want) return { ok: false, code: 'checksum_missing', detail: zipName }
  const got = createHash('sha256').update(zipBytes).digest('hex')
  if (got !== want) return { ok: false, code: 'checksum_mismatch', detail: zipName }

  const tmp = mkdtempSync(join(tmpdir(), 'marveen-rclone-'))
  try {
    const zipPath = join(tmp, zipName)
    writeFileSync(zipPath, zipBytes)
    const u = await unzip(zipPath, `${dir}/rclone`, tmp)
    const extracted = join(tmp, 'rclone')
    if (!u.ok || !existsSync(extracted)) return { ok: false, code: 'unzip_failed', detail: u.detail || 'rclone' }
    const binDir = join(home, '.local', 'bin')
    const dest = join(binDir, 'rclone')
    try {
      mkdirSync(binDir, { recursive: true })
      // Atomikus csere: egy felig megirt binaris soha nem all a helyen.
      const part = dest + '.part'
      writeFileSync(part, readFileSync(extracted))
      chmodSync(part, 0o755)
      renameSync(part, dest)
    } catch (e: any) {
      return { ok: false, code: 'write_failed', detail: String(e?.message || e) }
    }
    return { ok: true, version, path: dest }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
