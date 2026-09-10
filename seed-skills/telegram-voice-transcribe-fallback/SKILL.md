---
name: telegram-voice-transcribe-fallback
description: Bejovo Telegram hanguzenet (voice) atirasa, ha a sajat agens-mappa scripts/voice/venv-je hianyzik. Hasznald amikor egy attachment_kind="voice" uzenetet kell atirni, de a `scripts/voice/stt.sh <file_id>` "No such file or directory" hibat ad a venv/bin/python-ra.
scope: global
---

# Telegram hanguzenet atirasa -- venv fallback

## Mikor hasznald
Egy bejovo `<channel ... attachment_kind="voice" attachment_file_id="...">` uzenetet
at kell irni szoveggé, de a sajat agens `scripts/voice/venv/` konyvtara nincs
telepitve (pl. egy ujabb/kulon agens-mappa, ahol a voice-install nem futott le).

## Eljaras
1. Ha meg nincs letoltve a hangfajl, a Telegram MCP `download_attachment`
   toollal az `attachment_file_id`-bol megszerezheto -- de ehhez a skillhez
   nem is kell: az `_vtools.py transcribe` maga tolt le a file_id alapjan.
2. Probald a sajat mappad wrapperjet:
   ```bash
   bash {{PROJECT_ROOT}}/scripts/voice/stt.sh "<file_id>"
   ```
3. Ha `No such file or directory: .../scripts/voice/venv/bin/python` hibat kapsz,
   NE telepits ujra venv-et -- eloszor nezd meg, van-e mar egy GLOBALIS
   (install-voice.sh alapertelmezett celja) telepites:
   ```bash
   ls "$HOME/.local/share/marveen-voice/venv/bin/python"
   ```
   Ha letezik, hivd kozvetlenul azt, a sajat agens telegram csatorna-mappajat
   adva at state_dir-nek (ide irja/olvassa a segéd-allapotot):
   ```bash
   "$HOME/.local/share/marveen-voice/venv/bin/python" \
     "$HOME/.local/share/marveen-voice/_vtools.py" transcribe \
     "<file_id>" \
     "<SAJAT_AGENS_TELEGRAM_CHANNEL_DIR>"
   ```
   (`<SAJAT_AGENS_TELEGRAM_CHANNEL_DIR>` pl.
   `{{PROJECT_ROOT}}/agents/<SAJAT_AGENS>/.claude/channels/telegram`.)
   Az atirt szoveg stdout-ra kerul (magyar nyelvu ASR, Telegram hangokra hangolva).

## Buktatok
- A `stt.sh` sajat DEST-et a script konyvtarabol probalja kitalalni
  (`_vtools.py` melletti `venv`), ez agensenkent kulon telepitest feltetelez --
  ha az az agens sose futtatta az `install-voice.sh`-t, a venv hianyzik, de a
  `_vtools.py` maga mar ott lehet (csak a venv nincs).
- A globalis `$HOME/.local/share/marveen-voice/` (vagy egy egyedi
  `INSTALL_DIR`-rel telepitett hely) egy MASIK agensnel/a fo telepitesnel mar
  felepult venv-et tartalmazhat -- ugyanaz a Python-kod (`_vtools.py`), csak a
  futtato interpreter mas helyen van. Ez biztonsagosan ujrahasznalhato
  barmelyik agensbol, mert a `transcribe` parancs csak a file_id-t es a
  Telegram bot-tokent hasznalja (a state_dir csak sajat konyvtar-elkulonitesre
  kell, nem befolyasolja MELYIK hangot irja at).
- NE probalj sajat venv-et telepiteni csak egy atirashoz -- az `install-voice.sh`
  tobb percig tart es csomagot telepit (jovahagyast igenyelhet); a globalis
  venv ujrahasznalata gyorsabb es nem igenyel telepitest.

## Ellenorzes
- A stdout tenyleges, ertelmes magyar mondatokat tartalmaz (nem ures, nem
  hibauzenet).
- Ha a globalis venv is hianyzik, jelentsd a tulajdonosnak hogy a hangot nem
  tudtad atirni, es kerd meg hogy irja le szovegben -- ne talalj ki tartalmat.
