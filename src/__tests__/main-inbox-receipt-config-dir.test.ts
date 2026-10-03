// The main agent's receipt ("Megkaptam, sorban all") read the transcript under the shared ~/.claude,
// while the main channels session runs on its own CLAUDE_CONFIG_DIR (e.g. ~/.claude-marvin). The
// shared directory held a 20-day-old file, no queue-operation ever appeared, and a message that
// arrived during a long turn never got its receipt (Boss, TG 7461). Same class as #413.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { transcriptDirInConfig } from '../web/main-inbox-receipt.js'

describe('transcriptDirInConfig', () => {
  it('follows the config root the main agent runs on', () => {
    expect(transcriptDirInConfig('/opt/marveen', '/home/geza/.claude-marvin')).toBe('/home/geza/.claude-marvin/projects/-opt-marveen')
  })
  it('is what startMainInboxReceipt reads, resolved on every read', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'main-inbox-receipt.ts'), 'utf-8')
    expect(src).toContain('get transcriptDir() { return transcriptDirInConfig(PROJECT_ROOT, mainAgentEffectiveConfigDir()) }')
    expect(src).not.toContain('transcriptDir: transcriptDirFor(PROJECT_ROOT)')
  })
})
