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
import json
import os
import struct
import sys
import time
from datetime import datetime, timezone

# A telepites portable modban fut, a history a telepitesi mappaban van.
MT4_HISTORY = "/mnt/d/Tozsde_telepitesi_mappa/Activtrades_Mt4/history/ActivTradesCorp-5"
SYMBOL = "GOLD"
# MT4 a PERCEK szamaval nevezi el a fajlt: M5 -> GOLD5.hst, D1 -> GOLD1440.hst
TIMEFRAMES = {"D1": 1440, "H1": 60, "M15": 15, "M5": 5}
HEADER_SIZE = 148


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


def analyse(tf, minutes):
    path = os.path.join(MT4_HISTORY, f"{SYMBOL}{minutes}.hst")
    if not os.path.exists(path):
        return {"tf": tf, "error": f"nincs history fajl: {path}"}
    bars, version, total = read_hst(path)
    if len(bars) < 30:
        return {"tf": tf, "error": f"tul keves gyertya ({len(bars)})"}
    closes = [b["c"] for b in bars]
    last = bars[-1]
    macd_line, macd_sig = macd(closes)
    k, d = stochastic(bars)
    file_mtime = os.path.getmtime(path)
    return {
        "tf": tf,
        "utolso_gyertya": datetime.fromtimestamp(last["t"], timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fajl_frissitve": datetime.fromtimestamp(file_mtime).strftime("%Y-%m-%d %H:%M"),
        "fajl_kora_perc": round((time.time() - file_mtime) / 60),
        "o": round(last["o"], 2), "h": round(last["h"], 2),
        "l": round(last["l"], 2), "c": round(last["c"], 2),
        "ma20": round(sma(closes, 20), 2) if sma(closes, 20) else None,
        "ma100": round(sma(closes, 100), 2) if sma(closes, 100) else None,
        "rsi14": round(rsi(closes), 2) if rsi(closes) else None,
        "macd": macd_line, "macd_signal": macd_sig,
        "atr14": atr(bars),
        "stoch_k": k, "stoch_d": d,
        "gyertyak": len(bars), "hst_verzio": version,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tf", choices=list(TIMEFRAMES), help="csak ez az egy idosik")
    ap.add_argument("--human", action="store_true", help="rovid, olvashato kimenet")
    args = ap.parse_args()

    wanted = {args.tf: TIMEFRAMES[args.tf]} if args.tf else TIMEFRAMES
    out = [analyse(tf, m) for tf, m in wanted.items()]

    if args.human:
        for r in out:
            if "error" in r:
                print(f"{r['tf']:>4}: HIBA -- {r['error']}")
                continue
            print(f"{r['tf']:>4}: ar {r['c']}  (O {r['o']} H {r['h']} L {r['l']})  "
                  f"MA20 {r['ma20']} MA100 {r['ma100']}  RSI {r['rsi14']}  "
                  f"MACD {r['macd']}/{r['macd_signal']}  ATR {r['atr14']}  "
                  f"Stoch {r['stoch_k']}/{r['stoch_d']}")
            print(f"      utolso gyertya: {r['utolso_gyertya']} | fajl {r['fajl_kora_perc']} perce frissult")
        return
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
