#!/usr/bin/env python3
"""GOLD (XAUUSD) gyertya- es indikator-adatok kiolvasasa a MetaTrader 4 SAJAT
history-fajljaibol -- kepernyokep, fokusz es kattintas nelkul.

MIERT: az arany-heartbeat eddig ugy olvasta le a chartot, hogy kattintott az MT4
toolbarjara es screenshotot keszitett. Ez ketszeresen is torekeny (kanban
bd02805a): ha a MetaTrader nem kapja meg a fokuszt -- mert Boss eppen dolgozik
--, a kattintas AZ O ablakaba megy (2026-08-10-en tobbszor megtortent), es ha az
MT4 talcara van rejtve, egyaltalan nem lehet lefotozni (a PrintWindow feketet
ad). Mindket hiba ugyanabbol jon: a kepernyo kozos eroforras.

A megoldas nem kulso ar-forras: a COMEX-hatarido (Yahoo GC=F) ~40 dollarral a
spot FOLOTT jar, es egy tamasz/ellenallas szint, ami 40 dollarral el van csuszva
attol amit Boss a sajat chartjan lat, rosszabb mint a semmi. Az MT4 viszont a
sajat, broker-oldali gyertyait kiirja a lemezre (history/<szerver>/<SYMBOL><perc>.hst)
-- ugyanaz az adat ami a charton van, csak fajlbol. Nem kell hozza se lathato
ablak, se MetaEditor, se MQL4-forditas.

Az .hst formatum: 148 bajtos fejlec, majd fix meretu rekordok. A 401-es
(build 600+) valtozat 60 bajtos rekordokat hasznal (ctm int64, OHLC double,
volume int64, spread int32, real_volume int64); a regi 400-as 44 bajtosat
(ctm int32, open/low/high/close double, volume double) -- mindketto tamogatott.

FONTOS a friss­esegrol: az MT4 nem minden tick utan ir lemezre, hanem
idoszakosan. A kimenet ezert MINDIG tartalmazza az utolso gyertya idejet es a
fajl korat is -- az elemzes ezzel egyutt ertelmezendo, sose ugy mintha
masodperc-pontos live ar lenne.

Hasznalat:
  gold-data.py                 # mind a 4 idosik, JSON
  gold-data.py --tf M15        # csak egy idosik
  gold-data.py --human         # rovid, olvashato osszefoglalo
"""
import argparse
import glob
import json
import os
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone

SYMBOL = "GOLD"
# MT4 a PERCEK szamaval nevezi el a fajlt: M5 -> GOLD5.hst, D1 -> GOLD1440.hst
TIMEFRAMES = {"D1": 1440, "H1": 60, "M15": 15, "M5": 5}
HEADER_SIZE = 148

# FRISSESSEG-KAPU kuszob (kanban 891a30f6). A dontest az UTOLSO GYERTYA kora hozza,
# nem a fajl mtime-ja (az .hst mtime frissulhet uj gyertya nelkul is). A kuszob
# idosikonkent aranyos: N x az idosik perce, also korlattal. Igy egy D1 gyertya
# ejjel (majdnem egy napos, de a mai nap FRISS gyertyaja) nem riaszt hamisan
# (6 x 1440 = 8640 perc = 6 nap), egy 30+ perces M5 viszont igen (6 x 5 = 30 perc).
FRISSESSEG_N = 6
FRISSESSEG_MIN_PERC = 20  # also korlat, hogy a legrovidebb idosik se legyen tul szoros
# A live EA-snapshot ennel fiatalabb "generated" bejegyzese jelenti azt, hogy a
# piac NYITVA van ES az MT4 tenylegesen tolt. Ennel oregebb (vagy hianyzo) snapshot
# eseten NEM talalgatunk: lehet hetvege/unnep, de lehet halott EA is.
LIVE_FRISS_PERC = 15

# A GOLD_Live_Export EA a telepites MQL4/Files mappajaba irja a friss snapshotot
# (kanban 70efa568 / #93). Ha ez a fajl letezik es ervenyes, ELSOBBSEGET elvez a
# .hst-vel szemben, mert az MT4 a .hst-t csak ritkan flusholja lemezre -> a
# live-fajl a formalodo (shift=0) gyertyat is tartalmazza, tehat masodperc-friss.
LIVE_FILE_NAME = "gold_live.txt"

