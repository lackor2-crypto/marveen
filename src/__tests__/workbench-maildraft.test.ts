// The e-mail draft of a document (Boss TG, 2026-10-16): an .eml with the document and its annexes as PDF attachments,
// made by Marveen and refreshed by itself, so a fresh install attaches the current PDF without anybody doing it by hand.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleParser } from 'mailparser'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem } from '../workbench.js'
import { addBlock, addSection, updateBlock } from '../workbench-docmodel.js'
import { addAnnex, setDocSettings } from '../workbench-docannex.js'
import { resolverFor } from '../workbench-docfinal.js'
import { mirrorOutlineToFile } from '../workbench-docmirror.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { markPlainItem } from '../workbench-assets.js'
import { finalizeDocxItem } from '../workbench-docxfinal.js'
import { annexFileStem, buildEml, cleanAddresses, encodeHeaderText, forgetMailDraft, mailDraftView, saveMailDraft } from '../workbench-maildraft.js'

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
  const emlFiles = (): string[] => {
    const f = getWorkItem(itemId)!.folder!
    return readdirSync(join(projDir(), ...f.split('/'))).filter((n) => n.endsWith('.eml'))
  }
  const emlPath = (name: string): string => join(projDir(), ...getWorkItem(itemId)!.folder!.split('/'), name)

  // #723 (Boss TG 3935: "feladot is irni kell az emailhoz ... egy kodsort hasznaljunk csak"): a finalized Word item makes
  // its mail with this same code -- the sender account, the From line, the final PDF attached, in Finished materials.
  it('a finalized Word item: the same draft with the sender, its final PDF attached, in Finished materials beside the file', async () => {
    writeFileSync(join(projDir(), 'Iratok', 'Antrag.docx'), 'PK fake word')
    const w = createWorkItem({ project_id: pid, title: 'Antrag', type: 'document', source_path: 'Projektek/Iroda/Iratok/Antrag.docx' })
    if (!w.ok) throw new Error('item')
    markPlainItem(w.item.id)
    const before = await saveMailDraft(w.item, { to: 'amt@stadt.de' }, 'hu')
    expect(before).toMatchObject({ ok: false, code: 'docx_mail_no_pdf' })
    const f = await finalizeDocxItem(getWorkItem(w.item.id)!, { by: 'owner', ui: 'hu' })
    if (!f.ok) throw new Error('finalize ' + f.code + ' ' + f.detail)
    const word = getWorkItem(w.item.id)!
    const r = await saveMailDraft(word, { from_account: 'work', from_addr: 'me@example.com', to: 'amt@stadt.de', subject: 'Antrag' }, 'hu')
    if (!r.ok) throw new Error('save ' + r.code)
    expect(r.draft).toMatchObject({ from_account: 'work', from_addr: 'me@example.com', state: 'current' })
    expect(r.draft.file).toBe('Projektek/Iroda/Iratok/Elkészített anyagok/' + r.draft.file_name)
    const mail = await simpleParser(readFileSync(join(projDir(), 'Iratok', 'Elkészített anyagok', r.draft.file_name)))
    expect(mail.from?.value[0]?.address).toBe('me@example.com')
    expect(mail.attachments.map((a) => a.filename)).toEqual(['Antrag - végleges.pdf'])
    // a plain item never gets a folder of its own (#721): nothing new beside the file but the Finished materials
    expect(readdirSync(join(projDir(), 'Iratok')).sort()).toEqual(['Antrag.docx', 'Elkészített anyagok', 'bescheid.pdf', 'vertrag.pdf'])
    expect(mailDraftView(word)).toMatchObject({ from_account: 'work', state: 'current' })
  })

  it('an item without a document makes no draft', async () => {
    const r = await saveMailDraft(item(), {}, 'hu')
    expect(r).toMatchObject({ ok: false, code: 'outline_empty' })
    expect(mailDraftView(item())).toBeNull()
  })

  it('makes an .eml with the document and every annex as its own PDF, named by label and title', async () => {
    write('Text eins')
    annexes()
    const r = await saveMailDraft(item(), { to: 'amt@stadt.de', subject: 'Nachreichung', body: 'Guten Tag' }, 'hu')
    if (!r.ok) throw new Error('save: ' + r.code + ' ' + r.detail)
    expect(r.new_file).toBe(true)
    expect(emlFiles()).toHaveLength(1)
    const m = await simpleParser(readFileSync(emlPath(r.draft.file_name)))
    expect(m.subject).toBe('Nachreichung')
    expect(m.text).toContain('Guten Tag')
    expect(m.attachments.map((a) => a.filename)).toEqual([
      'Antwort auf das Schreiben.pdf',
      'K1 – Mietvertrag (Korpás László).pdf',
      'K2 – Bescheid vom 04.07.2026.pdf',
    ])
    expect(m.attachments[0]!.content.subarray(0, 4).toString()).toBe('%PDF')
    expect(m.attachments[1]!.content.toString()).toContain('VERTRAG-INHALT')
    expect(r.draft.state).toBe('current')
    expect(r.draft.attachments.map((a) => a.kind)).toEqual(['document', 'annex', 'annex'])
  })

  it('"combined" annex mode attaches ONE PDF', async () => {
    write('Text eins')
    annexes()
    setDocSettings(itemId, { annex_mode: 'combined' })
    const r = await saveMailDraft(item(), {}, 'en')
    if (!r.ok) throw new Error('save: ' + r.code + ' ' + r.detail)
    expect(r.draft.attachments).toHaveLength(1)
    expect(r.draft.attachments[0]!.kind).toBe('package')
  })

  it('an empty body gets a short default text in the document language, the subject defaults to the title', async () => {
    write('Text eins')
    const r = await saveMailDraft(item(), {}, 'hu')
    if (!r.ok) throw new Error('save')
    expect(r.draft.subject).toBe('Antwort auf das Schreiben')
    expect(r.draft.body.length).toBeGreaterThan(20)
  })

  it('the chosen sender account is stored, written as the From line, and kept by a later save that leaves it out', async () => {
    write('Text eins')
    const r = await saveMailDraft(item(), { from_account: 'work', from_addr: 'me@example.com', to: 'amt@stadt.de' }, 'hu')
    if (!r.ok) throw new Error('save')
    expect(r.draft).toMatchObject({ from_account: 'work', from_addr: 'me@example.com' })
    const mail = await simpleParser(readFileSync(emlPath(r.draft.file_name)))
    expect(mail.from?.value[0]?.address).toBe('me@example.com')
    const again = await saveMailDraft(item(), { subject: 'Neu' }, 'hu')
    if (!again.ok) throw new Error('save2')
    expect(again.draft.from_account).toBe('work')
    const cleared = await saveMailDraft(item(), { from_account: '' }, 'hu')
    if (!cleared.ok) throw new Error('save3')
    expect(cleared.draft).toMatchObject({ from_account: '', from_addr: '' })
  })

  it('a bad address is refused with nothing written', async () => {
    write('Text eins')
    const r = await saveMailDraft(item(), { to: 'nem cim' }, 'hu')
    expect(r).toMatchObject({ ok: false, code: 'bad_input' })
    expect(mailDraftView(item())).toBeNull()
  })

  it('the attachment follows the text: a change of the document refreshes the PDF in the draft by itself', async () => {
    const blockId = write('Text eins')
    const first = await saveMailDraft(item(), { to: 'amt@stadt.de' }, 'hu')
    if (!first.ok) throw new Error('save')
    const before = await simpleParser(readFileSync(emlPath(first.draft.file_name)))
    updateBlock(itemId, blockId, { text: 'Text zwei, ganz anders', author: 'owner' })
    expect(mailDraftView(item())!.state).toBe('outdated')
    await mirrorOutlineToFile(itemId)
    const view = mailDraftView(item())!
    expect(view.state).toBe('current')
    expect(emlFiles()).toHaveLength(1)
    const after = await simpleParser(readFileSync(emlPath(view.file_name)))
    expect(after.attachments[0]!.content.equals(before.attachments[0]!.content)).toBe(false)
    expect(after.subject).toBe(before.subject)
    expect((after.to as { text: string }).text).toBe('amt@stadt.de')
  })

  it('a new annex shows up in the draft without anybody touching the mail', async () => {
    write('Text eins')
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    expect(first.draft.attachments).toHaveLength(1)
    annexes()
    await mirrorOutlineToFile(itemId)
    expect(mailDraftView(item())!.attachments).toHaveLength(3)
  })

  it('a file the owner changed is not overwritten by the refresh; the explicit button writes a new file beside it', async () => {
    const blockId = write('Text eins')
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    writeFileSync(emlPath(first.draft.file_name), 'Subject: kezzel szerkesztve\r\n\r\nsajat')
    updateBlock(itemId, blockId, { text: 'Text zwei', author: 'owner' })
    await mirrorOutlineToFile(itemId)
    expect(readFileSync(emlPath(first.draft.file_name), 'utf-8')).toContain('kezzel szerkesztve')
    expect(mailDraftView(item())!.state).toBe('edited')
    const again = await saveMailDraft(item(), {}, 'hu')
    if (!again.ok) throw new Error('save2')
    expect(again.new_file).toBe(true)
    expect(again.draft.file_name).not.toBe(first.draft.file_name)
    expect(emlFiles()).toHaveLength(2)
    expect(readFileSync(emlPath(first.draft.file_name), 'utf-8')).toContain('kezzel szerkesztve')
    expect(again.draft.state).toBe('current')
  })

  it('a deleted file is reported as missing and NOT silently recreated by the refresh', async () => {
    const blockId = write('Text eins')
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    rmSync(emlPath(first.draft.file_name))
    updateBlock(itemId, blockId, { text: 'Text zwei', author: 'owner' })
    await mirrorOutlineToFile(itemId)
    expect(existsSync(emlPath(first.draft.file_name))).toBe(false)
    expect(mailDraftView(item())!.state).toBe('missing')
    const again = await saveMailDraft(item(), {}, 'hu')
    expect(again.ok).toBe(true)
    expect(emlFiles()).toHaveLength(1)
  })

  it('forgetting the draft keeps the file and stops the refresh', async () => {
    const blockId = write('Text eins')
    const first = await saveMailDraft(item(), {}, 'hu')
    if (!first.ok) throw new Error('save')
    expect(forgetMailDraft(itemId)).toBe(true)
    const body = readFileSync(emlPath(first.draft.file_name))
    updateBlock(itemId, blockId, { text: 'Text zwei', author: 'owner' })
    await mirrorOutlineToFile(itemId)
    expect(readFileSync(emlPath(first.draft.file_name)).equals(body)).toBe(true)
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
  it('chains the mailbox save after the draft is made, when a sender is chosen', () => {
    expect(src).toMatch(/if \(from\) \{ render\(\); mailToMailbox\(\); return \}/)
  })
})
