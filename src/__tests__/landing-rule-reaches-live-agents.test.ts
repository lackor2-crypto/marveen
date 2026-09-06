// A landolasi doksi eddig CSAK a telepitesi sablonban letezett.
//
// Merve 2026-09-06-an az ELO telepitesen: a projekt CLAUDE.md-ben es mind a
// nyolc agens CLAUDE.md-jeben NULLA talalat a "land-pr"-re, miközben a
// templates/CLAUDE.md.template reszletesen leirja. Az ok nem feledekenyseg: a
// CLAUDE.md fajlok nincsenek git-ben kovetve (`git ls-files CLAUDE.md` -> 0
// sor), tehat a sablon kizarolag TELEPITESKOR, illetve UJ agens
// letrehozasakor er el egy fajlt. A mar letezo fajlokba semmi nem viszi be
// utolag -- ugyanaz a sablon-vs-elo szinkron-res, ami a negy ledger-hookot is
// hetekig a fo agensnel tartotta.
//
// Amit ez a teszt ved (a #202-es wake-greeting teszt mintajara):
//   1. meglevo agens CLAUDE.md-je megkapja a blokkot (nincs kezi migracio),
//   2. ujboli hivas no-op: nincs duplikalt blokk es nincs felesleges iras,
//   3. a markereken KIVULI tartalomhoz sosem nyulunk,
//   4. a fo agens es a worktree-bol dolgozo agens a gepszintu ~/.claude/CLAUDE.md-bol
//      kapja meg -- es a landolas EPPEN worktree-bol tortenik, tehat ez a fontosabb fele,
//   5. a szoveg gepfuggetlen,
//   6. friss telepites: a sablon TOVABBRA is tartalmazza (az elso dashboard-indulas
//      elott csak az van), es a szabaly tenylegesen be van kotve a web.ts-be.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureLandingSection, ensureGlobalLandingRule } from '../web/agent-scaffold.js'

const REPO = join(__dirname, '..', '..')
const THROWAWAY = 'zz-landing-rule-probe'

afterEach(() => {
  rmSync(agentDir(THROWAWAY), { recursive: true, force: true })
})

function seed(body: string): string {
  const dir = agentDir(THROWAWAY)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'CLAUDE.md')
  writeFileSync(path, body)
  return path
}

describe('ensureLandingSection', () => {
  it('beirja a landolasi szabalyt egy meglevo agens CLAUDE.md-jebe', () => {
    const path = seed('# zz-landing-rule-probe\n\nSajat tartalom.\n')
    expect(ensureLandingSection(THROWAWAY)).toBe('written')
    const out = readFileSync(path, 'utf-8')
    // A negy dolog, ami nelkul az agens rossz utat valaszt:
    expect(out).toContain('scripts/land-pr.sh')          // MIVEL landol
    expect(out).toContain('DIREKT PUSH TILOS')           // amit NEM szabad
    expect(out).toContain('MEGVARJA amig a CI zold')     // miert nem eleg a push
    expect(out).toContain('MARVEEN_SKIP_TEST_GATE=1')    // a veszkijarat, es hogy CSAK a lokalis kapura all
    expect(out).toContain('Sajat tartalom.')             // a sajat tartalom serthetetlen
  })

  it('idempotens: nincs duplikalt blokk es nincs ujrairas masodszorra', () => {
    const path = seed('# zz-landing-rule-probe\n\nSajat tartalom.\n')
    ensureLandingSection(THROWAWAY)
    const firstWrite = statSync(path).mtimeMs
    expect(ensureLandingSection(THROWAWAY)).toBe('current')
    const out = readFileSync(path, 'utf-8')
    expect(out.split('BEGIN GENERATED: landing-rule').length - 1).toBe(1)
    expect(statSync(path).mtimeMs).toBe(firstWrite)
  })

  it('egy elavult blokkot lecserel, a korulotte levo sorokat nem bantja', () => {
    const path = seed(
      '# zz-landing-rule-probe\n\nELOTTE.\n\n'
      + '<!-- BEGIN GENERATED: landing-rule (auto-generated, do not edit by hand) -->\n'
      + 'regi szoveg\n'
      + '<!-- END GENERATED: landing-rule -->\n\nUTANA.\n',
    )
    expect(ensureLandingSection(THROWAWAY)).toBe('written')
    const out = readFileSync(path, 'utf-8')
    expect(out).not.toContain('regi szoveg')
    expect(out).toContain('scripts/land-pr.sh')
    expect(out).toContain('ELOTTE.')
    expect(out).toContain('UTANA.')
  })

  it('tobb generalt blokk mellett is CSAK a sajatjat csereli (nem-mohó illesztes)', () => {
    // Egy mohó regex a sajat BEGIN-jetol a fajl UTOLSO END-jeig tartana, es
    // menet kozben megenne a kozte allo mas szabalyokat -- csendben.
    const path = seed(
      '<!-- BEGIN GENERATED: landing-rule (auto-generated, do not edit by hand) -->\n'
      + 'regi landolas\n'
      + '<!-- END GENERATED: landing-rule -->\n\n'
      + '<!-- BEGIN GENERATED: recheck-rule (auto-generated, do not edit by hand) -->\n'
      + 'IDEGEN SZABALY TARTALMA\n'
      + '<!-- END GENERATED: recheck-rule -->\n',
    )
    ensureLandingSection(THROWAWAY)
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('IDEGEN SZABALY TARTALMA')
    expect(out).toContain('BEGIN GENERATED: recheck-rule')
    expect(out).not.toContain('regi landolas')
  })

  it('a fo agenst kihagyja az agens-fajlbol, es hianyzo fajlt nem hoz letre', () => {
    expect(ensureLandingSection(MAIN_AGENT_ID)).toBe('skipped-main')
    expect(ensureLandingSection(THROWAWAY)).toBe('no-file')
  })

  it('a szoveg gepfuggetlen: nincs benne agens-nev, tulajdonos-nev, /home ut', () => {
    const path = seed('# zz-landing-rule-probe\n')
    ensureLandingSection(THROWAWAY)
    const block = readFileSync(path, 'utf-8')
    expect(block).not.toContain('/home/')
    expect(block).not.toContain('lackor')
    expect(block).not.toContain('Marvin')
    expect(block).not.toContain('Boss')
  })
})

