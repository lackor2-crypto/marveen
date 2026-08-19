#!/usr/bin/env python3
"""A tartalek-ut merese. Semmit nem kuldunk: a kuldo fuggvenyeket kicsereljuk,
a Windows-automatizalas nem indul el.

A SZABALY, amit vedunk (Boss 2026-08-16: "azt azonnal el kell kuldeni a
cimzettnek"): a kilepokod KEZBESITEST jelent, nem azt, hogy a WhatsApp mukodott.
  - WhatsApp ment                     -> True
  - WhatsApp bukott, de az email MENT -> True, es latszik hogy a WhatsApp romlott
  - WhatsApp bukott, az email is      -> False, "NOT DELIVERED"
Es kulon: egy PISZKOZAT nem kezbesites -- ha a kuldes bukik, a tartalek-fuggveny
False-t ad, akkor is, ha sikerult piszkozatot parkolnia.
"""
import importlib.util, io, os, sys, contextlib

# A vizsgalt script MELLETTUNK van, ugyanabban a scripts/ mappaban -- a sajat
# utunkbol vezetjuk le. Beegetett /home/boss/... ut mas gepen (es a template-bol
# klonozott telepitesen) nem letezne: ezt fogta meg a
# template-identity-hygiene teszt.
WA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "whatsapp-send.py")

spec = importlib.util.spec_from_file_location("wa", WA_PATH)
wa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wa)

wa.PS_EXE = "/stub/powershell.exe"          # a valodi kereses ne dontsön el
wa.whatsapp_is_running = lambda: True        # ne inditson/keressen appot
wa.time.sleep = lambda s: None               # ne varjon a backoffra

# A run() lecsereli a modulon a tartalek-fuggvenyt egy stubra, ezert a 4. eset
# mar nem a valodit hivna. Elmentjuk, mielott barmi hozzanyulna.
EREDETI_FALLBACK = wa.send_email_fallback


def run(argv, whatsapp_ok, email_ok):
    """email_ok = a tartalek VALODI kuldese sikerult-e."""
    wa.send_whatsapp_message = lambda *a, **k: whatsapp_ok
    wa.send_email_fallback = lambda *a, **k: email_ok
    sys.argv = ["whatsapp-send.py"] + argv
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        res = wa.main()
    return res, buf.getvalue()


ARGV = ["uzenet", "--skip-launch", "--retries", "2"]
hiba = 0


def eset(cim, ok, reszlet):
    global hiba
    print(f"{cim} {reszlet}  {'OK' if ok else 'BUKOTT'}")
    hiba += 0 if ok else 1


res, out = run(ARGV, False, True)
eset("1. WhatsApp bukott + email ELMENT ->",
     (res is True) and ("BROKEN" in out) and ("NOT DELIVERED" not in out),
     f"visszateres={res} (elvart: True), 'WhatsApp is BROKEN' kiirva={'BROKEN' in out}")

res, out = run(ARGV, False, False)
eset("2. WhatsApp bukott + email sem ment ->",
     (res is False) and ("NOT DELIVERED" in out),
     f"visszateres={res} (elvart: False), NOT DELIVERED kiirva={'NOT DELIVERED' in out}")

res, out = run(ARGV, True, False)
eset("3. KONTROLL -- WhatsApp sikeres ->",
     (res is True) and ("NOT DELIVERED" not in out) and ("BROKEN" not in out),
     f"visszateres={res} (elvart: True)")

# 4. A tartalek-fuggveny SAJAT viselkedese: ha a valodi kuldes bukik, a
# visszateres akkor is False, ha piszkozatot meg sikerult parkolni. Ez a
# kulonbseg a regi es az uj kod kozott -- a regi a piszkozatot sikernek vette.
hivott = []


class Eredmeny:
    def __init__(self, rc): self.returncode, self.stdout, self.stderr = rc, "", ""


def hamis_gmail(cmd, **kw):
    mod = cmd[2]                      # [python, helper, mode, to, subject, file]
    hivott.append(mod)
    return Eredmeny(1 if mod == "send" else 0)   # a kuldes bukik, a piszkozat sikerul


eredeti_run, eredeti_exists = wa.subprocess.run, os.path.exists
wa.subprocess.run = hamis_gmail
os.path.exists = lambda p: True if p.endswith("gmail-send.py") else eredeti_exists(p)
try:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r4 = EREDETI_FALLBACK("szoveg", "cimzett@pelda.hu")
    kimenet = buf.getvalue()
finally:
    wa.subprocess.run, os.path.exists = eredeti_run, eredeti_exists

eset("4. A kuldes bukott, csak piszkozat lett ->",
     (r4 is False) and hivott == ["send", "draft"],
     f"visszateres={r4} (elvart: False), hivott modok={hivott} (elvart: ['send', 'draft'])")

# 5-8. A WhatsApp-ut HASZNALHATATLAN (nem a kuldes bukott, hanem oda sem
# jutunk el). Merve 2026-08-19: a WSL-bol nem latszott a powershell.exe, es a
# script ilyenkor kilepett tartalek nelkul -- Kiss Zoltan semmit nem kapott
# volna. A diagnosztikai kapcsolok viszont TOVABBRA SE kuldjenek.
def run_halott_ut(argv, email_ok, ps_hianyzik=True, fut=True):
    wa.PS_EXE = None if ps_hianyzik else "/stub/powershell.exe"
    wa.whatsapp_is_running = lambda: fut
    wa.send_whatsapp_message = lambda *a, **k: False
    wa.send_email_fallback = lambda *a, **k: email_ok
    sys.argv = ["whatsapp-send.py"] + argv
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        res = wa.main()
    wa.PS_EXE = "/stub/powershell.exe"
    wa.whatsapp_is_running = lambda: True
    return res, buf.getvalue()


res, out = run_halott_ut(ARGV, True)
eset("5. Nincs powershell + email ELMENT ->",
     (res is True) and ("BROKEN" in out),
     f"visszateres={res} (elvart: True), BROKEN kiirva={'BROKEN' in out}")

res, out = run_halott_ut(ARGV, False)
eset("6. Nincs powershell + email sem ment ->",
     (res is False) and ("NOT DELIVERED" in out),
     f"visszateres={res} (elvart: False), NOT DELIVERED kiirva={'NOT DELIVERED' in out}")

kuldott = []
wa_eredeti = wa.send_email_fallback
wa.send_email_fallback = lambda *a, **k: (kuldott.append(1), True)[1]
res, out = run_halott_ut(["uzenet", "--dry-run"], True)
wa.send_email_fallback = wa_eredeti
eset("7. Nincs powershell + --dry-run (csak diagnosztika) ->",
     (res is False) and not kuldott,
     f"visszateres={res} (elvart: False), kuldott-e emailt={bool(kuldott)} (elvart: nem)")

res, out = run_halott_ut(ARGV, True, ps_hianyzik=False, fut=False)
eset("8. Nem fut a WhatsApp + email ELMENT ->",
     (res is True) and ("BROKEN" in out),
     f"visszateres={res} (elvart: True), BROKEN kiirva={'BROKEN' in out}")

print("EREDMENY:", "MIND OK" if hiba == 0 else f"{hiba} eset bukott")
sys.exit(hiba)
