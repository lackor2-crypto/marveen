// SKILL NEM SZULETHET `scope:` NELKUL.
//
// Boss, 2026-08-30: "ne lehessen letrehozni skillt e nelkul hogy ezt meg ne
// adnad. es ha nem szemelyes hanem altalanosan hasznalhato barkinek, akkor
// viszont azt be kel egetni a marveenba! minidg." -- es: "De menet kozben is ha
// egy olyan altalanos skill jon letre azt is mind be kell egetni!"
//
// A mert eset (2026-08-30): negy skill letezett CSAK ezen a gepen
// (gold-technical-analysis, skill-factory, whatsapp-kiss-zoltan-send,
// whatsapp-send). Kettot GEP irt a tomorites-reflexiobol, ember nelkul -- tehat
// senki nem dontotte el, kire szolnak. Az egyikuk maga a `skill-factory` volt:
// egy friss telepites a skill-gyarat sem kapta volna meg.
//
// Ez a fajl az, ami megbuktatja a munkat, ha barmelyik reteg kinyilik.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync as rf } from 'node:fs'
import {
  HUMAN_SKILL_SCOPES,
  ALL_SKILL_SCOPES,
  MACHINE_SKILL_SCOPE,
  parseHumanSkillScope,
  readSkillScope,
  withSkillScope,
  seedGlobalSkill,
  sweepGlobalSkillsIntoSeed,
} from '../web/skill-scope.js'
import { skillScopeReviewRows } from '../web/system-health.js'

const ROOT = join(__dirname, '..', '..')

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'skillscope-'))
}

function writeSkill(home: string, name: string, md: string): void {
  const dir = join(home, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), md)
}

describe('skill scope: a harom ertek', () => {
  it('emberi uton CSAK personal vagy global valaszthato', () => {
    expect([...HUMAN_SKILL_SCOPES]).toEqual(['personal', 'global'])
    expect([...ALL_SKILL_SCOPES]).toContain('review')
  })

  it('a "review" GEPI ertek -- ember nem allithatja be', () => {
    expect(MACHINE_SKILL_SCOPE).toBe('review')
    expect(parseHumanSkillScope('review')).toBeNull()
    expect(parseHumanSkillScope('personal')).toBe('personal')
    expect(parseHumanSkillScope('global')).toBe('global')
  })

  it('nincs alapertelmezes: ures/hianyzo/ismeretlen ertek elutasitva', () => {
    for (const bad of [undefined, null, '', '   ', 'PERSONALIS', 'igen', 0, true, {}]) {
      expect(parseHumanSkillScope(bad)).toBeNull()
    }
  })
})

describe('readSkillScope', () => {
  it('kiolvassa a fejlecbol', () => {
    expect(readSkillScope('---\nname: x\nscope: global\n---\n\n# X\n')).toBe('global')
    expect(readSkillScope('---\nscope: review\n---\n')).toBe('review')
  })

  it('null, ha nincs sor vagy nincs fejlec -- a "nem tudom" nem dontes', () => {
    expect(readSkillScope('---\nname: x\n---\n\n# X\n')).toBeNull()
    expect(readSkillScope('# X\n')).toBeNull()
    expect(readSkillScope('')).toBeNull()
  })

  it('a torzsbeli "scope:" szoveg NEM szamit fejlecnek', () => {
    expect(readSkillScope('---\nname: x\n---\n\nscope: global\n')).toBeNull()
  })
})

describe('withSkillScope', () => {
  it('meglevo fejlecbe beszurja', () => {
    const out = withSkillScope('---\nname: x\ndescription: d\n---\n\n# X\n', 'personal')
    expect(readSkillScope(out)).toBe('personal')
    expect(out).toContain('description: d')
    expect(out).toContain('# X')
  })

  it('felulirja a korabbi erteket (review -> global)', () => {
    const out = withSkillScope('---\nname: x\nscope: review\n---\n\n# X\n', 'global')
    expect(readSkillScope(out)).toBe('global')
    expect(out.match(/^scope:/gm) || []).toHaveLength(1)
  })

  it('fejlec nelkuli fajlnak fejlecet ad, a tartalom megmarad', () => {
    const out = withSkillScope('# X\n\ntorzs\n', 'global', 'x')
    expect(readSkillScope(out)).toBe('global')
    expect(out).toContain('torzs')
  })
})

