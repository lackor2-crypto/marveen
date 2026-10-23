// Kozossegi kozzetetel (8/c): tarhely + Buffer hamis szerverrel, penz es halozat nelkul.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import { parseCloudinaryUrl, signUpload, uploadPublicVideo } from '../workbench-social-host.js'
import { publishClip, publishWithoutAsking } from '../workbench-social-publish.js'

const CFG = { cloudName: 'demo', apiKey: '123', apiSecret: 'TITOK' }
const BYTES = Buffer.alloc(2048, 5)

function hostFake(opts: { status?: number; body?: unknown } = {}) {
  const seen: { url: string; form: FormData }[] = []
  return {
    seen,
    fetchImpl: async (url: string, init: { method: string; body: FormData }) => {
      seen.push({ url, form: init.body })
      const body = opts.body ?? { secure_url: 'https://res.cloudinary.com/demo/video/upload/v1/marveen/clip1.mp4', public_id: 'marveen/clip1', bytes: 2048 }
      return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, text: async () => JSON.stringify(body) }
    },
  }
}
function bufferFake(failChannel?: string) {
  const posts: { input: Record<string, unknown> }[] = []
  return {
    posts,
    fetchImpl: async (_u: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      const input = JSON.parse(init.body).variables.input as Record<string, unknown>
      posts.push({ input })
      const data = input['channelId'] === failChannel ? { createPost: { message: 'Channel is disconnected' } } : { createPost: { post: { id: 'post-' + input['channelId'], text: 't' } } }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data }) }
    },
  }
}

describe('tarhely', () => {
  it('a Vault-bejegyzes ertelmezese; hibas alak = nincs beallitva', () => {
    expect(parseCloudinaryUrl('cloudinary://123:TITOK@demo')).toEqual(CFG)
    expect(parseCloudinaryUrl('valami')).toBeNull()
    expect(parseCloudinaryUrl(null)).toBeNull()
  })
  it('az alairas: abc-sorrendu "kulcs=ertek" parameterek &-vel, utana a titok, SHA-1 (a vart ertek kulso sha1sum-mal szamolva; a Cloudinary elfogadasat fiok nelkul nem tudjuk igazolni)', () => {
    expect(signUpload({ timestamp: 1315060510, public_id: 'sample' }, 'abcd')).toBe('c3470533147774275dd37996cc4d0e68fd03cd4f')
  })
  it('feltoltes: alairt kerés, a kimeno URL https, a titok nem megy ki az urlapban', async () => {
    const h = hostFake()
    const r = await uploadPublicVideo({ bytes: BYTES, publicId: 'marveen/clip1' }, { fetchImpl: h.fetchImpl, config: CFG, now: () => 1_700_000_000_000 })
    expect(r).toMatchObject({ ok: true, url: 'https://res.cloudinary.com/demo/video/upload/v1/marveen/clip1.mp4' })
    expect(h.seen[0].url).toBe('https://api.cloudinary.com/v1_1/demo/video/upload')
    const f = h.seen[0].form
    expect(f.get('api_key')).toBe('123')
    expect(f.get('signature')).toBe(signUpload({ public_id: 'marveen/clip1', timestamp: 1_700_000_000 }, 'TITOK'))
    expect([...f.keys()]).not.toContain('api_secret')
    expect(JSON.stringify([...f.values()].filter((v) => typeof v === 'string'))).not.toContain('TITOK')
  })
  it('hibak: nincs beallitas, elutasitott kulcs (titok nelkul), nem https valasz', async () => {
    expect(await uploadPublicVideo({ bytes: BYTES, publicId: 'x' }, { config: null })).toMatchObject({ code: 'host_not_configured' })
    const rej = hostFake({ status: 401, body: { error: { message: 'Invalid Signature TITOK' } } })
    const r = await uploadPublicVideo({ bytes: BYTES, publicId: 'x' }, { fetchImpl: rej.fetchImpl, config: CFG })
    expect(r).toMatchObject({ ok: false, code: 'host_key_rejected' })
    if (!r.ok) expect(r.detail).not.toContain('TITOK')
    const http = hostFake({ body: { secure_url: 'http://x/a.mp4' } })
    expect(await uploadPublicVideo({ bytes: BYTES, publicId: 'x' }, { fetchImpl: http.fetchImpl, config: CFG })).toMatchObject({ code: 'host_bad_answer' })
  })
})

