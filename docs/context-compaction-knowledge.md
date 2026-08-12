# Forras: Boss altal kuldott tudasanyag (Telegram, 2026-08-12, uzenet 248/249)

> Eredeti fajlnev: Kontextusgenerator_Marveenba.pdf / message.txt. Valtozatlan tartalom.

# Marvin – Professzionális Context Compaction és Memory Management rendszer

## 1. Cél

A Marvinban olyan context-management rendszert kell létrehozni, amely hosszú, több órás vagy akár több napos AI-agent munkamenetekben is megőrzi a projekt lényeges állapotát.

A cél nem egyszerűen az, hogy a kontextus kisebb legyen.

A cél:

**minimális aktív tokenmennyiség mellett maximális információmegőrzés és visszakereshetőség.**

A rendszernek úgy kell működnie, hogy:

* az agent hosszú ideig dolgozhasson;
* a context window ne teljen be;
* compaction után ne kezdje újra a már megoldott problémákat;
* ne felejtse el a fontos döntéseket;
* ne felejtse el a sikertelen megközelítéseket;
* ne veszítse el a fájlok aktuális állapotát;
* ne veszítse el a felhasználó fontos követelményeit;
* a régi részletes információk szükség esetén visszakereshetők legyenek;
* a compaction többször egymás után is végrehajtható legyen jelentős információromlás nélkül.

A rendszer alapelve:

**Never confuse compression with deletion.**

A contextből lehet eltávolítani információt, de az eredeti információt nem szabad véglegesen megsemmisíteni, ha annak későbbi visszakeresése értelmes lehet.

---

# 2. A legfontosabb architekturális változtatás

Ne egyetlen „summary” változót használj.

Ez a legegyszerűbb megoldás, de hosszú munkameneteknél fokozatos információvesztést okoz.

Helyette a Marvinnak több memória-szintet kell használnia.

Javasolt architektúra:

**L0 – System / immutable instructions**

**L1 – Current working context**

**L2 – Structured project state**

**L3 – Compressed conversation memory**

**L4 – Episodic event/history store**

**L5 – Full raw archive**

**L6 – Retrieval index**

Ez hasonló a MemGPT által bevezetett „virtual context” gondolatához: az LLM aktuális contextje nem maga a teljes memória, hanem egy gyors munkamemória, amelyből a régebbi információ szükség esetén betölthető.

---

# 3. L0 – Immutable system context

Ezt a réteget SOHA ne add át a compactionnak.

Ide tartozik:

* system prompt;
* Marvin alapvető működési szabályai;
* tool-definíciók;
* biztonsági szabályok;
* projekt-specifikus alapvető szabályok;
* compaction szabályai;
* memória-kezelési szabályok.

A compaction csak a beszélgetési előzményt tömörítse.

Ne készíts olyan summaryt, amelybe belekerülnek az alapvető system instructionök.

A compaction után:

`NEW_CONTEXT = IMMUTABLE_CONTEXT + PROJECT_STATE + WORKING_MEMORY + COMPACTED_HISTORY`

Ez fontos különbség.

Az alapvető szabályokat nem kell minden compactionnál újra „kitalálni”.

---

# 4. L1 – Working Context

Ez az, amit az AI jelenleg ténylegesen lát.

Ide kerül:

* aktuális user request;
* aktuális task;
* legutóbbi tool calls;
* legutóbbi tool results;
* aktuális fájlok releváns részei;
* aktuális hibák;
* aktuális terv;
* a legutóbbi néhány lépés.

Ez legyen a legfrissebb és legdinamikusabb memória.

Nem kell minden korábbi üzenetet ide rakni.

A cél:

**only what the model needs NOW.**

Ez a context engineering egyik központi elve: nem a lehető legtöbb információt kell a modellnek adni, hanem a következő döntéshez szükséges információt. Anthropic ezt kifejezetten úgy definiálja, mint az inference során a megfelelő tokenek kiválasztását és fenntartását.

---

# 5. L2 – Structured Project State

Ez legyen a Marvin egyik legfontosabb komponense.

Ne bízd a projektállapot teljes megőrzését egy LLM által generált szöveges summaryra.

Legyen egy strukturált state.

Például:

```text
PROJECT STATE

Project:
Marvin

Current objective:
...

Current phase:
...

Completed:
...

In progress:
...

Blocked:
...

Known bugs:
...

Architecture:
...

Files modified:
...

Files created:
...

Important decisions:
...

Rejected approaches:
...

Constraints:
...

Dependencies:
...

Environment:
...

Tests:
...

Last verified state:
...

Next action:
...
```

A strukturált adatokat lehetőleg JSON/YAML/SQLite formában tárold.

Például:

```json
{
  "objective": "...",
  "phase": "implementation",
  "completed": [],
  "in_progress": [],
  "blocked": [],
  "decisions": [],
  "rejected_approaches": [],
  "constraints": [],
  "files_changed": [],
  "tests": [],
  "next_action": "..."
}
```

A kritikus strukturált adatot ne csak LLM-szövegből próbáld később visszanyerni.

---

