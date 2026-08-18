// Atkoltoztetes a depoba.
//
// A szabaly, amitol ez nem tud kart tenni: MASOLUNK, ELLENORZUNK, es csak
// AZUTAN torlunk. Egyetlen fajlra nezve is igy megy, nem a vegen egyszerre --
// tehat egy aramszunet a folyamat kozepen legfeljebb annyit jelent, hogy a
// kepek egy resze mar a depoban van, a tobbi meg a regi helyen. Egyik allapot
// sem vesztes: a Marveen mindket helyrol olvas (lasd `photoFilePath`).
//
// Az ellenorzes SHA-256, nem meret. Egy megszakadt masolas eppen ugy vegzodhet
// azonos merettel (a fajlrendszer elore lefoglalhatja a helyet), es a
// "megvan, jo meretu, de mas a tartalma" a legrosszabb fajta hiba: eszrevetlen.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'

export interface MigrateResult {
  /** Hany fajl kerult at. */
  moved: number
  /** Hany volt mar amugy is a helyen (ugyanaz a lenyomat). */
  alreadyThere: number
  /** Hany nem sikerult. Ezek a REGI helyukon maradnak, erintetlenul. */
  failed: number
  /** Osszesen ennyi bajt kerult at. */
  bytes: number
  /** Az elso nehany hiba, emberi alakban -- hogy a felulet meg tudja mondani, mi tortent. */
  errors: string[]
}

/** Egy fajl lenyomata, darabokban (egy 1,8 GB-os video nem fer a memoriaba). */
export function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(file)
    s.on('error', reject)
    s.on('data', (c) => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * Egy fajl atvitele: masolas -> lenyomat-ellenorzes -> a regi torlese.
 *
 * A masolat eloszor `.part` neven keszul, es csak a SIKERES ellenorzes utan
 * kapja meg a vegleges nevet. Igy a celmappaban sosem all egy felkesz fajl a
 * vegleges neven -- amit a Marveen kesz kepnek nezne.
 */
export async function moveVerified(from: string, to: string): Promise<'moved' | 'already' | 'failed'> {
  const srcHash = await sha256Of(from)
  if (existsSync(to)) {
    // Mar ott van valami ezen a neven. Ha ugyanaz a tartalom, keszen vagyunk --
    // a regi peldany mehet. Ha MAS, hozza sem nyulunk: inkabb maradjon ket
    // fajl, mint hogy felulirjunk valamit, amit nem mi tettunk oda.
    try {
      if ((await sha256Of(to)) === srcHash) { rmSync(from, { force: true }); return 'already' }
    } catch { /* olvashatatlan celfajl: alabb ujraprobaljuk */ }
    return 'failed'
  }
  const tmp = `${to}.part`
  try {
    mkdirSync(dirname(to), { recursive: true })
    await pipeline(createReadStream(from), createWriteStream(tmp))
    if ((await sha256Of(tmp)) !== srcHash) {
      rmSync(tmp, { force: true })
      return 'failed'
    }
    renameSync(tmp, to)
    rmSync(from, { force: true })
    return 'moved'
  } catch {
    try { rmSync(tmp, { force: true }) } catch { /* nem is keszult el */ }
    return 'failed'
  }
}

/**
 * Egy mappa tartalmanak atkoltoztetese.
 *
 * A rejtett (ponttal kezdodo) bejegyzesek kimaradnak: a `.thumbs` bolyegkepek
 * ujra elkeszulnek a celhelyen -- masodpercek --, egy felbeszakadt `.part`
 * darabot pedig kifejezetten NEM akarunk atvinni.
 */
export async function migrateDir(from: string, to: string): Promise<MigrateResult> {
  const r: MigrateResult = { moved: 0, alreadyThere: 0, failed: 0, bytes: 0, errors: [] }
  if (!existsSync(from)) return r
  let names: string[] = []
  try { names = readdirSync(from) } catch { return r }
  mkdirSync(to, { recursive: true })
  for (const name of names) {
    if (name.startsWith('.')) continue
    const src = join(from, name)
    let size = 0
    try {
      const st = statSync(src)
      if (!st.isFile()) continue
      size = st.size
    } catch { continue }
    let outcome: 'moved' | 'already' | 'failed'
    try {
      outcome = await moveVerified(src, join(to, name))
    } catch (err: any) {
      outcome = 'failed'
      if (r.errors.length < 5) r.errors.push(`${name}: ${String(err?.message || err).slice(0, 120)}`)
    }
    if (outcome === 'moved') { r.moved++; r.bytes += size }
    else if (outcome === 'already') r.alreadyThere++
    else {
      r.failed++
      if (r.errors.length < 5) r.errors.push(`${name}: nem sikerült átvinni, a régi helyén maradt`)
    }
  }
  return r
}
