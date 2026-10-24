// #770: the owner's ONE remark for the whole Inbox list goes into the AI request, ranks above the AI's own guess,
// and the AI says for which item it really used it.
import { describe, it, expect, afterEach } from 'vitest'
import {
  buildPrompt, parseAiAnswer, classifyWithAi, mergeAiIntoSuggestion, setAiRunners, resetLimitCooldown, type ClaudeAccount,
} from '../life-inbox-ai.js'
import type { InboxSuggestion, KnownFolder } from '../life-inbox-analyze.js'

const config = {
  persons: [{ id: 'p2', name: 'Bakos Éva', role: '', countries: [], mediaGroups: [] }],
  companies: [],
} as any
const folders: KnownFolder[] = [{ rel: 'Bakos Éva/Hatóságok', display: '', personId: 'p2' }]
const item = { name: 'level.pdf', kind: 'pdf', text: 'x', metadata: {}, dateCandidates: [] }
const NOTE = 'a level.pdf a szocialis hivataltol jott, Bakos Evahoz tartozik'

function suggestion(name: string): InboxSuggestion {
  return {
    name, rel: name, credentialWarning: '',
    type: { value: 'pdf', label: 'PDF', confidence: 1 },
    owner: { personId: '', name: '', confidence: 0, uncertain: true, options: [] },
    date: { value: '2026-08-23', source: 'filedate', confidence: 0.2, alternatives: [] },
    category: { key: '', label: '', confidence: 0 },
    targetRel: 'Bakos Éva/Hatóságok', targetDisplay: '', targetExists: true,
    suggestedName: 'x', ext: '.pdf', needsReview: true, notes: [],
  } as InboxSuggestion
}

afterEach(() => { setAiRunners({ claude: null, ollama: null, accounts: null }); resetLimitCooldown() })

describe('#770 owner note in the AI request', () => {
  it('the prompt carries the note only when there is one', () => {
    expect(JSON.parse(buildPrompt([item], config, folders, 'hu', false)).ownerNote).toBeUndefined()
    expect(JSON.parse(buildPrompt([item], config, folders, 'hu', false, NOTE)).ownerNote).toBe(NOTE)
    expect(JSON.parse(buildPrompt([item], config, folders, 'hu', true, NOTE)).ownerNote).toBe(NOTE)
  })

  it('noteUsed is read as a strict boolean and shows on the merged suggestion', () => {
    const answer = JSON.stringify({ items: [
      { name: 'level.pdf', ownerId: 'p2', targetRel: 'Bakos Éva/Hatóságok', confidence: 0.9, noteUsed: true },
      { name: 'masik.pdf', ownerId: 'p2', confidence: 0.9, noteUsed: 'true' },
    ] })
    const got = parseAiAnswer(answer, ['level.pdf', 'masik.pdf'], config, folders)
    expect(got.map((g) => g.noteUsed)).toEqual([true, false])
    const merged = mergeAiIntoSuggestion(suggestion('level.pdf'), got[0], { engine: 'claude', model: 'm' }, config)
    expect(merged.ai?.noteUsed).toBe(true)
    const plain = mergeAiIntoSuggestion(suggestion('masik.pdf'), got[1], { engine: 'claude', model: 'm' }, config)
    expect(plain.ai?.noteUsed).toBeUndefined()
  })

  it('classifyWithAi hands the note to the Claude runner (and the local model on the fallback)', async () => {
    const seen: string[] = []
    const acc: ClaudeAccount = { agent: 'a', configDir: 'a', model: 'claude-opus-5', fiveHourPct: 0, usageAt: Date.now() }
    setAiRunners({
      accounts: () => [acc],
      claude: async (_sys, prompt) => { seen.push(prompt); return null },
      ollama: async (_sys, prompt) => { seen.push(prompt); return null },
    })
    await classifyWithAi([{ suggestion: suggestion('level.pdf'), prefetched: undefined }], config, folders, 'hu', NOTE)
    expect(seen.length).toBeGreaterThanOrEqual(2)
    for (const p of seen) expect(JSON.parse(p).ownerNote).toBe(NOTE)
  })
})