# MIERT NINCS ITT FIX UTVONAL: a MetaTrader telepitesi mappaja gepenkent mas, es
# ezen a gepen 2026 augusztusaban at is koltozott
# (D:\Tozsde_telepitesi_mappa\Activtrades_Mt4 -> F:\...\MT4_ActivTrades).
# A beegetett regi ut miatt mind a negy idosik hibat adott, a szkript viszont
# 0-val lepett ki es a "nincs live snapshot" sort irta ki -- az utemezett feladat
# ezt sikeres, csak eppen ures meresnek latta. Sorrend most: .env -> gyorsitotar
# -> automatikus kereses, es ha egyik sem talal, HANGOS hiba nem-nulla koddal.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_KEY = "MT4_TERMINAL_DIR"
CACHE_FILE = os.path.join(REPO_ROOT, "store", "mt4-terminal-dir.txt")


def _env_value(key):
    """Egy kulcs erteke: eloszor a folyamat kornyezetebol, aztan a repo .env-jebol."""
    val = os.environ.get(key)
    if val and val.strip():
        return val.strip()
    try:
        with open(os.path.join(REPO_ROOT, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    v = line[len(key) + 1:].strip().strip('"').strip("'")
                    return v or None
    except OSError:
        pass
    return None


def is_terminal_dir(path):
    """Igaz, ha ez tenylegesen egy MT4 telepites gyokere (terminal.exe + history)."""
    return bool(path) and os.path.isfile(os.path.join(path, "terminal.exe")) \
        and os.path.isdir(os.path.join(path, "history"))


def _mounted_windows_drives():
    out = []
    for entry in sorted(glob.glob("/mnt/?")):
        if os.path.isdir(entry) and len(os.path.basename(entry)) == 1:
            try:
                if os.listdir(entry):
                    out.append(entry)
            except OSError:
                continue
    return out


def discover_terminal_dir(max_depth=7, timeout_per_drive=180):
    """Vegigneézi a csatolt Windows-meghajtokat egy MT4 gyokerert. Draga, ezert
    csak akkor fut, ha se a .env, se a gyorsitotar nem adott ervenyes utat -- a
    talalatot elmentjuk, hogy legkozelebb ne kelljen ujra keresni. Az a talalat
    nyer, amelyikben van SYMBOL*.hst, azok kozul a legfrissebb."""
    found = []
    for drive in _mounted_windows_drives():
        try:
            res = subprocess.run(
                ["find", drive, "-maxdepth", str(max_depth), "-type", "f",
                 "-iname", "terminal.exe"],
                capture_output=True, text=True, timeout=timeout_per_drive)
        except (subprocess.TimeoutExpired, OSError):
            continue
        for line in res.stdout.splitlines():
            root = os.path.dirname(line.strip())
            if is_terminal_dir(root):
                found.append(root)
    if not found:
        return None

    def rank(root):
        bars = glob.glob(os.path.join(root, "history", "*", SYMBOL + "*.hst"))
        if not bars:
            return (0, 0.0)
        return (1, max(os.path.getmtime(b) for b in bars))

    found.sort(key=rank, reverse=True)
    return found[0]


# Ha NINCS a gepen MetaTrader, a kereses vegigmegy az osszes meghajton (percek).
# Utemezett feladatnal ez 45 percenkent ismetlodne, ezert a SIKERTELEN kereses
# eredmenyet is megjegyezzuk -- de csak ennyi idore, hogy egy kesobb feltelepitett
# MT4 magatol elokeruljon. A --keres azonnal felulirja.
NEG_CACHE_FILE = CACHE_FILE + ".nincs"
NEG_CACHE_TTL = 6 * 3600


def _save_cache(path):
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            f.write(path + "\n")
        if os.path.exists(NEG_CACHE_FILE):
            os.remove(NEG_CACHE_FILE)
    except OSError:
        pass  # a gyorsitotar kenyelem, nem feltetel


def _recent_failed_search():
    """Igaz, ha nemreg mar kerestunk es nem talaltunk semmit."""
    try:
        return (time.time() - os.path.getmtime(NEG_CACHE_FILE)) < NEG_CACHE_TTL
    except OSError:
        return False


def _mark_failed_search():
    try:
        os.makedirs(os.path.dirname(NEG_CACHE_FILE), exist_ok=True)
        with open(NEG_CACHE_FILE, "w", encoding="utf-8") as f:
            f.write("nem talaltam MetaTrader telepitest " + time.strftime("%Y-%m-%d %H:%M") + "\n")
    except OSError:
        pass


def resolve_terminal_dir(allow_search=True, force_search=False):
    """{path, forras, hiba} -- a MetaTrader telepitesi mappaja.
    A `hiba` mindig emberi mondat, mert ez kerul a felhasznalo ele."""
    if not force_search:
        cfg = _env_value(ENV_KEY)
        if cfg:
            if is_terminal_dir(cfg):
                return {"path": cfg, "forras": ".env"}
            return {"path": None, "forras": ".env", "hiba":
                    f"A .env-ben a {ENV_KEY} erre mutat: {cfg} -- de ott nincs "
                    f"terminal.exe es history mappa. Javitsd az utat, vagy vedd ki "
                    f"a sort es hagyd hogy a szkript megkeresse (--keres)."}
        try:
            with open(CACHE_FILE, encoding="utf-8") as f:
                cached = f.read().strip()
            if is_terminal_dir(cached):
                return {"path": cached, "forras": "gyorsitotar"}
        except OSError:
            pass
    if not allow_search:
        return {"path": None, "forras": None, "hiba":
                f"Nincs beallitva MetaTrader-mappa ({ENV_KEY} a .env-ben)."}
    if not force_search and _recent_failed_search():
        return {"path": None, "forras": None, "hiba":
                "Nemreg mar vegigkerestem a meghajtokat es nem talaltam MetaTrader "
                "telepitest, ezert most nem kerestem ujra. Ha kozben feltelepitetted: "
                "python3 scripts/gold-data.py --keres --human"}
    found = discover_terminal_dir()
    if found:
        _save_cache(found)
        return {"path": found, "forras": "kereses"}
    _mark_failed_search()
    return {"path": None, "forras": None, "hiba":
            "Nem talalok MetaTrader telepitest a csatolt meghajtokon "
            f"({', '.join(_mounted_windows_drives()) or 'nincs csatolt meghajto'}). "
            f"Ha mashol van, ird be a repo .env fajljaba: {ENV_KEY}=/mnt/<betu>/.../<MT4 mappa>"}


def mt4_running():
    """Fut-e a terminal.exe? True / False / None (nem tudtam megnezni).

    MIERT KELL: az elavult adat KET, ellentetes dolgot jelenthet. Hetvegen a
    piac zarva van, ilyenkor a penteki utolso gyertya a HELYES allapot es nincs
    mirol szolni. Hetkoznap viszont ugyanaz az elavultsag azt jelenti, hogy az
    MT4 nem fut -- es akkor a legfontosabb sor az, hogy ezt kimondjuk. A ket
    esetet nem a gyertyak korabol talalgatjuk, hanem magatol a forrastol
    kerdezzuk meg: fut-e a folyamat."""
    for exe in ("/mnt/c/Windows/System32/tasklist.exe", "tasklist.exe"):
        try:
            res = subprocess.run([exe, "/FI", "IMAGENAME eq terminal.exe", "/NH"],
                                 capture_output=True, text=True, timeout=30)
        except (subprocess.TimeoutExpired, OSError):
            continue
        if res.returncode != 0:
            continue
        return "terminal.exe" in res.stdout.lower()
    return None  # nem tudtam megnezni -- ezt is ki kell mondani, nem "nem fut"


def resolve_history_dir(root):
    """(history/<szerver>, szerverek listaja). Nem egetjuk be a szerver nevet
    (ActivTradesCorp-5): azt a mappat valasztjuk, amelyikben tenyleg van
    SYMBOL*.hst, tobb talalat eseten a legfrissebbet."""
    base = os.path.join(root, "history")
    if not os.path.isdir(base):
        return None, []
    servers = sorted(d for d in os.listdir(base)
                     if os.path.isdir(os.path.join(base, d)))
    hits = [os.path.join(base, s) for s in servers
            if glob.glob(os.path.join(base, s, SYMBOL + "*.hst"))]
    if not hits:
        return None, servers
    hits.sort(key=lambda p: max(os.path.getmtime(f)
                                for f in glob.glob(os.path.join(p, SYMBOL + "*.hst"))),
              reverse=True)
    return hits[0], servers


def read_hst(path, max_bars=1200):
    """Az utolso `max_bars` gyertya beolvasasa. Csak a fajl VEGET olvassuk --
    a GOLD5.hst 28 MB, az egeszet betolteni feleslegesen draga lenne. 1200 gyertya
    eleg ahhoz hogy a Wilder-simitasu mutatok (RSI, ATR) beallajanak."""
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        version = struct.unpack("<i", f.read(4))[0]
        rec_size = 60 if version >= 401 else 44
        total = (size - HEADER_SIZE) // rec_size
        take = min(max_bars, total)
        f.seek(HEADER_SIZE + (total - take) * rec_size)
        bars = []
        for _ in range(take):
            raw = f.read(rec_size)
            if len(raw) < rec_size:
                break
            if rec_size == 60:
                ctm, o, h, l, c, vol, spread, rvol = struct.unpack("<qddddqiq", raw)
            else:
                ctm, o, l, h, c, vol = struct.unpack("<iddddd", raw)
            bars.append({"t": int(ctm), "o": o, "h": h, "l": l, "c": c})
    return bars, version, total


def read_live(path):
    """A GOLD_Live_Export EA snapshot-fajljanak beolvasasa. Visszaad egy dict-et
    {generated, iso, bid, ask, digits, tf:{NEV:[bars]}} vagy None-t, ha a fajl
    hianyzik / serult / nem a mienk. A serules elleni vedelem az utolso "END <n>"
    sor: ha hianyzik vagy nem egyezik a beolvasott B-sorok szamaval, a fajl eppen
    iras kozben van (vagy csonka) -> None, es a hivo a .hst-re esik vissza."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="ascii", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return None
    meta = None
    tf = {}
    bar_count = 0
    end_n = None
    for line in lines:
        p = line.split()
        if not p:
            continue
        tag = p[0]
        if tag == "META" and len(p) >= 8:
            meta = {
                "symbol": p[1],
                "generated": int(p[2]),
                "iso": p[3] + " " + p[4],
                "bid": float(p[5]),
                "ask": float(p[6]),
                "digits": int(p[7]),
            }
        elif tag == "TF" and len(p) >= 4:
            tf.setdefault(p[1], [])
        elif tag == "B" and len(p) >= 8:
            tf.setdefault(p[1], []).append({
                "t": int(p[2]), "o": float(p[3]), "h": float(p[4]),
                "l": float(p[5]), "c": float(p[6]),
            })
            bar_count += 1
        elif tag == "END" and len(p) >= 2:
            end_n = int(p[1])
    if meta is None or end_n is None or end_n != bar_count:
        return None  # csonka vagy eppen-iras-alatti fajl
    meta["tf"] = tf
    return meta


def sma(values, n):
    return sum(values[-n:]) / n if len(values) >= n else None


def ema_series(values, n):
    if len(values) < n:
        return []
    k = 2 / (n + 1)
    out = [sum(values[:n]) / n]
    for v in values[n:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def rsi(closes, n=14):
    """Wilder-simitas, ahogy az MT4 is szamolja."""
    if len(closes) < n + 1:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0.0)
        losses += max(-d, 0.0)
    ag, al = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(d, 0.0)) / n
        al = (al * (n - 1) + max(-d, 0.0)) / n
    if al == 0:
        return 100.0
    return 100 - 100 / (1 + ag / al)


def macd(closes, fast=12, slow=26, signal=9):
    """FONTOS: az MT4 beepitett MACD-je a jelvonalat EGYSZERU mozgoatlaggal
    (MODE_SMA) szamolja, nem EMA-val, ellentetben a "klasszikus" MACD-vel.
    EMA-val szamolva a jelvonal lathatoan elter attol amit Boss a charton lat
    (merve 2026-08-10: D1-en -6.5 az MT4 -12.6-ja helyett), ezert itt is SMA."""
    ef, es = ema_series(closes, fast), ema_series(closes, slow)
    if not ef or not es:
        return None, None
    ef = ef[-len(es):]
    line = [a - b for a, b in zip(ef, es)]
    if len(line) < signal:
        return round(line[-1], 4), None
    sig = sum(line[-signal:]) / signal
    return round(line[-1], 4), round(sig, 4)


def atr(bars, n=14):
    if len(bars) < n + 1:
        return None
    trs = []
    for i in range(1, len(bars)):
        p, b = bars[i - 1], bars[i]
        trs.append(max(b["h"] - b["l"], abs(b["h"] - p["c"]), abs(b["l"] - p["c"])))
    a = sum(trs[:n]) / n
    for tr in trs[n:]:
        a = (a * (n - 1) + tr) / n
    return round(a, 2)


def stochastic(bars, k=5, d=3, slowing=3):
    """MT4 alapertelmezett Stochastic(5,3,3): a nyers %K-t `slowing` hosszan
    simitjuk, a %D pedig ennek a `d` hosszu mozgoatlaga."""
    if len(bars) < k + slowing + d:
        return None, None
    raw = []
    for i in range(k - 1, len(bars)):
        window = bars[i - k + 1:i + 1]
        hi = max(b["h"] for b in window)
        lo = min(b["l"] for b in window)
        raw.append(0.0 if hi == lo else (bars[i]["c"] - lo) / (hi - lo) * 100)
    smooth = [sum(raw[i - slowing + 1:i + 1]) / slowing for i in range(slowing - 1, len(raw))]
    if len(smooth) < d:
        return round(smooth[-1], 2), None
    return round(smooth[-1], 2), round(sum(smooth[-d:]) / d, 2)


def analyse(tf, minutes, live, history_dir):
    # ELSOBBSEG a live snapshotnak (kanban #93): ha az EA-fajl ervenyes es erre az
    # idosikra eleg gyertyat tartalmaz, abbol szamolunk -- ez a shift=0 formalodo
    # gyertyat is hozza, tehat friss. Kulonben a .hst a tartalek.
    version = None
    if live is not None and len(live.get("tf", {}).get(tf, [])) >= 30:
        bars = live["tf"][tf]
        source = "live"
        stamp = live["generated"]
    else:
        path = os.path.join(history_dir, f"{SYMBOL}{minutes}.hst")
        if not os.path.exists(path):
            return {"tf": tf, "error": f"nincs history fajl: {path}"}
        bars, version, total = read_hst(path)
        source = "hst"
        stamp = os.path.getmtime(path)
    if len(bars) < 30:
        return {"tf": tf, "error": f"tul keves gyertya ({len(bars)})"}
    closes = [b["c"] for b in bars]
    last = bars[-1]
    macd_line, macd_sig = macd(closes)
    k, d = stochastic(bars)
    out = {
        "tf": tf,
        "forras": source,
        "utolso_gyertya": datetime.fromtimestamp(last["t"], timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        # A DONTESRE alkalmas szam: az utolso gyertya kora. A fajl mtime (lentebb)
        # frissulhet uj gyertya nelkul is, ezert a frissesseg-kapu ezt hasznalja.
        # Megjegyzes a broker-idorol: az .hst gyertyaideje broker-idozonaban van
        # (jellemzoen UTC+2/+3) -- egy pozitiv eltolas a friss gyertyat meg
        # fiatalabbnak (akar negativnak) mutatja, tehat sosem okoz HAMIS "elavult"-ot;
        # a kaput ugyis csak nagy (tobb oras/napos) elmaradasnal billenti at.
        "utolso_gyertya_kora_perc": round((time.time() - last["t"]) / 60),
        "fajl_frissitve": datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "fajl_kora_perc": round((time.time() - stamp) / 60),
        "o": round(last["o"], 2), "h": round(last["h"], 2),
        "l": round(last["l"], 2), "c": round(last["c"], 2),
        "ma20": round(sma(closes, 20), 2) if sma(closes, 20) else None,
        "ma100": round(sma(closes, 100), 2) if sma(closes, 100) else None,
        "rsi14": round(rsi(closes), 2) if rsi(closes) else None,
        "macd": macd_line, "macd_signal": macd_sig,
        "atr14": atr(bars),
        "stoch_k": k, "stoch_d": d,
        "gyertyak": len(bars),
    }
    if source == "live":
        out["elo_bid"] = round(live["bid"], 2)
        out["elo_ask"] = round(live["ask"], 2)
    else:
        out["hst_verzio"] = version
    return out


def piac_nyitva_becsles(live, most, friss_perc=LIVE_FRISS_PERC):
    """A "piac nyitva" jelzest EGYETLEN becsuletes forrasbol vesszuk: a live EA-
    snapshot frissessegebol. Ha a snapshot friss, a piac nyitva ES az MT4 tolti az
    adatot -> True. Ha nincs snapshot vagy elavult, NEM talalgatunk (lehet hetvege,
    de lehet halott EA is) -> None. A naptari hetveget SZANDEKOSAN nem hasznaljuk
    verdiktre: unnepnap is van, es a piac-orak brokerenkent elternek -- a hetvege-ora
    legfeljebb a kiirt SZOVEGET lagyithatja, a verdiktet soha.

    Visszaad: True (nyitva es tolt) vagy None (nem tudom). False-t szandekosan
    SOHA nem ad: nincs olyan forrasunk, ami a zarva-t pozitivan igazolna."""
    if live is None:
        return None
    try:
        kor_perc = (most - live["generated"]) / 60
    except (KeyError, TypeError):
        return None
    return True if kor_perc <= friss_perc else None


def frissesseg_kapu(idosikok, running, live, most, n=FRISSESSEG_N):
    """TISZTA fuggveny (kanban 891a30f6): idosikonkent eldonti, friss-e az adat.
    Minden bemenet parameter -- idosikok = analyse() eredmenyeinek listaja,
    running = mt4_running() (bool/None, csak a szoveghez), live = read_live()
    (dict/None), most = time.time() --, hogy a --selftest halozat es fajl nelkul
    hivhassa.

    A REGI hiba, amit javit (bd->891a30f6): a fo kimenet a legFRISSEBB idosik korat
    nezte (min(ages)) es csak akkor szolt, ha AZ is 2 orajas volt. Igy ha D1/H1/M15
    friss es csak az M5 all 3855 perce, a figyelmeztetes SOHA nem futott le. Itt
    idosikonkent, KULON verdikttel dontunk, es az osszesitest a legELAVULTABB hozza.

    Idosikonkenti verdikt:
      'ok'         -- az utolso gyertya a kuszob alatt (N x idosik-perc, also korlat).
      'elavult'    -- a gyertya a kuszob folott ES a piac nyitva (live friss): ez
                      valodi baj, ez az idosik chartja valoszinuleg nincs nyitva.
      'nem_tudom'  -- a gyertya a kuszob folott, DE nincs friss live snapshot, tehat
                      nem tudom, a piac zarva van-e (hetvege/unnep) vagy az MT4 nem
                      tolti ezt az idosikot.
      'nincs_adat' -- ezen az idosikon nincs beolvasott gyertya (hianyzo .hst, tul
                      keves gyertya): friss telepitesen ez a normal, NEM 'elavult'."""
    piac = piac_nyitva_becsles(live, most)
    reszletek = {}
    korok = []
    for r in idosikok:
        tf = r.get("tf", "?")
        if "utolso_gyertya_kora_perc" not in r:
            reszletek[tf] = {
                "allapot": "nincs_adat",
                "gyertya_kora_perc": None,
                "kuszob_perc": None,
                "indoklas": r.get("error", "nincs beolvasott gyertya ezen az idosikon"),
            }
            continue
        kora = r["utolso_gyertya_kora_perc"]
        korok.append(kora)
        kuszob = max(n * TIMEFRAMES.get(tf, 0), FRISSESSEG_MIN_PERC)
        gy = r.get("utolso_gyertya", "?")
        if kora <= kuszob:
            allapot = "ok"
            indoklas = f"{tf}: friss (utolso gyertya {kora} perce, kuszob {kuszob} perc)."
        elif piac is True:
            allapot = "elavult"
            indoklas = (f"FIGYELEM -- a(z) {tf} chart nincs nyitva vagy nem frissul az "
                        f"MT4-ben, pedig a piac nyitva (a live snapshot friss): "
                        f"utolso gyertya {gy}, {kora} perce -- a kuszob {kuszob} perc.")
        else:
            allapot = "nem_tudom"
            indoklas = (f"{tf}: az utolso gyertya {gy}, {kora} perce (kuszob {kuszob} "
                        f"perc), de nincs friss live snapshot, ezert nem tudom, a piac "
                        f"zarva van-e (hetvege/unnep), vagy az MT4 nem tolti ezt az idosikot.")
        reszletek[tf] = {
            "allapot": allapot,
            "gyertya_kora_perc": kora,
            "kuszob_perc": kuszob,
            "indoklas": indoklas,
        }
    van_elavult = any(v["allapot"] == "elavult" for v in reszletek.values())
    van_nemtudom = any(v["allapot"] == "nem_tudom" for v in reszletek.values())
    if van_elavult:
        verdikt = "elavult"
    elif not korok:
        verdikt = "nincs_adat"
    elif van_nemtudom:
        verdikt = "nem_tudom"
    else:
        verdikt = "ok"
    return {
        "verdikt": verdikt,
        "piac_nyitva": piac,
        "legelavultabb_adat_kora_perc": max(korok) if korok else None,
        "idosikok": reszletek,
    }


def _selftest():
    """Rejtett onellenorzo (a repoban nincs python teszt-futtato). Halozat es fajl
    NELKUL, szintetikus bemeneteken hivja a tiszta fuggvenyeket. Hibanal nem-nullaval
    lep ki -- a src/__tests__/gold-frissesseg.test.ts ezt execFileSync-kel futtatja."""
    most = 1_000_000_000  # fix epoch -> determinisztikus
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    # piac-becsles: csak True vagy None, SOHA nem False
    check(piac_nyitva_becsles(None, most) is None, "live=None -> None")
    check(piac_nyitva_becsles({"generated": most - 60}, most) is True, "friss live -> True")
    check(piac_nyitva_becsles({"generated": most - 3 * 3600}, most) is None,
          "elavult live -> None (nem False, nem True)")

    d1 = {"tf": "D1", "utolso_gyertya_kora_perc": 1380, "utolso_gyertya": "reggeli D1"}
    m5_regi = {"tf": "M5", "utolso_gyertya_kora_perc": 3855,
               "utolso_gyertya": "2026-08-21 18:45 UTC"}

    # 1) friss D1 + 3855 perces M5, friss live -> M5 'elavult', D1 'ok', verdikt 'elavult'
    k = frissesseg_kapu([d1, m5_regi], True, {"generated": most - 120}, most)
    check(k["idosikok"]["M5"]["allapot"] == "elavult", "M5(3855) + piac nyitva -> elavult")
    check(k["idosikok"]["D1"]["allapot"] == "ok", "D1(1380) friss -> ok (ejjel nem riaszt)")
    check(k["verdikt"] == "elavult", "osszesitett verdikt elavult (a legelavultabb hozza)")
    check(k["legelavultabb_adat_kora_perc"] == 3855, "legelavultabb = 3855 (nem a min)")

    # 2) nulla .hst (hianyzo fajl) -> 'nincs_adat', NEM 'elavult'
    k2 = frissesseg_kapu([{"tf": "M5", "error": "nincs history fajl: /.../GOLD5.hst"}],
                         True, {"generated": most - 120}, most)
    check(k2["idosikok"]["M5"]["allapot"] == "nincs_adat", "hianyzo .hst -> nincs_adat")
    check(k2["idosikok"]["M5"]["allapot"] != "elavult", "hianyzo .hst NEM elavult")
    check(k2["verdikt"] == "nincs_adat", "csak hianyzo idosik -> verdikt nincs_adat")

    # 3) nincs live snapshot -> 'nem_tudom', NEM 'ok'
    k3 = frissesseg_kapu([d1, m5_regi], True, None, most)
    check(k3["idosikok"]["M5"]["allapot"] == "nem_tudom", "nincs live + regi M5 -> nem_tudom")
    check(k3["idosikok"]["M5"]["allapot"] != "ok", "nincs live + regi M5 NEM ok")
    check(k3["idosikok"]["D1"]["allapot"] == "ok", "nincs live + friss D1 -> ok")

    if failures:
        print("SELFTEST BUKAS (%d):" % len(failures), file=sys.stderr)
        for f in failures:
            print("  - " + f, file=sys.stderr)
        return 1
    print("selftest OK")
    return 0


def fail(human, message, hint=None, code=2):
    """Hangos, ertheto leallas. A nulla ket dolgot jelenthetne (nincs adat vs.
    nem latok oda), ezert itt sosem terunk vissza csendben ures eredmennyel."""
    payload = {"error": message}
    if hint:
        payload["teendo"] = hint
    if human:
        print("HIBA -- " + message, file=sys.stderr)
        if hint:
            print("       " + hint, file=sys.stderr)
    else:
        # ugyanaz a burok mint sikeres futasnal, hogy a hivo ne ket alakot lasson
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", choices=list(TIMEFRAMES), help="csak ez az egy idosik")
    ap.add_argument("--human", action="store_true", help="rovid, olvashato kimenet")
    ap.add_argument("--keres", action="store_true",
                    help="a MetaTrader mappa ujra-keresese (a gyorsitotar es a .env megkerulesevel)")
    ap.add_argument("--selftest", action="store_true",
                    help=argparse.SUPPRESS)  # rejtett: a frissesseg-kapu onellenorzese
    args = ap.parse_args()

    if args.selftest:
        return _selftest()

    # 1. lepes: HOL van a MetaTrader? Ha nincs meg, az nem "ures meres", hanem hiba.
    res = resolve_terminal_dir(force_search=args.keres)
    if not res["path"]:
        return fail(args.human, res["hiba"],
                    f"Ha tudod az utat: ird be a .env-be, hogy {ENV_KEY}=/mnt/.../<MT4 mappa>. "
                    "Ha nem tudod: futtasd ezt -- python3 scripts/gold-data.py --keres --human",
                    code=2)
    root = res["path"]

    # 2. lepes: van-e GOLD elozmeny EBBEN a telepitesben? A ket eset kulon uzenet:
    #    "megvan a MetaTrader, de meg nincs GOLD adata" != "nem latom a mappat".
    history_dir, servers = resolve_history_dir(root)
    if not history_dir:
        return fail(
            args.human,
            f"A MetaTrader mappa megvan ({root}, forras: {res['forras']}), de nincs benne "
            f"egyetlen {SYMBOL} elozmeny-fajl sem" +
            (f" (atnezett szerver-mappak: {', '.join(servers)})" if servers else
             " (a history mappa ures)") + ".",
            f"Nyisd meg az MT4-ben a {SYMBOL} chartot es varj amig letolti az elozmenyt "
            "(Eszkozok -> Beallitasok -> Chartok -> a max. sav-szam legyen eleg nagy).",
            code=3)

    live_path = os.path.join(root, "MQL4", "Files", LIVE_FILE_NAME)
    wanted = {args.tf: TIMEFRAMES[args.tf]} if args.tf else TIMEFRAMES
    live = read_live(live_path)
    out = [analyse(tf, m, live, history_dir) for tf, m in wanted.items()]

    running = mt4_running()
    most = time.time()
    # A frissesseg-kapu idosikonkent, az UTOLSO GYERTYA korabol dont (kanban 891a30f6).
    kapu = frissesseg_kapu(out, running, live, most)
    ages = [r["fajl_kora_perc"] for r in out if "fajl_kora_perc" in r]
    frissesseg = {
        "mt4_fut": running,
        "piac_nyitva": kapu["piac_nyitva"],
        "verdikt": kapu["verdikt"],
        # kompat: a REGI mezo (fajl mtime alapjan, a legfrissebb idosik) marad,
        "legfrissebb_adat_kora_perc": min(ages) if ages else None,
        # DE a dontest mostantol a legELAVULTABB idosik GYERTYA-kora hozza:
        "legelavultabb_adat_kora_perc": kapu["legelavultabb_adat_kora_perc"],
        "idosikok": kapu["idosikok"],
    }
    if running is None:
        frissesseg["megjegyzes"] = ("Nem tudtam megnezni, fut-e az MT4, ezert az adat "
                                    "korat nem tudom megmagyarazni.")
    elif not running:
        frissesseg["megjegyzes"] = ("Az MT4 NEM fut, ezert ez az adat nem frissul -- "
                                    "a lentiek a legutobbi futas ota valtozatlanok.")
    elif kapu["verdikt"] == "elavult":
        frissesseg["megjegyzes"] = ("Az MT4 fut es a piac nyitva, DE van olyan idosik, "
                                    "amelyik nem frissul (lasd idosikonkent lentebb). "
                                    "Valoszinuleg annak a chartja nincs nyitva az MT4-ben.")
    elif kapu["verdikt"] == "nem_tudom":
        frissesseg["megjegyzes"] = ("Van tobb tizperces/orajas idosik, de nincs friss "
                                    "live snapshot, ezert nem tudom, a piac zarva van-e "
                                    "(hetvege/unnep) vagy egy chart nem frissul.")

    if args.human:
        print(f"[mappa] {root}  (forras: {res['forras']})")
        print(f"[hist ] {history_dir}")
        if running is None:
            print("[mt4  ] nem tudtam megnezni, fut-e a terminal.exe")
        else:
            print(f"[mt4  ] terminal.exe {'FUT' if running else 'NEM FUT'}"
                  + ("" if running else " -- ezert nem frissul az adat"))
        if live is not None:
            print(f"[live] EA snapshot {live['iso']} | bid {round(live['bid'],2)} ask {round(live['ask'],2)} | "
                  f"{round((time.time()-live['generated'])/60)} perce")
        elif not os.path.exists(live_path):
            print(f"[hst ] nincs live snapshot ({live_path} nem letezik) -- .hst tartalekbol. "
                  "A GOLD_Live_Export EA nincs a charton, vagy nem fut.")
        else:
            print(f"[hst ] a live snapshot ervenytelen vagy eppen iras alatt "
                  f"({live_path}) -- .hst tartalekbol")
        for r in out:
            if "error" in r:
                print(f"{r['tf']:>4}: HIBA -- {r['error']}")
                continue
            print(f"{r['tf']:>4} ({r['forras']}): ar {r['c']}  (O {r['o']} H {r['h']} L {r['l']})  "
                  f"MA20 {r['ma20']} MA100 {r['ma100']}  RSI {r['rsi14']}  "
                  f"MACD {r['macd']}/{r['macd_signal']}  ATR {r['atr14']}  "
                  f"Stoch {r['stoch_k']}/{r['stoch_d']}")
            print(f"      utolso gyertya: {r['utolso_gyertya']} | {r['fajl_kora_perc']} perce")
        # Frissesseg-kapu: idosikonkent egy emberi mondat -- csak akkor, ha nem 'ok',
        # hogy a valos problema (nem frissulo chart) ne vesszen el a szamok kozott.
        for tf, v in kapu["idosikok"].items():
            if v["allapot"] != "ok":
                print(v["indoklas"])
        if "megjegyzes" in frissesseg:
            print("FIGYELEM -- " + frissesseg["megjegyzes"])
    else:
        print(json.dumps({"frissesseg": frissesseg, "idosikok": out},
                         ensure_ascii=False, indent=2))

    # Kilepokod (az utemezo ezt latja):
    #   4 = MINDEN idosik hibas (nincs egy hasznalhato sem)
    #   5 = az MT4 fut es a piac nyitva, DE van elavult idosik (valodi, teendot igenylo baj)
    #   0 = kulonben (a 'nem_tudom' NEM buktat: nem vagyunk biztosak benne, hogy baj van)
    if not any("error" not in r for r in out):
        return 4
    if kapu["verdikt"] == "elavult":
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
