#!/usr/bin/env python3
"""A javitas merese: ha a WhatsApp bukik es CSAK piszkozat keszul, a script
NEM allithatja, hogy sikerult. Semmit nem kuldunk: a kuldo fuggvenyeket
kicsereljuk, a Windows-automatizalas nem indul el.

Ket eset:
  1. piszkozat keszult  -> main() False (exit 1) + "NOT DELIVERED" a kimeneten
  2. piszkozat sem lett -> main() False (exit 1)
Es a kontroll: ha a WhatsApp SIKERES, main() True maradjon (nem rontottam el).
"""
import importlib.util, io, os, sys, contextlib

# A vizsgalt script MELLETTUNK van, ugyanabban a scripts/ mappaban -- a sajat
# utunkbol vezetjuk le. Beegetett /home/boss/... ut mas gepen (es a template-bol
# kloonozott telepitesen) nemleteznenek: ezt fogta meg a
# template-identity-hygiene teszt.
WA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "whatsapp-send.py")

spec = importlib.util.spec_from_file_location("wa", WA_PATH)
wa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wa)

wa.PS_EXE = "/stub/powershell.exe"          # a valodi kereses ne dontsön el
wa.whatsapp_is_running = lambda: True        # ne inditson/keressen appot
wa.time.sleep = lambda s: None               # ne varjon a backoffra

def run(argv, whatsapp_ok, draft_ok):
    wa.send_whatsapp_message = lambda *a, **k: whatsapp_ok
    wa.send_email_fallback = lambda *a, **k: draft_ok
    sys.argv = ["whatsapp-send.py"] + argv
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        res = wa.main()
    return res, buf.getvalue()

hiba = 0

res, out = run(["uzenet", "--skip-launch", "--retries", "2"], False, True)
ok = (res is False) and ("NOT DELIVERED" in out)
print(f"1. WhatsApp bukott + piszkozat keszult -> visszateres={res} "
      f"(elvart: False), NOT DELIVERED kiirva={'NOT DELIVERED' in out}  "
      f"{'OK' if ok else 'BUKOTT'}")
hiba += 0 if ok else 1

res, out = run(["uzenet", "--skip-launch", "--retries", "2"], False, False)
ok = res is False
print(f"2. WhatsApp bukott + piszkozat sem  -> visszateres={res} "
      f"(elvart: False)  {'OK' if ok else 'BUKOTT'}")
hiba += 0 if ok else 1

res, out = run(["uzenet", "--skip-launch", "--retries", "2"], True, False)
ok = (res is True) and ("NOT DELIVERED" not in out)
print(f"3. KONTROLL -- WhatsApp sikeres    -> visszateres={res} "
      f"(elvart: True)  {'OK' if ok else 'BUKOTT'}")
hiba += 0 if ok else 1

print("EREDMENY:", "MIND OK" if hiba == 0 else f"{hiba} eset bukott")
sys.exit(hiba)
