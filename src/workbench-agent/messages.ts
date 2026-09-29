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
  max_rounds_reached: {
    hu: 'Ez a kérés sok lépést igényelt (pl. egy hosszú fájl végiglapozását), és elértem a lépés-keretet, mielőtt a végső választ meg tudtam volna fogalmazni. Kérdezz szűkebben (pl. egy adott szakaszra), vagy kérd meg, hogy csak a lényeget nézze -- akkor egy fordulóban belefér.',
    en: 'This request took many steps (for example paging through a long file) and I hit the step budget before I could write the final answer. Ask something narrower (e.g. one section), or ask for just the essentials, and it will fit in one turn.',
  },

  // --- allo, elo munkamenet (#434, C opcio) ---------------------------------
  live_resume_prompt: {
    hu: 'A Marveen újraindult (frissítés), és ez megszakította a munkádat. Folytasd a félbeszakadt munkát onnan, ahol abbamaradt; ha már kész volt, röviden írd meg az eredményt.',
    en: 'Marveen restarted (update) and that cut off your work. Continue the interrupted work from where it stopped; if it was already done, briefly report the result.',
  },
  live_session_failed: {
    hu: 'A teljes értékű ügynök munkamenete megszakadt: {detail}. Írd újra az üzeneted -- a beszélgetés folytatódik.',
    en: 'The full agent session stopped: {detail}. Send your message again -- the conversation continues.',
  },

  // --- teljes erteku agent a kod-hidon (#433, B opcio) ---------------------
  code_bridge_handed_off: {
    hu: 'Átadtam a teljes értékű ügynöknek (feladat {id}). Dolgozik rajta, a válasza itt jelenik meg, amint kész. A részletes lépések a Kód-híd nézetben is látszanak.',
    en: 'Handed to the full agent (task {id}). It is working on it; the answer appears here when ready. The detailed steps are also visible in the Code Bridge view.',
  },
  code_bridge_running: {
    hu: 'A teljes értékű ügynök most dolgozik a feladaton.',
    en: 'The full agent is working on the task now.',
  },
  code_bridge_done_empty: {
    hu: 'A teljes értékű ügynök befejezte, de nem adott vissza szöveges választ. Nézd meg a Kód-híd nézetet a részletekért.',
    en: 'The full agent finished but returned no text answer. Check the Code Bridge view for details.',
  },
  code_bridge_error: {
    hu: 'A teljes értékű ügynök hibába futott. Nézd meg a Kód-híd nézetet a részletekért, vagy próbáld újra.',
    en: 'The full agent hit an error. Check the Code Bridge view for details, or try again.',
  },
  code_bridge_error_detail: {
    hu: 'A teljes értékű ügynök hibára futott. A pontos ok: {detail}',
    en: 'The full agent hit an error. The exact reason: {detail}',
  },
  code_bridge_limit: {
    hu: 'A VS Code kódhíd fiókja elérte a keretét: {detail}',
    en: 'The VS Code code bridge account hit its usage limit: {detail}',
  },
  code_bridge_limit_fallback: {
    hu: 'A VS Code kódhíd fiókjának kerete kifogyott, a munkát a(z) {to} fiókkal folytatom.',
    en: 'The VS Code code bridge account ran out of quota, I continue the work with the {to} account.',
  },
  code_bridge_stalled_fallback: {
    hu: 'A VS Code kódhíd futása elakadt (időkorlát), a munkát a(z) {to} fiókkal folytatom.',
    en: 'The VS Code code bridge run stalled (time limit), I continue the work with the {to} account.',
  },
  code_bridge_updating: {
    hu: 'A VS Code kódhíd Claude Code programja elavult. Megnézem, tudom-e frissíteni a Windows gépen.',
    en: 'The VS Code code bridge Claude Code is out of date. I am checking whether I can update it on the Windows machine.',
  },
  code_bridge_outdated_fallback: {
    hu: 'A VS Code kódhíd Claude Code programja elavult, ezt a modellt nem ismeri (nem keretprobléma). A munkát a(z) {to} fiókkal folytatom.',
    en: 'The VS Code code bridge Claude Code is out of date and does not know this model (not a quota problem). I continue the work with the {to} account.',
  },
  live_account_switched: {
    hu: 'A(z) {from} fiók kerete kifogyott, a munkát a(z) {to} fiókkal folytatom.',
    en: 'The {from} account ran out of quota, I continue the work with the {to} account.',
  },
  live_switch_continue: {
    hu: 'Az előző fiók kerete e válasz közben fogyott ki. Eddig ezt írta:\n---\n{partial}\n---\nFolytasd innen (a munkakönyvtár állapotából is látod, meddig jutott), ne kezdd elölről.',
    en: 'The previous account ran out of quota during this answer. So far it wrote:\n---\n{partial}\n---\nContinue from here (the working folder shows how far it got), do not start over.',
  },
  bridge_continue_note: {
    hu: 'Egy másik fiók már dolgozott ezen, de félbeszakadt. Nézd meg a munkakönyvtár állapotát (pl. git status), és onnan folytasd; ha már kész, röviden írd meg az eredményt.',
    en: 'Another account already worked on this but was cut off. Check the state of the working folder (e.g. git status) and continue from there; if it is already done, briefly report the result.',
  },
  bridge_continue_prompt: {
    hu: '{notice}\n\nFolytasd a félbeszakadt munkát onnan, ahol abbamaradt (a munkakönyvtár állapotából látod, meddig jutott); ha már kész volt, röviden írd meg az eredményt.',
    en: '{notice}\n\nContinue the interrupted work from where it stopped (the working folder shows how far it got); if it was already done, briefly report the result.',
  },
  code_bridge_cancelled: {
    hu: 'A feladat megszakadt, mielőtt a teljes értékű ügynök befejezte volna.',
    en: 'The task was cancelled before the full agent finished.',
  },
  code_bridge_timeout: {
    hu: 'A teljes értékű ügynök még dolgozik (feladat {id}). Amint végez, a válasza ide érkezik; addig az új üzeneteid sorba állnak, és utána mennek tovább.',
    en: 'The full agent is still working (task {id}). Its answer will arrive here as soon as it finishes; until then your new messages wait in the queue and go on afterwards.',
  },
  code_bridge_lost: {
    hu: 'A feladatot nem találom többé a sorban. Próbáld újra elküldeni az üzenetet.',
    en: 'I can no longer find the task in the queue. Try sending the message again.',
  },
  code_bridge_enqueue_failed: {
    hu: 'Nem sikerült átadni a teljes értékű ügynöknek: {detail}',
    en: 'Could not hand the task to the full agent: {detail}',
  },
  code_bridge_no_worker: {
    hu: 'A teljes értékű mód be van kapcsolva, de most nincs bejelentkezett Claude Code worker, ezért a megszokott projekt-asszisztens válaszol. Ahhoz, hogy a chatben a teljes értékű ügynökkel beszélj, köss be egy workert a Kód-híd oldalon (Beállítások / Kód-híd): töltsd le az indítót, futtasd a gépeden, és jelentkezz be a Claude-fiókoddal.',
    en: 'Full mode is on, but there is no signed-in Claude Code worker right now, so the usual project assistant answers. To talk to the full agent in the chat, connect a worker on the Code Bridge page (Settings / Code Bridge): download the launcher, run it on your machine, and sign in with your Claude account.',
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
  // #426: a fiokok kerete a SZOLGALTATONAL fogyott el (heti/5 oras). Ez MAS,
  // mint a kozos 5 oras kapu -- itt a fallback vegigment az osszes fiokon, es
  // mind elutasitott. Az uzenet NE a "kozos 5 oras keret 100%"-ot mondja
  // (Boss, 2026-09-27: "kulvara nem erdekel a 100%").
  all_accounts_limited: {
    hu: 'Most minden bejelentkezett fiók kerete kimerült a szolgáltatónál, ezért egyik sem tud válaszolni. Amint valamelyik visszaáll, próbáld újra — vagy válaszd ki a beállításnál, melyik fiókkal menjen.',
    en: 'Every signed-in account is out of quota at the provider right now, so none of them can answer. As soon as one comes back, try again — or pick which account to use in the settings.',
  },
  chosen_account_limited: {
    hu: 'A választott fiók ({account}) kerete most kimerült a szolgáltatónál. Válassz másik fiókot a beállításnál, vagy hagyd automatikuson, hogy magától egy élő fiókra váltson.',
    en: 'The chosen account ({account}) is out of quota at the provider right now. Pick another account in the settings, or leave it on automatic so it switches to a live account by itself.',
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
