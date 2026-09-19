# Marvin AI Munkapad – Implementációs specifikáció

**Dokumentum típusa:** végleges implementációs specifikáció  
**Cél:** a Marvin Projektek moduljának AI-alapú, tényleges munkavégzésre alkalmas Munkapaddá bővítése  
**Állapot:** implementálásra kész műszaki terv  
**Nyelv:** magyar  
**Elsődleges UI:** magyar, HU/EN váltással  
**Alapelv:** a Projekt a kontextus, a Work Item a konkrét munkadarab, az Agent a munkavégző intelligencia, a preview a vizuális visszajelzés, a verziózás pedig minden módosítás biztonsági hálója.

---

# 1. Rendszercél

A Marvin Projektek modulja ne kizárólag projekt-dashboard legyen. A projektoldalnak két külön szerepet kell ellátnia:

1. **Áttekintés:** megmutatja, mi történik a projektben.
2. **Munkapad:** lehetővé teszi a tényleges munkavégzést AI-agent segítségével.

A Munkapad fő működési ciklusa:

```text
Felhasználó
    ↓
Agent chat
    ↓
Feladat megértése
    ↓
Terv / kérdés / javaslat
    ↓
Felhasználói jóváhagyás, ha szükséges
    ↓
Tool / szakmai motor kiválasztása
    ↓
Munkadarab módosítása vagy létrehozása
    ↓
Preview / render
    ↓
Új verzió
    ↓
Felhasználói visszajelzés
    ↓
Agent
    ↓
Új verzió
```

A rendszernek támogatnia kell legalább:

- szöveges munkát;
- PDF-et;
- DOCX-et;
- képeket;
- grafikákat;
- videót;
- videógenerálást;
- videóösszeállítást;
- hangot/narrációt;
- preview-t;
- verziózást;
- AI-agent chatet;
- projektkontextust;
- fájlkezelést;
- háttérben futó render/generálási feladatokat;
- HU/EN munkafolyamatot;
- Kanban ↔ Work Item kapcsolatot.

---

# 2. Kötelező architekturális alapelvek

## 2.1. Marvin nem legyen minden szakmai program másolata

Nem készül saját:

- Photoshop-klón;
- Premiere-klón;
- Word-klón;
- Acrobat-klón;
- Canva-klón.

A Marvin egységes AI-munkakörnyezetet biztosít, és adaptereken keresztül használja a megfelelő dokumentum-, grafikai-, média- és AI-motorokat.

## 2.2. Egy objektum, több nézet

A projektobjektumok között ne legyen felesleges másolat.

```text
Project
 ├── Kanban
 ├── Ideas
 ├── Files
 ├── Work Items
 └── Agent Sessions
```

A Kanban-kártya, fájl és Work Item kapcsolata legyen explicit és lekérdezhető.

## 2.3. A Work Item nem azonos a fájllal

Egy Work Item egy munkafolyamatot képviselhet, amelyhez több fájl, asset, preview, verzió és AI-művelet tartozik.

Példa:

```text
Freeber bemutatkozó videó
 ├── brief
 ├── storyboard
 ├── scene-01.mp4
 ├── scene-02.mp4
 ├── voice.mp3
 ├── music.mp3
 ├── logo.png
 ├── timeline/project.json
 └── final.mp4
```

## 2.4. Eredeti fájlt ne írjon felül automatikusan az agent

Az alapértelmezett folyamat:

```text
Original
   ↓
Draft
   ↓
Preview
   ↓
Version
   ↓
Approval
   ↓
Final
```

## 2.5. Destruktív és külső hatású műveletekhez jóváhagyás kell

Automatikusan végezhető például:

- olvasás;
- preview készítés;
- új draft;
- új verzió;
- render;
- képgenerálás;
- videógenerálás;
- grafikai objektum módosítása.

Megerősítés szükséges például:

- eredeti törlése;
- eredeti felülírása;
- projektfájl végleges törlése;
- külső szolgáltatásba feltöltés;
- publikálás;
- közösségi média közzététel;
- email küldés;
- jelentős költségű AI-művelet.

---

# 3. Projektstruktúra

A meglévő Projektek modul maradjon a rendszer alapja.

```text
Iroda
└── Projektek
    ├── Marvin fejlesztés
    │   ├── Munkapad
    │   ├── Áttekintés
    │   ├── Kanban
    │   ├── Ötletek
    │   └── Fájlok
    │
    └── Freeber
        ├── Munkapad
        ├── Áttekintés
        ├── Kanban
        ├── Ötletek
        └── Fájlok
```

