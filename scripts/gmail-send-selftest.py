#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Onellenorzo a gmail-send.py fiokvalasztasahoz. Halozat nelkul fut.

Miert kell: 2026-08-19-en ez a script volt az EGYETLEN, ami meg a regi,
egyfiokos store/google-token.json-t olvasta, mikozben a rendszer rég a
fiok-kulcsolt tarra allt at. A regi fajlt semmi nem ujitotta -> a levelkuldes
`invalid_grant`-tal bukott, mikozben a feluleten mind a 10 fiok zold volt. Ez a
proba azt orzi, hogy a valasztas ne csusszon vissza a halott utra.

Titkot nem ir ki: a tesztek kitalalt "DUMMY" tokenekkel dolgoznak.
"""
import importlib.util
import json
import os
import sys
import tempfile

HIBA = 0


def eset(nev, ok, reszlet=""):
    global HIBA
    print(("  OK   " if ok else "  BUKOTT ") + nev + ("" if ok else "  -- " + reszlet))
    if not ok:
        HIBA += 1


def betolt(store_dir):
    """A scriptet a MARVEEN_STORE-ral toltjuk be, igy a valodi store-hoz nem nyulunk."""
    os.environ["MARVEEN_STORE"] = store_dir
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gmail-send.py")
    spec = importlib.util.spec_from_file_location("gmail_send_%d" % id(store_dir), p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def ir(d, nev, tartalom):
    with open(os.path.join(d, nev), "w", encoding="utf-8") as f:
        json.dump(tartalom, f)


REC = {"refresh_token": "DUMMY", "email": "lackor2@gmail.com"}
REC2 = {"refresh_token": "DUMMY2", "email": "usalackor@gmail.com"}

print("gmail-send.py fiokvalasztas:")

# 1. A fiok-kulcsolt tarbol a _default fiok jon.
with tempfile.TemporaryDirectory() as d:
    ir(d, "google-tokens.json", {"_default": "lackor2", "lackor2": REC, "usalackor": REC2})
    ir(d, "google-token.json", {"refresh_token": "REGI-HALOTT"})
    m = betolt(d)
    rec, honnan = m._token_record()
    eset("1. a _default fiokot valasztja",
         rec["refresh_token"] == "DUMMY" and "lackor2@gmail.com" in honnan,
         "kapott: %s" % honnan)
    eset("1b. NEM a regi, halott fajlt olvassa",
         rec["refresh_token"] != "REGI-HALOTT", "a legacy tokent valasztotta")

# 2. A MARVEEN_GOOGLE_ACCOUNT felulirja.
with tempfile.TemporaryDirectory() as d:
    ir(d, "google-tokens.json", {"_default": "lackor2", "lackor2": REC, "usalackor": REC2})
    os.environ["MARVEEN_GOOGLE_ACCOUNT"] = "usalackor"
    m = betolt(d)
    rec, honnan = m._token_record()
    del os.environ["MARVEEN_GOOGLE_ACCOUNT"]
    eset("2. a kert fiokot valasztja", rec["refresh_token"] == "DUMMY2", honnan)

# 3. Nem letezo fiok: HANGOSAN bukik, es felsorolja a letezoket -- nem esik
#    vissza csendben egy masik cimre, mert az idegennek kuldott level rosszabb,
#    mint a hibauzenet.
with tempfile.TemporaryDirectory() as d:
    ir(d, "google-tokens.json", {"_default": "lackor2", "lackor2": REC})
    os.environ["MARVEEN_GOOGLE_ACCOUNT"] = "nincs-ilyen"
    m = betolt(d)
    try:
        m._token_record()
        eset("3. ismeretlen fiok -> hiba", False, "nem dobott hibat")
    except SystemExit as e:
        eset("3. ismeretlen fiok -> beszedes hiba",
             "lackor2" in str(e) and "nincs-ilyen" in str(e), str(e)[:120])
    del os.environ["MARVEEN_GOOGLE_ACCOUNT"]

# 4. Migracio elotti telepites: nincs fiok-kulcsolt tar -> a regi fajl a jo.
with tempfile.TemporaryDirectory() as d:
    ir(d, "google-token.json", {"refresh_token": "REGI"})
    m = betolt(d)
    rec, honnan = m._token_record()
    eset("4. fiok-tar nelkul a regi fajl jon", rec["refresh_token"] == "REGI", honnan)

# 5. Semmi sincs: beszedes hiba, nem nyers KeyError.
with tempfile.TemporaryDirectory() as d:
    m = betolt(d)
    try:
        m._token_record()
        eset("5. token nelkul -> hiba", False, "nem dobott hibat")
    except SystemExit as e:
        eset("5. token nelkul -> beszedes hiba", "Fiokok" in str(e), str(e)[:120])

print("EREDMENY:", "MIND OK" if HIBA == 0 else "%d eset bukott" % HIBA)
sys.exit(0 if HIBA == 0 else 3)
