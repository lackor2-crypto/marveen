/**
 * EGY SZOLGÁLTATÁS, TÖBB KULCS -- a "férőhelyek" (slotok) modellje.
 *
 * Boss, 2026-09-02: "akár felvihetne később egy legújabb GLM előfizetést is.
 * másodikat. nem? tehát akkor miért tűnne el onnan a listából?"
 *
 * Igaza volt, és a válasz nem csak a felületen volt rossz. A trezor egyetlen
 * NEVET ismert szolgáltatásonként (`zai-coding-key`), és az egész flotta azt
 * az egy nevet olvasta -- egy második GLM-előfizetés kulcsa tehát nem MELLÉ
 * került volna, hanem FELÜLÍRTA volna az elsőt. A lehetőség azért tűnt el a
 * listáról, mert tényleg nem volt hova tenni a másodikat.
 *
 * A FÉRŐHELY. Egy szolgáltatáshoz mostantól több trezor-kártya tartozhat:
 *   - `zai-coding-key`      -- az alap-hely (ez volt eddig is, változatlanul)
 *   - `zai-coding-key.2`    -- a második előfizetés
 *   - `zai-coding-key.3`    -- a harmadik, és így tovább
 * Ezen felül továbbra is felel a szolgáltatásért bármelyik kártya MEZŐJE,
 * amelyik az alap-névre van kötve (`bindingId`) -- így áll ma egy kártyán a
 * három openrouter-* kulcs, és ez a rész nem változik.
 *
 * MIÉRT PONT PONT A SZÉTVÁLASZTÓ. A trezor-azonosító URL-útvonalba kerül
 * (`/api/vault/<id>`), ezért a `#` kockázatos lenne: kódolatlanul levágná a
 * kérés végét. A pont minden útvonalban önmagát jelenti, és nem igényel
 * kódolást.
 *
 * A NULLA KÉT DOLGOT JELENTHET. A `listSecrets()` olvashatatlan trezornál
 * ÜRES listát ad -- ami pontosan úgy néz ki, mint egy friss telepítés. Ezért
 * itt sose a találatok számából következtetünk: külön megkérdezzük magát a
 * fájlt (`vaultFileState()`), és romlott trezornál `count: null` megy ki, nem
 * nulla. Friss telepítésen a 0 a helyes, csendes válasz.
 */
import { listSecrets, vaultFileState } from './vault.js'
import { activeSlotFor } from './key-service-active.js'

/** Az alap-név és a sorszám közötti jel. Lásd a fenti indoklást. */
export const SLOT_SEP = '.'

/** `number` = megmérve. `null` = a trezort magát nem tudtam elolvasni. */
export type MaybeCount = number | null

export interface KeyServiceSlot {
  /** A trezor-bejegyzés azonosítója -- ezzel lehet megnyitni és szerkeszteni. */
  slotId: string
  /** Emberi név: a kártya címkéje. */
  label: string
  /** Van-e benne tényleg érték. Üres kártya = a hely megvan, a kulcs nincs. */
  hasValue: boolean
  updatedAt: string
  /**
   * Ha ez egy MÁSIK kártya mezője, ami az alap-névre van kötve, akkor annak a
   * kártyának a címkéje. A felület ezt kiírja, különben a sor egy olyan névre
   * mutatna, amit a trezorban hiába keresne a felhasználó.
   */
  boundOn?: string
}

export interface KeyServiceView {
  serviceId: string
  slots: KeyServiceSlot[]
  /** Hány helyen van tényleg kulcs. `null` = nem láttam a trezorba. */
  count: MaybeCount
  /** A választott hely, vagy `null`, ha soha nem választottak. */
  activeSlotId: string | null
  /**
   * true = választottak, de az a hely már nincs meg (törölték a kártyát).
   * Ilyenkor a flotta az alap-helyre esik vissza -- ez néma hiba lenne, ezért
   * a felület és az önellenőrzés is KIMONDJA.
   */
  activeMissing: boolean
}

/** `zai-coding-key.2` -> `zai-coding-key`. Ami nem férőhely, az önmaga. */
export function baseServiceId(vaultId: string): string {
  const i = vaultId.indexOf(SLOT_SEP)
  return i < 0 ? vaultId : vaultId.slice(0, i)
}

