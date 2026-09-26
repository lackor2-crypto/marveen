// A BETEKINTO LINK NYILVANOS LAPJA (kanban #406, 18. pont).
//
// `/view/<token>` -- szandekosan NEM `/api/` alatt: a hitelesito kapu (auth-
// gate `requiresAuth`) ezt az utat nem kapuzza, es a token SEHOL mashol nem
// ervenyes. Harom valasz van, mind CSAK olvasas:
//   GET /view/<token>            -> a lap (szkript nelkul, sandbox CSP)
//   GET /view/<token>/file       -> munkadarab-linknel: az eredeti fajl letoltese
//   GET /view/<token>/download   -> csomag-linknel: az atadasi csomag (ZIP)
//   GET /view/<token>/post/<id>  -> vegyes munkadarabnal: egy elmentett
//                                   platform-meretu posztkep (#406)
// Barmilyen hibanal (rossz, lejart, visszavont token, eltunt munkadarab)
// ugyanaz az emberi mondat jon, 404-gyel -- a kivulallo nem tudja meg, melyik.
import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveLifePath } from '../../life-explorer.js'
import { getProject } from '../../projects.js'
import { getWorkItem } from '../../workbench.js'
import { buildExportPage } from '../../workbench-export.js'
import { buildPreview } from '../../workbench-preview.js'
import { listPostFiles, getPostFile, POST_PLATFORMS } from '../../workbench-post-files.js'
import { planHandoff, buildHandoffZip, HANDOFF_MAX_BYTES } from '../../workbench-handoff.js'
import { resolveShareToken, noteShareView, shareLangHint, type ShareRow } from '../../workbench-share.js'
import type { RouteContext } from './types.js'

type Lang = 'hu' | 'en'

const T = {
  hu: {
    gone: 'Ez a link nem érvényes: lejárt, visszavonták, vagy nem pontosan került át. Kérj újat attól, aki küldte.',
    banner: 'Csak olvasható betekintés', until: 'A link lejár', download: 'Az eredeti fájl letöltése',
    fileOnly: 'Ezt a fájlt ez a lap nem tudja megjeleníteni. Töltsd le a fenti gombbal.',
    noFile: 'Ezt a munkadarabot ez a lap nem tudja megjeleníteni, és a fájlja most nem érhető el.',
    handoff: 'Átadási csomag', project: 'Projekt', zip: 'A csomag letöltése (ZIP)',
    noItems: 'Ebben a csomagban most nincs egy munkadarab sem.', tooLarge: 'A csomag túl nagy a letöltéshez. Szólj annak, aki a linket küldte.',
    items: 'Munkadarabok',
    postTitle: 'A poszt képei, platform-méretben',
    postNone: 'Ehhez a poszthoz még nincs elmentett platform-méretű kép. A poszt tartalma lent látható; a képet a küldőtől kérheted.',
    postPdf: 'PDF-hez: a böngésző Nyomtatás menüjében válaszd a „Mentés PDF-ként” lehetőséget.',
  },
  en: {
    gone: 'This link is not valid: it expired, was revoked, or was not copied exactly. Ask the person who sent it for a new one.',
    banner: 'Read-only view', until: 'The link expires', download: 'Download the original file',
    fileOnly: 'This page cannot show this file. Download it with the button above.',
    noFile: 'This page cannot show this work item, and its file cannot be reached right now.',
    handoff: 'Handoff package', project: 'Project', zip: 'Download the package (ZIP)',
    noItems: 'This package has no work items right now.', tooLarge: 'The package is too large to download. Tell the person who sent the link.',
    items: 'Work items',
    postTitle: 'Post images, at platform size',
    postNone: 'No platform-size image has been saved for this post yet. The post content is shown below; ask the sender for the image.',
    postPdf: 'For a PDF: in the browser Print menu choose "Save as PDF".',
  },
} as const

