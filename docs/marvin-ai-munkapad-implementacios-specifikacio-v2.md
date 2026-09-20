# Marvin AI Munkapad – Implementációs specifikáció v2

**Állapot:** implementálás előtti architekturális döntési változat  
**Alap:** az eredeti Marvin AI Munkapad specifikáció + a Marvin (Opus 4.8) felülvizsgálata

## 0. Kötelező architektúra-döntések

### 0.1 Agent-runtime

A Munkapad számára interaktív, szerveroldali agent-runtime készül, amely támogatja:

- természetes nyelvű beszélgetést;
- streaming választ;
- projekt- és Work Item-kontextust;
- tervkészítést;
- tool-hívásokat;
- preview-t;
- verziózást;
- háttérben futó hosszú műveleteket.

A Munkapad **nem épít különálló agent-infrastruktúrát**. A meglévő Marvin agent/fleet infrastruktúrával közös provider-, usage-, approval- és audit-réteget kell használnia.

```text
Marvin Agent Infrastructure
        │
   ┌────┴────┐
   │         │
 Fleet    Workbench Agent
   │         │
   └────┬────┘
        │
 Shared Usage / Rate Limit
        │
   AI Providers
```

### 0.2 Közös 5 órás usage/rate-limit

A fleet és a Munkapad ugyanazt a usage/rate-limit rendszert használja.

Szükséges központi komponens:

```text
UsageManager
 ├── getUsage()
 ├── getRemaining()
 ├── reserve()
 ├── release()
 ├── record()
 └── getWindow()
```

Minden Claude/Anthropic-hívást ezen keresztül kell kezelni, hogy a Munkapad ne használja fel kontroll nélkül a fleet keretét.

### 0.3 Jogosultság és approval

Nem készül második jogosultsági rendszer.

A tényleges engedélyezési igazság:

```text
autonomy-config
+
existing approvals
```

A Tool Registry technikai metaadatokat tarthat:

```text
destructive
reversible
external_effect
estimated_cost
```

de ezek a meglévő Marvin autonomy/approval rendszerére legyenek leképezve.

Példák:

```text
file.read       → automatikus
file.write      → autonomy alapján
file.delete     → szükség esetén approval
external_message→ approval
payment         → approval
social.publish  → approval
```

A meglévő `/api/approvals` rendszert kell újrahasznosítani.

---

# 1. Capability / Dependency Manager

A Munkapadnak friss telepítésen is használhatónak kell maradnia.

Az opcionális/nehezebb komponensek:

- ONLYOFFICE;
- LibreOffice;
- FFmpeg;
- Remotion render pipeline;
- Chromium render;
- külső AI providerek

hiánya ne okozzon általános rendszerhibát.

A Marvin Capability / Dependency Manager mutassa:

```text
PDF
✓ Elérhető

DOCX preview
✓ Elérhető

DOCX beágyazott szerkesztés
⚠ Nincs beállítva
[Beállítás]

Videó render
⚠ Nincs beállítva
[Beállítás]

Veo
⚠ API-kulcs nincs megadva
[Beállítás]
```

A hiányzó capability esetén a Marvin adja meg:

- mi hiányzik;
- melyik funkció érintett;
- hogyan állítható be;
- szükség esetén hol szerezhető be;
- milyen állapotban van a konfiguráció.

---

# 2. Friss telepítés és Provider Setup

A beállítás legyen UI-ból végigvezethető:

```text
detect
→ explain
→ configure/install
→ verify
→ enable
```

A külső providerekhez:

```text
Anthropic
Google Gemini
Google Veo
ElevenLabs
```

legyen Provider Setup Wizard.

Mutassa:

- mire használható;
- szükséges API-kulcs;
- hol szerezhető be;
- költségre vonatkozó információ;
- kapcsolat állapota;
- tesztelési lehetőség.

API-kulcs soha ne kerüljön:

- frontendbe;
- chatbe;
- localStorage-ba;
- Work Item manifestbe.

Csak szerveroldali konfigurációban tárolható.

---

# 3. Munkapad

A Projekt elsődleges munkanézete:

```text
MUNKAPAD
```

A dashboard az áttekintéshez való; a Munkapad a tényleges munkavégzés helye.

```text
┌────────────────┬──────────────────────────────────┬─────────────────┐
│ MUNKADARABOK   │          AKTUÁLIS MUNKA          │ KONTEXTUS       │
│                │                                  │                 │
│ Fájlok         │          PREVIEW / EDITOR        │ Projekt         │
│ Munkák         │                                  │ Work Item       │
│ Dokumentumok   │          ▶ LEJÁTSZÁS             │ Kanban          │
│ Képek          │                                  │ Verziók         │
│ Grafikák       │                                  │ AI műveletek    │
│ Videók         │                                  │                 │
└────────────────┴──────────────────────────────────┴─────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ AI AGENT CHAT                                                       │
│ [ szövegbevitel ... ]                              Küldés            │
└─────────────────────────────────────────────────────────────────────┘
```

