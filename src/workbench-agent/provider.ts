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

/** Honnan ment a hivas: melyik fiok, vagy a szerveroldali API-kulcs. SOSE token/email. */
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

/** Csak teszthez: a nyilvantartas kiuritese. */
export function clearAIProvidersForTest(): void {
  providers.clear()
  order.length = 0
}
