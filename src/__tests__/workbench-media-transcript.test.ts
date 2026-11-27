// #986 (Boss TG 7719): what is said in an audio file or a video lands in the context file of the work item. The
// recogniser is a stand-in here (the real one is the local voice toolkit); everything around it is the real code.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { ensureWorkItemFolder, listWorkItemAssets, registerAsset } from '../workbench-assets.js'
import { ensureItemContext, readItemContext, readItemMaterials, sweepItemContexts } from '../workbench-item-context.js'
import { extractionBlockLines, isReadableKind, readNewMaterials } from '../workbench-upload-extract.js'
import { _setSpeechDeps, _transcriptsIdle, queueTranscript, type SpeechResult } from '../workbench-media-transcript.js'
import { transcriptText } from '../workbench-media-recognise.js'
import { backgroundThreads } from '../workbench-video-autosub.js'
import { setLiveTranscript } from '../workbench-media-state.js'

describe('#986 audio and video are transcribed into the context of the work item', () => {
  let depot = ''
  let saved: string | undefined
  const heard: string[] = []
  const used: string[] = []
  const recogniser = (answer: (abs: string) => SpeechResult, installed = true): void => {
    _setSpeechDeps({ installed: () => installed, recognise: async (abs) => { heard.push(abs); return answer(abs) } })
  }
  const file = (name: string, body = name, mtimeSec?: number): { rel: string; abs: string } => {
    const abs = join(depot, name)
    writeFileSync(abs, body)
    if (mtimeSec) utimesSync(abs, mtimeSec, mtimeSec)
    used.push(abs)
    return { rel: name, abs }
  }
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-speech-'))
    saved = process.env['MARVEEN_DEPOT']
    process.env['MARVEEN_DEPOT'] = depot
    heard.length = 0
  })
  afterEach(async () => {
    await _transcriptsIdle()
    for (const a of used.splice(0)) setLiveTranscript(a, null)
    _setSpeechDeps()
    if (saved === undefined) delete process.env['MARVEEN_DEPOT']; else process.env['MARVEEN_DEPOT'] = saved
    rmSync(depot, { recursive: true, force: true })
  })

  function newItem() {
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    updateProject(p.project.id, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: p.project.id, title: 'Betegség', type: 'document' })
    if (!w.ok) throw new Error('item')
    ensureWorkItemFolder(w.item)
    const item = getWorkItem(w.item.id)!
    const project = getProject(p.project.id)!
    ensureItemContext(item, project)
    return { item, project }
  }

  it('audio and video are readable kinds', () => {
    for (const n of ['a.m4a', 'b.MP3', 'c.wav', 'd.mp4', 'e.mov', 'f.ogg']) expect(isReadableKind(n), n).toBe(true)
    expect(isReadableKind('a.zip')).toBe(false)
  })

  it('a recording ADDED from elsewhere in the Life tree lands in the context file, whole', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `[${i}] Anyu ma reggel nem ismerte fel a lakást.`).join('\n') + '\nVEGE-A-FELVETELNEK'
    recogniser(() => ({ ok: true, text: long }))
    const { item, project } = newItem()
    mkdirSync(join(depot, 'Család'), { recursive: true })
    file('Család/Anyu 2019-07-10.m4a')
    registerAsset(item.id, 'Család/Anyu 2019-07-10.m4a', 'Anyu 2019-07-10.m4a', 'sha-1', 10, null)
    await readItemMaterials(item, project)
    await _transcriptsIdle()
    expect(heard).toEqual([join(depot, 'Család', 'Anyu 2019-07-10.m4a')])
    const cf = readItemContext(item)!.text
    expect(cf).toContain('### Család/Anyu 2019-07-10.m4a')
    expect(long.length).toBeGreaterThan(8_000)
    expect(cf).toContain('VEGE-A-FELVETELNEK')
    // heard once: the next pass does not start the recogniser again
    await readItemMaterials(item, project)
    await _transcriptsIdle()
    expect(heard).toHaveLength(1)
    const view = listWorkItemAssets(item.id).find((a) => a.name.endsWith('.m4a'))!
    expect(view.support).toBe('usable')
    expect(view.transcript).toEqual({ state: 'done' })
  })

  it('a material added to an older item is read at the next light pass, not an hour later', async () => {
    recogniser(() => ({ ok: true, text: 'a friss felvétel szövege' }))
    const { item, project } = newItem()
    await sweepItemContexts({ full: true })
    getDb().prepare('UPDATE work_items SET updated_at = updated_at - 86400 WHERE id = ?').run(item.id)
    mkdirSync(join(depot, 'Család'), { recursive: true })
    file('Család/uj.m4a')
    registerAsset(item.id, 'Család/uj.m4a', 'uj.m4a', 'sha-3', 10, null)
    await sweepItemContexts()
    await _transcriptsIdle()
    await vi.waitFor(() => expect(readItemContext(getWorkItem(item.id)!)!.text).toContain('a friss felvétel szövege'))
    expect(project.id).toBeTruthy()
  })

  it('the materials list says where the transcript stands; our own finished video has none', () => {
    recogniser(() => ({ ok: true, text: 'x' }))
    const { item } = newItem()
    mkdirSync(join(depot, 'Elkészített anyagok'), { recursive: true })
    file('hang.m4a')
    file('Elkészített anyagok/kesz.mp4')
    registerAsset(item.id, 'hang.m4a', 'hang.m4a', 'sha-4', 1, null)
    registerAsset(item.id, 'Elkészített anyagok/kesz.mp4', 'kesz.mp4', 'sha-5', 1, null)
    const by = (): Record<string, unknown> => Object.fromEntries(listWorkItemAssets(item.id).map((a) => [a.name, a.transcript]))
    expect(by()['hang.m4a']).toEqual({ state: 'waiting' })
    expect(by()['kesz.mp4']).toBeUndefined()
    recogniser(() => ({ ok: true, text: 'x' }), false)
    expect(by()['hang.m4a']).toEqual({ state: 'no_recogniser' })
    expect(listWorkItemAssets(item.id).find((a) => a.name === 'hang.m4a')!.support).toBe('needs_processor')
  })

  it('a document linked from elsewhere is read out too (same root cause)', async () => {
    recogniser(() => ({ ok: true, text: 'x' }))
    const { item, project } = newItem()
    mkdirSync(join(depot, 'Család'), { recursive: true })
    file('Család/lelet.txt', 'Diagnózis: 4711')
    registerAsset(item.id, 'Család/lelet.txt', 'lelet.txt', 'sha-2', 10, null)
    await readItemMaterials(item, project)
    expect(readItemContext(item)!.text).toContain('Diagnózis: 4711')
  })

  it('the call does not wait for the recogniser, and the block says the transcript is still being made', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    _setSpeechDeps({ installed: () => true, recognise: async () => { await gate; return { ok: true, text: 'kész szöveg' } } })
    const a = file('a.m4a')
    let ready = 0
    expect(await readNewMaterials('item-x', [a], 0, async () => { ready++ })).toBe(0)
    expect(extractionBlockLines('item-x', [a]).join('\n')).toMatch(/a\.m4a\n⏳/)
    release()
    await _transcriptsIdle()
    expect(ready).toBe(1)
    expect(extractionBlockLines('item-x', [a]).join('\n')).toContain('kész szöveg')
  })

  it('one recording at a time, the newest first; two items waiting for the same file both get it', async () => {
    let running = 0
    let most = 0
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    _setSpeechDeps({ installed: () => true, recognise: async (abs) => { running++; most = Math.max(most, running); order.push(abs); await gate; running--; return { ok: true, text: 't' } } })
    const first = file('first.m4a', '1', 1_000)
    const old = file('old.m4a', '2', 2_000)
    const young = file('young.m4a', '3', 3_000)
    await readNewMaterials('one', [first])
    await readNewMaterials('one', [old, young])
    await readNewMaterials('two', [young])
    release()
    await _transcriptsIdle()
    expect(most).toBe(1)
    expect(order).toEqual([first.abs, young.abs, old.abs])
    for (const id of ['one', 'two']) expect(getDb().prepare('SELECT COUNT(*) AS n FROM work_item_file_extract WHERE item_id = ? AND rel = ?').get(id, 'young.m4a')).toEqual({ n: 1 })
    // a third item takes over what was already heard, without the recogniser
    expect(await readNewMaterials('three', [young])).toBe(1)
    expect(order).toHaveLength(3)
  })

  it('without the recogniser the block says how to install it; after the install the file is read', async () => {
    recogniser(() => ({ ok: true, text: 'megjött' }), false)
    const a = file('b.mp4')
    await readNewMaterials('item-x', [a])
    expect(extractionBlockLines('item-x', [a]).join('\n')).toMatch(/Hang-eszköztár|Voice toolkit/)
    expect(heard).toHaveLength(0)
    recogniser(() => ({ ok: true, text: 'megjött' }))
    await readNewMaterials('item-x', [a])
    await _transcriptsIdle()
    expect(extractionBlockLines('item-x', [a]).join('\n')).toContain('megjött')
  })

  it('a failed try is named and not stored (tried again after a restart); "no sound" is final', async () => {
    recogniser((abs) => abs.endsWith('silent.mp4')
      ? { ok: false, final: true, reason: 'a fájlban nincs hang' }
      : { ok: false, final: false, reason: 'a beszédfelismerés nem sikerült' })
    const broken = file('broken.m4a')
    const silent = file('silent.mp4')
    await readNewMaterials('item-x', [broken, silent])
    await _transcriptsIdle()
    const block = extractionBlockLines('item-x', [broken, silent]).join('\n')
    expect(block).toContain('a beszédfelismerés nem sikerült')
    expect(block).toContain('a fájlban nincs hang')
    await readNewMaterials('item-x', [broken, silent])
    await _transcriptsIdle()
    expect(heard).toHaveLength(2) // no endless retry while this process runs
    expect(getDb().prepare('SELECT rel FROM work_item_file_extract').all()).toEqual([{ rel: 'silent.mp4' }])
    // restart: the memory of the failure is gone, the stored answer stays
    setLiveTranscript(broken.abs, null)
    await readNewMaterials('item-x', [broken, silent])
    await _transcriptsIdle()
    expect(heard).toHaveLength(3)
    expect(heard[2]).toBe(broken.abs)
  })

  it('a recogniser that throws does not stop the line', async () => {
    _setSpeechDeps({ installed: () => true, recognise: async (abs) => { if (abs.endsWith('x.m4a')) throw new Error('boom'); return { ok: true, text: 'jó' } } })
    const bad = file('x.m4a', 'x', 2_000)
    const good = file('y.m4a', 'y', 1_000)
    const results: Array<boolean> = []
    queueTranscript({ abs: bad.abs, size: 1, mtimeMs: 2 }, 'k1', async (r) => { results.push(r !== null) })
    queueTranscript({ abs: good.abs, size: 1, mtimeMs: 1 }, 'k2', async (r) => { results.push(r !== null) })
    await _transcriptsIdle()
    expect(results).toEqual([false, true])
  })

  it('a file that could not be read because a program was missing is read again once it is there', async () => {
    const a = file('n.txt', 'tartalom')
    await readNewMaterials('item-x', [a])
    getDb().prepare("UPDATE work_item_file_extract SET method = 'missing:unzip', text = '', error = 'unzip is missing'").run()
    // `unzip` exists on every machine the tests run on, so the row counts as stale
    expect(await readNewMaterials('item-x', [a])).toBe(1)
    expect(extractionBlockLines('item-x', [a]).join('\n')).toContain('tartalom')
  })

  it('a background transcript leaves half of the processor free', () => {
    expect(backgroundThreads(8)).toBe(4)
    expect(backgroundThreads(1)).toBe(1)
  })

  it('the transcript is cut into paragraphs that start with their time', () => {
    const words = [
      { word: 'Szia.', start: 0, end: 0.5 },
      { word: 'Ez', start: 41, end: 41.4 }, { word: 'később', start: 41.5, end: 42 },
      { word: 'jött.', start: 42.1, end: 42.5 },
      { word: 'Vége.', start: 3725, end: 3726 },
    ]
    const out = transcriptText(words).split('\n')
    expect(out).toHaveLength(3)
    expect(out[0]).toMatch(/^\[00:00\] Szia\./)
    expect(out[1]).toMatch(/^\[00:41\] Ez később jött\./)
    expect(out[2]).toMatch(/^\[1:02:05\] Vége\./)
  })
})
