// Kanban #136 (d9cb27ec): a helyi modell-lista NULLA eleme ket, egymassal
// ellentetes dolgot jelenthet -- "nincs mit mutatni" vagy "nem lattunk oda" --,
// es a regi vegpont mindkettore ugyanazt az ures tombot adta vissza. Ez a modul
// donti el, melyikrol van szo. Tiszta fuggveny: se halozat, se DB, se ora, hogy
// a dontes tesztelheto legyen a szerver elinditasa nelkul.
//
// A harmadik eset ugyanilyen nema volt: fut a szerver, van is benne modell, de
// MIND beagyazo (embed) modell -- azok keresesre jok, beszelgetesre nem, ezert a
// lista jogosan ures, csak ezt eddig senki nem mondta meg a felhasznalonak.

/** Egy sor az Ollama /api/tags valaszabol (csak amit hasznalunk belole). */
export interface OllamaTag {
  name: string
  size?: number
  details?: { parameter_size?: string }
}

/** Egy valaszthato modell ugy, ahogy a felulet listaja keri. */
export interface OllamaModelOption {
  name: string
  size: string
  params: string
}

export type OllamaListVerdict = 'ok' | 'unreachable' | 'no_models' | 'embed_only'

export interface OllamaModelList {
  models: OllamaModelOption[]
  /** Miert ures a lista (vagy 'ok', ha nem ures). A felulet ebbol valasztja ki,
   *  mit mondjon -- nem a models.length-bol kovetkeztet. */
  verdict: OllamaListVerdict
  reachable: boolean
  /** Hany modell van OSSZESEN a szerveren (szures elott). `null` = nem lattunk
   *  oda; a 0 ettol kulonbozik: az azt jelenti, hogy megkerdeztuk es ures. */
  totalModels: number | null
  /** A TENYLEGES hibauzenet, ha nem sikerult elerni. Sosem talalgatas. */
  error: string | null
  /** Melyik cimet kerdeztuk meg -- a hibauzenet enelkul nem cselekvokepes. */
  url: string
}

/** Beagyazo (embed) modell-e. A nevben szereplo "embed" az egyetlen jel, amit az
 *  Ollama /api/tags ad; kis- es nagybetutol fuggetlenul nezzuk. */
export function isEmbeddingModel(name: string): boolean {
  return /embed/i.test(name || '')
}

function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  return Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10 + ' GB'
}

export function summarizeOllamaModels(input: {
  url: string
  reachable: boolean
  tags: OllamaTag[] | null
  error?: string | null
}): OllamaModelList {
  const base = { url: input.url, models: [] as OllamaModelOption[] }

  // 1. Nem lattunk oda. Ez NEM ures lista, es sosem szabad annak latszania.
  if (!input.reachable || input.tags === null) {
    return {
      ...base,
      verdict: 'unreachable',
      reachable: false,
      totalModels: null,
      error: input.error && input.error.trim() !== '' ? input.error : 'ismeretlen hiba',
    }
  }

  const tags = input.tags
  const models = tags
    .filter((m) => !isEmbeddingModel(m.name))
    .map((m) => ({ name: m.name, size: formatSize(m.size), params: m.details?.parameter_size || '' }))

  // 2. Megkerdeztuk, es tenyleg nincs benne semmi (friss Ollama-telepites).
  if (tags.length === 0) {
    return { ...base, verdict: 'no_models', reachable: true, totalModels: 0, error: null }
  }

  // 3. Van modell, de mind beagyazo -- pontosan ez volt a tulajdonos esete.
  if (models.length === 0) {
    return { ...base, verdict: 'embed_only', reachable: true, totalModels: tags.length, error: null }
  }

  return { models, url: input.url, verdict: 'ok', reachable: true, totalModels: tags.length, error: null }
}
