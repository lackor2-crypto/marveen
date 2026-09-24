/**
 * ALAP-PROJEKTEK EGY FRISS TELEPITESEN (kanban #374).
 *
 * Boss, 2026-09-21: "projekt nelkuli kanban kartyat tilos letrehozni ... ha
 * Marvin alatt fejleszt valaki valamit, javit valamit, akkor az Marvin projekt.
 * Ha iroda alatt, akkor iroda fejlesztese. ... uj telepitesnel is ez igy
 * mukodjon." A kartya-kapu (`kanban-create.ts`) projektet kovetel -- egy friss
 * telepitesen viszont meg egy projekt sincs, tehat a ket alap-projektet itt
 * hozzuk letre: a rendszer sajat fejlesztese, es az Iroda menupontjai.
 *
 * EGYSZER fut: csak akkor, ha a projekt-tabla TELJESEN ures, es meg sosem
 * futott (jelzofajl a store-ban). Ha a user kesobb torli oket, nem jonnek
 * vissza. A slug allando (`system-dev`, `office-dev`), hogy a kod nev nelkul
 * is megtalalja oket -- a nev a marka es a telepites nyelve szerint valtozik.
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getDb } from './db.js'
import { createProject, ensureProjectTables } from './projects.js'

export const SYSTEM_DEV_SLUG = 'system-dev'
export const OFFICE_DEV_SLUG = 'office-dev'

const TEXT = {
  hu: {
    system: (brand: string) => ({
      name: `${brand} fejlesztése`,
      description: `Minden, ami a ${brand} saját menüpontjait, ágenseit, beállításait vagy működését fejleszti vagy javítja.`,
    }),
    office: () => ({
      name: 'Iroda fejlesztése',
      description: 'Minden, ami az Iroda alatti menüpontokat (Intéző, Projektek, Raktár, Drive, Fotók, ...) fejleszti vagy javítja.',
    }),
  },
  en: {
    system: (brand: string) => ({
      name: `${brand} development`,
      description: `Everything that builds or fixes ${brand}'s own menus, agents, settings or behaviour.`,
    }),
    office: () => ({
      name: 'Office development',
      description: 'Everything that builds or fixes the menus under Office (Explorer, Projects, Depot, Drive, Photos, ...).',
    }),
  },
} as const

export interface SeedResult { seeded: string[]; reason: 'seeded' | 'already_seeded' | 'has_projects' }

/**
 * A ket alap-projekt letrehozasa egy friss telepitesen. `markerDir` a store
 * mappa (tesztben ideiglenes). Soha nem dob: a hivo csak naploz.
 */
export function seedDefaultProjects(opts: { markerDir: string; brand: string; lang: string }): SeedResult {
  ensureProjectTables()
  const marker = join(opts.markerDir, '.default-projects-seeded')
  if (existsSync(marker)) return { seeded: [], reason: 'already_seeded' }
  const count = (getDb().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
  const writeMarker = (): void => {
    try { mkdirSync(opts.markerDir, { recursive: true }); writeFileSync(marker, new Date().toISOString() + '\n') } catch { /* next start retries */ }
  }
  if (count > 0) { writeMarker(); return { seeded: [], reason: 'has_projects' } }
  const t = opts.lang === 'en' ? TEXT.en : TEXT.hu
  const brand = opts.brand.trim() || 'Marveen'
  const seeded: string[] = []
  for (const [slug, text] of [[SYSTEM_DEV_SLUG, t.system(brand)], [OFFICE_DEV_SLUG, t.office()]] as const) {
    const r = createProject({ ...text, slug })
    if (r.ok) seeded.push(r.project.id)
  }
  writeMarker()
  return { seeded, reason: 'seeded' }
}
