/**
 * AI-KEPSZERKESZTES a rajzvaszon egy kepelemen (kanban #441, v4 spec 8.4,
 * K-2.11 .. K-2.13).
 *
 * A szakmai minta (Canva Magic Edit, Adobe Firefly, Google Gemini): egy kep +
 * egy mondat ("legyen piros az auto") -> UJ kep. Itt a Google Gemini
 * kepmodellje fut (REST `generateContent`, a kep `inline_data`-kent megy fel).
 *
 * Harom szabaly, amit ez a fajl oriz:
 *
 *   1. A REGI SOSE VESZ EL. Az eredmeny UJ fajl a regi mellett (a fajl-iro
 *      sosem ir felul); a vaszon elem csak az uj fajlra mutat, es ez egy
 *      visszavonhato lepes (Ctrl+Z -> ujra a regi kep).
 *   2. A PENZ ELORE LATSZIK. A varhato koltseg a futtatas ELOTT kiirhato
 *      (K-2.12, K-X.1); a tenyleges koltseg utana a valaszban all, a modell
 *      sajat token-szamabol szamolva.
 *   3. ERZEKENY MUNKADARABNAL NEM FUT (K-1.32): a kep nem hagyhatja el a gepet.
 *
 * Az arak ADAT (forrassal es datummal), nem talalgatas: ha egy modell nincs a
 * tablaban, a felulet azt mondja, hogy a koltseget nem ismerjuk.
 */
import { getEffectiveSettingValue } from './settings-store.js'

export const IMAGE_EDIT_MODEL_DEFAULT = 'gemini-3.1-flash-image'

/** USD. Forras: https://ai.google.dev/gemini-api/docs/pricing (2026-09-30). */
export const IMAGE_MODEL_PRICES: Record<string, { input_per_mtok: number; output_per_image: number; output_per_mtok: number }> = {
  'gemini-3.1-flash-image': { input_per_mtok: 0.5, output_per_image: 0.067, output_per_mtok: 60 },
  'gemini-3.1-flash-lite-image': { input_per_mtok: 0.25, output_per_image: 0.0336, output_per_mtok: 30 },
  'gemini-3-pro-image': { input_per_mtok: 2, output_per_image: 0.134, output_per_mtok: 120 },
}
export const IMAGE_PRICE_SOURCE = { url: 'https://ai.google.dev/gemini-api/docs/pricing', checked: '2026-09-30' }

/** Egy bemeno kep kb. ennyi token a Gemininel (1024 px korul). A becsleshez. */
const INPUT_IMAGE_TOKENS = 1290

/** Ennel nagyobb kepet nem kuldunk fel (a Gemini keres-hatara 20 MB, benne a base64). */
export const IMAGE_EDIT_MAX_BYTES = 12 * 1024 * 1024

export const IMAGE_EDIT_MIMES = ['image/png', 'image/jpeg', 'image/webp']

export interface ImageAiConfig { key: string; model: string }

function setting(key: string): string {
  try { return String(getEffectiveSettingValue(key) ?? '').trim() } catch { return '' }
}

/** A beallitas: kulcs + modell. Kulcs nelkul `null` -- ez a friss telepites
 *  rendes allapota, nem hiba. */
export function imageAiConfig(): ImageAiConfig | null {
  const key = setting('WORKBENCH_GEMINI_API_KEY')
  if (!key) return null
  return { key, model: setting('WORKBENCH_IMAGE_EDIT_MODEL') || IMAGE_EDIT_MODEL_DEFAULT }
}

export interface CostEstimate {
  model: string
  /** `null`: a modell ara nincs a tablaban -- nem talalunk ki szamot. */
  usd: number | null
  source: { url: string; checked: string }
}

export function estimateImageEdit(model: string, instruction = ''): CostEstimate {
  const p = IMAGE_MODEL_PRICES[model]
  if (!p) return { model, usd: null, source: IMAGE_PRICE_SOURCE }
  const inTok = INPUT_IMAGE_TOKENS + Math.ceil(String(instruction).length / 3) + 50
  const usd = p.output_per_image + (inTok / 1e6) * p.input_per_mtok
  return { model, usd: Math.round(usd * 10000) / 10000, source: IMAGE_PRICE_SOURCE }
}

