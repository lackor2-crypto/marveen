// #938 (Boss TG 6887): a big letter takes minutes to send; the button said only "Sending..." and looked frozen.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8')
const hu = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf8')
const en = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf8')

describe('the compose send shows that a long send is still working (#938)', () => {
  const fn = /async function emailComposeNewSubmit\(asDraft\) \{([\s\S]*?)\n\}\n/.exec(app)
  it('the submit handler shows the elapsed time and a "still sending" note, and stops the timer in finally', () => {
    expect(fn).not.toBeNull()
    expect(fn![1]).toContain("t('email.sending_elapsed'")
    expect(fn![1]).toContain("'email.sending_long'")
    expect(fn![1]).toContain('setInterval(sendTick, 1000)')
    expect(/finally \{[\s\S]*clearInterval\(sendTimer\)/.test(fn![1])).toBe(true)
  })
  it('the note element exists in the compose dialog', () => {
    expect(html).toContain('id="emailComposeNewSendNote"')
  })
  it('every new text exists in Hungarian and English', () => {
    for (const k of ['email.sending_elapsed', 'email.sending_long', 'email.saving_long']) {
      expect(hu).toContain(`'${k}'`)
      expect(en).toContain(`'${k}'`)
    }
  })
})
