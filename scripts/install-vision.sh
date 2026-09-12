#!/usr/bin/env bash
# Vision components installer for the Marveen agent fleet.
#
# Installs: pytesseract + Pillow (OCR, needs system tesseract-ocr) +
#           face_recognition (dlib-based local face recognition) +
#           fleet helper scripts (OCR text extraction, face match, face
#           enrollment).
#
# System dependencies (tesseract-ocr, tesseract-ocr-hun, cmake,
# build-essential) are NOT installed by this script -- they need root, and
# per CLAUDE.md package_install/privileged_sudo are level-2 categories.
# Install them manually first:
#   sudo apt-get install -y tesseract-ocr tesseract-ocr-hun cmake build-essential
#
# Usage:
#   ./scripts/install-vision.sh                     # installs to ~/.local/share/marveen-vision
#   INSTALL_DIR=/custom/path ./scripts/install-vision.sh
#
# Safe to re-run (idempotent): skips already-completed steps.
# The dlib-based face_recognition package compiles from source and can take
# 10-20 minutes and a lot of memory on a constrained machine -- this is
# expected, not a hang.
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
_step "[1/4] System dependencies (tesseract-ocr, cmake, build tools)"
command -v tesseract &>/dev/null || _fail "tesseract not found -- install manually: sudo apt-get install -y tesseract-ocr tesseract-ocr-hun"
command -v cmake &>/dev/null || _fail "cmake not found -- install manually: sudo apt-get install -y cmake build-essential"
command -v gcc &>/dev/null || _fail "gcc not found -- install manually: sudo apt-get install -y build-essential"
command -v pdftoppm &>/dev/null || _fail "pdftoppm not found -- install manually: sudo apt-get install -y poppler-utils"
python3 -m venv --help &>/dev/null 2>&1 || _fail "python3-venv missing -- install manually: sudo apt-get install -y python3-venv"
_pass "tesseract + cmake + gcc + poppler-utils + python3-venv present"

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
  echo "    Compiling dlib + face_recognition -- this can take 10-20 minutes..."
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
  "$DEST/venv/bin/pip" install --quiet face_recognition
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
