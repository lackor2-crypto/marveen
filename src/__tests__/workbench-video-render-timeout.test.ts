// #789 follow-up: whichever module loads first, the render must see a real render timeout. An import cycle
// (workbench-video -> workbench-capabilities -> workbench-video-render -> workbench-video) left it NaN when workbench-video
// was loaded first (as a script or a test does), and every render "timed out" at once. This file loads it first.
import { videoTool } from '../workbench-video.js'
import { RENDER_TIMEOUT_MS } from '../workbench-video-render.js'
import { describe, it, expect } from 'vitest'
import { ffprobeBeside } from '../ffprobe-path.js'
import { join } from 'node:path'

describe('#789 the render timeout is a real number whichever module loads first', () => {
  it('RENDER_TIMEOUT_MS is a finite, positive number of milliseconds', () => {
    expect(typeof videoTool).toBe('function')
    expect(Number.isFinite(RENDER_TIMEOUT_MS)).toBe(true)
    expect(RENDER_TIMEOUT_MS).toBeGreaterThan(60_000)
  })
  it('ffprobe is looked for beside ffmpeg', () => {
    expect(ffprobeBeside('/opt/v/bin/ffmpeg')).toBe(join('/opt/v/bin', 'ffprobe'))
    expect(ffprobeBeside('ffmpeg')).toBe('ffprobe')
  })
})
