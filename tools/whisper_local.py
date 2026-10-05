#!/usr/bin/env python3
"""
tools/whisper_local.py — L110 T3.1
Local faster-whisper word-level transcription. CPU INT8 (no GPU).
Reads an audio path (argv[1]); prints JSON {ok, words:[{word,start,end}]} to stdout.
Model + cache go to D:\ (HF_HOME forced by the Node caller's env).
"""
import sys, json, os

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "no_audio_arg"})); return 2
    audio = sys.argv[1]
    if not os.path.exists(audio):
        print(json.dumps({"ok": False, "reason": "audio_missing"})); return 2
    model_size = os.environ.get("WHISPER_MODEL", "small.en")
    try:
        from faster_whisper import WhisperModel
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio, word_timestamps=True, beam_size=1, vad_filter=False)
        words = []
        for seg in segments:
            if seg.words:
                for w in seg.words:
                    t = (w.word or "").strip()
                    if t:
                        words.append({"word": t, "start": float(w.start), "end": float(w.end)})
        print(json.dumps({"ok": True, "model": model_size, "words": words}))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "reason": "transcribe_failed: " + str(e)[:300]}))
        return 1

if __name__ == "__main__":
    sys.exit(main())
