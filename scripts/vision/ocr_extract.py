#!/usr/bin/env python3
"""Local OCR text extraction for the Marveen Beerkezo inbox classifier.

Usage: ocr_extract.py <path-to-image-or-pdf>

Prints the extracted text to stdout (UTF-8) and exits 0 on success.
On any failure (unreadable file, no text found, missing dependency) it
prints nothing and exits 1 -- the caller (life-vision-adapter.ts) treats
a non-zero exit as "no text available", never as a crash.

PDFs are rendered to PNG (first page only, that's enough to find a date
in an unfamiliar document) via poppler's pdftoppm, which is a system
dependency installed alongside tesseract, not a pip package.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import pytesseract
    from PIL import Image
except ImportError as exc:
    print(f"missing python dependency: {exc}", file=sys.stderr)
    sys.exit(1)

LANG = "hun+eng"


def ocr_image(image_path: str) -> str:
    return pytesseract.image_to_string(Image.open(image_path), lang=LANG)


def ocr_pdf_first_page(pdf_path: str) -> str:
    with tempfile.TemporaryDirectory() as tmp:
        prefix = str(Path(tmp) / "page")
        result = subprocess.run(
            ["pdftoppm", "-png", "-f", "1", "-l", "1", "-r", "200", pdf_path, prefix],
            capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            raise RuntimeError(f"pdftoppm failed: {result.stderr.decode(errors='replace')}")
        rendered = sorted(Path(tmp).glob("page*.png"))
        if not rendered:
            raise RuntimeError("pdftoppm produced no output page")
        return ocr_image(str(rendered[0]))


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: ocr_extract.py <path>", file=sys.stderr)
        return 1
    path = sys.argv[1]
    if not Path(path).is_file():
        print(f"not a file: {path}", file=sys.stderr)
        return 1
    try:
        if path.lower().endswith(".pdf"):
            text = ocr_pdf_first_page(path)
        else:
            text = ocr_image(path)
    except Exception as exc:  # noqa: BLE001 -- any failure means "no text"
        print(f"ocr failed: {exc}", file=sys.stderr)
        return 1
    text = text.strip()
    if not text:
        return 1
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
