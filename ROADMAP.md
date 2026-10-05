# Project Roadmap — Clipping Batch

This roadmap defines the iterative milestone path for the automated short-form viral video clipping pipeline.

## Milestone 1: Lightweight Core Render & QA Gate (Current)
- [x] Refactor rendering pipeline from heavy Remotion-Chromium to FFmpeg-native compositing (80MB RAM vs 600MB RAM)
- [x] Reposition captions to center of A-roll top half (Y=480)
- [x] Re-integrate real B-roll gameplay files (GTA5, Subway Surfers, Minecraft)
- [x] Wire Supreme Council Vision QA reviewer (pass threshold >= 85)
- [x] Map GSD npm scripts in `package.json`

## Milestone 2: Intelligent Content Sourcing & Slicing
- [ ] Implement semantic audio slice peak detection (improve Whisper timing alignment)
- [ ] Sourcing pipeline from YouTube URL lists (`npm run hunt`)
- [ ] Automate face-crop tracking adjustments for varying content aspect ratios

## Milestone 3: Auto-Upload & Publishing Queue
- [ ] Wire the Instagram Reels publishing flow via `lib/ig-uploader.js`
- [ ] Wire the YouTube Shorts publishing flow via `lib/yt-uploader.js`
- [ ] Implement queue management (`npm run upload`) with randomized schedule jitter (+/- 25 minutes)

## Milestone 4: Analytics Feedback Loop
- [ ] Harvest views and comments from published shorts
- [ ] Adjust Moment Selector weighting prompts based on performance data (dopamine feedback loop)
