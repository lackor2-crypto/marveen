// #604 (Boss TG 3357): a chapter title takes an alignment of its own (it used to be text only), saved with the page.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { documentOutline, listSections } from '../workbench-docmodel.js'
import { toRenderOutline, outlineHash, buildFodt } from '../workbench-docrender.js'
import { sanitizeRich, richRuns } from '../workbench-docrich.js'
import vm from 'node:vm'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('dokumentum-lap: a fejezetcim igazitasa (#604)', () => {
  let depot = ''
  let itemId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-tt-'))
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: p.project.id, title: 'Beadvany', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('the page save keeps a title alignment and the outline returns it', async () => {
    const s = await callWorkbench(`/api/workbench/items/${itemId}/outline/sections`, 'POST', { title: 'Tényállás' })
    const sec = s.body.outline.sections[0].id as string
    const r = await callWorkbench(`/api/workbench/items/${itemId}/outline/page`, 'POST', { sections: [{ id: sec, title: 'Tényállás', align: 'c', blocks: [] }], known: [sec] })
    expect(r.status).toBe(200)
    expect(listSections(itemId)[0].align).toBe('c')
    expect(documentOutline(itemId).sections[0].align).toBe('c')
    // an empty value takes it off again
    await callWorkbench(`/api/workbench/items/${itemId}/outline/page`, 'POST', { sections: [{ id: sec, title: 'Tényállás', align: '', blocks: [] }], known: [sec] })
    expect(documentOutline(itemId).sections[0].align).toBeNull()
  })

  it('a formatted title (bold, colour) is saved, returned, dropped when the text changes, and drawn in the export', async () => {
    const s = await callWorkbench(`/api/workbench/items/${itemId}/outline/sections`, 'POST', { title: 'Tényállás' })
    const sec = s.body.outline.sections[0].id as string
    const rich = '<b>Tény</b>állás'
    await callWorkbench(`/api/workbench/items/${itemId}/outline/page`, 'POST', { sections: [{ id: sec, title: 'Tényállás', rich, blocks: [] }], known: [sec] })
    expect(documentOutline(itemId).sections[0].rich).toBe(rich)
    // a rich that does not match the title is thrown away
    await callWorkbench(`/api/workbench/items/${itemId}/outline/page`, 'POST', { sections: [{ id: sec, title: 'Más', rich, blocks: [] }], known: [sec] })
    expect(documentOutline(itemId).sections[0].rich).toBeNull()
    await callWorkbench(`/api/workbench/items/${itemId}/outline/page`, 'POST', { sections: [{ id: sec, title: 'Más', rich: '<b>Más</b>', blocks: [] }], known: [sec] })
    const o = toRenderOutline(documentOutline(itemId) as never)
    expect(o.sections[0].rich).toBe('<b>Más</b>')
    expect(outlineHash(o, 'x')).not.toBe(outlineHash({ sections: [{ ...o.sections[0], rich: null }] } as never, 'x'))
  })

  it('the render outline and its hash follow the title alignment', () => {
    const base = { sections: [{ title: 'A', status: 'draft' as const, blocks: [] }] }
    const centred = { sections: [{ title: 'A', status: 'draft' as const, align: 'c', blocks: [] }] }
    expect(toRenderOutline(centred as never).sections[0].align).toBe('c')
    expect(outlineHash(toRenderOutline(base as never), 'x')).not.toBe(outlineHash(toRenderOutline(centred as never), 'x'))
  })

  it('a title the owner made NOT bold (it is bold by its own look) keeps that: saved, returned, drawn as normal weight in the export', async () => {
    const s = await callWorkbench(`/api/workbench/items/${itemId}/outline/sections`, 'POST', { title: 'Tényállás' })
    const sec = s.body.outline.sections[0].id as string
    const rich = '<span style="font-weight:normal">Tényállás</span>'
    await callWorkbench(`/api/workbench/items/${itemId}/outline/page`, 'POST', { sections: [{ id: sec, title: 'Tényállás', rich, blocks: [] }], known: [sec] })
    expect(documentOutline(itemId).sections[0].rich).toBe(rich)
    const xml = buildFodt(toRenderOutline(documentOutline(itemId) as never), { title: 'T', draft: false, lang: 'hu' } as never)
    const h = /<text:h [^>]*>(.*?)<\/text:h>/.exec(xml)?.[1] ?? ''
    expect(xml).toContain('fo:font-weight="normal"')
    expect(h).toMatch(/<text:span text:style-name="[^"]+">Tényállás<\/text:span>/)
    // un-bolding changes the export (the hash), bold wins over normal when both are on a run
    expect(sanitizeRich('<span style="font-weight:normal"><b>x</b></span>')).toBe('<b>x</b>')
    expect(richRuns(rich)[0]).toMatchObject({ n: true, b: false })
  })

  it('the real dpFmtOf: a title without bold is "n", a paragraph is never given that mark', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    const fns = src.slice(src.indexOf('function dpFontOf(v)'), src.indexOf('/** A field\'s paragraph format'))
    const body = src.slice(src.indexOf('function dpFmtOf(el)'), src.indexOf('return { rich: rich, plain: plain }\n  }', src.indexOf('function dpFmtOf(el)')) + 'return { rich: rich, plain: plain }\n  }'.length)
    type N = { nodeType: number; nodeName: string; nodeValue?: string; style?: Record<string, string>; firstChild: N | null; nextSibling: N | null; getAttribute?: (n: string) => string | null }
    const el = (name: string, style: Record<string, string>, kids: N[]): N => link({ nodeType: 1, nodeName: name.toUpperCase(), style, firstChild: null, nextSibling: null, getAttribute: () => null }, kids)
    const tx = (v: string): N => ({ nodeType: 3, nodeName: '#text', nodeValue: v, firstChild: null, nextSibling: null })
    function link(n: N, kids: N[]): N { kids.forEach((k, i) => { k.nextSibling = kids[i + 1] ?? null }); n.firstChild = kids[0] ?? null; return n }
    const run = (kind: string, kids: N[]): string => {
      const root = link({ nodeType: 1, nodeName: 'DIV', style: {}, firstChild: null, nextSibling: null, getAttribute: (n: string) => (n === 'data-wb-dp' ? kind : null) }, kids)
      const ctx = { DP_FONTS: ['Times New Roman', 'Arial', 'Courier New', 'Georgia', 'Verdana', 'Calibri'], root, out: undefined as unknown }
      vm.createContext(ctx)
      vm.runInContext(`${fns}\n${body}\nout = dpFmtOf(root)`, ctx)
      return (ctx.out as { rich: string }).rich
    }
    const kids = () => [el('span', { fontWeight: 'normal', color: 'rgb(255, 0, 0)' }, [el('i', {}, [tx('Cím')])])]
    expect(run('sec', kids())).toBe('<span style="font-weight:normal;color:#ff0000"><i>Cím</i></span>')
    expect(run('block', kids())).toBe('<span style="color:#ff0000"><i>Cím</i></span>')
    // normal weight alone on a title is a format of its own (it used to vanish on save: "bold" did nothing)
    expect(run('sec', [el('span', { fontWeight: 'normal' }, [tx('Cím')])])).toBe('<span style="font-weight:normal">Cím</span>')
    expect(run('sec', [el('b', {}, [tx('Cím')])])).toBe('<b>Cím</b>')
  })

  it('the selection of a title is remembered, so a font / size / colour picked from a list reaches it', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toMatch(/\/\^sec\$\/\.test\(f\.getAttribute\('data-wb-dp'\) \|\| ''\)\) WB\.dpRange = \{ id: f\.id, range: r\.cloneRange\(\) \}/)
  })

  it('the page draws the title with its alignment and the toolbar aligns a title', () => {
    const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')
    expect(js).toContain("dpEditHtml('wb-dp-title' + dpAlignAttrs(sec.align).cls")
    expect(js).toContain("align: el ? (el.getAttribute('data-wb-align') || '') : ''")
    expect(js).toContain('dpTitleTarget()')
    expect(js).toContain("rich: tf && tf.rich && tf.plain === title ? tf.rich : ''")
  })
})
