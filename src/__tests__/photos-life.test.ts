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

// Owner, 2026-10-09 (TG 8393): "file-onkent kell hogy megjegyezze hogy hova
// szeretnenk letolteni es file-onkent kell felajanlani". One batch, several
// folders, and each photo remembers its own.
describe('each photo goes into the folder chosen for IT', () => {
  const OTHER = 'Család/Laura/Nyaralás'

  it('one batch lands in two folders, and the result says how many went where', async () => {
    mkdirSync(join(depot, ...OTHER.split('/')), { recursive: true })
    bytesOf = { a1: 'egy', a2: 'ketto', a3: 'harom' }
    const where: Record<string, string> = { a1: DEST, a2: OTHER, a3: OTHER }
    const r = await downloadPickedToLife([item('a1', 'a.jpg'), item('a2', 'b.jpg'), item('a3', 'c.jpg')], 'acc', 'tok', '', { ...deps(), destFor: (it) => where[it.id] || null })
    expect(r).toMatchObject({ saved: 3, failed: 0, places: { [DEST]: 1, [OTHER]: 2 } })
    expect(readdirSync(destDir())).toEqual(['a.jpg'])
    expect(readdirSync(join(depot, ...OTHER.split('/'))).sort()).toEqual(['b.jpg', 'c.jpg'])
  })

  it('a photo without a chosen folder and without a batch folder does not come down anywhere', async () => {
    bytesOf = { a1: 'egy' }
    const r = await downloadPickedToLife([item('a1', 'a.jpg')], 'acc', 'tok', '', { ...deps(), destFor: () => null })
    expect(r).toMatchObject({ saved: 0, failed: 1 })
    expect(asked).toEqual([])
  })

  it('a chosen folder that cannot be used fails that photo instead of sending it elsewhere', async () => {
    bytesOf = { a1: 'egy' }
    const r = await downloadPickedToLife([item('a1', 'a.jpg')], 'acc', 'tok', DEST, { ...deps(), destFor: () => trashRelPath() })
    expect(r).toMatchObject({ saved: 0, failed: 1 })
    expect(readdirSync(destDir())).toEqual([])
  })

  it('the chosen folder wins over the folder the photo was uploaded from', async () => {
    mkdirSync(join(depot, ...OTHER.split('/')), { recursive: true })
    bytesOf = { a1: 'egy' }
    const r = await downloadPickedToLife([item('a1', 'a.jpg')], 'acc', 'tok', '', {
      ...deps(), destFor: () => OTHER, placeFor: () => ({ lifeRel: DEST, file: 'eredeti.jpg', bytes: 3 }),
    })
    expect(r).toMatchObject({ saved: 1, restored: 0, places: { [OTHER]: 1 } })
    expect(readdirSync(join(depot, ...OTHER.split('/')))).toEqual(['a.jpg'])
  })

  it('the folder chosen per photo is remembered per photo, and a later choice replaces it', async () => {
    const { rememberedPhotoPlace, rememberPhotoPlaces } = await import('../photos-life.js')
    expect(rememberedPhotoPlace('acc', 'a1')).toBe('')
    rememberPhotoPlaces('acc', { a1: DEST, a2: OTHER })
    expect(rememberedPhotoPlace('acc', 'a1')).toBe(DEST)
    expect(rememberedPhotoPlace('acc', 'a2')).toBe(OTHER)
    expect(rememberedPhotoPlace('masik', 'a1')).toBe('')
    rememberPhotoPlaces('acc', { a1: OTHER })
    expect(rememberedPhotoPlace('acc', 'a1')).toBe(OTHER)
    expect(rememberedPhotoPlace('acc', 'a2')).toBe(OTHER)
  })
})

