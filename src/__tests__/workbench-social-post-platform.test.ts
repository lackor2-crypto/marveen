import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SEED_PLATFORMS } from '../workbench-canvas-platforms.js'

const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')
const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf8')

// #493: a social post asks for its platform at creation; the empty canvas gets that size.
describe('social post platform at creation', () => {
  const ids = [...js.matchAll(/\{ id: '([a-z_]+)', w: (\d+), h: (\d+) \}/g)].map((m) => ({ id: m[1], w: Number(m[2]), h: Number(m[3]) }))

  it('offers Facebook, Instagram and LinkedIn with the server platform sizes', () => {
    expect(ids.map((x) => x.id)).toEqual(['facebook_post', 'instagram_square', 'linkedin_post'])
    for (const x of ids) {
      const p = SEED_PLATFORMS.find((s) => s.id === x.id)
      expect(p, x.id).toBeTruthy()
      expect([x.w, x.h]).toEqual([p!.width, p!.height])
    }
  })

  it('shows the picker on both start screens and seeds the canvas at that size', () => {
    expect((js.match(/intakePlatformHtml\(\)/g) || []).length).toBeGreaterThanOrEqual(3)
    expect(js).toContain("kind === 'social_post' ? intakePlatformNow()")
    expect(js).toContain('width: pf.w, height: pf.h')
  })

  it('has every label in Hungarian and English', () => {
    for (const k of ['platform_label', 'platform_hint', 'platform.facebook_post', 'platform.instagram_square', 'platform.linkedin_post']) {
      expect(hu).toContain(`"workbench.intake.${k}"`)
      expect(en).toContain(`"workbench.intake.${k}"`)
    }
  })
})

// #493: the canvas shows which platform and the exact size above it.
describe('canvas size caption', () => {
  it('is rendered above the stage with a custom-size fallback', () => {
    expect(js).toContain("(noCaption ? '' : canvasSizeCaptionHtml()) + canvasStageInnerHtml(name, bare)")
    expect(js).toContain("t('workbench.canvas.size_custom')")
  })
  it('has the fallback label in Hungarian and English', () => {
    expect(hu).toContain('"workbench.canvas.size_custom"')
    expect(en).toContain('"workbench.canvas.size_custom"')
  })
})
