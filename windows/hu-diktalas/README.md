# Magyar diktálás (Windows)

Mikrofon → magyar szöveg → oda illesztve, ahová kattintasz. Groq `whisper-large-v3-turbo`,
`language=hu`. Nem kell hozzá telepíteni semmit: a felvétel a Windows beépített `waveIn`
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
7. **A 100% túl sok: vágás.** Mérve: a kamera mikrofonja 100%-on `csúcs 100%, RMS 16,7%` = klippel,
   és ez rontja a felismerést. A cél a **vágás alatti** legnagyobb szint (60–85% csúcs). A diktálás
   önhangoló: vág → ×0,75, túl halk → +12 pont.
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
| `mikrofon.txt` | melyik eszközt nyissa (a telepítő / a váltók írják) — **nincs a repóban**, gépspecifikus |
| `groq.key` | az API-kulcs — **soha nem kerül a repóba** |

## Napló

`%USERPROFILE%\.hu-diktalas\diktal-auto.log` — minden felvételnél rögzíti a **mikrofon nevét**,
a hosszt, a csúcsot, az RMS-t és a dinamikát. Ha valami nem stimmel, ez az első hely, ahová nézni kell.