describe('seedGlobalSkill: a beegetes', () => {
  it('global -> atmegy a seed-skills ala', () => {
    const root = tmp()
    mkdirSync(join(root, 'seed-skills'), { recursive: true })
    const md = '---\nname: p\nscope: global\n---\n\n# P\n'
    const r = seedGlobalSkill('p', md, 'global', root)
    expect(r.seeded).toBe(true)
    expect(readFileSync(join(root, 'seed-skills', 'p', 'SKILL.md'), 'utf-8')).toBe(md)
    rmSync(root, { recursive: true, force: true })
  })

  it('personal SOHA nem eg be', () => {
    const root = tmp()
    mkdirSync(join(root, 'seed-skills'), { recursive: true })
    const r = seedGlobalSkill('p', '---\nscope: personal\n---\n', 'personal', root)
    expect(r).toEqual({ seeded: false, reason: 'not-global' })
    expect(existsSync(join(root, 'seed-skills', 'p'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('meglevot NEM ir felul -- es meg is mondja, miert nem', () => {
    const root = tmp()
    mkdirSync(join(root, 'seed-skills', 'p'), { recursive: true })
    writeFileSync(join(root, 'seed-skills', 'p', 'SKILL.md'), 'REGI')
    const r = seedGlobalSkill('p', '---\nscope: global\n---\nUJ\n', 'global', root)
    expect(r.seeded).toBe(false)
    expect(r.seeded === false && r.reason).toBe('already-exists')
    expect(readFileSync(join(root, 'seed-skills', 'p', 'SKILL.md'), 'utf-8')).toBe('REGI')
    rmSync(root, { recursive: true, force: true })
  })

  it('utvonal-szokes nem lehetseges', () => {
    const root = tmp()
    mkdirSync(join(root, 'seed-skills'), { recursive: true })
    const r = seedGlobalSkill('../kiszokes', '---\nscope: global\n---\n', 'global', root)
    expect(r.seeded).toBe(false)
    expect(existsSync(join(root, 'kiszokes'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('sweepGlobalSkillsIntoSeed: "menet kozben is"', () => {
  it('a kozvetlenul a mappaba irt global skillt is beegeti', () => {
    const home = tmp(); const root = tmp()
    mkdirSync(join(root, 'seed-skills'), { recursive: true })
    writeSkill(home, 'kozos', '---\nname: kozos\nscope: global\n---\n\n# K\n')
    writeSkill(home, 'sajat', '---\nname: sajat\nscope: personal\n---\n\n# S\n')
    writeSkill(home, 'eldontetlen', '---\nname: e\nscope: review\n---\n\n# E\n')
    const r = sweepGlobalSkillsIntoSeed(home, root)
    expect(r.seeded).toEqual(['kozos'])
    expect(r.scanned).toBe(3)
    expect(existsSync(join(root, 'seed-skills', 'sajat'))).toBe(false)
    expect(existsSync(join(root, 'seed-skills', 'eldontetlen'))).toBe(false)
    rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  })

  it('nevutkozesnel nem ir felul, hanem JELENTI', () => {
    const home = tmp(); const root = tmp()
    mkdirSync(join(root, 'seed-skills', 'kozos'), { recursive: true })
    writeFileSync(join(root, 'seed-skills', 'kozos', 'SKILL.md'), 'REGI')
    writeSkill(home, 'kozos', '---\nscope: global\n---\nUJ\n')
    const r = sweepGlobalSkillsIntoSeed(home, root)
    expect(r.conflicts).toEqual(['kozos'])
    expect(r.seeded).toEqual([])
    rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  })

  // A NULLA KET DOLGOT JELENTHET: friss telepitesen tenyleg nincs mit beegetni,
  // olvashatatlan mappanal viszont NEM LATUNK ODA. A ketto nem ugyanaz.
  it('friss telepites (van mappa, ures) -> scanned: 0', () => {
    const home = tmp(); const root = tmp()
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(root, 'seed-skills'), { recursive: true })
    expect(sweepGlobalSkillsIntoSeed(home, root).scanned).toBe(0)
    rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  })

  it('nincs skills-mappa (nem latunk oda) -> scanned: null, NEM 0', () => {
    const home = tmp(); const root = tmp()
    const r = sweepGlobalSkillsIntoSeed(home, root)
    expect(r.scanned).toBeNull()
    expect(r.seeded).toEqual([])
    rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// A KAPU: forras-szintu szerzodes. Ha barmelyik letrehozo utvonalrol lekerul a
// gate, ez a teszt bukik -- nem egy checklist.
// ---------------------------------------------------------------------------
describe('a kapu mind a harom letrehozo vegponton', () => {
  const routes = [
    'src/web/routes/skills.ts',
    'src/web/routes/agents-skills.ts',
    'src/web/routes/code.ts',
  ]
  for (const rel of routes) {
    it(`${rel}: scope nelkul nem hoz letre skillt`, () => {
      const s = rf(join(ROOT, rel), 'utf-8')
      expect(s).toContain('parseHumanSkillScope')
      expect(s).toContain('skill_scope_required')
      expect(s).toContain('withSkillScope')
    })
  }

  it('a gepi ut (tomorites-reflexio) bevallja, hogy nem dontott', () => {
    const s = rf(join(ROOT, 'src/web/reflect.ts'), 'utf-8')
    // UJ fajl -> `scope: review`: a gep nem tesz ugy, mintha dontott volna.
    expect(s).toContain('MACHINE_SKILL_SCOPE')
    // MEGLEVO fajl -> a hozzafuzes a fejlechez NEM nyul: sem az emberi
    // dontest nem irja at, sem uj sort nem csempesz be egy mentes melle.
    expect(s).toContain('HOZZAFUZES, NEM ATIRAS')
  })

  it('a sopres a szerver indulasakor elindul', () => {
    const s = rf(join(ROOT, 'src/web.ts'), 'utf-8')
    expect(s).toContain('startGlobalSkillSeeder()')
    expect(s).toContain('clearInterval(skillSeederInterval)')
  })

  it('a besorolatlan skillekrol az Attekintes SZOL (a csend nem valasz)', () => {
    const s = rf(join(ROOT, 'src/web/system-health.ts'), 'utf-8')
    expect(s).toContain('skillScopeReviewRows')
    expect(s).toContain('skills_scope_review')
  })

  // A ketfele "nem tudom" -- gep irta (review) es sosem volt scope sora --
  // egyformán besorolasra var. A masodikat konnyu elnezni: nincs benne semmi,
  // ami kiabalna.
  it('a HIANYZO scope-ot is eszreveszi, a besoroltakat nem zavarja', () => {
    const home = tmp()
    writeSkill(home, 'gepi', '---\nname: gepi\nscope: review\n---\n\n# G\n')
    writeSkill(home, 'regi', '---\nname: regi\ndescription: d\n---\n\n# R\n')
    writeSkill(home, 'sajat', '---\nname: sajat\nscope: personal\n---\n\n# S\n')
    writeSkill(home, 'kozos', '---\nname: kozos\nscope: global\n---\n\n# K\n')
    const root = tmp()
    mkdirSync(join(root, 'seed-skills'), { recursive: true })
    const rows = skillScopeReviewRows(home, root)
    expect(rows).toHaveLength(1)
    expect(rows[0].params?.n).toBe(2)
    expect(String(rows[0].params?.names)).toContain('gepi')
    expect(String(rows[0].params?.names)).toContain('regi')
    expect(String(rows[0].params?.names)).not.toContain('sajat')
    rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  })

  // Friss telepitesen a csend a helyes valasz -- de csak azert, mert
  // MEGNEZTUK, hogy nincs mit besorolni.
  it('friss telepitesen (nincs skills mappa) hallgat', () => {
    const home = tmp(); const root = tmp()
    expect(skillScopeReviewRows(home, root)).toEqual([])
    rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  })

  // A HARMADIK dontott allapot. Merve 2026-08-30: 59 helyi skillbol 55-nek
  // nincs scope sora, de mind a 55 MAR ott van a seed-skills alatt. Ha ezek
  // figyelmeztetest adnanak, a zaj elnyelne az egyetlen valodit.
  it('ami mar beegett a seed-skills ala, arrol nem kerdez ujra', () => {
    const home = tmp(); const root = tmp()
    mkdirSync(join(root, 'seed-skills', 'beegett'), { recursive: true })
    writeFileSync(join(root, 'seed-skills', 'beegett', 'SKILL.md'), '# B\n')
    writeSkill(home, 'beegett', '---\nname: beegett\n---\n\n# B\n')
    writeSkill(home, 'sehol', '---\nname: sehol\n---\n\n# S\n')
    const rows = skillScopeReviewRows(home, root)
    expect(rows[0].params?.n).toBe(1)
    expect(String(rows[0].params?.names)).toContain('sehol')
    rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true })
  })

  it('a felulet kotelezo, alapertelmezes NELKULI valasztot ad', () => {
    const html = rf(join(ROOT, 'web/index.html'), 'utf-8')
    expect(html).toContain('name="skillScope"')
    expect(html).toContain('value="personal"')
    expect(html).toContain('value="global"')
    // Elore bejelolt valasz = csendes alapertek, pont az, ami a bajt okozta.
    const block = html.slice(html.indexOf('name="skillScope"') - 200)
    expect(/name="skillScope"[^>]*checked/.test(block)).toBe(false)
  })
})

// A tudas is beeg: aki kezzel ir skillt, ugyanezt a lepest lassa.
describe('a szabaly a tudasban is benne van', () => {
  for (const rel of ['seed-skills/skill-factory/SKILL.md', 'seed-skills/skill-management/SKILL.md']) {
    it(`${rel}: elso lepes a besorolas`, () => {
      const s = rf(join(ROOT, rel), 'utf-8')
      expect(s).toContain('scope: personal')
      expect(s).toContain('scope: global')
      expect(s).toContain('seed-skills')
    })
  }

  // A repo CLAUDE.md-je gitignore-olt: egy friss telepitesre nem jut el, ezert
  // NEM az a szabaly otthona. A telepito kizarolag a seed-skills/ mappat
  // masolja -- amit ott kerunk szamon, azt kapja meg mindenki.
  it('a seed-skills a `scope:` sort KOTELEZOKENT mondja ki', () => {
    const s = rf(join(ROOT, 'seed-skills/skill-factory/SKILL.md'), 'utf-8')
    expect(s).toContain('KÖTELEZŐ ELSŐ LÉPÉS')
    expect(s).toContain('scope: review')
  })
})

// A BEEGETETT KESZLET EPSEGE. Ezek a fajlok azok, amiket egy friss telepites
// TENYLEG megkap -- itt kell epnek lenniuk, nem ezen a gepen.
describe('seed-skills: a beegetett keszlet', () => {
  const seedDir = join(ROOT, 'seed-skills')
  const nevek = readdirSync(seedDir).filter((n) => !n.startsWith('.')
    && existsSync(join(seedDir, n, 'SKILL.md')))

  it('van mit ellenorizni (a nulla itt "nem latok oda" lenne)', () => {
    expect(nevek.length).toBeGreaterThan(0)
  })

  it('mindegyiknek van `scope:` sora', () => {
    const hianyzik = nevek.filter((n) =>
      readSkillScope(rf(join(seedDir, n, 'SKILL.md'), 'utf-8')) === null)
    expect(hianyzik).toEqual([])
  })

  it('egyik sem szemelyes -- ami ide bekerul, azt mindenki megkapja', () => {
    const szemelyes = nevek.filter((n) =>
      readSkillScope(rf(join(seedDir, n, 'SKILL.md'), 'utf-8')) === 'personal')
    expect(szemelyes).toEqual([])
  })

  // A whatsapp-send csonk tanulsaga: egy .py-t igert, ami sehol nem volt a
  // skill mellett. Egy nem letezo fajlra mutato skill rosszabb a semminel --
  // az ugynok elindul rajta, es a hiba a felenel derul ki.
  it('nem hivatkozik nem letezo scripts/ fajlra', () => {
    const hianyzo: string[] = []
    for (const n of nevek) {
      const md = rf(join(seedDir, n, 'SKILL.md'), 'utf-8')
      for (const m of md.matchAll(/scripts\/([A-Za-z0-9_.-]+\.(?:py|sh|json|js|ts|ps1))/g)) {
        // Ket ervenyes hely van, es MINDKETTOT meg kell nezni: a skill sajat
        // mappaja (a telepito ezt masolja a skill-lel egyutt) es a repo kozos
        // scripts/ mappaja. Csak az egyiket nezni hamis riasztast ad.
        const sajat = join(seedDir, n, 'scripts', m[1])
        const kozos = join(ROOT, 'scripts', m[1])
        if (!existsSync(sajat) && !existsSync(kozos)) hianyzo.push(`${n} -> scripts/${m[1]}`)
      }
    }
    expect(hianyzo).toEqual([])
  })

  // Gepspecifikus ertek a beegetett keszletben mas gepen hazugsag.
  it('nincs benne a fejleszto gepere jellemzo ut', () => {
    const rossz: string[] = []
    for (const n of nevek) {
      const md = rf(join(seedDir, n, 'SKILL.md'), 'utf-8')
      if (/\/home\/boss\//.test(md)) rossz.push(n)
    }
    expect(rossz).toEqual([])
  })
})

// MINDEN KEPERNYORE KERULO SZOVEG KETNYELVU.
describe('i18n paritas az uj kulcsokra', () => {
  const keys = [
    'health.skills_scope_review',
    'health.skills_scope_review_action',
    'skills.modal.scope_label',
    'skills.modal.scope_hint',
    'skills.modal.scope_personal',
    'skills.modal.scope_personal_hint',
    'skills.modal.scope_global',
    'skills.modal.scope_global_hint',
    'skills.modal.scope_required',
    'skills.toast.added_seeded',
    'skills.toast.added_seed_conflict',
    'skills.scope.label',
    'skills.scope.personal_short',
    'skills.scope.global_short',
    'skills.scope.review_short',
    'skills.scope.missing_short',
    'skills.scope.set_personal',
    'skills.scope.set_global',
    'skills.scope.saved',
    'skills.scope.saved_seeded',
    'skills.scope.saved_seed_conflict',
    'skills.scope.save_failed',
  ]
  const hu = rf(join(ROOT, 'web/lang/hu.js'), 'utf-8')
  const en = rf(join(ROOT, 'web/lang/en.js'), 'utf-8')
  for (const k of keys) {
    it(`${k} mindket nyelven megvan`, () => {
      expect(hu).toContain(`'${k}'`)
      expect(en).toContain(`'${k}'`)
    })
  }
})
