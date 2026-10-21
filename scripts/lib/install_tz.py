"""The install's time zone for Python helpers (ISSUE1895, #1895).

Same rule as APP_TZ in src/config.ts and scripts/lib/install-tz.sh: SCHEDULER_TZ
(store/config-overrides.json over .env), else the host zone by NAME (a ZoneInfo
keeps the DST rules), else the process's own offset.
"""
import json
import os
from datetime import datetime

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - python < 3.9
    ZoneInfo = None


def _pinned_zone(root):
    try:
        with open(os.path.join(root, "store", "config-overrides.json"), encoding="utf-8") as f:
            ov = json.load(f)
        if isinstance(ov, dict) and ov.get("SCHEDULER_TZ"):
            return str(ov["SCHEDULER_TZ"]).strip()
    except Exception:
        pass
    try:
        value = ""
        with open(os.path.join(root, ".env"), encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line.startswith("SCHEDULER_TZ="):
                    value = line.split("=", 1)[1].strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                        value = value[1:-1]
        return value
    except Exception:
        return ""


def _host_zone_name():
    tz = (os.environ.get("TZ") or "").lstrip(":").strip()
    if tz and "/" in tz:
        return tz
    try:
        target = os.path.realpath("/etc/localtime")
        if "/zoneinfo/" in target:
            return target.split("/zoneinfo/", 1)[1]
    except Exception:
        pass
    return ""


def install_tz(root):
    """tzinfo of the install zone; never raises."""
    if ZoneInfo is not None:
        for zone in (_pinned_zone(root), _host_zone_name()):
            if zone:
                try:
                    return ZoneInfo(zone)
                except Exception:
                    pass  # a misspelled zone: the next candidate, like config.ts
    return datetime.now().astimezone().tzinfo
