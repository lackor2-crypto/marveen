// GOOGLE PHOTOS INTO THE LIFE TREE (#520): the download that never harms the
// folder it is pointed at.
//
// The old photo store deletes what its index does not know. This path must do
// the opposite in the owner's own folders: nothing there is deleted, replaced
// or renamed; a taken name gets " (2)"; originals are asked for (`=d`); a
// failed item leaves no file behind; and an unreachable folder never makes a
// photo "gone".
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const store = mkdtempSync(join(tmpdir(), 'photos-life-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: store, STORE_DIR: join(store, 'store') }
})

const {
  downloadPickedToLife, loadLifeIndex, checkPhotoDest, safeOriginalName, freeName, removeLifePhoto,
  pruneLifePhotosMissing, lastLifeDest, rememberLifeDest, lifePhotoPath,
} = await import('../photos-life.js')
const { trashRelPath } = await import('../life-tree.js')

let depot = ''
const DEST = 'Család/Laura/Média'
const item = (id: string, filename: string, mime = 'image/jpeg', extra: Record<string, unknown> = {}) => ({
  id, createTime: '2026-10-01T10:00:00Z',
  mediaFile: { baseUrl: `https://lh3.googleusercontent.com/${id}`, mimeType: mime, filename, mediaFileMetadata: { width: 4000, height: 3000, ...extra } },
})
let asked: string[] = []
let bytesOf: Record<string, string | null> = {}
const deps = () => ({
  isAllowedUrl: (u: string) => u.startsWith('https://lh3.googleusercontent.com/'),
  fetchBytes: async (url: string) => {
    asked.push(url)
    const id = url.split('/').pop()!.split('=')[0]
    const b = bytesOf[id]
    if (b === null || b === undefined) return { ok: false, body: null }
    return { ok: true, body: Readable.from([Buffer.from(b)]) }
  },
})
const destDir = () => join(depot, ...DEST.split('/'))

