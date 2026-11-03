import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { subjectFromLines } from '../workbench-letterinfo.js'
import { describe, expect, it } from 'vitest'

const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')

describe('Boss TG 4865: the e-mail panel comes first right after the finalization', () => {
  it('a successful finalize opens the e-mail panel (the header E-mail button panel) by itself', () => {
    const at = js.indexOf("'/outline/finalize', body)")
    const chunk = js.slice(at, at + 2500)
    expect(chunk).toContain('WB.docxMailFor = id')
    expect(chunk).toContain('.wb-docx-mail')
  })
})

describe('Boss TG 4871: a long "Betreff:" line is no reason to leave the subject empty', () => {
  it('keeps a 251-character subject whole', () => {
    const subj = 'Antrag auf Einleitung des Statusfeststellungsverfahrens nach § 7a Abs. 1 SGB IV sowie Bitte um schriftliche rechtliche Prüfung der ab 01.04.2026 gemeldeten haushaltsnahen Beschäftigung (geringfügige Beschäftigung) mit einem Entgelt von monatlich 150 €'
    expect(subj.length).toBe(251)
    expect(subjectFromLines(['Chemnitz, 03.11.2026', 'Betreff: ' + subj])).toBe(subj)
    expect(subjectFromLines(['Tárgy: ' + 'x'.repeat(600)]).length).toBe(600)
  })
})