# 6. Miért kell külön kezelni a döntéseket?

Ez az egyik legfontosabb rész.

Egy normál summary például ezt írhatja:

„Authentication was implemented using OAuth.”

Ez kevés.

A Marvinnak inkább ezt kell megőriznie:

```text
DECISION-017

Topic:
Authentication

Decision:
Use OAuth Authorization Code + PKCE.

Reason:
Required for browser-based authentication.

Rejected:
API-key-only authentication.

Why rejected:
Does not provide the desired interactive login flow.

Affected components:
auth/
oauth/
provider/
login/

Status:
Implemented

Verified:
2026-08-12

Source:
conversation event #184
```

Ez már nem egyszerű summary.

Ez **decision memory**.

---

# 7. A sikertelen megközelítéseket is meg kell őrizni

Ez kritikus.

Az agent egyik leggyakoribb hosszú-session hibája:

1. kipróbál valamit;
2. nem működik;
3. rájön, miért;
4. compaction történik;
5. később újra megpróbálja ugyanazt.

Ezt el kell kerülni.

Ezért külön:

```text
REJECTED APPROACHES
```

memóriát kell fenntartani.

Például:

```text
APPROACH-008

Attempt:
Use API key authentication for provider login.

Result:
Rejected.

Reason:
User requires browser OAuth login.

Do not retry unless:
provider API changes or user explicitly requests it.
```

Ez sokszor fontosabb, mint a pozitív döntések.

---

# 8. L3 – Compressed Conversation Memory

Itt történik maga a context compaction.

De ne egyetlen summary készüljön.

Készíts több külön szekciót.

Javasolt:

```text
SESSION SUMMARY
TASK STATE
DECISIONS
CONSTRAINTS
IMPORTANT FACTS
FAILED APPROACHES
TOOL RESULTS
FILE CHANGES
OPEN QUESTIONS
NEXT ACTION
```

Így a compaction modellnek nem kell eldöntenie, hogy „mi fontos általában”.

A rendszer konkrét kategóriákba kényszeríti.

---

# 9. A compaction prompt ne azt mondja:

„Summarize the conversation.”

Ez túl gyenge.

A Marvin compaction promptjának feladata:

**Extract state, not prose.**

A compaction modellnek azt kell mondani:

1. Identify current objective.
2. Identify completed work.
3. Identify unfinished work.
4. Extract explicit user requirements.
5. Extract hard constraints.
6. Extract decisions.
7. Extract rejected approaches.
8. Extract errors and their causes.
9. Extract verified facts.
10. Extract modified files.
11. Extract important tool results.
12. Extract dependencies.
13. Extract environment assumptions.
14. Extract unresolved questions.
15. Determine exact next action.

A compaction végén mindig legyen:

```text
CURRENT STATE
```

és:

```text
NEXT ACTION
```

---

# 10. A számokat és konkrét értékeket külön kell védeni

Az LLM summary egyik veszélye a numerical drift.

Például:

eredeti:

`timeout = 37 seconds`

summary:

`timeout = approximately 40 seconds`

Ez programozási környezetben hiba.

Ezért minden strukturált értéket külön kell kezelni:

* számok;
* fájlnevek;
* URL-ek;
* API endpointok;
* portok;
* verziószámok;
* modellek;
* environment variable nevek;
* konfigurációk;
* regexek;
* database table names;
* function names.

A compactor utasítása:

**Never approximate exact technical values.**

---

# 11. A fájlokat ne summaryból rekonstruáld

Ez nagyon fontos.

Ha a Marvin módosít egy fájlt:

```text
src/auth/oauth.ts
```

ne az legyen a memória:

„OAuth authentication file was modified.”

A valódi fájl maradjon a filesystemben.

A memory csak azt tartsa:

```text
FILE CHANGE

src/auth/oauth.ts

Status:
modified

Purpose:
OAuth Authorization Code + PKCE

Current implementation:
...

Last verified:
...

Commit:
abc1234
```

Ha később kell a teljes fájl, az agent újraolvassa.

Ez a **progressive disclosure** elv.

Nem kell 20 000 tokennyi source code-ot folyamatosan a contextben tartani.

---

# 12. Git legyen a hosszú coding session része

A Marvin coding agent esetén minden jelentős mérföldkőnél érdemes commitot létrehozni.

Például:

```text
checkpoint:
OAuth login implemented

commit:
a81f42e
```

Így a memory nem az egyetlen állapotforrás.

A valódi source-of-truth:

**Git + filesystem + structured state + event archive.**

Ez sokkal biztonságosabb.

---

# 13. L4 – Episodic Event Store

Minden fontos eseményt tárolj append-only módon.

Például:

```text
event_000184
event_000185
event_000186
```

Minden esemény:

```json
{
  "id": "event_000184",
  "timestamp": "...",
  "type": "decision",
  "task": "oauth",
  "content": "...",
  "files": [],
  "importance": 0.95,
  "source": "conversation"
}
```

A lényeg:

**A compaction ne törölje az eseményt.**

Csak az aktív contextből vegye ki.

---

# 14. L5 – Raw Archive

