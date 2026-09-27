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
