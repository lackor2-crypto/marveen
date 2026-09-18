// Card 56530b08: the Inbox AI step. Boss: Claude from the own subscription,
// always the smartest model, and "ha nincs is claude fiok a gepen akkor ne
// lepodjon meg es azzal csinalja ami van a gepen!" -- these tests pin the
// fallback chain and, above all, that nothing the model invents gets through.
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  orderClaudeAccounts, parseAiAnswer, validNewFolder, pickOllamaModel,
  classifyWithAi, mergeAiIntoSuggestion, setAiRunners, resetLimitCooldown, type ClaudeAccount,
} from '../life-inbox-ai.js'
import type { InboxSuggestion, KnownFolder } from '../life-inbox-analyze.js'

const config = {
  persons: [
    { id: 'p1', name: 'Korpás László', role: 'owner', countries: [], mediaGroups: [] },
    { id: 'p2', name: 'Bakos Éva', role: '', countries: [], mediaGroups: [] },
  ],
  companies: [],
} as any

const folders: KnownFolder[] = [
  { rel: 'Korpás László/Hatóságok', display: '', personId: 'p1' },
  { rel: 'Korpás László/Hatóságok/Németország', display: '', personId: 'p1' },
  { rel: 'Korpás László/Személyes', display: '', personId: 'p1' },
]

function suggestion(name: string, extra: Partial<InboxSuggestion> = {}): InboxSuggestion {
  return {
    name, rel: name, credentialWarning: '',
    type: { value: 'pdf', label: 'PDF', confidence: 1 },
    owner: { personId: '', name: '', confidence: 0, uncertain: true, options: [] },
    date: { value: '2026-08-23', source: 'filedate', confidence: 0.2, alternatives: [] },
    category: { key: '', label: '', confidence: 0 },
    targetRel: 'Korpás László/Személyes', targetDisplay: '', targetExists: true,
    suggestedName: 'x', ext: '.pdf', needsReview: true, notes: [],
    ...extra,
  } as InboxSuggestion
}

const acc = (agent: string, model: string, pct: number | null, dir = agent): ClaudeAccount =>
  ({ agent, configDir: dir, model, fiveHourPct: pct, usageAt: pct === null ? null : Date.now() })

afterEach(() => { setAiRunners({ claude: null, ollama: null, accounts: null }); resetLimitCooldown() })

describe('orderClaudeAccounts', () => {
  it('csak Claude-modellu, nem kimerult fiok; a legtobb szabad keret elol', () => {
    const out = orderClaudeAccounts([
      acc('free', 'openrouter/gemma-3', 0),
      acc('tele', 'claude-opus-5', 99),
      acc('felig', 'claude-sonnet-5', 60),
      acc('friss', 'claude-opus-5', 10),
    ])
    expect(out.map((a) => a.agent)).toEqual(['friss', 'felig'])
  })

  it('a heti keretet tenylegesen kimerito fiokot kihagyja (az a hivast is megfogja)', () => {
    const out = orderClaudeAccounts([{ ...acc('heti', 'claude-opus-5', 0), sevenDayPct: 100 }, acc('jo', 'claude-opus-5', 40)])
    expect(out.map((a) => a.agent)).toEqual(['jo'])
  })

  it('egy bejelentkezest csak egyszer probal, akarhany agens osztozik rajta', () => {
    const out = orderClaudeAccounts([acc('a', 'claude-opus-5', 10, 'kozos'), acc('b', 'claude-opus-5', 20, 'kozos')])
    expect(out).toHaveLength(1)
  })
})

describe('validNewFolder', () => {
  const known = new Set(folders.map((f) => f.rel))
  it('letezo mappa ala egy-ket uj szintet enged', () => {
    expect(validNewFolder('Korpás László/Hatóságok/Németország/Einwohnermeldeamt', known)).toBe('Korpás László/Hatóságok/Németország/Einwohnermeldeamt')
    expect(validNewFolder('Korpás László/Hatóságok/Ausztria/Bécs', known)).toBe('Korpás László/Hatóságok/Ausztria/Bécs')
  })
  it('kitalalt gyokeret, kiszokest, tiltott karaktert, letezo mappat NEM', () => {
    expect(validNewFolder('Idegen Ember/Hatóságok', known)).toBe('')
    expect(validNewFolder('Korpás László/../../etc', known)).toBe('')
    expect(validNewFolder('Korpás László/Hatóságok/a:b', known)).toBe('')
    expect(validNewFolder('Korpás László/Hatóságok', known)).toBe('')
    expect(validNewFolder('Korpás László/a/b/c', known)).toBe('')
  })
})