Minden eredeti conversation message és tool output maradjon meg.

Például:

```text
memory/
    raw/
        2026/
            08/
                session-001.jsonl
```

Ez legyen append-only.

A compaction egy másodlagos reprezentáció.

Így ha később kiderül:

„Az AI rosszul tömörített valamit.”

akkor vissza tudsz menni az eredeti adathoz.

Ez az úgynevezett **provenance**.

---

# 15. L6 – Retrieval

A régi memória ne kerüljön automatikusan vissza a contextbe.

A Marvin kérdezze meg:

**What information do I need now?**

és csak azt töltse vissza.

Ehhez használhatsz:

* SQLite;
* full-text search;
* BM25;
* embeddings;
* vector database;
* hybrid retrieval.

A legjobb általános megoldás:

**hybrid retrieval = lexical + semantic**

Anthropic saját Contextual Retrieval megoldása is a chunkhoz hozzáadott kontextust kombinálja embeddinges retrievallel és BM25-tel.

---

# 16. Ne csak similarity search legyen

Ez fontos fejlesztés.

Ha csak embedding similarity alapján keresel:

```text
query → embedding → top 5 memories
```

akkor elveszíthetsz olyan dolgokat, amelyek terminológiailag nem hasonlóak.

Használj több retrieval módot:

```text
exact keyword
+
BM25
+
semantic similarity
+
metadata filtering
+
recency
+
importance
+
dependency
```

Például:

```text
query:
"Why didn't we use API keys?"

retrieval:
- exact match: API key
- decision records
- rejected approaches
- authentication task
```

---

# 17. A memory legyen címezhető

Ez a 2026-os kutatás egyik különösen érdekes iránya.

Az ARC megközelítésben a régi tool observationök append-only, ID-val címezhető tárolóban maradnak, és a contextben csak kompakt hivatkozás marad. Ha az agentnek később kell a teljes adat, az ID alapján visszakérheti. A publikált eredményekben ez jelentős recall javulást mutatott a vizsgált feladatokon.

Marvinban ezért minden jelentős memóriaelem kapjon ID-t:

```text
DEC-017
FACT-034
ERR-091
FILE-021
TOOL-184
EVENT-203
```

A compacted contextben:

```text
OAuth decision: DEC-017
```

maradhat.

Ha szükséges:

```text
retrieve_memory("DEC-017")
```

és visszajön az eredeti rekord.

---

# 18. Ez jobb, mint a klasszikus rolling summary

A klasszikus:

```text
history
 ↓
summary
 ↓
summary + new messages
 ↓
new summary
 ↓
new summary + new messages
 ↓
new summary
```

folyamat problémája:

**summary drift.**

A részletek minden újabb összefoglalással tovább tömörödnek.

Ezért:

```text
summary of summary of summary
```

ne legyen a rendszer fő memóriája.

Az ACE kutatás is külön foglalkozik az úgynevezett context collapse problémájával, amikor az iteratív újraírás fokozatosan elveszíti a részleteket.

---

# 19. Ehelyett hierarchical compaction

Használj hierarchiát.

Például:

```text
Raw events
     ↓
Turn summaries
     ↓
Episode summaries
     ↓
Task summaries
     ↓
Project state
```

Például:

```text
EVENTS
001
002
003
004
005
006
007
008
```

↓

```text
EPISODE
OAuth implementation
```

↓

```text
TASK
Authentication system
```

↓

```text
PROJECT
Marvin architecture
```

Ez sokkal stabilabb.

A 2026-os HORMA kutatás is hierarchikus, filesystem-szerű memory navigationt használ, amely a summarykat visszavezeti az eredeti részletekhez.

---

# 20. A compaction ne történjen túl későn

Ne várd meg a context limitet.

Ha a modell maximuma például:

```text
200k
```

akkor ne:

```text
199k → compact
```

legyen.

Legyen:

```text
warning threshold
soft threshold
hard threshold
emergency threshold
```

Például 200k maximumnál:

```text
120k → monitor
140k → prepare
150k → compaction
170k → aggressive compaction
185k → emergency protection
```

A pontos értékeket benchmark alapján kell beállítani.

Anthropic server-side compactionja is konfigurálható threshold alapján működik, és a hosszú agentikus workflow-khoz ajánlják.

---

# 21. Marvin esetében 50k nem feltétlenül a context limit legyen

Ha a használt modell például 200k context window-t ad, akkor:

**ne azt jelentsd, hogy 50k-nál kötelezően kidobod a többit.**

A jobb stratégia:

```text
200k model context
        ↓
Marvin working budget
        ↓
~50–80k active working context
```

A többi adat külső memóriában van.

Így a 200k egy biztonsági tartalék is.

---

# 22. Compaction trigger legyen dinamikus

Ne csak:

```text
if tokens > 50000:
    compact()
```

legyen.

Használj több feltételt:

```text
if context_usage > threshold
OR
estimated_remaining_tokens < safe_margin
OR
tool_output_burst detected
OR
long_episode_completed
OR
task_boundary reached
OR
agent requests compaction
```

A legjobb időpont sokszor **task boundary**.

Például:

