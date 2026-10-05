#!/usr/bin/env node
/**
 * tools/nemotron-clips.js
 * 
 * Uses the Nvidia Nemotron-3-Super-120B model (via the new key)
 * to analyze the match events and output the exact clips, hooks, and titles needed.
 */
'use strict';

require('../lib/env-d-drive-only');
const { geminiGenerate } = require('../lib/gemini-call');

async function main() {
    console.log("[NEMOTRON] Triggering Nvidia reasoning model...");

    const prompt = `You are an elite, brutally honest social media football editor. 
I have a highlights video of the Mexico vs South Africa 2026 World Cup match.
The following chaotic events actually happened in the match:
- Quiñones scored first (9')
- Sithole red card (around 49'-50')
- Jiménez header/goal (67')
- Zwane red card after VAR review (84')
- Montes red card in stoppage time (90')

I need you to "find out the clips I need". Based purely on these 5 events, tell me:
1. Which of these moments should be standalone YouTube Shorts / TikToks?
2. Give me the perfect viral Title, the 3-second Hook text (what appears on screen immediately), and the narrative reason why it works.
3. Should they be stitched into one mega-compilation or split into 3 distinct videos? Give me your brutal, objective strategic opinion.

CRITICAL INSTRUCTION: Return strictly raw JSON. Do not wrap in markdown \`\`\`json or add any conversational text. Use this schema:
[
  {
    "type": "standalone" | "compilation",
    "momentsIncluded": ["..."],
    "title": "...",
    "hookTextOnScreen": "...",
    "narrativeReason": "..."
  }
]
`;

    // Force failure on Gemini to trigger the Nvidia fallback, or just call Nvidia directly if we wrote a wrapper.
    // Wait, let's just make the fetch call directly here to guarantee we use Nemotron and the exact params the user requested.
    const fetch = require('node-fetch');
    const key = process.env.NVIDIA_API_KEY;

    const body = {
        model: "nvidia/nemotron-3-super-120b-a12b",
        messages: [{"role":"user","content":prompt}],
        temperature: 1,
        top_p: 0.95,
        max_tokens: 16384,
        chat_template_kwargs: { enable_thinking: true },
        reasoning_budget: 16384
    };

    const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });

    if (!r.ok) {
        const text = await r.text();
        console.error("Nvidia API Error:", r.status, text);
        process.exit(1);
    }

    const j = await r.json();
    
    const reasoning = j.choices[0].message.reasoning_content;
    const content = j.choices[0].message.content;

    console.log("========== NEMOTRON REASONING ==========\n");
    console.log(reasoning);
    console.log("\n========== NEMOTRON OUTPUT ==========\n");
    console.log(content);
    
    const fs = require('fs');
    const path = require('path');
    fs.writeFileSync(path.join(__dirname, '..', 'renders', 'nemotron-clips-strategy.json'), content);
    console.log("\nSaved strategy to renders/nemotron-clips-strategy.json");
}

main().catch(console.error);
