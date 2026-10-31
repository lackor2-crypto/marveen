// E-MAIL DRAFT OF A DOCUMENT (Boss TG, 2026-10-16): "attach the German PDF to the draft as a PDF -- and it must be
// built into Marveen, so a fresh install does it too".
//
// A document work item can have ONE e-mail draft. #725 (Boss TG 3970): no .eml file lies beside the work item at all -- the
// recipients, subject, text and sender are a database row, and the message itself goes into the Drafts folder of the chosen
// Iroda mail account (saveDraftToMailbox). Its attachments are made by Marveen, never by hand:
//   - the document itself as a PDF (the plain twin, no watermark -- what the Word copy says right now);
//   - every annex as its own PDF, named "<label> – <title>.pdf" (annex mode "separate"), or ONE PDF with the annex covers
//     (annex mode "combined").
// The page says "outdated" when the document or an annex changed since the draft was made; the next press makes the
// attachments again, so the PDF in the mail is never an older one than the text on the screen.
//
// This does NOT send anything. The owner presses send in the mail program of the Drafts folder's account.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb } from './db.js'
import { currentOwnerName, OWNER_NAME_PLACEHOLDER } from './config.js'
import { getProject } from './projects.js'
import { finishedFolderFor, freeFileName, projectFileTarget } from './project-files.js'
import { writeBlockReason } from './git-guard.js'
import { ol } from './owner-lang.js'
import { ensureWorkItemFolder } from './workbench-assets.js'
import { annexPdfs, annexAttachmentName, annexContentPdf, mergePdfs, type PackageError } from './workbench-docpackage.js'
import { docSettings, listAnnexes } from './workbench-docannex.js'
import { getProfile, itemProfileId, profileFileName } from './workbench-courtprofile.js'
import { contentHash, docLangFor, fileStem, finalFileName, letterFileStem, letterNameLang, finalLang, finalPackageFiles, finalState, renderPlainPdf, resolverFor } from './workbench-docfinal.js'
import { hasDocModel, listBlocks } from './workbench-docmodel.js'
import { detectTextLanguage, letterSubject, subjectFromLines } from './workbench-letterinfo.js'
import { variantOf } from './workbench-doclang.js'
import { docxFinalPdf, hasDocxFinalPanel } from './workbench-docxfinal.js'
import { resolveLifePath } from './life-explorer.js'
import type { DocLang } from './workbench-docrender.js'
import type { WorkItemRow } from './workbench.js'
import { saveDraft as saveMailboxDraft } from './mail-send.js'
import { listAgentMessages, listAgentSessions } from './workbench-agent/sessions.js'

// ---------------------------------------------------------------------------
// The message: pure, no I/O
// ---------------------------------------------------------------------------

export interface MailAttachment { name: string; data: Buffer; type?: string }
export interface MailInput { from?: string; to: string; cc?: string; subject: string; body: string; attachments: MailAttachment[]; boundary?: string }

const CRLF = '\r\n'
const ASCII = /^[\x20-\x7e]*$/

/** One-line header text: no line breaks, ever (a header injection stops here). */
const oneLine = (s: string): string => s.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim()

/** An RFC 2047 encoded word (UTF-8, base64), cut on character boundaries so each word stays under the 75 character limit. */
export function encodeHeaderText(raw: string): string {
  const s = oneLine(raw)
  if (ASCII.test(s)) return s
  const words: string[] = []
  let cur = ''
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch, 'utf-8') > 42) { words.push(cur); cur = '' }
    cur += ch
  }
  if (cur) words.push(cur)
  return words.map((w) => `=?utf-8?B?${Buffer.from(w, 'utf-8').toString('base64')}?=`).join(CRLF + ' ')
}

/** Base64 in 76 character lines. */
function base64Lines(b: Buffer): string {
  const all = b.toString('base64')
  const out: string[] = []
  for (let i = 0; i < all.length; i += 76) out.push(all.slice(i, i + 76))
  return out.join(CRLF)
}

