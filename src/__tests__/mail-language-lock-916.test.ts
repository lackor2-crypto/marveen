// Boss 2026-11-16 ("meg mindig ezt mar egyszer javitottuk ... biztonsagi zarat"): the German language version (#113) of a letter
// opened its e-mail form with the HUNGARIAN subject and text. A language version reads its ORIGINAL's context file, whose plain
// "E-mail tárgya / szövege" lines are in the original's language; sendTextFor fell back to that plain line for ANY language.
// The lock: the e-mail's subject and text are always in the language of the letter being sent -- a translation never takes the
// original's plain line, an original never takes a plain line that is clearly another language, and saving a draft whose text is
// clearly in another language is refused.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, getProject, updateProject } from '../projects.js'
import { getWorkItem } from '../workbench.js'
import { addBlock, addSection } from '../workbench-docmodel.js'
import { createVariant } from '../workbench-doclang.js'
import { setSendDetails } from '../workbench-item-context.js'
import { defaultMailBody, mailDraftView, mailSubject, mailTextFitsItem, mailTextFitsLanguage } from '../workbench-maildraft.js'
import { applySendPatch, parseSendDetails, sendTextFor } from '../workbench-send-block.js'
import { detectTextLanguage } from '../workbench-letterinfo.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

const HU_SUBJECT = 'Kérésem továbbítása a Jobcenter illetékes munkatársához – önálló vállalkozás indítása és támogatási lehetőségek'
const HU_BODY = 'Tisztelt Jäckle Asszony!\n\nMellékelten küldöm a levelemet, amelyben segítséget kérek az ügyemben, és előre is köszönöm.\n\nTisztelettel,\nKorpás László'
const DE_BODY = 'Sehr geehrte Frau Jäckle,\n\nanbei sende ich Ihnen mein Schreiben, und ich bitte Sie um Ihre Hilfe in der Sache.\n\nMit freundlichen Grüßen\nLászló Korpás'

const hu = (h: string): string => h
describe('sendTextFor: the plain line of the block is never taken for a letter of another language', () => {
  const plainHu = parseSendDetails(applySendPatch('# K\n\n## Feladat\nx\n', { subject: HU_SUBJECT, body: HU_BODY }, hu))!
  const detect = detectTextLanguage

  it('a German letter does not get the Hungarian plain body (clearly Hungarian text)', () => {
    expect(sendTextFor(plainHu, 'de', 'body', { detect })).toBe('')
  })
  it('a language VERSION does not get a plain line it cannot recognise as its own language (a short Hungarian subject)', () => {
    expect(detectTextLanguage(HU_SUBJECT)).toBeNull() // too short to tell
    expect(sendTextFor(plainHu, 'de', 'subject', { detect, strict: true })).toBe('')
  })
  it('an ORIGINAL keeps its plain line when the language of the line cannot be told or fits (nothing is lost)', () => {
    expect(sendTextFor(plainHu, 'hu', 'subject', { detect })).toBe(HU_SUBJECT)
    expect(sendTextFor(plainHu, 'hu', 'body', { detect })).toBe(HU_BODY)
  })
  it('the own-language line always wins, and a version takes a plain line that is recognised as its language', () => {
    const both = parseSendDetails(applySendPatch(applySendPatch('# K\n\n## Feladat\nx\n', { subject: HU_SUBJECT, body: HU_BODY }, hu), { subject: 'Betreff DE', body: DE_BODY, lang: 'de' }, hu))!
    expect(sendTextFor(both, 'de', 'subject', { detect, strict: true })).toBe('Betreff DE')
    const plainDe = parseSendDetails(applySendPatch('# K\n\n## Feladat\nx\n', { body: DE_BODY }, hu))!
    expect(sendTextFor(plainDe, 'de', 'body', { detect, strict: true })).toBe(DE_BODY)
  })
})

describe('mailTextFitsLanguage: the lock itself', () => {
  it('refuses a clearly wrong-language text, passes a right one and a short one it cannot tell', () => {
    expect(mailTextFitsLanguage(HU_BODY, 'de')).toBe(false)
    expect(mailTextFitsLanguage(DE_BODY, 'hu')).toBe(false)
    expect(mailTextFitsLanguage(DE_BODY, 'de')).toBe(true)
    expect(mailTextFitsLanguage(HU_BODY, 'hu')).toBe(true)
    expect(mailTextFitsLanguage('Segítségkérés', 'de')).toBe(true) // too short to tell: not locked out
  })
})

