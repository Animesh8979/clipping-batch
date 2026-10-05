# GSD Workspace State

## Active Milestone
- **Milestone 1**: Core Pipeline Rebuild & Stability (FFmpeg + QA Gate Integration)

## Active State
- **Phase**: Execution (Phase 1-4)
- **Target OS**: Windows 11
- **VRAM limit**: 4GB VRAM (GTX 1650)
- **Clipping Engine**: FFmpeg-native split-screen + ASS caption burning (Remotion disabled for clipping)
- **QA Gate**: Supreme Council Vision reviewer (Gemini-3.5-flash ladder, threshold score: 85)

## Target Dependencies
- `ffmpeg-static` (^5.3.0)
- `ffprobe-static` (^3.1.0)
- `dotenv` (^17.4.2)
- `node-fetch` (^2.7.0)

## System Constraints & Config
- D:\ drive only for caching/rendering paths (enforced via `lib/env-d-drive-only.js`)
- $0 recurring API cost limit for clipping pipeline (excluding developer-provided LLM/Vision APIs)

## Active Tasks
- [x] Kill Remotion in clipping pipeline (daily-clip-v8.js)
- [x] Enable FFmpeg native vstack compositor (split-screen.js)
- [x] Reposition captions to center of top half (caption-builder.js, Y=480)
- [x] Restyle organic React subtitles component (BouncySubtitle.tsx)
- [x] Restore real B-roll files (gta5.mp4, minecraft.mp4, subwaysurfers.mp4) from reference
- [x] Wire Supreme Council QA check on final video (daily-clip-v8.js, >=85 pass)
- [x] Wire CLI commands in package.json
- [x] Perform end-to-end dry run and live upload verification
