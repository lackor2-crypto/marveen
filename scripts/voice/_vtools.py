#!/usr/bin/env python3
"""Voice tools for the agent fleet (STT + TTS), local + free.

Subcommands:
  transcribe <file_id> <state_dir>
      Download a Telegram voice file by file_id using the bot token in
      <state_dir>/.env, transcribe it (Hungarian; Groq cloud Whisper if
      a "groq-stt-key" secret is configured in the dashboard Vault, else
      local faster-whisper), print the transcript to stdout.

  speak <voice_onnx> <state_dir> <chat_id> <text...>
      Synthesize <text> with the given Piper voice model, convert to
      ogg/opus, and send it as a Telegram voice message via the bot token
      in <state_dir>/.env. Prints "ok=<bool> id=<message_id>".

  canary <voice_onnx> <expected_text...>
      Local-only self-test, no Telegram/network involved: synthesize
      <expected_text> with Piper, transcribe the resulting audio straight
      back with faster-whisper, and compare. Prints a one-line JSON result
      {"passed": bool, "expected": str, "transcript": str, "ratio": float}
      and exits 0 on pass / 1 on fail. Temp wav is always deleted -- never
      touches the live Telegram-facing stt.sh/tts.sh state or sends anything.

The bot token is read from the caller's OWN state dir at call time, never
hardcoded -- so each agent speaks/listens on its own bot.
"""
import os
import re
import sys
import json
import socket
import subprocess
import tempfile
import urllib.request
import urllib.parse
import urllib.error

# api.telegram.org publishes an AAAA record that is not routable from every host, and
# Python's urllib has no happy-eyeballs fallback: each fresh connection stalls on the
# IPv6 attempt before dropping to IPv4. MEASURED 2026-07-27 on the Marveen box: getFile
# took 25.1s with IPv6 allowed vs 0.0s IPv4-only, and a full transcribe ran 2m43s of
# which only 5.5s was CPU. That silently blew the dashboard's 60s STT timeout, so
# /api/voice/directive returned transcript=null and voice messages reached the agent
# untranscribed -- a failure with no error anywhere, just a missing transcript.
# PREFER IPv4, do not EXCLUDE IPv6: an AF_INET-only override would turn a working
# IPv6-only host into a dead one (ENETUNREACH -> transcript=null), which is the same
# silent failure this patch exists to remove, just relocated. Ordering keeps the whole
# measured benefit -- the stalling AAAA attempt no longer comes first -- while a host
# with no IPv4 route still resolves and connects. The caller's own `family` argument is
# passed through untouched, so an explicit AF_INET6 lookup still gets what it asked for.
_orig_getaddrinfo = socket.getaddrinfo


def _getaddrinfo_ipv4_first(host, port, family=0, *args, **kwargs):
    results = _orig_getaddrinfo(host, port, family, *args, **kwargs)
    # Stable sort: AF_INET entries move to the front, every other family keeps the
    # relative order the resolver returned.
    return sorted(results, key=lambda entry: 0 if entry[0] == socket.AF_INET else 1)


socket.getaddrinfo = _getaddrinfo_ipv4_first
# urlretrieve() takes no timeout kwarg -- bound it here so a stalled download can never
# hang unbounded again.
socket.setdefaulttimeout(60)

# Resolved relative to this file so PREFIX-based installs work correctly.
VENV_PY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "venv", "bin", "python")


def _token(state_dir):
    env = open(os.path.join(state_dir, ".env")).read()
    m = re.search(r"^TELEGRAM_BOT_TOKEN=(.+)$", env, re.M)
    if not m:
        sys.exit("no TELEGRAM_BOT_TOKEN in " + state_dir)
    return m.group(1).strip().strip('"').strip("'")


def _groq_key():
    """GROQ_API_KEY from the encrypted Vault (fleet-wide, not per-agent), fetched
    through the dashboard's own API so the secret only ever lives decrypted in
    the Node process -- this script never touches the master key or ciphertext.
    Returns None on any failure (dashboard down, key not configured, network),
    so the caller falls back to local whisper. Boss, 2026-08-07: this used to
    read a plaintext scripts/voice/.env that nothing in the UI explained or
    even offered to configure -- unified into the same Vault the dashboard's
    Vault page documents (id "groq-stt-key")."""
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    try:
        with open(os.path.join(project_root, "store", ".dashboard-token")) as f:
            dashboard_token = f.read().strip()
    except Exception:
        return None
    port = os.environ.get("WEB_PORT", "3420")
    try:
        req = urllib.request.Request(
            f"http://localhost:{port}/api/vault/groq-stt-key",
            headers={"Authorization": f"Bearer {dashboard_token}"},
        )
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read())
        return data.get("value") or None
    except Exception:
        return None


