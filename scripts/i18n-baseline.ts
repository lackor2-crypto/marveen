/**
 * A KEMENYEN KODOLT MAGYAR SZOVEGEK BAZISANAK UJRAIRASA.
 *
 *   npm run i18n:baseline
 *
 * A `i18n-no-hardcoded-hu.test.ts` ehhez a fajlhoz meri a feluletet: ami MAR
 * benne van, az ismert adossag; ami UJ, az bukas. A bazist tehat CSAK akkor
 * irjuk ujra, ha SZOVEGET FORDITOTTUNK -- azaz a lista rovidult.
 *
 * A szkript ezt ki is kenyszeriti: ha a lista NONE, kilep hibaval. Egy uj
 * magyar mondat nem „legalizalhato" egyetlen paranccsal; azt le kell forditani.
 * (Ha valami mast tenyleg fel kell venni -- pl. lemezen levo mappanev --, azt
 * a `--allow-growth` kapcsoloval lehet, hogy latszodjon a git-tortenetben.)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanHtml, scanJs, fingerprint } from '../src/__tests__/helpers/i18n-scan.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const BASELINE_PATH = join(ROOT, 'src', '__tests__', 'fixtures', 'i18n-baseline.json')

/** Amit merunk. A `lang/` szandekosan kimarad: ott a magyar a HELYE. */
export const WATCHED = [
  { file: 'web/index.html', kind: 'html' as const },
  { file: 'web/app.js', kind: 'js' as const },
]

export function collect(root = ROOT): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const w of WATCHED) {
    const hits = w.kind === 'html' ? scanHtml(join(root, w.file)) : scanJs(join(root, w.file))
    // Egyedi ujlenyomatok, rendezve: igy a git-diff olvashato marad.
    out[w.file] = [...new Set(hits.map(fingerprint))].sort()
  }
  return out
}

function main() {
  const allowGrowth = process.argv.includes('--allow-growth')
  const fresh = collect()
  const old: Record<string, string[]> = existsSync(BASELINE_PATH)
    ? JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
    : {}

  let grew = false
  for (const [file, list] of Object.entries(fresh)) {
    const before = (old[file] || []).length
    const delta = list.length - before
    const jel = delta === 0 ? '=' : delta < 0 ? '↓' : '↑'
    console.log(`${jel} ${file}: ${before} → ${list.length}`)
    if (delta > 0) {
      grew = true
      for (const s of list.filter((x) => !(old[file] || []).includes(x))) console.log(`    + ${s}`)
    }
  }

  if (grew && !allowGrowth) {
    console.error('\nA lista NOTT. Uj magyar szoveg nem irhato a bazisba -- forditsd le.')
    console.error('Ha tenyleg fel kell venni (pl. lemezen levo mappanev): --allow-growth')
    process.exit(1)
  }

  writeFileSync(BASELINE_PATH, JSON.stringify(fresh, null, 2) + '\n', 'utf-8')
  console.log(`\nMentve: ${BASELINE_PATH}`)
}

if (process.argv[1] && process.argv[1].includes('i18n-baseline')) main()
