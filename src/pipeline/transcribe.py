#!/usr/bin/env python3
"""
src/pipeline/transcribe.py — faster-whisper CPU INT8 with Silero VAD
Outputs: JSON transcript with word-level timestamps { ok, words: [{word, start, end}] }
"""
import sys
import os
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "reason": "Missing audio path"}))
        return 1

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(json.dumps({"ok": False, "reason": "Audio file not found"}))
        return 1

    model_size = os.environ.get("WHISPER_MODEL", "small.en")

    try:
        from faster_whisper import WhisperModel
        # CPU INT8 execution — zero GPU VRAM consumption
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        
        # vad_filter=True activates built-in Silero VAD
        segments, info = model.transcribe(
            audio_path,
            word_timestamps=True,
            beam_size=1,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )

        words = []
        full_text_segments = []

        for seg in segments:
            full_text_segments.append(seg.text.strip())
            if seg.words:
                for w in seg.words:
                    word_clean = (w.word or "").strip()
                    if word_clean:
                        words.append({
                            "word": word_clean,
                            "start": round(float(w.start), 3),
                            "end": round(float(w.end), 3)
                        })

        print(json.dumps({
            "ok": True,
            "language": info.language,
            "duration": round(info.duration, 2),
            "full_text": " ".join(full_text_segments),
            "words": words
        }))
        return 0

    except Exception as e:
        print(json.dumps({"ok": False, "reason": f"Whisper error: {str(e)}"}))
        return 1

if __name__ == "__main__":
    sys.exit(main())