A projekt továbbra is:

- adatbázis-objektum;
- fizikai projektmappa;
- meglévő Marvin-objektumok szűrt nézete;
- AI-munkafolyamat kontextusa.

A projektnek legyen:

- belső 8 karakteres Marvin ID-je;
- neve;
- slugja;
- leírása;
- státusza;
- `folder_path`;
- opcionális „Kinek készül?” / ügyfél mezője;
- létrehozási és módosítási adatai.

---

# 4. Munkapad UI

## 4.1. Fő navigáció

A projektoldalon a fülek:

```text
MUNKAPAD | ÁTTEKINTÉS | KANBAN | ÖTLETEK | FÁJLOK
```

A **Munkapad legyen az első és alapértelmezett nézet**.

## 4.2. Három fő terület

```text
┌────────────────┬──────────────────────────────────┬─────────────────┐
│ PROJEKT /       │                                  │ KONTEXTUS       │
│ MUNKADARABOK    │         AKTUÁLIS MUNKA          │                 │
│                 │                                  │ Projekt         │
│ Fájlok          │          PREVIEW / EDITOR        │ Work Item       │
│ Munkák          │                                  │ Kanban          │
│ Videók          │          ▶ LEJÁTSZÁS             │ Fájlok           │
│ Grafikák        │                                  │ Verziók          │
│ Dokumentumok    │                                  │ AI műveletek    │
│ Képek           │                                  │                 │
└────────────────┴──────────────────────────────────┴─────────────────┘
┌─────────────────────────────────────────────────────────────────────┐
│ AI AGENT CHAT                                                       │
│                                                                     │
│ Marvin válaszol, kérdez, javasol és műveleteket hajt végre.         │
│                                                                     │
│ [ szövegbevitel ... ]                              📎 🎤  Küldés    │
└─────────────────────────────────────────────────────────────────────┘
```

## 4.3. Felső fejléc

Tartalmazza:

- vissza a Projektekhez;
- projekt neve;
- projekt státusza;
- HU/EN;
- mentési állapot;
- aktuális Work Item neve;
- verzió;
- szükség esetén „Megnyitás külső editorban”;
- projektkontextus megnyitása.

## 4.4. Bal oldali panel

Tartalmazza:

- projekt mappastruktúra;
- Work Item lista;
- típus szerinti szűrés;
- keresés;
- új munkadarab;
- legutóbbi munkák;
- folyamatban lévő munkák.

Work Item típusok:

```text
document
pdf
image
graphic
video
audio
presentation
text
code
other
```

## 4.5. Középső panel

A középső panel a tényleges munka helye.

Támogatnia kell:

- dokumentum preview;
- PDF preview;
- grafikai canvas;
- kép preview;
- videó player;
- timeline;
- hang preview;
- render progress;
- generálási állapot;
- diff/összehasonlítás;
- verzió előnézet.

A középső panelnek mindig az aktuális Work Item típusához tartozó megfelelő workspace-et kell megjelenítenie.

## 4.6. Jobb oldali kontextuspanel

Tartalmazza:

- projekt;
- Work Item;
- kapcsolódó Kanban-kártya;
- kapcsolódó fájlok;
- assetek;
- verziók;
- agent műveletek;
- státusz;
- metadata;
- render/generálási állapot;
- költség, ha elérhető;
- kapcsolódó jóváhagyások.

---

# 5. Agent Chat

## 5.1. A chat ne parancssor legyen

A felhasználó természetes nyelven kommunikáljon.

Példák:

> „Szerinted a második jelenet túl gyors?”

> „Igen, rövidítsd le.”

> „Legyen inkább komolyabb.”

> „A címet tedd nagyobbra.”

> „Készíts ebből egy amerikai angol verziót.”

> „Ezt a képet használd háttérnek.”

Az agent válaszoljon és beszélje meg a döntést a felhasználóval.

## 5.2. Két működési állapot

### Beszélgetés

```text
USER → kérdés
AGENT → elemzés / javaslat
```

### Művelet

```text
USER → végrehajtási kérés
AGENT → terv
AGENT → tool call
TOOL → eredmény
AGENT → ellenőrzés
AGENT → válasz
```

## 5.3. Agent-válaszok

A chatben legyen támogatott:

