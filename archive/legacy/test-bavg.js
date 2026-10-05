const { SupremeOrchestrator } = require('./src/orchestration-bus.js');

async function run() {
    const orchestrator = new SupremeOrchestrator();
    await orchestrator.initializeEnvironment();

    const narrative = "A dramatic, high-speed cinematic shot of a football being struck powerfully, deforming as it flies through the air, and crashing into the stadium net under massive, blinding stadium floodlights. FIFA world cup atmosphere.";
    
    console.log("\n=============================================");
    console.log("🚀 INITIATING ORGANIC BAVG EXECUTION 🚀");
    console.log("=============================================\n");
    console.log("NARRATIVE:", narrative);

    try {
        const finalAsset = await orchestrator.runOrganicGeneration(narrative);
        console.log("\n✅ SUCCESS: Final Organic Asset Downloaded to:", finalAsset);
    } catch (error) {
        console.error("\n❌ FAILED TO GENERATE ORGANIC ASSET:");
        console.error(error.message);
    }
}

run();
