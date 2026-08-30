// SKILL-SCOPE: minden skill fejleceben KOTELEZO megmondani, kire szol.
//
// Boss, 2026-08-30: "amikor letrehozol skilleket vagy barki letrehoz
// skilleket, akkor a skill letrehozasanak a lepesere, hogy ez most personal
// vagy nem personal. Hogy ez mindig legyen kitoltve, akkor, amikor egy uj
// skill generalodik. Es ezt egesd be a marvinba." -- majd ugyanabban a
// beszelgetesben: "ne lehessen letrehozni skillt e nelkul hogy ezt meg ne
// adnad. es ha nem szemelyes hanem altalanosan hasznlalhato barkinek, akkor
// viszont azt be kel egetni a marveenba! mindig."
//
// A MERT ESET. 2026-08-30-an az Attekintes onellenorzese negy skillt jelentett,
// ami CSAK ezen a gepen letezett: gold-technical-analysis, skill-factory,
// whatsapp-kiss-zoltan-send, whatsapp-send. Kettonek ott volt a fejleceben,
// hogy a tomorites-reflexio irta -- vagyis GEP hozta letre oket, ember nelkul,
// es senki nem dontotte el, hova valok. A skill-factory egy altalanos
// meta-skill: friss telepitesen soha nem lett volna meg, pedig barkinek jo.
//
// A HAROM ERTEK ES MIERT PONT HAROM (a nulla ket dolgot jelenthet):
//   * `personal` -- szandekosan csak ezen a gepen: konkret emberre, fiokra,
//     szamlara, maganugyre szol. Az onellenorzes helyesen HALLGAT rola.
//   * `global`   -- barkinek hasznos. Ilyenkor a letrehozas ATIRJA a repo
//     `seed-skills/` mappajaba is, mert a telepito KIZAROLAG azt masolja ki.
//     Ez a "beegetes": e nelkul a tudas ezen a gepen ragadna.
//   * `review`   -- MEG SENKI NEM DONTOTTE EL. Ezt csak gepi ut irhatja (a
//     reflexio, illetve az import, ahol nincs ott ember). Ez NEM egy csendes
//     alapertek: az Attekintes onellenorzese kiirja, hany skill var
//     besorolasra, hogy a "nem tudom" ne latsszon dontesnek.
//
// Ember altal inditott letrehozasnal a `review` NEM fogadhato el: ott ott van
// az ember, tehat dontsen. Ezt a `parseHumanSkillScope` kenyszeriti ki.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

export type SkillScope = 'personal' | 'global' | 'review'

/** Amit ember valaszthat. A `review` szandekosan nincs benne. */
export const HUMAN_SKILL_SCOPES: readonly SkillScope[] = ['personal', 'global']

/** Minden ervenyes ertek, a gepi utat is beleertve. */
export const ALL_SKILL_SCOPES: readonly SkillScope[] = ['personal', 'global', 'review']

/** A gepi ut (reflexio, import) ezt irja: "meg senki nem dontotte el". */
export const MACHINE_SKILL_SCOPE: SkillScope = 'review'

/**
 * Ember altal kuldott scope ellenorzese.
 *
 * `null`-t ad, ha hianyzik VAGY ha nem `personal`/`global` -- a hivo ilyenkor
 * KOTELEZOEN elutasitja a letrehozast. Nincs alapertelmezes: egy kitalalt
 * ertek pont azt a dontest hamisitana meg, amit ez a mezo orizni hivatott.
 */
export function parseHumanSkillScope(raw: unknown): SkillScope | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  return (HUMAN_SKILL_SCOPES as string[]).includes(v) ? (v as SkillScope) : null
}

/** Egy mar meglevo SKILL.md fejlecebol olvassa ki a scope-ot; `null` = nincs. */
export function readSkillScope(content: string): SkillScope | null {
  const m = /^\s*scope:\s*([a-z]+)\s*$/mi.exec(frontmatterOf(content))
  if (!m) return null
  const v = m[1]!.toLowerCase()
  return (ALL_SKILL_SCOPES as string[]).includes(v) ? (v as SkillScope) : null
}

/** A `---` es `---` kozotti resz; ha nincs fejlec, ures sztring. */
function frontmatterOf(content: string): string {
  if (!/^---\s*\r?\n/.test(content)) return ''
  const end = content.indexOf('\n---', 4)
  return end === -1 ? '' : content.slice(0, end)
}

/**
 * Beleirja (vagy felulirja) a `scope:` sort a fejlecben.
 *
 * Ha nincs fejlec, kepez egyet -- egy fejlec nelkuli SKILL.md-t nem hagyunk
 * scope nelkul kicsuszni, mert pont az lenne a lyuk a kapun.
 */
export function withSkillScope(md: string, scope: SkillScope, fallbackName?: string): string {
  const text = md.replace(/^﻿/, '')
  if (!/^---\s*\r?\n/.test(text)) {
    const head = ['---', ...(fallbackName ? [`name: ${fallbackName}`] : []), `scope: ${scope}`, '---', '']
    return `${head.join('\n')}\n${text.replace(/^\s+/, '')}`
  }
  const end = text.indexOf('\n---', 4)
  if (end === -1) {
    // Nyitott, de sosem zart fejlec: nem talalgatunk, elore tesszuk a sajatunkat.
    const head = ['---', ...(fallbackName ? [`name: ${fallbackName}`] : []), `scope: ${scope}`, '---', '']
    return `${head.join('\n')}\n${text}`
  }
  const fm = text.slice(0, end)
  const rest = text.slice(end)
  if (/^\s*scope:\s*.*$/mi.test(fm)) {
    return fm.replace(/^\s*scope:\s*.*$/mi, `scope: ${scope}`) + rest
  }
  return `${fm}\nscope: ${scope}${rest}`
}