A középső panel mindig az aktuális Work Item típusának megfelelő preview/editor felületet mutatja.

---

# 4. Agent Chat

A chat ne parancssor legyen.

A felhasználó:

- kérdezhet;
- véleményt kérhet;
- módosítást kérhet;
- döntést beszélhet meg;
- jóváhagyhat;
- visszautasíthat;
- új irányt adhat.

Példa:

```text
User:
Szerinted a második jelenet túl gyors?

Agent:
A jelenlegi ritmusban rövidnek érződik.
2 másodperccel meghosszabbítanám.
Megcsináljam?

[ Igen, csináld ] [ Másképp ] [ Nem ]
```

Műveleti ciklus:

```text
user
→ agent
→ terv
→ approval, ha szükséges
→ tool
→ eredmény
→ verzió
→ preview
→ agent válasz
```

---

# 5. Agent Orchestrator

Feladata:

1. user message fogadása;
2. session betöltése;
3. projektkontextus;
4. Work Item-kontextus;
5. releváns fájlok;
6. agent inference;
7. terv;
8. tool kiválasztása;
9. approval ellenőrzés;
10. tool végrehajtás;
11. eredmény ellenőrzés;
12. verzió;
13. preview;
14. UI frissítés;
15. agent válasz;
16. audit.

---

# 6. Tool Registry

Az agent kizárólag engedélyezett toolokon keresztül dolgozhat.

Alap toolok:

```text
file.read
file.write
file.copy
file.move
file.rename
file.delete
file.preview

project.get
project.getContext
project.listFiles
project.listWorkItems
project.listKanban

workItem.create
workItem.open
workItem.update
workItem.attachFile
workItem.createVersion
workItem.restoreVersion
workItem.compareVersions

document.read
document.modify
document.exportPdf
document.renderPreview

graphic.create
graphic.readScene
graphic.setText
graphic.moveObject
graphic.resizeObject
graphic.deleteObject
graphic.addObject
graphic.export

image.generate
image.edit
image.upscale
image.removeBackground

video.create
video.addScene
video.replaceScene
video.removeScene
video.editTimeline
video.addText
video.addImage
video.addAudio
video.setTransition
video.render

preview.create
preview.refresh
preview.open
preview.compare
```

---

# 7. Provider abstraction

A Marvin üzleti logikája providerfüggetlen legyen.

```text
AIProvider
 └── AnthropicProvider

ImageProvider
 └── GeminiImageProvider

VideoProvider
 └── VeoProvider

AudioProvider
 └── ElevenLabsProvider

DocumentProvider
 └── OnlyOfficeProvider

RenderProvider
 ├── RemotionProvider
 └── FFmpegProvider
```

Későbbi provider hozzáadása ne igényelje a Workbench újraírását.

---

# 8. PDF és DOCX

## PDF

PDF preview:

```text
pdfjs-dist
```

Támogatás:

- megnyitás;
- lapozás;
- zoom;
- keresés;
- thumbnail;
- preview;
- verziózás.

## DOCX V1

Az első DOCX-megoldás legyen könnyű:

- DOCX beolvasás;
- preview;
- LibreOffice headless konverzió;
- PDF preview;
- letöltés/módosítás/újrafeltöltés;
- verziózás.

Az ONLYOFFICE beágyazott editor későbbi bővítés legyen, ne kötelező V1-komponens.

---

# 9. Grafika és kép

Strukturált grafikához:

```text
Fabric.js
```

Az objektumok stabil ID-val rendelkezzenek.

```json
{
  "id": "headline",
  "type": "text",
  "x": 400,
  "y": 100,
  "width": 800,
  "fontSize": 72,
  "text": "Ride for less"
}
```

Így az agent strukturáltan módosíthat:

> „A címet tedd 30%-kal nagyobbra és középre.”

Képgenerálás támogassa:

- text-to-image;
- image-to-image;
- image edit;
- háttérmódosítás;
- tárgymódosítás;
- upscale;
- export.

---

# 10. Videó – külön fejlesztési Epic

A videó ne legyen az első MVP része.

Külön Epic:

```text
AI Video Generation
Video Composition
Video Rendering
```

Későbbi komponensek:

```text
Veo
Remotion
FFmpeg
Audio provider
Timeline
Scene model
Render queue
Video preview
Versioning
```

A videó csak a stabil kép/grafika, dokumentum és Munkapad-alap után kezdhető.

---

# 11. Preview

Preview adapterek:

