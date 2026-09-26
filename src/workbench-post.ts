/**
 * MUNKAPAD: KOZOSSEGI POSZT SZERKESZTO -- HAROM ZONA (kanban #406).
 *
 * A tulajdonos (TG 6663): "Felulre egy szovegbevitelmezo, kozepre a foto, meg
 * alulra meg azok a szavak [hashtagek] ... ennyi egy Facebook poszt." A poszt
 * tehat NEM sorokba szedett szoveg-reszek listaja, hanem harom dolog:
 *
 *   - a poszt szovege (egy tobbsoros mezo),
 *   - a foto (az elso kep-resz),
 *   - a cimkek (`#felujitas #komuves`).
 *
 * Tarolas: a MEGLEVO resz-modellben (work_item_parts), kanonikus sorrendben --
 * [szoveg] [kep] [cimkek]. Igy az export, a betekinto link, a verziok es az
 * agens eszkozei valtozatlanul mukodnek, uj tabla nelkul. A munkadarab
 * `editor_type = 'social_post'` jelzi, hogy a felulet a harom-zonas
 * szerkesztot mutassa.
 *
 * A REGI (4 reszes sablonbol keszult) poszt nem veszik el: megnyitaskor a
 * szoveg-reszek osszefuzve a szoveg-mezobe kerulnek, a CSAK cimkebol allo
 * reszek es a szoveg vegi csak-cimke sorok a cimke-mezobe (`splitPost`). A
 * lemezen semmi nem valtozik, amig a felhasznalo nem ir bele -- az elso
 * mentes irja at kanonikus alakra, UJ verzioban, tehat a regi alak
 * visszaallithato marad.
 */
import { getDb } from './db.js'
import {
  addWorkItemPart, getWorkItem, listWorkItemParts, removeWorkItemPart, getWorkItemVersion,
  PART_TEXT_MAX, type WorkItemRow, type WorkItemPartRow, type WorkItemVersionRow,
} from './workbench.js'
import { editAsNewVersion } from './workbench-edit.js'

export const POST_EDITOR = 'social_post'
/** A cimke-mezo felso hatara (a Facebook/Instagram 30 cimkenel tobbet ugysem enged). */
export const POST_TAGS_MAX = 2000
/** Egymas utani gepeles egy verzioba kerul, ha ennyi masodpercen belul jon. */
export const POST_COALESCE_SEC = 600

/** Egy cimke: betu, szam, alahuzas -- a platformok az irasjelnel elvagjak. */
const TAG_WORD = /^#[\p{L}\p{N}_]+$/u

/** Egy sor CSAK cimkekbol all (`#a #b`). Az ures sor nem ilyen. */
export function isTagLine(line: string): boolean {
  const words = String(line || '').trim().split(/\s+/).filter(Boolean)
  return words.length > 0 && words.every((w) => TAG_WORD.test(w) || /^#\[[^\]]*\]$/.test(w))
}

/**
 * A cimke-mezo tartalma egyseges alakban: `#a #b #c`. A `#` nelkul beirt szot
 * is elfogadja, a vesszot/pontosvesszot elvalasztonak veszi, a nem-cimke
 * karaktereket (irasjel) kihagyja, es a duplikatumot (kis-nagybetu nelkul)
 * egyszer tartja meg.
 */
export function normalizeTags(raw: unknown): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const chunk of String(raw ?? '').split(/[\s,;]+/)) {
    const word = chunk.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]+/gu, '')
    if (!word) continue
    const key = word.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push('#' + word)
  }
  return out.join(' ')
}

export interface PostView {
  text: string
  tags: string
  /** Az elso kep-resz (a poszt fotoja), ha van. */
  image: WorkItemPartRow | null
  /** Hany kep-resz van (1-nel tobb: a szerkeszto csak az elsot mutatja). */
  image_count: number
  /** Regi (nem kanonikus) alak: az elso mentes atirja. */
  legacy: boolean
}

/** A reszekbol a harom zona. Tiszta fuggveny -- a tesztek ezt merik. */
export function splitPost(parts: readonly WorkItemPartRow[]): PostView {
  const texts = parts.filter((p) => p.kind === 'text' && (p.text || '').trim())
  const images = parts.filter((p) => p.kind === 'image' && p.asset_path)
  const tagChunks: string[] = []
  const bodyChunks: string[] = []
  for (const p of texts) {
    const t = String(p.text).trim()
    if (t.split('\n').every((l) => !l.trim() || isTagLine(l))) tagChunks.push(t)
    else bodyChunks.push(t)
  }
  // A szoveg vegi csak-cimke sorok is a cimke-mezobe valok ("a sor vegi #szavak").
  let body = bodyChunks.join('\n\n')
  const lines = body.split('\n')
  const tail: string[] = []
  while (lines.length && (isTagLine(lines[lines.length - 1]) || (!lines[lines.length - 1].trim() && tail.length))) {
    const l = lines.pop() as string
    if (l.trim()) tail.unshift(l.trim())
  }
  if (tail.length) body = lines.join('\n').replace(/\s+$/, '')
  const tags = [...tail, ...tagChunks].join(' ').split(/\s+/).filter(Boolean).join(' ')
  const canonical = texts.length === (body.trim() ? 1 : 0) + (tags ? 1 : 0)
    && (!body.trim() || texts[0].text === body)
    && (!tags || texts[texts.length - 1].text === normalizeTags(tags))
  return { text: body, tags, image: images[0] ?? null, image_count: images.length, legacy: !canonical }
}

