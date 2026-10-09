// FROM THE LIFE TREE UP TO GOOGLE PHOTOS (#520): an upload cannot be taken
// back, so the plan must be honest, the same content must never go up twice,
// a refusal from Google must stop the run in Google's own words -- and the
// log must let a later download put the photo back where it came from.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const store = mkdtempSync(join(tmpdir(), 'photos-up-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: store, STORE_DIR: join(store, 'store') }
})

const { planUpload, runUpload, loadUploadLog, uploadedPlaceFor, mediaMime, hasUploadScope, UPLOAD_SCOPE, BATCH_MAX } = await import('../photos-upload.js')
const { downloadPickedToLife, loadLifeIndex } = await import('../photos-life.js')

let depot = ''
const put = (rel: string, content: string): void => {
  const abs = join(depot, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

interface Call { url: string; body: unknown; headers: Record<string, string> }
let calls: Call[] = []
let refuse: { status: number; text: string } | null = null
let nextId = 0
async function drain(body: unknown): Promise<string> {
  if (typeof body === 'string') return body
  const chunks: Buffer[] = []
  for await (const c of body as Readable) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString('utf8')
}
const deps = () => ({
  http: async (url: string, init: any) => {
    const body = await drain(init.body)
    calls.push({ url, body, headers: init.headers })
    if (refuse) return { ok: false, status: refuse.status, text: async () => refuse!.text }
    if (url.endsWith('/uploads')) return { ok: true, status: 200, text: async () => 'tok:' + body }
    const items = JSON.parse(body).newMediaItems as any[]
    return { ok: true, status: 200, text: async () => JSON.stringify({ newMediaItemResults: items.map((n) => ({ uploadToken: n.simpleMediaItem.uploadToken, status: { message: 'Success' }, mediaItem: { id: 'gid' + (++nextId), filename: n.simpleMediaItem.fileName } })) }) }
  },
})

beforeEach(() => {
  if (depot) rmSync(depot, { recursive: true, force: true })
  depot = mkdtempSync(join(tmpdir(), 'photos-up-depot-'))
  process.env['MARVEEN_DEPOT'] = depot
  rmSync(join(store, 'store'), { recursive: true, force: true })
  calls = []; refuse = null; nextId = 0
})
afterAll(() => {
  rmSync(store, { recursive: true, force: true })
  if (depot) rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('what counts as a photo or video, and the permission', () => {
  it('by extension, case-insensitive; a document is not media', () => {
    expect(mediaMime('IMG_1.JPG')).toBe('image/jpeg')
    expect(mediaMime('nyar.heic')).toBe('image/heic')
    expect(mediaMime('film.MOV')).toBe('video/quicktime')
    expect(mediaMime('szerzodes.pdf')).toBeNull()
    expect(mediaMime('nincs-kiterjesztes')).toBeNull()
  })
  it('the upload permission is its own scope', () => {
    expect(hasUploadScope({ scope: 'a ' + UPLOAD_SCOPE + ' b' })).toBe(true)
    expect(hasUploadScope({ scope: 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly' })).toBe(false)
    expect(hasUploadScope(null)).toBe(false)
  })
})

describe('the plan', () => {
  it('lists the media under the picked folders and files; counts what is not media; reads nothing but names and sizes', async () => {
    put('Család/Laura/Média/a.jpg', 'aaa')
    put('Család/Laura/Média/Nyár/b.png', 'bbbb')
    put('Család/Laura/Média/jegyzet.txt', 'szoveg')
    put('Család/Laura/Média/.rejtett.jpg', 'x')
    put('Család/Közös/film.mp4', 'vvvvv')
    const p = await planUpload('acc', ['Család/Laura/Média', 'Család/Közös/film.mp4', 'Nincs/Ilyen', '../kint'])
    expect(p.upload.map((f) => [f.rel, f.lifeRel, f.file, f.bytes, f.mime])).toEqual([
      ['Család/Laura/Média/a.jpg', 'Család/Laura/Média', 'a.jpg', 3, 'image/jpeg'],
      ['Család/Laura/Média/Nyár/b.png', 'Család/Laura/Média/Nyár', 'b.png', 4, 'image/png'],
      ['Család/Közös/film.mp4', 'Család/Közös', 'film.mp4', 5, 'video/mp4'],
    ])
    expect(p).toMatchObject({ uploadBytes: 12, already: 0, notMedia: 1, truncated: false })
    expect(p.unreadable.length).toBe(2)
    expect(calls).toEqual([])
  })
})

describe('the upload', () => {
  it('sends the bytes, creates the items, and logs where each came from', async () => {
    put('Család/Laura/Média/a.jpg', 'aaa')
    put('Család/Közös/film.mp4', 'vvvvv')
    const plan = await planUpload('acc', ['Család'])
    const r = await runUpload(plan, 'tok', deps())
    expect(r).toMatchObject({ uploaded: 2, duplicates: 0, failed: [], stopped: null, remaining: 0 })
    const ups = calls.filter((c) => c.url.endsWith('/uploads'))
    expect(ups.map((c) => [c.body, c.headers['X-Goog-Upload-Content-Type'], c.headers['X-Goog-Upload-Protocol']]).sort()).toEqual([['aaa', 'image/jpeg', 'raw'], ['vvvvv', 'video/mp4', 'raw']])
    const batch = calls.filter((c) => c.url.endsWith(':batchCreate'))
    expect(batch.length).toBe(1)
    expect(JSON.parse(batch[0].body as string).newMediaItems.map((n: any) => n.simpleMediaItem.fileName).sort()).toEqual(['a.jpg', 'film.mp4'])
    const log = loadUploadLog()
    expect(log.map((l) => [l.account, l.lifeRel, l.file, l.bytes, !!l.mediaItemId, l.sha256.length]).sort()).toEqual([
      ['acc', 'Család/Közös', 'film.mp4', 5, true, 64], ['acc', 'Család/Laura/Média', 'a.jpg', 3, true, 64],
    ])
    // the tree was only read
    expect(readdirSync(join(depot, 'Család', 'Laura', 'Média'))).toEqual(['a.jpg'])
  })

  it('nothing goes up twice: the same place, the same content elsewhere, the same content in one run', async () => {
    put('A/kep.jpg', 'egyforma')
    await runUpload(await planUpload('acc', ['A']), 'tok', deps())
    // the same place, unchanged: the plan itself leaves it out
    const again = await planUpload('acc', ['A'])
    expect(again).toMatchObject({ already: 1 })
    expect(again.upload).toEqual([])
    // the same content under another name and place, twice in one run
    put('B/masolat.jpg', 'egyforma')
    put('B/uj1.jpg', 'uj tartalom')
    put('C/uj2.jpg', 'uj tartalom')
    calls = []
    const r = await runUpload(await planUpload('acc', ['B', 'C']), 'tok', deps())
    expect(r).toMatchObject({ uploaded: 1, duplicates: 2, failed: [] })
    expect(calls.filter((c) => c.url.endsWith('/uploads')).length).toBe(1)
    // another account is another library
    const other = await planUpload('masik', ['A'])
    expect(other.upload.length).toBe(1)
  })

  it('a changed file is sent again; a file that changed after the preview is not sent', async () => {
    put('A/kep.jpg', 'elso')
    await runUpload(await planUpload('acc', ['A']), 'tok', deps())
    put('A/kep.jpg', 'masodik tartalom')
    const later = new Date(Date.now() + 5000); utimesSync(join(depot, 'A', 'kep.jpg'), later, later)
    const plan = await planUpload('acc', ['A'])
    expect(plan.upload.length).toBe(1)
    put('A/kep.jpg', 'kozben megint mas')
    const r = await runUpload(plan, 'tok', deps())
    expect(r.uploaded).toBe(0)
    expect(r.failed).toEqual([{ rel: 'A/kep.jpg', detail: 'the file changed after the preview' }])
  })

  it("a refusal that would repeat stops the run in Google's own words, and nothing is logged as sent", async () => {
    for (let i = 0; i < 5; i++) put(`A/k${i}.jpg`, 'tartalom ' + i)
    refuse = { status: 429, text: JSON.stringify({ error: { code: 429, message: 'Quota exceeded for quota metric \'Write requests\'', status: 'RESOURCE_EXHAUSTED' } }) }
    const r = await runUpload(await planUpload('acc', ['A']), 'tok', deps())
    expect(r.uploaded).toBe(0)
    expect(r.stopped).toEqual({ status: 429, message: "Quota exceeded for quota metric 'Write requests'" })
    expect(r.remaining).toBe(4)
    expect(calls.length).toBe(1)
    expect(loadUploadLog()).toEqual([])
    // the next run starts again from the same plan: nothing was marked as done
    refuse = null
    expect((await planUpload('acc', ['A'])).upload.length).toBe(5)
  })

  it(`more than ${BATCH_MAX} files are created in several batches, each at most ${BATCH_MAX}`, async () => {
    for (let i = 0; i < BATCH_MAX + 3; i++) put(`A/k${String(i).padStart(3, '0')}.jpg`, 'egyedi ' + i)
    const r = await runUpload(await planUpload('acc', ['A']), 'tok', deps())
    expect(r.uploaded).toBe(BATCH_MAX + 3)
    const sizes = calls.filter((c) => c.url.endsWith(':batchCreate')).map((c) => JSON.parse(c.body as string).newMediaItems.length)
    expect(sizes).toEqual([BATCH_MAX, 3])
  })

  it('the owner can stop it; what went up stays logged, the rest is counted', async () => {
    for (let i = 0; i < 4; i++) put(`A/k${i}.jpg`, 'egyedi ' + i)
    let n = 0
    const r = await runUpload(await planUpload('acc', ['A']), 'tok', { ...deps(), shouldStop: () => ++n > 2 })
    expect(r).toMatchObject({ uploaded: 2, remaining: 2, stopped: null })
    expect(loadUploadLog().length).toBe(2)
  })
})

describe('a later download puts the photo back where it went up from (TG 8331)', () => {
  const picked = (id: string, filename: string) => ({ id, createTime: '2026-10-01T10:00:00Z', mediaFile: { baseUrl: `https://lh3.googleusercontent.com/${id}`, mimeType: 'image/jpeg', filename, mediaFileMetadata: {} } })
  const dl = (bytes: Record<string, string>) => ({
    isAllowedUrl: () => true,
    fetchBytes: async (url: string) => { const id = url.split('/').pop()!.split('=')[0]; return { ok: true, body: Readable.from([Buffer.from(bytes[id])]) } },
    placeFor: (it: { id: string; filename: string }) => uploadedPlaceFor('acc', it),
  })

  it('by Google id, or by a file name that is unambiguous; an ambiguous name is not guessed', async () => {
    put('Család/Laura/Média/laura.jpg', 'laura')
    put('Család/Apa/Média/kep.jpg', 'apa')
    put('Család/Anya/Média/kep.jpg', 'anya')
    await runUpload(await planUpload('acc', ['Család']), 'tok', deps())
    const log = loadUploadLog()
    const lauraId = log.find((l) => l.file === 'laura.jpg')!.mediaItemId
    expect(uploadedPlaceFor('acc', { id: lauraId, filename: 'masnev.jpg' })).toMatchObject({ lifeRel: 'Család/Laura/Média', file: 'laura.jpg' })
    expect(uploadedPlaceFor('acc', { id: 'picker-masik-azonosito', filename: 'laura.jpg' })).toMatchObject({ lifeRel: 'Család/Laura/Média' })
    expect(uploadedPlaceFor('acc', { id: 'x', filename: 'kep.jpg' })).toBeNull()
    expect(uploadedPlaceFor('acc', { id: 'x', filename: 'ismeretlen.jpg' })).toBeNull()
    expect(uploadedPlaceFor('masik', { id: lauraId, filename: 'laura.jpg' })).toBeNull()
  })

  it('still there and unchanged: not downloaded; gone with its folder: the folder is made again and the photo goes back; unknown: the chosen folder', async () => {
    put('Család/Laura/Média/laura.jpg', 'laura')
    put('Család/Apa/Nyár/apa.jpg', 'apa!')
    mkdirSync(join(depot, 'Letöltések'), { recursive: true })
    await runUpload(await planUpload('acc', ['Család']), 'tok', deps())
    rmSync(join(depot, 'Család', 'Apa'), { recursive: true })
    const r = await downloadPickedToLife(
      [picked('p1', 'laura.jpg'), picked('p2', 'apa.jpg'), picked('p3', 'telefonrol.jpg')], 'acc', 'tok', 'Letöltések',
      dl({ p1: 'laura', p2: 'apa!', p3: 'ismeretlen' }))
    expect(r).toMatchObject({ already: 1, saved: 2, restored: 1, failed: 0, dest: 'Letöltések' })
    expect(readdirSync(join(depot, 'Család', 'Apa', 'Nyár'))).toEqual(['apa.jpg'])
    expect(readdirSync(join(depot, 'Letöltések'))).toEqual(['telefonrol.jpg'])
    expect(readdirSync(join(depot, 'Család', 'Laura', 'Média'))).toEqual(['laura.jpg'])
    expect(loadLifeIndex().map((p) => [p.id, p.lifeRel, p.file]).sort()).toEqual([['p2', 'Család/Apa/Nyár', 'apa.jpg'], ['p3', 'Letöltések', 'telefonrol.jpg']])
    expect(existsSync(join(depot, 'Rendszer'))).toBe(false)
  })
})
