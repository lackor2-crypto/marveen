// AI-kepszerkesztes (#441, v4 spec K-2.11 .. K-2.13): a Gemini-hivas, hamis
// szerverrel -- penz es halozat nelkul.
import { describe, it, expect } from 'vitest'
import { editImageWithAI, estimateImageEdit, actualImageCost, IMAGE_EDIT_MODEL_DEFAULT } from '../workbench-image-ai.js'
import { parseCanvas, renderCanvasSvg, canvasAiShare } from '../workbench-graphic.js'

const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const cfg = { key: 'k-123', model: IMAGE_EDIT_MODEL_DEFAULT }

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: { headers: Record<string, string>; body: string } } = {}) {
  return async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    seen.url = url
    seen.init = init
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) }
  }
}

describe('Gemini kepszerkesztes', () => {
  it('a kep es az utasitas felmegy, a kulcs fejlecben (nem az URL-ben), az uj kep visszajon, a koltseg a token-szambol', async () => {
    const seen: { url?: string; init?: { headers: Record<string, string>; body: string } } = {}
    const out = Buffer.from('new-image')
    const r = await editImageWithAI({
      bytes: PNG, mime: 'image/png', instruction: 'legyen piros az autó', cfg,
      fetchImpl: fakeFetch(200, {
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: out.toString('base64') } }] } }],
        usageMetadata: { promptTokenCount: 1300, candidatesTokenCount: 1120 },
      }, seen),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.bytes.toString()).toBe('new-image')
    expect(seen.url).toContain(`/models/${IMAGE_EDIT_MODEL_DEFAULT}:generateContent`)
    expect(seen.url).not.toContain('k-123')
    expect(seen.init!.headers['x-goog-api-key']).toBe('k-123')
    const sent = JSON.parse(seen.init!.body)
    expect(sent.contents[0].parts[0].inline_data.data).toBe(PNG.toString('base64'))
    expect(sent.contents[0].parts[1].text).toContain('legyen piros az autó')
    expect(r.cost_usd).toBeCloseTo(0.0007 + 0.0672, 3)
  })

  it('a szolgaltato hibaja a sajat szovegevel jon vissza, kulon koddal', async () => {
    const bad = await editImageWithAI({ bytes: PNG, mime: 'image/png', instruction: 'x', cfg, fetchImpl: fakeFetch(403, { error: { status: 'PERMISSION_DENIED', message: 'API key not valid' } }) })
    expect(bad.ok).toBe(false)
    if (!bad.ok) { expect(bad.code).toBe('ai_edit_bad_key'); expect(bad.detail).toContain('API key not valid') }
    const quota = await editImageWithAI({ bytes: PNG, mime: 'image/png', instruction: 'x', cfg, fetchImpl: fakeFetch(429, { error: { message: 'quota' } }) })
    expect(!quota.ok && quota.code).toBe('ai_edit_quota')
    const none = await editImageWithAI({ bytes: PNG, mime: 'image/png', instruction: 'x', cfg, fetchImpl: fakeFetch(200, { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }) })
    expect(!none.ok && none.code).toBe('ai_edit_no_image')
    if (!none.ok) expect(none.detail).toContain('SAFETY')
  })

  it('ures utasitas es nem tamogatott kep: el sem indul', async () => {
    let called = false
    const f = async () => { called = true; return { ok: true, status: 200, json: async () => ({}), text: async () => '' } }
    expect((await editImageWithAI({ bytes: PNG, mime: 'image/png', instruction: '  ', cfg, fetchImpl: f })).ok).toBe(false)
    expect((await editImageWithAI({ bytes: PNG, mime: 'image/gif', instruction: 'x', cfg, fetchImpl: f })).ok).toBe(false)
    expect(called).toBe(false)
  })

  it('becsles: ismert modellnel szam a hivatalos arbol, ismeretlennel null (nem talalunk ki)', () => {
    const e = estimateImageEdit(IMAGE_EDIT_MODEL_DEFAULT, 'legyen piros')
    expect(e.usd).toBeGreaterThan(0.067)
    expect(e.usd).toBeLessThan(0.07)
    expect(e.source.url).toContain('ai.google.dev')
    expect(estimateImageEdit('valami-modell').usd).toBeNull()
    expect(actualImageCost('valami-modell', { promptTokenCount: 1 })).toBeNull()
  })
})

describe('AI-jeloles (K-2.13)', () => {
  it('az SVG csak kerésre kap IPTC jelolest; nagy AI-resznel "trainedAlgorithmicMedia"', () => {
    const p = parseCanvas({
      width: 100, height: 100,
      objects: [{ id: 'kep', type: 'image', src: 'a.png', x: 0, y: 0, width: 100, height: 100, ai: { model: 'm', at: 1, prompt: 'p' } }],
    })
    if (!p.ok) throw new Error(p.detail)
    expect(canvasAiShare(p.doc)).toBe(1)
    expect(renderCanvasSvg(p.doc)).not.toContain('digitalsourcetype')
    expect(renderCanvasSvg(p.doc, { aiLabel: true })).toContain('digitalsourcetype/trainedAlgorithmicMedia')
    const small = parseCanvas({ width: 100, height: 100, objects: [{ id: 'kep', type: 'image', src: 'a.png', x: 0, y: 0, width: 20, height: 20, ai: { model: 'm' } }] })
    if (!small.ok) throw new Error(small.detail)
    expect(renderCanvasSvg(small.doc, { aiLabel: true })).toContain('compositeWithTrainedAlgorithmicMedia')
  })
})