beforeEach(() => {
  if (depot) rmSync(depot, { recursive: true, force: true })
  depot = mkdtempSync(join(tmpdir(), 'photos-life-depot-'))
  process.env['MARVEEN_DEPOT'] = depot
  mkdirSync(destDir(), { recursive: true })
  rmSync(join(store, 'store'), { recursive: true, force: true })
  asked = []
  bytesOf = {}
})
afterAll(() => {
  rmSync(store, { recursive: true, force: true })
  if (depot) rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('the chosen folder is checked', () => {
  it('needs a folder; refuses outside the tree, a missing one, the trash, the inside of a repository', () => {
    expect(checkPhotoDest('')).toEqual({ ok: false, code: 'needs_dest' })
    expect(checkPhotoDest(undefined)).toEqual({ ok: false, code: 'needs_dest' })
    expect(checkPhotoDest('../kint')).toMatchObject({ ok: false })
    expect(checkPhotoDest('Nincs/Ilyen')).toEqual({ ok: false, code: 'dest_missing' })
    mkdirSync(join(depot, trashRelPath(), 'x'), { recursive: true })
    expect(checkPhotoDest(trashRelPath() + '/x')).toEqual({ ok: false, code: 'dest_trash' })
    mkdirSync(join(depot, 'Fejl', 'repo', '.git'), { recursive: true })
    mkdirSync(join(depot, 'Fejl', 'repo', 'kepek'), { recursive: true })
    expect(checkPhotoDest('Fejl/repo/kepek')).toEqual({ ok: false, code: 'dest_in_repo' })
    expect(checkPhotoDest('/' + DEST + '/')).toMatchObject({ ok: true, rel: DEST })
  })
})

describe('names', () => {
  it('keeps the original name, makes it safe, and adds an extension when there is none', () => {
    expect(safeOriginalName('IMG_2041.JPG', 'x', 'image/jpeg')).toBe('IMG_2041.JPG')
    expect(safeOriginalName('a/b:c?.jpg', 'x', 'image/jpeg')).toBe('a_b_c_.jpg')
    expect(safeOriginalName('nyaralas', 'x', 'video/mp4')).toBe('nyaralas.mp4')
    expect(safeOriginalName('', 'AbC-12_x!', 'image/png')).toBe('AbC-12_x.png')
    expect(safeOriginalName(undefined, '', 'image/heic')).toBe('photo.heic')
  })
  it('a taken name is never reused', () => {
    writeFileSync(join(destDir(), 'kep.jpg'), 'regi')
    writeFileSync(join(destDir(), 'kep (2).jpg'), 'regi2')
    expect(freeName(destDir(), 'kep.jpg')).toBe('kep (3).jpg')
    expect(freeName(destDir(), 'uj.jpg')).toBe('uj.jpg')
    expect(freeName(destDir(), 'uj.jpg', new Set(['uj.jpg']))).toBe('uj (2).jpg')
  })
})

describe('downloadPickedToLife', () => {
  it('asks for the ORIGINAL (=d, video =dv) and writes under the original name into the chosen folder', async () => {
    bytesOf = { a1: 'foto-bajtok', v1: 'video-bajtok' }
    const r = await downloadPickedToLife([item('a1', 'IMG_1.jpg'), item('v1', 'VID_1.mp4', 'video/mp4')], 'acc', 'tok', DEST, deps())
    expect(r).toMatchObject({ saved: 2, failed: 0, duplicates: 0, already: 0, selected: 2, dest: DEST })
    expect(asked).toEqual(['https://lh3.googleusercontent.com/a1=d', 'https://lh3.googleusercontent.com/v1=dv'])
    expect(readFileSync(join(destDir(), 'IMG_1.jpg'), 'utf8')).toBe('foto-bajtok')
    expect(readdirSync(destDir()).sort()).toEqual(['IMG_1.jpg', 'VID_1.mp4'])
    const idx = loadLifeIndex()
    expect(idx.map((p) => [p.id, p.lifeRel, p.file, p.isVideo, p.bytes])).toEqual([['a1', DEST, 'IMG_1.jpg', false, 11], ['v1', DEST, 'VID_1.mp4', true, 12]])
    expect(lifePhotoPath(idx[0])).toBe(join(destDir(), 'IMG_1.jpg'))
    // nothing was put under the old system folder
    expect(readdirSync(depot).sort()).toEqual(['Család'])
  })

  it("the owner's own files in that folder are untouched: nothing deleted, nothing replaced", async () => {
    writeFileSync(join(destDir(), 'IMG_1.jpg'), 'A TULAJDONOS SAJAT KEPE')
    writeFileSync(join(destDir(), 'jegyzet.txt'), 'nem foto, nincs a jegyzekben')
    writeFileSync(join(destDir(), '.rejtett'), 'x')
    bytesOf = { a1: 'google-bajtok' }
    const r = await downloadPickedToLife([item('a1', 'IMG_1.jpg')], 'acc', 'tok', DEST, deps())
    expect(r.saved).toBe(1)
    expect(readFileSync(join(destDir(), 'IMG_1.jpg'), 'utf8')).toBe('A TULAJDONOS SAJAT KEPE')
    expect(readFileSync(join(destDir(), 'IMG_1 (2).jpg'), 'utf8')).toBe('google-bajtok')
    expect(readdirSync(destDir()).sort()).toEqual(['.rejtett', 'IMG_1 (2).jpg', 'IMG_1.jpg', 'jegyzet.txt'])
  })

  it('two picked items with the same file name both arrive', async () => {
    bytesOf = { a1: 'egyik', a2: 'masik' }
    await downloadPickedToLife([item('a1', 'kep.jpg'), item('a2', 'kep.jpg')], 'acc', 'tok', DEST, deps())
    expect(readdirSync(destDir()).sort()).toEqual(['kep (2).jpg', 'kep.jpg'])
  })

  it('a failed item leaves no file behind and the rest still arrive', async () => {
    bytesOf = { a1: null, a2: 'jo' }
    const r = await downloadPickedToLife([item('a1', 'rossz.jpg'), item('a2', 'jo.jpg'), { id: '', mediaFile: {} }], 'acc', 'tok', DEST, deps())
    expect(r).toMatchObject({ saved: 1, failed: 2 })
    expect(readdirSync(destDir())).toEqual(['jo.jpg'])
  })

  it('what is already here is counted, not downloaded twice; the same bytes are not written twice', async () => {
    bytesOf = { a1: 'ugyanaz', a2: 'ugyanaz', a3: 'mas' }
    await downloadPickedToLife([item('a1', 'egy.jpg')], 'acc', 'tok', DEST, deps())
    asked = []
    const r = await downloadPickedToLife([item('a1', 'egy.jpg'), item('a2', 'ketto.jpg'), item('a3', 'harom.jpg'), item('regi', 'r.jpg')], 'acc', 'tok', DEST,
      { ...deps(), knownElsewhere: new Set(['regi']) })
    expect(r).toMatchObject({ saved: 1, duplicates: 1, already: 2, failed: 0 })
    expect(asked.length).toBe(2) // a1 and "regi" were not asked for again
    expect(readdirSync(destDir()).sort()).toEqual(['egy.jpg', 'harom.jpg'])
    expect(loadLifeIndex().find((p) => p.id === 'a2')).toMatchObject({ file: 'egy.jpg', lifeRel: DEST })
  })

  it('refuses to run without a valid folder, and writes nothing', async () => {
    bytesOf = { a1: 'x' }
    await expect(downloadPickedToLife([item('a1', 'a.jpg')], 'acc', 'tok', '', deps())).rejects.toMatchObject({ code: 'needs_dest' })
    await expect(downloadPickedToLife([item('a1', 'a.jpg')], 'acc', 'tok', 'Nincs/Ilyen', deps())).rejects.toMatchObject({ code: 'dest_missing' })
    expect(asked).toEqual([])
    expect(loadLifeIndex()).toEqual([])
  })

  it('a URL that is not Google is never fetched', async () => {
    const bad = item('a1', 'a.jpg'); bad.mediaFile.baseUrl = 'http://169.254.169.254/meta'
    const r = await downloadPickedToLife([bad], 'acc', 'tok', DEST, deps())
    expect(r.failed).toBe(1)
    expect(asked).toEqual([])
  })
})

describe('removing and following the disk', () => {
  it('Remove moves the file to the trash of the Life tree, never erases it', async () => {
    bytesOf = { a1: 'kep' }
    await downloadPickedToLife([item('a1', 'kep.jpg')], 'acc', 'tok', DEST, deps())
    const r = removeLifePhoto('a1', 'acc')
    expect(r).toEqual({ ok: true, trashed: true })
    expect(existsSync(join(destDir(), 'kep.jpg'))).toBe(false)
    expect(existsSync(join(depot, trashRelPath()))).toBe(true)
    expect(loadLifeIndex()).toEqual([])
    expect(removeLifePhoto('a1', 'acc')).toEqual({ ok: false, code: 'not_found' })
  })

  it('a file shared by two rows stays until the last row is removed', async () => {
    bytesOf = { a1: 'egyforma', b1: 'egyforma' }
    await downloadPickedToLife([item('a1', 'kep.jpg')], 'acc', 'tok', DEST, deps())
    await downloadPickedToLife([item('b1', 'masnev.jpg')], 'masik', 'tok', DEST, deps())
    expect(removeLifePhoto('a1', 'acc')).toEqual({ ok: true, trashed: false })
    expect(existsSync(join(destDir(), 'kep.jpg'))).toBe(true)
    expect(removeLifePhoto('b1', 'masik')).toEqual({ ok: true, trashed: true })
  })

  it('a file deleted by other means loses its row; an UNREACHABLE folder loses nothing', async () => {
    bytesOf = { a1: 'egy', a2: 'ketto' }
    await downloadPickedToLife([item('a1', 'egy.jpg'), item('a2', 'ketto.jpg')], 'acc', 'tok', DEST, deps())
    rmSync(join(destDir(), 'egy.jpg'))
    expect(await pruneLifePhotosMissing()).toBe(1)
    expect(loadLifeIndex().map((p) => p.id)).toEqual(['a2'])
    // the whole drive is gone: "cannot see" is not "deleted"
    process.env['MARVEEN_DEPOT'] = join(depot, 'lecsatolt', 'meghajto')
    expect(await pruneLifePhotosMissing()).toBe(0)
    expect(loadLifeIndex().map((p) => p.id)).toEqual(['a2'])
    process.env['MARVEEN_DEPOT'] = depot
    // the folder itself was removed while its parent is readable: the photo is gone with it
    rmSync(destDir(), { recursive: true })
    expect(await pruneLifePhotosMissing()).toBe(1)
  })

  it('the last chosen folder is remembered per account', () => {
    expect(lastLifeDest('acc')).toBe('')
    rememberLifeDest('acc', '/Család/Laura/Média/')
    rememberLifeDest('masik', 'Család/Közös')
    expect(lastLifeDest('acc')).toBe('Család/Laura/Média')
    expect(lastLifeDest('masik')).toBe('Család/Közös')
  })
})
