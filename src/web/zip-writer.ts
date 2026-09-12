// A ZIP file, written by hand.
//
// The dashboard has to hand the user a downloadable browser extension (card
// 21311fdb / #96): Chrome loads an unpacked folder, so the user needs a folder,
// and the only way to move a folder through a browser download is a zip.
//
// Node ships deflate but no archiver, and pulling a package in for this would
// put a dependency between a fresh install and a working feature -- plus
// installing one needs the owner's approval (package_install). A zip container
// is a well-specified, ~100-line format, so it is written here instead.
//
// Scope: what a small extension needs. Store or deflate, no zip64 (the guard
// below refuses anything near the 4 GB edge rather than writing a broken
// archive), no encryption, no directory entries -- paths carry the folders.

import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** Path inside the archive, forward slashes ("marveen-autofill/manifest.json"). */
  name: string
  data: Buffer | string
}

/** 4 GB is where zip32 stops being able to describe itself. We refuse well
 *  before that rather than emit an archive that unpacks to garbage. */
const MAX_TOTAL = 0x7fffffff

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f)
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f)
  return { time, date }
}

/**
 * Build a zip archive in memory.
 *
 * `modified` is injectable so a test can assert byte-for-byte output, and so
 * the served archive does not change on every request for no reason.
 */
export function buildZip(entries: ZipEntry[], modified: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(modified)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  let total = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf-8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf-8')
    const deflated = deflateRawSync(raw)
    // Deflate can be bigger than the input on incompressible or tiny files;
    // storing those keeps the archive honest about its own size.
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)

    total += payload.length + nameBuf.length * 2 + 76
    if (total > MAX_TOTAL) throw new Error('zip: archive too large for zip32')

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)          // version needed
    local.writeUInt16LE(0, 6)           // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)          // extra length
    nameBuf.copy(local, 30)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)        // version made by
    central.writeUInt16LE(20, 6)        // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)        // extra
    central.writeUInt16LE(0, 32)        // comment
    central.writeUInt16LE(0, 34)        // disk number
    central.writeUInt16LE(0, 36)        // internal attrs
    central.writeUInt32LE(0o644 << 16, 38) // external attrs: regular file, rw-r--r--
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)

    locals.push(local, payload)
    centrals.push(central)
    offset += local.length + payload.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, centralBuf, end])
}