- normál szöveges válasz;
- kérdés;
- javaslat;
- megerősítéskérés;
- művelet folyamatállapota;
- hibajelzés;
- preview-hivatkozás;
- verzióhivatkozás;
- „Megtekintés” gomb;
- „Visszaállítás” gomb;
- „Alkalmazás” gomb.

## 5.4. Streaming

A válasz ne csak a végén jelenjen meg.

A rendszer támogassa:

- streaming szöveget;
- tool státuszt;
- render státuszt;
- progress százalékot;
- elkészült assetek megjelenését.

---

# 6. Agent Orchestrator

A Marvin központi agentrétege felelős:

1. intent felismerésért;
2. projektkontextus összeállításáért;
3. Work Item kontextus betöltéséért;
4. releváns fájlok kiválasztásáért;
5. terv készítéséért;
6. szükséges tool kiválasztásáért;
7. toolok meghívásáért;
8. eredmények ellenőrzéséért;
9. verzió létrehozásáért;
10. preview készítéséért;
11. felhasználói visszajelzés feldolgozásáért.

Az elsődleges általános agentmodell adapteren keresztül legyen cserélhető. Az Anthropic Claude szolgálhat elsődleges agentként; a provider-réteg miatt később más modell is behelyezhető.

---

# 7. Tool Registry

Az agent ne kapjon közvetlen hozzáférést a teljes rendszerhez.

Minden művelet a Marvin Tool Registry-n keresztül történjen.

## 7.1. File toolok

```text
file.read
file.write
file.copy
file.move
file.rename
file.delete
file.metadata
file.preview
```

## 7.2. Project toolok

```text
project.get
project.getContext
project.listFiles
project.listWorkItems
project.listKanban
project.getInstructions
```

## 7.3. Work Item toolok

```text
workItem.create
workItem.open
workItem.update
workItem.attachFile
workItem.detachFile
workItem.getVersion
workItem.createVersion
workItem.restoreVersion
workItem.compareVersions
```

## 7.4. Document toolok

```text
document.read
document.modify
document.exportPdf
document.renderPreview
```

## 7.5. Graphic toolok

```text
graphic.create
graphic.readScene
graphic.setText
graphic.moveObject
graphic.resizeObject
graphic.deleteObject
graphic.addObject
graphic.export
```

## 7.6. Image toolok

```text
image.generate
image.edit
image.upscale
image.removeBackground
```

## 7.7. Video toolok

```text
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
video.extractFrame
```

## 7.8. Preview toolok

```text
preview.create
preview.refresh
preview.open
preview.compare
```

## 7.9. Agent tool security

Minden toolnál legyen:

- input schema;
- output schema;
- permission level;
- estimated cost;
- reversible flag;
- destructive flag;
- external-effect flag;
- audit logging.

---

# 8. Provider abstraction

Ne legyenek közvetlenül a UI-ba égetve a szolgáltatók.

```text
AIProvider
 ├── AnthropicProvider
 └── GeminiProvider

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

A Marvin üzleti logikája kizárólag az absztrakciót használja.

---

# 9. PDF

## 9.1. Megtekintés

Telepítendő/integrálandó:

```text
pdfjs-dist
```

Feladat:

- PDF oldalak renderelése;
- zoom;
- lapozás;
- keresés;
- thumbnail;
- preview.

## 9.2. Szerkesztés

Integrálandó:

```text
ONLYOFFICE Docs
```

A Marvin kezelje:

- dokumentumazonosítót;
- jogosultságot;
- callbacket;
- mentést;
- verziózást;
- projektkapcsolatot.

## 9.3. Konverzió

Telepítendő:

```text
LibreOffice
```

Használat:

- DOCX → PDF;
- dokumentum render;
- export;
- fallback.

---

# 10. DOCX

A DOCX Work Item:

```text
DOCX Work Item
 ├── source.docx
 ├── preview
 ├── versions
 └── metadata
```

A középső panelbe beágyazott ONLYOFFICE editor kerüljön.

Az agent a dokumentumot a támogatott dokumentum-műveleti rétegen keresztül módosítsa.

Minden mentés után:

```text
DOCX
 ↓
version
 ↓
preview
```

---

# 11. Grafikai rendszer

A strukturált grafikai munkadarabokhoz használjon:

```text
Fabric.js
```

A grafika ne csak rasterizált kép legyen.

Legyen objektummodellje:

```text
Graphic
 ├── canvas
 ├── objects[]
 │   ├── text
 │   ├── image
 │   ├── shape
 │   └── logo
 ├── dimensions
 └── metadata
