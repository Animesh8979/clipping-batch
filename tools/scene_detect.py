#!/usr/bin/env python3
"""tools/scene_detect.py — L110 T4. PySceneDetect visual cut detection.
argv[1]=video. Prints JSON {ok, cuts:[seconds,...]} — start time of each shot.
CPU/opencv-headless. Used to seed cleaner clip candidate windows."""
import sys, json
def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "no_arg"})); return 2
    try:
        from scenedetect import detect, ContentDetector
        scenes = detect(sys.argv[1], ContentDetector(threshold=27.0), show_progress=False)
        cuts = [round(s[0].get_seconds(), 2) for s in scenes]
        print(json.dumps({"ok": True, "cuts": cuts}))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "reason": str(e)[:300]})); return 1
if __name__ == "__main__":
    sys.exit(main())
