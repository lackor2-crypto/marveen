/**
 * A VIDEOGENERALAS FOLYAMATA (munkadarab "Video fejlesztes", 2-4. fazis): indit, var, letolt, a projektbe ment.
 *
 * A Marvin szabalyai ebben a fajlban:
 *   - NINCS ALAPERTELMEZETT UJRAPROBALKOZAS az inditasnal: ha a kerés lehet, hogy elment (idotullepes, 5xx), a feladat
 *     'failed' lesz, es a tulajdonos dont -- egy automatikus ujraküldes masodszor is fizettetne.
 *   - A kesz klip UJ FAJL es UJ VERZIO a munkadarabon (a regi sosem ir felul), a letoltes hibaja utan ingyen ujra lehet
 *     probalni (`retryVideoDownload`): a video az OpenRouternel megvan.
 *   - A havi keret elott a becsult koltseg ellenorzodik; erzekeny munkadarabnal a generalas tiltott.
 */
import { getSecret } from './web/vault.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { getProject, type ProjectRow } from './projects.js'
import { createWorkItemVersion, getWorkItem, type WorkItemRow } from './workbench.js'
import { writeProjectFile } from './project-files.js'
import { privacyState } from './workbench-privacy.js'
import {
  downloadVideo, estimateVideoCost, getVideoStatus, listVideoModels, startVideo, validateVideoParams,
  type FetchLike, type VideoParams,
} from './workbench-video-gen.js'
import {
  activeVideoGen, createVideoGen, failOrphanPreparing, failVideoGen, finishVideoGen, getVideoGen, monthSpendUsd,
  resumableVideoGens, setRemoteId, type VideoGenRow,
} from './workbench-video-gen-store.js'

export const OPENROUTER_VAULT_ID = 'openrouter-fleet-key'
export const VIDEO_MODEL_DEFAULT = 'google/veo-3.1-lite'
/** Ennyi ideig varunk egy klipre, utana a feladat 'failed' (a tulajdonos az OpenRouternel latja, mi lett). */
export const VIDEO_WAIT_MAX_MS = 45 * 60_000
export const VIDEO_POLL_MS = 20_000

export interface VideoGenDeps {
  fetchImpl?: FetchLike
  getKey?: () => string | null
  pollMs?: number
  waitMaxMs?: number
  sleep?: (ms: number) => Promise<void>
}

function setting(key: string): string {
  try { return String(getEffectiveSettingValue(key) ?? '').trim() } catch { return '' }
}

export function videoGenModel(): string { return setting('WORKBENCH_VIDEO_MODEL') || VIDEO_MODEL_DEFAULT }
export function videoMonthlyBudgetUsd(): number {
  const n = Number(setting('WORKBENCH_VIDEO_MONTHLY_USD'))
  return Number.isFinite(n) && n >= 0 ? n : 20
}
function keyOf(deps: VideoGenDeps): string | null {
  const k = deps.getKey ? deps.getKey() : getSecret(OPENROUTER_VAULT_ID)
  return k && k.trim() ? k.trim() : null
}

/** Van-e OpenRouter-kulcs a Vaultban (az erteke sosem megy ki). */
export function videoKeyPresent(deps: VideoGenDeps = {}): boolean { return keyOf(deps) !== null }

export interface VideoGenPreview {
  ok: true
  model: string
  name: string
  estimate_usd: number | null
  month_spent_usd: number
  month_budget_usd: number
  /** Ami a modell listajabol valaszthato (a felulet csak ezeket mutatja). */
  options: { resolutions: string[]; aspect_ratios: string[]; durations: number[]; audio: boolean | null }
  /** A tenylegesen becsult beallitasok (kitoltes utan). */
  params: VideoParams
}
export type VideoGenError = { ok: false; status: number; code: string; detail: string | null }

