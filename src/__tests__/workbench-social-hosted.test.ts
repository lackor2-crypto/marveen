// Nyilvanos tarhely (8/e): legfeljebb 3 video marad fent, a legregebbit toroljuk, a torlesi hiba nem akasztja a posztolast.
// Hamis szerverekkel, penz es halozat nelkul.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, truncateSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let lifeAbs = ''
vi.mock('../life-explorer.js', async (orig) => {
  const real = await orig<typeof import('../life-explorer.js')>()
  return { ...real, resolveLifePath: (rel: string) => (lifeAbs && rel.endsWith('.mp4') ? lifeAbs : null) }
})

import { initDatabase, getDb } from '../db.js'
import { destroyPublicVideo, signUpload } from '../workbench-social-host.js'
import { HOSTED_KEEP, hostedPublicId, hostedView, pruneHostedVideos, recordHosted, sha256Of } from '../workbench-social-hosted.js'
import { publishClip, readClipFile, CLIP_MAX_BYTES } from '../workbench-social-publish.js'

const CFG = { cloudName: 'demo', apiKey: '123', apiSecret: 'TITOK' }
const channels = [{ id: 'fb1', service: 'facebook' }]

/** Hamis tarhely: a feltoltest es a torlest is kiszolgalja, es megjegyzi, mi van "fent". */
function fakeHost(opts: { failDestroy?: (publicId: string) => { status: number; body: unknown } | null } = {}) {
  const up: string[] = []
  const destroyed: string[] = []
  const online = new Set<string>()
  const forms: FormData[] = []
  return {
    up, destroyed, online, forms,
    fetchImpl: async (url: string, init: { method: string; body: FormData }) => {
      forms.push(init.body)
      const pid = String(init.body.get('public_id'))
      if (url.endsWith('/video/upload')) {
        up.push(pid); online.add(pid)
        return { ok: true, status: 200, text: async () => JSON.stringify({ secure_url: `https://res.cloudinary.com/demo/video/upload/v1/${pid}.mp4`, public_id: pid, bytes: 2048 }) }
      }
      const fail = opts.failDestroy?.(pid)
      if (fail) return { ok: false, status: fail.status, text: async () => JSON.stringify(fail.body) }
      destroyed.push(pid)
      const had = online.delete(pid)
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: had ? 'ok' : 'not found' }) }
    },
  }
}
function bufferFake() {
  const posts: Record<string, unknown>[] = []
  return {
    posts,
    fetchImpl: async (_u: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      const input = JSON.parse(init.body).variables.input as Record<string, unknown>
      posts.push(input)
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { createPost: { post: { id: 'p-' + posts.length, text: 't' } } } }) }
    },
  }
}
const clip = (n: number) => Buffer.alloc(2048, n)
let clock = 1_700_000_000_000

async function post(h: ReturnType<typeof fakeHost>, n: number, extra: { bytes?: Buffer; clipKey?: string } = {}) {
  clock += 60_000
  const b = bufferFake()
  return publishClip(
    { workItemId: 'w1', clipKey: extra.clipKey ?? `w1/clip${n}`, bytes: extra.bytes ?? clip(n), text: 't', channels, draft: true },
    { host: { fetchImpl: h.fetchImpl, config: CFG, now: () => clock }, buffer: { fetchImpl: b.fetchImpl, getKey: () => 'K' } },
  )
}
const liveIds = () => hostedView().live.map((r) => r.clip_key)

beforeEach(() => { initDatabase(':memory:') })