// Owner, 2026-10-09 (TG 8417): two photos picked, one came down and showed on
// the page, his own -- already in its folder -- did not. "Nincs konzisztencia."
describe('a picked photo that is already on this machine still gets onto the page', () => {
  const place = () => ({ lifeRel: DEST, file: 'sajat.jpg', bytes: 5 })

  it('nothing is downloaded, the row points at the file that is there, and the file is untouched', async () => {
    writeFileSync(join(destDir(), 'sajat.jpg'), 'regi!')
    bytesOf = { u1: 'masik' }
    const r = await downloadPickedToLife([item('u1', 'sajat.jpg')], 'acc', 'tok', '', { ...deps(), placeFor: place, destFor: () => null })
    expect(r).toMatchObject({ saved: 0, already: 1, failed: 0 })
    expect(asked).toEqual([])
    const row = loadLifeIndex().find((p) => p.id === 'u1')!
    expect(row).toMatchObject({ lifeRel: DEST, file: 'sajat.jpg', bytes: 5, linked: true })
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(destDir(), 'sajat.jpg'), 'utf8')).toBe('regi!')
  })

  it('picking it again does not add a second row', async () => {
    writeFileSync(join(destDir(), 'sajat.jpg'), 'regi!')
    await downloadPickedToLife([item('u1', 'sajat.jpg')], 'acc', 'tok', '', { ...deps(), placeFor: place, destFor: () => null })
    await downloadPickedToLife([item('u1', 'sajat.jpg')], 'acc', 'tok', '', { ...deps(), placeFor: place, destFor: () => null })
    expect(loadLifeIndex().filter((p) => p.id === 'u1')).toHaveLength(1)
  })

  it('taking such a photo off the page never moves the owner\'s file to the trash', async () => {
    writeFileSync(join(destDir(), 'sajat.jpg'), 'regi!')
    await downloadPickedToLife([item('u1', 'sajat.jpg')], 'acc', 'tok', '', { ...deps(), placeFor: place, destFor: () => null })
    expect(removeLifePhoto('u1', 'acc')).toEqual({ ok: true, trashed: false })
    expect(existsSync(join(destDir(), 'sajat.jpg'))).toBe(true)
    expect(loadLifeIndex()).toEqual([])
  })
})

// Owner, 2026-10-09 (TG 8468): the photo he uploaded from the Life tree was not on the
// Photos page: "meg kene, hogy jelenjen a fotok alatt itt". It gets there by itself.
describe('what this program uploaded shows on the page without being picked again (#528)', () => {
  const up = (over: Record<string, unknown> = {}) => ({
    id: 'g1', lifeRel: DEST, file: 'sajat.jpg', bytes: 5, sha256: 'a'.repeat(64), mimeType: 'image/jpeg', uploadedAt: '2026-10-09T20:02:34Z', ...over,
  })

  it('the uploaded file gets a row that points at it; the file is not touched and nothing is asked from Google', async () => {
    const { linkUploadedPhotos } = await import('../photos-life.js')
    writeFileSync(join(destDir(), 'sajat.jpg'), 'regi!')
    expect(linkUploadedPhotos('acc', [up()])).toBe(1)
    expect(loadLifeIndex()).toMatchObject([{ id: 'g1', account: 'acc', lifeRel: DEST, file: 'sajat.jpg', bytes: 5, linked: true, isVideo: false }])
    expect(readFileSync(join(destDir(), 'sajat.jpg'), 'utf8')).toBe('regi!')
    expect(asked).toEqual([])
    // Asked again (every time the page is listed): no second row.
    expect(linkUploadedPhotos('acc', [up()])).toBe(0)
    expect(loadLifeIndex()).toHaveLength(1)
  })

  it('a file that is gone, or changed in size since the upload, is not shown as if it were there', async () => {
    const { linkUploadedPhotos } = await import('../photos-life.js')
    expect(linkUploadedPhotos('acc', [up()])).toBe(0)
    writeFileSync(join(destDir(), 'sajat.jpg'), 'mas meret')
    expect(linkUploadedPhotos('acc', [up()])).toBe(0)
    expect(loadLifeIndex()).toEqual([])
  })

  it('taken off the page it stays off, and the file stays in its folder', async () => {
    const { linkUploadedPhotos } = await import('../photos-life.js')
    writeFileSync(join(destDir(), 'sajat.jpg'), 'regi!')
    linkUploadedPhotos('acc', [up()])
    expect(removeLifePhoto('g1', 'acc')).toEqual({ ok: true, trashed: false })
    expect(linkUploadedPhotos('acc', [up()])).toBe(0)
    expect(loadLifeIndex()).toEqual([])
    expect(existsSync(join(destDir(), 'sajat.jpg'))).toBe(true)
  })

  it('picked in Google Photos later (even under another id): still one row, and an explicit pick brings back one that was taken off', async () => {
    const { linkUploadedPhotos } = await import('../photos-life.js')
    writeFileSync(join(destDir(), 'sajat.jpg'), 'regi!')
    linkUploadedPhotos('acc', [up()])
    const place = () => ({ lifeRel: DEST, file: 'sajat.jpg', bytes: 5 })
    await downloadPickedToLife([item('picker-id', 'sajat.jpg')], 'acc', 'tok', '', { ...deps(), placeFor: place, destFor: () => null })
    expect(loadLifeIndex()).toHaveLength(1)
    removeLifePhoto('g1', 'acc')
    await downloadPickedToLife([item('picker-id', 'sajat.jpg')], 'acc', 'tok', '', { ...deps(), placeFor: place, destFor: () => null })
    expect(loadLifeIndex()).toMatchObject([{ id: 'picker-id', linked: true }])
  })

  it('the same picture already on the page from another file (an earlier copy of it): no second tile', async () => {
    const { linkUploadedPhotos } = await import('../photos-life.js')
    writeFileSync(join(destDir(), 'sajat.jpg'), 'regi!')
    writeFileSync(join(destDir(), 'masolat.jpg'), 'regi!')
    expect(linkUploadedPhotos('acc', [up(), up({ id: 'g2', file: 'masolat.jpg' })])).toBe(1)
    expect(linkUploadedPhotos('acc', [up({ id: 'g3', file: 'masolat.jpg' })])).toBe(0)
    expect(loadLifeIndex().map((p) => p.file)).toEqual(['sajat.jpg'])
    // Another picture in the same folder still gets its own row.
    writeFileSync(join(destDir(), 'masik.jpg'), 'masik')
    expect(linkUploadedPhotos('acc', [up({ id: 'g4', file: 'masik.jpg', sha256: 'c'.repeat(64) })])).toBe(1)
  })

  it('a video and an upload without a Google id are handled too', async () => {
    const { linkUploadedPhotos } = await import('../photos-life.js')
    writeFileSync(join(destDir(), 'film.mp4'), 'video')
    expect(linkUploadedPhotos('acc', [up({ id: '', file: 'film.mp4', mimeType: 'video/mp4', sha256: 'b'.repeat(64) })])).toBe(1)
    expect(loadLifeIndex()[0]).toMatchObject({ file: 'film.mp4', isVideo: true, linked: true })
    expect(loadLifeIndex()[0]!.id).toMatch(/^up-b{40}$/)
  })
})