/** Becsles az inditas ELOTT: az elo lista alapjan, penz es kulcs nelkul. */
export async function previewVideoGen(params: VideoParams, deps: VideoGenDeps = {}, opts: { fillDefaults?: boolean } = {}): Promise<VideoGenPreview | VideoGenError> {
  const list = await listVideoModels(deps.fetchImpl)
  if (!list.ok) return { ok: false, status: 502, code: list.code, detail: list.detail }
  const id = videoGenModel()
  const model = list.models.find((m) => m.id === id)
  if (!model) return { ok: false, status: 409, code: 'video_model_unavailable', detail: id }
  // A panel elso megnyitasakor meg nincs kivalasztott ertek: a modell sajat listajabol valasztunk ki egy ertelmeset
  // (8 mp, 720p, 9:16, ha van), hogy a felulet a valaszthato ertekekkel egyutt megjelenhessen. Inditasnal NINCS kitoltes.
  if (opts.fillDefaults) {
    const pick = <T,>(cur: T, ok: (v: T) => boolean, prefer: T, list: T[]): T => (ok(cur) ? cur : list.includes(prefer) ? prefer : list[0] ?? cur)
    params = {
      ...params,
      duration: pick(params.duration, (v) => model.durations.includes(v), 8, model.durations),
      resolution: pick(params.resolution, (v) => model.resolutions.includes(v), '720p', model.resolutions),
      aspect_ratio: pick(params.aspect_ratio, (v) => model.aspectRatios.includes(v), '9:16', model.aspectRatios),
    }
  }
  const v = validateVideoParams(model, params)
  if (!v.ok) return { ok: false, status: 400, code: v.code, detail: v.detail }
  return {
    ok: true, model: model.id, name: model.name,
    estimate_usd: estimateVideoCost(model, params),
    month_spent_usd: monthSpendUsd(), month_budget_usd: videoMonthlyBudgetUsd(),
    options: { resolutions: model.resolutions, aspect_ratios: model.aspectRatios, durations: model.durations, audio: model.audio },
    params,
  }
}

export function parseVideoParams(body: Record<string, unknown>): VideoParams {
  return {
    duration: Number(body['duration']) || 0,
    resolution: String(body['resolution'] ?? '').trim(),
    aspect_ratio: String(body['aspect_ratio'] ?? '9:16').trim(),
    audio: body['audio'] !== false,
  }
}

/** A prompt elejere kerulo, a modell fele fixen elkuldott vedelem: ne legyen felismerheto marka, logo, rendszam. */
export const VIDEO_PROMPT_GUARD = 'No recognisable brand logos, real car brands, readable text or licence plates in the scene.'

const polling = new Map<string, Promise<void>>()

export async function startVideoGeneration(input: {
  item: WorkItemRow; project: ProjectRow; prompt: string; params: VideoParams; deps?: VideoGenDeps
}): Promise<{ ok: true; row: VideoGenRow } | VideoGenError> {
  const deps = input.deps ?? {}
  const prompt = input.prompt.trim().slice(0, 2000)
  if (!prompt) return { ok: false, status: 400, code: 'video_no_prompt', detail: null }
  if (privacyState(input.item.project_id, input.item.id).sensitive) return { ok: false, status: 403, code: 'video_sensitive', detail: null }
  const key = keyOf(deps)
  if (!key) return { ok: false, status: 409, code: 'video_no_key', detail: null }
  const active = activeVideoGen(input.item.id)
  if (active) return { ok: false, status: 409, code: 'video_already_running', detail: active.id }

  const pre = await previewVideoGen(input.params, deps)
  if (!pre.ok) return pre
  // Ismeretlen ar: nem talalunk ki szamot, es a keretet sem tudjuk vedeni -> nem indul.
  if (pre.estimate_usd === null) return { ok: false, status: 409, code: 'video_price_unknown', detail: pre.model }
  if (pre.month_spent_usd + pre.estimate_usd > pre.month_budget_usd) {
    return { ok: false, status: 409, code: 'video_over_budget', detail: `${pre.month_spent_usd.toFixed(2)} + ${pre.estimate_usd.toFixed(2)} > ${pre.month_budget_usd}` }
  }

  // A sor a KERES ELOTT: ha a folyamat most all le, a sor megvan (lasd failOrphanPreparing).
  const row = createVideoGen({ itemId: input.item.id, projectId: input.project.id, model: pre.model, prompt, params: input.params, estUsd: pre.estimate_usd })
  const started = await startVideo({ key, model: pre.model, prompt: `${prompt}\n\n${VIDEO_PROMPT_GUARD}`, params: input.params, fetchImpl: deps.fetchImpl })
  if (!started.ok) {
    failVideoGen(row.id, started.maybeStarted ? 'video_start_unsure' : started.code, started.detail)
    return { ok: false, status: started.maybeStarted ? 502 : started.code === 'video_no_credit' ? 402 : 502, code: started.maybeStarted ? 'video_start_unsure' : started.code, detail: started.detail }
  }
  setRemoteId(row.id, started.id)
  void pollVideoGeneration(row.id, deps)
  return { ok: true, row: getVideoGen(row.id)! }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() })

/** Var a kesz klipre, utana letolti es menti. Egyszerre egy figyelo per feladat. */
export function pollVideoGeneration(id: string, deps: VideoGenDeps = {}): Promise<void> {
  const running = polling.get(id)
  if (running) return running
  const p = pollLoop(id, deps).finally(() => { polling.delete(id) })
  polling.set(id, p)
  return p
}

