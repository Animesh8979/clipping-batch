require('./lib/env-d-drive-only');
const path = require('path');
const fs = require('fs');
const { geminiGenerate } = require('./lib/gemini-call');
const { GoogleAIFileManager } = require("@google/generative-ai/server");

async function main() {
    const videoPath = "D:\\anitgravity work\\.runtime-cache\\fifa-sources\\FIFAWorldCup-Mexico20SouthAfricaHighlights.mp4";
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("No API key");
        return;
    }
    const fileManager = new GoogleAIFileManager(apiKey);
    
    console.log("Uploading video...");
    const uploadResult = await fileManager.uploadFile(
        videoPath,
        {
            mimeType: "video/mp4",
            displayName: "MexicoHighlights",
        }
    );
    
    const uri = uploadResult.file.uri;
    const name = uploadResult.file.name;
    
    console.log(`Uploaded as ${uri}`);
    
    let fileState = await fileManager.getFile(name);
    while (fileState.state === "PROCESSING") {
        console.log("Processing...");
        await new Promise(r => setTimeout(r, 4000));
        fileState = await fileManager.getFile(name);
    }
    
    if (fileState.state === "FAILED") {
        console.log("Failed to process video");
        return;
    }
    
    const prompt = `You are a sports video editor. I have a highlights video. Please watch it and map the following match events to exact start and end timestamps (in seconds) in the video file. Return ONLY a JSON array of objects with { "moment": "name", "startSec": number, "dur": number }

Moments:
- Quiñones scored first (9')
- Sithole red card (around 49'-50')
- Jiménez header/goal (67')
- Zwane red card after VAR review (84')
- Montes red card in stoppage time`;

    console.log("Sending to Gemini...");
    const result = await geminiGenerate({
        parts: [
            { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uri } },
            { text: prompt }
        ],
        json: true,
        temperature: 0.1
    });
    
    console.log(result.text);
}

main().catch(console.error);
