import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applySendPatch, emptySendDetails, ensureSendBlockText, keepSendBlock, parseSendDetails, renderSendDetails,
  sendBlockRange, sendEmailOf, sendTextFor,
} from '../workbench-send-block.js'

// Boss 2026-11-14: every context file starts with a "Sending details" block (recipient name / e-mail / postal address, mail
// subject and text). The e-mail panel reads it; with no e-mail address the postal address and the name stay in it.
const hu = (h: string): string => h
const FILE = [
  '# Kontextus: Teszt',
  '',
  '> Ezt a fájlt az AI vezeti.',
  '',
  '## Feladat',
  'valami',
  '',
  '## Napló',
  '',
].join('\n')

describe('the sending block of the context file', () => {
  it('a file without it gets an empty block at the very top, before the Task section', () => {
    const out = ensureSendBlockText(FILE, hu)
    const r = sendBlockRange(out)!
    expect(r.start).toBeLessThan(out.indexOf('## Feladat'))
    expect(out.indexOf('## Küldési adatok')).toBeGreaterThan(out.indexOf('> Ezt a fájlt'))
    expect(ensureSendBlockText(out, hu)).toBe(out) // idempotent
  })

  it('writes and reads back name, e-mail, postal address, subject and a multi-line body', () => {
    const out = applySendPatch(FILE, {
      name: 'Frau Sarah Jäckle', email: 'Sarah.Jaeckle@stadt-chemnitz.de', postal: 'Bahnhofstraße 53, 09111 Chemnitz',
      subject: 'Az. 1 – Pflegegeld', body: 'Liebe Frau Jäckle,\n\nvielen Dank.\n\nHerzliche Grüße\nLászló',
    }, hu)
    const d = parseSendDetails(out)!
    expect(d.name).toBe('Frau Sarah Jäckle')
    expect(d.email).toBe('Sarah.Jaeckle@stadt-chemnitz.de')
    expect(d.postal).toBe('Bahnhofstraße 53, 09111 Chemnitz')
    expect(d.subject).toBe('Az. 1 – Pflegegeld')
    expect(d.body).toBe('Liebe Frau Jäckle,\n\nvielen Dank.\n\nHerzliche Grüße\nLászló')
    expect(out).toContain('## Feladat') // the rest of the file is untouched
  })

  it('a patch changes only what it carries: the rest of the block stays', () => {
    const a = applySendPatch(FILE, { name: 'Amt', email: 'a@amt.de', postal: 'Weg 1' }, hu)
    const b = applySendPatch(a, { subject: 'Betreff' }, hu)
    const d = parseSendDetails(b)!
    expect(d.name).toBe('Amt'); expect(d.email).toBe('a@amt.de'); expect(d.postal).toBe('Weg 1'); expect(d.subject).toBe('Betreff')
  })

  it('with no e-mail address the name and the postal address are kept and the e-mail reads as empty', () => {
    const out = applySendPatch(FILE, { name: 'Amtsgericht Chemnitz', postal: 'Dr.-Külz-Ring 1, 09111 Chemnitz' }, hu)
    const d = parseSendDetails(out)!
    expect(sendEmailOf(d)).toBe('')
    expect(d.name).toBe('Amtsgericht Chemnitz')
    expect(d.postal).toContain('09111 Chemnitz')
    expect(out).toContain('(még nincs kitöltve)') // the empty e-mail line says so
  })

  it('language versions share one file: the subject / body are picked by the letter language', () => {
    let out = applySendPatch(FILE, { subject: 'Tárgy HU', body: 'Szia' }, hu)
    out = applySendPatch(out, { subject: 'Betreff DE', body: 'Liebe Frau Jäckle', lang: 'de' }, hu)
    const d = parseSendDetails(out)!
    expect(sendTextFor(d, 'de', 'subject')).toBe('Betreff DE')
    expect(sendTextFor(d, 'de', 'body')).toBe('Liebe Frau Jäckle')
    expect(sendTextFor(d, 'hu', 'subject')).toBe('Tárgy HU')
    expect(sendTextFor(d, 'en', 'body')).toBe('Szia') // no English line: the plain one
  })

  it('an unfilled placeholder is never taken as a value', () => {
    const d = parseSendDetails(ensureSendBlockText(FILE, hu))!
    expect(sendEmailOf(d)).toBe('')
    expect(sendTextFor(d, 'de', 'subject')).toBe('')
    expect(sendTextFor(d, 'de', 'body')).toBe('')
  })

  it('context.rewrite keeps the block when the tidied text left it out', () => {
    const old = applySendPatch(FILE, { email: 'x@y.de', name: 'Y' }, hu)
    const tidied = keepSendBlock(old, '# Kontextus: Teszt\n\n## Feladat\nrendezett\n', hu)
    expect(parseSendDetails(tidied)!.email).toBe('x@y.de')
    expect(tidied.indexOf('## Küldési adatok')).toBeLessThan(tidied.indexOf('## Feladat'))
    expect(keepSendBlock(old, old, hu)).toBe(old)
  })

  it('the English heading and field names are understood too', () => {
    const en = '# Context: T\n\n## Sending details (e-mail / letter)\n- Recipient e-mail: a@b.org\n- E-mail subject: Hi\n- E-mail text:\n  Dear all\n\n## Task\nx\n'
    const d = parseSendDetails(en)!
    expect(d.email).toBe('a@b.org'); expect(d.subject).toBe('Hi'); expect(d.body).toBe('Dear all')
  })

  it('renders every field, even when empty', () => {
    const t = renderSendDetails(emptySendDetails(), hu)
    for (const label of ['Címzett neve', 'Címzett e-mail', 'Címzett postai címe', 'E-mail tárgya', 'E-mail szövege']) expect(t).toContain(label)
  })
})

describe('the sending block is burnt into Marveen (wiring)', () => {
  const src = (f: string): string => readFileSync(join(__dirname, '..', f), 'utf8')
  it('every new context file starts with the block, and every sweep adds it to old files', () => {
    const s = src('workbench-item-context.ts')
    expect(s).toContain('renderSendDetails(emptySendDetails(), ol)')
    expect(s).toContain('ensureSendBlockText(withBlock(')
    expect(s).toContain('keepSendBlock(old, clean, ol)')
  })
  it('the agent has the context.send tool and the law is in its prompt', () => {
    expect(src('workbench-agent/tools.ts')).toContain("name: 'context.send'")
    expect(src('workbench-agent/execute.ts')).toContain("case 'context.send'")
    expect(src('workbench-agent/approval-text.ts')).toContain("'context.send'")
    expect(src('workbench-agent/context.ts')).toContain('SENDING DETAILS')
  })
  it('the e-mail panel takes recipient, subject and text from the block', () => {
    const s = src('workbench-maildraft.ts')
    expect(s).toContain('sendBlockRecipient(item)')
    expect(s).toContain("sendTextFor(readSendDetails(item), sendLang(item), 'subject')")
    expect(s).toContain("sendTextFor(readSendDetails(item), lang, 'body')")
  })
})
