// The agent picker on the Approvals page, after Boss 2026-08-24 asked for two
// things on it: a mode ("vizsgalat, vagy javitas") and the VS Code executors
// ("es ott abban a listaban remelem lathato a vscode ugynok is!").
//
// The property worth guarding is not that the markup exists, but that the
// EMPTY cases still speak. A code bridge with nothing on it can be empty for
// four different reasons -- switched off, nothing wired up yet, worker not
// reporting, or the query failed -- and showing one row less in silence is
// exactly the failure the fresh-install rule forbids.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'

const APP = readFileSync(join(PROJECT_ROOT, 'web', 'app.js'), 'utf-8')
const HU = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
const EN = readFileSync(join(PROJECT_ROOT, 'web', 'lang', 'en.js'), 'utf-8')
const CSS = readFileSync(join(PROJECT_ROOT, 'web', 'style.css'), 'utf-8')

describe('the picker offers a mode, and says what each one does', () => {
  it('has two radio options, review preselected', () => {
    expect(APP).toContain('name="verifyMode" value="verify" checked')
    expect(APP).toContain('name="verifyMode" value="fix"')
  })

  it('each option carries a plain-language sentence, not just a label', () => {
    for (const key of [
      'approvals.verify.mode_verify_name', 'approvals.verify.mode_verify_hint',
      'approvals.verify.mode_fix_name', 'approvals.verify.mode_fix_hint',
    ]) {
      expect(APP).toContain(key)
      expect(HU).toContain(key)
      expect(EN).toContain(key)
    }
  })

  it('the button promises what it will actually do', () => {
    expect(APP).toContain("t(_verifyPickedMode() === 'fix' ? 'approvals.verify.picker_go_fix' : 'approvals.verify.picker_go')")
    expect(HU).toContain('approvals.verify.picker_go_fix')
    expect(EN).toContain('approvals.verify.picker_go_fix')
  })

  it('the chosen mode is actually sent to the server', () => {
    expect(APP).toContain('JSON.stringify({ agents: chosen, mode: _verifyPickedMode() })')
  })

  it('a finished row shows which mode it ran in', () => {
    expect(APP).toContain("v.mode === 'fix'")
  })
})

describe('the VS Code executors are on the list, and their absence is explained', () => {
  it('they are listed in their own group, addressed as code:<alias>', () => {
    expect(APP).toContain('approvals.verify.code_group_title')
    expect(APP).toContain("escapeAttr('code:' + pr.alias)")
  })

  it('every empty case produces a sentence -- none of them is silence', () => {
    // Switched off / nothing wired up yet / worker offline / cannot query.
    for (const key of [
      'approvals.verify.code_disabled',
      'approvals.verify.code_none_yet',
      'approvals.verify.code_worker_offline',
      'approvals.verify.code_unreachable',
    ]) {
      expect(APP).toContain(key)
      expect(HU).toContain(key)
      expect(EN).toContain(key)
    }
  })

  it('asks the SOURCE whether the bridge is on, instead of inferring it from an empty list', () => {
    expect(APP).toContain("fetch('/api/code/health')")
    expect(APP).toContain('health.enabled === false')
    expect(APP).toContain('health.workerOnline')
  })

  it('a fresh install reads as informational, and a missing executor as a warning', () => {
    // The two states must not share a tone: "you have not set this up yet" is
    // not an error, and "the thing that should be running is not" is.
    expect(APP).toMatch(/code_none_yet'\), tone: 'info'/)
    expect(APP).toMatch(/code_disabled'\), tone: 'info'/)
    expect(APP).toMatch(/code_worker_offline'\), tone: 'warn'/)
    expect(APP).toMatch(/code_unreachable'\), tone: 'warn'/)
  })

  it('an offline worker does not hide the projects -- the task queues up', () => {
    expect(APP).toContain('const note = health.workerOnline')
  })

  it('a code: row is labelled as its project, not as a broken agent id', () => {
    expect(APP).toContain('function _verifyAgentLabel(agent)')
    expect(APP).toContain('approvals.verify.code_agent_label')
  })

  it('the popover still opens when only a VS Code executor is available', () => {
    expect(APP).toContain('if (!selectable.length && !codeState.projects.length) {')
  })
})

describe('the mode chooser fits a phone', () => {
  it('stacks vertically instead of sitting side by side in a 240px popover', () => {
    expect(CSS).toContain('.verify-mode-choice {')
    expect(CSS).toMatch(/\.verify-mode-choice \{[^}]*flex-direction: column/)
  })

  it('does not widen the popover', () => {
    expect(CSS).toMatch(/\.verify-picker-popover \{[^}]*width: 240px/)
  })
})
