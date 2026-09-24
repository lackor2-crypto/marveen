// Audit f97acc32 D: the speech-to-text + voice stack the fleet actually calls
// (scripts/install-voice.sh: faster-whisper + piper) must be installed by BOTH
// installers. The Linux one has run it since 2026-09-21; the macOS one never did,
// so a fresh Mac had no working transcriber.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')

describe.each(['install-linux.sh', 'install-macos.sh'])('%s', (file) => {
  const src = read(file)
  it('runs scripts/install-voice.sh without root (SKIP_SYSTEM_DEPS=1)', () => {
    expect(src).toMatch(/SKIP_SYSTEM_DEPS=1 bash "\$INSTALL_DIR\/scripts\/install-voice\.sh"/)
  })
  it('only after ffmpeg is in place, and a failure does not stop the install', () => {
    const call = src.search(/SKIP_SYSTEM_DEPS=1 bash "\$INSTALL_DIR\/scripts\/install-voice\.sh"/)
    const guard = src.lastIndexOf('command -v ffmpeg', call)
    expect(guard).toBeGreaterThan(-1)
    expect(src.slice(call - 20, call)).toMatch(/if\s+$/)
  })
})