```

Minden objektumnak legyen stabil ID-ja.

Példa:

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

Így az agent pontos műveleteket végezhet.

Például:

> „A címet tedd 30%-kal nagyobbra.”

Ne új képet generáljon, hanem módosítsa:

```text
headline.fontSize *= 1.3
```

---

# 12. Képgenerálás és képszerkesztés

Az image provider adapter támogatja:

- text-to-image;
- image-to-image;
- image edit;
- háttérmódosítás;
- tárgymódosítás;
- méretváltozat;
- preview;
- export.

A Google Gemini image generation integráció használható első providerként.

A provider API-kulcsa kizárólag szerveroldali konfigurációban legyen.

---

# 13. Videórendszer

A videóréteget három részre kell bontani:

```text
AI Video Generation
Video Composition
Video Rendering
```

## 13.1. AI videógenerálás

Első adapter:

```text
VeoProvider
```

Támogatandó:

- prompt;
- aspect ratio;
- duration;
- resolution;
- reference images;
- scene generation;
- scene regeneration;
- video extension, ha a provider támogatja;
- async job.

## 13.2. Videó projektmodell

```text
VideoProject
 ├── width
 ├── height
 ├── fps
 ├── duration
 ├── scenes[]
 ├── tracks[]
 ├── audio[]
 ├── overlays[]
 └── metadata
```

Scene:

```text
Scene
 ├── id
 ├── start
 ├── duration
 ├── sourceAsset
 ├── prompt
 ├── transition
 └── metadata
```

## 13.3. Timeline

A timeline legyen strukturált és módosítható.

Támogatandó:

- scene move;
- trim;
- split;
- replace;
- text;
- image;
- logo;
- voice;
- music;
- transition;
- volume;
- crop;
- aspect ratio.

## 13.4. Remotion

A videó preview és render orchestration alapja:

```text
Remotion
```

A Remotion Player jelenítse meg a videó aktuális állapotát.

## 13.5. FFmpeg

Telepítendő:

```text
FFmpeg
```

Feladata:

- media conversion;
- audio mix;
- trim;
- concat;
- resize;
- overlay;
- frame extraction;
- final encoding.

---

# 14. Audio

Első opcionális provider:

```text
ElevenLabsProvider
```

Támogatandó:

- text-to-speech;
- voice selection;
- language;
- pronunciation;
- voice generation;
- preview;
- audio asset mentése.

A narráció a Video Work Item assetje legyen.

---

# 15. Preview-rendszer

Minden Work Item típusnak legyen preview adaptere.

```text
PreviewProvider
 ├── PdfPreview
 ├── DocumentPreview
 ├── ImagePreview
 ├── GraphicPreview
 ├── VideoPreview
 └── AudioPreview
```

A preview legyen:

- gyors;
- cache-elhető;
- verzióhoz kötött;
- újragenerálható;
- megnyitható teljes méretben.

---

# 16. Verziózás

## 16.1. Verzióobjektum

Minden verzió tartalmazza:

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

## 16.2. Verziók

```text
v1
v2
v3
v4
```

Minden agent-módosításnál új verzió készüljön.

## 16.3. Visszaállítás

A visszaállítás ne törölje a későbbi verziókat.

Például:

```text
v1
v2
v3
v4
v5

Restore v3
   ↓
v6 = v3 állapotának új verziója
```

## 16.4. Nagy assetek deduplikációja

Ne legyen minden verzió teljes másolat.

Asset tárolás:

```text
hash
path
mime
size
```

A verzió manifestje hivatkozzon az assetre.

---

# 17. Adatbázis

## 17.1. `work_items`

```sql
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

## 17.2. `work_item_versions`

```sql
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

## 17.3. `work_item_assets`

```sql
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

## 17.4. `agent_sessions`

```sql
id
project_id
work_item_id
started_at
ended_at
status
language
```

## 17.5. `agent_messages`

```sql
id
session_id
role
content
created_at
```

## 17.6. `agent_tool_calls`

```sql
id
session_id
tool_name
input_json
output_json
status
started_at
finished_at
```

## 17.7. `render_jobs`

```sql
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

## 17.8. `provider_usage`

```sql
id
project_id
work_item_id
provider
model
operation
input_units
output_units
estimated_cost
actual_cost
created_at
```

---

# 18. Fájlrendszer

A projekt fizikai mappája maradjon a Raktár alapja.

Javasolt belső struktúra:

```text
<ProjectFolder>/
├── Tudásbázis/
├── További anyagok/
├── Fejlesztés/
└── .marvin/
    ├── work-items/
    ├── versions/
    ├── previews/
    ├── manifests/
    ├── jobs/
    └── cache/
