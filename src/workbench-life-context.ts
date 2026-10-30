// "Move to the Life tree": WHERE a document belongs, read from where it lives (Boss TG 4059, 4065: 3B).
// The inbox sorter guesses from a file's own words, which put a letter to the social office about Bakos Eva under
// "Korpas Laszlo / Personal" (the letter happens to name him). The work item itself knows more: the folder it sits in
// ("Szochivatal Bakos Eva"), its title, who it is addressed to. This reads those, in this order of trust:
//   1. the person: a Life-tree person named in the item's folder path, then in its title;
//   2. the area: an authority/office word -> "Authorities", and the country / office folders that really exist;
//   3. when more than one office fits, the likeliest is still pre-filled but flagged as uncertain (shown in red).
// Only an EXISTING folder is ever returned (nothing is created here).

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectRow } from './projects.js'
import type { WorkItemRow } from './workbench.js'
import { humanLocation, resolveLifePath } from './life-explorer.js'
import { lifeName, loadLifeConfig, personRel } from './life-tree.js'
import { caseFoldersIn, casePlaceFor, classifyCaseKind } from './workbench-life-case.js'

export interface ContextTarget {
  target: string
  display: string
  /** false = more than one place fits (or the person was found in the title only): pre-filled, but shown in red. */
  confident: boolean
  /** Why this place, in the owner's words (HU/EN by `lang`). */
  why: string
}

/** Lower case, no accents, everything that is not a letter or digit becomes one space. */
export function flat(s: string): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

const AUTHORITY_WORDS = ['hivatal', 'szochivatal', 'amt', 'sozial', 'jobcenter', 'behorde', 'antrag', 'wohngeld', 'hatosag', 'aok', 'versicherung', 'finanzamt', 'sgb', 'pflegegeld', 'rentenversicherung', 'kasse']
const COUNTRY_WORDS: Array<{ words: string[]; folder: string[] }> = [
  { words: ['nemet', 'nemetorszag', 'german', 'deutsch', 'antrag', 'sozialamt', 'jobcenter', 'wohngeld', 'behorde', 'chemnitz', 'pflegegeld', 'sgb'], folder: ['nemetorszag', 'deutschland', 'germany'] },
  { words: ['magyar', 'magyarorszag', 'hungar', 'nav', 'onkormanyzat', 'kormanyhivatal'], folder: ['magyarorszag', 'hungary', 'ungarn'] },
]
/** Words that tell which office folder is meant, even when the folder is named differently ("Sozialamt" = "Szocialis hivatal"). */
const OFFICE_ALIASES: Array<{ words: string[]; folders: string[] }> = [
  { words: ['sozialamt', 'sozial', 'sgb xii', 'szocialis', 'szochivatal', 'pflegegeld', 'sozialhilfe'], folders: ['sozialamt', 'szocialis hivatal', 'szocialis'] },
  { words: ['wohngeld'], folders: ['wohngeldbehorde', 'wohngeld'] },
  { words: ['jobcenter'], folders: ['jobcenter'] },
  { words: ['aok'], folders: ['aok'] },
  { words: ['rentenversicherung', 'rente'], folders: ['rentenversicherung'] },
]

function subDirs(abs: string): string[] {
  try { return readdirSync(abs).filter((n) => { try { return statSync(join(abs, n)).isDirectory() } catch { return false } }) } catch { return [] }
}

/**
 * The likeliest Life-tree folder for a document, or null when its folder / title name nobody and nothing
 * (then the caller falls back to the content-based guess). `pathText` = the item's folder path; `name` = a file name.
 */
/** `text` = the words read from the file itself (docx / pdf / OCR): the content settles which office and which case folder. */
export interface ContextOpts { outgoing?: boolean; text?: string }

