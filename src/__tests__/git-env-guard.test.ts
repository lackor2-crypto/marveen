/**
 * ★ A GIT_DIR-SZOKES KENYSZERITO ORE.
 *
 * AMI TORTENT (2026-09-03, merve -- nem rekonstrualva)
 *   A `pre-push` kapu a TELJES teszt-suite-ot a git sajat hookjabol inditja. A
 *   git minden hook-folyamatba EXPORTALJA a `GIT_DIR`-t, az pedig felulirja
 *   MIND a `cwd`-t, MIND a `git -C <ut>`-ot. Igy minden teszt, amelyik git-et
 *   inditott, az ELO repoba irt: 11:23:23 es 11:23:41 kozott negy commit
 *   landolt a `main`-en, es egy 1193 fajlos fat egyetlen `a.txt`-re cserelt.
 *
 * AMIT ORIZ
 *   Minden fajl a `src/` alatt, amelyik KOZVETLENUL indit git-et. Ket dolgot
 *   kovetel meg tole:
 *     1. hivatkozzon a `cleanGitEnv`-re (vagy a `gitEnvFor`-ra, ami rajta ul),
 *     2. ne teritse be a `...process.env`-t egy git-hivas kornyezetebe --
 *        pontosan azon a soron szokik at az orokolt GIT_DIR.
 *
 * MIERT NEM ELEG A `git-env-escape.test.ts`
 *   Az BIZONYITJA, hogy a `cleanGitEnv` mukodik: valodi repokon meri, hogy
 *   vedelem nelkul tenyleg atszokik a hivas, vedelemmel pedig nem. Arrol
 *   viszont semmit nem mond, hogy a fa OSSZES git-hivasa hasznalja-e. Egyetlen
 *   uj `execFile('git', ...)` -- `env` nelkul -- visszanyitja a lyukat, es
 *   minden teszt zold marad kozben. Ez a ket teszt egyutt fedi le a kerdest:
 *   az egyik a MECHANIZMUST, ez a LEFEDETTSEGET.
 *
 * AMIT NEM LAT (szandekosan kimondva)
 *   Csak a KOZVETLEN git-inditast latja. Ha egy fajl shell-szkriptet indit, es
 *   a SZKRIPT hiv git-et, az ide nem latszik -- ott kezzel kell tisztitani. A
 *   `src/web/upstream-measure-runner.ts` pont ilyen (bash-t indit, ami git-tel
 *   dolgozik); ott a `cleanGitEnv()` a `spawn` env-jeben all.
 *
 * HA EZ A TESZT ELBUKIK, A TEENDO
 *   Ne a listat bovitsd: add at a git-hivasnak a `cleanGitEnv()`-et
 *   (`env: cleanGitEnv()`, vagy `{ ...cleanGitEnv(), SAJAT_VALTOZO: '...' }`).
 *   Ha egy sornak tenyleg a teljes `process.env` kell (mert NEM git indul ott,
 *   csak ugyanabban a fajlban all), ird a sor vegere a `// git-env-ok:` jelolot
 *   es MELLE AZ INDOKOT. Megjegyzes-sorokat az or nem szamol kodnak.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..')

/** Maga a vedelem forrasa -- rola nem kerheto szamon, hogy hasznalja magat. */
const KIVETEL = ['git-env.ts']

/** `execFile('git'`, `spawnSync("git"`, `execFileSync(GIT,` -- a kozvetlen inditas. */
const GIT_INDITAS = /\b(execFile|execFileSync|exec|execSync|spawn|spawnSync)\(\s*(['"`]git['"`]|GIT\s*[,)])/

/** A teljes kornyezet beteritese. A sorvegi jelolo tudatos kivetelt jelent. */
const TELJES_ENV = /\.\.\.process\.env/
const JELOLO = /\/\/\s*git-env-ok/

/** Megjegyzes-sor. Enelkul a sajat doc-blokkunk bukna meg a sajat szabalyan --
 *  ezt nem kitalaltuk, hanem az ort romlott bemeneten probalva jott elo. */
const MEGJEGYZES = /^\s*(\/\/|\*|\/\*)/

function tsFajlok(dir: string): string[] {
  const ki: string[] = []
  for (const nev of readdirSync(dir)) {
    const ut = join(dir, nev)
    if (statSync(ut).isDirectory()) ki.push(...tsFajlok(ut))
    else if (nev.endsWith('.ts') && !KIVETEL.includes(nev)) ki.push(ut)
  }
  return ki
}

/** A git-et indito fajlok, a tartalmukkal egyutt. */
function gitesFajlok(): Array<{ ut: string; szoveg: string }> {
  return tsFajlok(SRC)
    .map(ut => ({ ut: relative(SRC, ut), szoveg: readFileSync(ut, 'utf-8') }))
    .filter(f => GIT_INDITAS.test(f.szoveg))
}

describe('GIT_DIR-szokes: a fa minden git-hivasa tisztitott kornyezetet kap', () => {
  // A NULLA KET DOLGOT JELENTHET. Ha a bejaras semmit nem talal, az itt nem
  // "minden rendben", hanem "nem lattam oda" -- akkor a ket allitas alatta
  // uresen, tehat hamis biztonsagerzettel menne at.
  it('a bejaras egyaltalan talal git-et indito fajlokat', () => {
    const fajlok = gitesFajlok()
    expect(fajlok.length, 'nulla talalat: a bejaras nem latott a src/ ala').toBeGreaterThan(5)
  })

  it('mindegyik hivatkozik a cleanGitEnv-re (vagy a ra epulo gitEnvFor-ra)', () => {
    const vetkesek = gitesFajlok()
      .filter(f => !/cleanGitEnv|gitEnvFor/.test(f.szoveg))
      .map(f => f.ut)
    expect(vetkesek, `git-et indit, de nem tisztit: ${vetkesek.join(', ')}`).toEqual([])
  })

  it('egyik sem teriti be a teljes process.env-et git-hivasba', () => {
    const vetkesek: string[] = []
    for (const f of gitesFajlok()) {
      f.szoveg.split('\n').forEach((sor, i) => {
        if (MEGJEGYZES.test(sor) || JELOLO.test(sor)) return
        if (TELJES_ENV.test(sor)) vetkesek.push(`${f.ut}:${i + 1}`)
      })
    }
    expect(vetkesek, `orokolt GIT_DIR szokhet at itt: ${vetkesek.join(', ')}`).toEqual([])
  })
})
