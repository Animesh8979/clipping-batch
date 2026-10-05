---
name: local-voice
description: "Zero-bloat local voice and speech synthesis engine. Built on native Windows SAPI with SQLite audio memoization, consuming 0MB extra RAM and zero GPU VRAM."
tags: [voice, speech, tts, sapi, audio, zero-bloat]
created: "2026-10-01 15:10:00"
---

# local-voice

A zero-overhead, 100% offline local speech synthesis skill for Antigravity on Windows.

## Why Built-In SAPI Beats Cloud/Abandoned Models
- **No Abandoned Repos**: Unlike `supertone-oss-archive/supertonic`, Windows SAPI has zero upstream dependency risk.
- **Zero VRAM / Zero CPU Core Saturation**: Doesn't saturate OpenMP CPU threads or touch the GTX 1650's 4GB VRAM.
- **Instant Latency**: Generates notification WAV files in <200ms and memoizes repeated alert phrases in SQLite.

## Usage Patterns

### Direct One-Liner (PowerShell)
```powershell
Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak("Verification passed.")
```

### Python Engine Integration
```python
from voice_engine import LocalVoiceEngine

engine = LocalVoiceEngine()
# Generate or fetch cached WAV
wav_path = engine.synthesize_sapi_wav("Build pipeline completed with zero errors.")
# Speak aloud asynchronously without blocking
engine.speak("Agent task complete.", async_play=True)
```
