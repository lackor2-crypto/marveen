// #599 (Boss TG 3283): with the cursor in a chapter title the format buttons used to fall back to the LAST paragraph
// the cursor had been in, so "centre" moved the line BELOW the title. #604 (Boss TG 3357): the title is now the target
// itself (alignment, bold, font ...); anything else that is not a paragraph still never falls back to the last one.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

const js = readFileSync(join(process.cwd(), 'web/workbench.js'), 'utf8')
const lang = (l: string): string => readFileSync(join(process.cwd(), `web/lang/${l}.js`), 'utf8')

describe('#599 format target on a chapter title', () => {
  it('dpFmtTarget does not fall back to the last paragraph while the cursor is in another page element', () => {
    const body = js.slice(js.indexOf('function dpFmtTarget()'), js.indexOf('function dpAlignIcon'))
    expect(body).toMatch(/if \(dpTitleTarget\(\)\) return a\s+[\s\S]*if \(a\) return null\s+var last/)
  })

  it('a title says why it has no list / indent / line spacing instead of the generic message', () => {
    expect((js.match(/window\.showToast\(t\('workbench\.dp\.fmt_title'\)\)/g) || []).length).toBe(2)
  })

  it('the message exists in both languages', () => {
    expect(lang('hu')).toContain('"workbench.dp.fmt_title"')
    expect(lang('en')).toContain('"workbench.dp.fmt_title"')
  })
})

// Behaviour, not just source text: run the real dpTitleTarget / dpFmtTarget with a tiny fake page.
type FakeEl = { kind: string; cls?: string[]; id?: string; isConnected: boolean }
function targetFor(cursor: FakeEl | null, last: FakeEl | null): FakeEl | null {
  const mk = (e: FakeEl) => ({
    id: e.id, isConnected: e.isConnected,
    getAttribute: (n: string) => (n === 'data-wb-dp' ? e.kind : null),
    classList: { contains: (c: string) => (e.cls || []).includes(c) },
  })
  const els = new Map<string, ReturnType<typeof mk>>()
  const cur = cursor ? mk(cursor) : null
  const lastEl = last ? mk(last) : null
  if (lastEl && last?.id) els.set(last.id, lastEl)
  const src = js.slice(js.indexOf('function dpTitleTarget()'), js.indexOf('/** Four text lines'))
  const ctx = {
    dpCurrent: () => cur,
    WB: { dpFmtLast: last?.id },
    document: { getElementById: (id: string) => els.get(id) || null },
    out: undefined as unknown,
  }
  vm.createContext(ctx)
  vm.runInContext(`${src}\nout = dpFmtTarget()`, ctx)
  const got = ctx.out as { id?: string; getAttribute: (n: string) => string } | null
  if (!got) return null
  return got === cur ? cursor : last
}

describe('#599 dpFmtTarget behaviour (real function, fake page)', () => {
  const para: FakeEl = { kind: 'block', id: 'p1', isConnected: true }
  const title: FakeEl = { kind: 'sec', id: 't1', isConnected: true }

  it('cursor in a chapter title: the title is the target, never the last paragraph below it', () => {
    expect(targetFor(title, para)).toBe(title)
  })

  it('cursor in a paragraph: that paragraph', () => {
    expect(targetFor(para, { kind: 'block', id: 'p0', isConnected: true })).toBe(para)
  })

  it('cursor in some other page element: no target (does not fall back to the last paragraph)', () => {
    expect(targetFor({ kind: 'img', id: 'i1', isConnected: true }, para)).toBeNull()
  })

  it('cursor in a table block: no target, even with a remembered paragraph', () => {
    expect(targetFor({ kind: 'block', cls: ['wb-outline-kind-table'], id: 'tb', isConnected: true }, para)).toBeNull()
  })

  it('no cursor in the page: falls back to the last paragraph the cursor was in', () => {
    expect(targetFor(null, para)).toBe(para)
  })
})
