/**
 * MUNKAPAD: EXPORT ES KULDES (kanban #406, 6. pont).
 *
 * EXPORT: a munkadarab egy ONALLO, nyomtathato HTML-lapja (a kepek beagyazva),
 * amibol a bongeszo "Nyomtatas -> Mentes PDF-kent" utja PDF-et csinal -- ez
 * minden gepen, telefonon is, friss telepitesen, kulso program nelkul megy. A
 * kep (PNG) exportot a bongeszo rajzolja (web/workbench.js).
 *
 * KULDES (tulajdonos dontese, 2026-09-27): KET UT, a hivo fajtaja szerint.
 *   - A TULAJDONOS SAJAT KATTINTASA (bejelentkezett dashboard-munkamenet,
 *     `auth.kind === 'session'`): `sendNow()` AZONNAL elkuldi a levelet a
 *     bekotott Google-fiokrol (`scripts/gmail-send.py`), jegy nelkul. Az
 *     eredmeny igazolt: sikernel a Gmail uzenet-azonositoja, hibanal a
 *     tenyleges hibauzenet. Bekotott fiok nelkul emberi mondattal all meg.
 *   - MINDEN MAS HIVO (token, federacio, eszkoz, a Munkapad-agens eszkozei):
 *     `requestSendApproval()` a MEGLEVO jovahagyasi kapun at (`createApproval`
 *     + `[APPROVAL_REQUEST]` a fo agensnek) egy `email_send` jegyet nyit;
 *     kifele csak a tulajdonos igen-je utan megy barmi.
 *   A ket ut kozti valasztast a SZERVER (az utvonal) teszi meg, nem a felulet.
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID, STORE_DIR } from './config.js'
import { createApproval, createAgentMessage } from './db.js'
import { logger } from './logger.js'
import { resolveLifePath } from './life-explorer.js'
import { getProject } from './projects.js'
import { fileKind } from './file-kind.js'
import { buildPreview } from './workbench-preview.js'
import { readCanvas, renderCanvasForItem } from './workbench-canvas-store.js'
import { listWorkItemParts, type WorkItemRow } from './workbench.js'

type Lang = 'hu' | 'en'

/** Egy beagyazott kep felso hatara; nagyobbnal a lap csak megnevezi a kepet. */
export const EXPORT_IMAGE_MAX_BYTES = 15 * 1024 * 1024
/** Az egesz lap kepeinek felso hatara (egy nyomtathato lap, nem egy archivum). */
export const EXPORT_TOTAL_MAX_BYTES = 40 * 1024 * 1024

const W = {
  hu: {
    version: 'verzió', project: 'Projekt', print: 'Nyomtatás / mentés PDF-ként',
    printHint: 'A nyomtatási ablakban válaszd a „Mentés PDF-ként” célt. Telefonon: Megosztás → Nyomtatás.',
    empty: 'Ebben a munkadarabban még nincs tartalom.',
    imageMissing: 'A kép nem olvasható', imageTooBig: 'A kép túl nagy a beágyazáshoz',
    fileOnly: 'Ez a munkadarab egy fájl, amit ez a lap nem tud megjeleníteni. Az eredeti fájlt töltsd le a Munkapadról.',
    generated: 'Készült',
  },
  en: {
    version: 'version', project: 'Project', print: 'Print / save as PDF',
    printHint: 'In the print dialog choose "Save as PDF". On a phone: Share → Print.',
    empty: 'This work item has no content yet.',
    imageMissing: 'The image cannot be read', imageTooBig: 'The image is too large to embed',
    fileOnly: 'This work item is a file this page cannot show. Download the original from the Workbench.',
    generated: 'Generated',
  },
} as const

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