```text
Feature A finished
tests passed
git commit created
→ compact
```

Ez jobb, mint egy feature közepén compactiont indítani.

A Codex nyilvános fejlesztői issue-i is rámutatnak arra, hogy a compaction időzítése számít: a túl késői automatikus compaction megszakíthatja az agent folyamatát.

---

# 23. Compaction előtt legyen PRE-COMPACTION CHECKPOINT

Ez nagyon fontos.

Mielőtt a Marvin tömörít:

```text
1. Save project state
2. Save current task
3. Save decisions
4. Save rejected approaches
5. Save file changes
6. Save current errors
7. Save next action
8. Save git state
9. Save raw conversation
10. Only then compact
```

Tehát:

**checkpoint → compact**

és ne:

**compact → reméljük, hogy minden megmaradt.**

---

# 24. A compaction után legyen POST-COMPACTION VALIDATION

Ez az egyik legfontosabb profi funkció.

A compactor készít egy summaryt.

Ezután egy második ellenőrző lépés vizsgálja:

```text
Did we lose:
- user requirements?
- constraints?
- decisions?
- numbers?
- file names?
- failed approaches?
- current task?
- next action?
```

Ha igen:

```text
retrieve original events
→ repair summary
```

Ez már **validated compaction**.

---

# 25. Különösen fontos: contradiction detection

A memory rendszernek észre kell vennie:

```text
old:
timeout = 30

new:
timeout = 60
```

Ez nem két egyformán igaz adat.

A rendszernek tudnia kell:

```text
30 → superseded
60 → current
```

Használj:

```text
valid_from
valid_until
supersedes
superseded_by
```

mezőket.

Például:

```json
{
  "fact": "timeout = 60",
  "supersedes": "FACT-021",
  "status": "current"
}
```

---

# 26. A memory ne legyen csak szöveg

A legjobb Marvin-architektúra:

```text
SQLite
    +
JSON
    +
filesystem
    +
Git
    +
optional vector index
```

SQLite-ben:

```text
events
facts
decisions
tasks
errors
files
sessions
summaries
```

Filesystemben:

```text
raw/
summaries/
project/
snapshots/
```

Gitben:

```text
source code
configuration
important state files
```

Vector indexben:

```text
semantic retrieval
```

---

# 27. Tool output management

Az agenteknél az egyik legnagyobb context-killer a tool output.

Például:

```text
grep
npm install
git diff
test output
compiler output
browser result
web page
logs
```

Ezek gyakran sokkal több tokent fogyasztanak, mint maga a beszélgetés.

Ezért ne minden tool output maradjon teljes hosszában a contextben.

Legyen:

```text
RAW TOOL OUTPUT
        ↓
STORE
        ↓
EXTRACT RESULT
        ↓
CONTEXT
```

Például egy 30 000 tokenes tesztlogból az aktív contextbe:

```text
Tests: 1842 passed
3 failed
Failures:
test A
test B
test C

Full output:
TOOL-918
```

kerüljön.

Ha kell:

```text
retrieve TOOL-918
```

---

# 28. Tool outputnak is legyen importance score-ja

Például:

```text
importance = 1.0
```

ha:

* kritikus hiba;
* security issue;
* architecture decision;
* test failure;
* user requirement.

És:

```text
importance = 0.1
```

ha:

* hosszú, ismétlődő log;
* install output;
* verbose debug;
* már feldolgozott tool output.

Compactionkor először az alacsony importance értékű adatokat kell eltávolítani az aktív contextből.

---

# 29. Context prioritization

Minden context elem kapjon:

```text
importance
recency
relevance
reliability
cost
retrievability
```

Egy egyszerű prioritási modell:

```text
priority =
    relevance × 0.35
  + importance × 0.30
  + recency × 0.15
  + reliability × 0.10
  + dependency × 0.10
```

Ez csak kezdeti formula.

A későbbi benchmark alapján módosítható.

---

# 30. User requirements legyenek „pinned”

Ha a user kimond valami olyat, hogy:

```text
Do not use API keys.
Use OAuth.
Never modify database schema.
Use Python 3.12.
```

akkor ezeket ne bízd a normál summaryra.

Legyen:

```text
PINNED REQUIREMENTS
```

Ezek minden contextben jelen legyenek.

A pin lehet:

```text
CRITICAL
HIGH
NORMAL
```

A `CRITICAL` soha ne kerüljön compactionba.

---

# 31. A memory provenance legyen kötelező

Minden fontos állításnál legyen:

```text
source
timestamp
session
event_id
confidence
```

Például:

```json
{
  "fact": "OAuth PKCE is required",
  "source": "event_184",
  "session": "session_2026_08_12_01",
  "confidence": 1.0
}
```

Így ha az AI később téved:

```text
Why do you believe this?
```

a Marvin meg tudja keresni az eredeti forrást.

---

# 32. Confidence is not truth

Ne engedd, hogy az LLM saját confidence értéke automatikusan igazsággá váljon.

Például:

```text
LLM says confidence = 0.99
```

nem bizonyíték.

A reliability inkább:

