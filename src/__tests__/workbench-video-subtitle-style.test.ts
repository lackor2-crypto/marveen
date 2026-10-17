// #669: subtitle look / animation / position: the model, the ASS file, and a real libass burn-in.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyTimeline, applyTimelineOps, parseTimeline, type TimelineDoc } from '../workbench-video-timeline.js'
import { buildAss } from '../workbench-video-render.js'

function ok(doc: TimelineDoc, ops: unknown[]): TimelineDoc {
  const r = applyTimelineOps(doc, ops)
  if (!r.ok) throw new Error(`${r.code}: ${r.detail}`)
  return r.doc
}
const withClip = (): TimelineDoc => ok(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 5 }])

describe('subtitle style: the model', () => {
  it('a plain subtitle stores no style; a styled one stores only what differs from the default', () => {
    let d = ok(withClip(), [{ op: 'addSubtitle', text: 'a', start: 0, end: 1 }])
    expect(d.subtitles[0]).toEqual({ id: 's1', text: 'a', start: 0, end: 1 })
    d = ok(d, [{ op: 'addSubtitle', text: 'b', start: 1, end: 2, look: 'yellow', anim: 'fade', pos: 'bottom' }])
    expect(d.subtitles[1]).toEqual({ id: 's2', text: 'b', start: 1, end: 2, look: 'yellow', anim: 'fade' })
  })

  it('update replaces a given field, "" or the default clears it, an absent one stays', () => {
    let d = ok(withClip(), [{ op: 'addSubtitle', text: 'a', start: 0, end: 1, look: 'box', anim: 'pop', pos: 'top' }])
    d = ok(d, [{ op: 'updateSubtitle', id: 's1', look: 'bold' }])
    expect(d.subtitles[0]).toMatchObject({ look: 'bold', anim: 'pop', pos: 'top' })
    d = ok(d, [{ op: 'updateSubtitle', id: 's1', look: 'classic', anim: '' }])
    expect(d.subtitles[0].look).toBeUndefined()
    expect(d.subtitles[0].anim).toBeUndefined()
    expect(d.subtitles[0].pos).toBe('top')
  })

  it('a name outside the lists is refused and changes nothing', () => {
    const d = ok(withClip(), [{ op: 'addSubtitle', text: 'a', start: 0, end: 1 }])
    for (const bad of [{ look: 'neon' }, { anim: 'spin' }, { pos: 'left' }, { look: 3 }]) {
      const r = applyTimelineOps(d, [{ op: 'addSubtitle', text: 'x', start: 1, end: 2, ...bad }])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('timeline_bad_style')
      const u = applyTimelineOps(d, [{ op: 'updateSubtitle', id: 's1', ...bad }])
      expect(u.ok).toBe(false)
    }
  })

  it('the style survives a save and load', () => {
    const d = ok(withClip(), [{ op: 'addSubtitle', text: 'a', start: 0, end: 1, look: 'title', pos: 'middle' }])
    const back = parseTimeline(JSON.parse(JSON.stringify(d)))
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.doc.subtitles[0]).toMatchObject({ look: 'title', pos: 'middle' })
  })
})

describe('subtitle style: the ASS file', () => {
  it('a plain subtitle line is unchanged (no override block)', () => {
    const ass = buildAss(ok(withClip(), [{ op: 'addSubtitle', text: 'Hi', start: 0.5, end: 2 }]))
    expect(ass).toContain('Dialogue: 0,0:00:00.50,0:00:02.00,Default,,0,0,0,,Hi')
  })

  it('every look has a style, the line names it, position and animation become override tags', () => {
    const d = ok(withClip(), [
      { op: 'addSubtitle', text: 'A', start: 0, end: 1, look: 'yellow', pos: 'top', anim: 'fade' },
      { op: 'addSubtitle', text: 'B', start: 1, end: 2, look: 'box', pos: 'middle', anim: 'pop' },
      { op: 'addSubtitle', text: 'C', start: 2, end: 3, anim: 'slideup' },
    ])
    const ass = buildAss(d)
    for (const n of ['Default', 'bold', 'yellow', 'box', 'title']) expect(ass).toContain(`Style: ${n},`)
    expect(ass).toContain(',yellow,,0,0,0,,{\\an8\\fad(250,250)}A')
    expect(ass).toContain(',box,,0,0,0,,{\\an5\\fscx70\\fscy70\\t(0,220,\\fscx100\\fscy100)}B')
    expect(ass).toMatch(/,Default,,0,0,0,,\{\\move\(960,\d+,960,\d+,0,250\)\}C/)
    expect(ass).toMatch(/Style: yellow,[^,]+,\d+,&H0000FFFF,/)
    expect(ass).toMatch(/Style: box,[^\n]*,3,\d+,0,2,/)
  })
})

describe('subtitle style: the panel sends the style (source contract, both save paths)', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
  const body = (name: string) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n  }\n', i)) }
  it('adding and saving a subtitle both put look/anim/pos into the op; the clip add does not', () => {
    expect(body('vtAddSubtitle')).toContain('vtSubStyleOp(')
    expect(body('vtSaveSubtitle')).toContain('vtSubStyleOp(')
    expect(body('vtAddClip')).not.toContain('vtSubStyleOp')
  })
})

const HAVE = spawnSync('ffmpeg', ['-version']).status === 0 && /\bass\b/.test(String(spawnSync('ffmpeg', ['-filters']).stdout))

describe.skipIf(!HAVE)('subtitle style: libass accepts the file (real ffmpeg)', () => {
  it('burns every look, position and animation into a picture without an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbsubstyle-'))
    try {
      let d = withClip()
      const ops: unknown[] = []
      let t = 0
      for (const look of ['classic', 'bold', 'yellow', 'box', 'title']) for (const anim of ['none', 'fade', 'pop', 'slideup']) {
        ops.push({ op: 'addSubtitle', text: `${look} ${anim}`, start: t, end: t + 0.2, look, anim, pos: ['bottom', 'middle', 'top'][t % 3 | 0] })
        t = Math.round((t + 0.1) * 10) / 10
      }
      d = ok(d, ops.slice(0, 100))
      const ass = join(dir, 's.ass'), out = join(dir, 'o.mp4')
      writeFileSync(ass, buildAss(d))
      const r = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=1920x1080:d=3:r=10', '-vf', `ass=filename='${ass}'`, '-pix_fmt', 'yuv420p', out], { encoding: 'utf8' })
      expect(r.status, r.stderr?.slice(-400)).toBe(0)
      expect(existsSync(out) && statSync(out).size > 1000).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
