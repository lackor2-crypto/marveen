import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(join(__dirname, '..', '..', p), 'utf-8')

describe('Boss TG 4885: the recipient comes from the context file too', () => {
  it('knownRecipient looks at chat, then the context file, then the letter', () => {
    const src = read('src/workbench-maildraft.ts')
    const at = src.indexOf('export function knownRecipient')
    const chunk = src.slice(at, at + 700)
    expect(chunk.indexOf('chatRecipient')).toBeLessThan(chunk.indexOf('contextRecipient'))
    expect(chunk.indexOf('contextRecipient')).toBeLessThan(chunk.indexOf('inText'))
  })
  it('the Gaps check has the open point, with Hungarian and English texts', () => {
    expect(read('src/web/routes/workbench.ts')).toContain('recipient_email_missing')
    expect(read('src/workbench-check-todos.ts')).toContain('recipient_email_missing')
    expect(read('web/lang/hu.js')).toContain('check.recipient_email_missing')
    expect(read('web/lang/en.js')).toContain('check.recipient_email_missing')
  })
  it('the assistant is told to write facts into the context file at once', () => {
    expect(read('src/workbench-agent/context.ts')).toContain('Címzett e-mail:')
    expect(read('seed-skills/workitem-context-file/SKILL.md')).toContain('Címzett e-mail:')
  })
})
