// Every "takes effect after a restart" setting must say WHAT to restart, and
// the badge must be a state rather than a permanent label.
//
// Boss, 2026-08-16, two reports on the same screen:
//   "tegyel egy gombot oda a beallitasokba illetve minden ilyen helyre ahol
//    ezt irjatok ki hogy ujrainditas utan lep eletbe. legyen mar ott egy gomb"
//   "nem akarok latni ilyet hogy sargan oda van barhova is irva hogy
//    ujrainditas utan lep eletbe. sokszor ujra lett mar inditva a marvin es
//    megis itt vannak ezek a sarga betuk. itt valami bug van."
//
// Both were true. The badge came from `requiresRestart`, a property of the
// DEFINITION, so no restart could ever clear it; and the text never named the
// process to restart, so restarting the dashboard for a main-agent setting
// looked like a broken system rather than the wrong button.
//
// These tests pin down the contract that fixes it: a target on every restart
// key, the target and the pending flag on the wire, and a frontend that gates
// the yellow badge on the pending flag.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_REGISTRY } from '../config-registry.js'
import {
  computeRestartPending,
  restartRelevantKeys,
  snapshotValues,
} from '../settings-restart-pending.js'

const ROOT = join(__dirname, '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf8')
const SETTINGS_ROUTE = readFileSync(join(ROOT, 'src', 'web', 'routes', 'settings.ts'), 'utf8')

const VALID_TARGETS = ['dashboard', 'main-agent', 'dashboard+agents', 'dashboard+heartbeat']

