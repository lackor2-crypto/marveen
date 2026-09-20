import { describe, it, expect } from 'vitest'
import {
  applyVerificationFinding, descriptionWithoutFinding,
  AUTO_TESTING_MARKER, FINDING_BLOCK_START,
} from '../web/approval-finding.js'

// Kanban a2d2470e (#334): the description has to show the LATEST finding. The
// bug was silent -- the second report simply changed nothing -- so these cases
// measure the replacement itself, not just that something was written.
describe('approval verification finding in the description', () => {
  const autoDesc =
    'Kártya #321 (kanban-azonosító: c17e3a2d, nem git commit): Projekt-oldal -- várakozóba került, tehát a munka elkészült rajta. '
    + AUTO_TESTING_MARKER
    + 'a felelős ágens egészítse ki, mielőtt Boss dönt.'

  it('replaces the auto-generated marker with the finding', () => {
    const out = applyVerificationFinding(autoDesc, 'usalackor', 'fail', 'Javaslat: Boss várjon a landolásra')

    expect(out).toContain('Kártya #321')
    expect(out).not.toContain(AUTO_TESTING_MARKER)
    expect(out).toContain(`${FINDING_BLOCK_START}❌ usalackor -- Javaslat: Boss várjon a landolásra`)
  })

  it('a SECOND report replaces the first finding instead of leaving it standing', () => {
    const afterFail = applyVerificationFinding(autoDesc, 'usalackor', 'fail', 'Javaslat: Boss várjon a landolásra')
    const afterPass = applyVerificationFinding(afterFail, 'usalackor', 'pass', 'Landolt: PR #206, merge 202a0388')

    expect(afterPass).toContain('✅ usalackor -- Landolt: PR #206, merge 202a0388')
    // The exact regression: the stale fail must be gone, not merely followed.
    expect(afterPass).not.toContain('Javaslat: Boss várjon a landolásra')
    expect(afterPass).not.toContain('❌')
    expect(afterPass.match(/Tesztelve \(legfrissebb\):/g)).toHaveLength(1)
    // ...and the base text survives every round.
    expect(afterPass).toContain('Kártya #321')
  })

  it('replaces the pre-#334 block that live approval rows still carry', () => {
    const legacy =
      'Kártya #332 (kanban-azonosító: 876b2833): Kész kártyát azonnal waiting-be -- várakozóba került, tehát a munka elkészült rajta. '
      + 'Tesztelve: ❌ lagunas -- nem talaltam a kartyat'
    const out = applyVerificationFinding(legacy, 'usalackor', 'pass', 'PR #215, merge b474919c')

    expect(out).not.toContain('nem talaltam a kartyat')
    expect(out).toContain('Kártya #332')
    expect(out).toContain(`${FINDING_BLOCK_START}✅ usalackor -- PR #215, merge b474919c`)
  })

  it('appends a finding to an agent-written description that never had a marker', () => {
    // This case used to get NO finding at all: no marker, no replacement.
    const written = 'Kártya #334: a jóváhagyás leírása nem frissül. Teljes suite zöld, tsc 0 hiba.'
    const out = applyVerificationFinding(written, 'gemma', 'pass', 'atneztem, rendben')

    expect(out.startsWith(written)).toBe(true)
    expect(out).toContain(`${FINDING_BLOCK_START}✅ gemma -- atneztem, rendben`)
  })

  it('keeps a report that quotes the block start from moving the cut', () => {
    // The report is free text an agent writes; quoting the mechanism's own
    // wording must not truncate the next replacement mid-report.
    const quoted = applyVerificationFinding(
      'Kártya #999: valami.', 'nemotronsuper', 'fail',
      `a leirasban ez all: "${FINDING_BLOCK_START}✅ masik-agens -- ok", es ez elavult`,
    )
    const out = applyVerificationFinding(quoted, 'usalackor', 'pass', 'javitva')

    expect(out).toBe(`Kártya #999: valami.\n\n${FINDING_BLOCK_START}✅ usalackor -- javitva`)
  })

  it('an empty or missing description still gets the finding, without stray newlines', () => {
    expect(applyVerificationFinding(null, 'gemma', 'pass', 'ok')).toBe(`${FINDING_BLOCK_START}✅ gemma -- ok`)
    expect(applyVerificationFinding('   ', 'gemma', 'fail', '')).toBe(`${FINDING_BLOCK_START}❌ gemma -- (nincs indoklás)`)
  })

  it('a missing report becomes an explicit "no reason given", never an empty tail', () => {
    const out = applyVerificationFinding('Kártya #1: x', 'lagunas', 'fail', null)
    expect(out).toContain('❌ lagunas -- (nincs indoklás)')
  })

  it('descriptionWithoutFinding leaves a description that has no finding alone', () => {
    expect(descriptionWithoutFinding('Kártya #5: semmi teszt-blokk.')).toBe('Kártya #5: semmi teszt-blokk.')
    // A human sentence about testing is NOT a finding block (no icon).
    expect(descriptionWithoutFinding('Tesztelve: teljes suite zold, 8042 teszt.')).toBe('Tesztelve: teljes suite zold, 8042 teszt.')
  })
})
