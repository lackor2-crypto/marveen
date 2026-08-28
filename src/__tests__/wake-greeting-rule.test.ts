// A felebredes elso mondata a koszones -- es ez FLOTTA-szabaly, nem emlekezet.
//
// Boss, 2026-08-28 (hangzenet): "amikor felebredsz, akkor azzal kezd, az elso
// lepes az, hogy felebredtem. Szia, itt vagyok, felebredtem. Es a masodik lepes
// [...] a telegramban levo utasitasokat elkezded vegig megcsinalni. De az elso
// lepes mindig az, hogy szia, itt vagyok, felebredtem."
//
// Egy 2026-08-11-es kartya (1aad386f) ezt mar kimondta, de a kod sosem keszult
// el hozza: 2026-08-28-an merve a szabaly SEHOL nem szerepelt -- se a kozos
// sablonban, se egyetlen agens CLAUDE.md-jeben. Vagyis addig kizarolag azon
// mult, hogy az adott agens emlekszik-e ra.
//
// Amit ez a teszt ved:
//   1. meglevo agens CLAUDE.md-je megkapja a blokkot (nincs kezi migracio),
//   2. ujboli hivas no-op: nincs duplikalt blokk es nincs felesleges iras,
//   3. a markereken KIVULI tartalomhoz sosem nyulunk,
//   4. a fo agens kimarad az agens-fajlbol, de a gepszintu ~/.claude/CLAUDE.md
//      lefedi -- a fo agens is felebred, neki is koszonnie kell,
//   5. a szabaly szovege gepfuggetlen: nem nevez meg agenst, tulajdonost, utat.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureWakeGreetingSection, ensureGlobalWakeGreetingRule } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-wake-greeting-probe'

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

describe('ensureWakeGreetingSection', () => {
  it('beirja a szabalyt egy meglevo agens CLAUDE.md-jebe', () => {
    const path = seed('# zz-wake-greeting-probe\n\nSajat tartalom.\n')
    expect(ensureWakeGreetingSection(THROWAWAY)).toBe('written')
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('FELEBREDESKOR AZ ELSO MONDAT A KOSZONES')
    // A konkret mondat, amit a tulajdonos kert -- nem csak az elv.
    expect(out).toContain('Szia, itt vagyok, felebredtem')
    // A ket fel egyutt all benne: kieseskor csend, visszatereskor koszones.
    expect(out).toContain('KIESESKOR hallgatsz')
    // A sajat tartalom serthetetlen.
    expect(out).toContain('Sajat tartalom.')
  })

  it('idempotens: nincs duplikalt blokk es nincs ujrairas masodszorra', () => {
    const path = seed('# zz-wake-greeting-probe\n\nSajat tartalom.\n')
    ensureWakeGreetingSection(THROWAWAY)
    const firstWrite = statSync(path).mtimeMs
    expect(ensureWakeGreetingSection(THROWAWAY)).toBe('current')
    const out = readFileSync(path, 'utf-8')
    const occurrences = out.split('BEGIN GENERATED: wake-greeting-rule').length - 1
    expect(occurrences).toBe(1)
    expect(statSync(path).mtimeMs).toBe(firstWrite)
  })

  it('egy elavult blokkot lecserel, a korulotte levo sorokat nem bantja', () => {
    const path = seed(
      '# zz-wake-greeting-probe\n\nELOTTE.\n\n'
      + '<!-- BEGIN GENERATED: wake-greeting-rule (auto-generated, do not edit by hand) -->\n'
      + 'regi szoveg\n'
      + '<!-- END GENERATED: wake-greeting-rule -->\n\nUTANA.\n',
    )
    expect(ensureWakeGreetingSection(THROWAWAY)).toBe('written')
    const out = readFileSync(path, 'utf-8')
    expect(out).not.toContain('regi szoveg')
    expect(out).toContain('Szia, itt vagyok, felebredtem')
    expect(out).toContain('ELOTTE.')
    expect(out).toContain('UTANA.')
  })

  it('a fo agenst kihagyja az agens-fajlbol, es hianyzo fajlt nem hoz letre', () => {
    expect(ensureWakeGreetingSection(MAIN_AGENT_ID)).toBe('skipped-main')
    // Nem letezo agens: 'no-file', nem osszeomlas es nem uj fajl.
    expect(ensureWakeGreetingSection(THROWAWAY)).toBe('no-file')
  })

  it('a szoveg gepfuggetlen: nincs benne agens-nev, tulajdonos-nev, /home ut', () => {
    const path = seed('# zz-wake-greeting-probe\n')
    ensureWakeGreetingSection(THROWAWAY)
    const block = readFileSync(path, 'utf-8')
    expect(block).not.toContain('/home/')
    expect(block).not.toContain('lackor')
    expect(block).not.toContain('Marvin')
    expect(block).not.toContain('Boss')
  })
})

describe('ensureGlobalWakeGreetingRule', () => {
  it('a gepszintu CLAUDE.md-be is beirja, a meglevo tartalom mellé', () => {
    // A fo agens es a worktree-ben futo agens SOSEM olvassa a sajat
    // agents/<nev>/CLAUDE.md-jet, viszont ok is felebrednek. Ezert a
    // gepszintu fajl a lenyeg, nem a kenyelem.
    const home = mkdtempSync(join(tmpdir(), 'wake-greeting-home-'))
    const original = process.env['HOME']
    process.env['HOME'] = home
    try {
      const path = join(home, '.claude', 'CLAUDE.md')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(path, '# Sajat gepszintu szabalyaim\n\nEzt nem szabad bantani.\n')
      ensureGlobalWakeGreetingRule()
      const out = readFileSync(path, 'utf-8')
      expect(out).toContain('Szia, itt vagyok, felebredtem')
      expect(out).toContain('Ezt nem szabad bantani.')

      // Masodszorra nem ir ujra.
      const mtime = statSync(path).mtimeMs
      ensureGlobalWakeGreetingRule()
      expect(statSync(path).mtimeMs).toBe(mtime)
      expect(readFileSync(path, 'utf-8').split('BEGIN GENERATED: wake-greeting-rule').length - 1).toBe(1)
    } finally {
      if (original === undefined) delete process.env['HOME']
      else process.env['HOME'] = original
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('friss telepitesen letrehozza a fajlt, nem hallgat', () => {
    // Ures ~/.claude: a nulla itt "meg nincs semmi", nem "nem lattam oda" --
    // ezert a szabalynak akkor is meg kell szuletnie.
    const home = mkdtempSync(join(tmpdir(), 'wake-greeting-fresh-'))
    const original = process.env['HOME']
    process.env['HOME'] = home
    try {
      ensureGlobalWakeGreetingRule()
      const out = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')
      expect(out).toContain('FELEBREDESKOR AZ ELSO MONDAT A KOSZONES')
    } finally {
      if (original === undefined) delete process.env['HOME']
      else process.env['HOME'] = original
      rmSync(home, { recursive: true, force: true })
    }
  })
})
