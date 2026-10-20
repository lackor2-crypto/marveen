// E-MAIL DRAFT OF A DOCUMENT (Boss TG, 2026-10-16): "attach the German PDF to the draft as a PDF -- and it must be
// built into Marveen, so a fresh install does it too".
//
// A document work item can have ONE e-mail draft: an .eml file (X-Unsent: 1, so Outlook / Thunderbird / Apple Mail open it
// as a message still to be sent) lying in the item's own folder. Its attachments are made by Marveen, never by hand:
//   - the document itself as a PDF (the plain twin, no watermark -- what the Word copy says right now);
//   - every annex as its own PDF, named "<label> – <title>.pdf" (annex mode "separate"), or ONE PDF with the annex covers
//     (annex mode "combined").
// The draft is a MIRROR like the Word copy: whenever the document or an annex changes, the attachments are rebuilt, so the
// PDF in the mail is never an older one than the text on the screen. A file the owner edited or saved elsewhere (its hash
// differs from what we wrote) is left alone; an explicit "make it" then writes a new file next to it, nothing is overwritten.
//
// This does NOT send anything. The owner opens the .eml and presses send in the mail program, or has it put into the
// Drafts folder of the chosen Iroda mail account (saveDraftToMailbox: still nothing is sent).

import { createHash } from 'node:crypto'
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
import { annexPdfs, annexContentPdf, mergePdfs, type PackageError } from './workbench-docpackage.js'
import { docSettings, listAnnexes } from './workbench-docannex.js'
import { contentHash, docLangFor, fileStem, finalState, renderPlainPdf, resolverFor } from './workbench-docfinal.js'
import { hasDocModel } from './workbench-docmodel.js'
import { docxFinalPdf, hasDocxFinalPanel } from './workbench-docxfinal.js'
import type { DocLang } from './workbench-docrender.js'
import type { WorkItemRow } from './workbench.js'

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
  de: (title, n, who) => `Sehr geehrte Damen und Herren,\n\nanbei übersende ich Ihnen das Schreiben „${title}“${n ? ` mit ${n} Anlage${n === 1 ? '' : 'n'}` : ''} als PDF-Datei${n ? 'en' : ''} im Anhang.\n\nMit freundlichen Grüßen${who ? '\n' + who : ''}`,
  en: (title, n, who) => `Dear Sir or Madam,\n\nplease find attached the letter "${title}"${n ? ` with ${n} annex${n === 1 ? '' : 'es'}` : ''} as PDF file${n ? 's' : ''}.\n\nKind regards${who ? '\n' + who : ''}`,
  hu: (title, n, who) => `Tisztelt Címzett!\n\nCsatolva küldöm a(z) „${title}” című levelet${n ? ` és ${n} mellékletét` : ''} PDF-fájlként.\n\nÜdvözlettel${who ? '\n' + who : ''}`,
}