```text
user statement > verified tool result > source file > test result > model inference > model speculation
```

legyen.

---

# 33. A compactionnak külön modellt is használhatsz

Elméletileg:

```text
Main model:
Claude Opus / GPT / Gemini

Compaction model:
cheaper/faster model
```

Ez költség szempontból érdekes.

A Codex közösségi fejlesztői issue-i között külön felmerült, hogy a compactionhoz külön modell legyen használható, mivel a compaction feladata más, mint az aktív coding/reasoning.

Marvinban ezért az architecture legyen provider-independent:

```text
MainProvider
CompactionProvider
EmbeddingProvider
RetrievalProvider
```

Így később cserélhető.

---

# 34. A compaction modellnek nem kell ugyanazt „gondolnia”

A compactor feladata:

**state extraction**

nem:

**problem solving**

Ez fontos.

A compactor ne kezdje újra megoldani a programozási problémát.

Csak állapítsa meg:

```text
what happened?
what was decided?
what remains?
what must not be forgotten?
```

---

# 35. A compaction eredménye legyen géppel validálható

A summaryt ne csak Markdownként tárold.

Legyen strukturált schema.

Például:

```json
{
  "objective": "",
  "current_state": "",
  "completed": [],
  "in_progress": [],
  "decisions": [],
  "constraints": [],
  "rejected": [],
  "facts": [],
  "errors": [],
  "files": [],
  "tools": [],
  "open_questions": [],
  "next_action": "",
  "critical_items": [],
  "memory_refs": []
}
```

A modellnek ezt kell kitöltenie.

Utána a Marvin validálja a JSON-t.

---

# 36. Compaction quality test

Minden compaction után automatikusan futtass egy ellenőrzést.

Például:

```text
QUESTION 1:
What is the current objective?

QUESTION 2:
What has already been completed?

QUESTION 3:
What approaches have failed?

QUESTION 4:
What are the user's hard constraints?

QUESTION 5:
Which files were changed?

QUESTION 6:
What is the next action?

QUESTION 7:
What important numerical values exist?

QUESTION 8:
What decisions were made?
```

A validator az eredeti historyból tudja a helyes választ.

A summary válaszait össze kell hasonlítani.

---

# 37. Memory recall benchmark

A Marvinhoz érdemes saját tesztkészletet létrehozni.

Például 100 mesterséges coding session.

Mindegyikbe elrejtesz:

```text
critical fact
number
decision
rejected approach
file
constraint
error
dependency
```

Majd:

```text
10 compactions
```

után kérdezed:

```text
What was the timeout?
Why did we reject solution B?
Which file contains OAuth?
What was the user's constraint?
What failed previously?
```

Mérd:

```text
exact recall
semantic recall
false recall
contradiction rate
hallucination rate
```

---

# 38. Ne csak recallt mérj

A túl sok memória is probléma.

Mérd:

```text
precision
recall
context size
latency
cost
task success
```

A cél nem:

**maximum memory**

hanem:

**minimum sufficient context.**

---

# 39. Lost-in-the-middle probléma

A hosszú context önmagában sem garancia.

A kutatások szerint a modellek bizonyos hosszú kontextusokban rosszabbul használják a középen elhelyezett információt, mint a context elején vagy végén.

Ezért a kritikus aktív state-et ne egy 80 000 tokenes history közepére temesd.

A context szerkezete legyen:

```text
SYSTEM
↓
CRITICAL REQUIREMENTS
↓
CURRENT PROJECT STATE
↓
CURRENT TASK
↓
RELEVANT RETRIEVED MEMORY
↓
RECENT TOOL RESULTS
↓
RECENT CONVERSATION
↓
CURRENT USER REQUEST
```

A legfontosabb információ legyen jól strukturált és könnyen elérhető.

---

# 40. Progressive disclosure

Ne töltsd be előre:

```text
all memories
all files
all logs
all history
```

Először csak:

```text
index
```

majd:

```text
relevant record
```

majd:

```text
full source
```

ha szükséges.

Ez a coding agenteknél különösen fontos.

---

# 41. Retrieval loop

A Marvin agent loopjába építsd be:

```text
User request
↓
Determine task
↓
Inspect current state
↓
Determine missing information
↓
Retrieve only relevant memory
↓
Build context
↓
LLM
↓
Tool action
↓
Update state
↓
Persist event
↓
Continue
```

Ne:

```text
User
↓
load entire memory
↓
LLM
```

---

# 42. Context compaction loop

A teljes rendszer:

```text
Agent working
        ↓
Token monitor
        ↓
Threshold reached?
   ↓             ↓
  NO            YES
   ↓             ↓
Continue      Pre-checkpoint
                  ↓
             Persist state
                  ↓
             Persist events
                  ↓
             Create summary
                  ↓
             Validate summary
                  ↓
             Repair if needed
                  ↓
             Store summary
                  ↓
             Replace old context
                  ↓
             Rebuild context
                  ↓
             Resume agent
```

---

# 43. A legjobb megoldás: lossless-ish compaction

A teljesen veszteségmentes context-compression nagyon nehéz.

