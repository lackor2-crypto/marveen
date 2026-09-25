// #388 -- AZ INTEZO BAL OLDALI FAJA TAGOLT.
//
// Boss: "a bal menü átláthatatlan [...] Korpás Lászlóra ha ráklikkelek, akkor
// ami az összes [...] alatt van, annak a hátterét az egésznek megváltoztatni".
// Minden felso szintu ag sajat szinu csikot + halvany hatteret kap az egesz
// alfajan, az aktiv ag erosebbet; a sorokon behuzas-vonalak.
//
// A forrast nezzuk: az app.js bongeszo-fajl, modulkent nem toltheto be.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(process.cwd(), 'web', 'app.js'), 'utf8')
const css = readFileSync(join(process.cwd(), 'web', 'style.css'), 'utf8')
function fnSrc(head: string): string {
  const i = app.indexOf(head)
  if (i < 0) throw new Error('nincs ilyen fuggveny: ' + head)
  return app.slice(i, app.indexOf('\n}\n', i) + 3)
}

describe('#388 -- tagolt Intezo-fa', () => {
  const render = fnSrc('function _intezoTreeRender() {')

  it('a felso szintu agak sajat szint kapnak, az aktiv ag jelolve van', () => {
    expect(render).toContain('const branch = depth === 1')
    expect(render).toContain("' class=\"intezo-tree-branch' + (onPath(rel) ? ' is-active-branch' : '')")
    expect(render).toContain("--tree-c:' + _intezoTreeBranchColor(idx)")
    // az aktiv ag = a mostani mappa maga vagy barmelyik ose (nem csak prefix-egyezes)
    expect(render).toContain("_intezoPath === rel || String(_intezoPath).startsWith(rel + '/')")
  })

  it('a szomszedos agak szine elter, es mindig ervenyes hsl', () => {
    // eslint-disable-next-line no-new-func
    const color = new Function(fnSrc('function _intezoTreeBranchColor(') + '; return _intezoTreeBranchColor')() as (i: number) => string
    const hues = Array.from({ length: 12 }, (_, i) => Number(/hsl\((\d+) /.exec(color(i))![1]))
    for (let i = 1; i < hues.length; i++) {
      const d = Math.abs(hues[i] - hues[i - 1])
      expect(Math.min(d, 360 - d)).toBeGreaterThan(40)
    }
    expect(color(undefined as unknown as number)).toMatch(/^hsl\(\d+ 65% 50%\)$/)
  })

  it('a sorok kapjak a melyseget (behuzas-vonalakhoz), az agak indexet', () => {
    expect(render).toContain("px;--d:' + depth + '\">'")
    // #387: only real descendants are drawn (no loop), the index still per branch.
    expect(render).toContain('.map((k, i) => node(k.rel, k.displayName || k.name, k, depth + 1, i))')
  })

  it('a CSS attetszo keveressel dolgozik (vilagos es sotet temaban is halvany)', () => {
    expect(css).toMatch(/\.intezo-tree-branch \{[\s\S]*?background: color-mix\(in srgb, var\(--tree-c\) 5%, transparent\)/)
    expect(css).toMatch(/\.intezo-tree-branch\.is-active-branch \{[\s\S]*?color-mix\(in srgb, var\(--tree-c\) 13%, transparent\)/)
    expect(css).toMatch(/\.intezo-tree-row::before \{[\s\S]*?var\(--border\)/)
  })

  it('a hosszu nev nem vesz el: title-ben is ott van', () => {
    expect(render).toMatch(/' title="' \+ escapeHtml\(hint \? name \+ ' \(' \+ hint \+ '\)' : name\)/)
  })
})
