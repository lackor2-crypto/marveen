#!/usr/bin/env python3
"""Telegram caption cap: flag a caption that was cut at Telegram's limit and,
when the owner dictated it on this machine, restore the full text.

Why (#447, measured 2026-09-30): the owner dictates into Telegram with the
Windows desktop dictation tool (windows/hu-diktalas), very often into the
caption of a screenshot. Telegram caps a caption at 1024 characters (4096 with
Premium) and sends nothing past the cap -- no second message, no error. Three
owner messages were cut exactly there (1122 -> 1023, 1250 -> 1024 and three
dictations of ~1700 -> 1024 characters): the agent got a sentence broken off
mid-word and never learned that the rest existed. It was reported as "the
dictation cuts long speech", yet the dictation log held every word -- the cut
happened between Telegram and the agent.

What was past the cap cannot be fetched from Telegram. Two things can be done:
  1. say it -- the agent learns in the same turn that the caption ends at the
     cap, so it does not act on half a message as if it were whole;
  2. restore it -- the dictation tool logs every transcript it pastes
     (`kesz: <text>`, the target app one line above). When that log is on this
     machine and the caption is the beginning of the owner's dictations pasted
     into Telegram just before the message was sent, the full text is rebuilt.

Imported by the two hooks a Telegram message reaches an agent through, both
already wired for every agent, so nothing new has to be registered:
  * channel-inbox-drain.py -- queued messages (the sub-agent path);
  * voice-reply-directive.py -- the --channels path, where the <channel> block
    is the prompt itself.
Both call it fail-open: an error here never stops a message from arriving.
"""
import glob
import html
import os
import re
import sys
from datetime import datetime, timedelta

CAPS = (1024, 4096)
# Telegram trims trailing whitespace, so a caption cut at the cap can come out
# a few characters short of it (measured: 1023).
SLACK = 16

CHANNEL_RX = re.compile(r'<channel\s+([^>]*)>(.*?)</channel>', re.S)
ATTR_RX = re.compile(r'(\w+)="([^"]*)"')

LOG_ENV = "HU_DIKTALAS_LOG"
LOG_GLOB = "/mnt/*/Users/*/.hu-diktalas/diktal-auto.log"
TAIL_BYTES = 512 * 1024
LOG_LINE_RX = re.compile(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)  (.*)$')
# How far back a dictation may belong to the caption, and how much clock skew
# between the Telegram server timestamp and this machine is tolerated.
WINDOW_BEFORE = timedelta(minutes=45)
WINDOW_AFTER = timedelta(seconds=5)


def utf16_len(s):
    # Telegram counts UTF-16 code units, not code points.
    return len(s.encode("utf-16-le")) // 2


def cap_hit(body):
    n = utf16_len(body)
    for cap in CAPS:
        if cap - SLACK <= n <= cap:
            return cap
    return None


def _norm(s):
    return re.sub(r'\s+', '', s)


def find_dictation_log(env=None):
    env = os.environ if env is None else env
    explicit = env.get(LOG_ENV)
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    cands = glob.glob(LOG_GLOB)
    if env.get("USERPROFILE"):
        cands.append(os.path.join(env["USERPROFILE"], ".hu-diktalas", "diktal-auto.log"))
    cands = [c for c in set(cands) if os.path.isfile(c)]
    if not cands:
        return None
    return max(cands, key=os.path.getmtime)


def read_tail(path, limit=TAIL_BYTES):
    with open(path, "rb") as f:
        f.seek(0, 2)
        size = f.tell()
        f.seek(max(0, size - limit))
        data = f.read()
    text = data.decode("utf-8", "replace")
    if size > limit:
        text = text.split("\n", 1)[-1]  # drop the partial first line
    return text