```

A `.marvin` technikai belső adatokat tartalmazzon.

A felhasználó számára látható projektfájlok ne keveredjenek a technikai cache-sel.

---

# 19. Work Item manifest

Minden Work Item rendelkezzen manifesttel.

Példa:

```json
{
  "workItemId": "AB12CD34",
  "type": "video",
  "title": "Freeber bemutatkozó videó",
  "projectId": "XY98PQ12",
  "currentVersion": 4,
  "assets": [],
  "editor": "remotion",
  "preview": {},
  "metadata": {}
}
```

A manifest legyen a Work Item technikai állapotának leírása.

---

# 20. Job Queue

A hosszú műveletek háttérben fussanak.

Kötelező állapotok:

```text
queued
running
completed
failed
cancelled
```

Támogatandó jobok:

- image generation;
- video generation;
- video rendering;
- PDF export;
- document conversion;
- preview generation;
- audio generation.

A UI mutassa:

```text
🎬 Videógenerálás 42%
🎨 Kép elkészítése
📄 PDF export
```

---

# 21. Párhuzamos működés

A chat és a háttérmunka ne blokkolják egymást.

Példa:

```text
Job A: video render
Job B: image generation
Chat: aktív
```

A felhasználó közben folytathassa a beszélgetést.

Az agent tudja, hogy mely jobok futnak.

---

# 22. Kanban-integráció

Minden Work Item opcionálisan kapcsolható Kanban-kártyához.

Kanban-kártyán:

```text
Megnyitás a Munkapadon
```

Ha nincs Work Item:

```text
Work Item létrehozása
```

A kapcsolat legyen kétirányúan elérhető:

```text
Kanban Card
 ↕
Work Item
```

A projekt ID mindkettőből lekérdezhető legyen.

---

# 23. Projektkontextus

Az agent promptjába ne kerüljön be automatikusan az egész projekt.

A Marvin készítsen releváns kontextust:

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

A kontextus legyen méretkorlátos és relevancia alapján összeállított.

---

# 24. Chat memória

Az Agent Session őrizze meg:

- beszélgetést;
- döntéseket;
- fontos preferenciákat;
- végrehajtott műveleteket;
- verziókat;
- hibákat;
- felhasználói jóváhagyásokat.

Ne kerüljön minden technikai log automatikusan a hosszú távú Marvin Memory rendszerbe.

---

# 25. HU / EN

A rendszer UI-ja támogassa:

```text
HU | EN
```

A Work Item tartalma ettől független nyelvű lehet.

Támogatandó:

- magyar munkadarab;
- angol munkadarab;
- amerikai angol;
- későbbi további nyelvek.

A felhasználó mondhatja:

> „Készíts amerikai angol verziót.”

A rendszer új verziót hozzon létre.

---

# 26. Cost tracking

Minden külső AI-művelet naplózza:

```text
provider
model
operation
input
output
duration
estimated_cost
actual_cost
```

Projekt szinten jelenjen meg:

```text
AI költség
 ├── Claude
 ├── Gemini
 ├── Video
 ├── Audio
 └── összesen
```

A költségadat ne legyen a Munkapad fő UI-eleme, de legyen elérhető.

---

# 27. Hibakezelés

Az agent soha ne állítsa azt, hogy elkészült valami, ha a tool vagy render sikertelen.

Hiba esetén:

```text
Tool
 ↓
Error
 ↓
Agent
 ↓
érthető magyarázat
 ↓
