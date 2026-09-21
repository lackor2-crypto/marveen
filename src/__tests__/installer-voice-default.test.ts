import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Kanban a0637863. Boss (2026-09-21, uzenet 1117): "Ezt az osszes agentnek meg
// kellene, hogy kapja alapbol. Tehat egess be a magunkba. Uj telepitesnel is jo
// legyen." -- a beszed-szoveg atiro egy friss telepitesen NEM volt meg: az
// install-linux.sh Whisper-blokkja (1) OPT-IN volt (default n), es (2) a rossz
// stacket ajanlotta (openai-whisper pipx-szel), amit a hanguzenet-atiro pipeline
// (src/web/routes/voice.ts -> transcribeVoiceFile, ~/.local/share/marveen-voice
// venv) SOSEM hivott. A valodi telepito a scripts/install-voice.sh, es azt a fo
// telepito korabban meg sem hivta.
//
// Ez a file a meres: nem csak a szoveget nezi, hanem KIVAGJA a blokkot es
// LEFUTTATJA egy rogzitovel (recorder) az install-voice.sh helyen, igy egy ures
// diff (a "kesz" jelentes valodi valtoztatas nelkul) nem mehet at.

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const LANG = readFileSync(join(ROOT, 'install-lang.sh'), 'utf-8')

/** A hang-komponens szekcio, a bannertol a kovetkezo szekcio-jelig. */
function voiceBlock(src: string): string {
  const start = src.indexOf('# --- Beszed-szoveg atiro (STT)')
  expect(start, 'nincs hang-komponens szekcio az install-linux.sh-ban').toBeGreaterThan(-1)
  const end = src.indexOf('INSTALL_STEP="bumblebee"', start)
  expect(end, 'nincs lezaro szekcio a hang-blokk utan').toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('installer: a beszed-szoveg atiro ALAPBOL telepul (nem opt-in)', () => {
  const block = voiceBlock(LINUX)

  it('a VALODI telepitot hivja: scripts/install-voice.sh, SKIP_SYSTEM_DEPS=1-gyel', () => {
    expect(block).toContain('scripts/install-voice.sh')
    expect(block).toContain('SKIP_SYSTEM_DEPS=1')
  })

  it('nem opt-in: a blokkban nincs read -rp / user-kerdes', () => {
    expect(block).not.toMatch(/\bread\s+-rp\b/)
  })

  it('a regi, sosem hasznalt openai-whisper (pipx) stack eltunt a telepitobol', () => {
    // A tenyleges parancs es a kihagyas opt-in kapcsoloja tunt el (a szo egy
    // magyarazo kommentben meg szerepelhet -- az tortenet, nem kod).
    expect(LINUX).not.toMatch(/pipx install openai-whisper/)
    expect(LINUX).not.toContain('prompt_whisper')
    // A most feleslegesse valt szovegkulcs sem maradhat a lang-fajlban (paritas).
    expect(LANG).not.toContain('prompt_whisper')
  })

  it('a python3-venv rendszerfuggoseget a fo telepito sudo-apt utja biztositja', () => {
    expect(block).toContain('python3-venv')
    expect(block).toContain('apt_run')
  })
})

describe('installer: a hang-blokk tenylegesen le is fut, user-valasz nelkul', () => {
  // Recorder az install-voice.sh helyen + hamis python3/ffmpeg a PATH-on, hogy a
  // futas a host meglevo csomagjaitol fuggetlen es determinisztikus legyen.
  function runBlock(input: string): { out: string; recorded: string } {
    const dir = mkdtempSync(join(tmpdir(), 'marveen-voice-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin, { recursive: true })
      // python3 -m venv --help -> 0 ; ffmpeg -> letezik
      writeFileSync(join(bin, 'python3'), '#!/bin/bash\nexit 0\n')
      writeFileSync(join(bin, 'ffmpeg'), '#!/bin/bash\nexit 0\n')
      chmodSync(join(bin, 'python3'), 0o755)
      chmodSync(join(bin, 'ffmpeg'), 0o755)

      const scriptsDir = join(dir, 'scripts')
      mkdirSync(scriptsDir, { recursive: true })
      const log = join(dir, 'called.txt')
      // A recorder rogziti, hogy meghivtak-e ES hogy SKIP_SYSTEM_DEPS atjott-e.
      writeFileSync(
        join(scriptsDir, 'install-voice.sh'),
        `#!/bin/bash\nprintf 'CALLED SKIP=%s\\n' "\${SKIP_SYSTEM_DEPS:-}" >> "${log}"\nexit 0\n`,
      )
      chmodSync(join(scriptsDir, 'install-voice.sh'), 0o755)

      const script = [
        'set -e',
        `export PATH="${bin}:$PATH"`,
        'DIM=""; NC=""',
        'PKG_MANAGER=""', // ne az apt-agra menjen a venv-telepites a tesztben
        'ok() { echo "OK: $*"; }',
        'warn() { echo "WARN: $*"; }',
        'wait_for_apt_lock() { :; }',
        'apt_run() { :; }',
        `INSTALL_DIR="${dir}"`,
        voiceBlock(LINUX),
      ].join('\n')
      const out = execFileSync('bash', ['-c', script], { input, encoding: 'utf-8' })
      return { out, recorded: existsSync(log) ? readFileSync(log, 'utf-8') : '' }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('ures stdin eseten is meghivja az install-voice.sh-t (nem var user-valaszra)', () => {
    const { out, recorded } = runBlock('')
    expect(recorded).toContain('CALLED')
    expect(recorded).toContain('SKIP=1')
    expect(out).toContain('OK:')
  })
})