_SETTINGS_CACHE = {}


def _setting(key, default):
    """One config value, resolved the SAME way the Node side resolves it.

    This bridge exists because of a trap worth spelling out: the dashboard's
    Settings page does NOT write environment variables -- `setOverride()` writes
    `store/config-overrides.json`, and Node reads it through
    `getEffectiveSettingValue()`. This script, however, is a separate process
    spawned per voice message and only ever saw `os.environ`. So a setting added
    to SETTINGS_REGISTRY would have rendered in the UI, saved without error, and
    changed NOTHING here -- the worst kind of failure, because it looks like it
    worked. Reading the same file closes that gap.

    Precedence:  os.environ  >  config-overrides.json  >  .env  >  default
    (environ first so a one-off `VAR=x stt.sh ...` still overrides for testing.)
    """
    if key in os.environ and os.environ[key].strip():
        return os.environ[key].strip()
    if key in _SETTINGS_CACHE:
        return _SETTINGS_CACHE[key] if _SETTINGS_CACHE[key] is not None else default

    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    val = None
    try:
        with open(os.path.join(root, "store", "config-overrides.json"), encoding="utf-8") as f:
            val = json.load(f).get(key)
    except Exception:
        val = None
    if val is None:
        try:
            with open(os.path.join(root, ".env"), encoding="utf-8") as f:
                m = re.search(r"^" + re.escape(key) + r"=(.*)$", f.read(), re.M)
            if m:
                val = m.group(1).strip().strip('"').strip("'")
        except Exception:
            val = None
    _SETTINGS_CACHE[key] = val
    return val if val not in (None, "") else default


_VOCAB_CACHE = []


def _stt_vocabulary():
    """Domain words fed to the recogniser as prior context (Whisper `prompt` /
    faster-whisper `initial_prompt`).

    Why this exists: measured on real dictation, ordinary Hungarian came back
    clean and ONLY proper nouns broke -- "Marveen" became "Marlin", "lackor2"
    became "lacskot ketto". Those are not words any general model has seen; the
    prompt parameter is the documented remedy.

    Source: scripts/voice/szotar.txt (or STT_VOCAB_FILE), one comma-separated
    list. Editable by hand -- no rebuild, no restart.

    The 224-token cap is enforced HERE because the API drops the overflow
    SILENTLY: half a vocabulary would look like it was applied. We approximate
    2.5 characters per token for Hungarian and cut on a comma boundary.
    """
    if _VOCAB_CACHE:
        return _VOCAB_CACHE[0]
    p = _setting("STT_VOCAB_FILE", "") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "szotar.txt")
    text = ""
    try:
        with open(p, encoding="utf-8") as f:
            text = " ".join(line.strip() for line in f
                            if line.strip() and not line.startswith("#"))
    except Exception:
        text = ""
    limit = 224 * 2.5           # ~560 characters
    if len(text) > limit:
        cut = text.rfind(",", 0, int(limit))
        text = text[:cut if cut > 0 else int(limit)].rstrip(" ,") + "."
        sys.stderr.write("[stt] szotar.txt exceeds the 224-token prompt cap; "
                         "truncated at a comma boundary\n")
    _VOCAB_CACHE.append(text)
    return text


