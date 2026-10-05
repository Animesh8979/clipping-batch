---
name: ffmpeg-skill
description: "Native local FFmpeg audio/video processing skill. Enforces zero-dependency execution via D:\\tools\\ffmpeg\\bin\\ffmpeg.exe with GTX 1650 VRAM safety."
tags: [video, audio, media, ffmpeg, nvenc, local]
created: "2026-10-01 15:10:00"
---

# ffmpeg-skill

A production-grade, zero-dependency local media processing skill for Antigravity.

Unlike npm wrappers that fail when `ffmpeg` is not in the system PATH, this skill targets the verified local binary at `D:\tools\ffmpeg\bin\ffmpeg.exe` and `ffprobe.exe`.

## Key Capabilities
1. **Lossless Video Cutting & Joining**: Keyframe-snapped `-c copy` operations with zero transcode delay.
2. **GTX 1650 VRAM Safety**:
   - **Default (CPU)**: Uses `libx264 -preset veryfast` for short clips (<30s encode time <0.5s), leaving 100% of the GTX 1650's 4GB VRAM free for local LLMs, AST analyzers, and agents.
   - **Guarded NVENC**: Uses `-c:v h264_nvenc -preset p4` (Volta TU117 safe preset; prevents invalid Turing B-frame flags and session allocation crashes).
3. **EBU R128 Loudness Normalization**: Automated two-pass `loudnorm` filter to broadcast -14 LUFS standards.
4. **Zero-Dependency Python Wrapper**: `D:\skills-library\ffmpeg-skill\ffmpeg_engine.py`.

## Quick Command Patterns

### 1. Lossless Cut
```powershell
& "D:\tools\ffmpeg\bin\ffmpeg.exe" -y -ss 00:00:05 -i input.mp4 -t 10 -c copy -avoid_negative_ts make_zero output.mp4
```

### 2. Fast CPU Transcode (VRAM-Safe)
```powershell
& "D:\tools\ffmpeg\bin\ffmpeg.exe" -y -i input.mp4 -c:v libx264 -preset veryfast -crf 22 -c:a aac -b:a 128k output.mp4
```

### 3. Hardware NVENC Transcode (GTX 1650 Safe)
```powershell
& "D:\tools\ffmpeg\bin\ffmpeg.exe" -y -i input.mp4 -c:v h264_nvenc -preset p4 -cq 23 -c:a aac -b:a 160k output.mp4
```

### 4. Audio Loudness Normalization (-14 LUFS)
```powershell
& "D:\tools\ffmpeg\bin\ffmpeg.exe" -y -i input.mp4 -c:v copy -filter:a "loudnorm=I=-14:TP=-1.5:LRA=11" output.mp4
```