/** RFC 5987 percent-encoding of one character run (parentheses, quotes and the like are encoded too). */
const pct = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** `filename` parameter lines: plain quoted for ASCII, RFC 2231 continuations (UTF-8) otherwise. */
export function fileNameParam(name: string): string {
  const n = oneLine(name).replace(/["\\]/g, '_')
  if (ASCII.test(n)) return ` filename="${n}"`
  const chunks: string[] = []
  let cur = ''
  for (const ch of n) {
    if (cur && pct(cur + ch).length > 54) { chunks.push(cur); cur = '' }
    cur += ch
  }
  if (cur) chunks.push(cur)
  return chunks.map((c, i) => ` filename*${i}*=${i === 0 ? "utf-8''" : ''}${pct(c)}`).join(';' + CRLF) + ''
}

/** An address list (comma / semicolon / space separated) cleaned to "a@x.y, b@x.y", or null when one entry is not an address. */
export function cleanAddresses(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return ''
  const parts = s.split(/[,;\s]+/).filter(Boolean)
  const ok = /^[^\s@<>(),;:"[\]\\]+@[^\s@<>(),;:"[\]\\]+\.[^\s@<>(),;:"[\]\\]+$/
  if (!parts.length || parts.some((p) => !ok.test(p))) return null
  return parts.join(', ')
}

/** The whole .eml (RFC 5322 / MIME), CRLF line ends. `X-Unsent: 1` makes the mail program open it as a draft. */
export function buildEml(input: MailInput): Buffer {
  const boundary = input.boundary || `----=_Marveen_${createHash('sha256').update(String(Date.now()) + input.subject).digest('hex').slice(0, 24)}`
  const head: string[] = []
  if (input.from) head.push(`From: ${oneLine(input.from)}`)
  if (input.to) head.push(`To: ${oneLine(input.to)}`)
  if (input.cc) head.push(`Cc: ${oneLine(input.cc)}`)
  head.push(`Subject: ${encodeHeaderText(input.subject)}`)
  head.push('X-Unsent: 1', 'MIME-Version: 1.0')
  head.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
  const text = input.body.replace(/\r\n|\r|\n/g, CRLF)
  const parts: string[] = [
    `--${boundary}${CRLF}Content-Type: text/plain; charset="utf-8"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${base64Lines(Buffer.from(text, 'utf-8'))}`,
  ]
  for (const a of input.attachments) {
    parts.push(
      `--${boundary}${CRLF}Content-Type: ${a.type || 'application/pdf'}${CRLF}Content-Transfer-Encoding: base64${CRLF}Content-Disposition: attachment;${CRLF}${fileNameParam(a.name)}${CRLF}${CRLF}${base64Lines(a.data)}`,
    )
  }
  return Buffer.from(head.join(CRLF) + CRLF + CRLF + parts.join(CRLF) + CRLF + `--${boundary}--` + CRLF, 'utf-8')
}

// ---------------------------------------------------------------------------
// The default text, in the document's own language
// ---------------------------------------------------------------------------

const DEFAULT_BODY: Record<DocLang, (title: string, annexes: number, who: string) => string> = {
  de: (title, n, who) => `Sehr geehrte Damen und Herren,\n\nanbei übersende ich Ihnen das Schreiben${title ? ` „${title}“` : ''}${n ? ` mit ${n} Anlage${n === 1 ? '' : 'n'}` : ''} als PDF-Datei${n ? 'en' : ''} im Anhang.\n\nMit freundlichen Grüßen${who ? '\n' + who : ''}`,
  en: (title, n, who) => `Dear Sir or Madam,\n\nplease find attached the letter${title ? ` "${title}"` : ''}${n ? ` with ${n} annex${n === 1 ? '' : 'es'}` : ''} as PDF file${n ? 's' : ''}.\n\nKind regards${who ? '\n' + who : ''}`,
  hu: (title, n, who) => `Tisztelt Címzett!\n\nCsatolva küldöm ${title ? `a(z) „${title}” című levelet` : 'a levelet'}${n ? ` és ${n} mellékletét` : ''} PDF-fájlként.\n\nÜdvözlettel${who ? '\n' + who : ''}`,
}

/**
 * #794 (Boss TG 3435): the work item's title is what the owner typed in HIS language ("Egy levelet akarok irni ..."), not the
 * letter's subject. The mail's subject is the subject line of the letter itself, in the letter's language: a labelled line
 * (Betreff / Subject / Tárgy / Re), else the first line after the date line of a letter. The title only when neither exists.
 */
export function mailSubject(item: WorkItemRow): string {
  if (hasDocModel(item.id)) return letterSubject(item.id)
  return hasDocxFinalPanel(item) ? subjectFromLines(docxParagraphs(item)) : ''
}

export function defaultMailBody(item: WorkItemRow, lang: DocLang, annexCount: number): string {
  const who = currentOwnerName()
  return (DEFAULT_BODY[lang] || DEFAULT_BODY.en)(mailSubject(item), annexCount, who && who !== OWNER_NAME_PLACEHOLDER ? who : '')
}

// ---------------------------------------------------------------------------
// The stored draft
// ---------------------------------------------------------------------------

let tablesDb: unknown = null
function ensureMailDraftTable(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`CREATE TABLE IF NOT EXISTS wb_doc_maildraft (
    work_item_id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    sha TEXT NOT NULL,
    package_key TEXT NOT NULL,
    from_account TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_addr TEXT NOT NULL DEFAULT '',
    cc_addr TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    attachments_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  )`)
  // A table made before the sender existed gets the two columns.
  const cols = (db.prepare('PRAGMA table_info(wb_doc_maildraft)').all() as { name: string }[]).map((c) => c.name)
  if (!cols.includes('from_account')) db.exec("ALTER TABLE wb_doc_maildraft ADD COLUMN from_account TEXT NOT NULL DEFAULT ''")
  if (!cols.includes('from_addr')) db.exec("ALTER TABLE wb_doc_maildraft ADD COLUMN from_addr TEXT NOT NULL DEFAULT ''")
  tablesDb = db
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

interface Row { from_account: string; from_addr: string; file_name: string; sha: string; package_key: string; to_addr: string; cc_addr: string; subject: string; body: string; attachments_json: string; updated_at: number }
const getRow = (itemId: string): Row | undefined => {
  ensureMailDraftTable()
  return getDb().prepare('SELECT from_account, from_addr, file_name, sha, package_key, to_addr, cc_addr, subject, body, attachments_json, updated_at FROM wb_doc_maildraft WHERE work_item_id = ?').get(itemId) as Row | undefined
}

export interface MailDraftAttachment { name: string; bytes: number; kind: 'document' | 'annex' | 'package' }
export interface MailDraftView {
  /** #725: no file is kept beside the work item any more, so both are always empty (the shape stays for old callers). */
  file: string
  file_name: string
  /** The mail account (Iroda) the draft is for, and its address (the From line). */
  from_account: string
  from_addr: string
  to: string
  cc: string
  subject: string
  body: string
  attachments: MailDraftAttachment[]
  total_bytes: number
  updated_at: number
  /** current: the attachments match the document as it is now; outdated: the document or an annex changed since. */
  state: 'current' | 'outdated'
}

/** Mail servers refuse messages above roughly this size (a base64 attachment is a third bigger than the file). */
export const MAIL_SOFT_LIMIT_BYTES = 20 * 1024 * 1024

function folderOf(item: WorkItemRow): { dirAbs: string; dirRel: string } | null {
  const project = getProject(item.project_id)
  if (!project) return null
  const folder = ensureWorkItemFolder(item)
  if (!folder.ok) return null
  // #723: a Word item's mail lies beside its final PDF, in Finished materials (Boss TG 3830), as the #719 panel put it.
  const dir = hasDocxFinalPanel(item) ? (finishedFolderFor(project, folder.folder) ?? folder.folder) : folder.folder
  const t = projectFileTarget(project, dir)
  return t.ok ? { dirAbs: t.dirAbs, dirRel: t.dirRel } : null
}

/** The draft as the page shows it, measured now (cheap: one row and one stat; nothing is rendered). Null when there is none. */
/** #794: the language the document TEXT is written in (hu / en / de), null when it cannot be told (too little text). */
/** The plain text of a Word item's file (tags stripped), '' when it cannot be read. */
function docxParagraphs(item: WorkItemRow): string[] {
  const abs = item.source_path ? resolveLifePath(item.source_path) : null
  if (!abs || !/\.docx$/i.test(abs)) return []
  try {
    const xml = execFileSync('unzip', ['-p', abs, 'word/document.xml'], { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }).toString('utf-8')
    return xml.split('</w:p>').map((p) => p.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()).filter(Boolean)
  } catch { return [] }
}
function docxPlainText(item: WorkItemRow): string { return docxParagraphs(item).join(' ') }

export function textLanguageOf(item: WorkItemRow): DocLang | null {
  const word = !hasDocModel(item.id) && hasDocxFinalPanel(item)
  if (!hasDocModel(item.id) && !word) return null
  return detectTextLanguage(word ? docxPlainText(item) : listBlocks(item.id).map((b) => b.text).join(' '))
}

/**
 * #794: the language the mail is written in = the language of the final PDF's TEXT. A language version says it (variant);
 * an original is told from its text (a German letter written under a Hungarian dashboard); the final's label only names
 * the dashboard language, so it is the last resort.
 */
export function mailLanguage(item: WorkItemRow, ui: 'hu' | 'en', final: { label: string }): DocLang {
  if (variantOf(item.id)) return docLangFor(item, ui)
  return textLanguageOf(item) ?? finalLang(final, ui)
}

/** #794: an untouched default text of another language than the current final PDF is shown in the final's language (old rows). */
/**
 * #794 (Boss TG 3441): before the title was taken out of the default text, a stored row carried "... das Schreiben „<title>“ ...".
 * Such a body that is still exactly that default is rewritten into the title-free default of its own language (nothing the
 * owner typed is touched: only an exact match counts).
 */
function legacyTitleDefaultLang(item: WorkItemRow, body: string): DocLang | null {
  const who = currentOwnerName()
  const w = who && who !== OWNER_NAME_PLACEHOLDER ? who : ''
  const max = Math.max(20, listAnnexes(item.id).length)
  for (const l of ['hu', 'en', 'de'] as DocLang[]) {
    for (let n = 0; n <= max; n++) if (body === DEFAULT_BODY[l](item.title, n, w)) return l
  }
  return null
}

function shownBody(item: WorkItemRow, stored: string): string {
  const legacy = legacyTitleDefaultLang(item, stored)
  if (legacy) {
    const body = defaultMailBody(item, currentFinalLang(item) ?? legacy, listAnnexes(item.id).length)
    try { getDb().prepare('UPDATE wb_doc_maildraft SET body = ? WHERE work_item_id = ? AND body = ?').run(body, item.id, stored) } catch { /* shown only */ }
    return body
  }
  const fl = currentFinalLang(item)
  const was = fl ? untouchedDefaultLang(item, stored) : null
  return fl && was && was !== fl ? defaultMailBody(item, fl, listAnnexes(item.id).length) : stored
}

/** Whether a file name carries the work item's title (as written, or as a court profile rewrites it with underscores). */
function namesTitle(item: WorkItemRow, name: string): boolean {
  const flat = (t: string): string => t.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
  const t = flat(item.title).replace(/^_|_$/g, '')
  return t.length >= 4 && flat(name).includes(t)
}

export function mailDraftView(item: WorkItemRow): MailDraftView | null {
  const row = getRow(item.id)
  if (!row) return null
  let attachments: MailDraftAttachment[] = []
  try { attachments = JSON.parse(row.attachments_json) as MailDraftAttachment[] } catch { /* a bad row shows no list */ }
  // #725: there is no .eml file any more; the draft lives in the account's Drafts folder, so only the document's change counts.
  // #794: an attachment named after the work item's title (made before the naming fix) is never current: pressing again renames it.
  const titled = !hasDocxFinalPanel(item) && attachments.some((a) => namesTitle(item, a.name))
  const state: MailDraftView['state'] = !titled && row.package_key === packageKey(item, row.from_account, row.to_addr, row.cc_addr, row.subject, row.body) ? 'current' : 'outdated'
  return {
    file: '', file_name: '',
    from_account: row.from_account, from_addr: row.from_addr, to: row.to_addr, cc: row.cc_addr, subject: row.subject, body: shownBody(item, row.body),
    attachments, total_bytes: attachments.reduce((n, a) => n + a.bytes, 0), updated_at: row.updated_at, state,
  }
}

/**
 * #794 (Boss TG 10451): what the mail form shows BEFORE a draft is stored -- the subject (the work item's title) and the
 * default text, in the language of the current final PDF. Nothing is stored here: the row appears when the button is pressed.
 * Null when a draft exists already, or there is no current final (the form is not offered then).
 */
/**
 * #794 (Boss TG 10459): the recipient the owner typed into the assistant chat. Only the OWNER's own messages count (never the
 * assistant's text or a tool result), the earliest one first: an address is never made up, it is taken from what was said.
 */
export function chatRecipient(item: WorkItemRow): string {
  try {
    const sessions = listAgentSessions(item.id).slice().reverse()
    for (const se of sessions) {
      for (const m of listAgentMessages(se.id, 400)) {
        if (m.role !== 'user') continue
        const hit = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/.exec(String(m.content ?? ''))
        if (hit) return hit[0]
      }
    }
  } catch { /* no chat tables yet: nothing to take */ }
  return ''
}

export function mailPrefill(item: WorkItemRow): { to: string; subject: string; body: string; lang: DocLang } | null {
  // A finalized Word item (#723): the final PDF it carries exists, the text language comes from the Word file itself.
  if (!hasDocModel(item.id) && hasDocxFinalPanel(item)) {
    if (getRow(item.id) || !docxFinalPdf(item)) return null
    const wl = textLanguageOf(item) ?? 'hu'
    return { to: chatRecipient(item), subject: mailSubject(item), body: defaultMailBody(item, wl, 0), lang: wl }
  }
  if (!hasDocModel(item.id) || hasDocxFinalPanel(item) || getRow(item.id)) return null
  const fin = finalState(item)
  if (!fin || fin.stale) return null
  const lang = mailLanguage(item, 'hu', fin)
  return { to: chatRecipient(item), subject: mailSubject(item), body: defaultMailBody(item, lang, listAnnexes(item.id).length), lang }
}

/** What the attachments are made from: the document, its annexes (name, size, time) and the mode, plus the mail's own text. */
/** The current final version (the PDFs of it are what the mail carries), '' when there is none or the text changed since. */
function currentFinalId(item: WorkItemRow): string {
  const f = finalState(item)
  return f && !f.stale ? f.version_id : ''
}

/** #723: the final PDF a Word item's mail carries (name, size, time), '' when there is none. */
function wordFinalPrint(item: WorkItemRow): string {
  const pdf = hasDocxFinalPanel(item) ? docxFinalPdf(item) : null
  if (!pdf) return ''
  try { const st = statSync(pdf.abs); return `${pdf.name}:${st.size}:${Math.floor(st.mtimeMs)}` } catch { return `${pdf.name}:missing` }
}

function packageKey(item: WorkItemRow, from: string, to: string, cc: string, subject: string, body: string): string {
  const doc = hasDocModel(item.id) ? [contentHash(item), docSettings(item.id).annex_mode, currentFinalId(item)] : []
  const word = hasDocxFinalPanel(item) ? [wordFinalPrint(item)] : []
  return sha(Buffer.from([...doc, ...word, from, to, cc, subject, body].join('\n'), 'utf-8'))
}

export type CollectResult =
  | { ok: true; files: (MailAttachment & { kind: MailDraftAttachment['kind'] })[] }
  | { ok: false; code: string; detail: string | null; label?: string }

function packageFail(e: PackageError & { ok: false }): { ok: false; code: string; detail: string | null; label?: string } {
  return { ok: false, code: e.code, detail: e.detail, label: 'label' in e ? e.label : undefined }
}

/**
 * Once the document is finalized (and unchanged since), the mail carries the FINAL package exactly as it was finalized: the
 * submission and its annexes (or the one combined file). #753: annexes not saved by the final are made now, cover + content,
 * the same as finalized (the content hash covers them). Null when there is no current final or a file is gone: the PDFs are
 * then made from the document as it is now.
 */
async function collectFinalFiles(item: WorkItemRow, ui: 'hu' | 'en'): Promise<(MailAttachment & { kind: MailDraftAttachment['kind'] })[] | null> {
  const f = finalState(item)
  if (!f || f.stale) return null
  const pkg = await finalPackageFiles(item, f, finalLang(f, ui))
  if (!pkg.ok) return null
  // #794 (Boss TG 3465/3467): a final made before the naming fix keeps its old (title based, Hungarian) name on disk, but the
  // mail names the submission from the letter itself, in the letter's language, the way a new final would be named.
  const profile = getProfile(itemProfileId(item.id))
  const total = pkg.files.length
  const stamp = new Date(f.created_at)
  // only a name that carries the work item's title is replaced: a PDF the owner already had in the folder keeps its own name
  const leaks = (n: string): boolean => namesTitle(item, n)
  return pkg.files.map((x, i) => ({
    name: x.role === 'annex' || !leaks(x.name) ? x.name : profileFileName(finalFileName(item, letterNameLang(item, ui), f.final_no, stamp), profile, i, total),
    data: x.pdf,
    kind: x.role === 'annex' ? 'annex' as const : x.role === 'bundle' ? 'package' as const : 'document' as const,
  }))
}

/** The PDFs that go with the mail, made now from the document as it is. */
export async function collectAttachments(item: WorkItemRow, ui: 'hu' | 'en'): Promise<CollectResult> {
  const finals = hasDocModel(item.id) ? await collectFinalFiles(item, ui) : null
  if (finals) return { ok: true, files: finals }
  // #723: a Word item finalized from its own panel (#719) carries that final PDF, exactly as it was made.
  if (hasDocxFinalPanel(item)) {
    const pdf = docxFinalPdf(item)
    if (pdf) {
      try { return { ok: true, files: [{ name: pdf.name, data: readFileSync(pdf.abs), kind: 'document' }] } } catch { /* gone: as if there were none */ }
    }
    if (!hasDocModel(item.id)) return { ok: false, code: 'docx_mail_no_pdf', detail: null }
  }
  const lang = docLangFor(item, ui)
  const main = await renderPlainPdf(item, ui)
  if (!main.ok) return { ok: false, code: main.code, detail: main.detail }
  const stem = fileStem(letterFileStem(item, lang))
  const resolve = resolverFor(item)
  const annexes = listAnnexes(item.id, resolve)
  if (!annexes.length) return { ok: true, files: [{ name: `${stem}.pdf`, data: main.pdf, kind: 'document' }] }
  if (!resolve) return { ok: false, code: 'annex_missing', detail: null }
  if (docSettings(item.id).annex_mode === 'combined') {
    const ax = await annexPdfs(item.id, resolve, { lang })
    if (!ax.ok) return packageFail(ax)
    const all = await mergePdfs([main.pdf, ...ax.annexes.map((a) => a.pdf)])
    if (!all.ok) return packageFail(all)
    return { ok: true, files: [{ name: `${stem}.pdf`, data: all.pdf, kind: 'package' }] }
  }
  const files: (MailAttachment & { kind: MailDraftAttachment['kind'] })[] = [{ name: `${stem}.pdf`, data: main.pdf, kind: 'document' }]
  for (const a of annexes) {
    const f = resolve(a.path)
    if (!f) return { ok: false, code: 'annex_missing', detail: a.path, label: a.label }
    const c = await annexContentPdf(f.abs, f.name)
    if (!c.ok) return { ok: false, code: c.code === 'annex_convert_failed' && c.convert ? c.convert : c.code, detail: c.detail, label: a.label }
    files.push({ name: annexAttachmentName(f.name), data: c.pdf, kind: 'annex' })
  }
  return { ok: true, files }
}

export type MailDraftOutcome =
  | { ok: true; draft: MailDraftView; written: boolean; new_file: boolean }
  | { ok: false; code: 'bad_input' | 'outline_empty' | 'no_folder' | 'write_failed' | string; detail: string | null; label?: string }

export interface MailDraftInput { from_account?: unknown; from_addr?: unknown; to?: unknown; cc?: unknown; subject?: unknown; body?: unknown }

const TEXT_MAX = 20_000
const SUBJECT_MAX = 300

/**
 * Make (or remake) the draft. The owner's explicit action: whatever the page shows is what is written. Fields left out keep
 * the stored value; with no stored value the subject is the document's title and the body a short default text in the
 * document's own language. Only the database row is written (#725: no file); the page then puts the message into the Drafts folder.
 */
export async function saveMailDraft(item: WorkItemRow, input: MailDraftInput, ui: 'hu' | 'en'): Promise<MailDraftOutcome> {
  // #723 (Boss TG 3935: "egy kodsort hasznaljunk csak"): a finalized Word item makes its mail here too, with the sender.
  if (!hasDocModel(item.id) && !hasDocxFinalPanel(item)) return { ok: false, code: 'outline_empty', detail: null }
  const prev = getRow(item.id)
  const fromAccount = input.from_account === undefined ? (prev?.from_account ?? '') : String(input.from_account).trim()
  const fromAddr = input.from_account === undefined ? (prev?.from_addr ?? '') : (cleanAddresses(input.from_addr) || '')
  const to = input.to === undefined ? (prev?.to_addr ?? '') : cleanAddresses(input.to)
  const cc = input.cc === undefined ? (prev?.cc_addr ?? '') : cleanAddresses(input.cc)
  if (to === null || cc === null) return { ok: false, code: 'bad_input', detail: 'address' }
  // #794 (Boss TG 10425/10429): the draft exists only AFTER the final PDF, and it is written in the language of THAT PDF
  // (the final's label says it), not in whatever the work item or the page happens to be in.
  const fin = hasDocModel(item.id) ? finalState(item) : null
  if (hasDocModel(item.id) && !hasDocxFinalPanel(item) && (!fin || fin.stale)) return { ok: false, code: 'final_required', detail: null }
  const lang: DocLang = fin && !fin.stale ? mailLanguage(item, ui, fin) : docLangFor(item, ui)
  const subjectRaw = input.subject === undefined ? (prev?.subject ?? '') : String(input.subject)
  const subject = oneLine(subjectRaw) || mailSubject(item)
  if (subject.length > SUBJECT_MAX) return { ok: false, code: 'bad_input', detail: 'subject' }
  const bodyRaw = input.body === undefined ? (prev ? shownBody(item, prev.body) : '') : String(input.body)
  if (bodyRaw.length > TEXT_MAX) return { ok: false, code: 'bad_input', detail: 'body' }
  const body = bodyRaw.trim() ? bodyRaw : defaultMailBody(item, lang, listAnnexes(item.id).length)

  const made = await collectAttachments(item, ui)
  if (!made.ok) return made

  const attachments: MailDraftAttachment[] = made.files.map((f) => ({ name: f.name, bytes: f.data.length, kind: f.kind }))
  ensureMailDraftTable()
  getDb().prepare(`INSERT INTO wb_doc_maildraft (work_item_id, from_account, from_addr, file_name, sha, package_key, to_addr, cc_addr, subject, body, attachments_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET from_account = excluded.from_account, from_addr = excluded.from_addr, file_name = excluded.file_name, sha = excluded.sha, package_key = excluded.package_key,
      to_addr = excluded.to_addr, cc_addr = excluded.cc_addr, subject = excluded.subject, body = excluded.body,
      attachments_json = excluded.attachments_json, updated_at = excluded.updated_at`)
    .run(item.id, fromAccount, fromAddr, '', '', packageKey(item, fromAccount, to, cc, subject, body), to, cc, subject, body, JSON.stringify(attachments), Date.now())
  const draft = mailDraftView(item)
  return draft ? { ok: true, draft, written: true, new_file: false } : { ok: false, code: 'write_failed', detail: null }
}

/**
 * Called after every refresh of the Word / PDF twin. #725: nothing to do -- no file is kept beside the item, so there is
 * nothing to remake; the page says "outdated" when the document changed, and the next press makes the attachments again.
 */
export async function refreshMailDraft(_item: WorkItemRow, _ui: 'hu' | 'en'): Promise<void> { /* nothing to remake (#725) */ }

/**
 * #794: a new final PDF (possibly in another language) starts the draft text again -- but only when the owner never touched
 * it: a stored body that is still one of the default texts (and a subject that is still the title) is dropped, so the next
 * draft is written in the language of the NEW final. A text the owner edited stays as it is.
 */
export function resetUntouchedMailText(item: WorkItemRow): boolean {
  const row = getRow(item.id)
  if (!row) return false
  if (!untouchedDefaultLang(item, row.body)) return false
  return forgetMailDraft(item.id)
}

/**
 * #794: which language's default text a stored body still is (null when the owner edited it). The annex count in the text
 * is the count at the time it was written, so every plausible count is tried, not only today's.
 */
function untouchedDefaultLang(item: WorkItemRow, body: string): DocLang | null {
  const max = Math.max(20, listAnnexes(item.id).length)
  for (const l of ['hu', 'en', 'de'] as DocLang[]) {
    for (let n = 0; n <= max; n++) if (body === defaultMailBody(item, l, n)) return l
  }
  return null
}

/** #794: the language the CURRENT final PDF is in, null when there is no current final. */
function currentFinalLang(item: WorkItemRow): DocLang | null {
  if (!hasDocModel(item.id)) return null
  const f = finalState(item)
  return f && !f.stale ? mailLanguage(item, 'hu', f) : null
}

/** Forget the stored draft row (a message already in the Drafts folder stays there). */
export function forgetMailDraft(itemId: string): boolean {
  ensureMailDraftTable()
  return getDb().prepare('DELETE FROM wb_doc_maildraft WHERE work_item_id = ?').run(itemId).changes > 0
}

/** Size of the file now, for the tests and the page (0 when it is not there). */
export function mailDraftFileBytes(item: WorkItemRow): number {
  const row = getRow(item.id)
  const dir = row && row.file_name ? folderOf(item) : null
  try { return row && dir ? statSync(join(dir.dirAbs, row.file_name)).size : 0 } catch { return 0 }
}

// ---------------------------------------------------------------------------
// Into the Drafts folder of the chosen mail account (nothing is sent)
// ---------------------------------------------------------------------------

export type MailboxSaveOutcome =
  | { ok: true; mailbox: string; account: string }
  | { ok: false; code: 'no_draft' | 'no_account' | 'save_failed' | string; detail: string | null; label?: string }

/**
 * Puts the stored draft (with its PDFs, made now) into the Drafts folder of the account chosen as the sender. It is saved as a
 * draft, never sent: the owner opens it in the mail program of that account and presses Send there.
 */
export async function saveDraftToMailbox(item: WorkItemRow, ui: 'hu' | 'en'): Promise<MailboxSaveOutcome> {
  const row = getRow(item.id)
  if (!row) return { ok: false, code: 'no_draft', detail: null }
  if (!row.from_account) return { ok: false, code: 'no_account', detail: null }
  const made = await collectAttachments(item, ui)
  if (!made.ok) return made
  const work = mkdtempSync(join(tmpdir(), 'marveen-maildraft-'))
  try {
    const files: string[] = []
    for (const f of made.files) {
      const dir = mkdtempSync(join(work, 'a-'))
      const abs = join(dir, f.name)
      writeFileSync(abs, f.data)
      files.push(abs)
    }
    // #797: the shared sender -- the same accounts as every other send (an Iroda account's Drafts folder, or a Gmail draft).
    const r = await saveMailboxDraft(row.from_account, { to: row.to_addr, cc: row.cc_addr, subject: row.subject, body: row.body, attachments: files })
    if (!r.ok) return { ok: false, code: r.code === 'unknown_account' ? 'no_account' : 'save_failed', detail: r.detail || null }
    return { ok: true, mailbox: r.mailbox || '', account: row.from_account }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* temp files only */ }
  }
}
