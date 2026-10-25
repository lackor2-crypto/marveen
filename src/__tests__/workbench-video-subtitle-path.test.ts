// #790: the subtitle file's full path went into ffmpeg's filter text (ass=filename='<path>'). On Windows the drive's ':'
// and the '\' are special there (an apostrophe in a user name too), so the render broke. Now ffmpeg runs in the subtitle
// file's folder and the filter gets only its bare name.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { _setVideoDeps } from '../workbench-video.js'
import { _setRenderDeps, renderTimeline, ASS_NAME } from '../workbench-video-render.js'
import { applyTimelineOps, emptyTimeline } from '../workbench-video-timeline.js'

const HAVE_ASS = spawnSync('ffmpeg', ['-hide_banner', '-filters']).stdout?.toString().includes(' ass ') ?? false

describe('#790 subtitles reach ffmpeg by a bare name', () => {
  let dir = ''
  let project: ProjectRow
  let itemId = ''
  const oldTmp = process.env['TMPDIR']
  beforeEach(() => {
    initDatabase(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'wb-subpath-'))
    process.env['MARVEEN_DEPOT'] = dir
    const p = createProject({ name: 'Klip' })
    if (!p.ok) throw new Error('projekt')
    updateProject(p.project.id, { folder_path: 'Projektek/Klip' })
    mkdirSync(join(dir, 'Projektek', 'Klip'), { recursive: true })
    project = getProject(p.project.id) as ProjectRow
    const w = createWorkItem({ project_id: p.project.id, title: 'Felirat', type: 'video' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
  })
  afterEach(() => {
    _setVideoDeps(); _setRenderDeps()
    if (oldTmp === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = oldTmp
    rmSync(dir, { recursive: true, force: true }); delete process.env['MARVEEN_DEPOT']
  })

  const docWithSubs = () => {
    const r = applyTimelineOps(emptyTimeline(), [
      { op: 'addClip', src: 'Projektek/Klip/a.mp4', start: 0, end: 2 },
      { op: 'addSubtitle', text: 'Helló világ', start: 0, end: 1.5 },
    ])
    if (!r.ok) throw new Error(r.detail)
    return r.doc
  }

  it('the filter carries only the bare name, and ffmpeg runs in the folder that holds the file', async () => {
    writeFileSync(join(dir, 'Projektek', 'Klip', 'a.mp4'), 'x')
    let seen: { args: string[]; cwd?: string; fileThere: boolean } | null = null
    _setVideoDeps({
      tool: async () => ({ state: 'ok', path: '/fake/ffmpeg', detail: null }),
      run: async (_cmd, args, _t, _d, opts) => {
        seen = { args, cwd: opts?.cwd, fileThere: !!opts?.cwd && existsSync(join(opts.cwd, ASS_NAME)) }
        writeFileSync(args[args.length - 1] as string, 'MP4')
        return { ok: true }
      },
    })
    _setRenderDeps({ probe: async () => ({ audio: true, duration: 5 }), filters: async () => true })
    const r = await renderTimeline(project, itemId, 'Felirat', docWithSubs())
    expect(r.ok).toBe(true)
    const graph = seen!.args[seen!.args.indexOf('-filter_complex') + 1] as string
    expect(graph).toContain(`ass=filename='${ASS_NAME}'`)
    expect(graph).not.toContain(tmpdir())
    expect(seen!.fileThere).toBe(true)
  })

  it.skipIf(!HAVE_ASS)('a real render with subtitles from a temp folder whose path has an apostrophe and a colon (what C:\\ and O\'Brien do on Windows)', async () => {
    const weird = join(dir, "O'Brien: temp")
    mkdirSync(weird, { recursive: true })
    process.env['TMPDIR'] = weird
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'Projektek', 'Klip', 'a.mp4')], { stdio: 'pipe' })
    const r = await renderTimeline(project, itemId, 'Felirat', docWithSubs())
    expect(r.ok ? 'ok' : `${r.code} ${'detail' in r ? r.detail : ''}`).toBe('ok')
    // the temp folder was used (and cleaned up) and the video is there
    expect(readdirSync(weird)).toEqual([])
    if (r.ok) expect(r.file.bytes).toBeGreaterThan(1000)
  }, 120_000)
})