/**
 * Harom-zonas szerkesztot kap-e a munkadarab. Az uj poszt a jelzorol; a regi
 * (4 reszes sablon) a formajarol: vegyes munkadarab, legfeljebb EGY keppel, es
 * az utolso szoveg-resze cimkekkel zarul. Egy tobbkepes vegyes munkadarab
 * SOSEM -- ott a szerkeszto elrejtene a tobbi kepet.
 */
export function isPostItem(item: Pick<WorkItemRow, 'type' | 'editor_type'>, parts: readonly WorkItemPartRow[]): boolean {
  if (item.editor_type === POST_EDITOR) return true
  if (item.type !== 'composite') return false
  if (parts.filter((p) => p.kind === 'image').length > 1) return false
  const texts = parts.filter((p) => p.kind === 'text' && (p.text || '').trim())
  if (!texts.length) return false
  const last = String(texts[texts.length - 1].text).trim().split('\n')
  return isTagLine(last[last.length - 1])
}

/** A munkadarab poszt-nezete, vagy null, ha nem poszt. */
export function postViewOf(item: WorkItemRow, parts: readonly WorkItemPartRow[]): PostView | null {
  return isPostItem(item, parts) ? splitPost(parts) : null
}

export type SavePostResult =
  | { ok: true; changed: boolean; post: PostView; parts: WorkItemPartRow[]; item: WorkItemRow; version: WorkItemVersionRow | null }
  | { ok: false; code: 'not_found' | 'text_too_long' | 'tags_too_long' | 'part_not_found' | string }

/** A szoveg + cimkek kanonikus alakba: [szoveg] [kepek] [cimkek]. */
function rewriteTextParts(itemId: string, text: string, tags: string, actor: string | null): { ok: true } | { ok: false; code: string } {
  const db = getDb()
  for (const p of listWorkItemParts(itemId)) {
    if (p.kind !== 'text') continue
    const r = removeWorkItemPart(p.id, itemId)
    if (!r.ok) return r
  }
  let bodyId: string | null = null
  if (text.trim()) {
    const r = addWorkItemPart({ work_item_id: itemId, kind: 'text', text, created_by: actor })
    if (!r.ok) return r
    bodyId = r.part.id
  }
  if (tags) {
    const r = addWorkItemPart({ work_item_id: itemId, kind: 'text', text: tags, created_by: actor })
    if (!r.ok) return r
  }
  const ordered = listWorkItemParts(itemId).slice()
  if (bodyId) {
    const at = ordered.findIndex((p) => p.id === bodyId)
    ordered.unshift(ordered.splice(at, 1)[0])
  }
  ordered.forEach((p, i) => db.prepare('UPDATE work_item_parts SET position = ? WHERE id = ?').run(i + 1, p.id))
  db.prepare('UPDATE work_items SET editor_type = ? WHERE id = ?').run(POST_EDITOR, itemId)
  return { ok: true }
}

/**
 * A poszt szovegenek es cimkeinek mentese. "Minden mentes uj verzio" (#406, 4.
 * pont) -- de a gepeles nem lehet minden szunetnel uj verzio: ha az aktualis
 * verzio MAR ugyanennek a szerkesztonek a mentese, ugyanattol, es
 * `POST_COALESCE_SEC`-en belul, akkor abba irunk. Valtozatlan tartalomra
 * semmi nem tortenik (nincs ures verzio).
 */
export function savePost(
  itemId: string,
  input: { text?: unknown; tags?: unknown },
  opts: { created_by?: string | null; now?: number } = {},
): SavePostResult {
  const item = getWorkItem(itemId)
  if (!item) return { ok: false, code: 'not_found' }
  const text = String(input.text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (text.length > PART_TEXT_MAX) return { ok: false, code: 'text_too_long' }
  const tags = normalizeTags(input.tags)
  if (tags.length > POST_TAGS_MAX) return { ok: false, code: 'tags_too_long' }
  const before = splitPost(listWorkItemParts(item.id))
  const actor = opts.created_by ?? null
  if (!before.legacy && item.editor_type === POST_EDITOR && before.text === text && normalizeTags(before.tags) === tags) {
    return { ok: true, changed: false, post: before, parts: listWorkItemParts(item.id), item, version: null }
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const cur = item.current_version_id ? getWorkItemVersion(item.current_version_id) : undefined
  let meta: { edit?: string } = {}
  try { meta = cur && cur.metadata_json ? JSON.parse(cur.metadata_json) : {} } catch { meta = {} }
  const coalesce = !!cur && meta.edit === 'post_update' && (cur.created_by ?? null) === actor
    && now - cur.created_at < POST_COALESCE_SEC

  if (coalesce) {
    const db = getDb()
    let bad: { ok: false; code: string } | null = null
    db.transaction(() => {
      const r = rewriteTextParts(item.id, text, tags, actor)
      if (!r.ok) { bad = r; throw new Error('rollback') }
    })
    try {
      db.transaction(() => {
        const r = rewriteTextParts(item.id, text, tags, actor)
        if (!r.ok) { bad = r; throw new Error('rollback') }
      })()
    } catch (e) {
      if (bad) return bad
      throw e
    }
    const fresh = getWorkItem(item.id) as WorkItemRow
    const parts = listWorkItemParts(item.id)
    return { ok: true, changed: true, post: splitPost(parts), parts, item: fresh, version: null }
  }

  const v = editAsNewVersion(item.id, { created_by: actor, kind: 'post_update' }, null, () => rewriteTextParts(item.id, text, tags, actor))
  if (!v.ok) return { ok: false, code: v.code }
  const parts = listWorkItemParts(item.id)
  return { ok: true, changed: true, post: splitPost(parts), parts, item: v.item, version: v.version }
}
