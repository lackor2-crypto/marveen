/**
 * A Munkapad-agent belepesi pontja (kanban #336, 2. fazis).
 *
 * Egy helyen dol el, MELYIK szolgaltatok leteznek. Aki ujat ad hozza, ide ir
 * egy sort -- az orchestrator nem valtozik (spec 7).
 */
import { anthropicProvider } from './provider-anthropic.js'
import { getAIProvider, listAIProviders, registerAIProvider } from './provider.js'

/**
 * Idempotens: a vegpont minden keresnel meghivhatja.
 *
 * A "mar megvan" a NYILVANTARTASBOL derul ki, nem egy kulon jelzobol -- igy ha
 * a nyilvantartast valami kiuriti, a kovetkezo keres helyreallitja. Egy
 * modul-szintu jelzo ilyenkor csendben szolgaltato nelkul hagyna a Munkapadot.
 */
export function ensureWorkbenchAgent(): void {
  if (!getAIProvider(anthropicProvider.id)) registerAIProvider(anthropicProvider)
}

/** Csak teszthez: a fenti fuggveny mar allapotmentes, ez csak a regi hivokat
 *  tartja eletben (es kimondja, hogy nincs mit visszaallitani). */
export function resetWorkbenchAgentForTest(): void { /* nincs sajat allapot */ }

export { listAIProviders }