describe('torles a tarhelyrol', () => {
  it('alairt kerés (public_id + timestamp + invalidate), a titok nem megy ki; "not found" = mar nincs ott = siker', async () => {
    const h = fakeHost()
    const r = await destroyPublicVideo('marveen/x', { fetchImpl: h.fetchImpl, config: CFG, now: () => 1_700_000_000_000 })
    expect(r).toEqual({ ok: true, alreadyGone: true })
    const f = h.forms[0]
    expect(f.get('signature')).toBe(signUpload({ public_id: 'marveen/x', timestamp: 1_700_000_000, invalidate: 'true' }, 'TITOK'))
    expect([...f.keys()]).not.toContain('api_secret')
    expect(JSON.stringify([...f.values()].filter((v) => typeof v === 'string'))).not.toContain('TITOK')
  })
  it('hibak: nincs beallitas, elutasitott kulcs es halozati hiba is titok nelkul', async () => {
    expect(await destroyPublicVideo('x', { config: null })).toMatchObject({ ok: false, code: 'host_not_configured' })
    const rej = await destroyPublicVideo('x', { config: CFG, fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: { message: 'bad TITOK' } }) }) })
    expect(rej).toMatchObject({ ok: false, code: 'host_key_rejected' })
    if (!rej.ok) expect(rej.detail).not.toContain('TITOK')
    const down = await destroyPublicVideo('x', { config: CFG, fetchImpl: async () => { throw new Error('connect ECONNREFUSED TITOK') } })
    expect(down).toMatchObject({ ok: false, code: 'host_unreachable' })
    if (!down.ok) expect(down.detail).not.toContain('TITOK')
  })
})

describe('legfeljebb 3 video marad fent', () => {
  it('az elso harom feltoltes mind fent marad, semmi nem torlodik', async () => {
    const h = fakeHost()
    for (const n of [1, 2, 3]) expect((await post(h, n)).ok).toBe(true)
    expect(HOSTED_KEEP).toBe(3)
    expect(liveIds()).toEqual(['w1/clip3', 'w1/clip2', 'w1/clip1'])
    expect(h.destroyed).toEqual([])
    expect(hostedView().removed).toEqual([])
  })
  it('a negyedik feltoltesnel a LEGREGEBBI torlodik (nem az utolso, nem a kozepso), a nyilvantartas megmondja mit', async () => {
    const h = fakeHost()
    for (const n of [1, 2, 3]) await post(h, n)
    const r = await post(h, 4)
    expect(r.ok && r.host?.deleted.length).toBe(1)
    expect(h.destroyed.length).toBe(1)
    expect(h.destroyed[0]).toMatch(/^marveen\/w1\/clip1-/)
    expect(liveIds()).toEqual(['w1/clip4', 'w1/clip3', 'w1/clip2'])
    expect(hostedView().removed.map((x) => x.clip_key)).toEqual(['w1/clip1'])
    expect(h.online.size).toBe(3)
    const r5 = await post(h, 5)
    expect(r5.ok && r5.host?.deleted[0]).toMatch(/clip2-/)
    expect(liveIds()).toEqual(['w1/clip5', 'w1/clip4', 'w1/clip3'])
  })
  it('egyszerre egy video megy fel (egy feltoltes = egy kérés); ugyanaz a tartalom ujra nem tolt fel, csak a hianyzo csatorna megy', async () => {
    const h = fakeHost()
    const b = bufferFake()
    const deps = { host: { fetchImpl: h.fetchImpl, config: CFG, now: () => clock }, buffer: { fetchImpl: b.fetchImpl, getKey: () => 'K' } }
    const two = [{ id: 'fb1', service: 'facebook' }, { id: 'ig1', service: 'instagram' }]
    await publishClip({ workItemId: 'w1', clipKey: 'w1/a', bytes: clip(1), text: 't', channels: [two[0]], draft: true }, deps)
    const again = await publishClip({ workItemId: 'w1', clipKey: 'w1/a', bytes: clip(1), text: 't', channels: two, draft: true }, deps)
    expect(h.up.length).toBe(1)
    expect(again.ok && again.host?.reused).toBe(true)
    expect(liveIds()).toEqual(['w1/a'])
  })
  it('ugyanaz a klip megvaltozott tartalommal uj cimet kap (nincs regi CDN-gyorsitotar), azonos tartalom azonos cimet', () => {
    expect(hostedPublicId('w1/same', sha256Of(clip(1)))).not.toBe(hostedPublicId('w1/same', sha256Of(clip(2))))
    expect(hostedPublicId('w1/same', sha256Of(clip(1)))).toBe(hostedPublicId('w1/same', sha256Of(clip(1))))
    expect(hostedPublicId('w1/Ékezetes név.mp4', sha256Of(clip(1)))).toMatch(/^marveen\/[A-Za-z0-9_\-/]+$/)
  })
})

