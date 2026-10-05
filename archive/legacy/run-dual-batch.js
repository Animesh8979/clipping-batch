const { SupremeOrchestrator } = require('./src/orchestration-bus');
const path = require('path');

async function run() {
    console.log("=================================================================");
    console.log("🚀 STARTING VIRAL SHORT BATCH GENERATION (VEO + META AI) 🚀");
    console.log("=================================================================\n");

    const orchestrator = new SupremeOrchestrator();
    await orchestrator.initializeEnvironment();

    // 1. VEO 3.1 PROMPT (The Hook / Establishing Vibe)
    // Designed for high-retention: dramatic lighting, elemental effects (rain, fire), slow motion.
    const veoPrompt = "A hyper-cinematic, ultra-slow-motion shot of a glowing, fiery football resting on wet, dark stadium grass under pouring rain. Lightning flashes illuminating the dark stadium in the background. Moody, dark cinematic lighting, 8k resolution, high-contrast chiaroscuro, shot on IMAX 70mm. Centered subject for vertical cropping.";
    
    // 2. META AI PROMPT (The Action / Face / Emotion)
    // Designed for algorithmic engagement: intense eye contact, human emotion, sudden movement.
    // Extremely safe language to bypass Meta's aggressive safety filters.
    const metaPrompt = "A hyper-realistic close-up of a joyful young esports champion celebrating a massive victory. He is smiling brightly, throwing his hands up in triumph, looking directly into the camera lens with excitement. Bright neon lights, high-tech gaming studio background, viral TikTok aesthetic, photorealistic 8k.";

    try {
        console.log("\n>>> PHASE 1: GENERATING HIGH-RETENTION HOOK SCENE WITH VEO 3.1");
        // Skipping Veo since we already successfully generated and downloaded the hook in the previous run.
        const veoPath = path.join('D:\\temp_assets', 'fc9d41e2-8c3e-43a7-93b1-649ae324e0c1.mp4');
        console.log(`✅ Veo 3.1 Hook Generated (Cached): ${veoPath}`);

        console.log("\n>>> PHASE 2: GENERATING EMOTIONAL ACTION SCENE WITH META AI");
        const metaResult = await orchestrator.runOrganicGeneration(metaPrompt, 'meta_ai');
        const metaPath = path.join('D:\\temp_assets', metaResult.id + '.mp4');
        console.log(`✅ Meta AI Action Generated: ${metaPath}`);

        console.log("\n=================================================================");
        console.log("🎉 VIRAL SHORT SEQUENCE COMPLETE 🎉");
        console.log(`- Scene 1 (The Hook):   ${veoPath}`);
        console.log(`- Scene 2 (The Action): ${metaPath}`);
        console.log("=================================================================\n");
        
        process.exit(0);
    } catch (e) {
        console.error("\n❌ BATCH FAILED:", e);
        process.exit(1);
    }
}

run();
