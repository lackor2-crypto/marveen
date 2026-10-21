import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CSS_NAMED_COLORS, normalizeCssColor } from '../css-color.js'

// Upstream #1875 (rebuilt): web/app.js escapes data at the sink with the helper
// of that context (escapeHtml, jsArg, escSnippet, safeHref, safeCssColor,
// tHtml). Upstream pinned that with a 3000-line parse5 sink scanner whose
// allowlist is keyed to upstream's app.js; this fork's app.js is a different
// file, so the scanner was not taken. What IS pinned here: the helpers behave,
// the dashboard's colour mirror is the same policy as src/css-color.ts (the
// shared vectors), and the sinks fixed in this fork stay fixed.

const src = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')

function extractFn(name: string): string {
  const start = src.indexOf(`\nfunction ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found in web/app.js`)
  const open = src.indexOf('{', src.indexOf(')', start))
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 1, i + 1)
  }
  throw new Error(`function ${name} is not closed`)
}

const colorStart = src.indexOf('const CSS_NAMED_COLORS = {')
const colorEnd = src.indexOf('// t() for a translation that is itself HTML')
if (colorStart < 0 || colorEnd < colorStart) throw new Error('the colour block of web/app.js moved')
const colorBlock = src.slice(colorStart, colorEnd)

// The page's escapeHtml goes through a DOM node; this stand-in does the same
// textContent -> innerHTML escaping of & < >.
const fakeDocument = {
  createElement: () => {
    let text = ''
    return {
      set textContent(v: unknown) { text = String(v) },
      get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') },
    }
  },
}

interface Helpers {
  escapeHtml(v: unknown): string
  esc(v: unknown): string
  jsArg(v: unknown): string
  escSnippet(raw: unknown, max: number): string
  safeHref(raw: unknown, opts?: { relative?: boolean }): string
  safeCssColor(v: unknown, fallback?: string): string
  tHtml(key: string, params?: Record<string, unknown>): string
  normalizeCssColor(v: unknown): string | null
  CSS_NAMED_COLORS: Record<string, string>
}

function load(): Helpers {
  const names = ['escapeHtml', 'esc', 'jsArg', 'escSnippet', 'safeHref', 'tHtml']
  const body = `${names.map(extractFn).join('\n')}\n${colorBlock}\n${extractFn('safeCssColor')}\n`
    + 'return { escapeHtml, esc, jsArg, escSnippet, safeHref, safeCssColor, tHtml, normalizeCssColor, CSS_NAMED_COLORS }'
  const win = {
    _brandTokens: { brand: 'A<b>' },
  }
  // t(key, params): the template is the key itself, {name} filled from params
  const t = (key: string, params: Record<string, unknown> = {}) => key.replace(/\{(\w+)\}/g, (m, n: string) => (n in params ? String(params[n]) : m))
  return new Function('document', 'window', 't', body)(fakeDocument, win, t) as Helpers
}

const h = load()

describe('web/app.js escaping helpers (upstream #1875, rebuilt)', () => {
  it('escapeHtml and esc are quote-safe for attributes', () => {
    for (const fn of [h.escapeHtml, h.esc]) {
      const out = fn('"><img src=x onerror=alert(1)>\'')
      expect(out).not.toMatch(/["'<>]/)
    }
  })

  it('jsArg keeps a hostile value one JS string inside an inline handler', () => {
    const hostile = `x');alert(document.domain);('`
    const attr = h.jsArg(hostile)
    expect(attr).not.toMatch(/["<>]/)
    // the HTML parser decodes the attribute, then the JS engine reads a string literal
    const decoded = attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    expect(new Function(`return ${decoded}`)()).toBe(hostile)
  })

  it('escSnippet cuts the raw text first, so no entity is split and the ellipsis follows the raw length', () => {
    expect(h.escSnippet('"""', 2)).toBe('&quot;&quot;…')
    expect(h.escSnippet('ab', 2)).toBe('ab')
    expect(h.escSnippet(null, 5)).toBe('')
  })

  it('safeHref lets through http(s) and mailto only, relative only on request', () => {
    expect(h.safeHref('https://example.com/a')).toBe('https://example.com/a')
    expect(h.safeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    for (const bad of ['javascript:alert(1)', ' JaVa\tScRiPt:alert(1)', 'data:text/html,x', '//evil.example/x', '/\\evil.example', '']) {
      expect(h.safeHref(bad, { relative: true }), bad).toBe('')
    }
    expect(h.safeHref('docs/a.md')).toBe('')
    expect(h.safeHref('docs/a.md', { relative: true })).toBe('docs/a.md')
  })

  it('safeCssColor keeps colours, var(--token) and refuses declarations and url()', () => {
    expect(h.safeCssColor('red')).toBe('#ff0000')
    expect(h.safeCssColor('#3b82f6')).toBe('#3b82f6')
    expect(h.safeCssColor('var(--accent)')).toBe('var(--accent)')
    expect(h.safeCssColor('red; background:url(//evil)', '#64748b')).toBe('#64748b')
    expect(h.safeCssColor('url(//evil)')).toBe('')
  })

  it('tHtml escapes the brand token and every param, not the template', () => {
    expect(h.tHtml('<b>{brand}</b> {x}', { x: '<i>' })).toBe('<b>A&lt;b&gt;</b> &lt;i&gt;')
  })

  it('the dashboard colour mirror is the same policy as the server: shared vectors and colour table', () => {
    const { vectors } = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'css-color-vectors.json'), 'utf8')) as { vectors: [unknown, string | null][] }
    expect(vectors.length).toBeGreaterThan(50)
    for (const [input, expected] of vectors) {
      expect(h.normalizeCssColor(input), JSON.stringify(input)).toBe(expected)
      expect(normalizeCssColor(input as string), JSON.stringify(input)).toBe(expected)
    }
    expect(h.CSS_NAMED_COLORS).toEqual({ ...CSS_NAMED_COLORS })
  })
})

describe('sinks fixed in this fork stay fixed', () => {
  it('inline-handler ids go through jsArg', () => {
    expect(src).toContain('onclick="loadChatThread(${jsArg(agentName)})"')
    expect(src).toContain('onclick="openIdeaDetail(${jsArg(idea.id)})"')
    expect(src).toContain('onclick="viewBgTask(${jsArg(task.id)})"')
    expect(src).not.toMatch(/onclick="[a-zA-Z]+\('\$\{idea\.id\}'/)
  })

  it('selectors built from data go through CSS.escape', () => {
    expect(src).toContain('data-status="${CSS.escape(String(status))}"')
    expect(src).toContain('data-req-id="${CSS.escape(String(id))}"')
  })

  it('option lists, connector fields and link anchors from data are escaped', () => {
    expect(src).toContain('<option value="${escapeHtml(a.name)}">${escapeHtml(a.label)}</option>')
    expect(src).toContain('id="assign-${escapeHtml(agent.name)}"')
    expect(src).toContain("safeHref(raw, { relative: true })")
    expect(src).toContain('urlEl.href = safeHref(data.authUrl)')
  })

  it('the quoted-HTML translations use tHtml, not t', () => {
    expect(src).toContain("el.innerHTML = tHtml(el.dataset.i18nHtml)")
    expect(src).toContain("steps.innerHTML = tHtml('channel.setup.tg_steps')")
  })
})
