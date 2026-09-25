// #394 -- Ugynokok racs: a leallitott agens a csoportja vegere kerul, es
// halvanyitva latszik (Boss TG 6411: "amelyik le van allitva, az egy kicsit
// szurkuljon be, es menjen az utolso helyre ... az ingyeneseknel ugyanigy").
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const app = readFileSync('web/app.js', 'utf8')
const css = readFileSync('web/style.css', 'utf8')

function fnBody(head: string): string {
  const i = app.indexOf(head)
  if (i < 0) throw new Error('missing: ' + head)
  return app.slice(i, app.indexOf('\n}', i) + 2)
}

const order = new Function(
  fnBody('function isFreeModel(') + '\n' + fnBody('function orderAgentsForGrid(') + '\nreturn orderAgentsForGrid',
)() as (a: any[]) => { paid: any[]; free: any[] }

const names = (l: any[]) => l.map((a) => a.name)

describe('#394 orderAgentsForGrid', () => {
  it('fizetos es ingyenes csoporton belul a futok elol, a leallitottak a vegen, stabil sorrendben', () => {
    const agents = [
      { name: 'p1', model: 'claude-opus', running: false },
      { name: 'f1', model: 'x/y:free', running: false },
      { name: 'p2', model: 'claude-sonnet', running: true },
      { name: 'f2', model: 'a/b:free', running: true },
      { name: 'p3', model: 'claude-haiku', running: false },
      { name: 'f3', model: 'c/d:FREE', running: true },
      { name: 'p4', model: 'claude-opus', running: true },
    ]
    const r = order(agents)
    expect(names(r.paid)).toEqual(['p2', 'p4', 'p1', 'p3'])
    expect(names(r.free)).toEqual(['f2', 'f3', 'f1'])
  })

  it('hianyzo running mezo = leallitott; ures / hibas bemenet nem dob', () => {
    expect(names(order([{ name: 'a', model: 'm' }, { name: 'b', model: 'm', running: true }]).paid)).toEqual(['b', 'a'])
    expect(order([])).toEqual({ paid: [], free: [] })
    expect(order(null as any)).toEqual({ paid: [], free: [] })
  })

  it('a racs a rendezett listat hasznalja, az elvalaszto a rendezett free elso elemenel', () => {
    const r = fnBody('function renderAgents(')
    expect(r).toContain('const { paid: paidAgents, free: freeAgents } = orderAgentsForGrid(agents)')
    expect(r).toContain('agent === freeAgents[0]')
    expect(r).toContain("card.classList.toggle('is-stopped', !isRunning)")
  })

  it('a leallitott kartya halvany, hoverre/fokuszra olvashato', () => {
    expect(css).toMatch(/\.agent-card\.is-stopped,[^{]*\{[^}]*opacity: \.55/)
    expect(css).toMatch(/\.agent-card\.is-stopped:hover,\s*\n\.agent-card\.is-stopped:focus-within,[^{]*\{ opacity: 1/)
  })
})

// Boss TG 6426: "Az org charton is szurkisd el oket." -- the org chart only
// dims, it never reorders (the tree is the hierarchy).
describe('#394 org chart: a stopped node is dimmed in place', () => {
  const graph = fnBody('function renderTeamGraph(')

  it('renderNode toggles is-stopped only on an explicit running:false', () => {
    expect(graph).toContain("div.classList.toggle('is-stopped', node.running === false)")
  })

  it('the org chart is not re-sorted by running state', () => {
    expect(graph).not.toMatch(/orderAgentsForGrid|sort\([^)]*running/)
  })

  it('one shared CSS rule dims the grid card and the chart node, hover/focus restores', () => {
    expect(css).toMatch(/\.agent-card\.is-stopped,\s*\n\.team-node\.is-stopped \{ opacity: \.55; filter: grayscale\(\.6\); \}/)
    expect(css).toContain('.team-node.is-stopped:hover')
    expect(css).toContain('.team-node.is-stopped:focus-within { opacity: 1; filter: none; }')
  })
})