/** A tenyleges koltseg a modell sajat token-szamabol (`usageMetadata`). */
export function actualImageCost(model: string, usage: { promptTokenCount?: number; candidatesTokenCount?: number } | null | undefined): number | null {
  const p = IMAGE_MODEL_PRICES[model]
  if (!p || !usage) return null
  const inTok = Number(usage.promptTokenCount) || 0
  const outTok = Number(usage.candidatesTokenCount) || 0
  if (!inTok && !outTok) return null
  return Math.round(((inTok / 1e6) * p.input_per_mtok + (outTok / 1e6) * p.output_per_mtok) * 10000) / 10000
}

export type ImageEditResult =
  | { ok: true; bytes: Buffer; mime: string; model: string; cost_usd: number | null; note: string | null }
  | { ok: false; code: string; detail: string }

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>
}>

/**
 * Egy kep szerkesztese egy mondattal. A hiba OKAT a szolgaltato sajat
 * uzenetebol adjuk vissza (rossz kulcs, keret, tiltott tartalom) -- nem
 * talalgatunk.
 */
export async function editImageWithAI(input: {
  bytes: Buffer; mime: string; instruction: string; cfg: ImageAiConfig; fetchImpl?: FetchLike; timeoutMs?: number
}): Promise<ImageEditResult> {
  const text = String(input.instruction || '').trim()
  if (!text) return { ok: false, code: 'ai_edit_no_instruction', detail: 'the instruction is empty' }
  if (!IMAGE_EDIT_MIMES.includes(input.mime)) return { ok: false, code: 'ai_edit_bad_image', detail: `this picture type cannot be edited: ${input.mime}` }
  if (input.bytes.length > IMAGE_EDIT_MAX_BYTES) return { ok: false, code: 'ai_edit_too_large', detail: `${Math.round(input.bytes.length / 1024 / 1024)} MB` }
  const f: FetchLike = input.fetchImpl || (globalThis.fetch as unknown as FetchLike)
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.cfg.model)}:generateContent`
  const body = {
    contents: [{
      role: 'user',
      parts: [
        // A kep ELOBB, az utasitas utana: a Google dokumentacioja szerint igy
        // a modell a kepet szerkeszti, nem ujat rajzol.
        { inline_data: { mime_type: input.mime, data: input.bytes.toString('base64') } },
        { text: `Edit this image: ${text}. Keep everything else in the picture unchanged (composition, size, style).` },
      ],
    }],
    generationConfig: { responseModalities: ['IMAGE'] },
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), input.timeoutMs ?? 120_000)
  let res
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': input.cfg.key },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const aborted = ctl.signal.aborted
    return { ok: false, code: aborted ? 'ai_edit_timeout' : 'ai_edit_network', detail: e instanceof Error ? e.message : String(e) }
  }
  clearTimeout(timer)
  let data: Record<string, unknown> = {}
  try { data = (await res.json()) as Record<string, unknown> } catch { data = {} }
  if (!res.ok) {
    const err = (data['error'] || {}) as { message?: string; status?: string }
    const code = res.status === 401 || res.status === 403 ? 'ai_edit_bad_key'
      : res.status === 429 ? 'ai_edit_quota'
        : res.status === 404 ? 'ai_edit_bad_model'
          : 'ai_edit_failed'
    return { ok: false, code, detail: `${res.status} ${err.status || ''} ${err.message || ''}`.trim() }
  }
  const cands = (data['candidates'] as { content?: { parts?: unknown[] }; finishReason?: string }[] | undefined) || []
  const parts = (cands[0]?.content?.parts || []) as { inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string }; text?: string }[]
  const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data)
  if (!img) {
    // A modell nem adott kepet: altalaban tartalmi szuro. A sajat szovege
    // es a leallas oka megy vissza.
    const said = parts.map((p) => p.text || '').join(' ').trim()
    const block = (data['promptFeedback'] as { blockReason?: string } | undefined)?.blockReason
    return { ok: false, code: 'ai_edit_no_image', detail: [block, cands[0]?.finishReason, said].filter(Boolean).join(' | ').slice(0, 500) || 'the model returned no picture' }
  }
  const raw = img.inlineData?.data || img.inline_data?.data || ''
  const mime = img.inlineData?.mimeType || img.inline_data?.mime_type || 'image/png'
  const note = parts.map((p) => p.text || '').join(' ').trim() || null
  return {
    ok: true, bytes: Buffer.from(raw, 'base64'), mime, model: input.cfg.model,
    cost_usd: actualImageCost(input.cfg.model, data['usageMetadata'] as { promptTokenCount?: number; candidatesTokenCount?: number }),
    note,
  }
}