describe('torlesi hiba', () => {
  it('nem akasztja a posztolast, latszik (delete_failed), es a kovetkezo feltoltesnel ujra probalja', async () => {
    let broken = true
    const h = fakeHost({ failDestroy: () => (broken ? { status: 500, body: { error: { message: 'boom TITOK' } } } : null) })
    for (const n of [1, 2, 3]) await post(h, n)
    const r = await post(h, 4)
    expect(r.ok).toBe(true) // a poszt kiment
    if (r.ok) {
      expect(r.outcomes.map((o) => o.status)).toEqual(['draft'])
      expect(r.host?.deleted).toEqual([])
      expect(r.host?.failed.length).toBe(1)
    }
    const stuck = hostedView().live.find((x) => x.state === 'delete_failed')
    expect(stuck?.clip_key).toBe('w1/clip1')
    expect(stuck?.delete_error).toContain('host_delete_failed')
    expect(stuck?.delete_error).not.toContain('TITOK')
    expect(hostedView().live.length).toBe(4) // amig nem sikerul a torles, a sor "fent" van, nem tesszuk hozza, hogy torolve
    broken = false
    const r5 = await post(h, 5)
    expect(r5.ok && r5.host?.deleted.length).toBe(2) // a regi, beragadt es az ujabb is
    expect(liveIds()).toEqual(['w1/clip5', 'w1/clip4', 'w1/clip3'])
    expect(hostedView().removed.map((x) => x.clip_key).sort()).toEqual(['w1/clip1', 'w1/clip2'])
  })
  it('a "Torles ujraprobalasa" (pruneHostedVideos) onmagaban is mukodik; tarhely-hozzaferes nelkul nem dob, csak kihagy', async () => {
    const h = fakeHost()
    for (const n of [1, 2, 3, 4]) recordHosted({ publicId: `marveen/p${n}`, clipKey: `p${n}`, url: 'https://x/' + n, bytes: 10, sha256: 'a'.repeat(64), now: clock + n })
    expect(await pruneHostedVideos({ config: null })).toEqual({ deleted: [], failed: [], skipped: true })
    expect(hostedView().live.length).toBe(4)
    const r = await pruneHostedVideos({ fetchImpl: h.fetchImpl, config: CFG })
    expect(r.deleted).toEqual(['marveen/p1'])
    expect(hostedView().live.map((x) => x.public_id)).toEqual(['marveen/p4', 'marveen/p3', 'marveen/p2'])
  })
  it('a torolt sorokbol csak az utolso 20 marad (a lista nem no vegtelenre)', async () => {
    const h = fakeHost()
    for (let n = 1; n <= 30; n++) recordHosted({ publicId: `marveen/q${n}`, clipKey: `q${n}`, url: 'https://x/' + n, bytes: 10, sha256: 'b'.repeat(64), now: clock + n })
    await pruneHostedVideos({ fetchImpl: h.fetchImpl, config: CFG, now: () => clock })
    const n = (getDb().prepare("SELECT COUNT(*) AS c FROM wb_social_hosted WHERE state = 'deleted'").get() as { c: number }).c
    expect(n).toBe(20)
    expect(hostedView().live.length).toBe(3)
  })
})

describe('100 MB feletti klip', () => {
  it('nem olvassuk be, nem tolt fel: ember-mondat kod + meret; a hataron beluli klip megy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-clip-'))
    try {
      lifeAbs = join(dir, 'a.mp4')
      writeFileSync(lifeAbs, Buffer.alloc(16))
      truncateSync(lifeAbs, CLIP_MAX_BYTES + 1)
      const big = readClipFile('Projektek/Reklam', 'Projektek/Reklam/a.mp4')
      expect(big).toMatchObject({ ok: false, code: 'publish_clip_too_big' })
      if (!big.ok) expect(big.detail).toBe('101 MB > 100 MB')
      truncateSync(lifeAbs, 4096)
      expect(readClipFile('Projektek/Reklam', 'Projektek/Reklam/a.mp4')).toMatchObject({ ok: true })
    } finally {
      lifeAbs = ''
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
