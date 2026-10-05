#!/usr/bin/env node
/**
 * tools/clip-hunter.js
 * 
 * Executes the 9-Phase "WORLD CUP CLIP HUNTER MODE" against a video source
 * using Gemini 1.5 Pro Vision.
 */
'use strict';

require('../lib/env-d-drive-only');
const path = require('path');
const fs = require('fs');
const { geminiGenerate } = require('../lib/gemini-call');
const { GoogleAIFileManager } = require("@google/generative-ai/server");

async function main() {
    const videoPath = path.join(__dirname, '..', '.runtime-cache', 'fifa-sources', 'FIFAWorldCup-Mexico20SouthAfricaHighlights.mp4');
    const outPath = process.argv[2] || path.join(__dirname, '..', 'renders', 'clip_hunter_report.md');
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("✗ No API key found in env");
        process.exit(1);
    }

    if (!fs.existsSync(videoPath)) {
        console.error(`✗ Video not found at ${videoPath}`);
        process.exit(1);
    }

    const fileManager = new GoogleAIFileManager(apiKey);
    
    console.log(`[CLIP HUNTER] Uploading video to Gemini File Manager: ${path.basename(videoPath)}`);
    const uploadResult = await fileManager.uploadFile(
        videoPath,
        {
            mimeType: "video/mp4",
            displayName: "WorldCupMatchSource",
        }
    );
    
    const uri = uploadResult.file.uri;
    const name = uploadResult.file.name;
    
    console.log(`[CLIP HUNTER] Uploaded as ${uri}. Waiting for processing...`);
    
    let fileState = await fileManager.getFile(name);
    while (fileState.state === "PROCESSING") {
        await new Promise(r => setTimeout(r, 4000));
        fileState = await fileManager.getFile(name);
    }
    
    if (fileState.state === "FAILED") {
        console.error("✗ Failed to process video in Gemini File Manager.");
        process.exit(1);
    }
    
    console.log(`[CLIP HUNTER] Video ready. Executing 9-Phase analysis...`);

    const prompt = `WORLD CUP CLIP HUNTER MODE

MISSION
You are not a highlight editor.
You are a football narrative analyst.
Your job is to watch an entire match and identify the moments most likely to generate:
* retention
* comments
* shares
* replays
* subscriptions
Do NOT prioritize goals.
Do NOT prioritize highlight packages.
Prioritize moments that create stories.

══════════════════════════════════════
INPUT
Match: Mexico vs South Africa
Competition: FIFA World Cup Highlights
Video Source: EXTENDED HIGHLIGHTS
══════════════════════════════════════
PHASE 1: FULL MATCH SCAN
Watch the entire match. Build a complete event timeline. For every significant event record: Match Minute, Broadcast Timestamp, Player, Team, Event Type.
══════════════════════════════════════
PHASE 2: MOMENT DISCOVERY
Find every moment belonging to: GOALS, DISALLOWED GOALS, VAR REVIEWS, PENALTIES, MISSED PENALTIES, RED CARDS, CONTROVERSIAL REFEREE DECISIONS, GOALKEEPER ERRORS, GOALKEEPER HEROICS, MISSED OPEN GOALS, PLAYER MELTDOWNS, MANAGER REACTIONS, BENCH REACTIONS, CROWD ERUPTIONS, CROWD SILENCE, PLAYER ARGUMENTS, TACTICAL COLLAPSES, LATE WINNERS, LAST-MINUTE DRAMA, EMOTIONAL REACTIONS.
══════════════════════════════════════
PHASE 3: VIRALITY SCORING
For every candidate moment score (0-10): Shock Value, Comment Potential, Replay Potential, Football Relevance, Emotional Impact. Total Score (0-50). Rank all moments.
══════════════════════════════════════
PHASE 4: COMMENT MAGNET TEST
Predict what football fans will argue about. If a moment does NOT generate an argument: Lower score.
══════════════════════════════════════
PHASE 5: STORY EXTRACTION
Do NOT create highlight clips. Create stories. Example: Bad: "South Korea Goal", Good: "The Goal Czechia Never Recovered From".
══════════════════════════════════════
PHASE 6: TOP CLIPS
Return TOP 20 CLIPS. Provide: Rank, Broadcast Timestamp Start, Broadcast Timestamp End, Match Minute, Title, Story, Why It Works, Expected Comment Rate, Expected Retention, Expected Replay Rate.
══════════════════════════════════════
PHASE 7: SHORTS OPTIMIZATION
For every clip provide a Hook (3 seconds maximum).
══════════════════════════════════════
PHASE 8: CHANNEL STRATEGY
Categorize every clip (Breaking News, Controversy, Star Player, Tactical Disaster, Emotion, Historical Moment).
══════════════════════════════════════
PHASE 9: FINAL OUTPUT
Return formatted entirely in highly readable Markdown:
1. Full event timeline
2. Top 20 moments
3. Top 10 viral clips
4. Top 5 guaranteed uploads
5. Best thumbnail angle
6. Best title angle
7. Best hook angle
8. Predicted view potential

IMPORTANT: Think like a football fan. Find the moments people will argue about tomorrow. Those are the moments worth clipping. Return ONLY the markdown output.`;

    try {
        const result = await geminiGenerate({
            parts: [
                { fileData: { mimeType: uploadResult.file.mimeType, fileUri: uri } },
                { text: prompt }
            ],
            json: false,
            temperature: 0.3
        });
        
        if (!result.ok) {
            console.error("✗ Gemini Generation Failed:", result.reason);
            process.exit(1);
        }
        
        fs.writeFileSync(outPath, result.text);
        console.log(`\n[CLIP HUNTER] SUCCESS! Narrative analysis written to: ${outPath}`);
    } catch (err) {
        console.error("✗ Gemini Generation Failed:", err);
        process.exit(1);
    }
}

main().catch(console.error);
