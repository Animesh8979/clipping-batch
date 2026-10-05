const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const artifactsDir = 'D:\\temp_assets';
const hookPath = path.join(artifactsDir, 'fc9d41e2-8c3e-43a7-93b1-649ae324e0c1.mp4'); // Veo
const actionPath = path.join(artifactsDir, 'remotion-fallback.mp4'); // Remotion Fallback
const outPath = path.join(artifactsDir, 'final-reel.mp4');

// We use FFmpeg to crop/scale both to 1080x1920 (9:16) and concat them sequentially.
// This time we also concat the Audio stream (a=1) so the Remotion audio is preserved!
// Because Veo audio and Remotion audio might have different sample rates, we resample to 48kHz.
const command = `ffmpeg -y -i "${hookPath}" -i "${actionPath}" -filter_complex "[0:v]scale=w=1080:h=1920:force_original_aspect_ratio=increase,crop=1080:1920[v0];[0:a]aformat=sample_rates=48000:channel_layouts=stereo[a0];[1:v]scale=w=1080:h=1920:force_original_aspect_ratio=increase,crop=1080:1920[v1];[1:a]aformat=sample_rates=48000:channel_layouts=stereo[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]" -map "[v]" -map "[a]" -c:v libx264 -crf 23 -preset fast -c:a aac "${outPath}"`;

console.log("Stitching both videos (Veo Hook -> Remotion Fallback) into a single 9:16 Reel WITH Audio...");
try {
    execSync(command, { stdio: 'inherit' });
    console.log(`\n✅ Successfully created final reel: ${outPath}`);
} catch (e) {
    console.error("❌ FFmpeg Failed:", e.message);
    process.exit(1);
}
