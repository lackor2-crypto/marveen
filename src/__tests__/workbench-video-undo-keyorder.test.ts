// #669: an undo step compares whole documents as JSON text, so an edit that leaves the keys of a clip in another order
// than the canonical (re-parsed) document must still be undoable.
import { describe, it, expect } from 'vitest'
import { applyTimelineOps, emptyTimeline, parseTimeline, timelineKind } from '../workbench-video-timeline.js'

const base = () => {
  const r = applyTimelineOps(emptyTimeline(), [{ op: 'addClip', src: 'P/a.mp4', start: 0, end: 10 }, { op: 'addClip', src: 'P/b.mp4', start: 0, end: 10 }])
  if (!r.ok) throw new Error('setup')
  return r.doc
}
const OPS: Array<[string, Record<string, unknown>]> = [
  ['speed', { op: 'setSpeed', id: 'c1', speed: 2 }],
  ['look', { op: 'setClipLook', id: 'c1', look: 'bw' }],
  ['stab', { op: 'setStabilize', id: 'c1', on: true }],
  ['frame', { op: 'setClipFrame', id: 'c1', zoom: 2, panX: 0.5 }],
  ['orient', { op: 'setClipOrient', id: 'c1', rotate: 90, flip: 'h' }],
  ['fade', { op: 'setClipFade', id: 'c1', in: 1, out: 2 }],
  ['transition', { op: 'setTransition', id: 'c1', type: 'fade', duration: 0.5 }],
  ['volume', { op: 'setClipVolume', id: 'c1', volume: 0.5 }],
]

describe('video undo is not fooled by key order', () => {
  for (const [name, op] of OPS) {
    it(`${name}: the document after the op equals its re-parsed copy as text`, () => {
      const r = applyTimelineOps(base(), [op])
      if (!r.ok) throw new Error('op ' + name + ' ' + JSON.stringify(r))
      const reparsed = parseTimeline(JSON.parse(JSON.stringify(r.doc)))
      if (!reparsed.ok) throw new Error('reparse')
      expect(JSON.stringify(reparsed.doc)).toBe(JSON.stringify(r.doc))
    })
  }
  it('two edits in a row (fade, then turn) still compare equal to the re-parsed document', () => {
    const r = applyTimelineOps(base(), [{ op: 'setClipFade', id: 'c1', in: 1, out: 2 }, { op: 'setClipOrient', id: 'c1', rotate: 90, flip: 'h' }])
    if (!r.ok) throw new Error('op')
    const reparsed = parseTimeline(JSON.parse(JSON.stringify(r.doc)))
    if (!reparsed.ok) throw new Error('reparse')
    // the texts differ in key order, but the undo comparison must call them the same document
    expect(timelineKind.diff(reparsed.doc, r.doc)).toBeNull()
  })

  it('undo and redo of a fade+orient edit apply on the re-parsed document', () => {
    const b = base()
    const r = applyTimelineOps(b, [{ op: 'setClipOrient', id: 'c1', rotate: 90 }, { op: 'setClipFade', id: 'c1', in: 1 }])
    if (!r.ok) throw new Error('op')
    const patch = timelineKind.diff(b, r.doc)!
    const stored = parseTimeline(JSON.parse(JSON.stringify(r.doc)))
    if (!stored.ok) throw new Error('reparse')
    const u = timelineKind.apply(stored.doc, patch, 'undo')
    expect(u.ok).toBe(true)
    const redo = timelineKind.apply(b, patch, 'redo')
    expect(redo.ok).toBe(true)
  })
})