describe('parseAiAnswer', () => {
  it('eldobja a kitalalt tulajdonost, mappat, datumot es az ismeretlen tetelt', () => {
    const text = '```json\n' + JSON.stringify({ items: [
      { name: 'a.pdf', ownerId: 'nincs-ilyen', date: '2021-02-31', targetRel: 'Kitalalt/Mappa', newFolderRel: '', suggestedName: 'a/b:c', confidence: 3 },
      { name: 'b.pdf', ownerId: 'p1', date: '2017-06-15', targetRel: 'Korpás László/Hatóságok/Németország', suggestedName: 'Korpás László_2017-06_Meldebestätigung' },
      { name: 'idegen.pdf', ownerId: 'p1' },
    ] }) + '\n```'
    const out = parseAiAnswer(text, ['a.pdf', 'b.pdf'], config, folders)
    expect(out).toHaveLength(2)
    const a = out.find((r) => r.name === 'a.pdf')!
    expect(a.ownerId).toBe('')
    expect(a.date).toBe('')
    expect(a.targetRel).toBe('')
    expect(a.suggestedName).toBe('abc')
    expect(a.confidence).toBe(1)
    const b = out.find((r) => r.name === 'b.pdf')!
    expect(b).toMatchObject({ ownerId: 'p1', date: '2017-06-15', targetRel: 'Korpás László/Hatóságok/Németország' })
  })

  it('ertelmetlen valaszra ures lista, nem kivetel', () => {
    expect(parseAiAnswer('bocs, nem tudom', ['a.pdf'], config, folders)).toEqual([])
  })
})

describe('pickOllamaModel', () => {
  it('a legnagyobb beszelgeto modellt valasztja, beagyazo modellt soha', () => {
    expect(pickOllamaModel([
      { name: 'nomic-embed-text', size: 9e9 }, { name: 'qwen2.5:3b', size: 2e9 }, { name: 'llama3:8b', size: 5e9 },
    ])).toBe('llama3:8b')
    expect(pickOllamaModel([{ name: 'nomic-embed-text', size: 1 }])).toBe('')
  })
})

