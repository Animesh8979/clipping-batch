#!/usr/bin/env python
"""
tools/speaker-reframe.py — active-speaker auto-reframe (16:9 -> 9:16).

Uses the ALREADY-INSTALLED opencv-python (Haar-cascade face detection) — no new
packages, no GPU, no torch. Detects the dominant face across sampled frames,
builds a smoothed horizontal-center track (EMA, OneEuro-style), and renders a
vertical 9:16 crop that follows the speaker via ffmpeg `sendcmd` keyframes.
Falls back to a centered crop when no faces are found (e.g. gameplay).

Usage:
  python tools/speaker-reframe.py <in.mp4> <out.mp4> [--sample 0.3] [--smooth 0.25]
Prints JSON: {ok, faces_found, keyframes, mode, out}
"""
import sys, os, json, subprocess, tempfile

def log(*a): print(*a, file=sys.stderr)

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "reason": "usage"})); return 2
    src, out = sys.argv[1], sys.argv[2]
    FF = os.environ.get('FFMPEG', 'ffmpeg')
    sample = 0.30
    smooth = 0.25
    for i, a in enumerate(sys.argv):
        if a == '--sample' and i + 1 < len(sys.argv): sample = float(sys.argv[i + 1])
        if a == '--smooth' and i + 1 < len(sys.argv): smooth = float(sys.argv[i + 1])
    if not os.path.exists(src):
        print(json.dumps({"ok": False, "reason": "source_missing"})); return 1
    try:
        import cv2
    except Exception as e:
        print(json.dumps({"ok": False, "reason": "no_cv2:" + str(e)[:80]})); return 1

    cap = cv2.VideoCapture(src)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "reason": "open_failed"})); return 1
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    dur = (total / fps) if fps else 0
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')

    crop_w = int(round(H * 9 / 16))           # vertical 9:16 window width
    crop_w = min(crop_w, W)
    half = crop_w / 2.0
    step_frames = max(1, int(round(sample * fps)))
    track = []                                 # (t, center_x_normalized 0..1)
    faces_found = 0
    idx = 0
    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok: break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = cascade.detectMultiScale(gray, scaleFactor=1.15, minNeighbors=5, minSize=(int(H*0.08), int(H*0.08)))
        t = idx / fps
        if len(faces):
            faces_found += 1
            # dominant face = largest area
            fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            cx = (fx + fw / 2.0) / W
            track.append((t, cx))
        idx += step_frames
        if total and idx >= total: break
    cap.release()

    if faces_found < 3:
        # no reliable face track -> centered crop (gameplay/horror handled by caller anyway)
        x_expr = f"(in_w-{crop_w})/2"
        vf = f"crop={crop_w}:{H}:{x_expr}:0,scale=1080:1920:flags=lanczos"
        r = subprocess.run(["ffmpeg", "-y", "-i", src, "-vf", vf, "-c:v", "libx264", "-preset", "fast",
                            "-crf", "20", "-c:a", "aac", "-b:a", "160k", out],
                           capture_output=True, text=True)
        ok = r.returncode == 0 and os.path.exists(out)
        print(json.dumps({"ok": ok, "faces_found": faces_found, "mode": "center_fallback", "out": out}))
        return 0 if ok else 1

    # EMA-smooth the center track, then clamp so the crop stays in-frame.
    sm = []
    prev = track[0][1]
    for (t, cx) in track:
        prev = prev + smooth * (cx - prev)
        # convert normalized center -> pixel x (top-left of crop), clamped
        cx_px = prev * W
        x = max(0.0, min(W - crop_w, cx_px - half))
        sm.append((t, x))

    # ffmpeg sendcmd keyframes to pan crop x over time (discrete, fine at ~0.3s spacing).
    fd, cmds = tempfile.mkstemp(suffix='.cmds', dir='D:/tmp' if os.path.isdir('D:/tmp') else None)
    os.close(fd)
    with open(cmds, 'w') as f:
        for (t, x) in sm:
            f.write(f"{t:.3f} crop x {x:.1f};\n")
    cmds_ff = cmds.replace('\\', '/').replace(':', '\\:')
    vf = f"sendcmd=f='{cmds_ff}',crop={crop_w}:{H}:{sm[0][1]:.1f}:0,scale=1080:1920:flags=lanczos"
    r = subprocess.run(["ffmpeg", "-y", "-i", src, "-vf", vf, "-c:v", "libx264", "-preset", "fast",
                        "-crf", "20", "-c:a", "aac", "-b:a", "160k", out],
                       capture_output=True, text=True)
    try: os.unlink(cmds)
    except Exception: pass
    ok = r.returncode == 0 and os.path.exists(out)
    print(json.dumps({"ok": ok, "faces_found": faces_found, "keyframes": len(sm), "mode": "speaker_track",
                      "src_dims": [W, H], "crop_w": crop_w, "out": out,
                      "stderr": ("" if ok else (r.stderr or "")[-400:])}))
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main())