const TYPE: Record<string, Record<Lang, string>> = {
  document: { hu: 'Dokumentum', en: 'Document' }, image: { hu: 'Kép', en: 'Image' }, graphic: { hu: 'Grafika', en: 'Graphic' },
  video: { hu: 'Videó', en: 'Video' }, note: { hu: 'Jegyzet', en: 'Note' }, composite: { hu: 'Vegyes', en: 'Mixed' },
}
const PLATFORM: Record<string, Record<Lang, string>> = {
  fb_feed: { hu: 'Facebook hírfolyam', en: 'Facebook feed' }, fb_square: { hu: 'Facebook négyzet', en: 'Facebook square' },
  fb_link: { hu: 'Facebook link-kép', en: 'Facebook link image' }, fb_story: { hu: 'Facebook történet', en: 'Facebook story' },
  ig_feed: { hu: 'Instagram hírfolyam', en: 'Instagram feed' }, ig_portrait: { hu: 'Instagram álló', en: 'Instagram portrait' },
  ig_square: { hu: 'Instagram négyzet', en: 'Instagram square' }, ig_story: { hu: 'Instagram történet', en: 'Instagram story' },
  li_landscape: { hu: 'LinkedIn fekvő', en: 'LinkedIn landscape' }, li_square: { hu: 'LinkedIn négyzet', en: 'LinkedIn square' },
  li_portrait: { hu: 'LinkedIn álló', en: 'LinkedIn portrait' },
}
const STATUS: Record<string, Record<Lang, string>> = {
  draft: { hu: 'Vázlat', en: 'Draft' }, in_progress: { hu: 'Folyamatban', en: 'In progress' },
  review: { hu: 'Átnézésre vár', en: 'In review' }, done: { hu: 'Kész', en: 'Done' },
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** A kozos biztonsagi fejlecek: a token az URL-ben van, tehat sehova ne szivarogjon. */
const SAFE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
}
/** Szkript nincs, kulso eroforras nincs, a lap sajat (ures) eredetben fut. */
export const VIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-downloads allow-popups"

function page(res: RouteContext['res'], status: number, html: string): void {
  res.writeHead(status, {
    ...SAFE_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(html, 'utf-8')),
    'Content-Security-Policy': VIEW_CSP,
  })
  res.end(html)
}