```text
PdfPreview
DocumentPreview
ImagePreview
GraphicPreview
VideoPreview
AudioPreview
```

A preview:

- cache-elhető;
- verzióhoz kötött;
- újragenerálható;
- gyorsan megnyitható.

---

# 12. Verziózás

Minden jelentős agent-módosítás új verzió.

```text
v1
v2
v3
v4
```

Az eredeti automatikusan nem írható felül.

Restore:

```text
v1
v2
v3
v4

Restore v2

→ v5 = v2 állapotának új verziója
```

A későbbi verziók nem törlődnek.

---

# 13. Asset-retention és Garbage Collection

A hash-alapú deduplikáció mellé retention/GC kell.

Asset metaadat:

```text
hash
path
size
mime
created_at
last_referenced_at
reference_count
retention_status
```

Állapotok:

```text
Active
Protected
Unreferenced
Pending GC
Deleted
```

Automatikus törlés csak akkor történhet, ha az asset:

- nincs aktív verzióban;
- nincs futó jobban;
- nincs restore pont;
- nincs védett retention alatt.

---

# 14. Adatbázis

## `work_items`

```text
id
project_id
type
title
status
source_path
editor_type
current_version_id
created_at
updated_at
created_by
```

## `work_item_versions`

```text
id
work_item_id
version_no
parent_version_id
manifest_path
preview_path
prompt
created_by
created_at
metadata_json
```

## `work_item_assets`

```text
id
work_item_id
version_id
asset_hash
path
mime_type
size
role
created_at
```

## `agent_sessions`

```text
id
project_id
work_item_id
started_at
ended_at
status
language
```

## `agent_messages`

```text
id
session_id
role
content
created_at
```

## `agent_tool_calls`

```text
id
session_id
tool_name
input_json
output_json
status
started_at
finished_at
```

## `render_jobs`

```text
id
work_item_id
version_id
job_type
provider
status
progress
output_path
error
created_at
started_at
finished_at
```

---

# 15. Job Queue

Hosszú műveletek háttérben fussanak:

- image generation;
- video generation;
- video render;
- PDF export;
- document conversion;
- preview generation;
- audio generation.

Állapotok:

```text
queued
running
completed
failed
cancelled
```

A chat a háttérjob közben is használható marad.

---

# 16. Projektkontextus

Az agent ne kapja meg automatikusan az egész projektet.

Releváns kontextus:

```text
Project
+
Current Work Item
+
Current Version
+
Relevant Files
+
Kanban Card
+
Project Instructions
+
Recent Agent Conversation
+
Relevant Memory
```

A kontextus legyen relevancia- és méretkorlátos.

Az agent ne találja ki a rendszerállapotot. Ha nincs adat, ezt jelezze.

---

# 17. Kanban-integráció

A Work Item opcionálisan kapcsolható Kanban-kártyához.

Kanbanból:

```text
Megnyitás a Munkapadon
```

Work Itemből:

```text
Megnyitás Kanbanban
```

A kapcsolat ne másolja az adatokat.

---

# 18. HU / EN

A teljes UI kétnyelvű:

```text
HU | EN
```

Minden UI-szövegnek legyen fordítása.

A meglévő Marvin:

- lang parity;
- no-hardcoded-HU

ellenőrzéseit kell alkalmazni.

A Work Item tartalma ettől független nyelvű lehet.

---

# 19. Audit

A meglévő `store/agent-audit.jsonl` mintát kell újrahasznosítani.

Naplózandó:

```text
timestamp
user
project
work_item
session
tool
input
output
status
duration
```

Nem készül párhuzamos auditmechanizmus.

---

# 20. Biztonság

API-kulcs:

- csak szerveroldalon;
- konfigurációban;
- frontendből nem elérhető;
- chatből nem olvasható;
- manifestbe nem kerülhet.

Az agent csak engedélyezett projektútvonalakon dolgozhat.

Minden fájlútvonalat validálni kell.

A feltöltött fájlokat MIME + extension + tényleges tartalom alapján kell ellenőrizni.

---

# 21. Fork-barát implementáció

A Munkapad külön, moduláris réteg legyen:

```text
workbench/
├── components/
├── work-items/
├── agent/
├── editors/
├── providers/
└── jobs/
```

A meglévő Marvin UI és szerver módosításait modulárisan kell tartani.

Semmilyen host, path, API key vagy azonosító ne legyen hardcoded.

---

# 22. Fejlesztési sorrend

```text
1. Workbench alap
2. Agent
3. közös UsageManager
4. meglévő Approvals/Autonomy integráció
5. Preview
6. Versioning
7. File handling
8. PDF
9. DOCX
10. Graphic
11. Image
12. Capability/Dependency Manager
13. Provider Setup
14. Security + Audit
15. Retention + GC
16. E2E stabilizálás
17. külön Video Epic
```

