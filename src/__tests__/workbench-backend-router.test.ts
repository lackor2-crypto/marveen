import { describe, it, expect } from 'vitest'
import { decideWorkbenchBackend } from '../workbench-agent/backend-router.js'

describe('decideWorkbenchBackend -- Munkapad chat ket hattere (#433, B opcio)', () => {
  it('bekapcsolt teljes mod + online worker -> a valodi Claude Code session', () => {
    const d = decideWorkbenchBackend({ fullAgentEnabled: true, workerOnline: true })
    expect(d.backend).toBe('code-bridge')
    expect(d.reason).toBe('ok')
    expect(d.needsWorkerSetup).toBe(false)
  })

  it('kikapcsolt teljes mod -> a megszokott projekt-asszisztens (semmi nem torik el)', () => {
    // Ez az ALAPERTELMEZES: a valtoztatas onmagaban nem valtoztat viselkedest.
    const d = decideWorkbenchBackend({ fullAgentEnabled: false, workerOnline: true })
    expect(d.backend).toBe('workbench-agent')
    expect(d.reason).toBe('disabled')
    expect(d.needsWorkerSetup).toBe(false)
  })

  it('bekapcsolt, DE nincs online worker -> nem nemul el: fallback + setup-jelzes', () => {
    // Friss telepites: a chat NEM halhat meg, csak setupra hiv.
    const d = decideWorkbenchBackend({ fullAgentEnabled: true, workerOnline: false })
    expect(d.backend).toBe('workbench-agent')
    expect(d.reason).toBe('no_worker')
    expect(d.needsWorkerSetup).toBe(true)
  })

  it('kikapcsolt es nincs worker -> a kapcsolo nyer, nincs folosleges setup-jelzes', () => {
    const d = decideWorkbenchBackend({ fullAgentEnabled: false, workerOnline: false })
    expect(d.backend).toBe('workbench-agent')
    expect(d.reason).toBe('disabled')
    expect(d.needsWorkerSetup).toBe(false)
  })
})

import { isWindowsDriveBridgePath } from '../workbench-agent/backend-router.js'
import { readFileSync as readSrc } from 'node:fs'
import { join as joinPath } from 'node:path'
describe('Windows-drive bridge switch (Boss, 2026-10-02)', () => {
  it('tells a Windows drive folder from a WSL one', () => {
    expect(isWindowsDriveBridgePath('f:\\Marveen\\Család\\Projektek\\Tőzsde')).toBe(true)
    expect(isWindowsDriveBridgePath('C:/Users/x/proj')).toBe(true)
    expect(isWindowsDriveBridgePath('\\\\wsl.localhost\\Ubuntu\\home\\boss\\marveen')).toBe(false)
    expect(isWindowsDriveBridgePath('/home/boss/marveen')).toBe(false)
    expect(isWindowsDriveBridgePath(null)).toBe(false)
  })
  it('the route skips the bridge-first path for such a project only when the setting says marvin', () => {
    const src = readSrc(joinPath(__dirname, '..', 'web', 'routes', 'workbench-agent.ts'), 'utf-8')
    expect(src).toContain('isWindowsDriveBridgePath(code.session.workspacePath)')
    expect(src).toContain("getEffectiveSettingValue('WORKBENCH_WINDOWS_BRIDGE') || 'windows') === 'marvin'")
    expect(src).toMatch(/bridgeFirst = [^\n]*!\(windowsDriveBridge && !!liveSpec\)/)
  })
})