lehetséges javítás
```

Például:

> „A videó renderelése sikertelen volt, mert a 3. jelenet assetje hiányzik. Megtaláljam vagy generáljam újra?”

---

# 28. Audit log

Minden agent által végrehajtott művelet naplózandó.

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

Ez legyen kereshető és hibakeresésre használható.

---

# 29. Biztonság

## API kulcsok

Az API-kulcsok ne kerüljenek:

- frontendbe;
- Work Item manifestbe;
- chatbe;
- kliensoldali localStorage-ba.

Csak szerveroldali konfigurációban legyenek.

## Tool sandbox

Az agent csak engedélyezett projektútvonalakon dolgozhasson.

## Path traversal

Minden fájlútvonalat validálni kell.

## File type validation

Feltöltött fájltípusokat MIME + extension + tényleges tartalom alapján ellenőrizni kell.

---

# 30. Költség- és jogosultsági szintek

Minden AI tool kapjon:

```text
cost_level
permission_level
external_effect
destructive
reversible
```

Példa:

```text
image.generate
cost: medium
reversible: yes
external_effect: no
```

```text
social.publish
cost: medium
reversible: no
external_effect: yes
```

Utóbbi kötelező megerősítést igényel.

---

# 31. Külső editor megnyitása

A Marvin Munkapad legyen az alap.

Ha egy Work Item olyan külső editorral működik, amelynek nincs teljes beágyazott kezelése, legyen:

```text
Megnyitás külső editorban
```

A visszaérkező fájl új verzióként kerüljön Marvinba.

---

# 32. Nem kötelező azonnal külső editor

A fejlesztés első szakaszában:

- PDF preview;
- DOCX editor;
- image preview;
- graphic canvas;
- video preview

legyen elsődleges.

A teljes külső editor-integráció későbbi bővítés lehet.

---

# 33. Fejlesztési fázisok

## FÁZIS 1 – Munkapad alap

Implementálandó:

- Work Item DB;
- Version DB;
- Agent Session DB;
- Agent Message DB;
- Tool Call DB;
- Workbench UI;
- hárompaneles layout;
- Work Item lista;
- preview terület;
- chat;
- verziólista;
- projektkontextus.

**Elfogadási feltétel:** létrehozható egy Work Item, megnyitható, chatből beszélhető és új verzió készíthető.

---

## FÁZIS 2 – Agent

Implementálandó:

- provider abstraction;
- Anthropic adapter;
- streaming;
- tool registry;
- tool schema;
- tool execution;
- permission check;
- agent audit log.

**Elfogadási feltétel:** a user természetes nyelven kérhet műveletet, az agent megtervezi, végrehajtja, majd visszajelzést ad.

---

## FÁZIS 3 – Fájlok és preview

Implementálandó:

- file adapter;
- preview cache;
- PDF.js;
- image preview;
- DOCX preview;
- asset hash;
- manifest.

**Elfogadási feltétel:** a projektfájlból Work Item nyitható és középen preview jelenik meg.

---

## FÁZIS 4 – Dokumentum

Implementálandó:

- ONLYOFFICE;
- LibreOffice;
- DOCX;
- PDF export;
- document toolok;
- document versioning.

**Elfogadási feltétel:** DOCX megnyitható, módosítható, menthető és verziózható.

---

## FÁZIS 5 – Grafika és kép

Implementálandó:

- Fabric.js;
- Graphic Work Item;
- object IDs;
- image provider;
- image editing;
- export;
- undo/redo.

**Elfogadási feltétel:** „A címet tedd nagyobbra” típusú agent-kérés strukturált objektummódosítást hajt végre.

---

## FÁZIS 6 – Videó

Implementálandó:

- Video Work Item;
- scene model;
- timeline;
- Remotion;
- Player;
- FFmpeg;
- render queue;
- Veo adapter;
- audio provider;
- scene regeneration;
- video versioning.

**Elfogadási feltétel:** rövid bemutatkozó videó létrehozható chatből, lejátszható, módosítható és verziózható.

---

## FÁZIS 7 – Mély Marvin-integráció

Implementálandó:

- Kanban ↔ Work Item;
- approvals;
- relevant memory;
- code tasks;
- project activity;
- agent claims;
- project links.

---

# 34. Tesztelési stratégia

## Unit test

Kötelező:

- Work Item;
- Version;
- Asset;
- Manifest;
- Tool validation;
- permission;
- provider abstraction;
- job state;
- path validation.

## Integration test

Kötelező:

```text
Agent
 → Tool
 → File
 → Version
 → Preview