export function contextTarget(project: ProjectRow, item: Pick<WorkItemRow, 'title'> & Partial<Pick<WorkItemRow, 'folder' | 'container_folder'>>, name: string, lang: string, optsIn: boolean | ContextOpts = false): ContextTarget | null {
  const opts: ContextOpts = typeof optsIn === 'boolean' ? { outgoing: optsIn } : optsIn
  const outgoing = !!opts.outgoing
  const contentText = flat(String(opts.text || '').slice(0, 6000))
  let config
  try { config = loadLifeConfig() } catch { return null }
  if (!config.persons.length) return null
  const pathText = flat(`${item.folder ?? ''} ${item.container_folder ?? ''}`)
  const titleText = flat(`${item.title ?? ''} ${name}`)
  const projectText = flat(project.name || '')
  const everything = `${pathText} ${titleText} ${projectText} ${contentText}`

  // 1. The person: the folder path first (it was named for the case), then the title.
  const personsIn = (text: string) => config.persons.filter((p) => { const f = flat(p.name); return f.length > 3 && (` ${text} `).includes(` ${f} `) })
  let fromPath = personsIn(pathText)
  let fromTitle = personsIn(titleText)
  const person = fromPath[0] || fromTitle[0]
  if (!person) return null
  let confident = new Set([...fromPath, ...fromTitle].map((p) => p.id)).size === 1

  // 2. The area: only when an authority word is there. Anything else is the content-based guess's business.
  const authority = AUTHORITY_WORDS.some((w) => everything.split(' ').some((tok) => tok === w || tok.startsWith(w) || tok.endsWith(w) && w.length > 3))
  if (!authority) return null
  const personDir = personRel(config, person.name)
  const authRel = `${personDir}/${lifeName('authorities', lang)}`
  const authAbs = resolveLifePath(authRel)
  if (!authAbs || !existsSync(authAbs)) return null
  let rel = authRel
  let how = lang === 'en' ? 'the person is in the folder name' : 'a mappa nevében szerepel a személy'
  if (!fromPath[0]) how = lang === 'en' ? 'the person is in the title' : 'a címben szerepel a személy'

  // Country folder: the one that really exists and whose words are in the text; the only one when there is just one.
  const countries = subDirs(authAbs)
  let country = ''
  if (countries.length === 1) country = countries[0]
  else {
    const toks = new Set(everything.split(' '))
    const hit = COUNTRY_WORDS.find((c) => c.words.some((w) => toks.has(w) || [...toks].some((t) => t.startsWith(w))))
    if (hit) country = countries.find((n) => hit.folder.includes(flat(n))) || ''
  }
  if (country) {
    rel = `${authRel}/${country}`
    // Office folder: weigh each by where its words appear (title/file name 3, folder path 1).
    const officeAbs = resolveLifePath(rel)
    const offices = officeAbs ? subDirs(officeAbs) : []
    const scores = offices.map((o) => {
      const of = flat(o)
      let s = 0
      if (of && (` ${titleText} `).includes(` ${of} `)) s += 3
      else if (of && (` ${pathText} ${projectText} `).includes(` ${of} `)) s += 1
      if (of && contentText && (` ${contentText} `).includes(` ${of} `)) s += 2
      for (const al of OFFICE_ALIASES) {
        if (!al.folders.includes(of)) continue
        for (const w of al.words) {
          if ((` ${titleText} `).includes(` ${w} `) || titleText.includes(w)) s += 3
          else if (pathText.includes(w) || projectText.includes(w)) s += 1
          if (contentText.includes(w)) s += 2
        }
      }
      return { o, s }
    }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)
    if (scores.length) {
      rel = `${rel}/${scores[0].o}`
      if (scores.length > 1 && scores[1].s >= scores[0].s - 1) confident = false
      how += lang === 'en' ? `; the office "${scores[0].o}" fits best` + (scores.length > 1 ? ` (also: ${scores.slice(1, 3).map((x) => x.o).join(', ')})` : '') : `; a(z) „${scores[0].o}" illik legjobban` + (scores.length > 1 ? ` (még szóba jön: ${scores.slice(1, 3).map((x) => x.o).join(', ')})` : '')
      // #794 (Boss TG 3594, 3612, 3638): a case holds Kérelem / Bejövő levelek / Kimenő levelek / Egyéb; a file goes into the
      // one that fits what the document IS (never a new folder per letter), when exactly one case folder of the office exists.
      const officeRel = rel
      const cases = caseFoldersIn(officeRel)
      if (cases.length === 1) {
        const caseRel = `${officeRel}/${cases[0]}`
        const kind = classifyCaseKind(name, opts.text || '', outgoing)
        const place = casePlaceFor(caseRel, kind)
        rel = place || caseRel
        how += lang === 'en' ? `; the case folder "${cases[0]}", ${place ? 'its folder for this kind of document' : 'the file is not a letter or the request'}` : `; az ügy mappája: „${cases[0]}”, ${place ? 'azon belül ennek a dokumentumfajtának a mappája' : 'maga az ügymappa'}`
      }
    } else confident = false
  } else confident = false
  return { target: rel, display: humanLocation(rel), confident, why: how }
}
