// Card #467: bilingual translator + read-aloud in the text editor (two columns) and the reader.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  const home = mkdtempSync(real.tmpdir() + '/wb-tr-home-')
  return { ...real, default: { ...real, homedir: () => home }, homedir: () => home }
})
vi.mock('../web/vault.js', () => ({ getSecret: vi.fn(() => 'test-key') }))
import { getSecret } from '../web/vault.js'
import { initDatabase } from '../db.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('server: POST /api/workbench/translate reuses the email translator', () => {
  const realFetch = globalThis.fetch
  let prompts: string[] = []
  beforeEach(() => {
    initDatabase(':memory:')
    prompts = []
    ;(getSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue('test-key')
    globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body))
      prompts.push(body.messages[0].content)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'FORDITAS ' + prompts.length } }] }), { status: 200 })
    }) as typeof fetch
  })
  afterEach(() => { globalThis.fetch = realFetch })

  it('translates with the picked pair and returns the text', async () => {
    const r = await callWorkbench('/api/workbench/translate', 'POST', { text: 'Hello world, this is a test of the thing.', source_lang: 'en', target_lang: 'hu' })
    expect(r.status).toBe(200)
    expect(r.body.translation).toBe('FORDITAS 1')
    expect(r.body.target_lang).toBe('hu')
    expect(prompts[0]).toContain('from English into Hungarian')
  })
  it('long text goes in paragraph-sized pieces and comes back joined in order', async () => {
    const para = (n: number) => `part${n} ` + 'word '.repeat(500)
    const r = await callWorkbench('/api/workbench/translate', 'POST', { text: [para(1), para(2), para(3)].join('\n\n'), source_lang: 'en', target_lang: 'de' })
    expect(r.status).toBe(200)
    expect(prompts.length).toBeGreaterThan(1)
    expect(r.body.translation).toBe(prompts.map((_, i) => 'FORDITAS ' + (i + 1)).join('\n\n'))
  })
  it('says in a human sentence when there is no key, no text, or the text is too long', async () => {
    ;(getSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue('')
    const a = await callWorkbench('/api/workbench/translate', 'POST', { text: 'hello', target_lang: 'hu' })
    expect(a.status).toBe(503)
    expect(a.body.message).toMatch(/OpenRouter/)
    const b = await callWorkbench('/api/workbench/translate', 'POST', { text: '  ' })
    expect(b.status).toBe(400)
    const c = await callWorkbench('/api/workbench/translate', 'POST', { text: 'x'.repeat(30_001) })
    expect(c.status).toBe(413)
  })
  it('a failed model call is an error, not a "translation"', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as typeof fetch
    const r = await callWorkbench('/api/workbench/translate', 'POST', { text: 'Hello there my friend, how are you doing today?', source_lang: 'en', target_lang: 'hu' })
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('translate_failed')
  })
})

describe('UI: the editor columns and the reader', () => {
  const ITEM = { id: 'w1', title: 'Jegyzet', type: 'note', status: 'draft', current_version_id: 'v1' }
  function setup() {
    const h = workbenchHarness()
    const calls: Record<string, unknown>[] = []
    h.respond((url, init) => {
      if (url.includes('/api/workbench/translate')) {
        const b = JSON.parse(String(init!.body)); calls.push(b)
        return { status: 200, body: { translation: 'HELLO VILAG', source_lang: 'hu', target_lang: b.target_lang } }
      }
      if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'text', name: 'terv.md', text: 'Szia vilag', truncated: false, version_id: 'v1' } }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: ITEM, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project: { id: 'p1', name: 'K' } } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'K' }) }
    })
    h.win.MarvinWorkbench.open('p1', 'K')
    return { h, calls }
  }
  async function toEdit(h: ReturnType<typeof workbenchHarness>) {
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="text-edit"'))
    h.click({ 'data-wb-act': 'text-edit' })
  }

  it('both columns have a language picker; the right has the Final / Translation switch', async () => {
    const { h } = setup(); await toEdit(h)
    const html = h.html()
    expect(html).toContain('data-wb-tr="src"')
    expect(html).toContain('data-wb-tr="dst"')
    expect(html).toContain('data-wb-act="tr-mode" data-wb-mode="final"')
    expect(html).toContain('data-wb-act="tr-mode" data-wb-mode="translation"')
    expect(html).toContain('id="wbTextEditLive"')
  })
  it('the Translation mode translates the editor text and shows it; typing then marks it old', async () => {
    const { h, calls } = setup(); await toEdit(h)
    h.click({ 'data-wb-act': 'tr-mode', 'data-wb-mode': 'translation' })
    await vi.waitFor(() => expect(h.html()).toContain('HELLO VILAG'))
    expect(calls[0]).toMatchObject({ text: 'Szia vilag', source_lang: 'auto' })
    expect(h.html()).not.toContain('wb-tr-stale')
    h.fire('input', { target: { id: 'wbTextEdit', value: 'Szia vilag!' } })
    h.click({ 'data-wb-act': 'layout-toggle' })
    expect(h.html()).toContain('wb-tr-stale')
  })
  it('swap makes the translation the editable text', async () => {
    const { h } = setup(); await toEdit(h)
    h.click({ 'data-wb-act': 'tr-mode', 'data-wb-mode': 'translation' })
    await vi.waitFor(() => expect(h.html()).toContain('HELLO VILAG'))
    h.click({ 'data-wb-act': 'tr-swap' })
    expect(h.html()).toContain('>HELLO VILAG</textarea>')
  })
  it('read-aloud buttons exist per column with their own language when speech is available', async () => {
    const { h } = setup()
    h.win.speechSynthesis = { speak() {}, cancel() {}, getVoices: () => [] }
    h.win.SpeechSynthesisUtterance = function () {}
    await toEdit(h)
    expect(h.html()).toContain('data-wb-tts="tr-left"')
    expect(h.html()).toContain('data-wb-tts="tr-right"')
  })
  it('the reader view offers the translation next to the existing read-aloud, and no raw Hungarian', async () => {
    const { h } = setup()
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="tr-mode"'))
    h.click({ 'data-wb-act': 'tr-mode', 'data-wb-mode': 'translation' })
    await vi.waitFor(() => expect(h.html()).toContain('HELLO VILAG'))
    expect(untranslatedHungarian(h.html(), ['Jegyzet', 'Szia vilag', 'HELLO VILAG', 'terv.md'])).toBe('')
  })
})