def parse_log(text):
    """Every pasted transcript: [{time, target, text}] in log order."""
    out = []
    target = None
    last = None
    for raw in text.splitlines():
        line = raw.rstrip("\r").lstrip("\ufeff")
        m = LOG_LINE_RX.match(line)
        if not m:
            # A transcript with a line break continues on untimestamped lines.
            if last is not None and line.strip():
                last["text"] += "\n" + line
            continue
        stamp, msg = m.groups()
        last = None
        if msg.startswith("mikrofon:"):
            target = None
        elif msg.startswith("beillesztes ide: "):
            target = msg[len("beillesztes ide: "):].strip()
        elif msg.startswith("kesz: "):
            try:
                when = datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S")
            except ValueError:
                continue
            last = {"time": when, "target": target or "", "text": msg[len("kesz: "):]}
            out.append(last)
            target = None
    return out


def restore(caption, entries, sent_at):
    """The owner's full text behind a capped caption, or None.

    The caption must be the BEGINNING of the owner's consecutive dictations
    pasted into Telegram up to the moment the message was sent (whitespace is
    ignored: pasted pieces are glued together without a separator). Returns
    {"text": ..., "pieces": n}, or {"complete": True} when the dictations add
    nothing past the caption (it was not cut after all).
    """
    cap_n = _norm(caption)
    if len(cap_n) < 40:
        return None
    pool = [
        e for e in entries
        if "telegram" in e["target"].lower()
        and sent_at - WINDOW_BEFORE <= e["time"] <= sent_at + WINDOW_AFTER
    ]
    for i in range(len(pool) - 1, -1, -1):
        run = pool[i:]
        joined = _norm("".join(e["text"] for e in run))
        if joined.startswith(cap_n):
            if len(joined) <= len(cap_n):
                return {"complete": True}
            return {"text": " ".join(e["text"].strip() for e in run), "pieces": len(run)}
    return None


def _sent_at(attrs, now=None):
    ts = attrs.get("ts") or ""
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
    except ValueError:
        return now or datetime.now()


def _safe(text):
    # The same neutralising the inbox drain applies: restored text must not be
    # able to open or close a <channel> block in the model's view.
    return re.sub(r"<(?=[A-Za-z/!])", "&lt;", text)


def notices(text, log_path=None, now=None, find_log=find_dictation_log):
    """One notice per capped Telegram caption found in `text` (joined by
    newlines), or "" when there is none."""
    out = []
    entries = None
    for m in CHANNEL_RX.finditer(text or ""):
        attrs = {k: html.unescape(v) for k, v in ATTR_RX.findall(m.group(1))}
        if "telegram" not in attrs.get("source", ""):
            continue
        if "image_path" not in attrs and not any(k.startswith("attachment_") for k in attrs):
            continue  # plain text: Telegram does not cap it this way
        body = html.unescape(m.group(2)).strip()
        cap = cap_hit(body)
        if not cap:
            continue
        mid = attrs.get("message_id") or "?"
        restored = None
        # Only a private chat is matched against the owner's own dictations.
        if not attrs.get("chat_id", "").startswith("-"):
            if entries is None:
                entries = []
                try:
                    path = log_path or find_log()
                    if path:
                        entries = parse_log(read_tail(path))
                except Exception:
                    entries = []
            if entries:
                restored = restore(body, entries, _sent_at(attrs, now))
        if restored and restored.get("complete"):
            continue
        if restored:
            out.append(
                "[TELEGRAM-KÉPALÁÍRÁS LEVÁGVA -- VISSZAÁLLÍTVA] A(z) %s. üzenet képpel/"
                "csatolmánnyal érkezett, a szövege KÉPALÁÍRÁS. A Telegram a képaláírást "
                "%d karakternél levágja, és ami ezen túl volt, azt el sem küldte. A "
                "tulajdonos ezt a szöveget ezen a gépen diktálta; a diktáló naplójában "
                "TELJES terjedelmében megvan (%d karakter, %d diktálás). A teljes szöveg:\n"
                "<<<\n%s\n>>>\n"
                "Ezt tekintsd a tulajdonos üzenetének, ne a levágott változatot. A "
                "válaszodban egy mondatban jelezd, hogy a Telegram levágta a képaláírást, "
                "de a teljes szöveget a diktálási naplóból megkaptad."
                % (mid, cap, len(restored["text"]), restored["pieces"], _safe(restored["text"]))
            )
        else:
            tail = body[-80:].replace("\n", " ")
            out.append(
                "[TELEGRAM-KÉPALÁÍRÁS LEVÁGVA] A(z) %s. üzenet képpel/csatolmánnyal "
                "érkezett, a szövege KÉPALÁÍRÁS, és %d karakter hosszú -- pont a Telegram "
                "%d karakteres képaláírás-határán. A vége szinte biztosan hiányzik: a "
                "Telegram a határon túli részt el sem küldte, ezért sehonnan nem olvasható "
                "vissza. Ne találgasd a hiányzó részt, és ne kezeld a levágott szöveget "
                "teljes utasításként. A válaszod ELEJÉN mondd meg a tulajdonosnak, hogy "
                "az üzenete a képaláírás-határnál megszakadt (utolsó szavai: \"...%s\"), "
                "és kérd, hogy a folytatást külön üzenetben, kép nélkül küldje."
                % (mid, utf16_len(body), cap, _safe(tail))
            )
    return "\n".join(out)


