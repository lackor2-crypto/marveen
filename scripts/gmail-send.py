#!/usr/bin/env python3
"""Gmail draft/send with attachment, using the Marvin OAuth token (gmail.send scope).

Usage:
  python3 scripts/gmail-send.py draft  <to> <subject> <file> [file2 ...]
  python3 scripts/gmail-send.py send   <to> <subject> <file> [file2 ...]

- 'draft' creates a Gmail draft (Boss reviews + sends from phone). SAFE default.
- 'send'  sends immediately (level2 -- only on explicit Boss instruction).
Body is auto-filled with a short line; each file becomes an attachment.
Prints the created draft/message id on success.
"""
import sys, os, json, base64, mimetypes, urllib.request, urllib.error
from email.message import EmailMessage

TOKEN = "/home/boss/marveen/store/google-token.json"
CLIENT = "/home/boss/marveen/store/google-oauth-client.json"


def _access_token():
    t = json.load(open(TOKEN))
    # refresh unconditionally -- tokens are short lived
    c = json.load(open(CLIENT))
    data = urllib.parse.urlencode({
        "client_id": c.get("client_id") or c.get("installed", {}).get("client_id"),
        "client_secret": c.get("client_secret") or c.get("installed", {}).get("client_secret"),
        "refresh_token": t["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["access_token"]


def _build(to, subject, files):
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(os.environ.get("MAIL_BODY", "Csatolva a kert dokumentum.\n\n--\nMarvin"))
    for f in files:
        if not os.path.isfile(f):
            raise SystemExit(f"HIBA: nincs ilyen fajl: {f}")
        ctype, _ = mimetypes.guess_type(f)
        maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
        with open(f, "rb") as fh:
            msg.add_attachment(fh.read(), maintype=maintype, subtype=subtype,
                               filename=os.path.basename(f))
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


def _post(url, at, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Authorization": "Bearer " + at,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HIBA {e.code}: {e.read().decode()[:400]}")


def main():
    if len(sys.argv) < 5:
        raise SystemExit(__doc__)
    mode, to, subject = sys.argv[1], sys.argv[2], sys.argv[3]
    files = sys.argv[4:]
    raw = _build(to, subject, files)
    at = _access_token()
    if mode == "draft":
        res = _post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", at,
                    {"message": {"raw": raw}})
        print("DRAFT OK id=" + res.get("id", "?"))
    elif mode == "send":
        res = _post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", at,
                    {"raw": raw})
        print("SENT OK id=" + res.get("id", "?"))
    else:
        raise SystemExit("mode: draft | send")


if __name__ == "__main__":
    main()
