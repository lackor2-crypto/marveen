// #406, 17. pont -- DIKTALAS ES FELOLVASAS a Munkapadon, a bongeszo sajat
// eszkozeivel (Web Speech API / speechSynthesis). A felulet tenyleges
// kimenetet merjuk (web/workbench.js fut), hamis bongeszo-eszkozokkel.
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const ITEM = { id: 'w1', title: 'Ajánlat', type: 'note', status: 'draft', current_version_id: 'v1' }
const PROJECT = { id: 'p1', name: 'Kovács weboldal', archived: false }

async function openItem(h: ReturnType<typeof workbenchHarness>, previewText = 'Első mondat. Második mondat.') {
  h.respond((url) => {
    if (url.includes('/preview')) return { status: 200, body: { available: true, kind: 'text', text: previewText, rel: 'a.md' } }
    if (url.includes('/api/workbench/items/w1')) {
      return { status: 200, body: { item: ITEM, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: [], project: PROJECT } }
    }
    return { status: 200, body: itemsBody([ITEM]) }
  })
  h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
  await vi.waitFor(() => expect(h.html()).toMatch(/wb-items/))
  h.click({ 'data-wb-item': 'w1' })
  await vi.waitFor(() => expect(h.html()).toContain('wb-preview-text'))
}

class FakeRec {
  static last: FakeRec | null = null
  lang = ''
  interimResults = false
  continuous = false
  started = false
  stopped = false
  onresult: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onend: (() => void) | null = null
  constructor() { FakeRec.last = this }
  start() { this.started = true }
  stop() { this.stopped = true }
}

describe('diktalas (#406, 17. pont)', () => {
  it('a chat mezo mellett ott a Diktalas gomb, a Kuldes gombbal egy sorban, a mezo alatt', async () => {
    const h = workbenchHarness()
    await openItem(h)
    const html = h.html()
    const row = html.slice(html.indexOf('class="wb-chat-row"'))
    const btns = row.indexOf('class="wb-chat-btns"')
    expect(btns).toBeGreaterThan(row.indexOf('id="wbChatInput"'))
    expect(row.slice(btns)).toContain('data-wb-dict="wbChatInput"')
    expect(row.slice(btns)).toContain('data-wb-act="chat-send"')
  })

  it('ha a bongeszo nem tud diktalni, emberi mondat mondja meg, mi a teendo (nem nema)', async () => {
    const h = workbenchHarness()
    await openItem(h)
    h.click({ 'data-wb-act': 'dict', 'data-wb-dict': 'wbChatInput' })
    expect(h.toasts.join('\n')).toContain('workbench.voice.no_dictation')
  })

  it('a hallott szoveg a meglevo szoveg UTAN kerul a mezobe, a Kuldes pedig leallitja a diktalast', async () => {
    const h = workbenchHarness()
    h.win.webkitSpeechRecognition = FakeRec
    await openItem(h)
    h.inputs['wbChatInput'] = { value: 'Szia,', focus() {} }
    h.click({ 'data-wb-act': 'dict', 'data-wb-dict': 'wbChatInput' })
    const rec = FakeRec.last!
    expect(rec.started).toBe(true)
    expect(rec.lang).toBe('hu-HU')
    expect(h.html()).toContain('workbench.voice.mic_stop')
    rec.onresult!({ resultIndex: 0, results: [Object.assign([{ transcript: 'kérek egy ajánlatot' }], { isFinal: true })] })
    expect(h.inputs['wbChatInput'].value).toBe('Szia, kérek egy ajánlatot')
    // Felig hallott (interim) resz latszik, de a vegen nem marad bent.
    rec.onresult!({ resultIndex: 1, results: [Object.assign([{ transcript: 'kérek egy ajánlatot' }], { isFinal: true }), Object.assign([{ transcript: 'hol' }], { isFinal: false })] })
    expect(h.inputs['wbChatInput'].value).toBe('Szia, kérek egy ajánlatot hol')
    h.click({ 'data-wb-act': 'dict', 'data-wb-dict': 'wbChatInput' })
    expect(rec.stopped).toBe(true)
    rec.onend!()
    expect(h.inputs['wbChatInput'].value).toBe('Szia, kérek egy ajánlatot')
    expect(h.html()).toContain('workbench.voice.mic⟧')
  })

  it('a mikrofon megtagadasa a teendot mondja (lakat ikon), nem a gepi kodot', async () => {
    const h = workbenchHarness()
    h.win.SpeechRecognition = FakeRec
    await openItem(h)
    h.click({ 'data-wb-act': 'dict', 'data-wb-dict': 'wbChatInput' })
    FakeRec.last!.onerror!({ error: 'not-allowed' })
    FakeRec.last!.onend!()
    expect(h.toasts.join('\n')).toContain('workbench.voice.err_denied')
  })

  it('az uj szoveges resz mezojeben a begepelt szoveg tuleli az ujrarajzolast', async () => {
    const h = workbenchHarness()
    await openItem(h)
    h.click({ 'data-wb-act': 'part-new-text' })
    expect(h.html()).toContain('id="wbPartNewText"')
    h.inputs['wbPartNewText'] = { value: 'félig megírt szöveg', focus() {} }
    // Barmilyen ujrarajzolas (itt: a Diktalas gomb megjelenik a mezo mellett).
    h.click({ 'data-wb-act': 'layout-toggle' })
    expect(h.html()).toContain('>félig megírt szöveg</textarea>')
    expect(h.html()).toContain('data-wb-dict="wbPartNewText"')
  })
})

