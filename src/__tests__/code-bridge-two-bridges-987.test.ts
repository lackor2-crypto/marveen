// #987: two project bridges are two separate things. Stopping one must never need the whole-bridge switch, and a
// paused card must not keep saying "running" while the other one works on.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { PROJECT_ROOT } from '../config.js'

const read = (...p: string[]) => readFileSync(join(PROJECT_ROOT, 'web', ...p), 'utf8')
const app = read('app.js')

/** The source of a top-level (or modal-scoped) function, cut at the next line that closes it at its own indent. */
function fnSource(name: string): string {
  const m = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(app)
  expect(m, name).toBeTruthy()
  const rest = app.slice(m!.index)
  return rest.slice(0, rest.indexOf(`\n${m![1]}}\n`) + m![1].length + 3)
}

function renderRows(health: unknown, rows: unknown, here = ''): string {
  const box = { innerHTML: '' }
  const ctx = vm.createContext({
    document: { getElementById: () => box },
    window: { _cbModalProject: here },
    t: (k: string) => k,
    escapeHtml: (s: unknown) => String(s),
    escapeAttr: (s: unknown) => String(s),
  })
  vm.runInContext(`${fnSource('cbRenderServiceProjects')}\ncbRenderServiceProjects(${JSON.stringify(health)}, ${JSON.stringify(rows)})`, ctx)
  return box.innerHTML
}

const two = [
  { project: 'marvin', workspacePath: '/ws/marvin', paused: true },
  { project: 'tozsde', workspacePath: 'f:\\tozsde', paused: false },
]
const rowOf = (html: string, p: string) => html.split('<div class="cb-service-row').find((r) => r.includes(`data-cb-service-row="${p}"`)) ?? ''

describe('two code bridges are stopped one by one (#987)', () => {
  it('the bridge window offers each project its own switch, in its own state', () => {
    const html = renderRows({ enabled: true, savedEnabled: true }, two, 'tozsde')
    const a = rowOf(html, 'marvin')
    const b = rowOf(html, 'tozsde')
    expect(a).toContain('data-cb-row-pause="marvin" data-cb-paused="1"')
    expect(a).toContain('cb.card.paused_label')
    expect(a).toContain('process-dot stopped')
    expect(b).toContain('data-cb-row-pause="tozsde" data-cb-paused="0"')
    expect(b).toContain('agents.status.running')
    expect(b).toContain('process-dot running')
    expect(b).toContain('is-here')
    expect(a).not.toContain('is-here')
  })

  it('with the whole bridge off the switches stay, and say so', () => {
    const html = renderRows({ enabled: false, savedEnabled: false }, two)
    expect(rowOf(html, 'marvin')).toContain('cb.service.row_off_paused')
    expect(rowOf(html, 'tozsde')).toContain('cb.service.row_off<')
  })

  it('a list that could not be read is not shown as "no projects"', () => {
    expect(renderRows({ enabled: true }, null)).toContain('cb.service.projects_unknown')
    expect(renderRows({ enabled: true }, [])).toBe('')
  })

  it('a paused card reads as paused while the other card keeps running', () => {
    const ctx = vm.createContext({ t: (k: string) => k, cbRunOn: () => true, cbRunDotClass: () => 'running', cbRunLabel: () => 'RUN', cbRunTip: () => '' })
    vm.runInContext(fnSource('cbProjectRunState'), ctx)
    const state = (paused: boolean) => vm.runInContext(`JSON.stringify(cbProjectRunState(${paused}))`, ctx) as string
    expect(JSON.parse(state(true))).toMatchObject({ dot: 'stopped', label: 'cb.card.paused_label' })
    expect(JSON.parse(state(false))).toMatchObject({ dot: 'running', label: 'RUN' })
  })

  it('the stop button says it stops everything and names the projects, in both languages', () => {
    for (const lang of ['hu.js', 'en.js']) {
      const src = read('lang', lang)
      const line = src.split('\n').find((l) => l.trim().startsWith("'cb.service.stop_confirm':")) ?? ''
      expect(line, lang).toContain('{projects}')
      for (const key of ['cb.card.paused_label', 'cb.service.projects_title', 'cb.service.row_off', 'cb.projects.delete_confirm']) {
        expect(src, `${lang} ${key}`).toContain(`'${key}'`)
      }
    }
    expect(app).toMatch(/projects: names\.join\(', '\)/)
  })
})