describe('the German version of a Hungarian letter opens its e-mail form in German', () => {
  let depot = ''
  let projectId = ''
  let origId = ''
  let deId = ''
  const saved: Record<string, string | undefined> = {}

  beforeEach(async () => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-maillock-'))
    for (const k of ['MARVEEN_DEPOT', 'OWNER_NAME']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['OWNER_NAME'] = 'Boss'
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    projectId = p.project.id
    if (!updateProject(projectId, { folder_path: 'Projektek/Iroda' }).ok) throw new Error('projektmappa')
    mkdirSync(join(depot, 'Projektek', 'Iroda'), { recursive: true })
    const c = await callWorkbench('/api/workbench/items', 'POST', { project_id: projectId, type: 'document', title: 'Segítségkérés' })
    origId = c.body.item.id as string
    const s = addSection(origId, 'Levél', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(origId, s.section.id, { text: 'Tisztelt Jäckle Asszony! Azt kérem, hogy segítsen nekem, és ezt a levelet küldje tovább, mert nem tudom, hogy kihez forduljak.', author: 'owner' })
    const w = setSendDetails(getWorkItem(origId)!, getProject(projectId)!, { subject: HU_SUBJECT, body: HU_BODY })
    expect(w.ok).toBe(true)
    const v = createVariant(getWorkItem(origId)!, 'de', null)
    if (!v.ok) throw new Error('nyelvi valtozat ' + v.code)
    deId = v.item.id
    const ds = addSection(deId, 'Schreiben', { status: 'done' })
    if (!ds.ok) throw new Error('de fejezet')
    addBlock(deId, ds.section.id, { text: 'Sehr geehrte Frau Jäckle, ich bitte Sie, mir zu helfen und dieses Schreiben an die zuständige Stelle weiterzuleiten, weil ich nicht weiß, an wen ich mich wenden soll.', author: 'owner' })
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(depot, { recursive: true, force: true })
  })

  it('REGRESSION: the German version never shows the original\'s Hungarian subject or text; it gets the German default', () => {
    const de = getWorkItem(deId)!
    expect(mailSubject(de)).not.toBe(HU_SUBJECT)
    expect(defaultMailBody(de, 'de', 0)).not.toContain('Tisztelt')
    expect(defaultMailBody(de, 'de', 0)).toMatch(/Sehr geehrte|Guten Tag|Mit freundlichen/)
    expect(mailTextFitsLanguage(defaultMailBody(de, 'de', 0), 'de')).toBe(true)
  })

  it('REGRESSION #931: a draft stored BEFORE the lock (Hungarian subject and text on the German version) is shown in German, never in Hungarian', () => {
    const de = getWorkItem(deId)!
    expect(mailDraftView(de)).toBeNull() // no draft yet (this also makes the table)
    getDb().prepare(`INSERT INTO wb_doc_maildraft (work_item_id, from_account, from_addr, file_name, sha, package_key, to_addr, cc_addr, subject, body, attachments_json, updated_at)
      VALUES (?, '', '', '', '', 'k', 'amt@example.de', '', ?, ?, '[]', 1)`).run(deId, HU_SUBJECT, HU_BODY)
    const v = mailDraftView(de)!
    expect(v.body).not.toContain('Tisztelt')
    expect(v.body).toMatch(/Sehr geehrte|Guten Tag|Mit freundlichen/)
    expect(v.subject).not.toBe(HU_SUBJECT)
    expect(v.state).toBe('outdated') // the stored draft in the mail folder is in the wrong language: it must be made again
  })

  it('a stored draft the owner wrote in the right language is shown untouched', () => {
    const de = getWorkItem(deId)!
    expect(mailDraftView(de)).toBeNull() // no draft yet (this also makes the table)
    getDb().prepare(`INSERT INTO wb_doc_maildraft (work_item_id, from_account, from_addr, file_name, sha, package_key, to_addr, cc_addr, subject, body, attachments_json, updated_at)
      VALUES (?, '', '', '', '', 'k', 'amt@example.de', '', 'Eigener Betreff', ?, '[]', 1)`).run(deId, DE_BODY)
    const v = mailDraftView(de)!
    expect(v.subject).toBe('Eigener Betreff')
    expect(v.body).toBe(DE_BODY)
  })

  it('REGRESSION #931: the save lock refuses the original\'s short Hungarian subject on the German version, but not on the original', () => {
    expect(mailTextFitsItem(getWorkItem(deId)!, HU_SUBJECT, 'de', 'subject')).toBe(false)
    expect(mailTextFitsItem(getWorkItem(origId)!, HU_SUBJECT, 'hu', 'subject')).toBe(true)
    expect(mailTextFitsItem(getWorkItem(deId)!, 'Bitte um Weiterleitung', 'de', 'subject')).toBe(true)
  })

  it('the Hungarian original still gets its own Hungarian subject and text', () => {
    const o = getWorkItem(origId)!
    expect(mailSubject(o)).toBe(HU_SUBJECT)
    expect(defaultMailBody(o, 'hu', 0)).toBe(HU_BODY)
  })

  it('once the German lines exist in the block, the German version shows exactly those', () => {
    const w = setSendDetails(getWorkItem(origId)!, getProject(projectId)!, { subject: 'Bitte um Weiterleitung meines Anliegens', body: DE_BODY, lang: 'de' })
    expect(w.ok).toBe(true)
    const de = getWorkItem(deId)!
    expect(mailSubject(de)).toBe('Bitte um Weiterleitung meines Anliegens')
    expect(defaultMailBody(de, 'de', 0)).toBe(DE_BODY)
  })
})

describe('the lock is wired into every way a mail text is made (wiring)', () => {
  const src = (f: string): string => readFileSync(join(__dirname, '..', f), 'utf8')
  it('saving a draft refuses a text in another language than the letter, with a clear message for the owner and for the agent', () => {
    expect(src('workbench-maildraft.ts')).toContain('mail_language_mismatch')
    expect(src('workbench-maildraft.ts')).toContain('mailTextFitsItem(item, text, lang, what)')
    expect(src('web/routes/workbench.ts')).toContain('maildraft_language_mismatch')
    expect(src('workbench-agent/execute.ts')).toContain('mail_language_mismatch')
  })
})
