/**
 * entity-photo-resolver.js — NER → Wikimedia Commons PERSON photo resolver
 *
 * Extracts named PEOPLE from news scripts and fetches real, CC-licensed
 * portrait photos from Wikimedia Commons. Only resolves real people —
 * no skylines, maps, logos, or generic org images.
 * Returns null on any failure — existing stock chain takes over.
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WIKIMEDIA_API = 'https://commons.wikimedia.org/w/api.php';
const CACHE_DIR = path.join(__dirname, 'public', 'v12-cache');
const ENTITY_TIMEOUT_MS = 10000;
const MIN_IMAGE_WIDTH = 400;

// Common false positive names to skip
const FALSE_POSITIVES = new Set([
  'the first', 'the second', 'the third', 'the next', 'the real',
  'that is', 'this is', 'right now', 'last year', 'next year',
  'new york', 'los angeles', 'san francisco', 'united states',
  'follow for', 'scene focus', 'visual context', 'item one',
]);

// Known world leaders, tech figures, Indian politicians, and important figures — priority matches
const KNOWN_FIGURES = [
  // US & Americas
  'Donald Trump', 'Joe Biden', 'Kamala Harris', 'JD Vance', 'Ron DeSantis',
  'Marco Rubio', 'Mike Johnson', 'Nancy Pelosi', 'Pete Buttigieg',
  // Russia & Eastern Europe
  'Vladimir Putin', 'Volodymyr Zelensky', 'Alexander Lukashenko',
  // China & Asia Pacific
  'Xi Jinping', 'Kim Jong Un', 'Fumio Kishida', 'Shigeru Ishiba',
  'Yoon Suk Yeol', 'Lai Ching-te',
  // Middle East
  'Benjamin Netanyahu', 'Ali Khamenei', 'Masoud Pezeshkian',
  'Mohammad Javad Zarif', 'Bashar Assad', 'Mohammed bin Salman',
  'Ebrahim Raisi', 'Ismail Haniyeh',
  // South Asia
  'Narendra Modi', 'Rahul Gandhi', 'Amit Shah', 'Yogi Adityanath',
  'Arvind Kejriwal', 'Mamata Banerjee', 'Shehbaz Sharif', 'Imran Khan',
  'Bilawal Bhutto', 'Sheikh Hasina',
  // Europe
  'Emmanuel Macron', 'Olaf Scholz', 'Keir Starmer', 'Rishi Sunak',
  'Ursula von der Leyen', 'Giorgia Meloni', 'Recep Erdogan',
  // Tech & Business
  'Elon Musk', 'Sam Altman', 'Mark Zuckerberg', 'Sundar Pichai',
  'Satya Nadella', 'Tim Cook', 'Jensen Huang', 'Dario Amodei',
  'Demis Hassabis', 'Jeff Bezos', 'Larry Page', 'Sergey Brin',
  'Jack Dorsey', 'Bill Gates', 'Mukesh Ambani', 'Gautam Adani',
  // International orgs
  'Antonio Guterres', 'Tedros Adhanom', 'Christine Lagarde',
  // Military & Intelligence
  'Lloyd Austin', 'Mark Milley', 'Valery Gerasimov',
];

function extractPeople(scriptText) {
  const text = String(scriptText || '');
  const people = [];
  const seen = new Set();

  // First pass: check for known figures explicitly
  for (const figure of KNOWN_FIGURES) {
    if (text.includes(figure) && !seen.has(figure.toLowerCase())) {
      seen.add(figure.toLowerCase());
      people.push({ name: figure, type: 'person', searchQuery: `${figure} portrait photo` });
    }
  }

  // Second pass: regex for capitalized 2-3 word names
  const nameRegex = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2})\b/g;
  let match;
  while ((match = nameRegex.exec(text)) !== null) {
    const name = match[1].trim();
    if (seen.has(name.toLowerCase())) continue;
    if (FALSE_POSITIVES.has(name.toLowerCase())) continue;
    if (name.split(' ').length < 2) continue;

    // Filter out sentences that start with common words
    const firstWord = name.split(' ')[0].toLowerCase();
    if (['the', 'this', 'that', 'after', 'before', 'when', 'where', 'what', 'which', 'here', 'there', 'item', 'scene', 'follow', 'breaking', 'just', 'today'].includes(firstWord)) continue;

    seen.add(name.toLowerCase());
    people.push({ name, type: 'person', searchQuery: `${name} portrait photo` });
  }

  // Third pass: check for single last names of known figures mentioned in the text
  for (const figure of KNOWN_FIGURES) {
    const lastName = figure.split(' ').pop();
    if (lastName.length >= 4 && !seen.has(figure.toLowerCase())) {
      const lastNameRegex = new RegExp(`\\b${lastName}\\b`, 'i');
      if (lastNameRegex.test(text)) {
        seen.add(figure.toLowerCase());
        people.push({ name: figure, type: 'person', searchQuery: `${figure} portrait photo` });
      }
    }
  }

  return people;
}

async function searchWikimediaPortrait(query) {
  const url = new URL(WIKIMEDIA_API);
  url.searchParams.set('action', 'query');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', query);
  url.searchParams.set('gsrnamespace', '6');
  url.searchParams.set('gsrlimit', '8');
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|size|extmetadata');
  url.searchParams.set('iiurlwidth', '1080');
  url.searchParams.set('format', 'json');

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': 'RagnarShortsAi/1.0 (automated-pipeline)' },
    signal: AbortSignal.timeout(ENTITY_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const data = await response.json();
  if (!data.query || !data.query.pages) return null;

  const pages = Object.values(data.query.pages)
    .filter(page => {
      const info = page.imageinfo && page.imageinfo[0];
      if (!info) return false;
      if (info.width < MIN_IMAGE_WIDTH) return false;
      const imgUrl = info.thumburl || info.url || '';
      if (!/\.(jpg|jpeg|png)$/i.test(imgUrl)) return false;
      if (/\.svg/i.test(info.url || '')) return false;
      // Prefer portrait-shaped images (height > width) or close to square
      return true;
    })
    .sort((a, b) => {
      const aInfo = a.imageinfo[0];
      const bInfo = b.imageinfo[0];
      // Prefer portrait aspect ratio
      const aRatio = aInfo.height / Math.max(1, aInfo.width);
      const bRatio = bInfo.height / Math.max(1, bInfo.width);
      const aPortrait = aRatio > 0.8 && aRatio < 2.5 ? 1 : 0;
      const bPortrait = bRatio > 0.8 && bRatio < 2.5 ? 1 : 0;
      if (bPortrait !== aPortrait) return bPortrait - aPortrait;
      return (bInfo.width * bInfo.height) - (aInfo.width * aInfo.height);
    });

  if (pages.length === 0) return null;

  const best = pages[0].imageinfo[0];
  return best.thumburl || best.url;
}

async function downloadAndCache(imageUrl, entityName) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const hash = crypto.createHash('sha1').update(entityName).digest('hex').slice(0, 10);
  const ext = imageUrl.match(/\.(jpg|jpeg|png)/i)?.[0] || '.jpg';
  const fileName = `wiki-entity-${hash}${ext}`;
  const filePath = path.join(CACHE_DIR, fileName);

  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 5000) {
    return `v12-cache/${fileName}`;
  }

  const response = await fetch(imageUrl, {
    signal: AbortSignal.timeout(ENTITY_TIMEOUT_MS),
    headers: { 'User-Agent': 'RagnarShortsAi/1.0' },
  });

  if (!response.ok) return null;

  const buffer = await response.buffer();
  if (buffer.length < 5000) return null;

  fs.writeFileSync(filePath, buffer);
  return `v12-cache/${fileName}`;
}

/**
 * Resolve PERSON photos for news scenes.
 * Only fetches portraits of important people mentioned in the script.
 * @param {string} scriptText — Full script text
 * @param {Array} scenes — Scene array from payload
 * @returns {Promise<Map<number, {src: string, entity: string, tier: string}>>}
 */