De a rendszer viselkedhet **gyakorlatilag losslessként**.

Ehhez:

```text
active context:
compressed

archive:
lossless
```

Ez a legfontosabb elv.

A LCM kutatás pontosan ezt az irányt követi: hierarchikus summary DAG, amely a tömörített állapotból visszamutat az eredeti tartalomra.

---

# 44. Memory DAG

A memória ne egyszerű lista legyen.

Legyen kapcsolatrendszer:

```text
DEC-017
   ↓
FILE-022
   ↓
EVENT-184
   ↓
TEST-203
```

Például:

```text
Decision:
OAuth

affected:
auth.ts

verified by:
test-auth.ts

source:
EVENT-184
```

Ez lehetővé teszi, hogy az agent ne csak similarity alapján keressen.

---

# 45. „Why?” retrieval

A Marvinnak tudnia kell válaszolni:

```text
Why did we do this?
```

Nem csak:

```text
What did we do?
```

Ezért a decision memory tartalmazza:

```text
decision
reason
alternatives
rejected alternatives
evidence
consequences
```

---

# 46. Task boundary detection

A Marvin automatikusan érzékelje:

```text
feature complete
bug fixed
test passed
commit created
user changed objective
```

Ekkor:

```text
checkpoint
```

készüljön.

Ez jelentősen stabilabb, mint a kizárólag token-alapú compaction.

---

# 47. User-request change detection

Ha a user teljesen más feladatra vált:

```text
Task A
```

→

```text
Task B
```

ne cipeld az A feladat összes részletét.

A Marvin készítsen:

```text
TASK A SNAPSHOT
```

majd új working contextet építsen.

Ez az **isolation**.

A LangChain context-engineering megközelítése is külön kezeli a context írását, kiválasztását, tömörítését és izolálását.

---

# 48. Multi-agent esetén külön memory namespace

Ha Marvin később több agentet használ:

```text
planner
coder
tester
researcher
reviewer
```

ne ugyanazt a teljes contextet kapják.

Legyen:

```text
global memory
project memory
task memory
agent memory
```

Például:

```text
planner/*
coder/*
tester/*
```

A coder ne kapja meg automatikusan a researcher összes outputját.

---

# 49. Memory write policy

Ne minden információ kerüljön persistent memoryba.

Különítsd el:

```text
ephemeral
session
task
project
persistent
```

Például:

```text
"User said hello"
→ ephemeral

"Currently debugging OAuth"
→ task

"Project uses TypeScript"
→ project

"Never use API keys"
→ persistent/project constraint
```

---

# 50. Memory consolidation

Időnként a Marvin futtasson consolidationt.

Például:

```text
FACT-001:
Python 3.12

FACT-017:
Project currently uses Python 3.12

FACT-044:
requirements specify Python >=3.12
```

ezeket össze lehet vonni:

```text
PROJECT-CONSTRAINT-003:
Python >=3.12
```

De az eredeti rekordokat nem kell törölni.

---

# 51. Memory decay

Nem minden információ egyformán értékes örökre.

Lehet:

```text
critical → never decay
important → slow decay
normal → decay
temporary → fast decay
```

De a decay csak az aktív contextben történjen.

Az archive maradjon.

---

# 52. Tool-result compaction külön algoritmus legyen

Ne ugyanazt a compactor promptot használd:

```text
conversation compaction
```

és:

```text
tool output compaction
```

A tool outputnak más szerkezete van.

Például test output:

```text
summary
pass/fail
failed tests
root cause
relevant stack trace
artifact reference
```

Git diff:

```text
files
added
removed
changed
semantic impact
```

Browser:

```text
source
facts
relevant URLs
important quotes
retrieval reference
```

---

# 53. Compaction legyen provider-independent

Marvin ne Claude-specifikus legyen.

Legyen:

```text
ContextManager
    ├── AnthropicAdapter
    ├── OpenAIAdapter
    ├── GeminiAdapter
    ├── PerplexityAdapter
    └── LocalModelAdapter
```

A context manager saját logikája legyen.

A provider csak ezt mondja:

```text
max_context_tokens
input_token_count
output_limit
supports_compaction
supports_cache
```

---

# 54. Provider-native compaction használata, ha elérhető

Ha egy provider saját compactiont kínál, azt is érdemes támogatni.

Anthropic jelenleg server-side compactiont ajánl hosszú beszélgetésekhez és agentikus workflow-khoz.

Marvin ezért tudjon két módban működni:

```text
MODE A:
Provider-native compaction

MODE B:
Marvin-managed compaction
```

A Marvin-managed mód kell ahhoz, hogy saját memory architecture-t használj.

---

# 55. Context budget

A Marvinnak legyen saját context budgetje:

```text
MODEL LIMIT
    ↓
SAFETY RESERVE
    ↓
SYSTEM RESERVE
    ↓
OUTPUT RESERVE
    ↓
WORKING CONTEXT
```

Például egy 200k modellnél:

```text
200k model limit

20k safety/output reserve

180k usable

80k working context

remaining information:
external memory
```

A tényleges számokat benchmarkkal kell meghatározni.

