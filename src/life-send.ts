// SEND FROM THE INTEZO (#389) -- turning a selection of tree items into
// attachments: files as they are, folders zipped.
//
// The owner (TG 6369): "a mappa felett vagy kep felett [...] jobb egergomb,
// akkor ott van, hogy send to [...] tudjam kuldeni peldaul e-mailen".
//
// Nothing here SENDS anything. This module only measures a selection and
// builds the files the e-mail composer (or the browser's share sheet) will
// carry; the user still presses Send himself.
//
// The zip writer is our own (store/deflate, zlib.crc32): a fresh install has
// no `zip` binary, and a folder must be sendable there too.
import { readdirSync, statSync, lstatSync, readFileSync, mkdtempSync, rmSync, openSync, writeSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { deflateRawSync, crc32 } from 'node:zlib'
import { resolveLifePath } from './life-explorer.js'

/** Gmail and most providers refuse a message above 25 MB. */
export const EMAIL_ATTACH_LIMIT = 25 * 1024 * 1024
/** A share-sheet hand-over keeps the files in browser memory: keep it sane. */
export const SHARE_LIMIT = 200 * 1024 * 1024
/** A folder walk stops here -- a bigger folder is not something to mail. */
const MAX_WALK_FILES = 5000

type Lang = 'hu' | 'en'
const T = (lang: Lang, hu: string, en: string): string => (lang === 'en' ? en : hu)

export interface SendItemInfo {
  rel: string
  name: string
  isDir: boolean
  /** Bytes on disk (a folder: the sum of its files; the zip is about this or less). */
  bytes: number
  /** A folder: how many files go into its zip. */
  files: number
  /** The file name the receiver gets (a folder: `<name>.zip`). */
  sendName: string
}

export interface SendInfo {
  ok: boolean
  items: SendItemInfo[]
  totalBytes: number
  emailLimit: number
  overEmailLimit: boolean
  /** Human sentence when `ok` is false. */
  message?: string
  code?: string
}

function walk(dir: string, out: { abs: string; inner: string; size: number }[], prefix: string): boolean {
  let names: string[]
  try { names = readdirSync(dir).sort() } catch { return true }
  for (const n of names) {
    if (out.length > MAX_WALK_FILES) return false
    const abs = join(dir, n)
    let st
    // lstat: a symlink inside the folder is NOT followed -- it could point
    // anywhere on the machine, and the security boundary is the tree root.
    try { st = lstatSync(abs) } catch { continue }
    if (st.isSymbolicLink()) continue
    if (st.isDirectory()) { if (!walk(abs, out, prefix + n + '/')) return false }
    else if (st.isFile()) out.push({ abs, inner: prefix + n, size: st.size })
  }
  return true
}

/** What a selection would send, measured -- nothing is built yet. */
export function lifeSendInfo(rels: unknown, lang: Lang): SendInfo {
  const list = Array.isArray(rels) ? rels.map((r) => String(r || '')).filter(Boolean) : []
  const base = { items: [], totalBytes: 0, emailLimit: EMAIL_ATTACH_LIMIT, overEmailLimit: false }
  if (!list.length) {
    return { ...base, ok: false, code: 'empty', message: T(lang, 'Nincs kijelölve semmi, amit el lehetne küldeni.', 'Nothing is selected to send.') }
  }
  const items: SendItemInfo[] = []
  for (const rel of list) {
    const abs = resolveLifePath(rel)
    let st
    try { st = abs ? statSync(abs) : null } catch { st = null }
    if (!abs || !st) {
      return { ...base, ok: false, code: 'not_found', message: T(lang,
        `„${basename(rel)}" nem található (közben áthelyezték vagy törölték?). Frissítsd a listát, és jelöld ki újra.`,
        `"${basename(rel)}" was not found (moved or deleted meanwhile?). Refresh the list and select it again.`) }
    }
    const name = basename(abs)
    if (st.isDirectory()) {
      const files: { abs: string; inner: string; size: number }[] = []
      if (!walk(abs, files, '')) {
        return { ...base, ok: false, code: 'too_many', message: T(lang,
          `A(z) „${name}" mappában több mint ${MAX_WALK_FILES} fájl van -- ezt nem lehet levélben elküldeni. Jelölj ki kevesebbet.`,
          `The folder "${name}" holds more than ${MAX_WALK_FILES} files -- too many to send. Select fewer.`) }
      }
      items.push({ rel, name, isDir: true, bytes: files.reduce((s, f) => s + f.size, 0), files: files.length, sendName: name + '.zip' })
    } else {
      items.push({ rel, name, isDir: false, bytes: st.size, files: 1, sendName: name })
    }
  }
  const totalBytes = items.reduce((s, i) => s + i.bytes, 0)
  return { ok: true, items, totalBytes, emailLimit: EMAIL_ATTACH_LIMIT, overEmailLimit: totalBytes > EMAIL_ATTACH_LIMIT }
}

/** DOS date/time for the zip headers. */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

/**
 * Zip a folder of the tree into `outFile`. The entries are named relative to
 * the folder, under a top directory of the folder's own name -- unpacking it
 * gives back the same folder. Names are UTF-8 (flag bit 11), so accented
 * names survive on Windows too.
 */
export function zipFolder(dirAbs: string, outFile: string): { files: number; bytes: number } {
  const top = basename(dirAbs)
  const files: { abs: string; inner: string; size: number }[] = []
  if (!walk(dirAbs, files, top + '/')) throw new Error('too_many')
  const fd = openSync(outFile, 'w')
  const central: Buffer[] = []
  let offset = 0
  try {
    for (const f of files) {
      const raw = readFileSync(f.abs)
      const packed = deflateRawSync(raw)
      const stored = packed.length >= raw.length
      const data = stored ? raw : packed
      const crc = crc32(raw) >>> 0
      const name = Buffer.from(f.inner, 'utf8')
      let mtime = new Date()
      try { mtime = statSync(f.abs).mtime } catch { /* keep now */ }
      const { time, date } = dosTime(mtime)
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0800, 6)
      local.writeUInt16LE(stored ? 0 : 8, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(raw.length, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      writeSync(fd, local); writeSync(fd, name); writeSync(fd, data)
      const cen = Buffer.alloc(46)
      cen.writeUInt32LE(0x02014b50, 0)
      cen.writeUInt16LE(20, 4)
      cen.writeUInt16LE(20, 6)
      cen.writeUInt16LE(0x0800, 8)
      cen.writeUInt16LE(stored ? 0 : 8, 10)
      cen.writeUInt16LE(time, 12)
      cen.writeUInt16LE(date, 14)
      cen.writeUInt32LE(crc, 16)
      cen.writeUInt32LE(data.length, 20)
      cen.writeUInt32LE(raw.length, 24)
      cen.writeUInt16LE(name.length, 28)
      cen.writeUInt32LE(offset, 42)
      central.push(cen, name)
      offset += local.length + name.length + data.length
    }
    const cdir = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(files.length, 8)
    end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(cdir.length, 12)
    end.writeUInt32LE(offset, 16)
    writeSync(fd, cdir); writeSync(fd, end)
  } finally {
    closeSync(fd)
  }
  return { files: files.length, bytes: offset }
}

export interface PreparedAttachments {
  ok: boolean
  /** Absolute paths, ready for `--attach`. */
  paths: string[]
  /** Call when the files are no longer needed (the zips live in a temp dir). */
  cleanup: () => void
  message?: string
  code?: string
}

/**
 * Build the attachment files of a selection: a file is attached in place, a
 * folder is zipped into a private temp directory. Refuses (with a sentence)
 * above `limit` -- measured BEFORE anything is built.
 */
export function prepareLifeAttachments(rels: unknown, lang: Lang, limit = EMAIL_ATTACH_LIMIT): PreparedAttachments {
  const noop = () => {}
  const info = lifeSendInfo(rels, lang)
  if (!info.ok) return { ok: false, paths: [], cleanup: noop, message: info.message, code: info.code }
  if (info.totalBytes > limit) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1)
    return { ok: false, paths: [], cleanup: noop, code: 'too_big', message: T(lang,
      `A kijelölés ${mb(info.totalBytes)} MB, a levél legfeljebb ${mb(limit)} MB lehet. Jelölj ki kevesebbet, vagy küldd több levélben.`,
      `The selection is ${mb(info.totalBytes)} MB, a message can be at most ${mb(limit)} MB. Select fewer, or send it in several messages.`) }
  }
  let tmp = ''
  const cleanup = () => { if (tmp) { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* temp dir */ } } }
  const paths: string[] = []
  const used = new Set<string>()
  try {
    for (const it of info.items) {
      const abs = resolveLifePath(it.rel)
      if (!abs) throw new Error('not_found')
      if (!it.isDir) { paths.push(abs); used.add(it.sendName); continue }
      if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'marveen-send-'))
      // Two folders of the same name from different places: the second zip
      // gets a (2), like the Windows Explorer does -- never overwritten.
      let zipName = it.sendName
      for (let i = 2; used.has(zipName); i++) zipName = `${it.name} (${i}).zip`
      used.add(zipName)
      const out = join(tmp, zipName)
      zipFolder(abs, out)
      paths.push(out)
    }
  } catch (e) {
    cleanup()
    return { ok: false, paths: [], cleanup: noop, code: 'build_failed', message: T(lang,
      `A csatolmányt nem sikerült elkészíteni: ${(e as Error).message}`,
      `Could not prepare the attachment: ${(e as Error).message}`) }
  }
  return { ok: true, paths, cleanup }
}