describe('kozzetetel', () => {
  beforeEach(() => { initDatabase(':memory:') })
  const channels = [{ id: 'fb1', service: 'facebook' }, { id: 'ig1', service: 'instagram' }]
  const base = { workItemId: 'w1', clipKey: 'clip1', bytes: BYTES, text: 'Freeber is Cheaper', channels }

  it('a vazlat jovahagyas nelkul is megy; egyszer tolt fel, csatornankent egy posztot keszit', async () => {
    const h = hostFake(), b = bufferFake()
    const r = await publishClip({ ...base, draft: true }, { host: { fetchImpl: h.fetchImpl, config: CFG }, buffer: { fetchImpl: b.fetchImpl, getKey: () => 'K' } })
    expect(r.ok).toBe(true)
    expect(h.seen.length).toBe(1)
    expect(b.posts.map((p) => p.input['channelId'])).toEqual(['fb1', 'ig1'])
    expect(b.posts.every((p) => p.input['saveToDraft'] === true)).toBe(true)
    if (r.ok) expect(r.outcomes.map((o) => o.status)).toEqual(['draft', 'draft'])
  })
  it('valodi kozzetetel jovahagyas nelkul NEM megy (sem feltoltes, sem poszt); jovahagyassal vagy 3-as szinten igen', async () => {
    const h = hostFake(), b = bufferFake()
    const deps = { host: { fetchImpl: h.fetchImpl, config: CFG }, buffer: { fetchImpl: b.fetchImpl, getKey: () => 'K' }, autonomy: { categories: [{ key: 'publish_content', level: 2, locked: false }] } }
    expect(await publishClip({ ...base, draft: false }, deps)).toMatchObject({ ok: false, code: 'publish_needs_approval' })
    expect(h.seen.length + b.posts.length).toBe(0)
    expect((await publishClip({ ...base, draft: false, approved: true }, deps)).ok).toBe(true)
    initDatabase(':memory:')
    const h2 = hostFake(), b2 = bufferFake()
    const auto = { host: { fetchImpl: h2.fetchImpl, config: CFG }, buffer: { fetchImpl: b2.fetchImpl, getKey: () => 'K' }, autonomy: { categories: [{ key: 'publish_content', level: 3, locked: false }] } }
    expect((await publishClip({ ...base, draft: false }, auto)).ok).toBe(true)
    expect(publishWithoutAsking({ categories: [{ key: 'publish_content', level: 3, locked: true }] })).toBe(false)
  })
  it('ugyanaz a klip ugyanarra a csatornara nem megy ki ketszer; reszleges hiba utan csak a hianyzo', async () => {
    const h = hostFake(), b = bufferFake('ig1')
    const deps = { host: { fetchImpl: h.fetchImpl, config: CFG }, buffer: { fetchImpl: b.fetchImpl, getKey: () => 'K' } }
    const first = await publishClip({ ...base, draft: true }, deps)
    expect(first.ok && first.outcomes.map((o) => o.status)).toEqual(['draft', 'failed'])
    const b2 = bufferFake()
    const again = await publishClip({ ...base, draft: true }, { host: { fetchImpl: h.fetchImpl, config: CFG }, buffer: { fetchImpl: b2.fetchImpl, getKey: () => 'K' } })
    expect(b2.posts.map((p) => p.input['channelId'])).toEqual(['ig1'])
    expect(again.ok && again.outcomes.map((o) => o.status).sort()).toEqual(['already_posted', 'draft'])
    const third = await publishClip({ ...base, draft: true }, { host: { fetchImpl: h.fetchImpl, config: CFG }, buffer: { fetchImpl: b2.fetchImpl, getKey: () => 'K' } })
    expect(third.ok && third.videoUrl).toBeNull() // nincs mit tenni: nem is toltott fel ujra
    expect(b2.posts.length).toBe(1)
  })
  it('tarhely-hiba: nem megy ki poszt; nincs csatorna: ertheto hiba', async () => {
    const b = bufferFake()
    const r = await publishClip({ ...base, draft: true }, { host: { config: null }, buffer: { fetchImpl: b.fetchImpl, getKey: () => 'K' } })
    expect(r).toMatchObject({ ok: false, code: 'host_not_configured' })
    expect(b.posts.length).toBe(0)
    expect(await publishClip({ ...base, channels: [], draft: true })).toMatchObject({ code: 'publish_no_channel' })
  })
})

import { readClipFile, listSocialPosts, clipKeyFor, CLIP_MAX_BYTES } from '../workbench-social-publish.js'
describe('a munkadarab klipje', () => {
  it('csak a projekt mappajan beluli videofajl; mas kiterjesztes / kijaro ut / hianyzo fajl ertheto hiba', () => {
    expect(readClipFile('Projektek/Reklam', '')).toMatchObject({ code: 'publish_no_clip' })
    expect(readClipFile('Projektek/Reklam', 'Masik/a.mp4')).toMatchObject({ code: 'publish_clip_outside' })
    expect(readClipFile('Projektek/Reklam', 'Projektek/Reklam/../Titok/a.mp4')).toMatchObject({ code: 'publish_clip_outside' })
    expect(readClipFile('Projektek/Reklam', 'Projektek/Reklam/a.pdf')).toMatchObject({ code: 'publish_clip_not_video' })
    expect(readClipFile(null, 'Projektek/Reklam/a.mp4')).toMatchObject({ code: 'publish_clip_outside' })
    expect(CLIP_MAX_BYTES).toBe(100 * 1024 * 1024)
  })
  it('a klip-azonosito a munkadarab + fajlnev; a korabbi posztok listaja', async () => {
    initDatabase(':memory:')
    expect(clipKeyFor('w1', 'Projektek/Reklam/Elkészített anyagok/ai-video-veo.mp4')).toBe('w1/ai-video-veo')
    expect(listSocialPosts('w1')).toEqual([])
    const h = hostFake(), b = bufferFake()
    await publishClip({ workItemId: 'w1', clipKey: 'w1/clip', bytes: BYTES, text: 't', channels: [{ id: 'fb1', service: 'facebook' }], draft: true }, { host: { fetchImpl: h.fetchImpl, config: CFG }, buffer: { fetchImpl: b.fetchImpl, getKey: () => 'K' } })
    expect(listSocialPosts('w1').map((p) => [p.service, p.draft])).toEqual([['facebook', 1]])
  })
})