async function resolveEntityPhotos(scriptText, scenes) {
  const results = new Map();

  try {
    const people = extractPeople(scriptText);
    if (people.length === 0) return results;

    console.log(`   🔎 Entity resolver: found ${people.length} people: ${people.map(e => e.name).join(', ')}`);

    for (let i = 0; i < Math.min(people.length, scenes.length); i++) {
      try {
        const person = people[i];
        const imageUrl = await searchWikimediaPortrait(person.searchQuery);
        if (!imageUrl) continue;

        const cachedSrc = await downloadAndCache(imageUrl, person.name);
        if (!cachedSrc) continue;

        // Assign person's image to the scene that mentions them — check ALL scenes, not just first N
        let targetScene = -1;
        for (let si = 0; si < scenes.length; si++) {
          const sceneSentence = String(scenes[si].sentence || scenes[si].sentenceEnglish || '');
          const portraitTerm = String(scenes[si].portraitSearchTerm || '');
          if (sceneSentence.includes(person.name) || portraitTerm.toLowerCase().includes(person.name.toLowerCase())) {
            targetScene = si;
            break;
          }
          // Also check last-name-only match
          const lastName = person.name.split(' ').pop();
          if (lastName.length >= 4 && (sceneSentence.includes(lastName) || portraitTerm.toLowerCase().includes(lastName.toLowerCase()))) {
            targetScene = si;
            break;
          }
        }
        const sceneIdx = targetScene >= 0 ? targetScene : i;

        if (!results.has(sceneIdx)) {
          results.set(sceneIdx, {
            src: cachedSrc,
            entity: person.name,
            tier: 'Tier 0.5 (Wikimedia Person Portrait)',
          });
          console.log(`   🔎 Person "${person.name}" → scene ${sceneIdx + 1}`);
        }
      } catch (err) {
        // Silent skip — stock chain handles it
      }
    }
  } catch (err) {
    console.log(`   🔎 Entity resolver skipped: ${String(err.message).slice(0, 80)}`);
  }

  return results;
}

module.exports = { resolveEntityPhotos, extractPeople };