/** Egy kep a Raktarbol, beagyazhato alakban -- vagy az ok, amiert nem. */
function imageDataUri(rel: string, budget: { left: number }): { ok: true; uri: string } | { ok: false; why: 'missing' | 'too_big' } {
  const abs = resolveLifePath(rel)
  if (!abs) return { ok: false, why: 'missing' }
  let size = 0
  try { size = statSync(abs).size } catch { return { ok: false, why: 'missing' } }
  if (size > EXPORT_IMAGE_MAX_BYTES || size > budget.left) return { ok: false, why: 'too_big' }
  let buf: Buffer
  try { buf = readFileSync(abs) } catch { return { ok: false, why: 'missing' } }
  budget.left -= buf.length
  const mime = fileKind(basename(abs)).mime || 'application/octet-stream'
  return { ok: true, uri: `data:${mime};base64,${buf.toString('base64')}` }
}

function paragraphs(text: string): string {
  return String(text || '').split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')
}

export interface ExportPage {
  html: string
  fileName: string
  versionNo: number | null
}

/**
 * A munkadarab nyomtathato lapja. `print`: a lap tetejen ott a "Nyomtatas /
 * PDF" gomb (a letoltott valtozatban nincs -- az mar a vegtermek).
 */
export function buildExportPage(item: WorkItemRow, wantedVersion: unknown, lang: Lang, opts: { toolbar?: boolean; autoPrint?: boolean; fileOnly?: string } = {}): ExportPage {
  const w = W[lang]
  const project = getProject(item.project_id)
  const p = buildPreview(item.id, wantedVersion)
  const budget = { left: EXPORT_TOTAL_MAX_BYTES }
  const blocks: string[] = []
  const img = (rel: string, alt: string, caption: string | null) => {
    const r = imageDataUri(rel, budget)
    const fig = r.ok
      ? `<img src="${r.uri}" alt="${esc(alt)}">`
      : `<p class="missing">${esc(r.why === 'too_big' ? w.imageTooBig : w.imageMissing)}: ${esc(basename(rel))}</p>`
    return `<figure>${fig}${caption ? `<figcaption>${esc(caption)}</figcaption>` : ''}</figure>`
  }

  if (p.kind === 'parts' || (!p.available && p.reason === 'no_source')) {
    const snapshot = p.version_id && p.version_id !== item.current_version_id ? p.version_id : null
    for (const part of listWorkItemParts(item.id, snapshot)) {
      if (part.kind === 'text') blocks.push(paragraphs(part.text || ''))
      else if (part.asset_path) blocks.push(img(part.asset_path, part.caption || item.title, part.caption))
    }
  } else if (p.available && p.kind === 'text') {
    blocks.push(`<pre>${esc(p.text || '')}</pre>`)
  } else if (p.available && p.kind === 'image' && p.rel) {
    blocks.push(img(p.rel, item.title, null))
  } else if (p.kind === 'canvas') {
    const c = readCanvas(item.id, wantedVersion)
    if (c.ok) blocks.push(`<div class="canvas">${renderCanvasForItem(item, c.doc)}</div>`)
    else blocks.push(`<p class="missing">${esc(opts.fileOnly ?? w.fileOnly)}</p>`)
  } else {
    blocks.push(`<p class="missing">${esc(opts.fileOnly ?? w.fileOnly)}${p.name ? ` (${esc(p.name)})` : ''}</p>`)
  }
  if (!blocks.length) blocks.push(`<p class="missing">${esc(w.empty)}</p>`)

  const when = new Date().toLocaleString(lang === 'en' ? 'en-GB' : 'hu-HU')
  const meta = [
    project ? `${w.project}: ${esc(project.name)}` : '',
    p.version_no ? `${esc(String(p.version_no))}. ${w.version}` : '',
    `${w.generated}: ${esc(when)}`,
  ].filter(Boolean).join(' · ')
  const toolbar = opts.toolbar
    ? `<div class="bar"><button type="button" onclick="window.print()">${esc(w.print)}</button><span>${esc(w.printHint)}</span></div>`
    : ''
  const auto = opts.autoPrint ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},300)})</script>' : ''
  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(item.title)}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; color: #111; line-height: 1.5; max-width: 800px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 1.6rem; margin: 0 0 4px; }
  .meta { color: #555; font-size: 0.85rem; margin: 0 0 20px; }
  p { margin: 0 0 12px; white-space: normal; word-break: break-word; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Consolas, monospace; font-size: 0.9rem; }
  figure { margin: 0 0 16px; page-break-inside: avoid; break-inside: avoid; }
  figure img, .canvas svg { max-width: 100%; height: auto; display: block; }
  figcaption { color: #444; font-size: 0.9rem; margin-top: 4px; }
  .missing { color: #8a4b00; font-style: italic; }
  .bar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; border: 1px solid #ccc; border-radius: 8px; padding: 10px; margin: 0 0 20px; font-size: 0.85rem; color: #444; }
  .bar button { font: inherit; font-size: 1rem; padding: 8px 14px; border-radius: 6px; border: 1px solid #888; background: #fff; cursor: pointer; }
  @media print { .bar { display: none; } body { margin: 0; max-width: none; } }
</style></head><body>
${toolbar}<h1>${esc(item.title)}</h1>
<p class="meta">${meta}</p>
${blocks.join('\n')}
${auto}</body></html>`
  const safe = String(item.title || 'munkadarab').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'munkadarab'
  return { html, fileName: `${safe}${p.version_no ? ` v${p.version_no}` : ''}.html`, versionNo: p.version_no }
}

// ---------------------------------------------------------------------------
// KULDES -- tulajdonos-kattintasra azonnal, minden masra jovahagyasi kapun at
// ---------------------------------------------------------------------------

export const SEND_SUBJECT_MAX = 200
export const SEND_MESSAGE_MAX = 5000
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

type SendInputCode = 'send_bad_to' | 'send_subject_too_long' | 'send_message_too_long' | 'send_no_source' | 'send_write_failed'
type Attachment = { name: string; path: string; kind: 'source' | 'html' }

export type SendRequestResult =
  | { ok: true; approval_id: string; attachment: Attachment }
  | { ok: false; code: SendInputCode; detail?: string }

export type SendNowResult =
  | { ok: true; message_id: string; attachment: Attachment }
  | { ok: false; code: SendInputCode | 'send_no_mail_account' | 'send_failed'; detail?: string }

/** Hova kerul a csatolando export: a `store/` alatti szarmaztatott adat, NEM
 *  a felhasznalo mappaja (azt nem szemeteljuk tele kuldesi masolatokkal). */
export function exportDir(): string {
  return process.env['MARVEEN_WORKBENCH_EXPORTS'] || join(PROJECT_ROOT, 'store', 'workbench-exports')
}

type SendInput = {
  to: unknown; subject: unknown; message: unknown; attachment: unknown; version: unknown; actor: string | null; lang: Lang
}
type Prepared = { to: string; subject: string; message: string; attachment: Attachment; versionNo: number | null; versionId: string | null }

/** Ellenorzes + a melleklet elkeszitese -- mindket ut ugyanezt hasznalja. */
function prepareSend(item: WorkItemRow, input: SendInput): { ok: true; p: Prepared } | { ok: false; code: SendInputCode; detail?: string } {
  const to = String(input.to ?? '').trim()
  // Egy cimzett, ervenyes alakban. Tobb cimzett = tobb kuldes, kulon dontessel.
  if (!EMAIL_RE.test(to)) return { ok: false, code: 'send_bad_to' }
  const subject = String(input.subject ?? '').trim() || item.title
  if (subject.length > SEND_SUBJECT_MAX) return { ok: false, code: 'send_subject_too_long' }
  const message = String(input.message ?? '').trim()
  if (message.length > SEND_MESSAGE_MAX) return { ok: false, code: 'send_message_too_long' }

  const p = buildPreview(item.id, input.version)
  let attachment: Attachment
  if (input.attachment === 'source') {
    const abs = p.rel ? resolveLifePath(p.rel) : null
    let isFile = false
    try { isFile = !!abs && statSync(abs).isFile() } catch { isFile = false }
    if (!abs || !isFile) return { ok: false, code: 'send_no_source' }
    attachment = { name: basename(abs), path: abs, kind: 'source' }
  } else {
    const page = buildExportPage(item, input.version, input.lang, { toolbar: false })
    const dir = exportDir()
    const file = join(dir, `${item.id}-${Date.now()}-${page.fileName.replace(/\s+/g, '_')}`)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, page.html, 'utf-8')
    } catch (e) {
      return { ok: false, code: 'send_write_failed', detail: e instanceof Error ? e.message : String(e) }
    }
    attachment = { name: page.fileName, path: file, kind: 'html' }
  }
  return { ok: true, p: { to, subject, message, attachment, versionNo: p.version_no ?? null, versionId: p.version_id ?? null } }
}

export function requestSendApproval(item: WorkItemRow, input: SendInput): SendRequestResult {
  const prep = prepareSend(item, input)
  if (!prep.ok) return prep
  const { to, subject, message, attachment, versionNo, versionId } = prep.p

  const project = getProject(item.project_id)
  const hu = input.lang !== 'en'
  const lines = hu
    ? [
      `Munkapad: küldés emailben — projekt „${project ? project.name : item.project_id}”, munkadarab „${item.title}”${versionNo ? ` (v${versionNo})` : ''}`,
      `Címzett: ${to}`,
      `Tárgy: ${subject}`,
      message ? `Üzenet: „${message.replace(/\s+/g, ' ').slice(0, 300)}”` : 'Üzenet: (nincs)',
      `Melléklet: ${attachment.name} — ${attachment.path}`,
      input.actor ? `Kérte: ${input.actor}` : '',
      'Jóváhagyás után a fő ágens küldi el pontosan ezt; elutasításnál semmi nem megy ki.',
    ]
    : [
      `Workbench: send by email — project "${project ? project.name : item.project_id}", work item "${item.title}"${versionNo ? ` (v${versionNo})` : ''}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      message ? `Message: "${message.replace(/\s+/g, ' ').slice(0, 300)}"` : 'Message: (none)',
      `Attachment: ${attachment.name} — ${attachment.path}`,
      input.actor ? `Requested by: ${input.actor}` : '',
      'After approval the main agent sends exactly this; on rejection nothing goes out.',
    ]
  const description = lines.filter(Boolean).join(' · ')
  const id = randomUUID()
  createApproval({
    id,
    // A Munkapad a fo agens neveben dolgozik (#404 H4): a jegy gazdaja o, a
    // kuldest is o vegzi jovahagyas utan.
    agent_id: MAIN_AGENT_ID,
    category: 'email_send',
    action_description: description,
    action_payload: JSON.stringify({
      source: 'workbench', tool: 'workItem.send', project: item.project_id, workItem: item.id,
      version: versionId, input: { to, subject, message, attachment_path: attachment.path, attachment_name: attachment.name },
    }),
  })
  try {
    createAgentMessage('system', MAIN_AGENT_ID, [
      '[APPROVAL_REQUEST]', `id=${id}`, `agent=${MAIN_AGENT_ID}`, 'category=email_send', `action=${description}`, 'timeout_at=null',
    ].join(' '))
  } catch (err) {
    // A jegy megvan (a Jovahagyasok oldalon latszik), csak az ertesites nem ment ki.
    logger.warn({ err, approvalId: id }, 'workbench-export: approval notification failed')
  }
  return { ok: true, approval_id: id, attachment }
}

// --- Azonnali kuldes (csak a tulajdonos munkamenetebol) ---------------------

export interface Mail { to: string; subject: string; body: string; attachmentPath: string }
export type MailerResult = { ok: true; messageId: string } | { ok: false; error: string }
export interface SendDeps {
  /** Van-e bekotott fiok, amirol level mehet. `null` = igen; kulonben az ok. */
  mailerReady: () => string | null
  mailer: (m: Mail) => Promise<MailerResult>
}

/**
 * Van-e hasznalhato Google-fiok. Ugyanazt a tarat nezi, amit a
 * `scripts/gmail-send.py` hasznal: `store/google-tokens.json` (fiok-kulcsolt,
 * `_default`) + `store/google-oauth-client.json`; regi telepitesen a
 * `store/google-token.json`. Friss telepitesen egyik sincs -- ezt ki kell
 * mondani, nem a Python-hibaig engedni.
 */
function defaultMailerReady(): string | null {
  const store = process.env['MARVEEN_STORE'] || STORE_DIR
  if (!existsSync(join(store, 'google-oauth-client.json'))) return 'no_oauth_client'
  const tokens = join(store, 'google-tokens.json')
  if (existsSync(tokens)) {
    try {
      const t = JSON.parse(readFileSync(tokens, 'utf-8')) as Record<string, unknown>
      const acc = process.env['MARVEEN_GOOGLE_ACCOUNT'] || t['_default']
      const rec = typeof acc === 'string' ? t[acc] as Record<string, unknown> | undefined : undefined
      return rec && rec['refresh_token'] ? null : 'no_account'
    } catch {
      return 'tokens_unreadable'
    }
  }
  return existsSync(join(store, 'google-token.json')) ? null : 'no_account'
}

/** A kuldo: `scripts/gmail-send.py send` -- a torzs a `MAIL_BODY` valtozoban
 *  megy (a script ezt mar ismeri), az azonosito a `SENT OK id=` sorbol jon. */
function defaultMailer(m: Mail): Promise<MailerResult> {
  const script = join(PROJECT_ROOT, 'scripts', 'gmail-send.py')
  return new Promise((resolve) => {
    execFile('python3', [script, 'send', m.to, m.subject, m.attachmentPath], {
      timeout: 120_000, maxBuffer: 1024 * 1024, env: { ...process.env, MAIL_BODY: m.body },
    }, (err, stdout, stderr) => {
      const id = /SENT OK id=(\S+)/.exec(String(stdout))?.[1]
      if (!err && id && id !== '?') return resolve({ ok: true, messageId: id })
      const why = String(stderr || '').trim().split('\n').filter(Boolean).pop()
        || (err ? err.message : 'no message id in the sender output')
      resolve({ ok: false, error: why.slice(0, 500) })
    })
  })
}

let deps: SendDeps = { mailerReady: defaultMailerReady, mailer: defaultMailer }
/** Tesztekhez: a kuldo es a fiok-ellenorzes cserelheto (valodi level nem megy ki). */
export function _setSendDeps(d: Partial<SendDeps> = {}): void {
  deps = { mailerReady: d.mailerReady || defaultMailerReady, mailer: d.mailer || defaultMailer }
}

/**
 * A tulajdonos kattintasa: AZONNAL elkuldi. CSAK a tulajdonos munkamenetebol
 * hivhato -- ezt az utvonal donti el (`auth.kind === 'session'`), nem ez a fv.
 */
export async function sendNow(item: WorkItemRow, input: SendInput): Promise<SendNowResult> {
  // Fiok nelkul mellekletet sem keszitunk: semmi ne maradjon a store-ban hiaba.
  const why = deps.mailerReady()
  if (why) return { ok: false, code: 'send_no_mail_account', detail: why }
  const prep = prepareSend(item, input)
  if (!prep.ok) return prep
  const { to, subject, message, attachment } = prep.p
  const body = message || (input.lang === 'en' ? `Attached: ${attachment.name}` : `Csatolva: ${attachment.name}`)
  let r: MailerResult
  try {
    r = await deps.mailer({ to, subject, body, attachmentPath: attachment.path })
  } catch (e) {
    r = { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok) {
    logger.warn({ workItem: item.id, error: r.error }, 'workbench-export: direct send failed')
    return { ok: false, code: 'send_failed', detail: r.error }
  }
  logger.info({ workItem: item.id, project: item.project_id, messageId: r.messageId, actor: input.actor }, 'workbench-export: sent by owner click')
  return { ok: true, message_id: r.messageId, attachment }
}