async function pollLoop(id: string, deps: VideoGenDeps): Promise<void> {
  {
    const sleep = deps.sleep ?? defaultSleep
    const pollMs = deps.pollMs ?? VIDEO_POLL_MS
    const deadline = Date.now() + (deps.waitMaxMs ?? VIDEO_WAIT_MAX_MS)
    let failures = 0
    for (;;) {
      const row = getVideoGen(id)
      if (!row || row.state !== 'running' || !row.remote_id) return
      const key = keyOf(deps)
      if (!key) { failVideoGen(id, 'video_no_key', 'the OpenRouter key is gone from the vault'); return }
      const st = await getVideoStatus({ key, id: row.remote_id, fetchImpl: deps.fetchImpl })
      if (!st.ok) {
        // Egy-egy megszakadt lekerdezes nem a generalas hibaja: tobbszor egymas utan kell elbukni.
        if (++failures >= 6) { failVideoGen(id, st.code, st.detail); return }
      } else {
        failures = 0
        if (st.status === 'failed') { failVideoGen(id, 'video_generation_failed', st.error || 'the model could not make the video', st.costUsd); return }
        if (st.status === 'completed') { await saveFinished(id, st.costUsd, deps); return }
      }
      if (Date.now() > deadline) { failVideoGen(id, 'video_gen_timeout', `no result after ${Math.round((deps.waitMaxMs ?? VIDEO_WAIT_MAX_MS) / 60000)} minutes; job ${row.remote_id}`); return }
      await sleep(pollMs)
    }
  }
}

function fileStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

async function saveFinished(id: string, costUsd: number | null, deps: VideoGenDeps): Promise<void> {
  const row = getVideoGen(id)
  if (!row || !row.remote_id) return
  const key = keyOf(deps)
  if (!key) { failVideoGen(id, 'video_no_key', 'the OpenRouter key is gone from the vault', costUsd); return }
  const item = getWorkItem(row.work_item_id)
  const project = item ? getProject(item.project_id) : undefined
  if (!item || !project) { failVideoGen(id, 'video_item_gone', 'the work item or project no longer exists', costUsd); return }
  let dl = await downloadVideo({ key, id: row.remote_id, fetchImpl: deps.fetchImpl })
  for (let i = 0; !dl.ok && i < 2; i++) { await (deps.sleep ?? defaultSleep)(2000); dl = await downloadVideo({ key, id: row.remote_id, fetchImpl: deps.fetchImpl }) }
  if (!dl.ok) { failVideoGen(id, dl.code, dl.detail, costUsd); return }
  const slug = row.model.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
  const sub = item.folder ? `${item.folder}/Elkészített anyagok` : null
  const written = writeProjectFile(project, sub, `ai-video-${slug}-${fileStamp()}.mp4`, dl.bytes)
  if (!written.ok) { failVideoGen(id, 'video_write_failed', written.message || written.code, costUsd); return }
  const ver = createWorkItemVersion(item.id, {
    source_path: written.rel, prompt: row.prompt, created_by: 'video-gen',
    metadata_json: JSON.stringify({ video_gen: row.id, model: row.model, params: JSON.parse(row.params_json), cost_usd: costUsd }),
  })
  if (!ver.ok) { failVideoGen(id, 'video_version_failed', ver.code, costUsd); return }
  finishVideoGen(id, { costUsd, fileRel: written.rel })
}

/** Letoltes-hiba utan: a videot ujra elkerjuk az OpenRouterrol (fizetes nelkul), nem generalunk ujat. */
export async function retryVideoDownload(id: string, deps: VideoGenDeps = {}): Promise<{ ok: true; row: VideoGenRow } | VideoGenError> {
  const row = getVideoGen(id)
  if (!row) return { ok: false, status: 404, code: 'video_not_found', detail: null }
  const code = row.error_code || ''
  if (row.state !== 'failed' || !row.remote_id || !(code.startsWith('video_download') || code === 'video_write_failed')) {
    return { ok: false, status: 409, code: 'video_not_retryable', detail: null }
  }
  await saveFinished(id, row.cost_usd, deps)
  return { ok: true, row: getVideoGen(id)! }
}

/** Indulaskor: a megszakadt feladatokat folytatjuk (ami nem derul ki, azt nem probaljuk ujra). */
export function resumeVideoGenerations(deps: VideoGenDeps = {}): { orphaned: number; resumed: number } {
  const orphaned = failOrphanPreparing()
  const rows = resumableVideoGens()
  for (const r of rows) void pollVideoGeneration(r.id, deps)
  return { orphaned, resumed: rows.length }
}