export function defaultMailBody(item: WorkItemRow, lang: DocLang, annexCount: number): string {
  const who = currentOwnerName()
  return (DEFAULT_BODY[lang] || DEFAULT_BODY.en)(item.title, annexCount, who && who !== OWNER_NAME_PLACEHOLDER ? who : '')
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
  /** Where the file lies (project-relative), and its name. */
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
  /** ok: the file is the one we wrote and it matches the document; the rest says what the owner must do. */
  state: 'current' | 'outdated' | 'edited' | 'missing'
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
export function mailDraftView(item: WorkItemRow): MailDraftView | null {
  const row = getRow(item.id)
  if (!row) return null
  let attachments: MailDraftAttachment[] = []
  try { attachments = JSON.parse(row.attachments_json) as MailDraftAttachment[] } catch { /* a bad row shows no list */ }
  // #725: there is no .eml file any more; the draft lives in the account's Drafts folder, so only the document's change counts.
  const state: MailDraftView['state'] = row.package_key === packageKey(item, row.from_account, row.to_addr, row.cc_addr, row.subject, row.body) ? 'current' : 'outdated'
  return {
    file: '', file_name: '',
    from_account: row.from_account, from_addr: row.from_addr, to: row.to_addr, cc: row.cc_addr, subject: row.subject, body: row.body,
    attachments, total_bytes: attachments.reduce((n, a) => n + a.bytes, 0), updated_at: row.updated_at, state,
  }
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

const NAME_MAX = 120

/**
 * An annex attachment's file name stem: "<label> – <title>". When it is too long it is cut at a word, and an opened bracket
 * is dropped with it, so a name never ends in the middle of a word ("(Éva Bako") the recipient would see.
 */
export function annexFileStem(label: string, title: string): string {
  const all = fileStem(`${label} – ${title}`, 10_000)
  if (all.length <= NAME_MAX) return all
  let cut = all.slice(0, NAME_MAX)
  if (all[NAME_MAX] !== ' ') cut = cut.slice(0, Math.max(cut.lastIndexOf(' '), label.length))
  const open = cut.lastIndexOf('(')
  if (open > cut.lastIndexOf(')') && open > label.length) cut = cut.slice(0, open)
  return cut.replace(/[\s,;.–-]+$/u, '')
}

/**
 * Once the document is finalized (and unchanged since), the mail carries the FINAL PDFs exactly as they were made: the
 * submission and its annexes (or the one combined file). Null when there is no current final or a file is gone: the PDFs are
 * then made from the document as it is now.
 */
function collectFinalFiles(item: WorkItemRow): (MailAttachment & { kind: MailDraftAttachment['kind'] })[] | null {
  const f = finalState(item)
  if (!f || f.stale) return null
  const resolve = resolverFor(item)
  const list = f.files && f.files.length ? f.files : [{ path: f.pdf_path, name: f.pdf_name, role: 'main' as const }]
  if (!resolve) return null
  const out: (MailAttachment & { kind: MailDraftAttachment['kind'] })[] = []
  for (const x of list) {
    const r = resolve(x.path)
    if (!r) return null
    try { out.push({ name: x.name, data: readFileSync(r.abs), kind: x.role === 'annex' ? 'annex' : x.role === 'bundle' ? 'package' : 'document' }) } catch { return null }
  }
  return out
}

/** The PDFs that go with the mail, made now from the document as it is. */
export async function collectAttachments(item: WorkItemRow, ui: 'hu' | 'en'): Promise<CollectResult> {
  const finals = hasDocModel(item.id) ? collectFinalFiles(item) : null
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
  const stem = fileStem(item.title)
  const resolve = resolverFor(item)
  const annexes = listAnnexes(item.id, resolve)
  if (!annexes.length) return { ok: true, files: [{ name: `${stem}.pdf`, data: main.pdf, kind: 'document' }] }
  if (!resolve) return { ok: false, code: 'annex_missing', detail: null }
  if (docSettings(item.id).annex_mode === 'combined') {
    const ax = await annexPdfs(item.id, resolve, { lang: lang === 'hu' ? 'hu' : 'en' })
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
    files.push({ name: `${annexFileStem(a.label, a.title)}.pdf`, data: c.pdf, kind: 'annex' })
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
 * document's own language. A file the owner changed is not overwritten: the new one gets a free name next to it.
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
  const lang = docLangFor(item, ui)
  const subjectRaw = input.subject === undefined ? (prev?.subject ?? '') : String(input.subject)
  const subject = oneLine(subjectRaw) || item.title
  if (subject.length > SUBJECT_MAX) return { ok: false, code: 'bad_input', detail: 'subject' }
  const bodyRaw = input.body === undefined ? (prev?.body ?? '') : String(input.body)
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
 * The automatic part, called after every refresh of the Word / PDF twin: when the item has a draft that we wrote, nobody
 * touched, and the document (or an annex) has changed since, the attachments are made again -- the mail never carries an
 * older PDF than the text. Best effort and silent: a failure leaves the old file, and the page says "outdated".
 */
export async function refreshMailDraft(_item: WorkItemRow, _ui: 'hu' | 'en'): Promise<void> {
  // #725: no file is kept beside the item any more, so there is nothing to remake; the page says "outdated" when the document changed.
}

/** Stop tracking (the file itself stays where it is). */
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

export interface MailboxDraftPort {
  save(account: string, msg: { to: string; cc: string; subject: string; body: string; files: string[] }): Promise<{ ok: boolean; mailbox?: string; detail?: string }>
}
let mailboxPort: MailboxDraftPort | null = null
/** The e-mail routes register how a message is saved into an account's Drafts folder (this module does not know the mail client). */
export function registerMailboxDraftPort(p: MailboxDraftPort): void { mailboxPort = p }

export type MailboxSaveOutcome =
  | { ok: true; mailbox: string; account: string }
  | { ok: false; code: 'no_draft' | 'no_account' | 'no_port' | 'save_failed' | string; detail: string | null; label?: string }

/**
 * Puts the stored draft (with its PDFs, made now) into the Drafts folder of the account chosen as the sender. It is saved as a
 * draft, never sent: the owner opens it in the mail program of that account and presses Send there.
 */
export async function saveDraftToMailbox(item: WorkItemRow, ui: 'hu' | 'en'): Promise<MailboxSaveOutcome> {
  const row = getRow(item.id)
  if (!row) return { ok: false, code: 'no_draft', detail: null }
  if (!row.from_account) return { ok: false, code: 'no_account', detail: null }
  if (!mailboxPort) return { ok: false, code: 'no_port', detail: null }
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
    const r = await mailboxPort.save(row.from_account, { to: row.to_addr, cc: row.cc_addr, subject: row.subject, body: row.body, files })
    return r.ok ? { ok: true, mailbox: r.mailbox || '', account: row.from_account } : { ok: false, code: 'save_failed', detail: r.detail || null }
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* temp files only */ }
  }
}