/** Ez a trezor-azonosító ennek a szolgáltatásnak a férőhelye-e. */
export function isSlotOf(vaultId: string, serviceId: string): boolean {
  if (vaultId === serviceId) return true
  if (!vaultId.startsWith(serviceId + SLOT_SEP)) return false
  // Csak sorszám jöhet a pont után: a `zai-coding-key.regi` nem férőhely,
  // hanem egy másik kártya, amit a felhasználó nevezett el így.
  return /^[0-9]+$/.test(vaultId.slice(serviceId.length + SLOT_SEP.length))
}

/**
 * A következő szabad férőhely azonosítója.
 *
 * Nem a darabszámból számol: a foglalt neveket nézi végig. Ha a 2-est
 * törölték, a következő új kulcs újra 2-es lesz -- a lyukak feltöltése
 * pontosan az, amit egy férőhely-listától vár az ember.
 */
export function nextSlotId(serviceId: string, taken: Iterable<string>): string {
  const used = new Set<string>()
  for (const id of taken) used.add(id)
  if (!used.has(serviceId)) return serviceId
  for (let n = 2; n < 1000; n++) {
    const candidate = serviceId + SLOT_SEP + n
    if (!used.has(candidate)) return candidate
  }
  // Ezer férőhely fölött már nem a névadás a probléma; ne fagyjunk le rajta.
  return serviceId + SLOT_SEP + Date.now()
}

interface SecretRow {
  id: string
  label: string
  updatedAt: string
  fields?: Array<{ bindingId?: string; hasValue?: boolean; label?: string }>
}

/**
 * Egy szolgáltatás teljes képe: hol laknak a kulcsai, melyik az aktív.
 *
 * A `secrets` paraméter a tesztek miatt injektálható; élesben a trezor
 * listája. Értéket SEHOL nem ad vissza -- a titkok a trezorban maradnak.
 */
export function keyServiceView(
  serviceId: string,
  secrets: SecretRow[] | null = null,
  active: string | null | undefined = undefined,
): KeyServiceView {
  const state = secrets ? 'ok' : vaultFileState()
  const activeSlotId = active === undefined ? activeSlotFor(serviceId) : active
  if (state === 'unreadable') {
    // Nem nulla: nem láttam oda. A felület ezt kimondja.
    return { serviceId, slots: [], count: null, activeSlotId, activeMissing: false }
  }
  const rows: SecretRow[] = secrets ?? (state === 'missing' ? [] : listSecrets() as SecretRow[])

  const slots: KeyServiceSlot[] = []
  for (const row of rows) {
    if (isSlotOf(row.id, serviceId)) {
      slots.push({
        slotId: row.id,
        label: row.label || row.id,
        // SZÁNDÉKOSAN mindig `true`: a "be van-e kötve" kérdésre az egész
        // rendszer a `getSecret(id) !== null` választ adja, és az egy létező
        // bejegyzésre akkor is nem-null, ha az alap-érték üres. Ha itt
        // szigorúbbak lennénk, a lehetőség-lista mást mondana, mint az
        // Önellenőrzés és az ügynök-indító ugyanarról a kulcsról -- két szám
        // ugyanarra a kérdésre rosszabb, mint egy pontatlan.
        hasValue: true,
        updatedAt: row.updatedAt,
      })
      continue
    }
    for (const f of row.fields ?? []) {
      if (f.bindingId !== serviceId) continue
      slots.push({
        slotId: row.id,
        label: row.label || row.id,
        hasValue: f.hasValue === true,
        updatedAt: row.updatedAt,
        boundOn: row.label || row.id,
      })
    }
  }

  // Sorrend: az alap-hely elöl, utána sorszám szerint, a kötött mezők a végén.
  slots.sort((a, b) => {
    const rank = (s: KeyServiceSlot) => (s.slotId === serviceId ? 0 : s.boundOn ? 2 : 1)
    const d = rank(a) - rank(b)
    return d !== 0 ? d : a.slotId.localeCompare(b.slotId, 'en')
  })

  const filled = slots.filter(s => s.hasValue)
  return {
    serviceId,
    slots,
    count: filled.length,
    activeSlotId,
    activeMissing: activeSlotId !== null && !slots.some(s => s.slotId === activeSlotId),
  }
}
