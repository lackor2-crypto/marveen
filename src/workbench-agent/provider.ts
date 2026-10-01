/**
 * PROVIDER ABSZTRAKCIO (kanban #336, 2. fazis, spec 7).
 *
 * "A Marvin uzleti logikaja providerfuggetlen legyen. Kesobbi provider
 *  hozzaadasa ne igenyelje a Workbench ujrairasat."
 *
 * Ezert az orchestrator KIZAROLAG ezt az interfeszt ismeri. Aki uj
 * szolgaltatot ad hozza, egy fajlt ir es `registerAIProvider()`-rel beteszi --
 * a loophoz nem nyul.
 *
 * KULCSOK: a spec 20. szakasza szerint API-kulcs SOSEM kerul a frontendbe, a
 * chatbe, a localStorage-ba vagy a work item manifestbe. Ez az interfesz ezert
 * nem is lat kulcsot: a szolgaltato a SAJAT, szerveroldali configjabol veszi,
 * es a hivo csak azt tudja meg rola, hogy `available`-e.
 */
import { msg, type Lang } from './messages.js'

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AICallRequest {
  system: string
  messages: AIMessage[]
  /** Melyik nyelven valaszoljon. A szolgaltato tovabbadja a promptban. */
  lang: 'hu' | 'en'
  /** Felso hatar a valaszra. A szolgaltato betarthatja vagy figyelmen kivul hagyhatja. */
  maxOutputChars?: number
  /** Megszakitas (a kliens lecsukta az SSE-t). */
  signal?: AbortSignal
  /**
   * Melyik agens elofizeteses fiokjat hasznalja (agent id). Ures = a
   * szolgaltato alapertelmezettje (a fo agens). Parameter, hogy egy kesobbi
   * fiok-valto (#402 2. resz) ne a providerhez nyuljon.
   */
  account?: string
}

/** Honnan ment a hivas: melyik fiok. SOSE token/email. Az `api_key` valtozat
 *  a kikerult sajat-kulcsos utbol (#404) maradt: uj ilyen sor nem keletkezik,
 *  de a regi beszelgetes-sorok igy olvashatok maradnak -- ezert NE vedd ki. */
export type AIVia =
  | { kind: 'account'; account: string }
  | { kind: 'api_key' }

/** Egy darab a streambol. `done` utan mar nem jon tobb. */
export type AIChunk =
  | { kind: 'text'; text: string }
  | { kind: 'done'; model: string; via?: AIVia }
  | { kind: 'error'; code: AIErrorCode; detail: string }

/** Miert nem jott valasz. Mindegyik a TENYLEGES esemenybol jon, nem talalgatas. */
export type AIErrorCode =
  /** A szolgaltato nincs beallitva ezen a gepen (nincs fiok/kulcs/helyi modell). */
  | 'not_configured'
  /** A szolgaltato maga mondta, hogy elfogyott a kerete. */
  | 'limit'
  /** Elindult, de nem adott hasznalhato valaszt. */
  | 'no_answer'
  /** Barmi mas: a nyers hibauzenet a `detail`-ben. */
  | 'failed'

export interface AIAvailability {
  available: boolean
  /** Miert nem erheto el -- csak ha `available` false. */
  reason?: 'not_configured'
  /** Emberi reszlet a naplohoz (SOSE kulcs, SOSE token). */
  detail?: string
  /** #455: the chosen model runs on this provider's key (e.g. "DeepSeek") and
   *  that key is missing -- the chat names it instead of "no Claude account". */
  keyFor?: string
}

export interface AIProvider {
  /** Gepi azonosito (`anthropic`, `ollama`, ...). */
  readonly id: string
  /** Melyik modellt hasznalna MOST. Configbol, sosem beegetve. */
  model(): string
  /** Be van-e allitva. NEM hiv modellt: olcso, szinkron ellenorzes. */
  availability(): AIAvailability
  /** A hivas. Darabonkent ad vissza szoveget (streaming). */
  stream(req: AICallRequest): AsyncIterable<AIChunk>
  /**
   * A kiprobalhato elofizeteses fiokok, a legjobb elol (#402). Ures lista vagy
   * hianyzo metodus = a szolgaltato nem fiokokkal dolgozik (API-kulcs, helyi
   * modell): a hivo a `stream()` alapertelmezettjet hasznalja.
   */
  accounts?(): string[]
  /**
   * #455: does the next call run on a Claude subscription account, i.e. on the
   * shared 5-hour limit? A GLM / DeepSeek / OpenRouter / local Ollama model
   * does not: the Claude accounts' limits must neither block it nor make the
   * caller switch accounts. Missing method = true.
   */
  onClaudeBudget?(): boolean
}

const providers = new Map<string, AIProvider>()
const order: string[] = []

/** Uj szolgaltato bejegyzese. A sorrend a bejegyzes sorrendje: az elso
 *  elerheto nyer (a `life-inbox-ai.ts` lanc-logikaja, ugyanaz az elv). */
export function registerAIProvider(p: AIProvider): void {
  if (!providers.has(p.id)) order.push(p.id)
  providers.set(p.id, p)
}

export function getAIProvider(id: string): AIProvider | undefined {
  return providers.get(id)
}

export function listAIProviders(): AIProvider[] {
  return order.map((id) => providers.get(id)).filter((p): p is AIProvider => !!p)
}

/**
 * Az elso szolgaltato, amelyik MOST elerheto -- vagy `null`, ha egyik sem.
 *
 * A `null` egy KIMONDOTT allapot ("nincs beallitva szolgaltato"), nem
 * hallgatas: a hivo ember-nyelvu mondatot ad rola (`messages.no_provider`).
 */
export function pickAIProvider(): AIProvider | null {
  for (const p of listAIProviders()) {
    try { if (p.availability().available) return p } catch { /* egy rossz szolgaltato ne vigye a tobbit */ }
  }
  return null
}

/**
 * WHY no provider is ready, in words (#455). A chosen model whose key is
 * missing is named as such; only when nothing points elsewhere does the
 * general "no provider" sentence stand.
 */
export function whyNoAIProvider(lang: Lang): string {
  for (const p of listAIProviders()) {
    try {
      const a = p.availability()
      if (!a.available && a.keyFor) return msg('model_key_missing', lang, { model: p.model(), provider: a.keyFor })
    } catch { /* a kovetkezo szolgaltato */ }
  }
  return msg('no_provider', lang)
}

/** Csak teszthez: a nyilvantartas kiuritese. */
export function clearAIProvidersForTest(): void {
  providers.clear()
  order.length = 0
}
