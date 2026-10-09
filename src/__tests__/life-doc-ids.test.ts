// #510 step 3: a stable id for a document, with a content hash that never lies.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, utimesSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { initDatabase } from '../db.js'
import {
  ensureDocumentId, documentIdFor, documentById, documentsBySize, documentsByHash, documentsByMd5,
  hashDocument, verifyDocument, moveDocumentsPrefix, relocateDocument,
} from '../life-doc-ids.js'
import { followFolderMove } from '../life-follow.js'

let dir = ''
const put = (rel: string, content: string | Buffer): void => {
  const abs = join(dir, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'life-docids-'))
  process.env['MARVEEN_DEPOT'] = dir
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('document ids (#510)', () => {
  it('a file gets one id, and keeps it; a folder or a missing file gets none', async () => {
    put('Csalad/Anna/hatarozat.pdf', 'tartalom')
    const id = await ensureDocumentId('Csalad/Anna/hatarozat.pdf')
    expect(id).toMatch(/^DOC-[2-9A-HJKMNP-Z]{8}$/)
    expect(await ensureDocumentId('/Csalad/Anna/hatarozat.pdf')).toBe(id)
    expect(documentIdFor('Csalad/Anna/hatarozat.pdf')).toBe(id)
    expect(documentIdFor('Csalad/Anna/nincs.pdf')).toBeNull()
    expect(await ensureDocumentId('Csalad/Anna')).toBeNull()
    expect(await ensureDocumentId('Csalad/Anna/nincs.pdf')).toBeNull()
    expect(documentById(id!)).toMatchObject({ id, rel: 'Csalad/Anna/hatarozat.pdf', size: 8, sha256: null, md5: null })
  })

  it('the hash is the real SHA-256 and md5 of the content, read in small chunks', async () => {
    const big = Buffer.alloc(200_000, 7) // more than one 64 KB chunk
    put('A/nagy.bin', big)
    const id = (await ensureDocumentId('A/nagy.bin'))!
    const sha = createHash('sha256').update(big).digest('hex')
    const md5 = createHash('md5').update(big).digest('hex')
    expect(await hashDocument(id)).toBe(sha)
    expect(documentById(id)).toMatchObject({ sha256: sha, md5 })
    expect(documentsByHash(sha).map((d) => d.id)).toEqual([id])
    expect(documentsByMd5(md5).map((d) => d.id)).toEqual([id])
    expect(documentsBySize(200_000).map((d) => d.id)).toEqual([id])
  })

  it('a hash taken from an older content is never reported: the file changed', async () => {
    put('A/level.txt', 'elso valtozat')
    const id = (await ensureDocumentId('A/level.txt'))!
    const old = (await hashDocument(id))!
    put('A/level.txt', 'masodik, hosszabb valtozat')
    utimesSync(join(dir, 'A', 'level.txt'), new Date(), new Date(Date.now() + 5000))
    const v = await verifyDocument(id)
    expect(v?.missing).toBe(false)
    expect(v?.doc.sha256).toBeNull()
    expect(documentsByHash(old)).toEqual([])
    const fresh = await hashDocument(id)
    expect(fresh).toBe(createHash('sha256').update('masodik, hosszabb valtozat').digest('hex'))
    expect(fresh).not.toBe(old)
  })

  it('two files with the same content are found by size first, then by hash', async () => {
    put('A/szamla.pdf', 'ugyanaz a szamla')
    put('B/masolat.pdf', 'ugyanaz a szamla')
    put('B/mas.pdf', 'ugyanolyan hosszu!')
    const a = (await ensureDocumentId('A/szamla.pdf'))!
    const b = (await ensureDocumentId('B/masolat.pdf'))!
    await ensureDocumentId('B/mas.pdf')
    expect(documentsBySize(16).map((d) => d.rel)).toEqual(['A/szamla.pdf', 'B/masolat.pdf'])
    const h = (await hashDocument(a))!
    await hashDocument(b)
    expect(documentsByHash(h).map((d) => d.rel)).toEqual(['A/szamla.pdf', 'B/masolat.pdf'])
  })

  it('the id follows a rename of the file and of a folder above it', async () => {
    put('Cegek/Alfa/Iratok/szerzodes.pdf', 'szerzodes')
    const id = (await ensureDocumentId('Cegek/Alfa/Iratok/szerzodes.pdf'))!
    expect(moveDocumentsPrefix('Cegek/Alfa/Iratok/szerzodes.pdf', 'Cegek/Alfa/Iratok/szerzodes-2026.pdf')).toBe(1)
    expect(documentById(id)?.rel).toBe('Cegek/Alfa/Iratok/szerzodes-2026.pdf')
    // the whole folder is renamed in the Intezo: followFolderMove carries the documents too
    expect(followFolderMove('Cegek/Alfa', 'Cegek/Alfa Uj').documents).toBe(1)
    expect(documentById(id)?.rel).toBe('Cegek/Alfa Uj/Iratok/szerzodes-2026.pdf')
    expect(documentIdFor('Cegek/Alfa/Iratok/szerzodes.pdf')).toBeNull()
    // a folder whose name merely STARTS the same is not touched
    put('Cegek/Alfa Uj Kft/x.pdf', 'x')
    const other = (await ensureDocumentId('Cegek/Alfa Uj Kft/x.pdf'))!
    moveDocumentsPrefix('Cegek/Alfa Uj', 'Cegek/Beta')
    expect(documentById(other)?.rel).toBe('Cegek/Alfa Uj Kft/x.pdf')
  })

  it('a file that is not at its path is reported missing and KEPT', async () => {
    put('A/irat.pdf', 'irat')
    const id = (await ensureDocumentId('A/irat.pdf'))!
    rmSync(join(dir, 'A', 'irat.pdf'))
    expect((await verifyDocument(id))?.missing).toBe(true)
    expect(documentById(id)?.rel).toBe('A/irat.pdf')
    expect(await hashDocument(id)).toBeNull()
  })

  it('a hashed file moved outside Marveen is found by its content', async () => {
    put('A/irat.pdf', 'egyedi tartalom')
    mkdirSync(join(dir, 'B', 'melyebb'), { recursive: true })
    const id = (await ensureDocumentId('A/irat.pdf'))!
    await hashDocument(id)
    renameSync(join(dir, 'A', 'irat.pdf'), join(dir, 'B', 'melyebb', 'atnevezve.pdf')) // the Windows Explorer did this
    expect(await relocateDocument(id)).toBe('B/melyebb/atnevezve.pdf')
    expect(documentById(id)).toMatchObject({ rel: 'B/melyebb/atnevezve.pdf' })
    expect(documentById(id)?.sha256).not.toBeNull()
  })

  it('it is NOT guessed: never hashed, or two files with that content', async () => {
    put('A/nem-hashelt.pdf', 'aaa')
    const never = (await ensureDocumentId('A/nem-hashelt.pdf'))!
    renameSync(join(dir, 'A', 'nem-hashelt.pdf'), join(dir, 'A', 'mashol.pdf'))
    expect(await relocateDocument(never)).toBeNull()

    put('C/eredeti.pdf', 'ket peldany')
    const twice = (await ensureDocumentId('C/eredeti.pdf'))!
    await hashDocument(twice)
    copyFileSync(join(dir, 'C', 'eredeti.pdf'), join(dir, 'C', 'egyik.pdf'))
    renameSync(join(dir, 'C', 'eredeti.pdf'), join(dir, 'C', 'masik.pdf'))
    expect(await relocateDocument(twice)).toBeNull()
    expect(documentById(twice)?.rel).toBe('C/eredeti.pdf')
  })
})
