// Face recognizer install from the dashboard (kanban f97acc32, audit C).
// What must hold: missing build tools never start a build and hand back the
// line for THIS package manager; an empty vision dir reads as not installed.
import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MARVEEN_VISION_DIR = mkdtempSync(join(tmpdir(), 'marveen-vision-'))

const { buildToolsCommand, startVisionInstall, missingBuildTools, visionInstallStatus, _resetVisionInstall, autoInstallVision, VISION_AUTO_MARKER } =
  await import('../vision-install.js')
const { SYSTEM_DEPS } = await import('../system-deps.js')

beforeEach(() => _resetVisionInstall())

describe('buildToolsCommand', () => {
  it('gives the line per package manager, null when unknown', () => {
    expect(buildToolsCommand('apt')).toMatch(/^sudo apt-get install .*cmake.*python3-venv/)
    expect(buildToolsCommand('dnf')).toMatch(/^sudo dnf install .*cmake/)
    expect(buildToolsCommand('brew')).toMatch(/^brew install .*cmake/)
    expect(buildToolsCommand(null)).toBeNull()
  })
})

describe('missingBuildTools', () => {
  it('needs only python3-venv: dlib comes as a prebuilt wheel, no compiler (#514)', () => {
    expect(missingBuildTools((cmd) => cmd !== 'cmake' && cmd !== 'gcc')).toEqual([])
    expect(missingBuildTools((_cmd, args) => !args.includes('venv'))).toEqual(['python3-venv'])
    expect(missingBuildTools(() => true)).toEqual([])
  })
})

describe('autoInstallVision (#514: installs by itself, no button)', () => {
  it('missing python3-venv: logs, starts nothing, leaves no retry marker', () => {
    expect(autoInstallVision({ missing: ['python3-venv'] })).toBe('missing_tools')
    expect(visionInstallStatus().running).toBe(false)
    expect(existsSync(VISION_AUTO_MARKER)).toBe(false)
  })

  it('a recent attempt is not repeated on every restart', () => {
    const now = Date.now()
    writeFileSync(VISION_AUTO_MARKER, JSON.stringify({ at: now - 60_000 }))
    try {
      expect(autoInstallVision({ now, missing: [] })).toBe('recently_tried')
      expect(visionInstallStatus().running).toBe(false)
    } finally { rmSync(VISION_AUTO_MARKER, { force: true }) }
  })
})

describe('startVisionInstall', () => {
  it('missing build tools: no build, the paste line comes back', () => {
    const r = startVisionInstall({ missing: ['cmake'], pm: 'apt' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.needsSudo).toBe(true)
      expect(r.missing).toEqual(['cmake'])
      expect(r.command).toMatch(/apt-get/)
    }
    expect(visionInstallStatus().running).toBe(false)
  })

  it('an empty vision dir is not installed, and shows no failure log', () => {
    const s = visionInstallStatus()
    expect(s.installed).toBe(false)
    expect(s.exit_code).toBeNull()
    expect(s.log_tail).toBeNull()
  })
})

describe('face-recognizer in the external programs list', () => {
  it('is extra, self-installed, and an empty vision dir measures not_installed', async () => {
    const d = SYSTEM_DEPS.find((x) => x.id === 'face-recognizer')
    expect(d?.tier).toBe('extra')
    expect(d?.selfInstall).toBe('vision')
    const p = await d!.probe!(true)
    expect(p.available).toBe(false)
    expect(p.reason).toBe('not_installed')
  })
})
