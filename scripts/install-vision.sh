#!/usr/bin/env bash
# Vision components installer for the Marveen agent fleet.
#
# Installs: pytesseract + Pillow (OCR, needs system tesseract-ocr) +
#           face_recognition (dlib-based local face recognition) +
#           fleet helper scripts (OCR text extraction, face match, face
#           enrollment).
#
# System dependencies are NOT installed by this script -- they need root.
# Required: python3-venv. For OCR: tesseract-ocr, tesseract-ocr-hun,
# poppler-utils (the main installers put these on the box). cmake +
# build-essential only on a machine with no prebuilt dlib wheel:
#   sudo apt-get install -y python3-venv tesseract-ocr tesseract-ocr-hun poppler-utils
#
# The main installers (install-linux.sh, install-macos.sh) run this script on
# every fresh install, and the dashboard runs it on start when the face
# recognizer is still missing (src/vision-install.ts, #514).
#
# Usage:
#   ./scripts/install-vision.sh                     # installs to ~/.local/share/marveen-vision
#   INSTALL_DIR=/custom/path ./scripts/install-vision.sh
#
# Safe to re-run (idempotent): skips already-completed steps.
# dlib comes as a prebuilt wheel where one exists (seconds); only a machine
# without a matching wheel compiles it from source, which can take 10-20
# minutes and a lot of memory -- expected, not a hang.
set -euo pipefail

DEST="${INSTALL_DIR:-$HOME/.local/share/marveen-vision}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VISION_SRC="$REPO_ROOT/scripts/vision"

_pass() { echo "    [PASS] $*"; }
_fail() { echo "    [FAIL] $*" >&2; exit 1; }
_skip() { echo "    [SKIP] $*"; }
_step() { echo ""; echo "==> $*"; }

echo "==> Vision component installer"
echo "    Target: $DEST"

# --- Step 1: System dependencies check (never installed here) ---
# Only python3-venv is a hard requirement. Since #514 dlib comes as a prebuilt
# wheel (dlib-bin), so cmake + a C compiler are needed ONLY when no wheel fits
# this machine and dlib has to be compiled -- checked there, not here.
# tesseract / pdftoppm are what the OCR helper calls at run time: missing
# ones are reported, but they do not stop the face recognizer from installing.
_step "[1/4] System dependencies (python3-venv; tesseract + poppler for OCR)"
python3 -m venv --help &>/dev/null 2>&1 || _fail "python3-venv missing -- install manually: sudo apt-get install -y python3-venv"
_pass "python3-venv present"
command -v tesseract &>/dev/null || echo "    [WARN] tesseract not found -- OCR will not work until: sudo apt-get install -y tesseract-ocr tesseract-ocr-hun"
command -v pdftoppm &>/dev/null || echo "    [WARN] pdftoppm not found -- PDF OCR will not work until: sudo apt-get install -y poppler-utils"

# --- Step 2: Python venv ---
_step "[2/4] Python venv"
mkdir -p "$DEST"
if [[ ! -d "$DEST/venv" ]]; then
  python3 -m venv "$DEST/venv"
  _pass "venv created at $DEST/venv"
else
  _skip "venv exists"
fi

# --- Step 3: Python packages ---
_step "[3/4] Python packages (pytesseract + Pillow + face_recognition)"
if "$DEST/venv/bin/python" -c "import pytesseract, PIL" 2>/dev/null; then
  _skip "OCR packages already installed"
else
  "$DEST/venv/bin/pip" install --quiet --upgrade pip
  "$DEST/venv/bin/pip" install --quiet pytesseract Pillow
  _pass "pytesseract + Pillow installed"
fi
if "$DEST/venv/bin/python" -c "import face_recognition" 2>/dev/null; then
  _skip "face_recognition already installed"
else
  # face_recognition_models (the large landmark-data package face_recognition
  # depends on) is too big for PyPI, so upstream ships it as a dependency-link
  # in setup.py instead of a normal PyPI release. setuptools >=81 dropped the
  # legacy easy_install machinery that used to resolve those links, so a plain
  # "pip install face_recognition" fails on modern toolchains with a
  # setuptools/pkg_resources error before it ever reaches dlib. Fix (matches
  # the current community-documented workaround, see ageitgey/face_recognition
  # issues #1265 and #764): pin setuptools below 81, then install
  # face_recognition_models directly from its git repo before face_recognition
  # itself.
  "$DEST/venv/bin/pip" install --quiet "setuptools<81"
  "$DEST/venv/bin/pip" install --quiet git+https://github.com/ageitgey/face_recognition_models
  # dlib: prebuilt wheel first (dlib-bin -- Linux x86_64/aarch64, macOS arm64,
  # Windows; seconds, no compiler). It installs the same `dlib` module under a
  # different distribution name, so face_recognition then goes in with
  # --no-deps (its own "dlib" requirement would start a source build anyway)
  # and its remaining dependencies are listed by hand.
  if "$DEST/venv/bin/python" -c "import dlib" 2>/dev/null; then
    _skip "dlib already installed"
  elif "$DEST/venv/bin/pip" install --quiet --only-binary=:all: dlib-bin; then
    _pass "dlib installed from a prebuilt wheel (dlib-bin)"
  else
    command -v cmake &>/dev/null || _fail "no prebuilt dlib for this machine, and cmake is missing to compile it -- install manually: sudo apt-get install -y cmake build-essential python3-dev"
    command -v gcc &>/dev/null || command -v cc &>/dev/null || _fail "no prebuilt dlib for this machine, and no C compiler to build it -- install manually: sudo apt-get install -y build-essential python3-dev"
    echo "    No prebuilt dlib for this machine -- compiling it, this can take 10-20 minutes..."
    "$DEST/venv/bin/pip" install --quiet dlib
    _pass "dlib compiled from source"
  fi
  "$DEST/venv/bin/pip" install --quiet Click numpy Pillow
  "$DEST/venv/bin/pip" install --quiet --no-deps face_recognition
  _pass "face_recognition installed"
fi
"$DEST/venv/bin/python" -c "import pytesseract, PIL, face_recognition" || _fail "package import check failed"

# --- Step 4: Helper scripts ---
_step "[4/4] Installing fleet helper scripts"
cp "$VISION_SRC/ocr_extract.py"   "$DEST/ocr_extract.py"
cp "$VISION_SRC/face_recognize.py" "$DEST/face_recognize.py"
cp "$VISION_SRC/face_enroll.py"    "$DEST/face_enroll.py"
chmod +x "$DEST/ocr_extract.py" "$DEST/face_recognize.py" "$DEST/face_enroll.py"
_pass "ocr_extract.py, face_recognize.py, face_enroll.py deployed"

# --- Done ---
echo ""
echo "==> Installation complete: $DEST"
echo "    OCR:  $DEST/venv/bin/python $DEST/ocr_extract.py <image-or-pdf>"
echo "    Face: $DEST/venv/bin/python $DEST/face_recognize.py <photo> <gallery-dir>"
