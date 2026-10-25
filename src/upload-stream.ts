// Large uploads (#663): the request body goes to a staging file on disk while it
// arrives, never into one Buffer. `readBody` buffers the whole body, so a
// multi-GB upload would take the server down with an out-of-memory error.
//
// The limit is a setting (WORKBENCH_UPLOAD_MAX_MB, 0 = no limit), not a constant:
// every install decides for itself how big a file may be.

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync, openSync,
  readdirSync, readFileSync, readSync, statSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import { STORE_DIR } from './config.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { RequestBodyTooLargeError } from './web/http-helpers.js'

/** Upper bound for the routes that must hold the body in memory (a picture or a PDF edited in the browser). */
export const BUFFERED_UPLOAD_CAP_BYTES = 1024 * 1024 * 1024

const STAGE_DIR = join(STORE_DIR, 'upload-tmp')
/** A staging file older than this is a leftover of a crashed upload. */
const STALE_MS = 6 * 60 * 60 * 1000

/** The configured upload limit in bytes; 0 = no limit. */
export function uploadLimitBytes(): number {
  const mb = Number(getEffectiveSettingValue('WORKBENCH_UPLOAD_MAX_MB'))
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb) * 1024 * 1024 : 0
}

/** The limit the "too large" sentence names, in MB (the in-memory cap when no limit is set). */
export function uploadLimitMbForMessage(): number {
  const b = uploadLimitBytes()
  return Math.floor((b > 0 ? b : BUFFERED_UPLOAD_CAP_BYTES) / (1024 * 1024))
}

/** Does a declared Content-Length already exceed the limit? Checked before a byte is read. */
export function uploadExceeds(declared: number): boolean {
  const limit = uploadLimitBytes()
  return limit > 0 && declared > limit
}

/** A body that did not fit on the disk (or could not be written there). */
export class UploadDiskError extends Error {
  readonly full: boolean
  constructor(message: string, full: boolean) {
    super(message)
    this.name = 'UploadDiskError'
    this.full = full
  }
}

export interface StagedUpload {
  readonly staged: true
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  /** Remove the staging file (idempotent). */
  discard(): void
}

/** What a writer takes: the bytes themselves, or a body already staged on disk. */
export type UploadData = Buffer | StagedUpload

export const isStaged = (d: UploadData): d is StagedUpload => !Buffer.isBuffer(d) && (d as StagedUpload).staged === true
export const dataBytes = (d: UploadData): number => (isStaged(d) ? d.bytes : d.length)
export const dataSha256 = (d: UploadData): string => (isStaged(d) ? d.sha256 : createHash('sha256').update(d).digest('hex'))

/** SHA-256 of a file read in chunks (a multi-GB file never sits in memory). */
export function fileSha256(abs: string): string {
  const h = createHash('sha256')
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}

/** Does the file at `abs` hold exactly the bytes of `d`? Size first, then content. */
export function fileEqualsData(abs: string, d: UploadData): boolean {
  if (statSync(abs).size !== dataBytes(d)) return false
  return isStaged(d) ? fileSha256(abs) === d.sha256 : readFileSync(abs).equals(d)
}

function sweepStale(): void {
  try {
    const now = Date.now()
    for (const n of readdirSync(STAGE_DIR)) {
      const p = join(STAGE_DIR, n)
      try { if (now - statSync(p).mtimeMs > STALE_MS) unlinkSync(p) } catch { /* gone or busy: leave it */ }
    }
  } catch { /* no staging dir yet */ }
}

function discardFile(path: string): void {
  try { unlinkSync(path) } catch { /* already gone */ }
}

/**
 * Stream the request body to a staging file, hashing it on the way. Throws
 * RequestBodyTooLargeError past `maxBytes` (0 = no limit) and UploadDiskError
 * when the disk cannot take it; the staging file is removed on every failure.
 */
export function streamBodyToStage(req: http.IncomingMessage, maxBytes: number = uploadLimitBytes()): Promise<StagedUpload> {
  return new Promise((resolve, reject) => {
    let path = ''
    try {
      mkdirSync(STAGE_DIR, { recursive: true })
      sweepStale()
      path = join(STAGE_DIR, `${randomUUID()}.part`)
    } catch (e) {
      reject(new UploadDiskError(e instanceof Error ? e.message : String(e), false))
      return
    }
    const ws = createWriteStream(path, { flags: 'wx' })
    const hash = createHash('sha256')
    let total = 0
    let settled = false
    let ended = false
    const bail = (err: Error): void => {
      if (settled) return
      settled = true
      // The stream opens its file asynchronously. Removing it right after destroy() raced that open: on a busy machine
      // the unlink ran first (nothing there yet), then the open created an empty .part that stayed for STALE_MS. Remove
      // it once the stream has closed, and only then answer.
      const done = (): void => { discardFile(path); reject(err) }
      if (ws.closed) { done(); return }
      ws.once('close', done)
      ws.destroy()
    }
    ws.on('error', (e: NodeJS.ErrnoException) => bail(new UploadDiskError(e.message, e.code === 'ENOSPC' || e.code === 'EDQUOT')))
    req.on('data', (c: Buffer) => {
      if (settled) return
      total += c.length
      if (maxBytes > 0 && total > maxBytes) {
        // The request is NOT destroyed: a dead socket would turn the "too large" sentence into a bare network error
        // for a body without an honest Content-Length. The rest is read and thrown away (the 'data' handler returns
        // early once settled) and Node drains whatever is left after the response.
        bail(new RequestBodyTooLargeError(maxBytes))
        return
      }
      hash.update(c)
      if (!ws.write(c)) {
        req.pause()
        ws.once('drain', () => req.resume())
      }
    })
    req.on('end', () => {
      ended = true
      if (settled) return
      ws.end(() => {
        if (settled) return
        settled = true
        resolve({
          staged: true, path, bytes: total, sha256: hash.digest('hex'),
          discard: () => discardFile(path),
        })
      })
    })
    req.on('error', (e) => bail(e))
    req.on('close', () => { if (!ended) bail(new Error('upload aborted')) })
  })
}

/**
 * Put a staged body at `destAbs`, never over an existing file (the same rule as
 * `writeFileSync(..., { flag: 'wx' })`). A hard link when both sit on one
 * filesystem, a copy otherwise; the staging file is gone afterwards.
 */
export function placeStaged(d: StagedUpload, destAbs: string): void {
  try {
    linkSync(d.path, destAbs)
  } catch (e) {
    // EEXIST is the "never over an existing file" guard. Any other link failure (another filesystem, a mount that
    // has no hard links) falls back to a copy.
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw e
    try {
      copyFileSync(d.path, destAbs, constants.COPYFILE_EXCL)
    } catch (c) {
      // A half-written copy (disk full) must not stay behind as a broken file.
      if ((c as NodeJS.ErrnoException).code !== 'EEXIST') { try { unlinkSync(destAbs) } catch { /* not there */ } }
      throw c
    }
  }
  if (!existsSync(destAbs)) throw new Error('placed file is missing')
  d.discard()
}
