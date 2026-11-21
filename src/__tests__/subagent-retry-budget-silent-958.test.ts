import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sh = readFileSync(join(__dirname, '..', '..', 'scripts', 'subagent-retry.sh'), 'utf8')

describe('#958 sub-agent retry watcher: exhausted budget stays off Telegram', () => {
  it('does not notify when the hourly retry budget is used up', () => {
    expect(sh).not.toMatch(/notify_once\s+"budget-/)
  })
  it('still logs it and keeps the persistent-config (model) notification', () => {
    expect(sh).toContain('elfogyott az ora-keret')
    expect(sh).toMatch(/notify_once\s+"model-\$a"/)
  })
})
