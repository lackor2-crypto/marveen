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
 *     kivalasztott fiokrol, jegy nelkul. Az eredmeny igazolt: hibanal a
 *     tenyleges hibauzenet. Fiok nelkul emberi mondattal all meg.
 *   - MINDEN MAS HIVO (token, federacio, eszkoz, a Munkapad-agens eszkozei):
 *     `requestSendApproval()` a MEGLEVO jovahagyasi kapun at (`createApproval`
 *     + `[APPROVAL_REQUEST]` a fo agensnek) egy `email_send` jegyet nyit;
 *     kifele csak a tulajdonos igen-je utan megy barmi, es azt a rendszer
 *     kuldi el (`settleSendApprovals`), nem a fo agens.
 *   A ket ut kozti valasztast a SZERVER (az utvonal) teszi meg, nem a felulet.
 *
 * #797: mindket ut a KOZOS kuldon megy (src/mail-send.ts): ugyanazok a fiokok
 * (az Iroda e-mail fiokjai, es a bekotott Google-fiok), mint a dokumentum
 * levelpiszkozatanal es az Iroda levelezesnel; a sikeres kuldes a munkadarab
 * "Elkuldve" naplojaba is bekerul.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID } from './config.js'
import { createApproval, createAgentMessage, getDb, listApprovals } from './db.js'
import { sendMail, sendingAccounts, type MailSendResult, type OutgoingMail, type SendingAccount } from './mail-send.js'
import { markSentManually, recordSent } from './workbench-docsent.js'
import { logger } from './logger.js'
import { resolveLifePath } from './life-explorer.js'
import { getProject } from './projects.js'
import { fileKind } from './file-kind.js'
import { buildPreview } from './workbench-preview.js'
import { readCanvas, renderCanvasForItem } from './workbench-canvas-store.js'
import { getWorkItem, listWorkItemParts, type WorkItemRow } from './workbench.js'

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
export function buildExportPage(item: WorkItemRow, wantedVersion: unknown, lang: Lang, opts: { toolbar?: boolean; autoPrint?: boolean; fileOnly?: string; docHtml?: string } = {}): ExportPage {
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

  if (opts.docHtml) {
    // #719 (Boss TG 3836): a Word item prints as its own text and pictures (LibreOffice's HTML of the document).
    const styles = (opts.docHtml.match(/<style\b[\s\S]*?<\/style\s*>/gi) || []).map((x) => x.replace(/@page\s*[^{]*\{[^}]*\}/gi, '')).join('\n')
    const body = (opts.docHtml.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i) || [, opts.docHtml])[1] || ''
    blocks.push(`${styles}<div class="docbody">${body}</div>`)
  } else if (p.kind === 'parts' || (!p.available && p.reason === 'no_source')) {
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
  .docbody p, .docbody h1, .docbody h2, .docbody h3, .docbody li { position: relative; }
  .docbody img { max-width: none; }
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

type AccountCode = 'send_no_mail_account' | 'send_bad_account'

export type SendRequestResult =
  | { ok: true; approval_id: string; attachment: Attachment }
  | { ok: false; code: SendInputCode | AccountCode; detail?: string }

export type SendNowResult =
  | { ok: true; message_id: string; from: string; sent_logged: 'recorded' | 'marked'; attachment: Attachment }
  | { ok: false; code: SendInputCode | AccountCode | 'send_failed'; detail?: string }

/** Hova kerul a csatolando export: a `store/` alatti szarmaztatott adat, NEM
 *  a felhasznalo mappaja (azt nem szemeteljuk tele kuldesi masolatokkal). */
export function exportDir(): string {
  return process.env['MARVEEN_WORKBENCH_EXPORTS'] || join(PROJECT_ROOT, 'store', 'workbench-exports')
}

type SendInput = {
  to: unknown; subject: unknown; message: unknown; attachment: unknown; version: unknown; actor: string | null; lang: Lang
  /** #779: the item's own document HTML (the document page's render, or a Word file's), so the sent page is the same as the export. */
  docHtml?: string
  /** #797: the sender account (an id from the shared list, /api/mail/sending-accounts); none = the first one. */
  from_account?: unknown
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
    const page = buildExportPage(item, input.version, input.lang, { toolbar: false, docHtml: input.docHtml })
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
  const acc = pickAccount(input.from_account)
  if (!acc.ok) return acc
  const from = acc.account
  const prep = prepareSend(item, input)
  if (!prep.ok) return prep
  const { to, subject, message, attachment, versionNo, versionId } = prep.p

  const project = getProject(item.project_id)
  const hu = input.lang !== 'en'
  const lines = hu
    ? [
      `Munkapad: küldés emailben — projekt „${project ? project.name : item.project_id}”, munkadarab „${item.title}”${versionNo ? ` (v${versionNo})` : ''}`,
      `Feladó: ${from.address || from.id}`,
      `Címzett: ${to}`,
      `Tárgy: ${subject}`,
      message ? `Üzenet: „${message.replace(/\s+/g, ' ').slice(0, 300)}”` : 'Üzenet: (nincs)',
      `Melléklet: ${attachment.name} — ${attachment.path}`,
      input.actor ? `Kérte: ${input.actor}` : '',
      'Jóváhagyás után a rendszer maga küldi el pontosan ezt (a fő ágensnek nincs teendője); elutasításnál semmi nem megy ki.',
    ]
    : [
      `Workbench: send by email — project "${project ? project.name : item.project_id}", work item "${item.title}"${versionNo ? ` (v${versionNo})` : ''}`,
      `From: ${from.address || from.id}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      message ? `Message: "${message.replace(/\s+/g, ' ').slice(0, 300)}"` : 'Message: (none)',
      `Attachment: ${attachment.name} — ${attachment.path}`,
      input.actor ? `Requested by: ${input.actor}` : '',
      'After approval the system itself sends exactly this (nothing for the main agent to do); on rejection nothing goes out.',
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
      // #797: the server sends it on approval (settleSendApprovals), from this account; an older ticket without the flag
      // is left to the main agent as before.
      server_sends: true, from_account: from.id, actor: input.actor, lang: input.lang,
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

// --- A kozos kuldo (#797) ------------------------------------------------------

export interface SendDeps {
  /** The accounts a mail can go out from (the shared list). */
  accounts: () => SendingAccount[]
  send: (accountId: string, mail: OutgoingMail) => Promise<MailSendResult>
}
let deps: SendDeps = { accounts: sendingAccounts, send: sendMail }
/** Tesztekhez: a kuldo es a fiok-lista cserelheto (valodi level nem megy ki). */
export function _setSendDeps(d: Partial<SendDeps> = {}): void {
  deps = { accounts: d.accounts || sendingAccounts, send: d.send || sendMail }
}

/** The sender: the one asked for, or (none asked) the first of the shared list. No account = an honest stop, not a Python error. */
function pickAccount(wanted: unknown): { ok: true; account: SendingAccount } | { ok: false; code: AccountCode; detail?: string } {
  const accounts = deps.accounts()
  if (!accounts.length) return { ok: false, code: 'send_no_mail_account', detail: 'no_account' }
  const id = typeof wanted === 'string' ? wanted.trim() : ''
  if (!id) return { ok: true, account: accounts[0] }
  const found = accounts.find((a) => a.id === id)
  return found ? { ok: true, account: found } : { ok: false, code: 'send_bad_account', detail: id }
}

function pad2(n: number): string { return String(n).padStart(2, '0') }

/**
 * The sending goes on the work item's "Sent" log: with a current final, as a sending of that final (date, time, recipient,
 * by e-mail); without one, the item is marked as sent (the same mark the owner can set by hand).
 */
function logSending(item: WorkItemRow, s: { to: string; subject: string; attachment: Attachment; from: string; actor: string | null }): 'recorded' | 'marked' {
  const now = new Date()
  const note = `${s.attachment.name} (${s.from})`.slice(0, 300)
  try {
    const rec = recordSent(item, {
      date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`, time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
      recipient: s.to, method: 'email', reference: s.subject.slice(0, 300), note,
    }, s.actor)
    if (rec.ok) return 'recorded'
  } catch (err) {
    logger.warn({ err, workItem: item.id }, 'workbench-export: recording the sending failed')
  }
  try { markSentManually(item.id, s.actor) } catch (err) { logger.warn({ err, workItem: item.id }, 'workbench-export: marking the item sent failed') }
  return 'marked'
}

