/**
 * Open a backup file: decrypt, untar into a directory, check it against its
 * own manifest (#396). Shared by `cli verify`, restore inspection and the
 * scheduled verify.
 *
 * The archive is authenticated before tar ever sees a byte of it (AES-GCM per
 * chunk, header bound through the AAD), so only someone holding the recovery
 * key can produce an archive this unpacks.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { BackupDecryptError, decryptStream, readHeader, type BackupHeader } from './crypto.js'
import type { BackupManifest } from './create.js'

export async function extractBackup(file: string, recoveryKey: string, destDir: string): Promise<{ header: BackupHeader; manifest: BackupManifest }> {
  const { header, headerBytes, payloadOffset } = readHeader(file)
  // Throws wrong_key synchronously, before tar is started.
  const dec = decryptStream(recoveryKey, header, headerBytes)
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', '-', '-C', destDir, '--no-same-owner'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    let pipeErr: unknown = null
    let tarCode: number | null | undefined
    let piped = false
    tar.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    const settle = () => {
      if (tarCode === undefined || !piped) return
      // A decrypt error is the real cause; tar's "unexpected EOF" is its echo.
      if (pipeErr) return reject(pipeErr)
      if (tarCode !== 0) return reject(new BackupDecryptError('corrupt', `The backup could not be unpacked: ${stderr.trim().slice(0, 300)}`))
      resolve()
    }
    tar.on('error', reject)
    tar.on('close', (code) => { tarCode = code; settle() })
    pipeline(createReadStream(file, { start: payloadOffset }), dec, tar.stdin)
      .catch((e) => { pipeErr = e; try { tar.stdin.destroy() } catch { /* closed */ } })
      .finally(() => { piped = true; settle() })
  })
  const mf = join(destDir, 'manifest.json')
  if (!existsSync(mf)) throw new BackupDecryptError('corrupt', 'The backup has no manifest.')
  const manifest = JSON.parse(readFileSync(mf, 'utf8')) as BackupManifest
  return { header, manifest }
}

function sha256File(p: string): string {
  const h = createHash('sha256')
  const fd = openSync(p, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (let pos = 0; ;) {
      const n = readSync(fd, buf, 0, buf.length, pos)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
      pos += n
    }
  } finally { closeSync(fd) }
  return h.digest('hex')
}

/** Every manifest file present with the right hash; returns the bad paths. */
export function checkManifestHashes(dir: string, manifest: BackupManifest): { missing: string[]; mismatched: string[] } {
  const missing: string[] = []
  const mismatched: string[] = []
  for (const f of manifest.files) {
    const p = join(dir, f.path)
    let isFile = false
    try { isFile = lstatSync(p).isFile() } catch { /* missing */ }
    if (!isFile) { missing.push(f.path); continue }
    if (sha256File(p) !== f.sha256) mismatched.push(f.path)
  }
  return { missing, mismatched }
}
