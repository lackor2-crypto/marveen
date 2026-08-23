// A `t()` a felulet EGYETLEN forditó fuggvenye. Ha egy fuggveny-hataron belul
// valaki `t` neven mast tarol -- tipikusan `const t = e.target` egy
// esemenykezeloben --, akkor az azon a hataron BELUL leirt `t('kulcs')` mar nem
// forditas, hanem egy DOM-elem meghivasa: `TypeError: t is not a function`.
//
// Ez NEM elmeleti. 2026-08-23-an a kod-hid ablakanak kattintas-kezeloje
// (`document.addEventListener('click', async function (e) { const t = e.target`)
// hat helyen hivta a `t()`-t. Kovetkezmeny: a "Letrehozas" gomb NEM hozott letre
// skillt es NEM irt ki hibat sem (a kezelo a status-szoveg beallitasakor
// eldobta a hibat), a hid "Leallitas" gombja pedig egyaltalan nem csinalt
// semmit. A teljes teszt-suite (6155 teszt) kozben VEGIG zold volt: a
// lang-paritas es a kemenykodolt-magyar mero a KULCSOKAT nezi, azt nem, hogy a
// `t` fut-e egyaltalan. Ezert kell ez a kulon mero.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FILES = ['web/app.js', 'web/index.html']

/** Deklaralja-e ez a sor `t` neven valamit (`const t =`, `let t =`, `var t =`,
 *  `function (t)`, `(t) =>`)? Csak az ertekadast nezzuk: a parameter-lista
 *  eseteket kulon mintaval fogjuk. */
const DECL = /(?:^|[^\w.$])(?:const|let|var)\s+t\s*=/
const PARAM = /(?:function\s*\(|\()\s*(?:[\w$]+\s*,\s*)*t\s*(?:,|\))/
/** `t(` hivas, ami NEM `.t(` es nem `$t(` -- vagyis a globalis fordito. */
const CALL = /(?<![\w.$])t\(/

/**
 * Az `at` sorban kezdodo blokk vege (a nyito kapcsos zarojel parja).
 * Ha nincs nyito zarojel a sorban, maga a sor a "blokk".
 */
function blockEnd(lines: string[], at: number): number {
  let depth = 0
  let seen = false
  for (let i = at; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true }
      else if (ch === '}') depth--
    }
    if (seen && depth <= 0) return i
  }
  return lines.length - 1
}

describe('a t() forditot semmi nem arnyekolhatja le', () => {
  for (const rel of FILES) {
    it(`${rel}: nincs olyan hatar, ahol a t mas, es kozben t()-t hivunk`, () => {
      const lines = readFileSync(join(__dirname, '..', '..', rel), 'utf-8').split('\n')
      const bad: string[] = []
      for (let i = 0; i < lines.length; i++) {
        if (!DECL.test(lines[i]) && !PARAM.test(lines[i])) continue
        const end = blockEnd(lines, i)
        for (let j = i; j <= end; j++) {
          if (CALL.test(lines[j])) {
            bad.push(
              `${rel}:${i + 1} itt a "t" mar nem a fordito (${lines[i].trim().slice(0, 70)}),\n` +
              `    de ${rel}:${j + 1} megis t()-t hiv: ${lines[j].trim().slice(0, 70)}\n` +
              '    -> nevezd at a valtozot (pl. tgt), NE a t() hivast.',
            )
            break
          }
        }
      }
      expect(bad.join('\n'), 'a t() lefedve egy azonos nevu valtozoval').toBe('')
    })
  }
})
