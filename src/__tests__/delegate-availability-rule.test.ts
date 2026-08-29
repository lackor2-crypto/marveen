// Munka atadasa elott kotelezo ellenorizni: online-e a cimzett -- es ez
// FLOTTA-szabaly, nem emlekezet.
//
// Boss (Telegram, 2026-08-29): "mielott barkinek is barki atadna egy
// feladatot, az elso dolog az legyen hogy ellenorizni kell hogy egyaltalan
// online e. el e. mertha nem akor teneked magadnak kel megcsinalni a munkat
// es nem adhatod at masnak! esetleg egy harmadik agentnek aki elerheto es
// megfelel a kovetelmenyeknek."
//
// A valos eset ugyanaznap: egy login-doboz javitas ki lett adva usalackornak,
// aki eppen "Not logged in -- Please run /login" allapotban ult (nem tudta
// feldolgozni a feladatot), majd lackor3-nak, aki mar a heti keretet is
// kimeritette. Mindket atadas eszrevetlenul allt, amig Boss ra nem mutatott.
//
// Amit ez a teszt ved (ugyanaz az ot pontos szerzodes, mint a tobbi generalt
// szabalynal):
//   1. meglevo agens CLAUDE.md-je megkapja a blokkot (nincs kezi migracio),
//   2. ujboli hivas no-op: nincs duplikalt blokk es nincs felesleges iras,
//   3. a markereken KIVULI tartalomhoz sosem nyulunk,
//   4. a fo agens kimarad az agens-fajlbol, de a gepszintu ~/.claude/CLAUDE.md
//      lefedi,
//   5. a szabaly szovege gepfuggetlen: nem nevez meg agenst, tulajdonost, utat.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_AGENT_ID } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { ensureDelegateCheckSection, ensureGlobalDelegateCheckRule } from '../web/agent-scaffold.js'

const THROWAWAY = 'zz-delegate-check-probe'

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

describe('ensureDelegateCheckSection', () => {
  it('beirja a szabalyt egy meglevo agens CLAUDE.md-jebe', () => {
    const path = seed('# zz-delegate-check-probe\n\nSajat tartalom.\n')
    expect(ensureDelegateCheckSection(THROWAWAY)).toBe('written')
    const out = readFileSync(path, 'utf-8')
    expect(out).toContain('MUNKA ATADASA ELOTT KOTELEZO ELLENORIZNI: ONLINE-E A CIMZETT')
    // Kis-nagybetu-fuggetlenul: a szabaly szovege nyomatekositasbol
    // 'HARMADIK agens'-t ir, es ezen a teszt ne bukjon el.
    expect(out).toMatch(/harmadik agens/i)
    expect(out).toContain('Sajat tartalom.')
  })

  it('idempotens: nincs duplikalt blokk es nincs ujrairas masodszorra', () => {
    const path = seed('# zz-delegate-check-probe\n\nSajat tartalom.\n')
    ensureDelegateCheckSection(THROWAWAY)
    const firstWrite = statSync(path).mtimeMs
    expect(ensureDelegateCheckSection(THROWAWAY)).toBe('current')
    const out = readFileSync(path, 'utf-8')
    const occurrences = out.split('BEGIN GENERATED: delegate-availability-rule').length - 1
    expect(occurrences).toBe(1)
    expect(statSync(path).mtimeMs).toBe(firstWrite)
  })

  it('egy elavult blokkot lecserel, a korulotte levo sorokat nem bantja', () => {
    const path = seed(
      '# zz-delegate-check-probe\n\nELOTTE.\n\n'
      + '<!-- BEGIN GENERATED: delegate-availability-rule (auto-generated, do not edit by hand) -->\n'
      + 'regi szoveg\n'
      + '<!-- END GENERATED: delegate-availability-rule -->\n\nUTANA.\n',
    )
    expect(ensureDelegateCheckSection(THROWAWAY)).toBe('written')
    const out = readFileSync(path, 'utf-8')
    expect(out).not.toContain('regi szoveg')
    expect(out).toContain('MUNKA ATADASA ELOTT KOTELEZO ELLENORIZNI')
    expect(out).toContain('ELOTTE.')
    expect(out).toContain('UTANA.')
  })

  it('a fo agenst kihagyja az agens-fajlbol, es hianyzo fajlt nem hoz letre', () => {
    expect(ensureDelegateCheckSection(MAIN_AGENT_ID)).toBe('skipped-main')
    expect(ensureDelegateCheckSection(THROWAWAY)).toBe('no-file')
  })

  it('a szoveg gepfuggetlen: nincs benne agens-nev, tulajdonos-nev, /home ut', () => {
    const path = seed('# zz-delegate-check-probe\n')
    ensureDelegateCheckSection(THROWAWAY)
    const block = readFileSync(path, 'utf-8')
    expect(block).not.toContain('/home/')
    expect(block).not.toContain('lackor')
    expect(block).not.toContain('usalackor')
    expect(block).not.toContain('Marvin')
    expect(block).not.toContain('Boss')
  })
})

describe('ensureGlobalDelegateCheckRule', () => {
  it('a gepszintu CLAUDE.md-be is beirja, a meglevo tartalom mellé', () => {
    const home = mkdtempSync(join(tmpdir(), 'delegate-check-home-'))
    const original = process.env['HOME']
    process.env['HOME'] = home
    try {
      const path = join(home, '.claude', 'CLAUDE.md')
      mkdirSync(join(home, '.claude'), { recursive: true })
      writeFileSync(path, '# Sajat gepszintu szabalyaim\n\nEzt nem szabad bantani.\n')
      ensureGlobalDelegateCheckRule()
      const out = readFileSync(path, 'utf-8')
      expect(out).toContain('MUNKA ATADASA ELOTT KOTELEZO ELLENORIZNI')
      expect(out).toContain('Ezt nem szabad bantani.')

      const mtime = statSync(path).mtimeMs
      ensureGlobalDelegateCheckRule()
      expect(statSync(path).mtimeMs).toBe(mtime)
      expect(readFileSync(path, 'utf-8').split('BEGIN GENERATED: delegate-availability-rule').length - 1).toBe(1)
    } finally {
      if (original === undefined) delete process.env['HOME']
      else process.env['HOME'] = original
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('friss telepitesen letrehozza a fajlt, nem hallgat', () => {
    const home = mkdtempSync(join(tmpdir(), 'delegate-check-fresh-'))
    const original = process.env['HOME']
    process.env['HOME'] = home
    try {
      ensureGlobalDelegateCheckRule()
      const out = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf-8')
      expect(out).toContain('MUNKA ATADASA ELOTT KOTELEZO ELLENORIZNI: ONLINE-E A CIMZETT')
    } finally {
      if (original === undefined) delete process.env['HOME']
      else process.env['HOME'] = original
      rmSync(home, { recursive: true, force: true })
    }
  })
})