async function deliver(item: WorkItemRow, acc: SendingAccount, p: { to: string; subject: string; message: string; attachment: Attachment }, lang: Lang, actor: string | null): Promise<SendNowResult> {
  const body = p.message || (lang === 'en' ? `Attached: ${p.attachment.name}` : `Csatolva: ${p.attachment.name}`)
  let r: MailSendResult
  try {
    r = await deps.send(acc.id, { to: p.to, subject: p.subject, body, attachments: [p.attachment.path] })
  } catch (e) {
    r = { ok: false, code: 'send_failed', detail: e instanceof Error ? e.message : String(e) }
  }
  if (!r.ok) {
    logger.warn({ workItem: item.id, account: acc.id, error: r.detail }, 'workbench-export: send failed')
    return { ok: false, code: r.code === 'unknown_account' ? 'send_bad_account' : 'send_failed', detail: r.detail }
  }
  const from = acc.address || acc.id
  const sentLogged = logSending(item, { to: p.to, subject: p.subject, attachment: p.attachment, from, actor })
  logger.info({ workItem: item.id, project: item.project_id, account: acc.id, messageId: r.messageId, actor }, 'workbench-export: sent')
  return { ok: true, message_id: r.messageId || '', from, sent_logged: sentLogged, attachment: p.attachment }
}