Ne egyetlen fix `50,000` értéket hardcode-olj minden modellre.

---

# 56. Modell-specifikus threshold

A konfiguráció legyen:

```yaml
context:
  target_utilization: 0.65
  compact_at: 0.70
  emergency_at: 0.85
  reserve: 0.15
```

Így:

```text
Claude:
dynamic

GPT:
dynamic

Gemini:
dynamic
```

---

# 57. Compaction trigger legyen előrejelző

A még jobb rendszer nem csak a jelenlegi tokeneket nézi.

Hanem:

```text
current tokens
+
estimated next tool output
+
estimated next response
```

Ha:

```text
current = 42k
next tool output = 15k
next response = 5k
```

akkor már előre tudható:

```text
42 + 15 + 5 = 62k
```

Ezért lehet compactiont még a következő tool call előtt indítani.

---

# 58. Ne compactálj aktív kritikus művelet közben

Ha az agent:

```text
editing file
running migration
debugging failure
```

közben van, ne feltétlenül szakítsd meg.

Várj:

```text
task boundary
```

ha van rá lehetőség.

Ez javítja az agent folytonosságát.

---

# 59. Async compaction

Ha a Marvin architektúrája engedi:

```text
main agent
       ↓
continues working

background:
context compactor
```

A háttérben elő lehet készíteni az új summaryt.

Ez különösen hasznos hosszú munkameneteknél.

A Codex fejlesztői közösségében is felmerült az ilyen background compaction igénye.

---

# 60. Compaction után ne kezdjen mindent újra

Az új context elején legyen:

```text
RESUMED SESSION

Objective:
...

Current state:
...

Last completed action:
...

Known constraints:
...

Do not repeat:
...

Next action:
...
```

A modellnek azonnal tudnia kell:

**where am I?**

és:

**what do I do next?**

---

# 61. A „next action” legyen kötelező

Minden compaction végén legyen egyetlen:

```text
NEXT ACTION
```

ne csak:

```text
remaining tasks:
A
B
C
D
```

Például:

```text
NEXT ACTION:
Run the OAuth integration test after restarting the local server.
```

Ez megakadályozza, hogy az agent újratervezze az egész projektet.

---

# 62. State machine

A projekt állapota lehet:

```text
PLANNING
IMPLEMENTING
TESTING
DEBUGGING
BLOCKED
WAITING_USER
COMPLETED
```

A compaction ezt is mentse.

---

# 63. A context nem egyetlen „agy”

A te korábbi megfogalmazásoddal élve:

**a modell az agy, de a Marvin legyen az operációs rendszer.**

Az agy nem tudhat mindent egyszerre.

A Marvin feladata:

```text
what to show
what to hide
what to save
what to retrieve
what to compress
what to preserve
```

Pont ez a váltás a sima chatbot és a komoly agent között.

---

# 64. A teljes Marvin architektúra

A végső rendszer így nézzen ki:

```text
                    ┌─────────────────────┐
                    │     USER REQUEST    │
                    └──────────┬──────────┘
                               ↓
                    ┌─────────────────────┐
                    │   TASK MANAGER      │
                    └──────────┬──────────┘
                               ↓
                    ┌─────────────────────┐
                    │ CONTEXT BUILDER     │
                    └──────────┬──────────┘
                               ↓
          ┌────────────────────┼────────────────────┐
          ↓                    ↓                    ↓
   PROJECT STATE        MEMORY RETRIEVAL      RECENT EVENTS
          ↓                    ↓                    ↓
          └────────────────────┼────────────────────┘
                               ↓
                    ┌─────────────────────┐
                    │    LLM / AGENT      │
                    └──────────┬──────────┘
                               ↓
                       TOOL EXECUTION
                               ↓
                    ┌─────────────────────┐
                    │ EVENT PERSISTENCE   │
                    └──────────┬──────────┘
                               ↓
                    ┌─────────────────────┐
                    │ TOKEN MONITOR       │
                    └──────────┬──────────┘
                               ↓
                        threshold?
                       /           \
                     NO             YES
                     ↓               ↓
                  continue     PRE-CHECKPOINT
                                     ↓
                              SAVE EVERYTHING
                                     ↓
                                COMPACTOR
                                     ↓
                              VALIDATOR
                                     ↓
                              REPAIR IF NEEDED
                                     ↓
                           HIERARCHICAL SUMMARY
                                     ↓
                             CONTEXT REBUILD
                                     ↓
                               AGENT RESUME
```

---

# 65. A legfontosabb szabályok röviden

A Marvin context systemjének ezeket kell betartania:

