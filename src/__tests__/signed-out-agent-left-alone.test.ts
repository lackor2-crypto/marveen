// Boss TG 3861: a signed-out account is left alone: no Telegram alert, no /login keystrokes, no wake.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'

const read = (p: string) => readFileSync(join(PROJECT_ROOT, p), 'utf-8')

describe('signed-out agent is left alone', () => {
  it('the reauth healer sends no Telegram alert and no /login keys for a dead token', () => {
    const src = read('src/web/reauth-healer.ts')
    const check = src.slice(src.indexOf('function checkSession('), src.indexOf('async function restartFirstRunGatedAgent'))
    expect(check).not.toContain('routeEscalation(')
    expect(check).not.toContain('sendBestEffortLogin(session)')
    expect(check).toContain('no Telegram alert (owner order)')
  })
  it('the limit-wake runner skips a signed_out agent', () => {
    const src = read('src/web/limit-wake-runner.ts')
    expect(src).toContain("reason === 'signed_out'")
  })
})