describe('ensureGlobalLandingRule', () => {
  it('a gepszintu CLAUDE.md-be is beirja, a meglevo tartalom melle', () => {
    // Ez a fontosabb fele: a landolas worktree-bol tortenik, es egy
    // worktree-ben futo session SOSEM olvassa az agents/<nev>/CLAUDE.md-t.
    const home = mkdtempSync(join(tmpdir(), 'landing-rule-home-'))
    const original = process.env['HOME']
    process.env['HOME'] = home
    try {
      const path = join(home, '.claude', 'CLAUDE.md')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(path, '# Gepszintu\n\nMar itt levo sor.\n')
      ensureGlobalLandingRule()
      const out = readFileSync(path, 'utf-8')
      expect(out).toContain('Mar itt levo sor.')
      expect(out).toContain('scripts/land-pr.sh')
      // Masodszorra nem duplikal.
      ensureGlobalLandingRule()
      expect(readFileSync(path, 'utf-8').split('BEGIN GENERATED: landing-rule').length - 1).toBe(1)
    } finally {
      if (original === undefined) delete process.env['HOME']
      else process.env['HOME'] = original
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('hianyzo gepszintu fajlt letrehoz (friss telepites)', () => {
    const home = mkdtempSync(join(tmpdir(), 'landing-rule-home-'))
    const original = process.env['HOME']
    process.env['HOME'] = home
    try {
      ensureGlobalLandingRule()
      expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')).toContain('scripts/land-pr.sh')
    } finally {
      if (original === undefined) delete process.env['HOME']
      else process.env['HOME'] = original
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('a szabaly tenylegesen be van kotve (nem eleg megirni)', () => {
  it('a web.ts indulaskor minden agensre es gepszinten is meghivja', () => {
    const web = readFileSync(join(REPO, 'src', 'web.ts'), 'utf-8')
    expect(web).toContain('ensureLandingSection(agentName)')
    expect(web).toContain('ensureGlobalLandingRule()')
  })

  it('friss telepites: a sablon is tartalmazza, mert az elso indulas elott csak az van', () => {
    const tpl = readFileSync(join(REPO, 'templates', 'CLAUDE.md.template'), 'utf-8')
    expect(tpl).toContain('land-pr.sh')
  })
})

describe('a gyors lokalis kapu leirasa egyezik azzal, amit a kapu csinal', () => {
  // A #215 atallitas utan a telepito komment meg a REGI viselkedest allitotta
  // ("run the full suite"), miközben a sub-hook mar csak tsc + syntax-ellenorzest
  // futtat. Egy hazudo komment rosszabb a hianyzonal: aki elolvassa, azt hiszi,
  // a push elott lefutott a teljes suite.
  it('a telepito nem allitja, hogy a sub-hook a teljes suite-ot futtatja', () => {
    const sh = readFileSync(join(REPO, 'scripts', 'install-test-gate-hook.sh'), 'utf-8')
    // A regi, hazudo mondat: "The gate sub-hook: run the full suite (+ tsc)".
    // Szuk mintara megyunk, mert a JAVITOTT szoveg maga is tartalmazza a
    // "run the full suite" szavakat -- tagadva.
    expect(sh).not.toMatch(/sub-hook:\s*run the full suite/i)
    expect(sh).toContain('does NOT run the full suite')
    // ...es a generalt sub-hook tenyleg nem INDIT teljes suite-ot. (A "vitest"
    // szo maga elofordul a fajlban, egy magyarazo kommentben -- a hivas az, ami
    // nem lehet ott.)
    expect(sh).not.toMatch(/npx vitest|npm (run )?test/)
  })
})