def self_test():
    import tempfile

    def block(body, **attrs):
        base = {"source": "telegram", "chat_id": "42", "message_id": "7",
                "ts": "2026-09-30T16:59:39.000Z", "image_path": "/tmp/x.jpg"}
        base.update(attrs)
        a = " ".join('%s="%s"' % (k, v) for k, v in base.items() if v is not None)
        return "<channel %s>%s</channel>" % (a, body)

    def local(iso):
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)

    sent = local("2026-09-30T16:59:39.000Z")
    stamp = lambda d: (sent + d).strftime("%Y-%m-%d %H:%M:%S")

    d1 = "Elso diktalas a kepernyokeprol, " + "a" * 360 + " vege egy."
    d2 = "Masodik diktalas, " + "b" * 540 + " vege ketto."
    d3 = "Harmadik diktalas, " + "c" * 720 + " VEGE HAROM."
    later = "Ez mar kulon uzenet volt, a kuldes utan."
    elsewhere = "Ez a Wordbe ment, nem a Telegramba."
    log = "\n".join([
        "%s  mikrofon: [0] Microphone" % stamp(timedelta(minutes=-6)),
        "%s  beillesztes ide: Telegram" % stamp(timedelta(minutes=-5)),
        "%s  kesz: Egy korabbi, kulon elkuldott uzenet." % stamp(timedelta(minutes=-5)),
        "%s  beillesztes ide: Telegram" % stamp(timedelta(minutes=-3, seconds=-23)),
        "%s  kesz: %s" % (stamp(timedelta(minutes=-3, seconds=-23)), d1),
        "",
        "%s  beillesztes ide: WINWORD" % stamp(timedelta(minutes=-2, seconds=-40)),
        "%s  kesz: %s" % (stamp(timedelta(minutes=-2, seconds=-40)), elsewhere),
        "%s  beillesztes ide: Telegram" % stamp(timedelta(minutes=-2, seconds=-11)),
        "%s  kesz: %s" % (stamp(timedelta(minutes=-2, seconds=-11)), d2[:300]),
        d2[300:],
        "%s  beillesztes ide: Telegram" % stamp(timedelta(seconds=-24)),
        "%s  kesz: %s" % (stamp(timedelta(seconds=-24)), d3),
        "%s  beillesztes ide: Telegram" % stamp(timedelta(minutes=1, seconds=7)),
        "%s  kesz: %s" % (stamp(timedelta(minutes=1, seconds=7)), later),
    ]) + "\n"

    entries = parse_log("\ufeff" + log)
    assert [e["target"] for e in entries] == ["Telegram", "Telegram", "WINWORD", "Telegram", "Telegram", "Telegram"], entries
    assert entries[3]["text"] == d2[:300] + "\n" + d2[300:], "continuation line"

    # Telegram glued the three pastes together and cut at 1024.
    caption = (d1 + d2 + d3)[:1024]
    assert cap_hit(caption) == 1024 and cap_hit(caption[:-5].rstrip()) == 1024
    assert cap_hit(caption[:900]) is None and cap_hit("x" * 2000) is None and cap_hit("x" * 4096) == 4096
    assert utf16_len("\U0001F600") == 2

    with tempfile.TemporaryDirectory() as td:
        path = os.path.join(td, "diktal-auto.log")
        with open(path, "w", encoding="utf-8") as f:
            f.write(log)
        no_log = lambda: None

        # 1. the 2026-09-30 case: three dictations in one caption, restored in
        #    full; the Word paste and the later separate message are left out.
        out = notices("hi\n" + block(caption), log_path=path)
        assert "VISSZAÁLLÍTVA" in out and "3 diktálás" in out, out
        assert "VEGE HAROM." in out and later not in out and elsewhere not in out, out
        assert "Egy korabbi" not in out, out

        # 2. same caption, no dictation log on this machine: say where it broke.
        out = notices(block(caption), find_log=no_log)
        assert "[TELEGRAM-KÉPALÁÍRÁS LEVÁGVA]" in out and "VISSZAÁLLÍTVA" not in out, out
        assert caption[-40:] in out and "1024 karakteres" in out, out

        # 3. a caption under the cap, and a plain text message at 1024: silent.
        assert notices(block(caption[:700]), log_path=path) == ""
        assert notices(block(caption, image_path=None), log_path=path) == ""

        # 4. a document caption counts too (attachment_* instead of image_path).
        out = notices(block(caption, image_path=None, attachment_kind="document"), find_log=no_log)
        assert "LEVÁGVA" in out, out

        # 5. near the cap but complete: the dictation is exactly the caption.
        whole = "Teljes diktalas, " + "d" * 995
        log2 = "%s  beillesztes ide: Telegram\n%s  kesz: %s\n" % (stamp(timedelta(seconds=-9)), stamp(timedelta(seconds=-9)), whole)
        p2 = os.path.join(td, "l2.log")
        with open(p2, "w", encoding="utf-8") as f:
            f.write(log2)
        assert cap_hit(whole) == 1024
        assert notices(block(whole), log_path=p2) == ""

        # 6. a group chat is never matched against the owner's dictations.
        out = notices(block(caption, chat_id="-100123"), log_path=path)
        assert "LEVÁGVA" in out and "VISSZAÁLLÍTVA" not in out, out

        # 7. drained bodies carry "&lt;" for tag-like "<": measured unescaped,
        #    and restored text cannot open a tag.
        tagged = "<b>" + caption[3:]
        assert cap_hit(html.unescape("&lt;b>" + caption[3:])) == 1024
        out = notices(block("&lt;b>" + caption[3:]), find_log=no_log)
        assert "LEVÁGVA" in out, out
        assert "<b>" not in _safe(tagged) and "&lt;b>" in _safe(tagged)

        # 8. two messages in one drained batch -> two notices; non-Telegram silent.
        out = notices(block(caption, message_id="1") + "\n" + block(caption, message_id="2"), find_log=no_log)
        assert out.count("LEVÁGVA]") == 2, out
        assert notices(block(caption, source="slack"), find_log=no_log) == ""

        # 9. the log tail reader drops a partial first line.
        big = os.path.join(td, "big.log")
        with open(big, "w", encoding="utf-8") as f:
            f.write("x" * 100 + "\n" + log)
        assert parse_log(read_tail(big, limit=len(log.encode("utf-8")) + 10))[-1]["text"] == later

        # 10. log discovery: explicit env wins; a missing explicit path is None.
        assert find_dictation_log({LOG_ENV: path}) == path
        assert find_dictation_log({LOG_ENV: os.path.join(td, "nincs.log")}) is None

    print("telegram_caption_limit self-test passed")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        self_test()


if __name__ == "__main__":
    main()
