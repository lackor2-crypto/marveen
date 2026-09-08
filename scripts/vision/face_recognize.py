#!/usr/bin/env python3
"""Local face recognition for the Marveen Beerkezo inbox classifier.

Usage: face_recognize.py <path-to-photo> <gallery-dir>

The gallery directory holds one subfolder per person, named by the
person's life-tree id, containing reference photos of that person:

    <gallery-dir>/<personId>/*.jpg

Prints a JSON array of matches to stdout: [{"personId": "...", "confidence": 0.0-1.0}, ...]
(empty array "[]" if no known face matched, or the gallery is empty/missing).
Exits 0 whenever it could run the comparison, even if no faces were found --
"no match" is a normal result, not a failure. Exits 1 only on a hard error
(missing dependency, unreadable input photo).

Encodings are recomputed from the gallery on every call -- for a personal
family photo archive (a handful of people, a few reference photos each)
this is fast enough that a cache would be premature.
"""
import json
import sys
from pathlib import Path

try:
    import face_recognition
except ImportError as exc:
    print(f"missing python dependency: {exc}", file=sys.stderr)
    sys.exit(1)

MATCH_TOLERANCE = 0.6  # face_recognition default; lower = stricter


def load_gallery(gallery_dir: Path):
    known_encodings = []
    known_person_ids = []
    if not gallery_dir.is_dir():
        return known_encodings, known_person_ids
    for person_dir in sorted(gallery_dir.iterdir()):
        if not person_dir.is_dir():
            continue
        person_id = person_dir.name
        for photo in sorted(person_dir.glob("*")):
            if photo.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            try:
                image = face_recognition.load_image_file(str(photo))
                encodings = face_recognition.face_encodings(image)
            except Exception:
                continue
            for enc in encodings:
                known_encodings.append(enc)
                known_person_ids.append(person_id)
    return known_encodings, known_person_ids


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: face_recognize.py <photo> <gallery-dir>", file=sys.stderr)
        return 1
    photo_path, gallery_dir = sys.argv[1], Path(sys.argv[2])
    if not Path(photo_path).is_file():
        print(f"not a file: {photo_path}", file=sys.stderr)
        return 1

    known_encodings, known_person_ids = load_gallery(gallery_dir)
    if not known_encodings:
        print("[]")
        return 0

    try:
        unknown_image = face_recognition.load_image_file(photo_path)
        unknown_encodings = face_recognition.face_encodings(unknown_image)
    except Exception as exc:
        print(f"could not read photo: {exc}", file=sys.stderr)
        return 1

    if not unknown_encodings:
        print("[]")
        return 0

    best_per_person = {}
    for unknown_enc in unknown_encodings:
        distances = face_recognition.face_distance(known_encodings, unknown_enc)
        for person_id, distance in zip(known_person_ids, distances):
            if distance > MATCH_TOLERANCE:
                continue
            confidence = round(1.0 - float(distance), 4)
            if confidence > best_per_person.get(person_id, 0.0):
                best_per_person[person_id] = confidence

    matches = [{"personId": pid, "confidence": conf} for pid, conf in best_per_person.items()]
    matches.sort(key=lambda m: m["confidence"], reverse=True)
    print(json.dumps(matches))
    return 0


if __name__ == "__main__":
    sys.exit(main())
