require('dotenv').config();
const { fal } = require('@fal-ai/client');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => {});
            reject(err);
        });
    });
}

async function run() {
    console.log("🚀 INITIATING FAL.AI (LTX-VIDEO) FALLBACK 🚀");
    const prompt = "Cinematic close-up. A joyful young esports champion celebrating a massive victory. He is smiling brightly, throwing his hands up in triumph, looking directly into the camera lens with excitement. Bright neon lights, high-tech gaming studio background, photorealistic 8k.";
    
    console.log(`Prompt: ${prompt}`);
    
    try {
        const result = await fal.subscribe("fal-ai/ltx-video", {
            input: {
                prompt: prompt,
                aspect_ratio: "9:16"
            },
            logs: true,
            onQueueUpdate: (update) => {
                if (update.status === "IN_PROGRESS") {
                    update.logs.map((log) => log.message).forEach(console.log);
                }
            },
        });
        
        console.log("✅ Fal.ai Generation Complete. Extracting payload...");
        const videoUrl = result.data.video.url;
        const outPath = 'D:\\temp_assets\\action-fal.mp4';
        
        console.log(`Downloading from ${videoUrl} to ${outPath}...`);
        await downloadFile(videoUrl, outPath);
        console.log("✅ Download complete.");

        // Stitching
        const artifactsDir = 'D:\\temp_assets';
        const hookPath = path.join(artifactsDir, 'fc9d41e2-8c3e-43a7-93b1-649ae324e0c1.mp4');
        const finalPath = path.join(artifactsDir, 'final-reel.mp4');

        const listPath = path.join(artifactsDir, 'concat_list.txt');
        fs.writeFileSync(listPath, `file '${hookPath.replace(/\\/g, '/')}'\nfile '${outPath.replace(/\\/g, '/')}'\n`);

        const command = `ffmpeg -y -i "${hookPath}" -i "${outPath}" -filter_complex "[0:v]scale=-2:1920,crop=1080:1920[v0];[1:v]scale=-2:1920,crop=1080:1920[v1];[v0][v1]concat=n=2:v=1[v]" -map "[v]" -c:v libx264 -crf 23 -preset fast "${finalPath}"`;

        console.log("🎬 Stitching both videos into a single 9:16 Reel...");
        execSync(command, { stdio: 'inherit' });
        console.log(`\n✅ SUCCESSFULLY ASSEMBLED COMPLETE REEL: ${finalPath}`);

    } catch (e) {
        console.error("❌ Fallback Failed:", e);
    }
}

run();