describe('classifyWithAi -- a lanc', () => {
  const inputs = [{ suggestion: suggestion('b.pdf'), prefetched: undefined }]
  const good = JSON.stringify({ items: [{ name: 'b.pdf', ownerId: 'p1', date: '2017-06-15', targetRel: 'Korpás László/Hatóságok/Németország', confidence: 0.9 }] })

  it('Claude valaszol -> Claude', async () => {
    let ollamaCalled = false
    setAiRunners({
      accounts: () => [acc('usa', 'claude-opus-5', 5)],
      claude: async () => ({ text: good, model: 'claude-opus-5' }),
      ollama: async () => { ollamaCalled = true; return null },
    })
    const run = await classifyWithAi(inputs, config, folders, 'hu')
    expect(run.engine).toBe('claude')
    expect(run.model).toBe('claude-opus-5')
    expect(run.results[0].ownerId).toBe('p1')
    expect(ollamaCalled).toBe(false)
  })

  it('nincs Claude-fiok -> a gepen levo helyi modell, es ezt ki is mondja', async () => {
    setAiRunners({ accounts: () => [], ollama: async () => ({ text: good, model: 'qwen2.5:3b' }) })
    const run = await classifyWithAi(inputs, config, folders, 'hu')
    expect(run.engine).toBe('ollama')
    expect(run.note).toContain('nincs használható Claude-fiók')
  })

  it('a helyi modell nev nelkuli egytetelest valasza is ervenyes', async () => {
    setAiRunners({ accounts: () => [], ollama: async () => ({ text: JSON.stringify({ ownerId: 'p1', date: '2017-06-15' }), model: 'q' }) })
    const run = await classifyWithAi(inputs, config, folders, 'hu')
    expect(run.results[0]).toMatchObject({ name: 'b.pdf', ownerId: 'p1' })
  })

  it('semmi nincs a gepen -> nem dob hibat, a szabalyok maradnak, es ezt mondja', async () => {
    setAiRunners({ accounts: () => [], ollama: async () => 'missing' })
    const run = await classifyWithAi(inputs, config, folders, 'hu')
    expect(run.engine).toBe('none')
    expect(run.note).toContain('nincs elérhető AI')
  })

  it('van helyi modell, de nem valaszol -> NEM azt mondja, hogy nincs', async () => {
    setAiRunners({ accounts: () => [], ollama: async () => null })
    const run = await classifyWithAi(inputs, config, folders, 'hu')
    expect(run.engine).toBe('none')
    expect(run.note).not.toContain('nincs elérhető AI')
    expect(run.note).toContain('nem válaszolt')
  })

  it('a Claude-hiba utan a kovetkezo fiokot, majd a helyi modellt probalja', async () => {
    const tried: string[] = []
    setAiRunners({
      accounts: () => [acc('a', 'claude-opus-5', 1), acc('b', 'claude-opus-5', 2)],
      claude: async (_s, _p, account) => { tried.push(account.agent); return null },
      ollama: async () => ({ text: good, model: 'q' }),
    })
    const run = await classifyWithAi(inputs, config, folders, 'hu')
    expect(tried).toEqual(['a', 'b'])
    expect(run.engine).toBe('ollama')
    expect(run.note).toContain('a Claude most nem válaszolt')
  })

  it('a "limit" valaszu fiok utan a kovetkezot probalja, es a kovetkezo korben mar nem kerdezi', async () => {
    // 2026-09-18, eles eset: a mentett szazalek elavult volt -- a "36%"-os
    // fiok mar a munkamenet-keret vegen allt, a harmadik (jo) fiokot pedig a
    // regi ket-probas korlat miatt senki nem kerdezte meg.
    const tried: string[] = []
    setAiRunners({
      accounts: () => [acc('a', 'claude-opus-5', 0), acc('b', 'claude-opus-5', 36), acc('c', 'claude-opus-5', 44)],
      claude: async (_s, _p, account) => { tried.push(account.agent); return account.agent === 'c' ? { text: good, model: 'claude-opus-5' } : 'limit' },
      ollama: async () => { throw new Error('nem kellene ide jutni') },
    })
    const run1 = await classifyWithAi(inputs, config, folders, 'hu')
    expect(run1.engine).toBe('claude')
    expect(tried).toEqual(['a', 'b', 'c'])
    tried.length = 0
    await classifyWithAi(inputs, config, folders, 'hu')
    expect(tried).toEqual(['c'])
  })

  it('a helyi modell egy kereson belul idokeretet tart, a maradek "pending" (a 300 s-os HTTP-korlat alatt)', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-18T10:00:00Z') })
    try {
      const many = ['a.pdf', 'b.pdf', 'c.pdf'].map((n) => ({ suggestion: suggestion(n), prefetched: undefined }))
      setAiRunners({
        accounts: () => [],
        ollama: async () => {
          vi.setSystemTime(Date.now() + 90_000)
          return { text: JSON.stringify({ ownerId: 'p1' }), model: 'q' }
        },
      })
      const run = await classifyWithAi(many, config, folders, 'hu')
      expect(run.results.map((r) => r.name)).toEqual(['a.pdf', 'b.pdf'])
      expect(run.pending).toEqual(['c.pdf'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('hitelesito adatot tartalmazo tetelt SOHA nem kuld el', async () => {
    let sent = ''
    setAiRunners({ accounts: () => [acc('a', 'claude-opus-5', 1)], claude: async (_s, p) => { sent = p; return null }, ollama: async () => 'missing' })
    await classifyWithAi([{ suggestion: suggestion('jelszo.txt', { credentialWarning: 'x' }), prefetched: undefined }], config, folders, 'hu')
    expect(sent).toBe('')
  })
})

describe('mergeAiIntoSuggestion', () => {
  it('uj mappa javaslatnal targetExists false, es a regi datum alternativa lesz', () => {
    const s = suggestion('b.pdf')
    const out = mergeAiIntoSuggestion(s, {
      name: 'b.pdf', ownerId: 'p1', docType: 'Meldebestätigung', summary: 'x', date: '2017-06-15',
      targetRel: '', newFolderRel: 'Korpás László/Hatóságok/Németország/Einwohnermeldeamt',
      suggestedName: 'Korpás László_2017-06_Meldebestätigung', reason: 'r', confidence: 0.9,
    }, { engine: 'claude', model: 'claude-opus-5' }, config)
    expect(out.owner.personId).toBe('p1')
    expect(out.date).toMatchObject({ value: '2017-06-15', source: 'ai' })
    expect(out.date.alternatives?.[0]).toMatchObject({ value: '2026-08-23', source: 'filedate' })
    expect(out.targetRel).toBe('Korpás László/Hatóságok/Németország/Einwohnermeldeamt')
    expect(out.targetExists).toBe(false)
    expect(out.ai).toMatchObject({ engine: 'claude', newFolder: true, docType: 'Meldebestätigung' })
    expect(out.needsReview).toBe(true)
  })
})
