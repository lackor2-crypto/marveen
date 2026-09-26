// #406, 19. pont -- EGYSZERU VIDEOMUNKA: lejatszas, eleje/vege levagasa,
// kepkocka mentese kepkent. Minden mentes UJ fajl; a vagas a video UJ
// verzioja, a kepkocka UJ kep munkadarab. FFmpeg nelkul emberi mondat.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, setProjectArchived } from '../projects.js'
import { createWorkItem, getWorkItem, listWorkItems } from '../workbench.js'
import { parseTime, timeLabel, _setVideoDeps, type Runner } from '../workbench-video.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

const VIDEO = Buffer.from('not really a video, but named like one')

describe('idopont beolvasasa', () => {
  it('masodperc, perc:mp, ora:perc:mp; rossz ertek null', () => {
    expect(parseTime('5')).toBe(5)
    expect(parseTime('1:05')).toBe(65)
    expect(parseTime('1:05.5')).toBe(65.5)
    expect(parseTime('1,5')).toBe(1.5)
    expect(parseTime('0:01:05')).toBe(65)
    expect(parseTime(12.25)).toBe(12.25)
    for (const bad of ['', 'abc', '-1', '1:75', '1:60:00', null, undefined, -3, NaN]) expect(parseTime(bad)).toBeNull()
    expect(timeLabel(65.9)).toBe('1-05')
    expect(timeLabel(3725)).toBe('1-02-05')
  })
})

