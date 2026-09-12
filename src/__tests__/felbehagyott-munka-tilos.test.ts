// FELBEHAGYOTT MUNKA NINCS + SOHA NEM DOLGOZUNK AZ ELO FABAN.
//
// Boss, 2026-09-12: "nem lehet ugy felbehagyni munkat hogy az a vegen
// commitkolatlan es pusholatlan maradjon. soha." -- es az indok ugyanabbol a
// mondatbol: "mert most mindenki all. es nem lehet tudni ki hagyta ott oket."
// Majd kulon: "sohasem dolgozunk kozvetlenul az elo tree ben!"
//
// A MERT ESET (2026-09-12). Az elo telepites munkafajaban 59 fajl allt
// commitolatlanul, legalabb negy kulon funkciobol. A kod ZOLD volt -- 487
// tesztfajl, 7523 teszt, 0 bukas --, csak soha nem lett commitolva: nem volt
// szerzoje, uzenete, visszavonhato pontja. Ugyanennek a fanak a `.git/config`-jaban
// `core.bare = true` allt, ezert ott semmilyen `git status`/`commit` nem futott le.
// Es a tesztkeszletet ott el sem lehet inditani: az `assert-not-live-install.ts`
// or szandekosan megtagadja -- aki az elo faban dolgozik, nem tudja lefuttatni a
// sajat tesztjeit.
//
// Ez a fajl azt orzi, hogy a doktrina ott legyen, ahol egy FRISS TELEPITES is
// megkapja: a kovetett template-ben es a kovetett seed-skillben. A gep sajat
// `CLAUDE.md`-je gitignore-olt (generalt fajl), azt itt nem lehet ellenorizni --
// eppen ezert kell a template-ben allnia.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const TEMPLATE = join(REPO, 'templates', 'CLAUDE.md.template')
const SKILL = join(REPO, 'seed-skills', 'nyomtalan-munka', 'SKILL.md')

function olvas(p: string): string {
  return readFileSync(p, 'utf-8')
}

describe('felbehagyott munka tilos -- a doktrina friss telepitesen is ott van', () => {
  it('a CLAUDE.md template kimondja: commitolatlanul es pusholatlanul nem lehet otthagyni', () => {
    const t = olvas(TEMPLATE)
    expect(t).toContain('FÉLBEHAGYOTT MUNKA NINCS')
    // A lenyeg nem a cim, hanem a ket mechanikus kovetkezmeny:
    expect(t).toContain('wip:')
    expect(t).toMatch(/pusholatlan/i)
  })

  it('a CLAUDE.md template kimondja: sosem dolgozunk kozvetlenul az elo faban', () => {
    const t = olvas(TEMPLATE)
    expect(t).toContain('SOHA NEM DOLGOZUNK KÖZVETLENÜL')
    expect(t).toContain('worktree')
    // A teszt-or megkerulese kifejezetten tiltott -- ez a mondat sem hianyozhat.
    expect(t).toContain('assert-not-live-install')
  })

  it('a nyomtalan-munka seed-skill is viszi mindket szabalyt (a skill globalis)', () => {
    const s = olvas(SKILL)
    expect(s).toContain('FÉLBEHAGYOTT MUNKA NINCS')
    expect(s).toContain('SOHA NEM DOLGOZUNK KÖZVETLENÜL')
  })

  it('a template es a skill NEM tartalmaz gepspecifikus nevet -- helyorzot hasznal', () => {
    // "A SKILLEKET IS GLOBALISAN KELL MEGIRNI": a fejleszto gepere jellemzo ertek
    // (nev, utvonal, fiok) nem kerulhet bele, kulonben friss telepitesen hamis.
    for (const p of [TEMPLATE, SKILL]) {
      const t = olvas(p)
      const ujResz = t.slice(t.indexOf('FÉLBEHAGYOTT MUNKA NINCS'))
      expect(ujResz).not.toMatch(/\bBoss\b/)
      expect(ujResz).toContain('{{OWNER_NAME}}')
    }
  })
})

describe('core.longpaths -- friss telepites mely, ekezetes utvonalakon is menjen', () => {
  // A raktar Windows-meghajton all (pl. "F:\\Marveen\\<nev>\\Projektek\\..."),
  // ahol a Windows 260 karakternel elvagja az utvonalat. A `--config` kapcsolo a
  // KLONOZOTT repo sajat configjaba irja be a beallitast, tehat kesobb a
  // Windows-oldali git (VS Code, Intezo) is latja.
  it('az install-linux.sh a klonozaskor beallitja', () => {
    expect(olvas(join(REPO, 'install-linux.sh'))).toContain('--config core.longpaths=true')
  })

  it('az install-windows.ps1 beallitja a klonon ES a Windows-oldali giten', () => {
    const t = olvas(join(REPO, 'install-windows.ps1'))
    expect(t).toContain('--config core.longpaths=true')
    expect(t).toContain('git config --global core.longpaths true')
    // A rendszerszintu kapcsolo kulon dolog -- enelkul maga a Windows vag.
    expect(t).toContain('LongPathsEnabled')
  })

  it('a raktarba lehuzott repok is megkapjak (nem csak a Marveen sajat klonja)', () => {
    const t = olvas(join(REPO, 'src', 'git-accounts.ts'))
    expect(t).toContain("'--config', 'core.longpaths=true'")
  })

  it('a hianyzo Windows-git NEM ugyanaz, mint a kikapcsolt beallitas', () => {
    // A NULLA KET DOLGOT JELENTHET. Ha nincs Windows-oldali git, azt ki kell
    // mondani -- nem szabad ugy viselkedni, mintha a beallitas lenne kikapcsolva.
    const t = olvas(join(REPO, 'install-windows.ps1'))
    expect(t).toContain('Windows-oldali git nem található')
  })
})