---

# 23. Első vertical slice

Az első teljes végponttól végpontig működő példa:

```text
Projekt
 ↓
Munkapad
 ↓
+ Új munkadarab
 ↓
Kép / grafika
 ↓
Agent chat
 ↓
„Készíts egy Facebook reklámot.”
 ↓
Image generation
 ↓
Fabric canvas
 ↓
„A címet tedd nagyobbra és középre.”
 ↓
Agent tool call
 ↓
Canvas módosítás
 ↓
Preview
 ↓
v2
 ↓
Export
```

Ez legyen a stabil alap a későbbi dokumentum- és videóréteghez.

---

# 24. Második vertical slice – DOCX/PDF

```text
Projekt
 ↓
Munkapad
 ↓
DOCX
 ↓
Preview
 ↓
Agent
 ↓
„A 2. fejezetet rövidítsd le.”
 ↓
Dokumentummódosítás
 ↓
Preview
 ↓
v2
 ↓
PDF export
```

---

# 25. Későbbi videó vertical slice

```text
Projekt
 ↓
Munkapad
 ↓
Videó Work Item
 ↓
Agent chat
 ↓
„Készíts 20 mp-es bemutatkozó videót.”
 ↓
Story plan
 ↓
Veo scenes
 ↓
Voice
 ↓
Remotion timeline
 ↓
Preview
 ↓
User feedback
 ↓
Scene replacement
 ↓
Render
 ↓
v2
```

---

# 26. Elfogadási feltételek

A Munkapad akkor tekinthető késznek, ha:

1. projektből egy kattintással elérhető;
2. Work Item létrehozható;
3. Work Item megnyitható;
4. középen tényleges preview jelenik meg;
5. alul agent chat működik;
6. az agent kérdésre válaszol;
7. az agent műveletet hajt végre;
8. a művelet eredménye previewban megjelenik;
9. jelentős módosítás új verzió;
10. korábbi verzió visszaállítható;
11. hosszú művelet háttérben fut;
12. a user közben tovább beszélhet az agenttel;
13. Work Item projekt ID-hoz kötött;
14. Kanbanhoz kapcsolható;
15. fájlokhoz kapcsolható;
16. HU/EN működik;
17. hiányzó capability emberi módon jelenik meg;
18. agent nem írja felül automatikusan az eredetit;
19. tool-hívások auditálhatók;
20. API-kulcsok nem kerülnek kliensoldalra;
21. Munkapad és fleet közös usage/rate-limit rendszert használ;
22. a meglévő approval/autonomy rendszer az egyetlen tényleges engedélyezési mechanizmus;
23. asset GC nem töröl aktív vagy védett adatot;
24. külső providerek beállíthatók a Marvin UI-ból;
25. opcionális komponens hiánya nem teszi használhatatlanná a Munkapadot.

---

# 27. Végleges működési modell

A Marvin Projekt ne egyszerű dashboard legyen.

A projekt legyen egy AI-alapú munkakörnyezet:

```text
MEGBESZÉLÉS
    ↓
TERV
    ↓
VÉGREHAJTÁS
    ↓
PREVIEW
    ↓
VISSZAJELZÉS
    ↓
MÓDOSÍTÁS
    ↓
ÚJ VERZIÓ
    ↓
PREVIEW
```

A felhasználó természetes nyelven beszél az agenttel.

Az agent:

- megérti a projektet;
- látja az aktuális munkadarabot;
- kérdez, ha szükséges;
- javaslatot tesz;
- a megfelelő toolt használja;
- végrehajtja a műveletet;
- preview-t készít;
- új verziót hoz létre;
- megmutatja az eredményt;
- reagál a következő visszajelzésre.

A Marvin így egységes AI munkakörnyezetként működik, amely a megfelelő dokumentum-, grafikai-, kép-, média- és AI-motorokat a háttérben használja.

---

# 28. Döntési alap

A v2 változat az eredeti Munkapad-specifikációt nem váltja le tartalmilag, hanem a Marvin felülvizsgálatából származó, implementáció előtt kötelező döntéseket építi be.

A legfontosabb lezárt döntések:

1. interaktív szerveroldali Munkapad-agent;
2. közös Marvin agent-infrastruktúra;
3. közös 5 órás usage/rate-limit;
4. meglévő autonomy + approvals használata;
5. Capability/Dependency Manager;
6. UI-alapú provider setup;
7. graceful degradation;
8. DOCX V1 könnyű út, ONLYOFFICE később;
9. videó külön későbbi Epic;
10. asset retention + garbage collection;
11. moduláris/fork-barát Workbench;
12. kötelező HU/EN parity.