describe('a mentes a szerveren', () => {
  let depot = ''
  let pid = ''
  let calls: { cmd: string; args: string[] }[] = []
  let behave: 'ok' | 'fail' | 'timeout' | 'empty' = 'ok'
  const dir = () => join(depot, 'Projektek', 'teszt')

  // A hamis FFmpeg a kimenetet (utolso argumentum) megirja, ahogy az igazi.
  const fakeRun: Runner = async (cmd, args) => {
    calls.push({ cmd, args })
    const out = args[args.length - 1]
    if (behave === 'ok') writeFileSync(out, 'OUT')
    if (behave === 'empty') writeFileSync(out, '')
    if (behave === 'fail') { writeFileSync(out, 'half'); return { ok: false, timeout: false, detail: 'Invalid data found when processing input' } }
    if (behave === 'timeout') return { ok: false, timeout: true, detail: 'timeout' }
    return { ok: true }
  }

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-vid-'))
    mkdirSync(dir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Kovács ház' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    if (!updateProject(pid, { folder_path: 'Projektek/teszt' }).ok) throw new Error('mappa')
    calls = []
    behave = 'ok'
    _setVideoDeps({ run: fakeRun, tool: async () => ({ state: 'ok', path: '/fake/ffmpeg', detail: null }) })
  })

  afterEach(() => {
    _setVideoDeps()
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function videoItem(name = 'klip.webm') {
    writeFileSync(join(dir(), name), VIDEO)
    const w = createWorkItem({ project_id: pid, title: 'Bemutató', type: 'video', source_path: `Projektek/teszt/${name}` })
    if (!w.ok) throw new Error('mu')
    return w.item
  }

  it('vagas: UJ mp4 a regi melle + UJ verzio; a regi fajl bajtra erintetlen; pontos vagas, felulirast tilt', async () => {
    const v = videoItem()
    const r = await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: '0:02', end: '0:07.5', base_version: v.current_version_id })
    expect(r.status).toBe(201)
    expect(r.body.name).toBe('klip.mp4')
    expect(r.body.version.version_no).toBe(2)
    expect(getWorkItem(v.id)?.source_path).toBe('Projektek/teszt/klip.mp4')
    expect(readdirSync(dir()).sort()).toEqual(['klip.mp4', 'klip.webm'])
    expect(readFileSync(join(dir(), 'klip.webm')).equals(VIDEO)).toBe(true)
    const a = calls[0].args
    expect(calls[0].cmd).toBe('/fake/ffmpeg')
    expect(a).toContain('-n')
    expect(a[a.indexOf('-ss') + 1]).toBe('2.000')
    expect(a[a.indexOf('-t') + 1]).toBe('5.500')
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    // A kovetkezo vagas a MOSTANI (mp4) verziobol, uj nevvel.
    const again = await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: 0, end: 1, base_version: r.body.version.id })
    expect(again.body.name).toBe('klip (2).mp4')
  })

  it('kepkocka: UJ png + UJ kep munkadarab ugyanabban a projektben; a video verzioja nem valtozik', async () => {
    const v = videoItem()
    const r = await callWorkbench(`/api/workbench/items/${v.id}/video-frame`, 'POST', { at: 12.4, base_version: v.current_version_id })
    expect(r.status).toBe(201)
    expect(r.body.name).toBe('klip 0-12.png')
    expect(r.body.new_item).toMatchObject({ type: 'image', project_id: pid, source_path: 'Projektek/teszt/klip 0-12.png' })
    expect(r.body.new_item.title).toBe('Bemutató -- képkocka 0:12')
    expect(getWorkItem(v.id)?.current_version_id).toBe(v.current_version_id)
    expect(listWorkItems(pid)).toHaveLength(2)
    const a = calls[0].args
    expect(a).toContain('-frames:v')
    const en = await callWorkbench(`/api/workbench/items/${v.id}/video-frame?lang=en`, 'POST', { at: 1, base_version: v.current_version_id })
    expect(en.body.new_item.title).toBe('Bemutató -- frame 0:01')
  })

  it('nincs FFmpeg: 503 emberi mondattal, fajl es verzio nem keletkezik; a statusz-vegpont is mondatot ad', async () => {
    _setVideoDeps({ run: fakeRun, tool: async () => ({ state: 'not_installed', path: null, detail: null }) })
    const v = videoItem()
    const r = await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: 0, end: 3, base_version: v.current_version_id })
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('video_no_ffmpeg')
    expect(r.body.message).toMatch(/FFmpeg/)
    expect(r.body.message).toMatch(/lejátszás enélkül is működik/)
    expect(calls).toHaveLength(0)
    expect(readdirSync(dir())).toEqual(['klip.webm'])
    const st = await callWorkbench('/api/workbench/video-status?lang=en', 'GET')
    expect(st.body.video.state).toBe('not_installed')
    expect(st.body.video.message).toMatch(/Playback works without it/)
    _setVideoDeps({ run: fakeRun, tool: async () => ({ state: 'check_failed', path: '/x/ffmpeg', detail: 'EACCES' }) })
    const cf = await callWorkbench(`/api/workbench/items/${v.id}/video-frame`, 'POST', { at: 1, base_version: v.current_version_id })
    expect(cf.status).toBe(503)
    expect(cf.body.error).toBe('video_ffmpeg_check_failed')
    expect(cf.body.detail).toBe('EACCES')
  })

  it('hibak emberi mondattal: rossz ido, elavult verzio, nem video, archivalt; bukott futas utan nincs felkesz fajl', async () => {
    const v = videoItem()
    const base = v.current_version_id
    const bad = await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: '0:05', end: '0:03', base_version: base })
    expect(bad.status).toBe(400)
    expect(bad.body.message).toMatch(/0:05/)
    expect((await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: 0, end: 2, base_version: 'regi' })).status).toBe(409)
    writeFileSync(join(dir(), 'leiras.txt'), 'x')
    const txt = createWorkItem({ project_id: pid, title: 'Leírás', type: 'note', source_path: 'Projektek/teszt/leiras.txt' })
    if (!txt.ok) throw new Error('txt')
    const nv = await callWorkbench(`/api/workbench/items/${txt.item.id}/video-frame`, 'POST', { at: 0, base_version: txt.item.current_version_id })
    expect(nv.body.error).toBe('video_not_video')

    behave = 'fail'
    const f = await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: 0, end: 2, base_version: base })
    expect(f.status).toBe(500)
    expect(f.body.message).toMatch(/nem készült új verzió/)
    expect(f.body.detail).toMatch(/Invalid data/)
    expect(readdirSync(dir()).sort()).toEqual(['klip.webm', 'leiras.txt'])
    behave = 'timeout'
    expect((await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: 0, end: 2, base_version: base })).body.error).toBe('video_timeout')
    behave = 'empty'
    expect((await callWorkbench(`/api/workbench/items/${v.id}/video-frame`, 'POST', { at: 999, base_version: base })).body.error).toBe('video_no_output')
    expect(readdirSync(dir()).sort()).toEqual(['klip.webm', 'leiras.txt'])
    expect(getWorkItem(v.id)?.current_version_id).toBe(base)

    setProjectArchived(pid, true)
    expect((await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: 0, end: 2, base_version: base })).status).toBe(409)
  })

  it('egy videon egyszerre egy vagas: a masodik kattintas 409', async () => {
    const v = videoItem()
    let release: () => void = () => {}
    _setVideoDeps({
      run: (cmd, args) => new Promise((res) => { release = () => { writeFileSync(args[args.length - 1], 'OUT'); res({ ok: true }) } }),
      tool: async () => ({ state: 'ok', path: '/fake/ffmpeg', detail: null }),
    })
    const first = callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: 0, end: 2, base_version: v.current_version_id })
    await vi.waitFor(() => expect(typeof release).toBe('function'))
    await new Promise((r) => setTimeout(r, 20))
    const second = await callWorkbench(`/api/workbench/items/${v.id}/video-trim`, 'POST', { start: 0, end: 2, base_version: v.current_version_id })
    expect(second.status).toBe(409)
    expect(second.body.error).toBe('video_busy')
    release()
    expect((await first).status).toBe(201)
  })
})

