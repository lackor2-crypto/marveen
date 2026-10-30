// Boss 2026-10-30: a finalised document must be confirmed as sent BY HAND. The project asks when it is opened, and the
// window that follows a mail draft stays open until the owner answers.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')
const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf8')
const routes = readFileSync(join(root, 'src', 'web', 'routes', 'workbench.ts'), 'utf8')

describe('Elküldve-kérdés ablak', () => {
  it('a projekt megnyitásakor lekérdezi a véglegesített, de el nem küldött iratokat', () => {
    expect(js).toContain("'/api/workbench/unsent-finals?project='")
    expect(js).toMatch(/load\(projectId\)\n\s+sentAskProject\(projectId\)/)
    expect(routes).toContain("path === '/api/workbench/unsent-finals'")
  })

  it('a levélpiszkozat elkészülte után felugrik, és csak válasszal záródik (nincs Escape / háttérkattintás)', () => {
    expect(js).toMatch(/workbench\.mail\.drafts_done[^\n]*\n\s+sentAsk\(/)
    const fn = js.slice(js.indexOf('function sentAsk('), js.indexOf('function sentAskProject('))
    expect(fn).not.toContain('Escape')
    expect(fn).not.toContain("overlay.addEventListener('click'")
    expect(fn).toContain('/sent-mark')
  })

  it('mindkét nyelven megvan a szöveg', () => {
    for (const k of ['title', 'intro_project', 'intro_mail', 'yes', 'no', 'no_done']) {
      expect(hu).toContain(`"workbench.sentask.${k}"`)
      expect(en).toContain(`"workbench.sentask.${k}"`)
    }
  })
})
