---
name: agent-identity-verification
description: Mielőtt kimondod, KI írt vagy KI csinált valamit (üzenet, commit, kártya-munka), ellenőrizd konkrét forrásból -- ne találgass a témából vagy szerepkörből. Különösen fontos modellváltás vagy session-újraindítás után, amikor a friss kontextus a saját korábbi üzeneteidet másik ágensének tűntetheti fel.
scope: global
---

# Azonosítás előtt kötelező ellenőrizni, nem találgatni

## A szabály (2026-09-08, {{OWNER_NAME}})

Ha valakinek ({{OWNER_NAME}}nak vagy egy másik ágensnek) meg kell mondanod, KI
írt vagy KI csinált valamit -- egy üzenetet, egy commitot, egy kártya-munkát --,
TILOS a témából vagy szerepkörből találgatni. Konkrét, ellenőrizhető forrást
kell megnézned MIELŐTT kimondod.

## A valós eset

Egy modellváltás (Opus 4.8 -> Sonnet 5) session-újraindítást váltott ki. A
frissen betöltött kontextusban az ágens saját korábbi üzenete (VS Code
kód-híd javítás + kanban landolás) szerepelt "Te:" jelöléssel. Az ágens ezt
tévesen a fő ágensnek tulajdonította, mert a téma (VS Code kód-híd) a fő
ágens szakterületének tűnt -- ahelyett hogy megnézte volna, valójában KI
írta. {{OWNER_NAME}} egy Telegram-képernyőképpel bizonyította, hogy az
üzenet az ágens SAJÁT bot-chatjéből jött. A hibát a témából/szerepkörből
való találgatás okozta, nem a rendszer.

**A tanulság:** modellváltás vagy session-újraindítás NEM változtatja meg,
MELYIK ágens vagy -- ugyanaz az ágens-azonosság (pl. lackor3) futhat egyik
modellként is, másikként is. A modell csak a "hang", nem az azonosság. A
saját korábbi ("Te:") kontextus ALAPBÓL a SAJÁT korábbi munkád, nem egy
másik ágensé -- fordítva csak konkrét bizonyítékkal állítható.

## Kötelezően ellenőrizendő, MIELŐTT egy azonosítást kimondasz

1. **Csatorna/bot.** Melyik CSATORNÁN/BOTON érkezett vagy ment az üzenet --
   minden ágensnek KÜLÖN Telegram-botja/chat-je van (pl. @segedmunkas_bot,
   @szakerto_bot), ezek SOSE keverednek össze. Ha van képernyőkép vagy
   channel-log, abból a bot/chat neve közvetlenül leolvasható.
2. **Git worktree és branch neve.** `git worktree list` -- a branch neve
   gyakran kódolja, melyik ágens/kártya munkája (pl.
   `fix/code-bridge-limited-state` egy adott ágens saját worktree-jében).
3. **Approval `agent_id` mezője.** A `kanban_done` jóváhagyást a kártyát
   `waiting`-be mozgató `actor` hozza létre (lásd `ensureApprovalForWaitingCard`
   a `src/web/routes/approvals.ts`-ben) -- ez megbízható forrás arra, KI
   fejezte be a munkát.
4. **Kanban komment szerzője, inter-agent üzenet `from` mezője.** Ezek az
   API-ban közvetlenül lekérdezhetők (`/api/kanban/:id/comments`,
   `/api/messages`).
5. **Saját korábbi kontextus alapértelmezés.** A "Te:" jelölésű korábbi
   szöveg a beszélgetésben ALAPBÓL a saját korábbi munkád -- ezt csak
   konkrét, a fentiek valamelyikéből származó bizonyíték döntheti meg.

## Ha nincs ellenőrizhető forrás

Ha egyik fenti forrás sem érhető el (a worktree törölve, nincs
approval-rekord, stb.), MONDD MEG hogy nem sikerült ellenőrizni -- ne állíts
tényként talalgatott azonosságot. A "nem tudom biztosan, ki csinálta"
mondat jobb, mint egy magabiztos, de rossz találgatás.

## Kapcsolódás más szabályokhoz

Ez a szabály a `recheck-before-restating` szabály speciális esete:
azonosításnál a "korábbi tudás" (mit gondoltál, ki csinálta) NEM forrás,
mindig friss ellenőrzés kell. Lásd még: `ask-back-when-ambiguous` -- ha az
ellenőrzés után is kétséges marad az azonosítás, kérdezz vissza ahelyett
hogy találgatnál.

## Ellenőrzés

- Meg tudod-e nevezni a KONKRÉT forrást (csatorna/bot, worktree/branch,
  approval `agent_id`, kanban komment), ami alapján az azonosítást tetted?
- Ha nem, mondtad-e ki, hogy ez bizonytalan, vagy csendben találgattál?
