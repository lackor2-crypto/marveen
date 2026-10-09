// The list the owner approves before a Google Photos download (#520).
//
// Owner, 2026-10-09 (TG 8389): "nem arrol volt szo hogy megjegyzi az utvonalat?
// [...] fel kellene ajanlania hogy honnan lett feltoltve". The place was
// remembered, but the page asked for one folder for the whole batch and said
// nothing. The list offers a place PER PHOTO and nothing comes down before it
// is approved.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDownloadReview, checkReviewPlaces, type ReviewDeps } from '../web/routes/photos-picker.js'

const item = (id: string, filename: string, mime = 'image/jpeg') => ({ id, mediaFile: { baseUrl: `https://lh3.googleusercontent.com/${id}`, mimeType: mime, filename } })
const deps = (over: Partial<ReviewDeps> = {}): ReviewDeps => ({
  lifeIds: new Map(), oldIds: new Set(), placeFor: () => null, remembered: () => '', unchangedThere: () => false, ...over,
})

describe('what is offered for each picked photo', () => {
  it('a photo this program uploaded is offered the folder it came from', () => {
    const rows = buildDownloadReview([item('u1', '009.jpg')], deps({ placeFor: () => ({ lifeRel: 'Család/En/Fotók', file: '009.jpg', bytes: 10 }) }))
    expect(rows).toEqual([{ id: 'u1', filename: '009.jpg', isVideo: false, already: false, alreadyAt: '', proposal: { kind: 'uploaded', lifeRel: 'Család/En/Fotók' } }])
  })

  it('an uploaded photo whose file is still in its folder is "already here", not downloaded again', () => {
    const rows = buildDownloadReview([item('u1', '009.jpg')], deps({ placeFor: () => ({ lifeRel: 'Család/En/Fotók', file: '009.jpg', bytes: 10 }), unchangedThere: () => true }))
    expect(rows[0]).toMatchObject({ already: true, alreadyAt: 'Család/En/Fotók', proposal: null })
  })

  it('a photo downloaded before is offered the folder chosen then', () => {
    const rows = buildDownloadReview([item('m1', 'IMG_1.jpg')], deps({ remembered: (id) => (id === 'm1' ? 'Család/Laura' : '') }))
    expect(rows[0].proposal).toEqual({ kind: 'remembered', lifeRel: 'Család/Laura' })
  })

  it('an unknown photo has no place: the owner has to choose (fresh install: every photo)', () => {
    const rows = buildDownloadReview([item('x1', 'a.jpg'), item('x2', 'b.mp4', 'video/mp4')], deps())
    expect(rows.map((r) => [r.proposal, r.already, r.isVideo])).toEqual([[null, false, false], [null, false, true]])
  })

  it('a photo already in the Life tree says where it is', () => {
    const rows = buildDownloadReview([item('k1', 'a.jpg'), item('o1', 'b.jpg')], deps({ lifeIds: new Map([['k1', 'Család/Laura']]), oldIds: new Set(['o1']) }))
    expect(rows.map((r) => [r.already, r.alreadyAt])).toEqual([[true, 'Család/Laura'], [true, '']])
  })
})

describe('nothing comes down until every photo has a usable folder', () => {
  const rows = buildDownloadReview([item('a', 'a.jpg'), item('b', 'b.jpg'), item('k', 'k.jpg')], deps({
    lifeIds: new Map([['k', 'X']]), placeFor: (it) => (it.id === 'b' ? { lifeRel: 'Régi/Hely', file: 'b.jpg', bytes: 1 } : null),
  }))
  const ok = (rel: unknown) => (rel === 'Jó' ? { ok: true } : { ok: false, code: rel === 'Kuka' ? 'dest_trash' : 'dest_missing' })

  it('the first photo without a folder is named', () => {
    expect(checkReviewPlaces(rows, { b: 'Jó' }, ok)).toEqual({ ok: false, code: 'place_missing', file: 'a.jpg' })
  })
  it('an unusable folder is refused with its reason and the photo it belongs to', () => {
    expect(checkReviewPlaces(rows, { a: 'Kuka', b: 'Jó' }, ok)).toEqual({ ok: false, code: 'dest_trash', file: 'a.jpg' })
  })
  it('the folder a photo was uploaded from may be gone: it will be made again', () => {
    expect(checkReviewPlaces(rows, { a: 'Jó', b: 'Régi/Hely' }, ok)).toEqual({ ok: true })
  })
  it('a gone folder that is NOT the upload place is refused', () => {
    expect(checkReviewPlaces(rows, { a: 'Nincs', b: 'Jó' }, ok)).toEqual({ ok: false, code: 'dest_missing', file: 'a.jpg' })
  })
  it('a photo that is already here needs no folder', () => {
    expect(checkReviewPlaces(rows, { a: 'Jó', b: 'Jó' }, ok)).toEqual({ ok: true })
  })
})

describe('the page and the route follow the same order', () => {
  const root = join(import.meta.dirname, '..', '..')
  const app = readFileSync(join(root, 'web/app.js'), 'utf-8')
  const route = readFileSync(join(root, 'src/web/routes/photos-picker.ts'), 'utf-8')

  it('"Add photos" no longer asks for a folder before the selection', () => {
    const start = app.slice(app.indexOf('async function _photosStartPicker()'), app.indexOf('let _photosPollGen'))
    expect(start).not.toContain('_lifePickFolder(')
    expect(start).toContain("body: JSON.stringify({ account: _photosAccount }),")
  })
  it('the selection opens the list instead of downloading', () => {
    expect(app).toContain('_photosReviewOpen(account, data.review)')
    const get = route.slice(route.indexOf("if (path === '/api/photos/session' && method === 'GET')"), route.indexOf("if (path === '/api/photos/session/thumb'"))
    expect(get).not.toContain('downloadPickedToLife(')
    expect(get).toContain('review: {')
  })
  it('only the approved list downloads, and it remembers the folder per photo', () => {
    const post = route.slice(route.indexOf("if (path === '/api/photos/session/download'"))
    expect(post.indexOf('checkReviewPlaces(rows, places)')).toBeGreaterThan(0)
    expect(post.indexOf('checkReviewPlaces(rows, places)')).toBeLessThan(post.indexOf('downloadPickedToLife('))
    expect(post).toContain('rememberPhotoPlaces(account, chosen)')
  })
})
