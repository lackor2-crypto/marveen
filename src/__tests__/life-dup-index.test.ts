// WHICH FILES ARE COPIES (#513, point 4): the background index and its two questions.
//
// What must hold: nothing is called a copy without the same size AND md5; a
// file that changed loses its hash; an answer from an index that never
// finished is "not checked", never "no copies"; a stopped run keeps what it
// hashed and the next one goes on from there; an unreadable root concludes
// nothing and forgets nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const store = mkdtempSync(join(tmpdir(), 'life-dups-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { initDatabase, getDb } = await import('../db.js')
const { startDupIndex, waitDupIndex, stopDupIndex, dupStatus, duplicatesIn, matchCloudFiles } = await import('../life-dup-index.js')
const { DEPOT_SYSTEM_ROOT } = await import('../depot.js')
const { trashRelPath } = await import('../life-tree.js')

let dir = ''
const put = (rel: string, content: string | Buffer): void => {
  const abs = join(dir, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}
const md5 = (c: string): string => createHash('md5').update(c).digest('hex')
const run = async () => { startDupIndex(); return waitDupIndex() }

beforeEach(() => {
  initDatabase(':memory:')
  rmSync(join(store, 'life-dup-index.json'), { force: true })
  dir = mkdtempSync(join(tmpdir(), 'life-dups-'))
  process.env['MARVEEN_DEPOT'] = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('the copy index (#513)', () => {
  it('before any run: nothing is claimed -- "not checked", and a cloud file is "unknown", not "absent"', () => {
    put('A/egy.pdf', 'tartalom')
    expect(dupStatus()).toMatchObject({ phase: 'idle', neverFinished: true, files: 0 })
    expect(duplicatesIn('A')).toEqual({ checked: false, copies: {} })
    expect(matchCloudFiles([{ name: 'egy.pdf', size: 8, md5: md5('tartalom') }])).toEqual([{ state: 'unknown', where: [] }])
  })

  it('finds copies by content, not by name; same size with other content is not a copy', async () => {
    put('Csalad/Anna/hatarozat.pdf', 'ugyanaz a tartalom')
    put('Projektek/X/masolat-mas-neven.pdf', 'ugyanaz a tartalom')
    put('Projektek/X/hatarozat.pdf', 'MAS de ugyanennyi!') // same name as the first, same length, other content
    put('Projektek/X/egyedi.txt', 'ez egyedul van a meretevel!!')
    const s = await run()
    expect(s).toMatchObject({ phase: 'idle', neverFinished: false, files: 4, candidates: 3, hashedFiles: 3, stopped: false, rootError: null })
    expect(duplicatesIn('Csalad/Anna')).toEqual({ checked: true, copies: { 'hatarozat.pdf': ['Projektek/X/masolat-mas-neven.pdf'] } })
    expect(duplicatesIn('Projektek/X').copies).toEqual({ 'masolat-mas-neven.pdf': ['Csalad/Anna/hatarozat.pdf'] })
    // only DIRECT children of the asked folder
    expect(duplicatesIn('Csalad').copies).toEqual({})
    // a file alone at its size is never read
    const row = getDb().prepare('SELECT md5 FROM life_file_index WHERE rel = ?').get('Projektek/X/egyedi.txt') as { md5: string | null }
    expect(row.md5).toBeNull()
  })

  it('the trash, the system folder, a git repository, hidden files and node_modules are not indexed', async () => {
    put('A/a.txt', 'azonos')
    put(`${trashRelPath()}/2026/a.txt`, 'azonos')
    put(`${DEPOT_SYSTEM_ROOT}/Mentesek/a.txt`, 'azonos')
    put('Fejlesztes/GIT_REPOS/repo/.git/HEAD', 'ref')
    put('Fejlesztes/GIT_REPOS/repo/a.txt', 'azonos')
    put('A/.rejtett', 'azonos')
    put('A/node_modules/x/a.txt', 'azonos')
    const s = await run()
    expect(s.files).toBe(1)
    expect(duplicatesIn('A').copies).toEqual({})
  })

  it('a changed file loses its hash and stops being a copy; the next run sees the new state', async () => {
    put('A/x.txt', 'egyforma')
    put('B/x.txt', 'egyforma')
    await run()
    expect(duplicatesIn('A').copies).toEqual({ 'x.txt': ['B/x.txt'] })
    put('B/x.txt', 'megvalto') // same length, new content
    const later = new Date(Date.now() + 5000)
    utimesSync(join(dir, 'B', 'x.txt'), later, later)
    await run()
    expect(duplicatesIn('A').copies).toEqual({})
    rmSync(join(dir, 'B', 'x.txt'))
    const s = await run()
    expect(s.files).toBe(1)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM life_file_index').get()).toEqual({ n: 1 })
  })

  it('a second run does not read again what is unchanged', async () => {
    put('A/x.txt', 'egyforma')
    put('B/x.txt', 'egyforma')
    await run()
    const before = getDb().prepare('SELECT rel, md5, hashed_mtime_ms FROM life_file_index ORDER BY rel').all()
    // If the run re-hashed, a wrong md5 planted here would be repaired; it must stay, proving no re-read.
    getDb().prepare("UPDATE life_file_index SET md5 = 'planted' WHERE rel = 'A/x.txt'").run()
    const s = await run()
    expect(s.hashedFiles).toBe(2)
    const after = getDb().prepare('SELECT rel, md5 FROM life_file_index ORDER BY rel').all() as Array<{ rel: string; md5: string }>
    expect(after[0].md5).toBe('planted')
    expect(before.length).toBe(2)
  })

  it('an unreachable root concludes nothing and forgets nothing', async () => {
    put('A/x.txt', 'egyforma')
    put('B/x.txt', 'egyforma')
    await run()
    process.env['MARVEEN_DEPOT'] = join(dir, 'nincs-ilyen')
    const s = await run()
    expect(s.rootError).toBeTruthy()
    expect(s.neverFinished).toBe(false) // the earlier finished run still stands
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM life_file_index').get()).toEqual({ n: 2 })
  })

  it('a stopped run is said to be stopped, keeps its hashes, and is not "finished"', async () => {
    for (let i = 0; i < 30; i++) put(`A/f${i}.txt`, 'egyforma tartalom')
    startDupIndex()
    stopDupIndex()
    const s = await waitDupIndex()
    expect(s.stopped).toBe(true)
    expect(s.neverFinished).toBe(true)
    expect(duplicatesIn('A').checked).toBe(false)
    const again = await run()
    expect(again).toMatchObject({ stopped: false, neverFinished: false, hashedFiles: 30 })
    expect(Object.keys(duplicatesIn('A').copies).length).toBe(30)
    expect(existsSync(join(store, 'life-dup-index.json'))).toBe(true)
  })
})

describe('is a cloud file already in the Life tree (#513)', () => {
  it('present by size + md5, wherever and under whatever name it is', async () => {
    put('A/szerzodes.pdf', 'a szerzodes szovege')
    put('B/masolat.pdf', 'a szerzodes szovege')
    await run()
    const [m] = matchCloudFiles([{ name: 'Scan_0001.pdf', size: 19, md5: md5('a szerzodes szovege').toUpperCase() }])
    expect(m).toEqual({ state: 'present', where: ['A/szerzodes.pdf', 'B/masolat.pdf'] })
  })

  it('absent only from a finished run; same size not hashed yet is "unknown", not "absent"', async () => {
    put('A/egyedul.pdf', 'egyedul a meretevel')
    await run()
    // The only file of that size was never hashed (it has no size-twin): it MAY be this cloud file.
    expect(matchCloudFiles([{ name: 'x.pdf', size: 19, md5: md5('egyedul a meretevel') }])[0].state).toBe('unknown')
    expect(matchCloudFiles([{ name: 'x.pdf', size: 12345, md5: 'ffffffffffffffffffffffffffffffff' }])[0].state).toBe('absent')
  })

  it('without a hash from the cloud: name + size is only "probable"; a Google document (no size) is "unknown"', async () => {
    put('A/kep.jpg', 'kepadat')
    await run()
    expect(matchCloudFiles([{ name: 'kep.jpg', size: 7 }])[0]).toEqual({ state: 'probable', where: ['A/kep.jpg'] })
    expect(matchCloudFiles([{ name: 'masnev.jpg', size: 7 }])[0].state).toBe('absent')
    expect(matchCloudFiles([{ name: 'Dokumentum', size: null }])[0].state).toBe('unknown')
  })
})