describe('felolvasas (#406, 17. pont)', () => {
  it('ha a bongeszo nem tud felolvasni, nincs gomb (nem kinal olyat, ami nem megy)', async () => {
    const h = workbenchHarness()
    await openItem(h)
    expect(h.html()).not.toContain('data-wb-act="tts"')
  })

  it('a szoveg rovid darabokban, a felulet nyelven, jelolo-karakterek nelkul szol', async () => {
    const h = workbenchHarness()
    const spoken: { text: string; lang: string }[] = []
    let cancelled = 0
    h.win.SpeechSynthesisUtterance = function (this: Record<string, unknown>, text: string) { this.text = text }
    h.win.speechSynthesis = {
      getVoices: () => [{ lang: 'hu-HU', name: 'Magyar' }],
      speak: (u: { text: string; lang: string }) => { spoken.push({ text: u.text, lang: u.lang }) },
      cancel: () => { cancelled++ },
    }
    await openItem(h, '# Cím\n\nEz **fontos** mondat. ' + 'Hosszú szöveg darab. '.repeat(30))
    expect(h.html()).toContain('data-wb-tts="preview"')
    h.click({ 'data-wb-act': 'tts', 'data-wb-tts': 'preview' })
    expect(spoken.length).toBeGreaterThan(1)
    expect(spoken.every((s) => s.lang === 'hu-HU' && s.text.length <= 220)).toBe(true)
    expect(spoken.map((s) => s.text).join(' ')).not.toMatch(/[#*]/)
    expect(h.html()).toContain('workbench.voice.tts_stop')
    h.click({ 'data-wb-act': 'tts', 'data-wb-tts': 'preview' })
    expect(cancelled).toBeGreaterThan(0)
    expect(h.html()).not.toContain('workbench.voice.tts_stop')
  })

  it('ha nincs magyar hang telepitve, kimondja, hol lehet hozzaadni', async () => {
    const h = workbenchHarness()
    h.win.SpeechSynthesisUtterance = function (this: Record<string, unknown>, text: string) { this.text = text }
    h.win.speechSynthesis = { getVoices: () => [{ lang: 'en-US' }], speak: () => {}, cancel: () => {} }
    await openItem(h)
    h.click({ 'data-wb-act': 'tts', 'data-wb-tts': 'preview' })
    expect(h.toasts.join('\n')).toContain('workbench.voice.no_voice')
  })
})

describe('ketnyelvu szovegek (#406, 17. pont)', () => {
  const root = path.join(__dirname, '..', '..', 'web')
  const src = fs.readFileSync(path.join(root, 'workbench.js'), 'utf8')
  const used = new Set([...src.matchAll(/'(workbench\.voice\.[a-z_]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('_')))
  // A hibakodokat a DICT_ERRORS tabla kepzi ('workbench.voice.err_' + k), ezert
  // a regex nem latja oket -- kulon vesszuk fel.
  for (const k of ['denied', 'no_speech', 'no_mic', 'network', 'lang', 'other']) used.add('workbench.voice.err_' + k)
  for (const f of ['hu.js', 'en.js']) {
    it(f + ': minden diktalas/felolvasas kulcs megvan', () => {
      const lang = fs.readFileSync(path.join(root, 'lang', f), 'utf8')
      for (const k of used) expect(lang, k).toContain('"' + k + '"')
    })
  }
})