const HAS_FFMPEG = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf-8' }).stdout?.includes('libx264') ?? false

describe.skipIf(!HAS_FFMPEG)('igazi FFmpeg (ahol van)', () => {
  let depot = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-vidreal-'))
    mkdirSync(join(depot, 'P'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    _setVideoDeps({ tool: async () => ({ state: 'ok', path: 'ffmpeg', detail: null }) })
  })
  afterEach(() => {
    _setVideoDeps()
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('3 mp-es probavideo: vagas 1-2 mp kozott es egy kepkocka valodi fajlt ad', async () => {
    const src = join(depot, 'P', 'proba.mp4')
    const mk = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=10', '-pix_fmt', 'yuv420p', src])
    expect(mk.status).toBe(0)
    const p = createProject({ name: 'Proba' })
    if (!p.ok) throw new Error('p')
    updateProject(p.project.id, { folder_path: 'P' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Próba', type: 'video', source_path: 'P/proba.mp4' })
    if (!w.ok) throw new Error('w')
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/video-trim`, 'POST', { start: 1, end: 2, base_version: w.item.current_version_id })
    expect(r.status).toBe(201)
    const probe = spawnSync('ffmpeg', ['-hide_banner', '-i', join(depot, 'P', r.body.name)], { encoding: 'utf-8' })
    const m = /Duration: 00:00:(\d+\.\d+)/.exec(probe.stderr)
    expect(Number(m?.[1])).toBeGreaterThan(0.8)
    expect(Number(m?.[1])).toBeLessThan(1.3)
    const f = await callWorkbench(`/api/workbench/items/${w.item.id}/video-frame`, 'POST', { at: 0.5, base_version: r.body.version.id })
    expect(f.body).toMatchObject({ ok: true })
    expect(f.status).toBe(201)
    expect(readFileSync(join(depot, 'P', f.body.name)).subarray(1, 4).toString('ascii')).toBe('PNG')
  }, 60_000)
})

describe('a felulet', () => {
  const VID_PREVIEW = { available: true, kind: 'video', url: '/api/life/file?rel=x', name: 'klip.webm', version_id: 'v1', versions: [] }
  const DETAIL = { item: { id: 'w1', project_id: 'p1', title: 'Bemutató', type: 'video', status: 'draft', current_version_id: 'v1' }, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project: { id: 'p1', name: 'Kovács ház', archived: false } }

  function open(video: Record<string, unknown>, post?: { status: number; body: unknown }) {
    const h = workbenchHarness()
    h.respond((url, init) => {
      if (url.includes('/api/workbench/video-status')) return { status: 200, body: { video } }
      if (url.includes('/video-') && init?.method === 'POST') return post || { status: 201, body: {} }
      if (url.includes('/preview')) return { status: 200, body: VID_PREVIEW }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: DETAIL }
      return { status: 200, body: itemsBody([DETAIL.item], DETAIL.project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács ház')
    return h
  }

  async function select(h: ReturnType<typeof open>) {
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('id="wbVideo"'))
  }

  it('FFmpeg nelkul: a lejatszo megvan, a vagas helyett egy mondat es a Kepessegek gomb', async () => {
    const h = open({ state: 'not_installed', message: 'A vágáshoz FFmpeg kell.' })
    await select(h)
    await vi.waitFor(() => expect(h.html()).toContain('A vágáshoz FFmpeg kell.'))
    expect(h.html()).toContain('id="wbVideo"')
    expect(h.html()).toContain('data-wb-act="caps-open"')
    expect(h.html()).not.toContain('data-wb-act="vid-trim"')
    expect(h.html()).not.toContain('video_no_ffmpeg')
  })

  it('FFmpeg-gel: jelolo gombok, a lejatszo helye a mezobe kerul; mentes POST a jelenlegi verzioval', async () => {
    const h = open({ state: 'ok', message: null }, { status: 201, body: { ok: true, name: 'klip.mp4', version: { version_no: 2 }, versions: [], item: DETAIL.item } })
    await select(h)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="vid-trim"'))
    expect(untranslatedHungarian(h.html(), ['Kovács ház', 'Bemutató'])).toBe('')
    h.inputs['wbVideo'] = { value: '', focus() {}, currentTime: 65.4 } as any
    h.inputs['wbVidStart'] = { value: '', focus() {} }
    h.inputs['wbVidEnd'] = { value: '1:30', focus() {} }
    h.click({ 'data-wb-act': 'vid-mark', 'data-wb-which': 'start' })
    expect(h.inputs['wbVidStart'].value).toBe('1:05.4')
    h.click({ 'data-wb-act': 'vid-trim' })
    await vi.waitFor(() => expect(h.toasts.some((m) => m.includes('workbench.vid.trim_saved'))).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/video-trim'))
    expect(JSON.parse(call?.init?.body as string)).toEqual({ base_version: 'v1', start: '1:05.4', end: '1:30' })
  })

  it('hiba a szervertol: a mondat es a reszlet latszik, a gomb ujra kattinthato', async () => {
    const h = open({ state: 'ok', message: null }, { status: 500, body: { error: 'video_failed', message: 'Az FFmpeg nem tudta.', detail: 'Invalid data' } })
    await select(h)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="vid-frame"'))
    h.inputs['wbVideo'] = { value: '', focus() {}, currentTime: 3 } as any
    h.click({ 'data-wb-act': 'vid-frame' })
    await vi.waitFor(() => expect(h.html()).toContain('Az FFmpeg nem tudta.'))
    expect(h.html()).toContain('Invalid data')
    expect(h.html()).not.toContain('data-wb-act="vid-frame" disabled')
    expect(JSON.parse(h.fetchCalls.find((c) => c.url.includes('/video-frame'))?.init?.body as string)).toEqual({ base_version: 'v1', at: 3 })
  })
})
