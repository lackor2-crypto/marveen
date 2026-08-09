# Magyar diktálás (Windows)

Mikrofon → magyar szöveg → oda illesztve, ahová kattintasz. Groq `whisper-large-v3`, `language=hu`, `temperature=0`. Nem kell hozzá telepíteni semmit: a felvétel a Windows beépített `waveIn`
API-jával megy, a HTTPS a rendszer `curl.exe`-jével.

**Miért van rá szükség:** a Claude Code beépített mikrofonja nem tud magyarul, és a motorja
nem cserélhető (a bővítmény része, a felismerés szerveroldalon fut).

## Telepítés

```powershell
powershell -ExecutionPolicy Bypass -File telepit.ps1
```

A Marveen Windows-telepítője (`install-windows.ps1`) ezt magától lefuttatja.

Nem kell rendszergazda. A telepítő:

1. `%USERPROFILE%\.hu-diktalas` alá másol mindent
2. helyreállítja a **CRLF** sorvégeket a `.cmd` fájlokon
3. bekéri a **Groq API-kulcsot** (ha még nincs) — [console.groq.com/keys](https://console.groq.com/keys), ingyenes
4. beállítja az alapértelmezett mikrofont **mind a három szerepre**
5. asztali parancsikonokat készít

## Használat

Kattints a **Magyar diktálás** ikonra → sípol → beszélsz → **kattints oda, ahová a szöveget
akarod** = leáll ÉS odailleszti. Max 5 perc.

Tálcára tűzés: jobb klikk az ikonon → *Pin to taskbar*. (A Win10 letiltotta a programozott
kitűzést, ezért kézzel kell — és ezért `wscript.exe` a parancsikon célja, mert csak EXE tűzhető.)

| parancsikon / fájl | mire jó |
|---|---|
| `Magyar diktálás` | a diktálás |
| `MIKROFON-kamera.cmd` | webkamera mikrofonja, 55% — **asztalnál ülve, ~1 méterről** |
| `MIKROFON-fejhallgato.cmd` | headset karmikrofon, 100% — ha fejre teszed |
| `mikrofon-valaszto.cmd` | **megméri mindkét mikrofont** ugyanabból a székből, és a jobbikat állítja be |
| `mikrofon-teszt.cmd` | jelszint-mérés API-hívás nélkül |
| `mikrofon-diagnosztika.ps1` | melyik eszköz, mekkora hangerő, dB-tartomány |

A `MIKROFON-*.cmd` mindkettőt egyszerre állítja: a **rendszer alapértelmezettjét** (hogy a Zoom,
Teams és a böngésző is ezt lássa) **és** a diktálás beállítását — így a kettő nem csúszhat szét.

## ★A legfontosabb: a MIKROFON dönt, nem a hangerő

Élesen mérve (2026-08-09), ugyanazzal a beszélővel és modellel:

| | webkamera mikrofonja | **headset karmikrofon** |
|---|---|---|
| csúcs | 100% (mindig a plafonon) | **87,5%** |
| RMS | 15–18% | 8% |
| **dinamika** | **2,8–3,5×** | **27,5×** |
| vágott minta | 0,03–0,27% | **0%** |
| átírás | széteső, hibás | **hibátlan** |

A webkamera **ötször hangosabb volt, mégis rosszabb.** A benne lévő automatikus
erősítés (AGC) felhúzza a csendet a szavak közt és lenyomja a csúcsokat —
szétlapítja a beszédet. **A dinamika a mérce, nem a hangerő**; ezért dönt eszerint
a `mikrofon-valaszto.cmd`.

> Ez egyben azt is jelenti, hogy a **kényelem és a pontosság között választani kell**:
> 1 méterről a webkamera hallja, de rosszul; a headset pontos, de viselni kell.

## ⛔Szótár (prompt) — alapból KI, és jó okkal

A `szotar.txt` **nem aktív** (a repóban `szotar.txt.pelda` néven van). Mérésen
kiderült, hogy **rontott**: a leiratban megjelent egy ismétlődő hurok
(„tőzsdei arányt… tőzsdei arányt"), aminek a szavai **szó szerint a promptból**
származtak.

A Whisper a promptot **előzményszövegnek** kapja. Ha a hang bizonytalan — például
mert egy AGC-s mikrofon lapította szét —, a dekóder inkább **folytatja a promptot**,
ahelyett hogy átírná a beszédet. A rossz hang és a prompt tehát **erősítik egymást**.

Bekapcsolni csak akkor érdemes, ha a hang már **tiszta** (dinamika 10× felett), és
akkor is méréssel: `hasonlit-modelleket.cmd` — ugyanaz a felvétel szótárral és anélkül.
Aktiválás: nevezd át `szotar.txt`-re.

A **`javitasok.txt` viszont marad**: az determinisztikus `hibás=helyes` csere, ami
nem tud kitalálni semmit.

## Melyik modell?

A Groq Cloud **két** átírási modellt kínál (ellenőrizve a `/v1/models` végponton):

| modell | mikor |
|---|---|
| `whisper-large-v3` | **ez az alapértelmezés** — pontosabb nem-angol nyelven és tulajdonneveken |
| `whisper-large-v3-turbo` | gyorsabb, de pontatlanabb |

Felülírható a **`modell.txt`**-ből. Ha el akarod dönteni a saját hangodon:

```
hasonlit-modelleket.cmd
```

Egyetlen felvételt küld fel **három** változatban — pontos+szótár, pontos szótár nélkül,
gyors+szótár —, egymás alatt kiírja őket, és a választásodat be is állítja.

## Buktatók, amiket már megoldottunk

Ezek mind éles hibából származnak; ha újra kell építeni, ne fussunk beléjük megint.

1. **`.cmd` LF sorvégekkel** → a `cmd.exe` azonnal kilép („felvillan egy fekete ablak").
   A telepítő ezért írja újra őket CRLF-fel, nem bízza a `.gitattributes`-ra.
2. **Ékezetes karakter a `.ps1`-ben** → a PS 5.1 ANSI-ként olvassa a BOM nélküli UTF-8-at,
   `László` → `LĂˇszlĂł`, és nem találja a kulcsot. **Minden `.ps1` 100% ASCII**, az út `$PSScriptRoot`-ból.
3. **`curl` kimenete közvetlenül változóba** → a PS 5.1 a konzol kódlapjával (CP852) dekódol.
   Fájlba kell íratni (`-o`) és `[IO.File]::ReadAllText(..., UTF8)`-cal olvasni.
4. **8 bites felvétel** → az MCI ezen a gépen nem hajlandó 16 bitre váltani (`RC=282`).
   Ezért `recorder.ps1` a **waveIn** API-t használja: 16 kHz / mono / 16 bit.
5. **Néma mikrofon → hallucináció.** A Whisper a csendre **kitalál** egy szöveget (élő mérésen
   `NAMASTE`). Ezért van jelszint-kapu: csend esetén fel sem küldjük.
6. **`WAVE_MAPPER` hazudik.** A régi MME-réteg „preferált eszköze" **nem feltétlenül** azonos a
   modern MMDevice-alapértelmezettel — emiatt fordulhatott elő, hogy a diagnosztika tökéletes
   eszközt jelzett, közben a felvétel a másik mikrofonról jött. Ezért **név szerint** nyitjuk meg
   az eszközt, és a naplóba is beírjuk, melyikről vettünk fel.
   Ráadásul a **waveIn indexek átrendeződnek**, ha az alapértelmezett eszköz változik
   (mérve: a Realtek 1-ről 0-ra ment) — index alapján választani ezért eleve törékeny.
7. **„A 100% csúcs = vágás" — EZ TÉVEDÉS VOLT, méréssel cáfolva.** A csúcs önmagában semmit
   nem árul el: egyetlen hangos szótag is 100%. Ami számít, hány **minta** ül a plafonon —
   mérve 0,03–0,27%, ami normális beszédcsúcs. A napló ezért írja ki a *vágott minta* értékét.
   Ugyanez buktatta meg az önhangolót is: a hangerő-csúszkát 55%→10%-ig tekerte le, miközben
   az RMS **változatlan** maradt (a webkamera AGC-je kiegyenlíti) — halott gombot tekert.
8. **A távolság nem a szinten múlik, hanem a küszöbön.** A régi kapu `RMS < 0,8%`-nál elutasított,
   ami közelről helyes, de 1 méterről a **valódi beszédet** is eldobta. Az új logika a **dinamikára**
   épül (a beszéd hullámzik, a zaj egyenletes) — az távolság-független.
9. **COM: elcsúszott vtable nem hibát dob, hanem HAZUDIK.** Az `IAudioEndpointVolume`-ban
   `GetMasterVolumeLevelScalar` és `SetMute` közt **pontosan 4** metódus van; 6 helykitöltővel a
   „GetMute" hívás valójában `VolumeStepUp`-ot hívott — a diagnosztika megemelte a hangerőt, és
   közben hamis „nincs némítva" értéket írt ki. A `SetDefaultEndpoint` az `IPolicyConfig` **11.**
   metódusa → előtte pontosan 10 helykitöltő kell.
10. **PS 5.1 nem tud metódust hívni nyers `__ComObject`-en** (IUnknown out-paraméterből).
    Minden COM-műveletet C#-on **belül** kell elvégezni, és csak primitívet visszaadni.

## Fájlok

| fájl | szerep |
|---|---|
| `diktal-auto.ps1` | a fő folyamat: felvétel → kattintásra leáll → Groq → beillesztés |
| `diktal-auto.vbs` | ablak nélküli indító (ez a parancsikon célja) |
| `recorder.ps1` | 16 bites waveIn felvevő, **név szerinti** eszközválasztással |
| `micgain.ps1` | **közös** COM-modul: hangerő + alapértelmezett eszköz (`IPolicyConfig`) |
| `diktal.ps1` | régi, vágólapos változat (Enter = kész, `Ctrl+V` bárhová) |
| `szotar.txt` | szakszavak, amiket a felismerés kapjon meg előre (`prompt`) |
| `javitasok.txt` | utólagos `hibás=helyes` cserék |
| `hasonlit-modelleket.ps1` | A/B próba: egy felvétel, mindkét modell |
| `mikrofon.txt` | melyik eszközt nyissa (a telepítő / a váltók írják) — **nincs a repóban**, gépspecifikus |
| `modell.txt` | melyik Whisper modell — **nincs a repóban**, gépspecifikus |
| `groq.key` | az API-kulcs — **soha nem kerül a repóba** |

## Napló

`%USERPROFILE%\.hu-diktalas\diktal-auto.log` — minden felvételnél rögzíti a **mikrofon nevét**,
a hosszt, a csúcsot, az RMS-t és a dinamikát. Ha valami nem stimmel, ez az első hely, ahová nézni kell.
