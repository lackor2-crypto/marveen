// The e-mail draft of a document (Boss TG, 2026-10-16): the document and its annexes as PDF attachments, made by Marveen,
// so a fresh install attaches the current PDF without anybody doing it by hand. #725: no .eml file lies beside the work
// item; the draft is a row and goes into the Drafts folder of the chosen account.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleParser } from 'mailparser'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { addBlock, addSection, updateBlock } from '../workbench-docmodel.js'
import { addAnnex, setDocSettings } from '../workbench-docannex.js'
import { contentHash, finalizeDocument, recordReview, resolverFor } from '../workbench-docfinal.js'
import { mirrorOutlineToFile } from '../workbench-docmirror.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { attachAsset, markPlainItem } from '../workbench-assets.js'
import { finalizeWorkItem } from '../workbench-approval.js'
import { annexFileStem, buildEml, cleanAddresses, encodeHeaderText, forgetMailDraft, mailDraftView, resetUntouchedMailText, saveDraftToMailbox, saveMailDraft } from '../workbench-maildraft.js'
import { registerMailboxEngine, _setGoogleEngine } from '../mail-send.js'

/** A fake LibreOffice: the PDF it writes carries a checksum of the source, so any change of the text shows in the bytes. */
const FAKE_SOFFICE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 test"; exit 0; fi
out=""; prev=""; src=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"; src="$a"
done
printf '%%PDF-1.4 SRC-%s\\n' "$(cksum < "$src" | tr ' ' '-')" > "$out/doc.pdf"
exit 0
`

/** A fake pdfunite: the inputs one after the other (the test PDFs are not real PDFs). */
const FAKE_PDFUNITE = `#!/bin/sh
out=""; for a in "$@"; do out="$a"; done
: > "$out"
for a in "$@"; do [ "$a" = "$out" ] || { cat "$a" >> "$out"; printf '\\n--\\n' >> "$out"; }; done
exit 0
`

describe('buildEml (pure)', () => {
  it('round-trips subject, addresses, body and attachments with accented and long names', async () => {
    const longName = 'Anlage K13 – Mietvertrag für die Wohnung Erich-Steinfurth-Straße 25, 09131 Chemnitz (Mietbeginn 15.06.2017) – Korpás László.pdf'
    const pdfA = Buffer.from('%PDF-1.7 \u0000\u0001ÿ binary', 'latin1')
    const pdfB = Buffer.alloc(5000, 7)
    const eml = buildEml({
      to: 'wohngeld@stadt-chemnitz.de', cc: 'a@x.de, b@y.de',
      subject: 'Wohngeldnummer 511000/25398636 – Nachreichung fehlender Unterlagen – Korpás László',
      body: 'Sehr geehrte Frau Teege,\n\nanbei übersende ich …\n\nMit freundlichen Grüßen',
      attachments: [{ name: 'Antwort (final).pdf', data: pdfA }, { name: longName, data: pdfB }],
    })
    expect(eml.toString('utf-8')).toMatch(/^To: wohngeld@stadt-chemnitz\.de\r\n/)
    expect(eml.toString('utf-8')).toContain('X-Unsent: 1\r\n')
    // no header line over 998, and the raw message is 7-bit clean (everything non-ASCII is encoded)
    expect(eml.toString('latin1')).toMatch(/^[\x00-\x7f]*$/)
    for (const line of eml.toString('utf-8').split('\r\n')) expect(line.length).toBeLessThanOrEqual(998)
    const m = await simpleParser(eml)
    expect(m.subject).toBe('Wohngeldnummer 511000/25398636 – Nachreichung fehlender Unterlagen – Korpás László')
    expect((m.to as { text: string }).text).toBe('wohngeld@stadt-chemnitz.de')
    expect((m.cc as { text: string }).text).toBe('a@x.de, b@y.de')
    expect(m.text).toContain('Mit freundlichen Grüßen')
    expect(m.attachments.map((a) => a.filename)).toEqual(['Antwort (final).pdf', longName])
    expect(m.attachments[0]!.content.equals(pdfA)).toBe(true)
    expect(m.attachments[1]!.content.equals(pdfB)).toBe(true)
    expect(m.attachments[0]!.contentType).toBe('application/pdf')
  })

  it('a line break in the subject cannot add a header', async () => {
    const eml = buildEml({ to: 'a@x.de', subject: 'Hello\r\nBcc: evil@x.de', body: 'x', attachments: [] })
    const m = await simpleParser(eml)
    expect(m.headers.get('bcc')).toBeUndefined()
    expect(m.subject).toBe('Hello Bcc: evil@x.de')
  })

  it('encodes only what needs it', () => {
    expect(encodeHeaderText('Plain subject')).toBe('Plain subject')
    expect(encodeHeaderText('Árvíztűrő')).toMatch(/^=\?utf-8\?B\?/)
  })

  it('cleans address lists and refuses a non-address', () => {
    expect(cleanAddresses('')).toBe('')
    expect(cleanAddresses(' a@x.de ; b@y.de,c@z.hu ')).toBe('a@x.de, b@y.de, c@z.hu')
    expect(cleanAddresses('not an address')).toBeNull()
    expect(cleanAddresses('a@x.de, <b>')).toBeNull()
  })
})

describe('the e-mail draft of a work item', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const saved: Record<string, string | undefined> = {}
  const projDir = () => join(depot, 'Projektek', 'Iroda')

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-maildraft-'))
    mkdirSync(join(projDir(), 'Iratok'), { recursive: true })
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE', 'MARVEEN_PDFUNITE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    for (const [name, body, env] of [['soffice.sh', FAKE_SOFFICE, 'MARVEEN_SOFFICE'], ['pdfunite.sh', FAKE_PDFUNITE, 'MARVEEN_PDFUNITE']] as const) {
      const f = join(depot, name)
      writeFileSync(f, body, 'utf-8')
      chmodSync(f, 0o755)
      process.env[env] = f
    }
    resetLibreOfficeProbe()
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: pid, title: 'Antwort auf das Schreiben', type: 'document' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
    writeFileSync(join(projDir(), 'Iratok', 'vertrag.pdf'), '%PDF-1.4 VERTRAG-INHALT')
    writeFileSync(join(projDir(), 'Iratok', 'bescheid.pdf'), '%PDF-1.4 BESCHEID-INHALT')
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmSync(depot, { recursive: true, force: true })
  })

  const item = () => getWorkItem(itemId)!
  function write(text: string): string {
    const s = addSection(itemId, '1. Sachverhalt', { status: 'done' })
    if (!s.ok) throw new Error('section')
    const b = addBlock(itemId, s.section.id, { text, author: 'agent' })
    if (!b.ok) throw new Error('block')
    return b.block.id
  }
  function annexes(): void {
    const r = resolverFor(item())
    for (const [path, title] of [['Iratok/vertrag.pdf', 'Mietvertrag (Korpás László)'], ['Iratok/bescheid.pdf', 'Bescheid vom 04.07.2026']] as const) {
      const a = addAnnex(itemId, { path, title }, r, 'owner')
      if (!a.ok) throw new Error('annex ' + a.code)
    }
  }
  /** #794: the draft exists only after the final PDF, so a test that wants a draft first makes the final (in `lang`). */
  async function makeFinal(lang: 'hu' | 'en' = 'hu'): Promise<void> {
    const it0 = item()
    const hash = contentHash(it0)
    recordReview(itemId, hash, 'owner')
    const f = await finalizeDocument(it0, { accept: true, hash, by: 'owner', lang })
    if (!f.ok) throw new Error('finalize ' + f.code + ' ' + f.detail)
  }
  const emlFiles = (): string[] => {
    const f = getWorkItem(itemId)!.folder
    if (!f) return []
    return readdirSync(join(projDir(), ...f.split('/'))).filter((n) => n.endsWith('.eml'))
  }
  const emlPath = (name: string): string => join(projDir(), ...getWorkItem(itemId)!.folder!.split('/'), name)

  /** #725/#797: the draft goes into the account's Drafts folder through the shared sender's mailbox engine; this one records what it got. */
  async function boxSave(it: ReturnType<typeof item>): Promise<{ account: string; to: string; subject: string; attachments: string[]; contents: string[] }> {
    const got = { account: '', to: '', subject: '', attachments: [] as string[], contents: [] as string[] }
    _setGoogleEngine(null, () => null)
    registerMailboxEngine({
      accounts: () => [{ id: 'work', address: 'me@example.com' }],
      run: async () => ({ ok: false, detail: 'a draft test never sends' }),
      sentFolder: async () => 'Sent',
      changed: () => {},
      async saveDraft(account, msg) {
        got.account = account; got.to = msg.to; got.subject = msg.subject
        for (const f of msg.attachments || []) { got.attachments.push(f.split('/').pop()!); got.contents.push(readFileSync(f, 'utf-8')) }
        return { ok: true, mailbox: '[Gmail]/Piszkozatok' }
      },
    })
    const r = await saveDraftToMailbox(it, 'hu')
    registerMailboxEngine(null)
    _setGoogleEngine(null)
    if (!r.ok) throw new Error('mailbox ' + r.code)
    return got
  }

  // #723 (Boss TG 3935: "feladot is irni kell az emailhoz ... egy kodsort hasznaljunk csak"): a finalized Word item makes
  // its mail with this same code -- the sender account, the From line, the final PDF attached, in Finished materials.
  it('a Word item finalized with the old panel: the same draft with the sender, its final PDF attached, straight into the mailbox', async () => {
    writeFileSync(join(projDir(), 'Iratok', 'Antrag.docx'), 'PK fake word')
    const w = createWorkItem({ project_id: pid, title: 'Antrag', type: 'document', source_path: 'Projektek/Iroda/Iratok/Antrag.docx' })
    if (!w.ok) throw new Error('item')
    markPlainItem(w.item.id)
    const before = await saveMailDraft(w.item, { to: 'amt@stadt.de' }, 'hu')
    expect(before).toMatchObject({ ok: false, code: 'docx_mail_no_pdf' })
    // #803: the old Word finalize is gone; what it left (its final PDF in Finished materials, the item done) still mails.
    const pdf = attachAsset(getWorkItem(w.item.id)!, 'Antrag - végleges.pdf', Buffer.from('%PDF-1.4 old panel'), { force: true, createdBy: 'owner', into: 'finished' })
    if (!pdf.ok) throw new Error('pdf ' + pdf.code)
    if (!finalizeWorkItem(w.item.id, { by: 'owner' }).ok) throw new Error('finalize')
    const word = getWorkItem(w.item.id)!
    const r = await saveMailDraft(word, { from_account: 'work', from_addr: 'me@example.com', to: 'amt@stadt.de', subject: 'Antrag' }, 'hu')
    if (!r.ok) throw new Error('save ' + r.code)
    expect(r.draft).toMatchObject({ from_account: 'work', from_addr: 'me@example.com', state: 'current' })
    // #725: no .eml file anywhere; the Finished materials hold only the final PDF
    expect(r.draft.file).toBe('')
    const sent = await boxSave(word)
    expect(sent.attachments).toEqual(['Antrag - végleges.pdf'])
    expect(sent.account).toBe('work')
    expect(readdirSync(join(projDir(), 'Iratok', 'Elkészített anyagok')).filter((n) => n.endsWith('.eml'))).toEqual([])
    expect(readdirSync(join(projDir(), 'Iratok')).sort()).toEqual(['Antrag.docx', 'Elkészített anyagok', 'bescheid.pdf', 'vertrag.pdf'])
    expect(mailDraftView(word)).toMatchObject({ from_account: 'work', state: 'current' })
  })

  it('an item without a document makes no draft', async () => {
    const r = await saveMailDraft(item(), {}, 'hu')
    expect(r).toMatchObject({ ok: false, code: 'outline_empty' })
    expect(mailDraftView(item())).toBeNull()
  })

  it('puts the document and every annex as its own PDF into the mailbox, named by label and title, and writes no file', async () => {
    write('Text eins')
    annexes()
    await makeFinal()
    const folderBefore = getWorkItem(itemId)!.folder ?? ''
    const r = await saveMailDraft(item(), { from_account: 'work', from_addr: 'me@example.com', to: 'amt@stadt.de', subject: 'Nachreichung', body: 'Guten Tag' }, 'hu')
    if (!r.ok) throw new Error('save: ' + r.code + ' ' + r.detail)
    expect(r.new_file).toBe(false)
    expect(r.draft.file).toBe('')
    // making the mail draft adds nothing to the item's folder (the final PDF made it before)
    expect(getWorkItem(itemId)!.folder ?? '').toBe(folderBefore)
    const got = await boxSave(item())
    expect(got).toMatchObject({ account: 'work', to: 'amt@stadt.de', subject: 'Nachreichung' })
    // the submission is the FINAL PDF (named by the final), then every annex
    expect(got.attachments[0]).toMatch(/Antwort auf das Schreiben – HU – v1\.pdf$/)
    expect(got.attachments.slice(1)).toEqual([
      'K1 – Mietvertrag (Korpás László).pdf',
      'K2 – Bescheid vom 04.07.2026.pdf',
    ])
    expect(got.contents[0]!.slice(0, 4)).toBe('%PDF')
    expect(got.contents[1]).toContain('VERTRAG-INHALT')
    expect(r.draft.state).toBe('current')
    expect(r.draft.attachments.map((a) => a.kind)).toEqual(['document', 'annex', 'annex'])
    expect(emlFiles()).toHaveLength(0)
  })

  // #753 (Boss TG 4240): the final saves only the submission; the mail still carries every annex, cover before content.
  it('a finalized document with annexes: only the submission is saved, the mail carries the annexes made again', async () => {
    write('Text eins')
    annexes()
    const it0 = item()
    const hash = contentHash(it0)
    recordReview(itemId, hash, 'owner')
    const f = await finalizeDocument(it0, { accept: true, hash, by: 'owner', lang: 'hu' })
    if (!f.ok) throw new Error('finalize ' + f.code + ' ' + f.detail)
    expect(f.final.files!.map((x) => x.role)).toEqual(['main'])
    const dir = join(projDir(), ...getWorkItem(itemId)!.folder!.split('/'))
    const pdfs = (readdirSync(dir, { recursive: true }) as string[]).filter((n) => /\.pdf$/i.test(String(n)))
    expect(pdfs).toEqual([f.final.files![0]!.path.split('/').slice(-2).join('/')])
    const d = await saveMailDraft(item(), { from_account: 'work', to: 'amt@stadt.de', subject: 'Nachreichung' }, 'hu')
    if (!d.ok) throw new Error('save: ' + d.code + ' ' + d.detail)
    expect(d.draft.attachments.map((a) => a.kind)).toEqual(['document', 'annex', 'annex'])
    const got = await boxSave(item())
    expect(got.attachments).toEqual([f.final.pdf_name, 'K1 – Mietvertrag (Korpás László).pdf', 'K2 – Bescheid vom 04.07.2026.pdf'])
    // the cover page (made by the fake LibreOffice) comes first, then the annex itself
    expect(got.contents[1]!.startsWith('%PDF-1.4 SRC-')).toBe(true)
    expect(got.contents[1]!.indexOf('SRC-')).toBeLessThan(got.contents[1]!.indexOf('VERTRAG-INHALT'))
  })

  it('"combined" annex mode attaches ONE PDF', async () => {
    write('Text eins')
    annexes()
    setDocSettings(itemId, { annex_mode: 'combined' })
    await makeFinal()
    const r = await saveMailDraft(item(), {}, 'en')
    if (!r.ok) throw new Error('save: ' + r.code + ' ' + r.detail)
    expect(r.draft.attachments).toHaveLength(1)
    expect(r.draft.attachments[0]!.kind).toBe('package')
  })

  it('an empty body gets a short default text in the document language, the subject defaults to the title', async () => {
    write('Text eins')
    await makeFinal()
    const r = await saveMailDraft(item(), {}, 'hu')
    if (!r.ok) throw new Error('save')
    expect(r.draft.subject).toBe('Antwort auf das Schreiben')
    expect(r.draft.body.length).toBeGreaterThan(20)
  })

  it('the chosen sender account is stored and kept by a later save that leaves it out', async () => {
    write('Text eins')
    await makeFinal()
    const r = await saveMailDraft(item(), { from_account: 'work', from_addr: 'me@example.com', to: 'amt@stadt.de' }, 'hu')
    if (!r.ok) throw new Error('save')
    expect(r.draft).toMatchObject({ from_account: 'work', from_addr: 'me@example.com' })
    const again = await saveMailDraft(item(), { subject: 'Neu' }, 'hu')
    if (!again.ok) throw new Error('save2')
    expect(again.draft.from_account).toBe('work')
    const cleared = await saveMailDraft(item(), { from_account: '' }, 'hu')
    if (!cleared.ok) throw new Error('save3')
    expect(cleared.draft).toMatchObject({ from_account: '', from_addr: '' })
  })

  // #794 (Boss TG 10425/10429): nothing is generated before the final PDF, and the text follows the language of that PDF.
  it('refuses a draft before the final PDF exists, and writes the text in the language of the final', async () => {
    write('Text eins')
    const early = await saveMailDraft(item(), {}, 'hu')
    expect(early).toMatchObject({ ok: false, code: 'final_required' })
    expect(mailDraftView(item())).toBeNull()
    await makeFinal('en')
    const r = await saveMailDraft(item(), {}, 'hu')
    if (!r.ok) throw new Error('save ' + r.code)
    expect(r.draft.body).toMatch(/^Dear Sir or Madam/)
  })

  it('a new final starts an untouched default text again, but keeps a text the owner edited', async () => {
    const blockId = write('Text eins')
    await makeFinal('en')
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    expect(first.draft.body).toMatch(/^Dear Sir or Madam/)
    expect(resetUntouchedMailText(item())).toBe(true)
    expect(mailDraftView(item())).toBeNull()
    const own = await saveMailDraft(item(), { body: 'My own words' }, 'hu')
    if (!own.ok) throw new Error('save2')
    updateBlock(itemId, blockId, { text: 'Text zwei', author: 'owner' })
    expect(resetUntouchedMailText(item())).toBe(false)
    expect(mailDraftView(item())!.body).toBe('My own words')
  })

  it('an old row with the untouched default text of another language is shown (and saved) in the language of the current final', async () => {
    write('Text eins')
    await makeFinal('hu')
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    expect(first.draft.body).toMatch(/^Tisztelt Címzett/)
    await makeFinal('en')
    expect(mailDraftView(item())!.body).toMatch(/^Dear Sir or Madam/)
    const again = await saveMailDraft(item(), {}, 'hu')
    if (!again.ok) throw new Error('save2')
    expect(again.draft.body).toMatch(/^Dear Sir or Madam/)
  })

  it('an original written in German gets a German default text, whatever language the final label names', async () => {
    write('Sehr geehrte Damen und Herren, bezüglich der Verwarnung bitte ich Sie, das Verwarnungsgeld mit der Begründung zu erlassen, und ich danke für die Prüfung.')
    await makeFinal('hu')
    const r = await saveMailDraft(item(), {}, 'hu')
    if (!r.ok) throw new Error('save ' + r.code)
    expect(r.draft.body).toMatch(/^(Sehr geehrte|Dear Sir)/)
    expect(r.draft.body).not.toMatch(/^Tisztelt/)
  })

  it('a bad address is refused with nothing written', async () => {
    write('Text eins')
    const r = await saveMailDraft(item(), { to: 'nem cim' }, 'hu')
    expect(r).toMatchObject({ ok: false, code: 'bad_input' })
    expect(mailDraftView(item())).toBeNull()
  })

  it('a change of the document makes the stored draft "outdated"; saving again makes it current', async () => {
    const blockId = write('Text eins')
    await makeFinal()
    const first = await saveMailDraft(item(), { to: 'amt@stadt.de' }, 'hu')
    if (!first.ok) throw new Error('save')
    expect(first.draft.state).toBe('current')
    updateBlock(itemId, blockId, { text: 'Text zwei, ganz anders', author: 'owner' })
    await mirrorOutlineToFile(itemId)
    expect(mailDraftView(item())!.state).toBe('outdated')
    await makeFinal()
    const again = await saveMailDraft(item(), {}, 'hu')
    if (!again.ok) throw new Error('save2')
    expect(again.draft.state).toBe('current')
    expect(emlFiles()).toHaveLength(0)
  })

  it('a new annex shows up in the attachment list when the draft is saved again', async () => {
    write('Text eins')
    await makeFinal()
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    expect(first.draft.attachments).toHaveLength(1)
    annexes()
    await makeFinal()
    const again = await saveMailDraft(item(), {}, 'hu')
    if (!again.ok) throw new Error('save2')
    expect(again.draft.attachments).toHaveLength(3)
  })

  it('an old row that still points to an .eml file is kept as it is on disk, and the next save stops tracking it', async () => {
    write('Text eins')
    await makeFinal()
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    const old = join(projDir(), 'Iratok')
    writeFileSync(join(old, 'Levélpiszkozat - alt.eml'), 'Subject: alt\r\n\r\nalt')
    const again = await saveMailDraft(item(), {}, 'hu')
    if (!again.ok) throw new Error('save2')
    expect(again.draft.file).toBe('')
    expect(readFileSync(join(old, 'Levélpiszkozat - alt.eml'), 'utf-8')).toContain('alt')
  })

  it('forgetting the draft stops tracking it', async () => {
    write('Text eins')
    await makeFinal()
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    expect(forgetMailDraft(itemId)).toBe(true)
    expect(mailDraftView(item())).toBeNull()
  })
})

describe('annexFileStem', () => {
  it('keeps a short name whole', () => {
    expect(annexFileStem('Anlage K1', 'Lohnabrechnung Juli 2026 (Minijob, Korpás László)')).toBe('Anlage K1 – Lohnabrechnung Juli 2026 (Minijob, Korpás László)')
  })
  it('cuts a long name at a word and drops the opened bracket, never mid-word', () => {
    const n = annexFileStem('Anlage K11', 'Bescheid des ungarischen Rentenversicherungsträgers über die Einstellung der Rente zum 01.09.2026 (Éva Bakos)')
    expect(n).toBe('Anlage K11 – Bescheid des ungarischen Rentenversicherungsträgers über die Einstellung der Rente zum 01.09.2026')
    expect(n.length).toBeLessThanOrEqual(120)
  })
  it('keeps a closed bracket that fits', () => {
    const t = 'x'.repeat(10) + ' (' + 'y'.repeat(20) + ') ' + 'word '.repeat(30)
    const n = annexFileStem('K1', t)
    expect(n).toContain('(' + 'y'.repeat(20) + ')')
    expect(n.length).toBeLessThanOrEqual(120)
    expect(n.endsWith('word')).toBe(true)
  })
})

// #724 (Boss TG 3959): ONE button makes the draft and puts it into the mailbox; there is no second, late-appearing button.
describe('one-button e-mail draft (frontend source)', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
  it('has no separate save-to-mailbox button', () => {
    expect(src).not.toContain('data-wb-act="mail-to-mailbox"')
  })
  it('chains the mailbox save after the draft is made, and needs a sender (no .eml fallback)', () => {
    expect(src).toMatch(/render\(\); mailToMailbox\(\); return/)
    expect(src).toContain("if (!from) { window.showToast(t(WB.mailAccounts && WB.mailAccounts.length ? 'workbench.mail.from_required' : 'workbench.mail.account_needed')); return }")
  })
})
