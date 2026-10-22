#!/usr/bin/env python3
"""Background removal for one video clip (#669 phase C).

Runs on the owner's machine only (rembg + onnxruntime in the voice toolkit venv, the small
u2netp model): nothing is uploaded. Every frame of the chosen stretch gets a person/subject
mask, and the background behind the subject is replaced by a flat colour or by a blurred copy
of the original. The sound of the stretch is kept.

  cutout.py --in IN.mp4 --out OUT.mp4 --ss 0 --t 10 --mode color --color 00b140

Progress goes to stderr as "progress=0.37" lines (the dashboard reads them). Exit 0 = OUT.mp4 is complete.
"""
import argparse
import json
import os
import subprocess
import sys

MAX_SECONDS = 60.0


def probe(path):
    out = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate',
         '-of', 'json', path], capture_output=True, text=True, check=True).stdout
    s = json.loads(out)['streams'][0]
    num, den = s['r_frame_rate'].split('/')
    fps = float(num) / float(den or 1) if float(den or 1) else 25.0
    return int(s['width']), int(s['height']), max(1.0, min(60.0, fps))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--ss', type=float, default=0.0)
    ap.add_argument('--t', type=float, required=True)
    ap.add_argument('--mode', choices=['color', 'blur'], default='color')
    ap.add_argument('--color', default='00b140')
    ap.add_argument('--model', default='u2netp')
    ap.add_argument('--models', default='', help='folder that holds the model files (U2NET_HOME)')
    a = ap.parse_args()
    if not (0 < a.t <= MAX_SECONDS):
        print('too long: at most %d seconds at a time' % MAX_SECONDS, file=sys.stderr)
        return 2

    if a.models:
        os.environ['U2NET_HOME'] = a.models
    import numpy as np
    from PIL import Image, ImageFilter
    from rembg import new_session, remove

    w, h, fps = probe(a.src)
    w -= w % 2
    h -= h % 2
    session = new_session(a.model, providers=['CPUExecutionProvider'])
    total = max(1, int(a.t * fps))
    fsize = w * h * 3
    stride = 2 if fps >= 20 else 1
    rgb = tuple(int(a.color[i:i + 2], 16) for i in (0, 2, 4))
    flat = np.zeros((h, w, 3), dtype=np.uint8)
    flat[:, :] = rgb

    dec = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-ss', str(a.ss), '-t', str(a.t), '-i', a.src, '-vf', 'scale=%d:%d,fps=%s' % (w, h, fps),
         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    enc = subprocess.Popen(
        ['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (w, h), '-r', str(fps), '-i', '-',
         '-ss', str(a.ss), '-t', str(a.t), '-i', a.src, '-map', '0:v', '-map', '1:a:0?',
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k',
         '-shortest', '-movflags', '+faststart', a.out], stdin=subprocess.PIPE)

    prev = None
    n = 0
    try:
        while True:
            raw = dec.stdout.read(fsize)
            if len(raw) < fsize:
                break
            frame = np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
            img = Image.fromarray(frame)
            if prev is None or n % stride == 0:
                mask = remove(img, session=session, only_mask=True)
                m = np.asarray(mask.resize((w, h), Image.BILINEAR), dtype=np.float32) / 255.0
                # A little temporal smoothing keeps the edge from flickering between frames.
                if prev is not None:
                    m = 0.6 * m + 0.4 * prev
                prev = m
            else:
                # Half the frames reuse the last mask: the mask is the slow part, and at 20+ fps the subject barely moves between two frames.
                m = prev
            if a.mode == 'blur':
                small = img.resize((max(2, w // 8), max(2, h // 8)), Image.BILINEAR).filter(ImageFilter.GaussianBlur(3))
                back = np.asarray(small.resize((w, h), Image.BILINEAR), dtype=np.uint8)
            else:
                back = flat
            m3 = m[:, :, None]
            out = (frame * m3 + back * (1.0 - m3)).astype(np.uint8)
            enc.stdin.write(out.tobytes())
            n += 1
            print('progress=%.4f' % min(0.99, n / total), file=sys.stderr, flush=True)
    finally:
        try:
            dec.stdout.close()
        except Exception:
            pass
        dec.wait()
        try:
            enc.stdin.close()
        except Exception:
            pass
        rc = enc.wait()
    if n == 0:
        print('no frames could be read from the clip', file=sys.stderr)
        return 3
    return 0 if rc == 0 else rc


if __name__ == '__main__':
    sys.exit(main())