```text
1. Never delete raw history.

2. Never rely on one summary as the only memory.

3. Keep critical instructions outside compaction.

4. Keep structured project state separately.

5. Persist decisions separately.

6. Persist rejected approaches separately.

7. Persist exact numerical/technical values.

8. Persist file state separately from conversation memory.

9. Store full tool outputs outside active context.

10. Use retrieval instead of dumping all memory into context.

11. Use hybrid retrieval.

12. Give memories stable IDs.

13. Keep provenance for important facts.

14. Detect contradictions.

15. Track superseded information.

16. Compact before the hard context limit.

17. Prefer task boundaries for compaction.

18. Checkpoint before compaction.

19. Validate after compaction.

20. Repair failed compactions from raw memory.

21. Use hierarchical summaries.

22. Avoid summary-of-summary drift.

23. Keep a single explicit NEXT ACTION.

24. Keep current project state near the beginning of context.

25. Keep critical requirements pinned.

26. Treat tool output separately.

27. Use Git as source-of-truth for code.

28. Separate task memory from project memory.

29. Isolate unrelated tasks.

30. Benchmark recall after repeated compactions.
```

---

# 66. Amit én konkrétan a Marvinban megvalósítanék

Első verzióban ezt a 8 komponenst építeném meg:

```text
1. ContextMonitor
2. StateStore
3. EventStore
4. CompactionEngine
5. CompactionValidator
6. MemoryRetriever
7. ContextBuilder
8. CheckpointManager
```

A directory:

```text
marvin/
    context/
        monitor
        builder
        budget
    memory/
        state
        events
        decisions
        facts
        summaries
        archive
        retrieval
    compaction/
        engine
        validator
        repair
    checkpoints/
    project/
```

---

# 67. A sorrend, amelyben megépíteném

## Phase 1

Token monitor.

```text
current_tokens
context_limit
remaining_tokens
utilization
```

## Phase 2

Structured project state.

## Phase 3

Raw event store.

## Phase 4

Pre-compaction checkpoint.

## Phase 5

LLM-based compaction.

## Phase 6

Post-compaction validator.

## Phase 7

Memory retrieval.

## Phase 8

Decision/rejected-approach memory.

## Phase 9

Tool-output management.

## Phase 10

Hierarchical compaction.

## Phase 11

Automatic task-boundary checkpoints.

## Phase 12

Benchmarking and tuning.

---

# 68. A legfontosabb fejlesztési elv

Ne azt próbáld elérni, hogy:

**„A summary olyan jó legyen, hogy az AI mindent megjegyezzen.”**

A cél inkább:

**„Ha az AI elfelejt valamit az aktív contextből, a Marvin 1–2 művelettel vissza tudja szerezni.”**

Ez sokkal robusztusabb.

A modern kutatási irányok is ebbe mennek: hierarchical memory, retrieval, explicit addressing, persistent state és validated compaction kombinációja.

---

# 69. A végső modell

A Marvinnak ne:

```text
CONTEXT = conversation
```

legyen a mentális modellje.

Hanem:

```text
CONTEXT = WORKING SET

MEMORY = EVERYTHING PERSISTENT

RETRIEVAL = PAGE DATA INTO CONTEXT

COMPACTION = REMOVE FROM WORKING SET

ARCHIVE = NEVER DELETE

STATE = STRUCTURED CURRENT TRUTH

EVENTS = HISTORICAL PROVENANCE
```

Ez már lényegében egy **LLM memory hierarchy**.

A 2026-os kutatás ezt egyre inkább a klasszikus számítógépes memóriához hasonlítja: a context window inkább gyors, drága working memory, nem pedig a teljes memória.

---

# 70. Konkrét ajánlás a te Marvinodhoz

A jelenlegi célodhoz én ezt választanám:

```text
ACTIVE CONTEXT:
~50–80k token célérték

COMPACTION:
proaktív, nem vészhelyzeti

MEMORY:
SQLite + filesystem

RAW HISTORY:
append-only

CODE:
filesystem + Git

STRUCTURED STATE:
JSON/SQLite

RETRIEVAL:
BM25 + semantic search

CRITICAL MEMORY:
pinned

DECISIONS:
separate records

FAILED APPROACHES:
separate records

TOOL OUTPUT:
externalized + addressable

COMPACTION:
hierarchical

VALIDATION:
mandatory

REPAIR:
automatic

PROVENANCE:
mandatory

TASK BOUNDARIES:
automatic checkpoints

PROVIDER:
model-independent
```

**Ez az a felépítés, amit én a Marvinban választanék.**

Nem egyszerű „50 000 token után összefoglaljuk a chatet” rendszert építenék. Az túl törékeny. A komoly megoldás az, hogy a **50–80k csak az aktív munkamemória**, miközben a Marvin mögötte megtartja a teljes projektállapotot, a döntéseket, a hibákat, a tool outputokat és az eredeti historyt, és szükség esetén vissza tudja tölteni őket.

Ez azért is fontos, mert a hosszú kontextus önmagában nem oldja meg a problémát: a „lost in the middle” jelenség miatt a modellek nagy contextben sem feltétlenül használják egyformán jól az összes információt.

**A következő technikai lépésként a Marvin konkrét kódját kell ehhez igazítani:** először meg kell nézni, hogy a jelenlegi Marvinban **hol épül fel a messages/context tömb, hol számolja a tokeneket, hol történik a Claude API-hívás, és hol tárolja a sessiont**. Ez alapján lehet ezt a fenti architektúrát közvetlenül a projektbe beépíteni, nem egy általános mintaként, hanem konkrét fájlokra és függvényekre lebontva.
