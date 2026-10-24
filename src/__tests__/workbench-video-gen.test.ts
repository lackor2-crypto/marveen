// AI-videogeneralas (munkadarab "Video fejlesztes"): hamis OpenRouterrel, penz es halozat nelkul.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { setItemSensitive } from '../workbench-privacy.js'
import { estimateVideoCost, parseVideoModels, validateVideoParams, startVideo, type FetchLike } from '../workbench-video-gen.js'
import { getVideoGen, listVideoGens, monthSpendUsd, createVideoGen, setRemoteId, failOrphanPreparing, activeVideoGen } from '../workbench-video-gen-store.js'
import { startVideoGeneration, pollVideoGeneration, resumeVideoGenerations, retryVideoDownload, previewVideoGen, VIDEO_PROMPT_GUARD } from '../workbench-video-gen-jobs.js'

const LIST = { data: [
  { id: 'google/veo-3.1-lite', name: 'Google: Veo 3.1 Lite', supported_resolutions: ['720p', '1080p'], supported_aspect_ratios: ['16:9', '9:16'], supported_durations: [8, 4, 6], generate_audio: true,
    pricing_skus: { duration_seconds_with_audio: '0.08', duration_seconds_without_audio: '0.05', duration_seconds_with_audio_720p: '0.05', duration_seconds_without_audio_720p: '0.03' } },
  { id: 'alibaba/wan-3.0', name: 'Alibaba: Wan 3.0', supported_resolutions: ['480p', '720p'], supported_aspect_ratios: ['9:16'], supported_durations: [2, 3, 4, 5, 10], generate_audio: true,
    pricing_skus: { duration_seconds_480p: '0.05', duration_seconds_720p: '0.1' } },
  { id: 'x-ai/grok-imagine-video-1.5-lite', name: 'Grok Lite', supported_resolutions: ['480p', '720p'], supported_aspect_ratios: ['9:16'], supported_durations: [5, 10], generate_audio: null,
    pricing_skus: { cents_per_video_output_second_480p: '2', cents_per_video_output_second_720p: '3' } },
  { id: 'x/nincs-ar', name: 'X', supported_resolutions: ['720p'], supported_aspect_ratios: ['9:16'], supported_durations: [5], generate_audio: true, pricing_skus: { valami_mas: '1' } },
] }
const P = { duration: 8, resolution: '720p', aspect_ratio: '9:16', audio: true }
const MP4 = Buffer.alloc(4096, 7)

interface Fake { calls: { url: string; method: string; auth: string | undefined; body?: string }[]; posts: number }
function fakeOpenRouter(opts: { status?: string[]; startStatus?: number; startThrows?: boolean; downloadFailsFirst?: number; cost?: number; statusThrowsFirst?: number } = {}): { f: FetchLike; s: Fake } {
  const s: Fake = { calls: [], posts: 0 }
  let polled = 0
  let dlFails = opts.downloadFailsFirst ?? 0
  let stFails = opts.statusThrowsFirst ?? 0
  const f: FetchLike = async (url, init) => {
    const method = init?.method || 'GET'
    s.calls.push({ url, method, auth: init?.headers?.['authorization'], body: init?.body })
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) })
    if (url.endsWith('/videos/models')) return ok(LIST)
    if (method === 'POST') {
      s.posts++
      if (opts.startThrows) throw new Error('socket hang up')
      if (opts.startStatus) return ok({ error: { message: 'insufficient credits sk-secret-KEY' } }, opts.startStatus)
      return ok({ id: 'job-1', polling_url: 'x', status: 'pending' }, 202)
    }
    if (url.includes('/content')) {
      if (dlFails > 0) { dlFails--; return ok({ error: 'boom' }, 500) }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => MP4.buffer.slice(MP4.byteOffset, MP4.byteOffset + MP4.byteLength) as ArrayBuffer }
    }
    if (stFails > 0) { stFails--; throw new Error('getaddrinfo ENOTFOUND openrouter.ai') }
    const seq = opts.status ?? ['in_progress', 'completed']
    const st = seq[Math.min(polled++, seq.length - 1)]
    return ok({ status: st, usage: st === 'completed' ? { cost: opts.cost ?? 0.4 } : undefined, error: st === 'failed' ? 'content policy' : undefined })
  }
  return { f, s }
}
const noSleep = async (): Promise<void> => {}

