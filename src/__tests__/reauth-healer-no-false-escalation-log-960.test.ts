import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', 'web', 'reauth-healer.ts'), 'utf8')

describe('#960 reauth-healer does not log an ERROR claiming an escalation that never happens', () => {
  it('no logger.error line says "escalating to owner"', () => {
    expect(src).not.toMatch(/logger\.error\([^\n]*escalating to owner/)
  })
  it('the dead-token state line is a warn that says no Telegram alert is sent', () => {
    expect(src).toMatch(/logger\.warn\([^\n]*dead OAuth token on live session \(state only, no Telegram alert/)
  })
})
