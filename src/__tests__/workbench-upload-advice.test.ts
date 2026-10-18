import { describe, expect, it } from 'vitest'
import { adviseUpload } from '../workbench-misplaced.js'

// #700: the upload suggestion. Advice only: a match is silent, a mismatch names the
// folder it would rather go to (when the item has one), a soft case is a note.
const box = 'Munka'
const item = 'Munka/Wohngeld'
const folders = [
  box, item, `${item}/Mellékletek`, `${item}/Elkészített anyagok`, `${item}/Vitáztatás`, `${item}/Vitáztatás/jelentés`,
  `${item}/Feltöltések`, 'Munka/Egyeb',
]
const items = new Set([item])
const adv = (dest: string, name: string) => adviseUpload(box, dest, name, folders, items)

describe('adviseUpload', () => {
  it('a file that fits its folder is silent', () => {
    expect(adv(`${item}/Mellékletek`, 'K1_Bescheid.pdf')).toEqual({ ok: true })
    expect(adv(`${item}/Elkészített anyagok`, 'Kérelem_végleges.pdf')).toEqual({ ok: true })
  })

  it('an attachment dropped into the Finished folder is sent to the Attachments folder', () => {
    expect(adv(`${item}/Elkészített anyagok`, 'K1_Bescheid.pdf')).toEqual({ ok: false, code: 'attachment_in_finished', soft: false, suggested: `${item}/Mellékletek` })
  })

  it('a finished document dropped into Attachments is sent to Finished', () => {
    expect(adv(`${item}/Mellékletek`, 'Kérelem_végleges.pdf')).toMatchObject({ ok: false, code: 'finished_in_attachments', suggested: `${item}/Elkészített anyagok` })
  })

  it('a debate report goes to the report subfolder of the Debate folder', () => {
    expect(adv(`${item}/Mellékletek`, 'Vitáztatás jelentés - x.md')).toMatchObject({ ok: false, code: 'report_elsewhere', suggested: `${item}/Vitáztatás/jelentés` })
  })

  it('an outside opinion in the Debate folder is soft; elsewhere it is not judged', () => {
    expect(adv(`${item}/Vitáztatás`, 'GPT_velemeny.md')).toMatchObject({ ok: false, soft: true, suggested: null })
    expect(adv(`${item}/Mellékletek`, 'GPT_velemeny.md')).toEqual({ ok: true })
  })

  it('a file the name cannot place has no suggestion but is still asked about', () => {
    expect(adv(box, 'valami.txt')).toEqual({ ok: false, code: 'loose_beside_item', soft: false, suggested: null })
  })

  it('a folder that is not a standard subfolder of an item is never judged', () => {
    expect(adv('Munka/Egyeb', 'K1_Bescheid.pdf')).toEqual({ ok: true })
    expect(adv(item, 'K1_Bescheid.pdf')).toEqual({ ok: true })
  })

  it('no sibling folder of the wanted role -> no suggestion (nothing is invented)', () => {
    const r = adviseUpload(box, `${item}/Elkészített anyagok`, 'K1_Bescheid.pdf', [box, item, `${item}/Elkészített anyagok`], items)
    expect(r).toMatchObject({ ok: false, suggested: null })
  })
})
