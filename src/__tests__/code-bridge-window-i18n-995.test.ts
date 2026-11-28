// #995: with English selected most of the code bridge window stayed Hungarian (setup list, send form, task
// list, settings, toasts). Every text of the window has to come from the language files.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { PROJECT_ROOT } from '../config.js'

const read = (...p: string[]) => readFileSync(join(PROJECT_ROOT, 'web', ...p), 'utf8')
const app = read('app.js')
const html = read('index.html')

function dict(lang: 'hu' | 'en'): Record<string, string> {
  const window = { _i18n: {} as Record<string, Record<string, string>> }
  vm.runInContext(read('lang', `${lang}.js`), vm.createContext({ window }))
  return window._i18n[lang]
}
const hu = dict('hu')
const en = dict('en')
const ACCENT = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/
// Hungarian words without an accent that the old window texts used.
const PLAIN = /\b(nincs|sorban|fut|kikapcsolva|projekt|mappa|hiba|nem|egy)\b/

const overlayStart = html.indexOf('<div class="modal-overlay" id="cbOverlay">')
const overlay = html.slice(overlayStart, html.indexOf('<div class="modal-overlay"', overlayStart + 40))
  .replace(/<!--[\s\S]*?-->/g, '')

describe('code bridge window speaks the selected language (#995)', () => {
  it('the script of the window writes no Hungarian text itself', () => {
    const sf = ts.createSourceFile('app.js', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const from = app.indexOf('// === Kod-hid (VS Code Claude Code bridge) ===')
    const last = app.indexOf("t('cb.send.too_long'", from)
    const idle = app.indexOf('function cbIdleCardEntry(')
    expect(from).toBeGreaterThan(0)
    expect(last).toBeGreaterThan(from)
    const ranges = [[from, last + 200], [idle, app.indexOf('\n}\n', idle)]]
    const found: string[] = []
    const visit = (n: ts.Node) => {
      let text: string | null = null
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text
      else if (ts.isTemplateExpression(n)) text = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ')
      if (text !== null && ranges.some(([a, b]) => n.getStart() >= a && n.end <= b)) {
        const visible = text.replace(/<[^>]*>|\b(?:cb|data|class)[-\w.]+/g, ' ')
        if (ACCENT.test(visible) || PLAIN.test(visible)) found.push(text)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(found).toEqual([])
  })

  it('every Hungarian text in the markup of the window has a translation key', () => {
    const voids = new Set(['input', 'br', 'img', 'meta', 'link', 'hr', 'path', 'circle', 'rect', 'line', 'polyline'])
    const stack: { tag: string; keyed: boolean }[] = []
    const bare: string[] = []
    for (const m of overlay.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|[^>"])*)>|([^<]+)/g)) {
      const [, closing, tag, attrs, text] = m
      if (text !== undefined) {
        if ((ACCENT.test(text) || PLAIN.test(text)) && !stack.some((s) => s.keyed)) bare.push(text.trim())
        continue
      }
      if (closing) { while (stack.length && stack.pop()!.tag !== tag); continue }
      for (const a of ['placeholder', 'title', 'aria-label']) {
        const v = new RegExp(`\\s${a}="([^"]*)"`).exec(attrs)
        if (v && ACCENT.test(v[1]) && !attrs.includes(`data-i18n-${a}=`)) bare.push(v[1])
      }
      if (!voids.has(tag) && !attrs.endsWith('/')) stack.push({ tag, keyed: /\sdata-i18n(?:-html)?="/.test(attrs) })
    }
    expect(bare).toEqual([])
  })

  it('no element of the window carries two text keys (the first one silently wins)', () => {
    for (const m of overlay.matchAll(/<[a-zA-Z](?:"[^"]*"|[^>"])*>/g)) {
      expect((m[0].match(/\sdata-i18n(?:-html)?="/g) ?? []).length, m[0]).toBeLessThanOrEqual(1)
    }
  })

  it('every key the window asks for exists in both languages, and the English one is English', () => {
    const keys = new Set<string>()
    for (const m of overlay.matchAll(/data-i18n(?:-\w+(?:-\w+)?)?="([\w.]+)"/g)) keys.add(m[1])
    for (const m of app.matchAll(/\b(?:t|tHtml)\(\s*'(cb\.[\w.]*[a-z0-9])'/g)) keys.add(m[1])
    for (const s of ['queued', 'running', 'done', 'error', 'cancelled']) keys.add(`cb.taskstate.${s}`)
    for (const k of ['intro_wsl', 'intro_windows', 'intro_other']) keys.add(`cb.worker.${k}`)
    for (const k of ['none_online', 'none_offline']) keys.add(`cb.cand.${k}`)
    expect([...keys].filter((k) => !hu[k] || !en[k])).toEqual([])
    expect([...keys].filter((k) => k.startsWith('cb.') && ACCENT.test(en[k]))).toEqual([])
  })

  it('keeps a long translated option inside a phone-wide window', () => {
    const css = read('style.css')
    expect(css).toMatch(/#cbModalBody select\.input \{[^}]*max-width: 100%/)
  })

  it('takes the monogram of the bridge icon from the language files', () => {
    expect(app).toContain("el.textContent = t('cb.monogram')")
    expect([hu['cb.monogram'], en['cb.monogram']]).toEqual(['K', 'C'])
  })
})