```

## E2E

Legalább:

### PDF

```text
create
→ open
→ modify
→ preview
→ version
→ restore
```

### Graphic

```text
create
→ generate image
→ add text
→ resize text
→ preview
→ export
```

### Video

```text
create
→ generate scene
→ assemble
→ preview
→ user feedback
→ replace scene
→ render
→ version
```

### Agent

```text
user question
→ agent answer
→ user approval
→ tool call
→ result
→ new version
→ preview
```

---

# 35. UI elfogadási feltételek

A Munkapad akkor tekinthető késznek, ha:

1. egy projektből egy kattintással elérhető;
2. egy Work Item létrehozható;
3. egy Work Item megnyitható;
4. középen tényleges preview jelenik meg;
5. alul agent chat működik;
6. az agent képes válaszolni kérdésre;
7. az agent képes műveletet végrehajtani;
8. a művelet eredménye previewban megjelenik;
9. minden jelentős módosítás új verzió;
10. előző verzió visszaállítható;
11. hosszú művelet háttérben futhat;
12. a user közben tovább beszélhet az agenttel;
13. a Work Item projektazonosítóhoz kötött;
14. Kanban-kártyához kapcsolható;
15. fájlokhoz kapcsolható;
16. HU/EN működik;
17. hibák érthetően jelennek meg;
18. az agent nem írja felül automatikusan az eredetit;
19. a tool-hívások auditálhatók;
20. API-kulcsok nem kerülnek kliensoldalra.

---

# 36. Első működő demonstráció

Az első teljes vertical slice ne videóval kezdődjön.

A következő folyamat legyen az első végponttól végpontig működő demonstráció:

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
AI image generation
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
„Ez jobb.”
 ↓
Export
```

Ezután jöjjön a dokumentum, majd a videó.

---

# 37. Második vertical slice – DOCX/PDF

```text
Projekt
 ↓
Munkapad
 ↓
DOCX
 ↓
ONLYOFFICE
 ↓
Agent
 ↓
„A 2. fejezetet rövidítsd le.”
 ↓
DOCX módosítás
 ↓
Preview
 ↓
v2
 ↓
PDF export
```

---

# 38. Harmadik vertical slice – videó

```text
Projekt
 ↓
Munkapad
 ↓
Videó Work Item
 ↓
Agent chat
 ↓
„Készíts 20 mp Freeber bemutatkozó videót.”
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
FFmpeg / Remotion render
 ↓
v2
```

---

# 39. Telepítendő komponensek összesítve

## Frontend / alkalmazás

```text
pdfjs-dist
fabric.js
Remotion Player
Remotion
```

## Lokális / szerver oldali

```text
FFmpeg
LibreOffice
ONLYOFFICE Docs
```

## AI / külső szolgáltatók

```text
Anthropic API
Google Gemini API
Google Veo
ElevenLabs API
```

A provider-réteg miatt egyik külső szolgáltató sem legyen véglegesen a Marvin üzleti logikájába égetve.

---

# 40. Javasolt projektstruktúra a Marvin kódban

A konkrét meglévő Marvin stackhez kell igazítani, de az új réteg logikailag legyen elkülönítve:

```text
workbench/
├── components/
│   ├── WorkbenchLayout
│   ├── WorkItemSidebar
│   ├── PreviewPanel
│   ├── ContextPanel
│   ├── AgentChat
│   ├── VersionPanel
│   └── JobStatus
│
├── work-items/
│   ├── workItemService
│   ├── versionService
│   ├── assetService
│   └── manifestService
│
├── agent/
│   ├── orchestrator
│   ├── session
│   ├── context
│   ├── tools
│   ├── permissions
│   └── providers
│
├── editors/
│   ├── pdf
│   ├── document
│   ├── graphic
│   ├── image
│   └── video
│
├── providers/
│   ├── anthropic
│   ├── gemini
│   ├── veo
│   ├── elevenlabs
│   ├── onlyoffice
│   ├── remotion
│   └── ffmpeg
│
└── jobs/
    ├── queue
    ├── workers
    └── render
```

A tényleges fájlneveket és framework-konvenciókat a Marvin meglévő kódbázisához kell igazítani.

---

# 41. Provider interfészek

Az implementáció során az adaptereknek stabil interfészt kell biztosítaniuk.

Példa:

```text
AIProvider
  chat()
  stream()
  toolCall()
```

```text
ImageProvider
  generate()
  edit()
```

```text
VideoProvider
  generateScene()
  extend()
  getJob()
  cancel()
```

```text
AudioProvider
  synthesize()
```

```text
DocumentProvider
  open()
  save()
  export()
```

```text
RenderProvider
  preview()
  render()
  getJob()
  cancel()
```

---

# 42. Agent műveleti folyamat

Minden művelet:

```text
1. User message
2. Session load
3. Project context
4. Work Item context
5. Agent inference
6. Tool selection
7. Permission check
8. Tool execution
9. Tool result
10. Agent verification
11. Version creation
12. Preview creation
13. UI update
14. Agent response
15. Audit log
```

