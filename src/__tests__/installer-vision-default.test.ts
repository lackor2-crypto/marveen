import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// #514. Owner (2026-10-09): "be kell egetni, hogy benne legyen, ne is kelljen
// telepiteni, hanem az elso telepitessel telepuljon onmagatol." The face
// recognizer used to come only from the wizard's Install button. This file
// cuts the vision step out of both installers and RUNS it with a recorder in
// place of scripts/install-vision.sh, so a text-only change cannot pass.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const VISION_SH = readFileSync(join(ROOT, 'scripts', 'install-vision.sh'), 'utf-8')

function visionBlock(src: string): string {
  const start = src.indexOf('INSTALL_STEP="vision"')
  expect(start, 'no vision step in the installer').toBeGreaterThan(-1)
  const end = src.indexOf('INSTALL_STEP="', start + 1)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

/** Run the block with stubbed ok/warn and a recorder install-vision.sh. */
function runBlock(block: string, recorderExit: number): { called: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'marveen-vision-step-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    const mark = join(dir, 'called')
    writeFileSync(join(dir, 'scripts', 'install-vision.sh'), `touch "${mark}"\nexit ${recorderExit}\n`)
    const script = [
      'set -e',
      'ok() { echo "OK $*"; }', 'warn() { echo "WARN $*"; }',
      'GREEN=; ORANGE=; NC=; DIM=',
      `INSTALL_DIR="${dir}"`,
      block,
      'echo END',
    ].join('\n')
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' })
    return { called: existsSync(mark), out }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.each([
  ['install-linux.sh', LINUX],
  ['install-macos.sh', MACOS],
])('%s: the face recognizer installs by itself', (_name, src) => {
  const block = visionBlock(src)

  it('calls the real installer, with no question to the user', () => {
    expect(block).toContain('scripts/install-vision.sh')
    expect(block).not.toMatch(/\bread\s+-r?p\b/)
  })

  it('runs it, and a success is reported', () => {
    const r = runBlock(block, 0)
    expect(r.called).toBe(true)
    expect(r.out).toContain('END')
  })

  it('a failing install only warns: the main install goes on', () => {
    const r = runBlock(block, 1)
    expect(r.called).toBe(true)
    expect(r.out).toContain('END')
    expect(r.out).toMatch(/install-vision\.sh/)
  })
})

describe('install-vision.sh: prebuilt dlib first, compiler only as fallback', () => {
  it('tries the dlib-bin wheel before any source build', () => {
    const wheel = VISION_SH.indexOf('dlib-bin')
    const compile = VISION_SH.indexOf('pip" install --quiet dlib\n')
    expect(wheel).toBeGreaterThan(-1)
    expect(compile).toBeGreaterThan(wheel)
  })

  it('face_recognition goes in with --no-deps, so its "dlib" requirement starts no build', () => {
    expect(VISION_SH).toMatch(/--no-deps face_recognition/)
  })

  it('cmake is not a hard requirement up front any more', () => {
    const step1 = VISION_SH.slice(VISION_SH.indexOf('# --- Step 1'), VISION_SH.indexOf('# --- Step 2'))
    expect(step1).not.toMatch(/command -v cmake[^\n]*_fail/)
  })
})
