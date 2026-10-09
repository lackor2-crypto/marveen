// The upload dialog tells an operator how to grant the Google Photos upload
// permission. Owner, 2026-10-09 (#520): "ezzel a mondattal csak az a baj hogy
// hamis. nincs is ujracsatlakoztatas gomb." -- the sentence named a button that
// did not exist, and the button that does the job was only rendered for a
// BROKEN account, so a healthy account had no route at all.
//
// The frontend cannot be imported (browser globals), so the source is the
// evidence: the button must be on every row, and the sentence must take the
// button's name from the same key the button itself is labelled with.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const app = readFileSync(join(ROOT, 'web/app.js'), 'utf-8')
const hu = readFileSync(join(ROOT, 'web/lang/hu.js'), 'utf-8')
const en = readFileSync(join(ROOT, 'web/lang/en.js'), 'utf-8')

function entry(src: string, key: string): string {
  const line = src.split('\n').find(l => l.includes(`'${key}':`))
  if (!line) throw new Error(`missing key ${key}`)
  return line
}

describe('granting the Google Photos upload permission is reachable from the screen', () => {
  it('the sign-in-again button is rendered for a healthy account too', () => {
    const line = app.split('\n').find(l => l.includes('data-gact="reauth"'))
    expect(line).toBeTruthy()
    // The old gate: only an account with an error got the button.
    expect(line).not.toMatch(/a\.error\s*&&/)
    expect(line).toMatch(/apiOff \? '' :/)
  })

  it('the sentence names the button by the label the button really has', () => {
    expect(app).toContain("t('gphotos.up.no_perm_3', { button: t('gconn.reauth') })")
    for (const src of [hu, en]) {
      expect(entry(src, 'gphotos.up.no_perm_3')).toContain('{button}')
      expect(entry(src, 'gconn.reauth')).toBeTruthy()
    }
  })

  it('no made-up button name is left in the sentence', () => {
    expect(entry(hu, 'gphotos.up.no_perm_3')).not.toMatch(/jracsatlakoztat/)
    expect(entry(en, 'gphotos.up.no_perm_3')).not.toMatch(/Reconnect/)
  })

  it('the older expired-access guide names the same real button', () => {
    for (const src of [hu, en]) {
      const label = /'gconn\.reauth':\s*'([^']+)'/.exec(src)![1]
      expect(entry(src, 'guide.quick_3')).toContain(`<span class="guide-lit">${label}</span>`)
    }
  })

  it('the row the sentence points at is the row heading on the Accounts page', () => {
    const rowHu = /'acchub\.part_google':\s*'([^']+)'/.exec(hu)![1]
    const rowEn = /'acchub\.part_google':\s*'([^']+)'/.exec(en)![1]
    expect(entry(hu, 'gphotos.up.no_perm_3')).toContain(rowHu)
    expect(entry(en, 'gphotos.up.no_perm_3')).toContain(rowEn)
  })
})
