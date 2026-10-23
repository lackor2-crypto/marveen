// #766 (Boss, TG 10228): "nem figyelte senki, és ezek kimaradtak". A videó-fejlesztés úgy landolt, hogy a
// Cloudinary- és a Buffer-kulcs nincs a kulcsos szolgáltatások listájában (KEY_SERVICE_CATALOG), tehát a Fiókok oldal,
// az önellenőrzés és a varázsló nem tud róla. A szabály szövegben már megvolt (bake-in-wizard-selfcheck skill);
// ez a kapu gépileg kikényszeríti: minden Vault-azonosító, amit a kód nevesít, vagy szerepel a katalógusban, vagy
// INDOKOLT kivételként fel van sorolva ITT. Új kulcs kivételként való felvétele szándékos, látható döntés.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { KEY_SERVICE_CATALOG } from '../web/key-service-dependents.js'

const SRC = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Vault-azonosítók, amiket a kód név szerint kimond: `<NÉV>_VAULT_ID|KEY = '...'` és `getSecret('...')`. */
export function vaultIdsInCode(): Map<string, string> {
  const found = new Map<string, string>()
  const reConst = /\b(?:[A-Z][A-Z0-9_]*_)?VAULT_(?:ID|KEY)\s*=\s*'([^']+)'/g
  const reCall = /\bgetSecret\(\s*'([^']+)'/g
  for (const f of walk(SRC)) {
    const text = readFileSync(f, 'utf8')
    for (const re of [reConst, reCall]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) if (!found.has(m[1])) found.set(m[1], f.slice(SRC.length + 1))
    }
  }
  return found
}

/**
 * Szándékos kivételek: ezeknek NEM a kulcsos szolgáltatások listája a helye, vagy a hiányuk ismert és kártyán van.
 * Minden sorhoz INDOK kell. A "ismert hiány" sorok a javítással törlendők (a teszt a törlést ki is kényszeríti:
 * lásd a második tesztet, ami elbukik, ha egy kivétel már a katalógusban van).
 */
export const VAULT_EXEMPT: Record<string, string> = {
  'openrouter-management-key': 'a fiók-kezelő (admin) kulcs, nem szolgáltatás-kulcs; a Fiókok oldal kezeli külön',
  'openrouter-account-email': 'nem titok, a fiók e-mail-címe, az OpenRouter-sor része',
  'CONNECTORS_HU_TOKEN': 'a connectors-hu külön folyamata kezeli (docs/connectors-hu.md)',
  'buffer-api-key': 'ISMERT HIÁNY (#765): a Buffer-hozzáférésnek a katalógusba, az önellenőrzésbe és a varázslóba kell kerülnie; a #765 törli ezt a sort',
  'cloudinary-url': 'ISMERT HIÁNY (#765): a videó-tárhely kulcsának a katalógusba, az önellenőrzésbe és a varázslóba kell kerülnie; a #765 törli ezt a sort',
}

describe('minden kódban nevesített Vault-azonosítónak helye van a kulcsos szolgáltatások listájában', () => {
  const catalog = new Set(KEY_SERVICE_CATALOG.map((s) => s.vaultId))

  it('nincs olyan Vault-azonosító, ami se a katalógusban, se az indokolt kivételek között nincs', () => {
    const missing = [...vaultIdsInCode()].filter(([id]) => !catalog.has(id) && !(id in VAULT_EXEMPT))
    expect(
      missing.map(([id, file]) => `${id} (${file})`),
      'Új Vault-azonosító: vegyed fel a KEY_SERVICE_CATALOG-ba (src/web/key-service-dependents.ts), és csináld meg hozzá az '
      + 'önellenőrzés-sort és a varázsló-lépést (skill: bake-in-wizard-selfcheck). Ha tényleg nem oda való, a VAULT_EXEMPT-be, indokkal.',
    ).toEqual([])
  })

  it('a kivétel-lista nem rohad: ami már a katalógusban van vagy a kódból eltűnt, azt ki kell venni', () => {
    const inCode = vaultIdsInCode()
    const stale = Object.keys(VAULT_EXEMPT).filter((id) => catalog.has(id) || !inCode.has(id))
    expect(stale, 'Törölni való kivétel-sorok a VAULT_EXEMPT-ből').toEqual([])
  })
})
