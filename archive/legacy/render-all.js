/**
 * render-all.js — Universal Video Factory: Automation Loop
 *
 * Reads pipeline-data.json (from engine.js), then renders
 * each item via Remotion CLI, saving to /output/.
 *
 * Usage: node render-all.js
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ─── Config ───────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, "pipeline-data.json");
const OUTPUT_DIR = path.join(__dirname, "output");
const ENTRY_POINT = "src/index.jsx";
const COMPOSITION_ID = "UniversalShort";

// ─── Helpers ──────────────────────────────────────────────
function sanitize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function getTimestamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
}

// ─── Main ─────────────────────────────────────────────────
function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  🎬 Universal Video Factory — Renderer");
  console.log("═══════════════════════════════════════════\n");

  // 1. Read pipeline data
  if (!fs.existsSync(DATA_FILE)) {
    console.error("❌ pipeline-data.json not found. Run engine.js first.");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  const { topic, items } = data;

  if (!items || items.length === 0) {
    console.error("❌ No items found in pipeline-data.json.");
    process.exit(1);
  }

  // 2. Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const timestamp = getTimestamp();
  const topicSlug = sanitize(topic);
  const results = [];

  // 3. Render each item
  for (const item of items) {
    const outputFile = `${topicSlug}_${timestamp}_${item.index}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputFile);

    // Build input props JSON
    const props = {
      hook: item.hook,
      value: item.value,
      cta: item.cta,
      videoUrl: item.videoUrl || null,
    };

    const propsJson = JSON.stringify(JSON.stringify(props));

    console.log(`\n🎞️  Rendering video ${item.index}/3: "${item.hook}" ...`);
    console.log(`   Output: ${outputPath}`);
    console.log(`   Video:  ${item.videoUrl ? "✅ Pexels URL" : "🎨 Gradient fallback"}`);

    const cmd = `npx remotion render ${ENTRY_POINT} ${COMPOSITION_ID} --output "${outputPath}" --props ${propsJson}`;

    try {
      execSync(cmd, {
        cwd: __dirname,
        stdio: "inherit",
        env: { ...process.env, Path: process.env.Path || process.env.PATH },
      });

      const stats = fs.statSync(outputPath);
      const sizeKB = (stats.size / 1024).toFixed(1);
      console.log(`   ✅ Done! (${sizeKB} KB)`);
      results.push({ file: outputFile, size: sizeKB, status: "success" });
    } catch (err) {
      console.error(`   ❌ Render failed for #${item.index}: ${err.message}`);

      // Retry without video URL (gradient fallback)
      if (item.videoUrl) {
        console.log("   🔄 Retrying with gradient fallback ...");
        const fallbackProps = { ...props, videoUrl: null };
        const fallbackJson = JSON.stringify(JSON.stringify(fallbackProps));
        const fallbackCmd = `npx remotion render ${ENTRY_POINT} ${COMPOSITION_ID} --output "${outputPath}" --props ${fallbackJson}`;

        try {
          execSync(fallbackCmd, {
            cwd: __dirname,
            stdio: "inherit",
            env: { ...process.env, Path: process.env.Path || process.env.PATH },
          });
          const stats = fs.statSync(outputPath);
          const sizeKB = (stats.size / 1024).toFixed(1);
          console.log(`   ✅ Fallback render done! (${sizeKB} KB)`);
          results.push({ file: outputFile, size: sizeKB, status: "fallback" });
        } catch (e2) {
          console.error(`   💥 Fallback also failed: ${e2.message}`);
          results.push({ file: outputFile, size: 0, status: "failed" });
        }
      } else {
        results.push({ file: outputFile, size: 0, status: "failed" });
      }
    }
  }

  // 4. Summary
  console.log("\n═══════════════════════════════════════════");
  console.log("  📊 Render Summary");
  console.log("═══════════════════════════════════════════");
  results.forEach((r) => {
    const icon = r.status === "success" ? "✅" : r.status === "fallback" ? "🎨" : "❌";
    console.log(`  ${icon}  ${r.file}  (${r.size} KB)`);
  });
  console.log("═══════════════════════════════════════════\n");
}

main();
