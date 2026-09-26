/**
 * A Munkapad-agent EMBER-NYELVU mondatai (kanban #336, 2. fazis).
 *
 * Egy helyen, mindket nyelven. Gepi kod (`no_provider`, `limit_critical`)
 * sosem kerul onmagaban a kepernyore: a vegpont a kodot ES a mondatot is
 * visszaadja, a felulet a mondatot mutatja.
 *
 * A szovegek itt allnak (nem a web/lang/*.js-ben), mert a szerver akkor is ki
 * tudja mondani oket, amikor meg nincs betoltott felulet -- pl. egy
 * streamelt valasz kozepen. A `web/lang/*.js` ugyanezeket a kulcsokat viszi,
 * hogy a felulet a SAJAT forditasat mutathassa, ha ismeri a kodot.
 */
export type Lang = 'hu' | 'en'

export interface Message { hu: string; en: string }

export const MESSAGES = {
  // --- a szolgaltato allapota ---------------------------------------------
  no_provider: {
    hu: 'Ezen a gépen most nincs beállítva AI-szolgáltató a Munkapadhoz: nincs bejelentkezett Claude-fiók, és nincs helyi modell sem. Jelentkezz be egy Claude-fiókkal, vagy indíts helyi modellt — addig a Munkapad többi része működik, csak az ágens hallgat.',
    en: 'No AI provider is set up for the Workbench on this machine right now: there is no signed-in Claude account and no local model either. Sign in with a Claude account or start a local model — until then the rest of the Workbench works, only the agent stays silent.',
  },
  provider_no_answer: {
    hu: 'A szolgáltató most nem adott használható választ. Próbáld újra pár perc múlva.',
    en: 'The provider gave no usable answer now. Try again in a few minutes.',
  },
  provider_failed: {
    hu: 'A szolgáltató hívása nem sikerült: {detail}',
    en: 'The provider call failed: {detail}',
  },

  // --- a kozos 5 oras keret ------------------------------------------------
  limit_critical: {
    hu: 'A közös 5 órás Claude-keret most betelt ({pct}%), ezért a Munkapad nem indít új hívást — különben elvenné a keretet a többi ágenstől. {reset}',
    en: 'The shared 5-hour Claude limit is used up right now ({pct}%), so the Workbench starts no new call — it would take the frame from the other agents. {reset}',
  },
  limit_reset_known: {
    hu: 'A keret {when} körül áll vissza.',
    en: 'The limit comes back around {when}.',
  },
  limit_reset_unknown: {
    hu: 'Azt nem tudom, mikor áll vissza — a szolgáltató nem mondta meg.',
    en: 'I do not know when it comes back — the provider did not say.',
  },
  too_many_in_flight: {
    hu: 'Egyszerre túl sok Munkapad-hívás fut ({n}). Várd meg, amíg valamelyik befejeződik.',
    en: 'Too many Workbench calls are running at once ({n}). Wait until one of them finishes.',
  },
  usage_unknown: {
    hu: 'A közös keretről most nincs friss mérés — nem azt jelenti, hogy üres, hanem azt, hogy nem látok oda.',
    en: 'There is no fresh measurement of the shared limit right now — that does not mean it is empty, it means I cannot see it.',
  },

  // --- keres / munkamenet --------------------------------------------------
  message_required: {
    hu: 'Írd le, mit szeretnél — üres üzenetre nem tudok válaszolni.',
    en: 'Write down what you want — I cannot answer an empty message.',
  },
  message_too_long: {
    hu: 'Ez az üzenet túl hosszú (legfeljebb {max} karakter). Bontsd több üzenetre.',
    en: 'This message is too long ({max} characters at most). Split it into several messages.',
  },
  work_item_not_found: {
    hu: 'Ez a munkadarab nem található (lehet, hogy közben törölték).',
    en: 'This work item was not found (it may have been deleted).',
  },
  session_not_found: {
    hu: 'Ez a beszélgetés nem található.',
    en: 'This conversation was not found.',
  },
  bad_json: {
    hu: 'A kérés nem értelmezhető.',
    en: 'The request could not be read.',
  },
  busy: {
    hu: 'Ehhez a munkadarabhoz már fut egy válasz. Várd meg, amíg befejeződik.',
    en: 'An answer is already running for this work item. Wait until it finishes.',
  },

  // --- toolok / jovahagyas -------------------------------------------------
  tool_unknown: {
    hu: 'Ilyen eszköz nincs: {tool}. Az ágens csak az engedélyezett eszközöket használhatja.',
    en: 'There is no such tool: {tool}. The agent may only use the allowed tools.',
  },
  tool_needs_approval: {
    hu: 'Ehhez a lépéshez ({tool}) a jóváhagyásod kell. Felvettem a Jóváhagyások közé — ott tudod engedélyezni vagy elutasítani. Ha engedélyezed, magától lefut, és az eredményt ide írom.',
    en: 'This step ({tool}) needs your approval. I filed it under Approvals — you can allow or reject it there. If you allow it, it runs by itself and I post the result here.',
  },
  tool_blocked: {
    hu: 'Ezt a lépést ({tool}) a beállításaid nem engedik önállóan, és jóváhagyást sem kérhetek rá. Az Önállóság oldalon tudod feloldani.',
    en: 'Your settings do not allow this step ({tool}) on its own, and I cannot even ask for approval. You can unlock it on the Autonomy page.',
  },
  tool_approved_run_in_progress: {
    hu: 'Ez a jóváhagyott lépés ({tool}) már magától fut — nem indítom el még egyszer. Az eredményt ide írom.',
    en: 'This approved step ({tool}) is already running by itself — I will not start it a second time. I will post the result here.',
  },
  tool_ran_after_approval: {
    hu: 'Jóváhagyva, és lefutott: {tool}{target}.',
    en: 'Approved, and it ran: {tool}{target}.',
  },
  tool_failed_after_approval: {
    hu: 'Jóváhagyva, de nem sikerült lefuttatni ({tool}{target}): {detail}',
    en: 'Approved, but it could not run ({tool}{target}): {detail}',
  },
  tool_approval_rejected: {
    hu: 'Ezt a lépést ({tool}{target}) nem hagytad jóvá, ezért nem futott le.',
    en: 'You did not approve this step ({tool}{target}), so it did not run.',
  },
  tool_failed: {
    hu: 'Az eszköz ({tool}) nem futott le: {detail}',
    en: 'The tool ({tool}) did not run: {detail}',
  },

  // --- "nema nulla": nincs adat ≠ nincs semmi ------------------------------
  no_data_in_context: {
    hu: 'Erről most nincs adatom — nem azt mondom, hogy nincs ilyen, hanem azt, hogy nem látok oda.',
    en: 'I have no data on this right now — I am not saying there is none, I am saying I cannot see it.',
  },
} as const satisfies Record<string, Message>

export type MessageKey = keyof typeof MESSAGES

/** Egy mondat a keres nyelven, `{jelolo}` behelyettesitessel. */
export function msg(key: MessageKey, lang: Lang, params: Record<string, string | number> = {}): string {
  const raw = MESSAGES[key][lang]
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m))
}

/** Mindket nyelven -- naplohoz es teszthez. */
export function bothLangs(key: MessageKey, params: Record<string, string | number> = {}): Message {
  return { hu: msg(key, 'hu', params), en: msg(key, 'en', params) }
}