describe('ar es parameterek az elo listabol', () => {
  const models = parseVideoModels(LIST)
  const veo = models[0], wan = models[1], grok = models[2], noprice = models[3]
  it('az ar a modell sajat mezoibol jon (hanggal / hang nelkul / felbontassal / centben)', () => {
    expect(estimateVideoCost(veo, P)).toBeCloseTo(0.4, 4)
    expect(estimateVideoCost(veo, { ...P, audio: false })).toBeCloseTo(0.24, 4)
    expect(estimateVideoCost(wan, { duration: 10, resolution: '480p', aspect_ratio: '9:16', audio: true })).toBeCloseTo(0.5, 4)
    expect(estimateVideoCost(grok, { duration: 10, resolution: '720p', aspect_ratio: '9:16', audio: false })).toBeCloseTo(0.3, 4)
  })
  it('ismeretlen ar-szerkezetnel null (nem talal ki szamot)', () => {
    expect(estimateVideoCost(noprice, { duration: 5, resolution: '720p', aspect_ratio: '9:16', audio: true })).toBeNull()
  })
  it('#787: a modell, ami a listaja szerint NEM tud hangot: a hangos keres elutasitva, a becsles a hang nelkuli ar', () => {
    const silent = parseVideoModels({ data: [{ id: 'x/silent', name: 'Silent', supported_resolutions: ['720p'], supported_aspect_ratios: ['9:16'], supported_durations: [8], generate_audio: false,
      pricing_skus: { duration_seconds_with_audio: '0.08', duration_seconds_without_audio: '0.05' } }] })[0]
    expect(silent.audio).toBe(false)
    expect(validateVideoParams(silent, P)).toEqual({ ok: false, code: 'video_audio_unsupported', detail: 'the model list says this model makes no sound' })
    expect(validateVideoParams(silent, { ...P, audio: false }).ok).toBe(true)
    // the estimate never charges the sound price for a model that makes none
    expect(estimateVideoCost(silent, P)).toBeCloseTo(0.4, 4)
    expect(estimateVideoCost(silent, { ...P, audio: false })).toBeCloseTo(0.4, 4)
    // a model whose list says nothing about sound keeps its own code
    expect(validateVideoParams(grok, { ...P, duration: 10 })).toMatchObject({ ok: false, code: 'video_audio_unknown' })
  })
  it('a nem tamogatott ertek elutasitva, a megengedettekkel', () => {
    expect(validateVideoParams(veo, { ...P, duration: 9 })).toEqual({ ok: false, code: 'video_bad_duration', detail: '4, 6, 8' })
    expect(validateVideoParams(veo, { ...P, aspect_ratio: '1:1' }).ok).toBe(false)
    expect(validateVideoParams(grok, { ...P, duration: 10 }).ok).toBe(false) // a listaja nem mond hangrol
    expect(validateVideoParams(veo, P).ok).toBe(true)
  })
})

describe('inditas: hibak es a kulcs vedelme', () => {
  it('a kulcs csak a fejlecben megy; a szolgaltato hibauzenetebol kiszurve; 402 = nincs egyenleg, penz nem ment el', async () => {
    const { f } = fakeOpenRouter({ startStatus: 402 })
    const r = await startVideo({ key: 'sk-secret-KEY', model: 'm', prompt: 'p', params: P, fetchImpl: f })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('video_no_credit')
    expect(r.maybeStarted).toBe(false)
    expect(r.detail).not.toContain('sk-secret-KEY')
  })
  it('idotullepes/halozati hiba: lehet, hogy elindult -> maybeStarted', async () => {
    const { f } = fakeOpenRouter({ startThrows: true })
    const r = await startVideo({ key: 'k', model: 'm', prompt: 'p', params: P, fetchImpl: f })
    expect(r.ok === false && r.maybeStarted).toBe(true)
  })
})

