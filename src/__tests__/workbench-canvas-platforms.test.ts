// Platformmeretek es valtozat mas platformra (#441, v4 spec K-2.8 .. K-2.10).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCanvasPlatforms, canvasPlatform, platformForSize, SEED_PLATFORMS, checkPlatform } from '../workbench-canvas-platforms.js'
import { applyCanvasOps, parseCanvas, type CanvasDoc } from '../workbench-graphic.js'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-platforms-'))
  process.env['MARVEEN_CANVAS_PLATFORMS_FILE'] = join(dir, 'p.json')
})
afterEach(() => {
  delete process.env['MARVEEN_CANVAS_PLATFORMS_FILE']
  rmSync(dir, { recursive: true, force: true })
})

describe('platformlista (K-2.8)', () => {
  it('a spec tablazata benne van, forrassal es ellenorzesi nappal', () => {
    const ids = listCanvasPlatforms().platforms.map((p) => `${p.id}:${p.width}x${p.height}`)
    for (const want of ['facebook_post:1200x630', 'instagram_square:1080x1080', 'instagram_portrait:1080x1350', 'story_reel:1080x1920', 'linkedin_post:1200x627']) {
      expect(ids).toContain(want)
    }
    for (const p of SEED_PLATFORMS) {
      expect(checkPlatform(p).ok).toBe(true)
      expect(p.sources.length).toBeGreaterThan(0)
    }
  })

  it('a Story/Reel biztonsagi zonaja a Meta hivatalos szama: 14% fent, 35% lent, 6% oldalt', () => {
    expect(canvasPlatform('story_reel')!.safe).toEqual({ top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 })
    // Azonos meretnel a zonaval rendelkezo nyer.
    expect(platformForSize(1080, 1920)!.safe).not.toBeNull()
  })

  it('a fajl felulir es kiegeszit; a hibas fajl nem tunteti el a beepitett listat, de szol', () => {
    writeFileSync(process.env['MARVEEN_CANVAS_PLATFORMS_FILE']!, JSON.stringify({ platforms: [
      { id: 'linkedin_post', label: { hu: 'LinkedIn', en: 'LinkedIn' }, width: 1200, height: 628, safe: null, sources: [{ title: 'x', url: 'https://example.com' }], checked: '2026-09-30' },
      { id: 'pinterest', label: { hu: 'Pinterest', en: 'Pinterest' }, width: 1000, height: 1500, safe: null, sources: [{ title: 'x', url: 'https://example.com' }], checked: '2020-01-01' },
    ] }))
    const l = listCanvasPlatforms(new Date('2026-09-30T00:00:00Z'))
    expect(l.file_error).toBeNull()
    expect(canvasPlatform('linkedin_post')!.height).toBe(628)
    expect(l.platforms.find((p) => p.id === 'pinterest')!.stale).toBe(true)
    writeFileSync(process.env['MARVEEN_CANVAS_PLATFORMS_FILE']!, JSON.stringify({ platforms: [{ id: 'x' }] }))
    const bad = listCanvasPlatforms()
    expect(bad.file_error).toContain('id')
    expect(bad.platforms.length).toBe(SEED_PLATFORMS.length)
  })
})

describe('atrendezes uj meretre (K-2.9)', () => {
  function poster(): CanvasDoc {
    const p = parseCanvas({
      width: 1080, height: 1080,
      objects: [
        { id: 'hatter', type: 'rect', x: 0, y: 0, width: 1080, height: 1080, fill: '#ffeecc' },
        { id: 'cim', type: 'text', text: 'Nyári akció', x: 90, y: 20, width: 900, height: 120, fontSize: 80 },
        { id: 'logo', type: 'ellipse', x: 900, y: 900, width: 120, height: 120 },
      ],
    })
    if (!p.ok) throw new Error(p.detail)
    return p.doc
  }
  const ctx = { platform: canvasPlatform }

  it('a hatter kitolti az uj vasznat, a tobbi arany-helyes, torzitas nelkul', () => {
    const r = applyCanvasOps(poster(), [{ op: 'resize', platform: 'instagram_portrait' }], ctx)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const d = r.doc
    expect([d.width, d.height]).toEqual([1080, 1350])
    const bg = d.objects.find((o) => o.id === 'hatter')!
    expect([bg.x, bg.y, bg.width, bg.height]).toEqual([0, 0, 1080, 1350])
    const logo = d.objects.find((o) => o.id === 'logo')!
    expect(logo.width).toBe(logo.height)
  })

  it('Story meretben a szoveg a biztonsagi zonaba kerul', () => {
    const r = applyCanvasOps(poster(), [{ op: 'resize', platform: 'story_reel' }], ctx)
    if (!r.ok) throw new Error(r.detail)
    const cim = r.doc.objects.find((o) => o.id === 'cim')!
    expect(cim.y).toBeGreaterThanOrEqual(Math.floor(1920 * 0.14))
    const logo = r.doc.objects.find((o) => o.id === 'logo')!
    expect(logo.y + logo.height).toBeLessThanOrEqual(Math.ceil(1920 * 0.65))
    expect(logo.x + logo.width).toBeLessThanOrEqual(Math.ceil(1080 * 0.94))
  })

  it('ismeretlen platformnal hiba, meret nelkul hiba', () => {
    const a = applyCanvasOps(poster(), [{ op: 'resize', platform: 'myspace' }], ctx)
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.code).toBe('canvas_unknown_platform')
    expect(applyCanvasOps(poster(), [{ op: 'resize' }], ctx).ok).toBe(false)
  })
})
