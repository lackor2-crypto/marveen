// #991: only the newest build of the Settings page may draw. The REAL loadSettings / loadSettingsInner from web/app.js
// run here with a page that records every write; the full browser scenario is tests/browser/settings-reload-race-991.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'app.js'), 'utf8')

function slice(from: string, fnName: string): string {
  const start = SRC.indexOf(from)
  const body = SRC.indexOf(`function ${fnName}(`, start)
  expect(start).toBeGreaterThan(-1)
  expect(body).toBeGreaterThan(-1)
  return SRC.slice(start, SRC.indexOf('\n}\n', body) + 3)
}

type Answer = { ok: boolean; json: () => Promise<unknown> }

function load() {
  const writes: string[] = []
  const answers: Array<(a: Answer) => void> = []
  const node = (name: string) => ({
    parentElement: { insertBefore: () => writes.push(`${name}:park`) },
    set innerHTML(v: string) { writes.push(`${name}:${v.length ? 'html' : 'clear'}`) },
  })
  const nodes: Record<string, unknown> = { settingsTabNav: node('nav'), settingsTabPanels: node('panels') }
  const code = slice('// The in-flight build of the Settings page.', 'loadSettings') + slice('async function loadSettingsInner(', 'loadSettingsInner')
    + '\nreturn loadSettings'
  const loadSettings = new Function('document', 'fetch', 't', 'settingsDirty', 'updateSettingsSaveBar', 'renderAuthCard', code)(
    { getElementById: (id: string) => nodes[id] ?? null },
    () => new Promise<Answer>((r) => answers.push(r)),
    (k: string) => k,
    new Set(),
    () => {},
    () => {},
  ) as () => Promise<unknown>
  return { loadSettings, writes, answers }
}

const empty: Answer = { ok: true, json: async () => ({ settings: [] }) }

describe('#991: an older Settings build that answers late does not draw', () => {
  for (const [name, late] of [['answers', empty], ['fails', { ok: false, json: async () => ({}) }]] as const) {
    it(`when it ${name} after the newer one`, async () => {
      const { loadSettings, writes, answers } = load()
      const first = loadSettings()
      const second = loadSettings()
      answers[1]!(empty)
      await second
      const drawn = writes.length
      answers[0]!(late)
      await first
      expect(writes.slice(drawn)).toEqual([])
    })
  }
  it('a single build still draws', async () => {
    const { loadSettings, writes, answers } = load()
    const only = loadSettings()
    const before = writes.length
    answers[0]!(empty)
    await only
    expect(writes.length).toBeGreaterThan(before)
  })
})