/** A repo seed-skills mappaja -- EZT es csak ezt masolja ki a telepito. */
export function seedSkillsDir(projectRoot: string = PROJECT_ROOT): string {
  return join(projectRoot, 'seed-skills')
}

export type SeedResult =
  | { seeded: true; path: string }
  | { seeded: false; reason: 'not-global' | 'already-exists' | 'no-seed-dir'; path?: string }

/**
 * A "beegetes": egy `global` skill atirasa a repo seed-skills mappajaba.
 *
 * Boss, 2026-08-30: "ha nem szemelyes hanem altalanosan hasznlalhato barkinek,
 * akkor viszont azt be kel egetni a marveenba! mindig."
 *
 * Szandekosan NEM ir felul meglevot: a seed-skills a fo ag tartalma, egy
 * azonos nevu, kezzel gondozott skillt egy uj generalas nem tuntethet el.
 * Ilyenkor `already-exists` jon vissza, es a hivo ezt MEG IS MONDJA -- nem
 * hallgat rola, mert a csend ugy nezne ki, mintha megtortent volna.
 */
export function seedGlobalSkill(
  skillName: string,
  content: string,
  scope: SkillScope,
  projectRoot: string = PROJECT_ROOT,
): SeedResult {
  if (scope !== 'global') return { seeded: false, reason: 'not-global' }
  const root = seedSkillsDir(projectRoot)
  if (!existsSync(root)) return { seeded: false, reason: 'no-seed-dir' }
  const dir = join(root, skillName)
  if (!dir.startsWith(root + sep)) return { seeded: false, reason: 'no-seed-dir' }
  const file = join(dir, 'SKILL.md')
  if (existsSync(file)) return { seeded: false, reason: 'already-exists', path: file }
  mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(file, withSkillScope(content, 'global', skillName))
  return { seeded: true, path: file }
}

// ---------------------------------------------------------------------------
// MENET KOZBEN IS: a folyamatos beegeto
// ---------------------------------------------------------------------------
//
// Boss, 2026-08-30: "De menet kozben is ha egy olyan altalanos skill jon letre
// azt is mind be kell egetni!"
//
// A letrehozas pillanataban valo beegetes csak azt fogja meg, amit MARVEEN ir.
// Egy agens vagy egy kulso eszkoz kozvetlenul is tehet fajlt a
// ~/.claude/skills/ ala; ezt a sopres fogja meg. Fut induláskor es utana
// rendszeresen. Nem ir felul semmit: csak azt masolja at, ami a seed-skills-ben
// MEG NINCS.

const SEEDER_INTERVAL_MS = 15 * 60 * 1000

export type SeedSweepResult = {
  /** Amit most irtunk at a seed-skills ala. */
  seeded: string[]
  /** `global`, de a seed-skills-ben mar van ilyen nevu -- emberi dontes kell. */
  conflicts: string[]
  /**
   * `null` = NEM LATTUNK ODA (nincs skills-mappa, vagy olvashatatlan).
   * Ures tomb = megneztuk, es tenyleg nincs beegetnivalo. A ketto nem ugyanaz.
   */
  scanned: number | null
}

export function sweepGlobalSkillsIntoSeed(
  home: string,
  projectRoot: string = PROJECT_ROOT,
): SeedSweepResult {
  const out: SeedSweepResult = { seeded: [], conflicts: [], scanned: null }
  const skillsDir = join(home, '.claude', 'skills')
  if (!existsSync(skillsDir)) return out          // friss telepites: helyes a csend
  let names: string[]
  try { names = readdirSync(skillsDir) } catch { return out }
  out.scanned = 0
  for (const n of names) {
    if (n.startsWith('.')) continue
    const file = join(skillsDir, n, 'SKILL.md')
    if (!existsSync(file)) continue
    let content: string
    try { content = readFileSync(file, 'utf-8') } catch { continue }
    out.scanned++
    if (readSkillScope(content) !== 'global') continue
    const r = seedGlobalSkill(n, content, 'global', projectRoot)
    if (r.seeded) out.seeded.push(n)
    else if (r.reason === 'already-exists') out.conflicts.push(n)
  }
  return out
}

export function startGlobalSkillSeeder(
  home: string = homedir(),
  projectRoot: string = PROJECT_ROOT,
): NodeJS.Timeout {
  const tick = (): void => {
    try {
      const r = sweepGlobalSkillsIntoSeed(home, projectRoot)
      if (r.seeded.length > 0) {
        logger.info({ seeded: r.seeded }, 'skill-scope: global skillek beegetve a seed-skills ala')
      }
    } catch (err) {
      logger.warn({ err }, 'skill-scope: a beegeto sopres elhasalt')
    }
  }
  tick()
  return setInterval(tick, SEEDER_INTERVAL_MS).unref()
}
