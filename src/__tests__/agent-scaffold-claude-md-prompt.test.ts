// The "Új ismeretlen sender első üzenete (ARANYSZABÁLY)" block was REMOVED from
// generateClaudeMd() on 2026-08-25 (Boss, voice 482): "ez az ismeretlen szender
// ... megint csak hülyeség, mert nincs ismeretlen küldő, ha csak nem feltörték a
// Marvin-t. tehát ezt is old meg, ez se korlátozzon." The channel allowlist
// (allowFrom in the plugin's access.json) is the real gate -- only senders the
// owner already paired can reach the agent at all -- so the extra ping-Marvin-
// first / generic-answers-only brake made an online agent stall for no security
// gain.
//
// This test now locks the REMOVAL: the block must not reappear in the prompt.
// (The old test asserted the block was present and bot-name agnostic; it guarded
// the 2026-06-01 Pap Csaba / Tanfield incident where the block hardcoded
// "marveen" as the ping target. With the whole block gone that failure mode is
// gone too.) The BOT_NAME import guard is kept because ${BOT_NAME} is still used
// elsewhere in the prompt.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCAFFOLD_PATH = join(__dirname, '..', 'web', 'agent-scaffold.ts')

describe('generateClaudeMd: stranger-sender ARANYSZABÁLY block is gone', () => {
  const src = readFileSync(SCAFFOLD_PATH, 'utf-8')

  const promptStart = src.indexOf('export async function generateClaudeMd')
  expect(promptStart, 'generateClaudeMd entry not found').toBeGreaterThan(0)
  const promptEnd = src.indexOf('export async function generateSoulMd')
  expect(promptEnd, 'generateSoulMd terminator not found').toBeGreaterThan(promptStart)
  const promptBody = src.slice(promptStart, promptEnd)

  it('no longer emits the stranger-sender ping restriction', () => {
    expect(promptBody).not.toContain('## Új ismeretlen sender első üzenete')
    expect(promptBody).not.toContain('ARANYSZABÁLY')
    // The load-bearing behaviour that must not come back: instructing a
    // sub-agent to ping the main agent before answering a "new" sender.
    expect(promptBody).not.toMatch(/Ismeretlen sender \[ID\]/)
  })

  it('still imports BOT_NAME from config (used elsewhere in the prompt)', () => {
    expect(src).toMatch(/import\s*{[^}]*\bBOT_NAME\b[^}]*}\s*from\s*'\.\.\/config\.js'/)
  })
})
