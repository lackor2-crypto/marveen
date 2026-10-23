// Buffer-kliens (8/b): hamis szerverrel, kulcs es halozat nelkul.
import { describe, it, expect } from 'vitest'
import { listBufferChannels, createBufferPost, buildCreatePostInput, validatePublicVideoUrl, type BufferPostInput } from '../workbench-social-buffer.js'

type Seen = { url: string; headers: Record<string, string>; body: { query: string; variables?: Record<string, unknown> } }
function fake(answers: unknown[], status = 200, seen: Seen[] = []) {
  let i = 0
  return {
    seen,
    fetchImpl: async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      const a = answers[Math.min(i++, answers.length - 1)]
      return { ok: status < 400, status, text: async () => (typeof a === 'string' ? a : JSON.stringify(a)) }
    },
  }
}
const KEY = 'sk-buffer-SECRET'
const base: BufferPostInput = { channelId: 'ch1', text: 'Freeber is Cheaper', videoUrl: 'https://cdn.example.com/clip.mp4', draft: true }

describe('csatornak', () => {
  it('szervezet, majd csatornak; a kulcs csak a fejlecben', async () => {
    const f = fake([
      { data: { account: { organizations: [{ id: 'org1', name: 'My organization' }] } } },
      { data: { channels: [{ id: 'c1', name: 'Freeber', service: 'facebook', type: 'page', isLocked: false, isDisconnected: false, timezone: 'America/Chicago' }] } },
    ])
    const r = await listBufferChannels({ fetchImpl: f.fetchImpl, getKey: () => KEY })
    expect(r).toMatchObject({ ok: true, organizationId: 'org1' })
    if (r.ok) expect(r.channels[0].service).toBe('facebook')
    expect(f.seen[0].url).toBe('https://api.buffer.com')
    expect(f.seen[0].headers['authorization']).toBe(`Bearer ${KEY}`)
    expect(JSON.stringify(f.seen.map((s) => s.body))).not.toContain(KEY)
    expect(f.seen[1].body.variables).toEqual({ org: 'org1' })
  })
  it('ures csatornalista nem hiba; kulcs nelkul es elutasitott kulccsal ertheto kod', async () => {
    const empty = fake([{ data: { account: { organizations: [{ id: 'o', name: 'x' }] } } }, { data: { channels: [] } }])
    expect(await listBufferChannels({ fetchImpl: empty.fetchImpl, getKey: () => KEY })).toMatchObject({ ok: true, channels: [] })
    expect(await listBufferChannels({ getKey: () => null })).toMatchObject({ ok: false, code: 'buffer_no_key' })
    const rej = fake([`unauthorized ${KEY}`], 401)
    const r = await listBufferChannels({ fetchImpl: rej.fetchImpl, getKey: () => KEY })
    expect(r).toMatchObject({ ok: false, code: 'buffer_key_rejected' })
    if (!r.ok) expect(r.detail).not.toContain(KEY)
  })
})

describe('video-URL', () => {
  it('csak nyilvanos https, kozvetlen fajl; helyi cim, http, Drive/Dropbox megosztas elutasitva', () => {
    expect(validatePublicVideoUrl('https://cdn.example.com/a.mp4')).toBeNull()
    expect(validatePublicVideoUrl('http://cdn.example.com/a.mp4')).toMatch(/https/)
    expect(validatePublicVideoUrl('https://localhost/a.mp4')).toMatch(/public/)
    expect(validatePublicVideoUrl('https://192.168.1.5/a.mp4')).toMatch(/public/)
    expect(validatePublicVideoUrl('https://drive.google.com/file/d/1/view')).toMatch(/share links/)
    expect(validatePublicVideoUrl('https://www.dropbox.com/s/x/a.mp4')).toMatch(/share links/)
    expect(validatePublicVideoUrl('nem url')).toMatch(/valid/)
  })
})

describe('poszt', () => {
  it('a vazlat a schema szerinti mezokkel megy (saveToDraft, addToQueue, assets[video])', () => {
    expect(buildCreatePostInput(base)).toEqual({
      channelId: 'ch1', text: 'Freeber is Cheaper', assets: [{ video: { url: 'https://cdn.example.com/clip.mp4' } }],
      schedulingType: 'automatic', mode: 'addToQueue', saveToDraft: true,
    })
  })
  it('idopont = customScheduled + dueAt; csatornankenti beallitas (reel / TikTok-cim / YouTube)', () => {
    const due = '2026-10-27T23:00:00.000Z'
    const ig = buildCreatePostInput({ ...base, draft: false, dueAt: due, service: 'instagram' })
    expect(ig).toMatchObject({ mode: 'customScheduled', dueAt: due, saveToDraft: false, metadata: { instagram: { type: 'reel' } } })
    expect(buildCreatePostInput({ ...base, service: 'tiktok', title: 'Freeber' })['metadata']).toEqual({ tiktok: { isAiGenerated: true, title: 'Freeber' } })
    expect((buildCreatePostInput({ ...base, service: 'youtube', title: 'Freeber' })['metadata'] as { youtube: { privacy: string } }).youtube.privacy).toBe('public')
  })
  it('sikeres vazlat: a poszt azonositoja; a Buffer elutasitasa ertheto hiba', async () => {
    const ok = fake([{ data: { createPost: { post: { id: 'p1', text: 't' } } } }])
    expect(await createBufferPost(base, { fetchImpl: ok.fetchImpl, getKey: () => KEY })).toEqual({ ok: true, postId: 'p1', draft: true })
    expect(ok.seen[0].body.variables).toMatchObject({ input: { saveToDraft: true } })
    const no = fake([{ data: { createPost: { message: 'Channel is disconnected' } } }])
    expect(await createBufferPost(base, { fetchImpl: no.fetchImpl, getKey: () => KEY })).toMatchObject({ ok: false, code: 'buffer_post_rejected', detail: 'Channel is disconnected' })
  })
  it('a vedelmek: kifejezett draft jelzo, csatorna, szoveg, URL, idopont nelkul NEM megy ki semmi', async () => {
    const f = fake([{ data: {} }])
    const deps = { fetchImpl: f.fetchImpl, getKey: () => KEY }
    expect(await createBufferPost({ ...base, draft: undefined as unknown as boolean }, deps)).toMatchObject({ code: 'buffer_draft_flag_required' })
    expect(await createBufferPost({ ...base, channelId: '' }, deps)).toMatchObject({ code: 'buffer_no_channel' })
    expect(await createBufferPost({ ...base, text: '  ' }, deps)).toMatchObject({ code: 'buffer_no_text' })
    expect(await createBufferPost({ ...base, videoUrl: 'http://x.com/a.mp4' }, deps)).toMatchObject({ code: 'buffer_bad_video_url' })
    expect(await createBufferPost({ ...base, dueAt: 'holnap' }, deps)).toMatchObject({ code: 'buffer_bad_due_at' })
    expect(f.seen.length).toBe(0)
  })
})