function shell(lang: Lang, title: string, body: string): string {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #111; line-height: 1.5; max-width: 800px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; } .meta { color: #555; font-size: .9rem; }
  a.btn { display: inline-block; padding: 10px 16px; border-radius: 6px; border: 1px solid #888; color: #111; text-decoration: none; margin: 8px 0; }
  ul { padding-left: 20px; } li { margin: 4px 0; word-break: break-word; } .muted { color: #666; }
</style></head><body>${body}</body></html>`
}

function gone(res: RouteContext['res'], token: string): void {
  const hint = shareLangHint(token)
  const langs: Lang[] = hint ? [hint] : ['hu', 'en']
  const body = langs.map((l) => `<p>${esc(T[l].gone)}</p>`).join('')
  page(res, 404, shell(hint || 'hu', hint === 'en' ? 'Link not valid' : 'A link nem érvényes', body))
}

function untilText(s: ShareRow): string {
  const d = new Date((s.expires_at || 0) * 1000)
  return d.toLocaleString(s.lang === 'en' ? 'en-GB' : 'hu-HU', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A munkadarab letoltheto fajlja (Raktar-relativ ut + abszolut), ha van. */
function itemFile(itemId: string): { abs: string; name: string; size: number } | null {
  const p = buildPreview(itemId)
  if (!p.rel || p.kind === 'parts') return null
  const abs = resolveLifePath(p.rel)
  if (!abs) return null
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > HANDOFF_MAX_BYTES) return null
    return { abs, name: basename(abs), size: st.size }
  } catch { return null }
}

/** Vegyes munkadarab (poszt): az elmentett platform-kepek letoltesre. Szkript
 *  nincs, tehat itt nem vagunk -- csak a Munkapadon mar elmentett fajlt adjuk. */
function postSection(s: ShareRow, token: string, type: string): string {
  if (type !== 'composite') return ''
  const t = T[s.lang]
  const files = listPostFiles(s.work_item_id as string).filter((f) => f.available)
  const list = files.length
    ? files.map((f) => {
      const pf = POST_PLATFORMS[f.platform]
      const label = `${PLATFORM[f.platform]?.[s.lang] ?? f.platform} (${pf ? `${pf.w}×${pf.h}` : ''})`
      return `<a class="btn" href="/view/${esc(token)}/post/${esc(f.id)}" download>${esc(label)}</a> <span class="muted">(${esc(f.name)})</span><br>`
    }).join('')
    : `<p class="muted">${esc(t.postNone)}</p>`
  return `<div class="meta" style="border:1px solid #ccc;border-radius:8px;padding:8px 10px;margin:8px 0"><strong>${esc(t.postTitle)}</strong><br>${list}<span class="muted">${esc(t.postPdf)}</span></div>`
}

function itemPage(res: RouteContext['res'], s: ShareRow, token: string): void {
  const t = T[s.lang]
  const item = getWorkItem(s.work_item_id as string)!
  const file = itemFile(item.id)
  const exp = buildExportPage(item, null, s.lang, { toolbar: false, fileOnly: file ? t.fileOnly : t.noFile })
  const banner = `<p class="meta" style="border:1px solid #ccc;border-radius:8px;padding:8px 10px">${esc(t.banner)} · ${esc(t.until)}: ${esc(untilText(s))}`
    + (file ? `<br><a class="btn" href="/view/${esc(token)}/file" download>${esc(t.download)}</a> <span class="muted">(${esc(file.name)})</span>` : '')
    + '</p>' + postSection(s, token, item.type)
  page(res, 200, exp.html.replace('<body>', `<body>\n${banner}`))
}

function handoffPage(res: RouteContext['res'], s: ShareRow, token: string): void {
  const t = T[s.lang]
  const project = getProject(s.project_id)!
  const plan = planHandoff(project.id, s.scope === 'all' ? 'all' : 'done')
  const items = plan ? plan.items : []
  const list = items.length
    ? `<h2>${esc(t.items)}</h2><ul>${items.map((e) => `<li>${esc(e.title)} <span class="muted">(${esc(TYPE[e.type]?.[s.lang] ?? e.type)} · ${esc(STATUS[e.status]?.[s.lang] ?? e.status)})</span></li>`).join('')}</ul>`
    : `<p class="muted">${esc(t.noItems)}</p>`
  const dl = !items.length ? '' : plan!.too_large
    ? `<p>${esc(t.tooLarge)}</p>`
    : `<a class="btn" href="/view/${esc(token)}/download" download>${esc(t.zip)}</a>`
  const body = `<h1>${esc(t.handoff)}</h1><p class="meta">${esc(t.project)}: ${esc(project.name)}<br>${esc(t.banner)} · ${esc(t.until)}: ${esc(untilText(s))}</p>${dl}${list}`
  page(res, 200, shell(s.lang, `${t.handoff} -- ${project.name}`, body))
}

function attachment(res: RouteContext['res'], name: string, size: number, type: string): void {
  res.writeHead(200, {
    ...SAFE_HEADERS,
    // Mindig letoltes, sosem beagyazott megjelenites: egy feltoltott HTML/SVG
    // se futhasson a dashboard eredeteben.
    'Content-Type': type,
    'Content-Length': String(size),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Content-Security-Policy': "default-src 'none'; sandbox",
  })
}

export async function tryHandleWorkbenchShareView(ctx: RouteContext): Promise<boolean> {
  const { path, method, res } = ctx
  const m = /^\/view\/([^/]+)(?:\/(file|download|post)(?:\/([^/]+))?)?\/?$/.exec(path)
  if (!m) return false
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { ...SAFE_HEADERS, Allow: 'GET' })
    res.end()
    return true
  }
  const token = decodeURIComponent(m[1])
  const s = resolveShareToken(token)
  if (!s) { gone(res, token); return true }
  // Csak a poszt-kepnek van al-azonositoja: /file/x, /download/x nem a mienk.
  if (m[3] && m[2] !== 'post') { gone(res, token); return true }

  if (!m[2]) {
    noteShareView(s.id)
    if (s.kind === 'item') itemPage(res, s, token)
    else handoffPage(res, s, token)
    return true
  }

  if (m[2] === 'file' && s.kind === 'item') {
    const f = itemFile(s.work_item_id as string)
    if (!f) { gone(res, token); return true }
    attachment(res, f.name, f.size, 'application/octet-stream')
    if (method === 'HEAD') { res.end(); return true }
    createReadStream(f.abs).on('error', () => res.destroy()).pipe(res)
    return true
  }
  if (m[2] === 'post' && m[3] && s.kind === 'item') {
    const f = getPostFile(s.work_item_id as string, decodeURIComponent(m[3]))
    if (!f || !f.abs) { gone(res, token); return true }
    let size = 0
    try { size = statSync(f.abs).size } catch { gone(res, token); return true }
    attachment(res, f.name, size, f.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
    if (method === 'HEAD') { res.end(); return true }
    createReadStream(f.abs).on('error', () => res.destroy()).pipe(res)
    return true
  }
  if (m[2] === 'download' && s.kind === 'handoff') {
    const r = buildHandoffZip(s.project_id, s.scope === 'all' ? 'all' : 'done', s.lang)
    if (!r.ok) { gone(res, token); return true }
    attachment(res, r.filename, r.zip.length, 'application/zip')
    res.end(method === 'HEAD' ? undefined : r.zip)
    return true
  }
  gone(res, token)
  return true
}