/** Pull one top-level function body out of app.js by brace matching. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header)
  expect(start, `not found in web/app.js: ${header}`).toBeGreaterThan(-1)
  let depth = 0
  let i = source.indexOf('{', start)
  const open = i
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${header}`)
}

describe('restartTarget on the registry', () => {
  it('every requiresRestart setting names what to restart', () => {
    const missing = SETTINGS_REGISTRY
      .filter(d => d.requiresRestart && !d.restartTarget)
      .map(d => d.key)
    expect(missing, 'requiresRestart without restartTarget').toEqual([])
  })

  it('every restartTarget is one of the four known targets', () => {
    const bad = SETTINGS_REGISTRY
      .filter(d => d.restartTarget && !VALID_TARGETS.includes(d.restartTarget))
      .map(d => `${d.key}=${d.restartTarget}`)
    expect(bad).toEqual([])
  })

  it('does not put a target on settings that need no restart', () => {
    // Not cosmetic: a target on a live-reloading key would render a restart
    // button for a restart nobody owes.
    const stray = SETTINGS_REGISTRY
      .filter(d => !d.requiresRestart && d.restartTarget)
      .map(d => d.key)
    expect(stray).toEqual([])
  })

  it('there is at least one main-agent target', () => {
    // The whole report started with a main-agent setting (the model) that a
    // dashboard restart could never apply. If this drops to zero, the
    // distinction has silently been flattened back into "dashboard".
    const mainAgent = SETTINGS_REGISTRY.filter(d => d.restartTarget === 'main-agent')
    expect(mainAgent.length).toBeGreaterThan(0)
  })
})

describe('GET /api/settings carries the restart state', () => {
  it('sends restartTarget and restartPending', () => {
    expect(SETTINGS_ROUTE).toMatch(/restartTarget:\s*def\.restartTarget/)
    expect(SETTINGS_ROUTE).toMatch(/restartPending:\s*def\.requiresRestart\s*\?\s*isRestartPending\(def\.key\)\s*:\s*false/)
  })
})

describe('computeRestartPending', () => {
  it('reports nothing when the running values match the effective ones', () => {
    expect(computeRestartPending({ A: '1', B: 'x' }, { A: '1', B: 'x' })).toEqual([])
  })

  it('reports exactly the key that changed', () => {
    expect(computeRestartPending({ A: '1', B: 'x' }, { A: '1', B: 'y' })).toEqual(['B'])
  })

  it('treats 1 and "1" as the same value', () => {
    // .env yields strings, an override may yield a number. A type difference is
    // not a change the owner made, and reporting it would put the permanent
    // badge straight back on screen.
    expect(computeRestartPending({ A: 1 }, { A: '1' })).toEqual([])
  })

  it('ignores a key missing from the current values', () => {
    expect(computeRestartPending({ A: '1', B: 'x' }, { A: '2' })).toEqual(['A'])
  })

  it('ignores a key that only exists now', () => {
    expect(computeRestartPending({ A: '1' }, { A: '1', NEW: 'z' })).toEqual([])
  })

  it('is empty for an empty snapshot', () => {
    expect(computeRestartPending({}, { A: '1' })).toEqual([])
  })
})

describe('snapshotValues', () => {
  it('reads every key through the given reader', () => {
    expect(snapshotValues(['A', 'B'], k => k.toLowerCase())).toEqual({ A: 'a', B: 'b' })
  })

  it('skips a key that throws instead of losing the whole snapshot', () => {
    const read = (k: string) => {
      if (k === 'BOOM') throw new Error('nope')
      return k
    }
    expect(snapshotValues(['A', 'BOOM', 'B'], read)).toEqual({ A: 'A', B: 'B' })
  })

  it('covers exactly the requiresRestart keys', () => {
    const expected = SETTINGS_REGISTRY.filter(d => d.requiresRestart).map(d => d.key)
    expect(restartRelevantKeys().sort()).toEqual(expected.sort())
  })
})

describe('the settings row in web/app.js', () => {
  const body = functionBody(APP_JS, 'function buildSettingRow(def)')

  it('shows the yellow badge only when a restart is actually pending', () => {
    expect(body).toMatch(/if\s*\(def\.requiresRestart\s*&&\s*def\.restartPending\)/)
    // The old unconditional form must not come back.
    expect(body).not.toMatch(/if\s*\(def\.requiresRestart\)\s*\{/)
  })

  it('still explains the restart when nothing is pending, in a neutral row', () => {
    expect(body).toMatch(/if\s*\(def\.requiresRestart\s*&&\s*!def\.restartPending\)/)
    expect(body).toContain('settings.restart_hint_idle')
    // Neutral class, not the warning badge: an extra permanent yellow label is
    // the bug being fixed, not the fix.
    expect(body).toMatch(/hint\.className\s*=\s*'settings-row-meta'/)
  })

  it('mounts a restart control on the pending row', () => {
    expect(body).toContain('mountSettingRestartAction(slot, def)')
  })

  it('keeps the badge short and names the target where there is room', () => {
    // The badge is a nowrap chip, so it stays a two-word state. WHICH process
    // to restart is named in the neutral hint and in the note beside the
    // button -- both through restartTargetName, never hardcoded.
    expect(body).toMatch(/t\('settings\.restart_badge_pending'\)/)
    expect(body).toMatch(/settings\.restart_hint_idle'[^)]*restartTargetName\(def\.restartTarget\)/)
  })
})

describe('the restart control picks the right process', () => {
  const body = functionBody(APP_JS, 'async function mountSettingRestartAction(slot, def)')

  it('restarts the main agent, not the dashboard, for main-agent settings', () => {
    expect(body).toMatch(/target === 'main-agent'/)
    expect(body).toContain('/api/marveen/restart')
  })

  it('asks before a main-agent restart', () => {
    expect(body).toContain("confirm(t('agents.confirm.hard_restart'))")
  })

  it('uses the dashboard restart button for everything else', () => {
    expect(body).toContain('mountRestartButton(slot,')
  })

  it('says which process the button restarts, next to the button', () => {
    expect(body).toMatch(/restart\.row_note'[^)]*target:\s*targetName/)
    expect(body).toMatch(/restart\.btn_target'[^)]*target:\s*targetName/)
  })

  it('spells out the second step when the agents also have to come back', () => {
    expect(body).toMatch(/target === 'dashboard\+agents'/)
    expect(body).toContain('restart.second_step_agents')
  })

  it('never hardcodes the bot name', () => {
    const names = functionBody(APP_JS, 'function restartTargetName(target)')
    expect(names).toContain('mainAgentDisplayName()')
    expect(names).not.toMatch(/'Marv/)
  })

  it('falls back to the dashboard when the target is unknown', () => {
    // An unannotated key must still render a working button rather than an
    // empty box with no way forward.
    const names = functionBody(APP_JS, 'function restartTargetName(target)')
    expect(names).toContain("t('restart.target.dashboard')")
  })
})

describe('the new texts exist in both languages', () => {
  const keys = [
    'settings.restart_badge_pending',
    'settings.restart_hint_idle',
    'restart.target.dashboard',
    'restart.target.main_agent',
    'restart.target.dashboard_agents',
    'restart.target.dashboard_heartbeat',
    'restart.row_note',
    'restart.btn_target',
    'restart.second_step_agents',
  ]

  for (const key of keys) {
    it(`hu.js has ${key}`, () => {
      expect(HU).toContain(`'${key}'`)
    })
    it(`en.js has ${key}`, () => {
      expect(EN).toContain(`'${key}'`)
    })
  }

  it('the Hungarian texts talk about a process, not about a field', () => {
    // The owner is not a programmer: "restartTarget" or "requiresRestart" must
    // never reach the screen.
    for (const key of keys) {
      const line = HU.split('\n').find(l => l.includes(`'${key}'`)) || ''
      expect(line).not.toMatch(/requiresRestart|restartPending|restartTarget/)
    }
  })
})