/**
 * A tulajdonos kattintasa: AZONNAL elkuldi. CSAK a tulajdonos munkamenetebol
 * hivhato -- ezt az utvonal donti el (`auth.kind === 'session'`), nem ez a fv.
 */
export async function sendNow(item: WorkItemRow, input: SendInput): Promise<SendNowResult> {
  // Fiok nelkul mellekletet sem keszitunk: semmi ne maradjon a store-ban hiaba.
  const acc = pickAccount(input.from_account)
  if (!acc.ok) return acc
  const prep = prepareSend(item, input)
  if (!prep.ok) return prep
  return deliver(item, acc.account, prep.p, input.lang, input.actor)
}

// --- A jovahagyott kuldes: a rendszer kuldi el (#797) --------------------------

function ensureSettledTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS wb_send_approval_done (
    approval_id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL)`)
}

/**
 * After the owner approved a Workbench send ticket (`server_sends`), the mail goes out here, exactly as asked: from the
 * account, to the recipient, with the attachment prepared at the request. One ticket, one send: the row is claimed before
 * sending (a second call finds it taken). Called when an approval is decided (routes/approvals.ts).
 */
export async function settleSendApprovals(): Promise<number> {
  ensureSettledTable()
  let rows: { id: string; category: string; action_payload: string | null }[]
  try {
    rows = listApprovals({ status: 'approved', category: 'email_send', limit: 200 }) as { id: string; category: string; action_payload: string | null }[]
  } catch {
    return 0
  }
  let done = 0
  for (const a of rows) {
    if (a.category !== 'email_send') continue
    let p: { source?: unknown; tool?: unknown; server_sends?: unknown; workItem?: unknown; from_account?: unknown; actor?: unknown; lang?: unknown; input?: { to?: unknown; subject?: unknown; message?: unknown; attachment_path?: unknown; attachment_name?: unknown } } = {}
    try { p = JSON.parse(a.action_payload || '{}') } catch { continue }
    if (p.source !== 'workbench' || p.tool !== 'workItem.send' || p.server_sends !== true || typeof p.workItem !== 'string') continue
    const claimed = getDb().prepare('INSERT OR IGNORE INTO wb_send_approval_done (approval_id, work_item_id, outcome, at) VALUES (?, ?, ?, ?)')
      .run(a.id, p.workItem, 'sending', Date.now()).changes === 1
    if (!claimed) continue
    done++
    const finish = (outcome: string, detail: string | null): void => {
      getDb().prepare('UPDATE wb_send_approval_done SET outcome = ?, detail = ?, at = ? WHERE approval_id = ?').run(outcome, detail, Date.now(), a.id)
    }
    const item = getWorkItem(p.workItem)
    const inp = p.input || {}
    const path = typeof inp.attachment_path === 'string' ? inp.attachment_path : ''
    if (!item || !path || !existsSync(path)) { finish('failed', !item ? 'work item gone' : 'attachment gone'); logger.warn({ approvalId: a.id }, 'workbench-export: approved send not possible'); continue }
    const accounts = deps.accounts()
    const acc = accounts.find((x) => x.id === p.from_account)
    if (!acc) { finish('failed', `sender account "${String(p.from_account)}" not connected`); logger.warn({ approvalId: a.id }, 'workbench-export: approved send, account gone'); continue }
    const att: Attachment = { name: typeof inp.attachment_name === 'string' ? inp.attachment_name : basename(path), path, kind: 'html' }
    const r = await deliver(item, acc, { to: String(inp.to ?? ''), subject: String(inp.subject ?? ''), message: String(inp.message ?? ''), attachment: att }, p.lang === 'en' ? 'en' : 'hu', typeof p.actor === 'string' ? p.actor : null)
    finish(r.ok ? 'sent' : 'failed', r.ok ? r.message_id : (r.detail || r.code))
  }
  return done
}

/** What became of an approved send ticket (null = not settled here). */
export function sendApprovalOutcome(approvalId: string): { outcome: string; detail: string | null } | null {
  ensureSettledTable()
  const r = getDb().prepare('SELECT outcome, detail FROM wb_send_approval_done WHERE approval_id = ?').get(approvalId) as { outcome: string; detail: string | null } | undefined
  return r || null
}
