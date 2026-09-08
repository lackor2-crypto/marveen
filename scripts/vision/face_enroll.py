#!/usr/bin/env python3
"""Add one reference photo to the local face-recognition gallery.

Usage: face_enroll.py <photo> <personId> <gallery-dir>

Validates that the photo contains at least one detectable face (so the
gallery never fills up with unusable photos), copies it into
<gallery-dir>/<personId>/ under a fresh name, and prints the saved path.

Exits 1 (no copy made) if no face is found in the photo, or on any error.
"""
import shutil
import sys
import time
from pathlib import Path

try:
    import face_recognition
except ImportError as exc:
    print(f"missing python dependency: {exc}", file=sys.stderr)
    sys.exit(1)


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: face_enroll.py <photo> <personId> <gallery-dir>", file=sys.stderr)
        return 1
    photo_path, person_id, gallery_dir = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
    if not photo_path.is_file():
        print(f"not a file: {photo_path}", file=sys.stderr)
        return 1

    try:
        image = face_recognition.load_image_file(str(photo_path))
        faces = face_recognition.face_locations(image)
    except Exception as exc:
        print(f"could not read photo: {exc}", file=sys.stderr)
        return 1

    if not faces:
        print("no face detected in photo", file=sys.stderr)
        return 1

    person_dir = gallery_dir / person_id
    person_dir.mkdir(parents=True, exist_ok=True)
    suffix = photo_path.suffix.lower() or ".jpg"
    dest = person_dir / f"{int(time.time() * 1000)}{suffix}"
    shutil.copyfile(photo_path, dest)
    print(str(dest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