def _groq_transcribe(path):
    """Cloud STT via Groq's free Whisper endpoint. Returns None on any failure
    (missing key, network, bad response) so the caller falls back to local whisper."""
    key = _groq_key()
    if not key:
        return None
    try:
        # Boss 2026-08-09: default was "whisper-large-v3-turbo". Groq's own docs put
        # turbo at 12% WER vs 10.3% for the full model -- ~17% more errors -- while the
        # speed difference (216x vs 189x realtime) is irrelevant for a voice message.
        # Accuracy is what Boss asked for, so the full model is the default now.
        model = _setting("GROQ_STT_MODEL", "whisper-large-v3")
        boundary = "----marveengroq"
        with open(path, "rb") as f:
            audio = f.read()

        def _part(name, value):
            return ("--" + boundary + "\r\nContent-Disposition: form-data; name=\""
                    + name + "\"\r\n\r\n" + value + "\r\n").encode()

        body = (
            _part("model", model)
            + _part("language", "hu")
            # temperature=0 = greedy decoding: the most deterministic setting and the
            # one that best avoids hallucinated text on silent/noisy stretches.
            # Groq defaults to 0 too, but we state it so a provider-side default
            # change cannot quietly degrade us.
            + _part("temperature", "0")
            # Domain vocabulary. Measured on Boss's own dictation: ordinary Hungarian
            # sentences came back clean and ONLY the proper nouns broke
            # (Marveen -> "Marlin", lackor2 -> "lacskot ketto", pusholni -> "pussolni").
            # Whisper cannot guess names it has never seen; the prompt is the documented
            # fix for exactly this. Limit is 224 tokens -- anything beyond is dropped
            # SILENTLY, so _stt_vocabulary() truncates on a word boundary and says so.
            + (_part("prompt", _stt_vocabulary()) if _stt_vocabulary() else b"")
            + ("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"audio.ogg\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode()
            + audio + b"\r\n" + ("--" + boundary + "--\r\n").encode()
        )
        req = urllib.request.Request("https://api.groq.com/openai/v1/audio/transcriptions", data=body)
        req.add_header("Authorization", "Bearer " + key)
        req.add_header("Content-Type", "multipart/form-data; boundary=" + boundary)
        # Cloudflare (in front of api.groq.com) fingerprints the default
        # "Python-urllib/x.y" UA as bot traffic and returns 403 (Cloudflare
        # error 1010) before the request ever reaches Groq. A normal UA
        # string clears it -- measured 2026-08-04.
        req.add_header("User-Agent", "curl/8.5.0")
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
        return (data.get("text") or "").strip() or None
    except Exception:
        return None


def _audio_duration(path):
    """Seconds of audio via ffprobe; None if it can't be determined."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=15)
        return float(out.stdout.strip())
    except Exception:
        return None


def _pick_model(path):
    """Adaptive STT model: quality on short clips, speed on long ones.

    CPU inference scales ~1.5x audio length. "small" is accurate but on a 26s
    clip takes ~40s -- unusable. "base" does the same clip in ~10s and stays
    intelligible. So: short messages get "small" (accurate, still <~10s wall),
    long messages get "base" (small would be a 30-40s wait). Threshold and
    models are overridable via env for tuning.
    """
    forced = _setting("MARVEEN_STT_MODEL", "")
    if forced:
        return forced
    threshold = float(_setting("MARVEEN_STT_THRESHOLD", "10"))
    dur = _audio_duration(path)
    if dur is not None and dur >= threshold:
        return _setting("MARVEEN_STT_MODEL_LONG", "medium")
    return _setting("MARVEEN_STT_MODEL_SHORT", "medium")


def _whisper(path, words=False):
    # words=True (upstream, 2026-09-12) is a SEPARATE output (JSON with per-word
    # `end` times) for the cut-boundary check; the plain-text words=False path
    # that stt.sh and the canary rely on is unchanged. Word timestamps only come
    # from the local engine, so that mode never takes the cloud route.
    # Boss 2026-08-09: which engine runs was hardcoded as "cloud first, local on
    # failure". That is the right default -- Groq is both more accurate and far
    # faster than CPU inference on this box -- but it left no way to say "stay
    # offline" (no network, or simply not wanting audio to leave the machine).
    #   auto  = Groq, fall back to local   (default, unchanged behaviour)
    #   groq  = cloud only, no local fallback
    #   local = never leave the machine
    engine = _setting("MARVEEN_STT_ENGINE", "auto").strip().lower()
    if engine not in ("auto", "groq", "local"):
        engine = "auto"

    if not words and engine in ("auto", "groq"):
        groq_text = _groq_transcribe(path)
        if groq_text:
            print(groq_text)
            return
        if engine == "groq":
            sys.stderr.write("[stt] MARVEEN_STT_ENGINE=groq and the cloud call "
                             "failed; not falling back to local\n")
            return

    from faster_whisper import WhisperModel
    model = _pick_model(path)
    m = WhisperModel(model, device="cpu", compute_type="int8", cpu_threads=8)
    # temperature=0 pins greedy decoding (no fallback sampling), which is what the
    # literature recommends when accuracy matters more than "always produce
    # something": sampling is where hallucinated text on silence comes from.
    # initial_prompt gives the local engine the same domain vocabulary the cloud
    # path gets -- otherwise the two engines would spell Boss's names differently
    # depending on which one happened to run.
    segs, _ = m.transcribe(path, language="hu", beam_size=5,
                           condition_on_previous_text=False, vad_filter=True,
                           temperature=0, initial_prompt=(_stt_vocabulary() or None),
                           word_timestamps=words)
    segs = list(segs)
    if not words:
        print(" ".join(s.text.strip() for s in segs).strip())
        return
    out = []
    for s_ in segs:
        for w in (getattr(s_, "words", None) or []):
            out.append({"word": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
    print(json.dumps({"text": " ".join(s_.text.strip() for s_ in segs).strip(), "words": out},
                     ensure_ascii=False))


def transcribe(file_id, state_dir):
    # Accept an already-downloaded local file as well as a Telegram file_id: the channel
    # plugin's download_attachment tool hands back a PATH, and feeding that to getFile as
    # a file_id fails with HTTP 400 (hit live 2026-07-27).
    if os.path.isfile(file_id):
        _whisper(file_id)
        return
    token = _token(state_dir)
    d = json.load(urllib.request.urlopen(
        f"https://api.telegram.org/bot{token}/getFile?file_id={urllib.parse.quote(file_id)}",
        timeout=20))
    fp = d["result"]["file_path"]
    fd, out = tempfile.mkstemp(suffix=".ogg")
    os.close(fd)
    try:
        urllib.request.urlretrieve(f"https://api.telegram.org/file/bot{token}/{fp}", out)
        _whisper(out)
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass



class VoiceSendError(RuntimeError):
    """sendVoice failed, and the message carries the reason the API gave.

    e39b8f7b: the caller used to see only ``HTTP Error 400: Bad Request``,
    because ``urlopen`` raises before anyone reads the response body -- and the
    body is where Telegram puts ``description`` ("chat not found", "VOICE_
    MESSAGES_FORBIDDEN", "file must be non-empty"). That string is the whole
    diagnosis, and it was thrown away at the one place it existed.
    """


def _http_error_detail(err):
    """Pull Telegram's own ``description`` out of a 4xx/5xx body.

    The body is read ONCE (it is a stream) and every failure mode below falls
    back to something still useful -- a diagnostic path that raises its own
    exception would hide the very error it is reporting.

    NOT included, deliberately: the request URL. It carries the bot token in the
    path (``/bot<token>/sendVoice``), so putting it in a log line or an
    exception message would leak the credential into places that get copied
    around (kanban comments, inter-agent messages, CI output).
    """
    try:
        raw = err.read()
    except Exception:  # noqa: BLE001 - the stream may already be consumed/closed
        raw = b""
    text = raw.decode("utf-8", "replace").strip()
    try:
        payload = json.loads(text)
    except ValueError:
        payload = None
    if isinstance(payload, dict) and payload.get("description"):
        return str(payload["description"])
    if text:
        # Not JSON (proxy/HTML error page): keep a bounded excerpt, not the lot.
        return text[:300]
    return "(the response had no body)"


def _post_voice(token, chat_id, ogg):
    """POST the ogg to sendVoice and return the parsed JSON answer.

    Two guards, both from e39b8f7b:
      * an EMPTY ogg is caught here, before the network call. Telegram answers a
        zero-byte upload with a 400 whose text does not say "your file is
        empty", so the useful error has to be produced on our side -- and the
        call is skipped, not just annotated.
      * a 4xx/5xx is turned into VoiceSendError carrying the API's description,
        and the same line goes to stderr so it survives in the job log even if
        the caller swallows the exception.
    """
    size = os.path.getsize(ogg)
    if size <= 0:
        raise VoiceSendError(
            "the synthesized voice file is empty (0 bytes) -- not sending; "
            "the TTS/ffmpeg step produced no audio"
        )
    b = "----fleetvoice"
    fd = open(ogg, "rb").read()
    body = (("--" + b + "\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n" + str(chat_id) + "\r\n").encode()
            + ("--" + b + "\r\nContent-Disposition: form-data; name=\"voice\"; filename=\"v.ogg\"\r\nContent-Type: audio/ogg\r\n\r\n").encode()
            + fd + b"\r\n" + ("--" + b + "--\r\n").encode())
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendVoice", data=body)
    req.add_header("Content-Type", "multipart/form-data; boundary=" + b)
    try:
        return json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        detail = _http_error_detail(e)
        print("sendVoice failed: HTTP %s -- %s" % (e.code, detail), file=sys.stderr)
        raise VoiceSendError("sendVoice failed: HTTP %s -- %s" % (e.code, detail)) from e

def speak(voice_onnx, state_dir, chat_id, text):
    token = _token(state_dir)
    fd_wav, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd_wav)
    fd_ogg, ogg = tempfile.mkstemp(suffix=".ogg")
    os.close(fd_ogg)
    try:
        subprocess.run([VENV_PY, "-m", "piper", "-m", voice_onnx, "-f", wav],
                       input=text.encode(), check=True)
        # Optional voice style: deeper + slower (e.g. a melancholic android tone).
        # asetrate lowers pitch AND slows playback; aresample restores the container
        # rate (so the lower pitch sticks). Distribution-safe default = 1.0 (off,
        # natural Piper voice); set VOICE_PITCH in the host env (e.g. dashboard
        # plist) to style a specific deployment. TODO: per-agent voice-style config.
        pitch = os.environ.get("VOICE_PITCH", "1.0")
        af = []
        if pitch and pitch != "1.0":
            af = ["-af", "asetrate=22050*%s,aresample=22050" % pitch]
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", wav, *af, "-c:a", "libopus", "-b:a", "32k", ogg], check=True)
        r = _post_voice(token, chat_id, ogg)
        print("ok=%s id=%s" % (r.get("ok"), (r.get("result") or {}).get("message_id")))
    finally:
        for p in (wav, ogg):
            try:
                os.unlink(p)
            except OSError:
                pass


def _normalize(s):
    s = s.lower()
    s = re.sub(r"[^\w\sáéíóöőúüű]", "", s, flags=re.UNICODE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def canary(voice_onnx, expected_text):
    fd_wav, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd_wav)
    try:
        subprocess.run([VENV_PY, "-m", "piper", "-m", voice_onnx, "-f", wav],
                       input=expected_text.encode(), check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        from faster_whisper import WhisperModel
        m = WhisperModel("medium", device="cpu", compute_type="int8")
        segs, _ = m.transcribe(wav, language="hu", beam_size=5, condition_on_previous_text=False)
        transcript = " ".join(s.text.strip() for s in segs).strip()
        exp_words = _normalize(expected_text).split()
        got_words = set(_normalize(transcript).split())
        common = sum(1 for w in exp_words if w in got_words)
        ratio = common / max(1, len(exp_words))
        passed = ratio >= 0.8
        print(json.dumps({"passed": passed, "expected": expected_text,
                           "transcript": transcript, "ratio": round(ratio, 2)}))
        sys.exit(0 if passed else 1)
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "transcribe":
        transcribe(sys.argv[2], sys.argv[3])
    elif cmd == "speak":
        speak(sys.argv[2], sys.argv[3], sys.argv[4], " ".join(sys.argv[5:]))
    elif cmd == "transcribe-words":
        # Lokalis fajl -> JSON szo-szintu idokkel. Telegram file_id-t NEM fogad: a hivoi (pl. a
        # vagas-hatar verify) maguk vagjak ki a klipet ffmpeg-gel.
        _whisper(sys.argv[2], words=True)
    elif cmd == "canary":
        canary(sys.argv[2], " ".join(sys.argv[3:]))
    else:
        sys.exit("usage: _vtools.py transcribe <file_id> <state_dir> | transcribe-words <file> | speak <voice_onnx> <state_dir> <chat_id> <text...> | canary <voice_onnx> <expected_text...>")
