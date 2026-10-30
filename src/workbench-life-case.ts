// #794 (Boss TG 3638): a correspondence case in the Life tree holds four folders: Kérelem (the application itself),
// Bejövő levelek (what the authority writes to the owner), Kimenő levelek (what the owner writes out) and Egyéb (anything
// else: notes, an AI answer overview, a stray photo). Every file of a case goes into ONE of them, chosen by what the
// document IS (its content, not only its name). "Egyéb" is made ONCE: if the owner deletes or renames it, it is not made
// again (the file then goes to the case folder itself).

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { resolveLifePath } from './life-explorer.js'
import { flat } from './workbench-life-context.js'

export type CaseKind = 'request' | 'incoming' | 'outgoing' | 'other'

export const CASE_FOLDER: Record<CaseKind, string> = {
  request: 'Kérelem',
  incoming: 'Bejövő levelek',
  outgoing: 'Kimenő levelek',
  other: 'Egyéb',
}

const NOTE_EXT = /\.(md|txt|json|csv|log)$/i
const NOTE_WORDS = ['gpt', 'chatgpt', 'jegyzet', 'notes', 'attekintes', 'overview', 'osszefoglalo', 'summary', 'draft', 'vazlat']
const REQUEST_WORDS = ['antrag', 'kerelem', 'wohngeldantrag', 'application']
const INCOMING_WORDS = ['bescheid', 'anhorung', 'aufforderung', 'nachforderung', 'ihr schreiben', 'sehr geehrte', 'rechtsbehelfsbelehrung', 'bewilligung', 'ablehnung', 'eingangsbestatigung', 'bestatigung']
const OUTGOING_WORDS = ['antwort', 'valasz', 'widerspruch', 'vitatas', 'mit freundlichen grussen', 'hianypotlas', 'nachreichung', 'nachgereicht']

/**
 * What a document of the case is. `text` = the words read from the file (docx / pdf / OCR), '' when nothing could be read.
 * The sent version of a generated letter is outgoing by definition (the caller says so).
 */
export function classifyCaseKind(name: string, text: string, outgoing: boolean): CaseKind {
  if (outgoing) return 'outgoing'
  const n = flat(name)
  const body = flat(String(text || '').slice(0, 6000))
  const has = (hay: string, words: string[]): boolean => words.some((w) => hay.includes(w))
  if (NOTE_EXT.test(name) || has(n, NOTE_WORDS)) return 'other'
  // A reply letter names its addressee in the first lines; check the name first, it is the clearest signal we have.
  if (has(n, OUTGOING_WORDS)) return 'outgoing'
  if (has(n, REQUEST_WORDS) && !has(n, INCOMING_WORDS)) return 'request'
  if (has(n, INCOMING_WORDS)) return 'incoming'
  if (body) {
    const head = body.slice(0, 1500)
    if (has(head, INCOMING_WORDS)) return 'incoming'
    if (has(head, OUTGOING_WORDS)) return 'outgoing'
    if (has(head, REQUEST_WORDS)) return 'request'
  }
  return 'other'
}

function subDirs(abs: string): string[] {
  try { return readdirSync(abs).filter((e) => { try { return statSync(join(abs, e)).isDirectory() } catch { return false } }) } catch { return [] }
}

const STANDARD = [CASE_FOLDER.request, CASE_FOLDER.incoming, CASE_FOLDER.outgoing]

/** The case folders of an office: the subfolders that hold at least one of the standard case folders. */
export function caseFoldersIn(officeRel: string): string[] {
  const dir = resolveLifePath(officeRel)
  if (!dir) return []
  return subDirs(dir).filter((c) => subDirs(join(dir, c)).some((s) => STANDARD.includes(s)))
}

function extraFile(): string { return join(STORE_DIR, 'life-case-extra.json') }
function readMade(): string[] {
  try { const v = JSON.parse(readFileSync(extraFile(), 'utf8')); return Array.isArray(v) ? v.map(String) : [] } catch { return [] }
}
/** True when "Egyéb" was already made once for this case (and so must not be made again). */
export function extraWasMade(caseRel: string): boolean { return readMade().includes(caseRel) }
function recordMade(caseRel: string): void {
  try { const all = readMade(); if (!all.includes(caseRel)) { all.push(caseRel); writeFileSync(extraFile(), JSON.stringify(all, null, 2)) } } catch { /* the folder exists; the note is only a memory aid */ }
}

/**
 * Where, inside the case folder, a document of this kind goes. Returns the Life-tree path, or '' when the case folder
 * has no such place (the caller then keeps the case folder itself). "Egyéb" may be proposed although it does not exist
 * yet, but only the first time for this case.
 */
export function casePlaceFor(caseRel: string, kind: CaseKind): string {
  const dir = resolveLifePath(caseRel)
  if (!dir) return ''
  const want = CASE_FOLDER[kind]
  const sub = `${caseRel}/${want}`
  const subAbs = join(dir, want)
  if (existsSync(subAbs)) { if (kind === 'other') recordMade(caseRel); return sub }
  if (kind === 'other' && !extraWasMade(caseRel)) return sub
  return ''
}

/**
 * Called when a row is about to move: if the target is a case's "Egyéb" folder that is not there yet and was never made,
 * make it now (once). Any other missing target is left alone (moveLife refuses it with its own message).
 */
export function ensureExtraFolderOnce(targetRel: string): void {
  const parts = targetRel.split('/')
  if (parts.pop() !== CASE_FOLDER.other) return
  const caseRel = parts.join('/')
  const abs = resolveLifePath(targetRel)
  const caseAbs = resolveLifePath(caseRel)
  if (!abs || !caseAbs || existsSync(abs) || extraWasMade(caseRel)) return
  if (!subDirs(caseAbs).some((s) => STANDARD.includes(s))) return
  try { mkdirSync(abs); recordMade(caseRel) } catch { /* moveLife reports it */ }
}
