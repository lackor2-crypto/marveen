// Rate-limit self-guard hook (kanban ef06b18d follow-up, Boss 2026-08-08):
// the Overview dashboard widget shows the plan usage % to Boss, but Boss
// pointed out that a webpage warning is useless while the agent is working --
// the agent itself needs to see the warning. This hook reads the same
// snapshot statusline.py writes and injects a directive once usage crosses
// 90%/95%, so it reaches the agent every turn instead of a page nobody's
// looking at.
//
// Behavioural tests run the python hook as a subprocess (deterministic, no LLM),
// with a fake PROJECT_ROOT (a temp dir mirroring the real layout) so the test
// never touches the live install's store/rate-limit-status/.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const HOOK_SRC = join(ROOT, 'scripts', 'hooks', 'rate-limit-guard.py')

let fakeRoot: string

beforeEach(() => {
  // A real, non-/tmp-under-homedir fixture so the hook's own filesystem
  // guards (if any project-root checks apply) never trip -- mirrors the
  // fake-project-root convention documented in marveen-test-suite-triage.
  fakeRoot = mkdtempSync(join(tmpdir(), 'rate-limit-guard-test-'))
  mkdirSync(join(fakeRoot, 'scripts', 'hooks'), { recursive: true })
  mkdirSync(join(fakeRoot, 'store', 'rate-limit-status'), { recursive: true })
  cpSync(HOOK_SRC, join(fakeRoot, 'scripts', 'hooks', 'rate-limit-guard.py'))
  writeFileSync(join(fakeRoot, '.env'), 'MAIN_AGENT_ID=testagent\n')
})

afterEach(() => {
  rmSync(fakeRoot, { recursive: true, force: true })
})

function writeSnapshot(snap: Record<string, unknown>) {
  writeFileSync(join(fakeRoot, 'store', 'rate-limit-status', 'testagent.json'), JSON.stringify(snap))
}

function runHook(): string {
  try {
    return execFileSync('python3', [join(fakeRoot, 'scripts', 'hooks', 'rate-limit-guard.py')], {
      cwd: fakeRoot,
      input: '',
      encoding: 'utf-8',
    })
  } catch {
    return ''
  }
}

describe('rate-limit-guard hook (behavioural)', () => {
  it('stays silent with no snapshot file at all', () => {
    expect(runHook().trim()).toBe('')
  })

  it('stays silent below the caution threshold', () => {
    writeSnapshot({ fiveHour: { usedPct: 40 }, sevenDay: { usedPct: 10 }, updatedAt: Date.now() })
    expect(runHook().trim()).toBe('')
  })

  it('warns at/above the caution threshold, below critical', () => {
    writeSnapshot({ fiveHour: { usedPct: 91 }, sevenDay: { usedPct: 10 }, updatedAt: Date.now() })
    const out = runHook()
    expect(out).toContain('KERET-FIGYELMEZTETES')
    expect(out).toContain('91%')
    expect(out.toLowerCase()).not.toContain('ne vegezz kodolast')
  })

  it('warns at/above the critical threshold with the no-coding directive', () => {
    writeSnapshot({ fiveHour: { usedPct: 97 }, sevenDay: { usedPct: 20 }, updatedAt: Date.now() })
    const out = runHook()
    expect(out).toContain('KERET-FIGYELMEZTETES')
    expect(out).toContain('97%')
    expect(out.toLowerCase()).toContain('ne vegezz kodolast')
  })

  // The hook deliberately reads ONLY the 5-hour window (`worst = five`, with the
  // sevenDay figure treated as display-only). This test pins that decision so it
  // is a visible choice rather than something that quietly rots: a seven-day
  // window at 97% now produces NO warning at all.
  //
  // Flagged to Boss on 2026-08-11 as a behaviour change worth a second look --
  // running out of the weekly allowance stops work just as hard as the 5-hour
  // one does, and nothing warns about it any more.
  it('ignores the seven-day window entirely (only the 5-hour plan window drives the warning)', () => {
    writeSnapshot({ fiveHour: { usedPct: 20 }, sevenDay: { usedPct: 97 }, updatedAt: Date.now() })
    expect(runHook().trim()).toBe('')
  })

  it('stays silent when the snapshot is stale (agent idle since last tick)', () => {
    writeSnapshot({ fiveHour: { usedPct: 99 }, sevenDay: { usedPct: 10 }, updatedAt: Date.now() - 40 * 60_000 })
    expect(runHook().trim()).toBe('')
  })

  it('ignores a snapshot with no usable percentages', () => {
    writeSnapshot({ fiveHour: { usedPct: null }, sevenDay: { usedPct: null }, updatedAt: Date.now() })
    expect(runHook().trim()).toBe('')
  })
})