// #524: a restored backup, the Life tree on the new disk not made yet. The index row and the
// upload log are there, the file and its folder are not: the picture must come down again.
describe('an index row whose file is gone is not "already here" (#524)', () => {
  const OLD = 'Család/Régi hely/Fotók'
  const oldDir = () => join(depot, ...OLD.split('/'))
  const seed = async () => {
    const { saveLifeIndex } = await import('../photos-life.js')
    saveLifeIndex([{
      id: 'g1', account: 'acc', lifeRel: OLD, file: '009.jpg', mimeType: 'image/jpeg', createdTime: '', width: 1, height: 1,
      isVideo: false, bytes: 5, sha256: 'a'.repeat(64), savedAt: '2026-10-01T00:00:00Z', linked: true,
    }])
    mkdirSync(join(store, 'store', 'photos'), { recursive: true })
    writeFileSync(join(store, 'store', 'photos', 'upload-log.json'), JSON.stringify([{
      account: 'acc', sha256: 'a'.repeat(64), lifeRel: OLD, file: '009.jpg', bytes: 5, mtimeMs: 1, mediaItemId: 'g1', uploadedAt: '2026-10-01T00:00:00Z',
    }]))
  }

  it('the list offers the old folder, and the download brings the file back with exactly one row', async () => {
    await seed()
    const { buildDownloadReview, reviewDepsFor } = await import('../web/routes/photos-picker.js')
    const rows = buildDownloadReview([item('g1', '009.jpg')], reviewDepsFor('acc'))
    expect(rows[0]).toMatchObject({ already: false, proposal: { kind: 'uploaded', lifeRel: OLD } })

    bytesOf = { g1: 'foto!' }
    const { uploadedPlaceFor } = await import('../photos-upload.js')
    const r = await downloadPickedToLife([item('g1', '009.jpg')], 'acc', 'tok', '', {
      ...deps(), placeFor: (it: { id: string; filename: string }) => uploadedPlaceFor('acc', it), destFor: () => OLD,
    })
    expect(r).toMatchObject({ saved: 1, already: 0, failed: 0 })
    expect(readFileSync(join(oldDir(), '009.jpg'), 'utf8')).toBe('foto!')
    const rowsOfG1 = loadLifeIndex().filter((p) => p.id === 'g1' && p.account === 'acc')
    expect(rowsOfG1).toMatchObject([{ lifeRel: OLD, file: '009.jpg', bytes: 5 }])
    // the new row is the downloaded one, not the old "linked" orphan
    expect(rowsOfG1[0]).not.toHaveProperty('linked')
    expect(loadLifeIndex()).toHaveLength(1)
  })

  it('regression guard: the file is there with the same size, so it is still "already here"', async () => {
    await seed()
    mkdirSync(oldDir(), { recursive: true })
    writeFileSync(join(oldDir(), '009.jpg'), 'regi!')
    const { buildDownloadReview, reviewDepsFor } = await import('../web/routes/photos-picker.js')
    expect(buildDownloadReview([item('g1', '009.jpg')], reviewDepsFor('acc'))[0]).toMatchObject({ already: true, alreadyAt: OLD })
    const r = await downloadPickedToLife([item('g1', '009.jpg')], 'acc', 'tok', '', { ...deps(), destFor: () => OLD })
    expect(r).toMatchObject({ saved: 0, already: 1 })
    expect(asked).toEqual([])
    expect(loadLifeIndex()).toHaveLength(1)
  })
})