describe('a teljes folyamat', () => {
  let depot = ''
  let projectId = ''
  let itemId = ''
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-videogen-'))
    mkdirSync(join(depot, 'Projektek', 'Reklam'), { recursive: true })
    saved['MARVEEN_DEPOT'] = process.env['MARVEEN_DEPOT']
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Reklam' })
    if (!p.ok) throw new Error('projekt')
    projectId = p.project.id
    updateProject(projectId, { folder_path: 'Projektek/Reklam' })
    const w = createWorkItem({ project_id: projectId, title: 'Taxi klip', type: 'video' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })
  afterEach(() => {
    if (saved['MARVEEN_DEPOT'] === undefined) delete process.env['MARVEEN_DEPOT']
    else process.env['MARVEEN_DEPOT'] = saved['MARVEEN_DEPOT']
    rmSync(depot, { recursive: true, force: true })
  })
  const ctx = () => ({ item: getWorkItem(itemId)!, project: { id: projectId } as never })
  const run = async (deps: Parameters<typeof startVideoGeneration>[0]['deps'], prompt = 'Taxi a naplementeben') => {
    const { getProject } = await import('../projects.js')
    return startVideoGeneration({ item: getWorkItem(itemId)!, project: getProject(projectId)!, prompt, params: P, deps })
  }

  it('siker: sor a kerés elott, azonosito mentve, kesz klip uj fajl + uj verzio, tenyleges koltseg, a kulcs a fejlecben', async () => {
    const { f, s } = fakeOpenRouter({ cost: 0.41 })
    const deps = { fetchImpl: f, getKey: () => 'KEY1', pollMs: 1, sleep: noSleep }
    const r = await run(deps)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row.remote_id).toBe('job-1')
    await pollVideoGeneration(r.row.id, deps)
    // a hatterben indult figyelo is ugyanezt a sort viszi; a vegeredmeny ugyanaz
    const done = getVideoGen(r.row.id)!
    expect(done.state).toBe('done')
    expect(done.cost_usd).toBeCloseTo(0.41, 4)
    expect(done.file_rel).toMatch(/ai-video-google-veo-3-1-lite-\d{8}-\d{4}\.mp4$/)
    expect(existsSync(join(depot, done.file_rel!))).toBe(true)
    const item = getWorkItem(itemId)!
    expect(item.source_path).toBe(done.file_rel)
    expect(s.calls.every((c) => c.url.endsWith('/models') || c.auth === 'Bearer KEY1')).toBe(true)
    const post = s.calls.find((c) => c.method === 'POST')!
    const sent = JSON.parse(post.body!)
    expect(sent).toMatchObject({ model: 'google/veo-3.1-lite', duration: 8, resolution: '720p', aspect_ratio: '9:16', generate_audio: true })
    expect(sent.prompt).toContain('Taxi a naplementeben')
    expect(sent.prompt).toContain(VIDEO_PROMPT_GUARD)
    expect(JSON.stringify(done)).not.toContain('KEY1')
  })

  it('dupla inditas: a masodik elutasitva, csak EGY fizetos kerés megy el', async () => {
    const { f, s } = fakeOpenRouter({ status: ['in_progress'] })
    const deps = { fetchImpl: f, getKey: () => 'K', pollMs: 1_000_000, sleep: () => new Promise<void>(() => {}) }
    const a = await run(deps)
    const b = await run(deps)
    expect(a.ok).toBe(true)
    expect(b).toMatchObject({ ok: false, code: 'video_already_running' })
    expect(s.posts).toBe(1)
  })

  it('#784: ket EGYIDEJU inditas (ket ful / tulajdonos + asszisztens): csak EGY fizetos keres megy el', async () => {
    const { f, s } = fakeOpenRouter({ status: ['in_progress'] })
    const deps = { fetchImpl: f, getKey: () => 'K', pollMs: 1_000_000, sleep: () => new Promise<void>(() => {}) }
    const [a, b] = await Promise.all([run(deps), run(deps)])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect(a.ok ? b : a).toMatchObject({ ok: false, code: 'video_already_running' })
    expect(s.posts).toBe(1)
    expect(listVideoGens(itemId)).toHaveLength(1)
  })

  it('#784: egy elutasitott inditas nem hagy foglalast: utana ujra lehet inditani', async () => {
    const bad = fakeOpenRouter({ startStatus: 402 })
    expect(await run({ fetchImpl: bad.f, getKey: () => 'K' })).toMatchObject({ ok: false, code: 'video_no_credit' })
    const good = fakeOpenRouter({ status: ['in_progress'] })
    const r = await run({ fetchImpl: good.f, getKey: () => 'K', pollMs: 1_000_000, sleep: () => new Promise<void>(() => {}) })
    expect(r.ok).toBe(true)
  })

  it('erzekeny munkadarabnal nem fut; kulcs nelkul nem fut; ures prompttal nem fut', async () => {
    const { f, s } = fakeOpenRouter()
    expect(await run({ fetchImpl: f, getKey: () => null })).toMatchObject({ ok: false, code: 'video_no_key' })
    expect(await run({ fetchImpl: f, getKey: () => 'K' }, '   ')).toMatchObject({ ok: false, code: 'video_no_prompt' })
    setItemSensitive(itemId, true, 'teszt')
    expect(await run({ fetchImpl: f, getKey: () => 'K' })).toMatchObject({ ok: false, code: 'video_sensitive' })
    expect(s.posts).toBe(0)
  })

  it('a havi keret: ami atlepne, nem indul; az ismeretlen ar sem', async () => {
    const { f, s } = fakeOpenRouter()
    const deps = { fetchImpl: f, getKey: () => 'K' }
    const old = createVideoGen({ itemId, projectId, model: 'm', prompt: 'x', params: P, estUsd: 19.8 })
    setRemoteId(old.id, 'old')
    expect(monthSpendUsd()).toBeCloseTo(19.8, 3)
    // az elozo feladat meg fut -> eloszor azt zarjuk le, hogy a keret-ellenorzest lassuk
    getVideoGenDone(old.id)
    expect(await run(deps)).toMatchObject({ ok: false, code: 'video_over_budget' })
    expect(s.posts).toBe(0)
  })

  it('az indulas elutasitasa (402) nem hagy fuggo feladatot; a bizonytalan inditas NEM probalkozik ujra', async () => {
    const a = fakeOpenRouter({ startStatus: 402 })
    expect(await run({ fetchImpl: a.f, getKey: () => 'K' })).toMatchObject({ ok: false, code: 'video_no_credit' })
    expect(activeVideoGen(itemId)).toBeNull()
    const b = fakeOpenRouter({ startThrows: true })
    expect(await run({ fetchImpl: b.f, getKey: () => 'K' })).toMatchObject({ ok: false, code: 'video_start_unsure' })
    expect(b.s.posts).toBe(1)
    expect(listVideoGens(itemId)[0].state).toBe('failed')
  })

  it('a modell hibaja: failed, a modell sajat uzenetevel', async () => {
    const { f } = fakeOpenRouter({ status: ['failed'] })
    const deps = { fetchImpl: f, getKey: () => 'K', pollMs: 1, sleep: noSleep }
    const r = await run(deps)
    if (!r.ok) throw new Error('inditas')
    await pollVideoGeneration(r.row.id, deps)
    const row = getVideoGen(r.row.id)!
    expect(row.state).toBe('failed')
    expect(row.error_code).toBe('video_generation_failed')
    expect(row.error_detail).toContain('content policy')
  })

  it('letoltes-hiba: failed, de ingyen ujra letoltheto; nem generalunk ujat', async () => {
    const { f, s } = fakeOpenRouter({ downloadFailsFirst: 3 })
    const deps = { fetchImpl: f, getKey: () => 'K', pollMs: 1, sleep: noSleep }
    const r = await run(deps)
    if (!r.ok) throw new Error('inditas')
    await pollVideoGeneration(r.row.id, deps)
    expect(getVideoGen(r.row.id)!.error_code).toBe('video_download_failed')
    const again = await retryVideoDownload(r.row.id, deps)
    expect(again.ok).toBe(true)
    expect(getVideoGen(r.row.id)!.state).toBe('done')
    expect(s.posts).toBe(1)
  })

  it('#785: hosszabb net-kimaradas (10 elbukott allapot-lekerdezes) nem oli meg a feladatot: utana letolti', async () => {
    const { f, s } = fakeOpenRouter({ statusThrowsFirst: 10 })
    const deps = { fetchImpl: f, getKey: () => 'K', pollMs: 1, sleep: noSleep }
    const r = await run(deps)
    if (!r.ok) throw new Error('inditas')
    await pollVideoGeneration(r.row.id, deps)
    expect(getVideoGen(r.row.id)!.state).toBe('done')
    expect(s.posts).toBe(1)
  })

  it('#785: idotullepes utan a kifizetett video NEM vesz el: ujra ellenorizheto (ingyen), es ha kesz, letoltodik', async () => {
    const slow = fakeOpenRouter({ status: ['in_progress'] })
    const deps = { fetchImpl: slow.f, getKey: () => 'K', pollMs: 1, sleep: noSleep, waitMaxMs: -1 }
    const r = await run(deps)
    if (!r.ok) throw new Error('inditas')
    await pollVideoGeneration(r.row.id, deps)
    expect(getVideoGen(r.row.id)).toMatchObject({ state: 'failed', error_code: 'video_gen_timeout' })
    // a talan-fizetett feladat a havi keretbe a becslesevel szamit
    expect(monthSpendUsd()).toBeCloseTo(0.4, 4)
    const ready = fakeOpenRouter({ status: ['completed'], cost: 0.4 })
    const deps2 = { fetchImpl: ready.f, getKey: () => 'K', pollMs: 1, sleep: noSleep }
    const again = await retryVideoDownload(r.row.id, deps2)
    expect(again.ok).toBe(true)
    await pollVideoGeneration(r.row.id, deps2)
    expect(getVideoGen(r.row.id)).toMatchObject({ state: 'done', error_code: null })
    expect(slow.s.posts + ready.s.posts).toBe(1)
  })

  it('#785: a tartos net-hiba a varakozasi ido vegen a halozati kodot adja, es az is ujra ellenorizheto', async () => {
    const { f } = fakeOpenRouter({ statusThrowsFirst: 1000 })
    const deps = { fetchImpl: f, getKey: () => 'K', pollMs: 1, sleep: noSleep, waitMaxMs: 0 }
    const r = await run(deps)
    if (!r.ok) throw new Error('inditas')
    await new Promise((res) => setTimeout(res, 5))
    await pollVideoGeneration(r.row.id, deps)
    expect(getVideoGen(r.row.id)).toMatchObject({ state: 'failed', error_code: 'video_status_unreachable' })
    const ok = fakeOpenRouter()
    const again = await retryVideoDownload(r.row.id, { fetchImpl: ok.f, getKey: () => 'K', pollMs: 1, sleep: noSleep })
    expect(again).toMatchObject({ ok: true })
  })

  it('#785: a modell sajat hibaja (nem fizetett) es az elutasitott inditas nem szamit a keretbe; a bizonytalan inditas igen', async () => {
    const a = createVideoGen({ itemId, projectId, model: 'm', prompt: 'p', params: P, estUsd: 1 })
    setRemoteId(a.id, 'job-a')
    const { failVideoGen } = await import('../workbench-video-gen-store.js')
    failVideoGen(a.id, 'video_generation_failed', 'policy')
    const b = createVideoGen({ itemId, projectId, model: 'm', prompt: 'p', params: P, estUsd: 2 })
    failVideoGen(b.id, 'video_no_credit', 'x')
    expect(monthSpendUsd()).toBe(0)
    const c = createVideoGen({ itemId, projectId, model: 'm', prompt: 'p', params: P, estUsd: 3 })
    failVideoGen(c.id, 'video_start_unsure', 'x')
    expect(monthSpendUsd()).toBe(3)
    expect(await retryVideoDownload(a.id)).toMatchObject({ ok: false, code: 'video_not_retryable' })
  })

  it('ujrainditas: a futo feladat folytatodik, a "preparing" maradek failed es nem megy ujra', async () => {
    const { f, s } = fakeOpenRouter()
    const running = createVideoGen({ itemId, projectId, model: 'google/veo-3.1-lite', prompt: 'p', params: P, estUsd: 0.4 })
    setRemoteId(running.id, 'job-1')
    const w2 = createWorkItem({ project_id: projectId, title: 'Masik', type: 'video' })
    if (!w2.ok) throw new Error('w2')
    const orphan = createVideoGen({ itemId: w2.item.id, projectId, model: 'm', prompt: 'p', params: P, estUsd: 0.4 })
    expect(failOrphanPreparing()).toBe(1)
    expect(getVideoGen(orphan.id)).toMatchObject({ state: 'failed', error_code: 'video_interrupted_before_id' })
    const r = resumeVideoGenerations({ fetchImpl: f, getKey: () => 'K', pollMs: 1, sleep: noSleep })
    expect(r.resumed).toBe(1)
    await new Promise((res) => setTimeout(res, 50))
    expect(getVideoGen(running.id)!.state).toBe('done')
    expect(s.posts).toBe(0)
  })

  it('a panel elso megnyitasa (meg nincs kivalasztott ertek): a modell sajat listajabol kitolt, nem hibaval ter vissza', async () => {
    const { f } = fakeOpenRouter()
    const strict = await previewVideoGen({ duration: 0, resolution: '', aspect_ratio: '9:16', audio: true }, { fetchImpl: f })
    expect(strict.ok).toBe(false) // inditasnal tovabbra sincs kitoltes
    const filled = await previewVideoGen({ duration: 0, resolution: '', aspect_ratio: '9:16', audio: true }, { fetchImpl: f }, { fillDefaults: true })
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.params).toEqual({ duration: 8, resolution: '720p', aspect_ratio: '9:16', audio: true })
    expect(filled.estimate_usd).toBeCloseTo(0.4, 4)
  })

  it('#787: a panel elso megnyitasa egy hangot nem keszito modellnel: a hang kikapcsolva, nem hiba, a becsles a hang nelkuli ar', async () => {
    const { VIDEO_MODEL_DEFAULT } = await import('../workbench-video-gen-jobs.js')
    const f: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: VIDEO_MODEL_DEFAULT, name: 'Silent', supported_resolutions: ['720p'], supported_aspect_ratios: ['9:16'], supported_durations: [8], generate_audio: false,
      pricing_skus: { duration_seconds_with_audio: '0.08', duration_seconds_without_audio: '0.05' } }] }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) })
    const filled = await previewVideoGen({ duration: 0, resolution: '', aspect_ratio: '9:16', audio: true }, { fetchImpl: f }, { fillDefaults: true })
    expect(filled.ok).toBe(true)
    if (!filled.ok) return
    expect(filled.params.audio).toBe(false)
    expect(filled.options.audio).toBe(false)
    expect(filled.estimate_usd).toBeCloseTo(0.4, 4)
    // a start with sound is still refused (no fill at start)
    const strict = await previewVideoGen(P, { fetchImpl: f })
    expect(strict).toMatchObject({ ok: false, code: 'video_audio_unsupported' })
  })

  it('az elo modelllista: valaszthato ertekek + becsles', async () => {
    const { f } = fakeOpenRouter()
    const pre = await previewVideoGen(P, { fetchImpl: f })
    expect(pre.ok && pre.estimate_usd).toBeCloseTo(0.4, 4)
    if (pre.ok) expect(pre.options.durations).toEqual([4, 6, 8])
    void ctx
  })
})

import { getDb } from '../db.js'
function getVideoGenDone(id: string): void {
  getDb().prepare(`UPDATE wb_video_gen SET state = 'done', cost_usd = est_usd WHERE id = ?`).run(id)
}