---

# 43. Agent ne találja ki az állapotot

Az agent kizárólag a rendszerből lekérdezett adatokból állítsa:

- milyen fájl van;
- melyik verzió aktív;
- melyik job fut;
- milyen render készült;
- melyik Kanban-kártya kapcsolódik;
- melyik asset létezik.

Ha nincs adat, mondja azt, hogy nincs adat.

---

# 44. AI által javasolt változtatás kezelése

Ha a user kérdez:

> „Szerinted jobb lenne nagyobb címmel?”

Agent:

> „Igen, a jelenlegi kompozícióban a cím vizuálisan gyenge. 20–30%-os növelést javaslok. Megcsináljam?”

Gombok:

```text
[ Igen, csináld ]
[ Másképp ]
[ Nem ]
```

Ezután:

```text
tool call
→ version
→ preview
```

---

# 45. Több iteráció támogatása

A chatnek a Work Item aktuális állapotát kell követnie.

Például:

```text
v1
„Készíts videót.”

v2
„Legyen modernebb.”

v3
„A maci legyen kisebb.”

v4
„Legyen angol narráció.”

v5
„A CTA legyen 2 mp hosszú.”
```

A Marvinnak tudnia kell:

> „A jelenlegi v5 alapján módosítsd csak a CTA-t.”

---

# 46. Költséges műveletek

A költséges műveleteknél az agent előzetesen jelezheti:

> „Ez új videógenerálást indít. Elkészítsem?”

A rendszer költségbecslést is megjeleníthet, ha a provider biztosít megfelelő adatot.

---

# 47. Offline / lokális működés

A lokális Marvin-rész működjön internet nélkül is:

- projektfájlok;
- Work Item;
- verziók;
- preview cache;
- helyi dokumentumok;
- helyi grafika;
- helyi videóösszeállítás;
- FFmpeg;
- LibreOffice.

Az AI-generálás természetesen providerfüggő.

---

# 48. Teljes rendszer végső modellje

```text
                         ┌─────────────────────┐
                         │       MARVIN        │
                         │      PROJECT        │
                         └──────────┬──────────┘
                                    │
                              ┌─────▼─────┐
                              │ WORKBENCH │
                              └─────┬─────┘
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                    │
               ▼                    ▼                    ▼
             FILES              WORK ITEM             AGENT
               │                    │                    │
               │          ┌─────────┼─────────┐          │
               │          │         │         │          │
               │         PDF      GRAPHIC    VIDEO       │
               │          │         │         │          │
               │       PDF.js    Fabric    Remotion      │
               │       ONLYOFFICE Image     FFmpeg       │
               │       LibreOffice          Veo          │
               │                             Audio       │
               │                                │         │
               └────────────────┬───────────────┘         │
                                │                         │
                                ▼                         │
                         VERSION MANAGER ◄────────────────┘
                                │
                                ▼
                             PREVIEW
                                │
                                ▼
                         USER FEEDBACK
                                │
                                └──────────► AGENT
```

---

# 49. Végleges fejlesztési sorrend

```text
1. projects véglegesítése
2. work_items
3. work_item_versions
4. work_item_assets
5. agent_sessions
6. agent_messages
7. agent_tool_calls
8. render_jobs
9. Workbench UI
10. Preview architecture
11. Agent chat
12. Tool Registry
13. Permission layer
14. Anthropic provider
15. File tools
16. PDF.js
17. ONLYOFFICE
18. LibreOffice
19. Fabric.js
20. Image provider
21. Remotion
22. FFmpeg
23. Video provider
24. Audio provider
25. Render queue
26. Version compare/restore
27. Kanban integration
28. Project context
29. Memory integration
30. Cost tracking
31. Audit
32. E2E tests
33. production hardening
```

---

# 50. Végleges definíció

A Marvin Projektek moduljának végső célja:

> **A projekt ne csak egy hely legyen, ahol a felhasználó megnézi, mi történt. A projekt legyen egy AI-alapú munkakörnyezet, ahol a felhasználó természetes nyelven megbeszéli az agenttel, mit szeretne létrehozni vagy módosítani, az agent végrehajtja a szükséges műveleteket a megfelelő szakmai motorokkal, az eredmény azonnal previewban látható, minden módosítás verziózott, és a felhasználó iteratív beszélgetésben tudja finomítani a munkát.**

A fő UX-ciklus:

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

Ez legyen a Marvin AI Munkapad alapműködése.
