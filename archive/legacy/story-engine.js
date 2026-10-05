require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { buildStoryValuePromiseCta } = require('./growth-cta');
const { loadRecentPerformanceEntries, normalizeStorySeriesTitle } = require('./content-dedupe');
const { repairMojibakeText } = require('./text-repair');

const STATE_FILE = path.join(__dirname, 'story-state.json');
const STORY_TIMEOUT_MS = 60000;
const GEMINI_RATE_LIMIT_RETRY_MS = Math.max(3000, parseInt(process.env.GEMINI_RATE_LIMIT_RETRY_MS || '12000', 10) || 12000);
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

const STORY_ARCS = [
  {
    type: 'action_blockbuster',
    intro: 'high-octane action movie with explosions, car chases, and a hero against the world',
    subjects: [
      'Aakhri Mission - The Final Mission',
      'City Under Siege - Shehar Khatre Mein',
      'One Man Army - Akela Rakshak',
    ],
    placeHi: ['à¤šà¤²à¤¤à¥€ à¤Ÿà¥à¤°à¥‡à¤¨ à¤•à¥€ à¤›à¤¤', 'à¤§à¤§à¤•à¤¤à¤¾ à¤¹à¥à¤† à¤—à¥‹à¤¦à¤¾à¤®', 'à¤…à¤‚à¤¡à¤°à¤—à¥à¤°à¤¾à¤‰à¤‚à¤¡ à¤¬à¤‚à¤•à¤°'],
    placeEn: ['roof of a moving train', 'burning warehouse', 'underground bunker'],
    objectHi: ['à¤Ÿà¤¾à¤‡à¤® à¤¬à¤®', 'à¤šà¥‹à¤°à¥€ à¤¹à¥à¤ˆ à¤¹à¤¾à¤°à¥à¤¡ à¤¡à¥à¤°à¤¾à¤‡à¤µ', 'à¤¸à¥à¤¨à¤¾à¤‡à¤ªà¤° à¤°à¤¾à¤‡à¤«à¤²'],
    objectEn: ['time bomb', 'stolen hard drive', 'sniper rifle'],
    threatHi: ['à¤—à¥ˆà¤‚à¤—à¤¸à¥à¤Ÿà¤° à¤•à¤¾ à¤¬à¥‰à¤¸', 'à¤­à¥à¤°à¤·à¥à¤Ÿ à¤ªà¥à¤²à¤¿à¤¸ à¤‘à¤«à¤¿à¤¸à¤°', 'à¤¹à¥‡à¤²à¥€à¤•à¥‰à¤ªà¥à¤Ÿà¤° à¤¸à¥‡ à¤¹à¤®à¤²à¤¾'],
    threatEn: ['gangster boss', 'corrupt police officer', 'helicopter attack'],
    sensoryAnchors: ['à¤¬à¤¾à¤°à¥‚à¤¦ à¤•à¥€ à¤—à¤‚à¤§', 'à¤—à¥‹à¤²à¤¿à¤¯à¥‹à¤‚ à¤•à¥€ à¤¤à¤¡à¤¼à¤¤à¤¡à¤¼à¤¾à¤¹à¤Ÿ', 'à¤¹à¥‡à¤²à¥€à¤•à¥‰à¤ªà¥à¤Ÿà¤° à¤•à¤¾ à¤¶à¥‹à¤°'],
    sensoryAnchorsEn: ['smell of gunpowder', 'rat-a-tat of bullets', 'chopper roaring noise'],
  },
  {
    type: 'romantic_drama',
    intro: 'bollywood style romantic drama, intense emotions, rain, and heartbreak',
    subjects: [
      'Ek Adhuri Kahani - An Unfinished Tale',
      'Baarish Ki Boondein - Raindrops of Love',
      'Aakhri Mulakat - The Last Meeting',
    ],
    placeHi: ['à¤¬à¤¾à¤°à¤¿à¤¶ à¤¸à¥‡ à¤­à¥€à¤—à¤¾ à¤°à¥‡à¤²à¤µà¥‡ à¤¸à¥à¤Ÿà¥‡à¤¶à¤¨', 'à¤•à¥‰à¤²à¥‡à¤œ à¤•à¥€ à¤ªà¥à¤°à¤¾à¤¨à¥€ à¤•à¥ˆà¤‚à¤Ÿà¥€à¤¨', 'à¤¸à¤°à¥à¤¦à¤¿à¤¯à¥‹à¤‚ à¤•à¥€ à¤°à¤¾à¤¤ à¤•à¤¾ à¤•à¥ˆà¤«à¥‡'],
    placeEn: ['rain-soaked railway station', 'old college canteen', 'winter night cafe'],
    objectHi: ['à¤ªà¥à¤°à¤¾à¤¨à¤¾ à¤–à¤¤', 'à¤Ÿà¥‚à¤Ÿà¤¾ à¤¹à¥à¤† à¤—à¤¿à¤Ÿà¤¾à¤°', 'à¤²à¤¾à¤² à¤›à¤¾à¤¤à¤¾'],
    objectEn: ['old letter', 'broken guitar', 'red umbrella'],
    threatHi: ['à¤ªà¤°à¤¿à¤µà¤¾à¤° à¤•à¤¾ à¤µà¤¿à¤°à¥‹à¤§', 'à¤—à¤²à¤¤à¤«à¤¹à¤®à¥€', 'à¤›à¥‚à¤Ÿà¤¤à¥€ à¤¹à¥à¤ˆ à¤Ÿà¥à¤°à¥‡à¤¨'],
    threatEn: ['family opposition', 'misunderstanding', 'departing train'],
    sensoryAnchors: ['à¤—à¥€à¤²à¥€ à¤®à¤¿à¤Ÿà¥à¤Ÿà¥€ à¤•à¥€ à¤®à¤¹à¤•', 'à¤—à¤¿à¤Ÿà¤¾à¤° à¤•à¥€ à¤§à¥à¤¨', 'à¤†à¤à¤¸à¥à¤“à¤‚ à¤•à¥€ à¤—à¤°à¥à¤®à¤¾à¤¹à¤Ÿ'],
    sensoryAnchorsEn: ['smell of petrichor', 'strumming of guitar', 'warmth of tears'],
  },
  {
    type: 'epic_historical',
    intro: 'cinematic historical epic like Baahubali, massive battles, kings, and betrayal',
    subjects: [
      'Simhasan Ka Khel - Game of the Throne',
      'Yoddha Ka Dharam - The Warrior Creed',
      'Dharati Ki Pukaar - Call of the Motherland',
    ],
    placeHi: ['à¤°à¤£à¤­à¥‚à¤®à¤¿', 'à¤°à¤¾à¤œà¤¾ à¤•à¤¾ à¤¦à¤°à¤¬à¤¾à¤°', 'à¤•à¤¿à¤²à¥‡ à¤•à¥€ à¤ªà¥à¤°à¤¾à¤šà¥€à¤°'],
    placeEn: ['battlefield', 'king court', 'fort ramparts'],
    objectHi: ['à¤–à¥‚à¤¨ à¤¸à¥‡ à¤¸à¤¨à¥€ à¤¤à¤²à¤µà¤¾à¤°', 'à¤°à¤¾à¤œà¤®à¥à¤•à¥à¤Ÿ', 'à¤ªà¥à¤°à¤¾à¤¨à¤¾ à¤¨à¤•à¥à¤¶à¤¾'],
    objectEn: ['blood-stained sword', 'royal crown', 'ancient map'],
    threatHi: ['à¤µà¤¿à¤¦à¥à¤°à¥‹à¤¹à¥€ à¤¸à¥‡à¤¨à¤¾à¤ªà¤¤à¤¿', 'à¤ªà¤¡à¤¼à¥‹à¤¸à¥€ à¤°à¤¾à¤œà¤¾', 'à¤®à¤¹à¤² à¤•à¤¾ à¤·à¤¡à¥à¤¯à¤‚à¤¤à¥à¤°'],
    threatEn: ['rebel commander', 'neighboring king', 'palace conspiracy'],
    sensoryAnchors: ['à¤¤à¤²à¤µà¤¾à¤°à¥‹à¤‚ à¤•à¥‡ à¤Ÿà¤•à¤°à¤¾à¤¨à¥‡ à¤•à¥€ à¤†à¤µà¤¾à¤œà¤¼', 'à¤¯à¥à¤¦à¥à¤§ à¤•à¥‡ à¤¨à¤—à¤¾à¤¡à¤¼à¥‡', 'à¤¹à¤¾à¤¥à¤¿à¤¯à¥‹à¤‚ à¤•à¥€ à¤šà¤¿à¤‚à¤˜à¤¾à¤¡à¤¼'],
    sensoryAnchorsEn: ['clashing of swords', 'war drums beating', 'elephants trumpeting'],
  },
  {
    type: 'heist_thriller',
    intro: 'slick heist movie with a brilliant plan, a ticking clock, and a twist',
    subjects: [
      'Bank Of The Century - 100 Crore Ki Chori',
      'The Perfect Heist - Ek Paripurna Chori',
      'Aakhri Daaw - The Final Gamble',
    ],
    placeHi: ['à¤¬à¥ˆà¤‚à¤• à¤•à¤¾ à¤¤à¤¿à¤œà¥‹à¤°à¥€ à¤•à¤®à¤°à¤¾', 'à¤¹à¤¾à¤ˆ-à¤¸à¤¿à¤•à¥à¤¯à¥‹à¤°à¤¿à¤Ÿà¥€ à¤²à¥‡à¤œà¤° à¤—à¥à¤°à¤¿à¤¡', 'à¤•à¤¸à¥€à¤¨à¥‹ à¤•à¤¾ à¤µà¥€à¤†à¤ˆà¤ªà¥€ à¤°à¥‚à¤®'],
    placeEn: ['bank vault room', 'high-security laser grid', 'casino VIP room'],
    objectHi: ['à¤¹à¥€à¤°à¥‡ à¤•à¤¾ à¤¹à¤¾à¤°', 'à¤¹à¥ˆà¤•à¤¿à¤‚à¤— à¤¡à¤¿à¤µà¤¾à¤‡à¤¸', 'à¤¬à¥à¤²à¥‚à¤ªà¥à¤°à¤¿à¤‚à¤Ÿ'],
    objectEn: ['diamond necklace', 'hacking device', 'blueprint'],
    threatHi: ['à¤¸à¥à¤°à¤•à¥à¤·à¤¾ à¤—à¤¾à¤°à¥à¤¡', 'à¤¬à¤œà¤¤à¤¾ à¤¹à¥à¤† à¤…à¤²à¤¾à¤°à¥à¤®', 'à¤ªà¥à¤²à¤¿à¤¸ à¤•à¥€ à¤˜à¥‡à¤°à¤¾à¤¬à¤‚à¤¦à¥€'],
    threatEn: ['security guard', 'ringing alarm', 'police barricade'],
    sensoryAnchors: ['à¤…à¤²à¤¾à¤°à¥à¤® à¤•à¥€ à¤šà¥à¤­à¤¤à¥€ à¤†à¤µà¤¾à¤œà¤¼', 'à¤²à¥‡à¤œà¤° à¤²à¤¾à¤‡à¤Ÿ à¤•à¥€ à¤—à¤°à¥à¤®à¥€', 'à¤²à¥‰à¤•à¤° à¤–à¥à¤²à¤¨à¥‡ à¤•à¥€ à¤•à¥à¤²à¤¿à¤•'],
    sensoryAnchorsEn: ['piercing alarm sound', 'heat of laser lights', 'click of locker opening'],
  },
  {
    type: 'underdog_sports',
    intro: 'inspirational sports movie, training montage, the final match',
    subjects: [
      'Aakhri Shot - The Final Shot',
      'Maidaan-e-Jung - The Battlefield',
      'Houslon Ki Udaan - Flight of Courage',
    ],
    placeHi: ['à¤§à¥‚à¤² à¤­à¤°à¤¾ à¤•à¥à¤°à¤¿à¤•à¥‡à¤Ÿ à¤®à¥ˆà¤¦à¤¾à¤¨', 'à¤¬à¥‰à¤•à¥à¤¸à¤¿à¤‚à¤— à¤°à¤¿à¤‚à¤—', 'à¤«à¤¾à¤‡à¤¨à¤² à¤®à¥ˆà¤š à¤•à¤¾ à¤¸à¥à¤Ÿà¥‡à¤¡à¤¿à¤¯à¤®'],
    placeEn: ['dusty cricket ground', 'boxing ring', 'final match stadium'],
    objectHi: ['à¤Ÿà¥‚à¤Ÿà¤¾ à¤¹à¥à¤† à¤¬à¥ˆà¤Ÿ', 'à¤ªà¤¸à¥€à¤¨à¥‡ à¤¸à¥‡ à¤­à¥€à¤—à¤¾ à¤¤à¥Œà¤²à¤¿à¤¯à¤¾', 'à¤—à¥‹à¤²à¥à¤¡ à¤®à¥‡à¤¡à¤²'],
    objectEn: ['broken bat', 'sweaty towel', 'gold medal'],
    threatHi: ['à¤˜à¤®à¤‚à¤¡à¥€ à¤šà¥ˆà¤‚à¤ªà¤¿à¤¯à¤¨', 'à¤ªà¥à¤°à¤¾à¤¨à¥€ à¤šà¥‹à¤Ÿ', 'à¤®à¥ˆà¤š à¤¹à¤¾à¤°à¤¨à¥‡ à¤•à¤¾ à¤¡à¤°'],
    threatEn: ['arrogant champion', 'old injury', 'fear of losing'],
    sensoryAnchors: ['à¤¦à¤°à¥à¤¶à¤•à¥‹à¤‚ à¤•à¤¾ à¤¶à¥‹à¤°', 'à¤®à¤¿à¤Ÿà¥à¤Ÿà¥€ à¤•à¥€ à¤§à¥‚à¤²', 'à¤¦à¤¿à¤² à¤•à¥€ à¤§à¤¡à¤¼à¤•à¤¨'],
    sensoryAnchorsEn: ['roaring of the crowd', 'dust of the ground', 'heartbeat thumping'],
  },
  // L99: NEW ARCS — Diverse genres for wider audience reach
  {
    type: 'comedy_chaos',
    intro: 'hilarious Bollywood-style comedy with misunderstandings, over-the-top characters, and a twist ending that makes you laugh out loud',
    subjects: [
      'Shaadi Ka Hungama - Wedding Chaos',
      'Galti Se Mistake - Accidental Trouble',
      'Jugaad King - The Master of Hacks',
    ],
    placeHi: ['\u0936\u093E\u0926\u0940 \u0915\u093E \u092E\u0902\u0921\u092A', '\u0930\u0947\u0932\u0935\u0947 \u0915\u093E \u091C\u0928\u0930\u0932 \u0921\u093F\u092C\u094D\u092C\u093E', '\u0915\u0949\u0932\u0947\u091C \u0915\u0948\u0902\u091F\u0940\u0928'],
    placeEn: ['wedding mandap', 'crowded railway platform', 'college canteen'],
    objectHi: ['\u0917\u0932\u0924 \u0928\u0902\u092C\u0930 \u0915\u093E \u092B\u094B\u0928', '\u0909\u0932\u091D\u093E \u0939\u0941\u0906 \u0938\u0942\u091F\u0915\u0947\u0938', '\u091C\u0941\u0917\u093E\u0921\u093C \u0915\u093E \u0930\u093F\u092E\u094B\u091F'],
    objectEn: ['wrong number phone call', 'mixed-up suitcase', 'jugaad remote control'],
    threatHi: ['\u0917\u0941\u0938\u094D\u0938\u0947\u092C\u093E\u091C\u093C \u0938\u093E\u0938', '\u0926\u094B \u0932\u0921\u093C\u0915\u093F\u092F\u094B\u0902 \u0938\u0947 \u092A\u094D\u092F\u093E\u0930', '\u092A\u0941\u0932\u093F\u0938 \u0907\u0902\u0938\u094D\u092A\u0947\u0915\u094D\u091F\u0930'],
    threatEn: ['angry father-in-law', 'dating two people at once', 'police inspector'],
    sensoryAnchors: ['\u0922\u094B\u0932 \u0915\u0940 \u0925\u093E\u092A', '\u0939\u0901\u0938\u0940 \u0915\u0940 \u0917\u0942\u0902\u091C', '\u0936\u094B\u0930\u0917\u0941\u0932'],
    sensoryAnchorsEn: ['dhol beating loudly', 'echo of laughter', 'chaos and shouting'],
  },
  {
    type: 'supernatural_mystery',
    intro: 'spine-tingling supernatural mystery with an ancient secret, a haunted location, and a shocking revelation',
    subjects: [
      'Haveli Ka Raaz - The Mansion Secret',
      'Aatma Ki Pukar - The Spirit Call',
      'Bhooli Bisri Kahani - The Forgotten Tale',
    ],
    placeHi: ['\u092A\u0941\u0930\u093E\u0928\u0940 \u0939\u0935\u0947\u0932\u0940', '\u091C\u0902\u0917\u0932 \u0915\u093E \u092E\u0902\u0926\u093F\u0930', '\u0935\u0940\u0930\u093E\u0928 \u0915\u093F\u0932\u093E'],
    placeEn: ['ancient haveli mansion', 'jungle temple', 'abandoned fort'],
    objectHi: ['\u092A\u0941\u0930\u093E\u0928\u093E \u0932\u0949\u0915\u0947\u091F', '\u091C\u0932\u0924\u0940 \u092E\u094B\u092E\u092C\u0924\u094D\u0924\u0940', '\u0930\u0939\u0938\u094D\u092F\u092E\u092F \u0928\u0915\u094D\u0936\u093E'],
    objectEn: ['ancient locket', 'burning candle', 'mysterious map'],
    threatHi: ['\u0905\u0926\u0943\u0936\u094D\u092F \u0936\u0915\u094D\u0924\u093F', '\u0936\u094D\u0930\u093E\u092A \u0915\u0940 \u0906\u0935\u093E\u091C\u093C', '\u0930\u0939\u0938\u094D\u092F\u092E\u092F \u092A\u0930\u091B\u093E\u0908'],
    threatEn: ['invisible force', 'curse voice', 'mysterious shadow'],
    sensoryAnchors: ['\u0920\u0902\u0921\u0940 \u0939\u0935\u093E \u0915\u093E \u091D\u094B\u0902\u0915\u093E', '\u092E\u094B\u092E\u092C\u0924\u094D\u0924\u0940 \u0915\u0940 \u091F\u093F\u092E\u091F\u093F\u092E\u093E\u0924\u0940 \u0930\u094B\u0936\u0928\u0940', '\u0926\u0930\u0935\u093E\u091C\u093C\u0947 \u0915\u0940 \u091A\u0930\u092E\u0930\u093E\u0939\u091F'],
    sensoryAnchorsEn: ['gust of cold wind', 'flickering candlelight', 'creaking of doors'],
  },
  {
    type: 'family_drama',
    intro: 'emotional Bollywood family drama with relationships, sacrifice, tears, and a redemption arc that hits the heart',
    subjects: [
      'Maa Ki Duaa - A Mother Prayer',
      'Rishtey Ka Bandhan - Bonds of Blood',
      'Ghar Wapsi - The Homecoming',
    ],
    placeHi: ['\u0917\u093E\u0901\u0935 \u0915\u093E \u092A\u0941\u0930\u093E\u0928\u093E \u0918\u0930', '\u0936\u0939\u0930 \u0915\u0940 \u091B\u094B\u091F\u0940 \u091D\u094B\u092A\u0921\u093C\u0940', '\u0905\u0938\u094D\u092A\u0924\u093E\u0932 \u0915\u093E \u0917\u0932\u093F\u092F\u093E\u0930\u093E'],
    placeEn: ['village ancestral home', 'city apartment', 'hospital corridor'],
    objectHi: ['\u092E\u093E\u0901 \u0915\u093E \u092A\u0941\u0930\u093E\u0928\u093E \u0916\u0924', '\u091F\u0942\u091F\u093E \u0939\u0941\u0906 \u092B\u094B\u091F\u094B', '\u0926\u093E\u0926\u0940 \u0915\u0940 \u0905\u0902\u0917\u0942\u0920\u0940'],
    objectEn: ['old letter from mother', 'torn family photo', 'grandfather ring'],
    threatHi: ['\u092A\u0941\u0930\u093E\u0928\u0940 \u0926\u0941\u0936\u094D\u092E\u0928\u0940', '\u092A\u0930\u093F\u0935\u093E\u0930 \u0915\u093E \u091F\u0942\u091F\u0928\u093E', '\u092C\u0940\u092E\u093E\u0930\u0940'],
    threatEn: ['old rivalry', 'family splitting apart', 'terminal illness'],
    sensoryAnchors: ['\u0906\u0901\u0938\u0941\u0913\u0902 \u0915\u0940 \u0917\u0930\u094D\u092E\u093E\u0939\u091F', '\u091A\u0942\u0932\u094D\u0939\u0947 \u0915\u093E \u0927\u0941\u0906\u0901', '\u092E\u093F\u091F\u094D\u091F\u0940 \u0915\u0940 \u0916\u0941\u0936\u092C\u0942'],
    sensoryAnchorsEn: ['warmth of tears', 'smoke of the hearth', 'scent of fresh soil'],
  },
];

const HEROES = ['à¤¦à¥‡à¤µ', 'à¤†à¤°à¤µ', 'à¤¨à¤¯à¤¨', 'à¤°à¤¾à¤˜à¤µ', 'à¤‡à¤°à¤¾', 'à¤•à¤¾à¤µà¥à¤¯à¤¾', 'à¤µà¤¿à¤µà¤¾à¤¨'];
const ALLIES = ['à¤®à¥€à¤°à¤¾', 'à¤°à¤¿à¤¯à¤¾', 'à¤¤à¤¾à¤°à¤¾', 'à¤¸à¤¿à¤¯à¤¾', 'à¤¨à¥ˆà¤¨à¤¾', 'à¤°à¤¿à¤¦à¥à¤§à¤¿'];

const NAME_ROMANIZATION = {
  'à¤¦à¥‡à¤µ': 'Dev',
  'à¤†à¤°à¤µ': 'Aarav',
  'à¤¨à¤¯à¤¨': 'Nayan',
  'à¤°à¤¾à¤˜à¤µ': 'Raghav',
  'à¤‡à¤°à¤¾': 'Ira',
  'à¤•à¤¾à¤µà¥à¤¯à¤¾': 'Kavya',
  'à¤µà¤¿à¤µà¤¾à¤¨': 'Vivan',
  'à¤®à¥€à¤°à¤¾': 'Meera',
  'à¤°à¤¿à¤¯à¤¾': 'Riya',
  'à¤¤à¤¾à¤°à¤¾': 'Tara',
  'à¤¸à¤¿à¤¯à¤¾': 'Siya',
  'à¤¨à¥ˆà¤¨à¤¾': 'Naina',
  'à¤°à¤¿à¤¦à¥à¤§à¤¿': 'Riddhi',
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

function uniqueNonEmpty(values) {
  const seen = new Set();
  return values.filter((value) => {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function countWords(text) { return String(text || '').trim().split(/\s+/).filter(Boolean).length; }

function normalizeEnglishNarration(text) {
  return repairText(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSceneLeadSignature(text) {
  return normalizeEnglishNarration(text).split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
}

function includesNarrativePattern(text, pattern) {
  return pattern.test(normalizeEnglishNarration(text));
}

function looksMojibake(text) {
  return /ÃƒÆ’|Ãƒâ€š|ÃƒÂ¢Ã¢â€šÂ¬|Ãƒ Ã‚Â¤|Ãƒ Ã‚Â¥|Ã Â¤|Ã¢â‚¬"|Ã¢â‚¬|Ã°Å¸/u.test(String(text || ''));
}

function repairText(text) {
  return repairMojibakeText(text);
}

function sanitizeHindiStoryText(text) {
  return repairText(text)
    .replace(/\bPart\s*([123])\b/gi, 'à¤­à¤¾à¤— $1')
    .replace(/\bfollow\b/gi, 'à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹')
    .replace(/\bbewildered\b/gi, 'à¤¹à¥ˆà¤°à¤¾à¤¨')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim();
}

function containsLatinLeak(text) {
  return /\b[A-Za-z]{3,}\b/.test(String(text || ''));
}

function repairValue(value) {
  if (typeof value === 'string') return repairText(value);
  if (Array.isArray(value)) return value.map(repairValue);
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, nested] of Object.entries(value)) next[key] = repairValue(nested);
    return next;
  }
  return value;
}

function romanizeStoryNames(text) {
  let output = repairText(text);
  for (const [hindi, english] of Object.entries(NAME_ROMANIZATION)) {
    output = output.replace(new RegExp(hindi, 'g'), english);
  }
  return output;
}

function normalizeScene(scene, index) {
  const isV13 = process.env.ENABLE_V13_HACKS === 'true';
  const hi = sanitizeHindiStoryText(scene && (scene.sentenceHindi || scene.sentence || ''));
  const en = romanizeStoryNames(scene && (scene.sentenceEnglish || scene.sentence || ''));
  
  let literalSearch = String(scene && scene.literalSearchTerm ? scene.literalSearchTerm : 'cinematic fiction scene').trim();
  let fallbackVibe = String(scene && scene.fallbackVibeTerm ? scene.fallbackVibeTerm : 'dark cinematic suspense').trim();
  
  if (isV13) {
    const cinematicTags = ', 8k resolution, Unreal Engine 5 render, low angle shot, volumetric fog, dramatic cinematic moonlight, extremely detailed, terrifying atmosphere, color grading by Roger Deakins';
    literalSearch += cinematicTags;
    fallbackVibe += cinematicTags;
  }

  return {
    sentenceHindi: hi.trim(),
    sentenceEnglish: en.trim(),
    sentence: en.trim(),
    durationWeight: Number(scene && scene.durationWeight) > 0 ? Number(scene.durationWeight) : 1.1,
    literalSearchTerm: literalSearch,
    fallbackVibeTerm: fallbackVibe,
    portraitSearchTerm: String(scene && scene.portraitSearchTerm ? scene.portraitSearchTerm : 'dramatic portrait').trim(),
    index,
  };
}

function trimSentenceToWords(text, maxWords, terminalPunctuation) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const words = raw.split(/\s+/).filter(Boolean);
  if (!words.length) {
    return '';
  }
  if (words.length <= maxWords) {
    return raw;
  }

  const clauses = raw
    .replace(/[\u2014-]/g, ',')
    .split(/\s*,\s*|\s*[;:.!?à¥¤]\s*/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  let bestClauseFit = '';
  let prefix = '';
  for (const clause of clauses) {
    const nextPrefix = prefix ? `${prefix} ${clause}` : clause;
    if (countWords(nextPrefix) > maxWords) {
      break;
    }
    prefix = nextPrefix;
    if (countWords(prefix) >= Math.max(6, maxWords - 6)) {
      bestClauseFit = prefix;
    }
  }
  if (bestClauseFit) {
    return `${bestClauseFit.replace(/[,:;.!?à¥¤]+$/g, '').trim()}${terminalPunctuation}`.trim();
  }

  const trimmed = words.slice(0, Math.max(1, maxWords)).join(' ').replace(/[,:;.!?à¥¤]+$/g, '').trim();
  return `${trimmed}${terminalPunctuation}`.trim();
}

function normalizePowerHookText(value) {
  const words = String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  if (words.length < 2) {
    return null;
  }
  return words.join(' ').toUpperCase();
}

function normalizeVisualCueList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return uniqueNonEmpty(
    values
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 12)
  );
}

function normalizePatternInterrupts(values, maxSeconds = 48) {
  if (!Array.isArray(values) || values.length === 0) {
    const defaults = [];
    for (let second = 3; second < maxSeconds; second += 3) {
      const stamp = `00:${String(second).padStart(2, '0')}`;
      defaults.push(
        second % 6 === 0
          ? `${stamp} - b-roll flash reset`
          : `${stamp} - 1.2x zoom snap`
      );
    }
    return defaults;
  }

  return uniqueNonEmpty(
    values
      .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 18)
  );
}

function compactStoryPart(part) {
  if (!part || !Array.isArray(part.scenes) || part.scenes.length === 0) {
    return part;
  }

  const currentWordCount = countWords(part.scriptTextHindi || part.scriptText || '');
  if (currentWordCount <= 64) {
    return part;
  }

  const compactedScenes = part.scenes.map((scene, index) => {
    const isFinalScene = index === part.scenes.length - 1;
    const hasDialogue = /"/.test(String(scene && scene.sentenceHindi ? scene.sentenceHindi : ''));
    const hindiMaxWords = isFinalScene ? 11 : hasDialogue ? 10 : 9;
    const englishMaxWords = isFinalScene ? 11 : hasDialogue ? 10 : 9;
    return normalizeScene({
      ...scene,
      sentenceHindi: trimSentenceToWords(scene.sentenceHindi, hindiMaxWords, 'à¥¤'),
      sentenceEnglish: trimSentenceToWords(scene.sentenceEnglish || scene.sentence, englishMaxWords, '.'),
    }, index);
  });

  const scriptTextHindi = compactedScenes.map((scene) => scene.sentenceHindi).join(' ').trim();
  const scriptTextEnglish = compactedScenes.map((scene) => scene.sentenceEnglish).join(' ').trim();

  return {
    ...part,
    scenes: compactedScenes,
    scriptText: scriptTextHindi,
    scriptTextHindi,
    scriptTextEnglish,
  };
}

function isValidStoryPart(part, options = {}) {
  return getStoryPartValidationIssues(part, options).length === 0;
}

function getStoryPartValidationIssues(part, options = {}) {
  const hindi = sanitizeHindiStoryText(part && (part.scriptTextHindi || part.scriptText || ''));
  const english = repairText(part && part.scriptTextEnglish || '');
  const scenes = Array.isArray(part && part.scenes) ? part.scenes : [];
  const dialogueCount = (hindi.match(/"/g) || []).length / 2;
  const minHindiWords = options.relaxed ? 35 : 45;
  const minEnglishWords = options.relaxed ? 30 : 40;
  const minScenes = options.relaxed ? 5 : 6;
  const minDialogue = options.relaxed ? 1 : 1;
  const issues = [];
  if (!/[\u0900-\u097F]/.test(hindi)) issues.push('missing Devanagari Hindi text');
  if (looksMojibake(hindi)) issues.push('Hindi text contains mojibake');
  if (containsLatinLeak(hindi)) issues.push('Hindi text still contains Latin words');
  if (countWords(hindi) < minHindiWords) issues.push(`Hindi word count ${countWords(hindi)} below minimum ${minHindiWords}`);
  if (countWords(hindi) > 85) issues.push(`Hindi word count ${countWords(hindi)} above maximum 85`);
  if (countWords(english) < minEnglishWords) issues.push(`English word count ${countWords(english)} below minimum ${minEnglishWords}`);
  if (scenes.length < minScenes) issues.push(`scene count ${scenes.length} below minimum ${minScenes}`);
  if (dialogueCount < 0) issues.push(`dialogue count ${dialogueCount} below minimum ${minDialogue}`);
  if (!scenes.every((scene) => {
    const hi = sanitizeHindiStoryText(scene.sentenceHindi || '');
    return hi.trim() && !containsLatinLeak(hi) && repairText(scene.sentenceEnglish || '').trim();
  })) {
    issues.push('one or more scenes are missing clean Hindi or English text');
  }
  return issues;
}

function scoreStoryQuality(part) {
  let score = 0;
  const hi = sanitizeHindiStoryText(part.scriptTextHindi || '');
  const en = String(part.scriptTextEnglish || '');
  const scenes = Array.isArray(part.scenes) ? part.scenes : [];
  const partNumber = Number(part.storyPart || part.partNumber || 0);
  const sceneEnglish = scenes.map((scene) => repairText(scene && scene.sentenceEnglish ? scene.sentenceEnglish : ''));
  const firstEnglish = sceneEnglish[0] || '';
  const midpointEnglish = sceneEnglish.slice(2, 4).join(' ');
  const lastEnglish = sceneEnglish[sceneEnglish.length - 1] || '';
  // Dialogue presence (quotes or reported speech)
  const dialogueMarkers = (hi.match(/["""]/g) || []).length;
  if (dialogueMarkers >= 4) score += 3;
  else if (dialogueMarkers >= 2) score += 1;
  // Unique search terms
  const searchTerms = new Set(scenes.map(s => s.literalSearchTerm || ''));
  if (searchTerms.size >= scenes.length - 1) score += 2;
  else if (searchTerms.size >= scenes.length / 2) score += 1;
  // Sensory language (Hindi)
  const sensoryWords = ['à¤†à¤µà¤¾à¤œà¤¼', 'à¤—à¤‚à¤§', 'à¤ à¤‚à¤¡', 'à¤—à¤°à¥à¤®à¥€', 'à¤•à¤¾à¤‚à¤ª', 'à¤§à¤¡à¤¼à¤•', 'à¤¸à¤¾à¤‚à¤¸', 'à¤šà¥€à¤–', 'à¤–à¥‚à¤¨', 'à¤ªà¤¸à¥€à¤¨', 'à¤¦à¤°à¥à¤¦'];
  const sensoryCount = sensoryWords.filter(w => hi.includes(w)).length;
  if (sensoryCount >= 3) score += 3;
  else if (sensoryCount >= 1) score += 1;
  const intensityWords = ['à¤–à¥‚à¤¨', 'à¤šà¥€à¤–', 'à¤¶à¤¾à¤ª', 'à¤¦à¤°à¤µà¤¾à¤œà¤¼à¤¾', 'à¤ªà¤°à¤›à¤¾à¤ˆ', 'à¤†à¤ˆà¤¨à¤¾', 'à¤¥à¤°à¤¥à¤°', 'à¤§à¤¡à¤¼à¤•à¤¨', 'à¤…à¤šà¤¾à¤¨à¤•', 'à¤«à¥à¤¸à¤«à¥à¤¸à¤¾à¤¹à¤Ÿ'];
  const intensityCount = intensityWords.filter((word) => hi.includes(word)).length;
  if (intensityCount >= 4) score += 3;
  else if (intensityCount >= 2) score += 1;
  // Word count in range
  const wc = countWords(hi);
  if (wc >= 44 && wc <= 60) score += 2;
  else if (wc >= 40 && wc <= 64) score += 1;
  // English subtitle quality
  if (countWords(en) >= 45) score += 1;
  const shortSceneCount = scenes.filter((scene) => countWords(scene.sentenceHindi || '') <= 18).length;
  if (shortSceneCount >= Math.max(5, scenes.length - 1)) score += 2;
  if (
    countWords(firstEnglish) >= 6 &&
    countWords(firstEnglish) <= 18 &&
    includesNarrativePattern(firstEnglish, /\b(found|heard|saw|opened|turned|whispered|screamed|blood|vanished|locked|glowed|shook|appeared)\b/)
  ) {
    score += 3;
  } else if (countWords(firstEnglish) <= 22) {
    score += 1;
  }
  if (includesNarrativePattern(midpointEnglish, /\b(but|then|until|instead|suddenly|realized|revealed|except|when)\b/)) {
    score += 2;
  }
  if (partNumber > 0 && partNumber < STORY_PART_COUNT) {
    if (
      includesNarrativePattern(lastEnglish, /\b(part\s*[23]|next part|reveal|decision|truth|survive|choice)\b/) &&
      includesNarrativePattern(lastEnglish, /\b(blood|door|wall|mark|trap|hand|voice|object|curse|threat|room)\b/)
    ) {
      score += 3;
    } else if (includesNarrativePattern(lastEnglish, /\b(part\s*[23]|next part)\b/)) {
      score += 1;
    }
  } else if (partNumber === STORY_PART_COUNT) {
    const endingWindow = sceneEnglish.slice(-2).join(' ');
    if (includesNarrativePattern(endingWindow, /\b(finally|by morning|survived|broke|alive|ash|mark|dissolved|escaped)\b/)) {
      score += 3;
    }
  }
  const namedCharacters = new Set(
    sceneEnglish.flatMap((line) =>
      Object.values(NAME_ROMANIZATION).filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(line))
    )
  );
  if (namedCharacters.size >= 2) score += 2;
  else if (namedCharacters.size === 1) score += 1;
  const leadSignatures = scenes.map((scene) => buildSceneLeadSignature(scene && scene.sentenceEnglish ? scene.sentenceEnglish : ''));
  if (new Set(leadSignatures.filter(Boolean)).size >= Math.max(5, scenes.length - 1)) {
    score += 2;
  } else if (new Set(leadSignatures.filter(Boolean)).size >= Math.max(4, scenes.length - 2)) {
    score += 1;
  }
  return score;
}

function createSeed(arc) {
  const protagonistDescriptions = [
    "Indian man, early 30s, sharp jaw, black hair, wearing a dark jacket",
    "Indian male, late 20s, rugged stubble, intense eyes, wearing a simple solid shirt",
    "South Asian man, mid 30s, short messy hair, wearing a dark hoodie",
    "Indian man, 25 years old, clean shaven, expressive face, wearing a casual jacket"
  ];

  return {
    protagonistHindi: pick(HEROES),
    allyHindi: pick(ALLIES),
    placeHindi: pick(arc.placeHi),
    placeEnglish: pick(arc.placeEn),
    objectHindi: pick(arc.objectHi),
    objectEnglish: pick(arc.objectEn),
    threatHindi: pick(arc.threatHi),
    threatEnglish: pick(arc.threatEn),
    sensoryHindi: arc.sensoryAnchors ? pick(arc.sensoryAnchors) : 'à¤…à¤‚à¤§à¥‡à¤°à¥‡ à¤®à¥‡à¤‚ à¤¸à¤¾à¤‚à¤¸ à¤•à¥€ à¤†à¤µà¤¾à¤œà¤¼',
    sensoryEnglish: arc.sensoryAnchorsEn ? pick(arc.sensoryAnchorsEn) : 'breathing in the dark',
    characterDescription: pick(protagonistDescriptions),
  };
}

function normalizeState(raw) {
  const repaired = repairValue(raw || {});
  const current = repaired.currentSeries;
  if (!current || typeof current !== 'object') {
    return { currentSeries: null, completedSeries: Array.isArray(repaired.completedSeries) ? repaired.completedSeries : [] };
  }
  const normalized = {
    arc: current.arc || null,
    subject: repairText(current.subject || ''),
    baseTitle: repairText(current.baseTitle || current.subject || ''),
    startedAt: current.startedAt || new Date().toISOString(),
    seed: current.seed && typeof current.seed === 'object' ? repairValue(current.seed) : null,
    partsCompleted: Array.isArray(current.partsCompleted) ? current.partsCompleted.map(Number).filter(Boolean) : [],
    partSummaries: Array.isArray(current.partSummaries) ? current.partSummaries.map(repairText) : [],
    generatedParts: Array.isArray(current.generatedParts) ? current.generatedParts.map(repairValue) : [],
  };
  if (looksMojibake(normalized.subject) || normalized.generatedParts.some((part) => !isValidStoryPart(part))) {
    return { currentSeries: null, completedSeries: Array.isArray(repaired.completedSeries) ? repaired.completedSeries : [] };
  }
  return { currentSeries: normalized, completedSeries: Array.isArray(repaired.completedSeries) ? repaired.completedSeries : [] };
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { currentSeries: null, completedSeries: [] };
  try { return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); }
  catch (_) { return { currentSeries: null, completedSeries: [] }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(repairValue(state), null, 2));
}

async function callGeminiStory(prompt) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // Phase A — free-tier key returns 400 on gemini-2.5-*. Default to 1.5 family.
  const models = uniqueNonEmpty([
    process.env.GEMINI_STORY_QUALITY_MODEL || 'gemini-1.5-pro',
    process.env.GEMINI_STORY_PRIMARY_MODEL || 'gemini-1.5-flash',
    process.env.GEMINI_STORY_SECONDARY_MODEL || 'gemini-1.5-flash-8b',
    process.env.GEMINI_STORY_EXPERIMENTAL_MODEL || '',
  ]);
  let lastError = null;
  for (const modelName of models) {
    try {
      return (await genAI.getGenerativeModel({ model: modelName }).generateContent(prompt)).response.text();
    } catch (error) {
      lastError = error;
      const message = String(error && error.message ? error.message : error);
      if (message.includes('429') || /quota|RESOURCE_EXHAUSTED/i.test(message)) await sleep(GEMINI_RATE_LIMIT_RETRY_MS);
    }
  }
  throw lastError || new Error('No Gemini story model succeeded.');
}

async function callDeepSeekStory(prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STORY_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat', temperature: 0.8, max_tokens: 2200,
        messages: [
          { role: 'system', content: 'Return only valid JSON. Hindi narration must be in Devanagari and subtitles in English. Write vivid, cinematic Hindi fiction.' },
          { role: 'user', content: prompt },
        ],
      }),
    });
    const data = await response.json();
    return data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : '';
  } finally { clearTimeout(timer); }
}

async function callOllamaStory(prompt) {
  const models = uniqueNonEmpty(
    String(process.env.OLLAMA_STORY_MODELS || process.env.OLLAMA_STORY_MODEL || '')
      .split(',')
      .map((value) => value.trim())
  );
  let lastError = null;

  for (const modelName of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STORY_TIMEOUT_MS);
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          stream: false,
          format: 'json',
          options: {
            temperature: 0.8,
          },
          messages: [
            {
              role: 'system',
              content:
                'Return only valid JSON. Hindi narration must be in Devanagari, intense, cinematic, and fully fictional. English subtitles must be faithful and clean.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Ollama ${modelName} HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const data = await response.json();
      return data && data.message ? data.message.content || '' : '';
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('No Ollama story model succeeded.');
}

const STORY_PART_COUNT = Math.max(2, Math.min(3, Number(process.env.STORY_PART_COUNT || process.env.DAILY_STORY_VIDEO_COUNT || '3') || 3));

function getEffectiveStoryPartNumber(partNumber) {
  if (STORY_PART_COUNT === 2 && partNumber === 2) return 3;
  return partNumber;
}

function buildPrompt(arc, subject, seed, partNumber, previousSummary) {
  const effectivePartNumber = getEffectiveStoryPartNumber(partNumber);
  const ranges = { 1: '44-56', 2: '44-56', 3: '44-56' };
  const partDirectives = {
    1: [
      'à¤¶à¥à¤°à¥‚ à¤•à¤°à¥‹ à¤à¤• à¤¤à¥‡à¤œà¤¼ cinematic hook à¤¸à¥‡ â€” à¤ªà¤¹à¤²à¥‡ à¤¹à¥€ à¤µà¤¾à¤•à¥à¤¯ à¤®à¥‡à¤‚ à¤ªà¤¾à¤ à¤• à¤•à¥‹ à¤œà¤—à¤¹ à¤•à¤¾ à¤®à¤¾à¤¹à¥Œà¤², tension, à¤”à¤° emotion à¤•à¤¾ à¤à¤¹à¤¸à¤¾à¤¸ à¤¹à¥‹',
      `${seed.protagonistHindi} à¤•à¥‹ ${seed.objectHindi} à¤®à¤¿à¤²à¤¤à¤¾ à¤¹à¥ˆ à¤¯à¤¾ à¤¸à¤¾à¤®à¤¨à¤¾ à¤¹à¥‹à¤¤à¤¾ à¤¹à¥ˆ â€” à¤‡à¤¸à¤•à¤¾ à¤µà¤°à¥à¤£à¤¨ à¤‡à¤¤à¤¨à¤¾ à¤¸à¤Ÿà¥€à¤• à¤¹à¥‹ à¤•à¤¿ à¤¦à¤°à¥à¤¶à¤• à¤‰à¤¸à¥‡ à¤®à¤¹à¤¸à¥‚à¤¸ à¤•à¤° à¤¸à¤•à¥‡, à¤‰à¤¸à¤•à¥€ à¤¬à¤¨à¤¾à¤µà¤Ÿ à¤”à¤° à¤µà¤œà¤¼à¤¨ feel à¤¹à¥‹`,
      `à¤•à¤® à¤¸à¥‡ à¤•à¤® 3 à¤¬à¤¾à¤° direct dialogue à¤²à¤¿à¤–à¥‹ â€” "${seed.protagonistHindi} à¤¨à¥‡ à¤•à¤¹à¤¾" à¤¯à¤¾ "${seed.allyHindi} à¤šà¤¿à¤²à¥à¤²à¤¾à¤ˆ" â€” à¤¹à¤° dialogue à¤®à¥‡à¤‚ emotion (tension, motivation, urgency) spill à¤¹à¥‹`,
      `à¤¹à¤° scene à¤®à¥‡à¤‚ à¤•à¤® à¤¸à¥‡ à¤•à¤® à¤à¤• sensory anchor à¤œà¤¼à¤°à¥‚à¤° à¤¡à¤¾à¤²à¥‹ â€” à¤¸à¤¿à¤°à¥à¤« visual à¤¨à¤¹à¥€à¤‚, à¤¬à¤²à¥à¤•à¤¿ sound (à¤¨à¤—à¤¾à¤¡à¤¼à¥‡, à¤•à¤¾à¤° à¤•à¥€ à¤†à¤µà¤¾à¤œà¤¼, à¤—à¥‹à¤²à¤¿à¤¯à¤¾à¤‚), smell (à¤¬à¤¾à¤°à¥‚à¤¦, à¤®à¤¿à¤Ÿà¥à¤Ÿà¥€, à¤‡à¤¤à¥à¤°), touch (à¤ªà¤¸à¥€à¤¨à¤¾, à¤†à¤‚à¤¸à¥‚, à¤šà¥‹à¤Ÿ)`,
      `${seed.threatHindi} à¤•à¤¾ à¤ªà¤¹à¤²à¤¾ signal à¤¦à¥‹ â€” antagonism establish à¤•à¤°à¥‹ à¤œà¥‹ à¤†à¤—à¥‡ à¤œà¤¾à¤•à¤° à¤¬à¤¡à¤¼à¥€ à¤šà¥à¤¨à¥Œà¤¤à¥€ à¤¬à¤¨à¥‡`,
      `${seed.protagonistHindi} à¤•à¥€ à¤à¤• internal thought à¤²à¤¿à¤–à¥‹ â€” "à¤‰à¤¸à¤¨à¥‡ à¤¸à¥‹à¤šà¤¾..." format à¤®à¥‡à¤‚, à¤œà¥‹ à¤‰à¤¸à¤•à¥€ vulnerability à¤¯à¤¾ determination à¤¦à¤¿à¤–à¤¾à¤`,
      'à¤à¤• dramatic slow-motion scene à¤°à¤–à¥‹ à¤œà¤¹à¤¾à¤ suspense à¤¯à¤¾ emotion à¤¹à¤¾à¤µà¥€ à¤¹à¥‹, à¤«à¤¿à¤° à¤à¤• rapid-action scene à¤œà¤¹à¤¾à¤ sudden pacing change à¤¹à¥‹',
      'à¤…à¤‚à¤¤ à¤®à¥‡à¤‚ à¤à¤• CONCRETE physical challenge: abstract danger BANNED à¤¹à¥ˆ â€” à¤²à¤¿à¤–à¥‹ "à¤ªà¥à¤²à¤¿à¤¸ à¤¨à¥‡ à¤šà¤¾à¤°à¥‹à¤‚ à¤¤à¤°à¤« à¤¸à¥‡ à¤˜à¥‡à¤° à¤²à¤¿à¤¯à¤¾, à¤”à¤° à¤¸à¤¾à¤®à¤¨à¥‡ à¤¸à¤¿à¤°à¥à¤« à¤à¤• à¤°à¤¾à¤¸à¥à¤¤à¤¾ à¤¥à¤¾" à¤œà¥ˆà¤¸à¤¾ specific',
      'à¤¹à¤° scene à¤•à¤¾ PACING à¤…à¤²à¤— à¤¹à¥‹ â€” short rapid 5-word sentences mix à¤•à¤°à¥‹ 15-word descriptive ones à¤•à¥‡ à¤¸à¤¾à¤¥',
    ],
    2: [
      `à¤ªà¤¿à¤›à¤²à¥‡ à¤­à¤¾à¤— à¤•à¤¾ 1-line sharp recap Hindi à¤®à¥‡à¤‚ â€” SPECIFIC events mention à¤•à¤°à¥‹ (à¤•à¥Œà¤¨ à¤¸à¤¾ object, à¤•à¥Œà¤¨ à¤¸à¥€ à¤œà¤—à¤¹, à¤•à¥à¤¯à¤¾ à¤¹à¥à¤†)`,
      `à¤à¤• major turning point à¤¯à¤¾ setback â€” à¤œà¥‹ Part 1 à¤•à¥€ à¤•à¤¿à¤¸à¥€ SPECIFIC à¤šà¥€à¤œà¤¼ à¤•à¥‹ recontextualize à¤•à¤°à¥‡, à¤¨à¤ˆ meaning à¤¦à¥‡`,
      `${seed.allyHindi} à¤•à¤¾ role DRAMATICALLY increase à¤•à¤°à¥‹ â€” ally à¤¸à¥‡ saviour à¤¯à¤¾ critical mentor â€” à¤”à¤° à¤¯à¥‡ shift dialogue à¤®à¥‡à¤‚ reveal à¤¹à¥‹`,
      `à¤•à¤® à¤¸à¥‡ à¤•à¤® 3 direct dialogue lines â€” à¤à¤• ${seed.protagonistHindi} à¤•à¥€ (motivation/anger), à¤à¤• ${seed.allyHindi} à¤•à¥€ (support/warning), à¤à¤• ${seed.threatHindi} à¤¸à¥‡ à¤œà¥à¤¡à¤¼à¥€ (command/threat)`,
      `sensory intensity ESCALATE à¤•à¤°à¥‹: à¤…à¤—à¤° Part 1 à¤®à¥‡à¤‚ à¤ªà¤¸à¥€à¤¨à¤¾ à¤¥à¤¾ à¤¤à¥‹ à¤…à¤¬ à¤–à¥‚à¤¨ à¤¹à¥‹, à¤…à¤—à¤° à¤†à¤µà¤¾à¤œà¤¼ à¤¥à¥€ à¤¤à¥‹ à¤…à¤¬ à¤§à¤®à¤¾à¤•à¤¾ à¤¹à¥‹ â€” ${seed.sensoryHindi} à¤•à¥‹ 10x à¤•à¤°à¥‹`,
      `${seed.protagonistHindi} à¤•à¥‹ à¤à¤• impossible choice à¤¦à¥‹ â€” sacrifice à¤•à¤°à¥‹ à¤¯à¤¾ à¤¸à¤¾à¤®à¤¨à¤¾ à¤•à¤°à¥‹ â€” à¤”à¤° à¤¯à¥‡ choice physical à¤¹à¥‹ (à¤œà¥€à¤¤, à¤†à¤œà¤¼à¤¾à¤¦à¥€, à¤ªà¥à¤¯à¤¾à¤°, à¤œà¤¾à¤¨)`,
      'à¤à¤• scene à¤œà¤¹à¤¾à¤ time pressure PHYSICAL à¤¹à¥‹ â€” "à¤Ÿà¥à¤°à¥‡à¤¨ à¤•à¥‡ à¤›à¥‚à¤Ÿà¤¨à¥‡ à¤¸à¥‡ à¤ªà¤¹à¤²à¥‡" à¤¯à¤¾ "à¤¬à¤® à¤«à¤Ÿà¤¨à¥‡ à¤¸à¥‡ à¤ªà¤¹à¤²à¥‡" à¤¯à¤¾ "à¤†à¤–à¤¿à¤°à¥€ à¤°à¤¾à¤‰à¤‚à¤¡ à¤–à¤¤à¥à¤® à¤¹à¥‹à¤¨à¥‡ à¤¤à¤•"',
      'cliffhanger: Part 3 à¤•à¤¾ setup â€” EXACTLY à¤¬à¤¤à¤¾à¤“ à¤•à¥Œà¤¨ à¤¸à¤¾ confrontation à¤¹à¥‹à¤—à¤¾, à¤•à¤¿à¤¸à¤•à¥‡ à¤¬à¥€à¤š, à¤”à¤° à¤à¤• specific location/challenge mention à¤•à¤°à¥‹',
    ],
    3: [
      `Parts 1 à¤”à¤° 2 à¤•à¤¾ 1-line recap â€” SPECIFIC plot points: à¤•à¥à¤¯à¤¾ à¤¦à¤¾à¤‚à¤µ à¤ªà¤° à¤²à¤—à¤¾ à¤¹à¥ˆ, à¤†à¤–à¤¿à¤°à¥€ choice à¤•à¥à¤¯à¤¾ à¤¥à¥€`,
      `${seed.protagonistHindi} à¤à¤• ACTIVE choice à¤•à¤°à¥‡ â€” à¤à¤• à¤†à¤–à¤¿à¤°à¥€ à¤µà¤¾à¤° à¤•à¤°à¥‡, à¤¦à¥Œà¤¡à¤¼à¥‡, à¤¸à¤šà¥à¤šà¤¾à¤ˆ à¤¬à¥‹à¤²à¥‡ â€” passive discovery à¤¯à¤¾ luck BANNED`,
      `${seed.threatHindi} à¤¸à¥‡ FACE-TO-FACE direct confrontation â€” à¤¦à¥‹à¤¨à¥‹à¤‚ à¤†à¤®à¤¨à¥‡-à¤¸à¤¾à¤®à¤¨à¥‡ à¤¹à¥‹à¤‚, intense dialogue exchange à¤¹à¥‹`,
      `à¤•à¤® à¤¸à¥‡ à¤•à¤® 3 dialogue lines CLIMAX à¤®à¥‡à¤‚ â€” rapid-fire back-and-forth à¤œà¥‹ cinematic tension build à¤•à¤°à¥‡`,
      `à¤¸à¤¬à¤¸à¥‡ INTENSE visual moment story à¤•à¥‡ LAST 2 scenes à¤®à¥‡à¤‚ à¤°à¤–à¥‹ â€” victory moment, massive explosion, epic reunion, trophy lift`,
      'resolution LOGICAL à¤¹à¥‹ â€” à¤ªà¤¹à¤²à¥‡ à¤•à¥‡ EXACT setup à¤•à¤¾ payoff (Part 1 à¤•à¤¾ object, Part 2 à¤•à¥€ choice à¤•à¤¾ à¤…à¤¸à¤°)',
      `${seed.allyHindi} à¤•à¤¾ final role CLEAR à¤”à¤° ACTIVE à¤•à¤°à¥‹ â€” passive bystander BANNED`,
      'à¤…à¤‚à¤¤à¤¿à¤® à¤µà¤¾à¤•à¥à¤¯ EMOTIONAL à¤¹à¥‹ â€” "à¤à¤¸à¥€ à¤”à¤° à¤•à¤¹à¤¾à¤¨à¤¿à¤¯à¥‹à¤‚ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹" naturally fit à¤¹à¥‹, forced CTA BANNED',
      'LAST SCENE must leave ONE unforgettable visual image â€” something the viewer sees when they close their eyes (like a movie freeze frame)',
    ],
  };

  const baseRules = [
    `Write part ${partNumber} of a ${STORY_PART_COUNT}-part fictional Hindi YouTube Shorts story.`,
    `Title: ${subject}`,
    `Arc type: ${arc.type} â€” ${arc.intro}`,
    `Hero: ${seed.protagonistHindi} | Ally: ${seed.allyHindi}`,
    `Place: ${seed.placeHindi} (${seed.placeEnglish})`,
    `Object: ${seed.objectHindi} (${seed.objectEnglish})`,
    `Threat: ${seed.threatHindi} (${seed.threatEnglish})`,
    `Sensory anchor: ${seed.sensoryHindi} (${seed.sensoryEnglish})`,
    previousSummary ? `CONTINUITY from previous parts:\n${previousSummary}` : 'This is Part 1. Establish the dark atmosphere in the first sentence.',
    '',
    'MANDATORY NARRATIVE DIRECTIVES:',
    ...partDirectives[effectivePartNumber].map((d, i) => `${i + 1}. ${d}`),
    '',
    'HARD RULES:',
    '- HYPNOTIC LOOPING: The very last sentence of your script MUST grammatically half-finish and lead directly into the first hook sentence of your script. Example: "...isiliye asli darr shuru hota hai jabâ€”" (loops to) "â€”DARWAZA KHULA!"',
    '- DO NOT include any Call to Actions like "like and subscribe" at the end of the script. It breaks the loop.',
    `- Hindi narration: ${ranges[effectivePartNumber]} words, Devanagari script ONLY`,
    '- English subtitles: full faithful translation of the Hindi narration',
    '- Hindi narration must not contain Latin or English words like "follow", "part", or English adjectives',
    '- Exactly 7 scenes',
    '- Each scene MUST have a UNIQUE literalSearchTerm â€” no repeats, no vague terms like "dark suspense"',
    '- literalSearchTerm must be a specific, filmable English noun phrase (e.g. "rusted iron door closeup", NOT "dark suspense" or "tense atmosphere")',
    '- BANNED phrases: "stakes raised", "truth revealed", "danger escalated", "game began", "meaning changed", "khel shuru hua", "sach samne aaya"',
    '- Every scene must advance the plot â€” no filler, no repetition, no "atmosphere building" without action',
    '- Use concrete actions, sounds, physical sensations â€” NOT abstract descriptions like "tension increased" or "fear grew"',
    '- Direct dialogue must use quotation marks in Hindi: "..." â€” MINIMUM 3 dialogue lines per part',
    '- Each scene should stay under 18 Hindi words and sound speakable for a human storyteller narrating with emotion and natural breath control',
    '- Write Hindi clauses for premium voice synthesis: avoid tongue-twister stacking, overloaded compound sentences, and abrupt English-sounding phrasing',
    '- Scene 3 or 4 must contain a clear suspense hinge such as "Lekin ab asli twist aata hai" or equally sharp Hindi midpoint turn',
    '- Make the overall emotion VISCERAL, PHYSICAL, and cliffhanger-driven â€” the viewer must feel it in their body',
    '- PERSONA-DRIVEN: Write like a modern, high-energy YouTube/Instagram Creator. Use natural pacing, dramatic pauses, and conversational internet slang. NO robotic tone.',
    '- Vary sentence length dramatically: 3-word rapid punch ("Vo ruka. Saans thami.") mixed with 18-word atmospheric descriptions',
    '- Include at least 2 sound words (onomatopoeia) per scene â€” à¤§à¤®à¥à¤®, à¤šà¤°à¥à¤°, à¤–à¤Ÿ-à¤–à¤Ÿ, à¤¸à¤¨à¥à¤¨, à¤›à¤¨à¥à¤¨, à¤•à¤¡à¤¼à¤¾à¤•, à¤­à¤¡à¤¼à¤¾à¤®, à¤¸à¤°à¥à¤°, à¤–à¤¡à¤¼à¤–à¤¡à¤¼',
    '- Never start two consecutive scenes with the same sentence pattern or the same character name',
    '- EVERY scene must have one line that triggers a physical reaction â€” goosebumps, held breath, racing heart',
    '- Scene 1 must begin with an immediate physical disruption, eerie discovery, or spoken warning inside the first 8 words',
    '- Part 2 must reinterpret one clue from Part 1 instead of only making the danger louder',
    '- Part 3 must pay off one exact object, room, warning, or promise introduced earlier',
    '- The final dramatic sentence before any follow CTA must leave one concrete visual image in the viewer mind',
    '- Reuse at least one earlier clue so the arc feels designed, not randomly improvised',
    '- Also generate Hook_Text: exactly 3 uppercase words for the on-screen power overlay',
    '- Also generate BGM_Prompt for a dark open-source no-vocals background track',
    '- Also generate Pattern_Interrupts every 3 seconds for vertical pacing resets',
    '- Also generate characterLock: one concise English description of the recurring protagonist/avatar look',
    '- Generate EXACTLY 7 Visual_Cues: one per scene, in the same order as the scenes',
    '- Every Visual_Cue must use this format exactly: [CameraMotion][Flux prompt]',
    '- Every Visual_Cue prompt must specify a visible subject, location, action, and lighting mood so the image generator can produce a premium cinematic still',
  ];

  const isV13 = process.env.ENABLE_V13_HACKS === 'true';
  if (isV13) {
    baseRules.push(
      '- EXTREMELY IMPORTANT (Mind-Attack Hook): Start the script IN THE MIDDLE OF ACTION, no setup. Jump straight to the horror.',
      '- EXTREMELY IMPORTANT (Infinite Loop): The Final Sentence of Part 3 MUST grammatically connect seamlessly to the First Sentence of Part 1.',
      '- Use `<break time=\"1.5s\"/>` inside the Hindi Script immediately before massive plot reveals or jump scares to build suspense.',
      '- Use deeply visceral, terrifying Hindi vocabulary (e.g., Bhayanak, Khauf, Rongte Khade) instead of basic translation.'
    );
  }

  baseRules.push(
    '',
    'Return ONLY valid JSON:',
    '{"Hook_Text":"3-WORD HOOK","BGM_Prompt":"specific no-vocals music prompt","Pattern_Interrupts":["00:03 - 1.2x zoom snap"],"characterLock":"recurring avatar look","Visual_Cues":["[Crash Zoom][specific cinematic prompt]"],"scriptTextHindi":"...","scriptTextEnglish":"...","partSummary":"2-3 sentence summary of SPECIFIC events that happened","scenes":[{"sentenceHindi":"...","sentenceEnglish":"...","durationWeight":1.2,"literalSearchTerm":"specific filmable term","fallbackVibeTerm":"mood term","portraitSearchTerm":"portrait type"}]}'
  );

  return baseRules.join('\n');
}

function extractJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  return first >= 0 && last > first ? cleaned.slice(first, last + 1) : null;
}

function parseStoryResponse(rawText, options = {}) {
  const json = extractJson(rawText);
  if (!json) return null;
  try {
    const parsed = repairValue(JSON.parse(json));
    const candidate = {
      scriptTextHindi: sanitizeHindiStoryText(parsed.scriptTextHindi || ''),
      scriptTextEnglish: repairText(parsed.scriptTextEnglish || ''),
      partSummary: repairText(parsed.partSummary || ''),
      scenes: Array.isArray(parsed.scenes) ? parsed.scenes.map((scene, index) => normalizeScene(scene, index)) : [],
      hookText: normalizePowerHookText(parsed.Hook_Text || parsed.hookText || parsed.hook_text || ''),
      bgmPrompt: String(parsed.BGM_Prompt || parsed.bgmPrompt || '').replace(/\s+/g, ' ').trim() || null,
      patternInterrupts: normalizePatternInterrupts(parsed.Pattern_Interrupts || parsed.patternInterrupts),
      visualCues: normalizeVisualCueList(parsed.Visual_Cues || parsed.visualCues),
      characterLock: String(parsed.characterLock || parsed.character_lock || '').replace(/\s+/g, ' ').trim() || null,
    };
    candidate.scriptText = candidate.scriptTextHindi;
    return isValidStoryPart(candidate, options) ? candidate : null;
  } catch (_) { return null; }
}

// â”€â”€â”€ ARC-SPECIFIC RICH FALLBACK TEMPLATES â”€â”€â”€
function buildFallbackPart(seed, arc, partNumber) {
  const effectivePartNumber = getEffectiveStoryPartNumber(partNumber);
  const genericTemplates = {
    1: [
      [`${seed.placeHindi} à¤®à¥‡à¤‚ ${seed.protagonistHindi} à¤¨à¥‡ à¤œà¥ˆà¤¸à¥‡ à¤¹à¥€ à¤•à¤¦à¤® à¤°à¤–à¤¾, à¤¹à¤µà¤¾ à¤®à¥‡à¤‚ ${seed.sensoryHindi} à¤•à¤¾ à¤à¤¹à¤¸à¤¾à¤¸ à¤¹à¥à¤†, à¤”à¤° ${seed.objectHindi} à¤‰à¤¸à¤•à¥‡ à¤¸à¤¾à¤®à¤¨à¥‡ à¤¥à¤¾à¥¤`, `The moment ${seed.protagonistHindi} stepped into ${seed.placeEnglish}, the air filled with ${seed.sensoryEnglish}, and the ${seed.objectEnglish} was right there before him.`, `${seed.placeEnglish} dramatic entrance`],
      [`"à¤…à¤¬ à¤ªà¥€à¤›à¥‡ à¤¹à¤Ÿà¤¨à¥‡ à¤•à¤¾ à¤•à¥‹à¤ˆ à¤°à¤¾à¤¸à¥à¤¤à¤¾ à¤¨à¤¹à¥€à¤‚!" ${seed.allyHindi} à¤¨à¥‡ à¤šà¤¿à¤²à¥à¤²à¤¾à¤•à¤° à¤•à¤¹à¤¾à¥¤ ${seed.protagonistHindi} à¤¨à¥‡ à¤¸à¤¿à¤° à¤¹à¤¿à¤²à¤¾à¤¯à¤¾ à¤”à¤° à¤†à¤—à¥‡ à¤¬à¤¢à¤¼à¤¾à¥¤`, `"There's no turning back now!" ${seed.allyHindi} shouted. ${seed.protagonistHindi} nodded and moved forward.`, 'dramatic turning point determination'],
      [`à¤¤à¤­à¥€ ${seed.threatHindi} à¤•à¤¾ à¤¸à¤¾à¤¯à¤¾ à¤‰à¤¨ à¤ªà¤° à¤ªà¤¡à¤¼à¤¾à¥¤ à¤šà¥à¤¨à¥Œà¤¤à¥€ à¤¸à¤¾à¤« à¤¥à¥€, à¤”à¤° à¤¸à¤®à¤¯ à¤•à¤® à¤¥à¤¾à¥¤`, `Then the shadow of ${seed.threatEnglish} fell upon them. The challenge was clear, and time was short.`, 'threat looming dramatic confrontation'],
      [`${seed.objectHindi} à¤•à¥€ à¤šà¤®à¤• à¤¸à¥‡ ${seed.protagonistHindi} à¤•à¤¾ à¤šà¥‡à¤¹à¤°à¤¾ à¤°à¥‹à¤¶à¤¨ à¤¹à¥‹ à¤—à¤¯à¤¾à¥¤ à¤‰à¤¸à¥‡ à¤ªà¤¤à¤¾ à¤¥à¤¾ à¤•à¤¿ à¤¯à¤¹à¥€ à¤†à¤–à¤¿à¤°à¥€ à¤‰à¤®à¥à¤®à¥€à¤¦ à¤¹à¥ˆà¥¤`, `The shine of the ${seed.objectEnglish} illuminated ${seed.protagonistHindi}'s face. He knew this was the last hope.`, 'object glowing face closeup hero'],
      [`à¤²à¥‡à¤•à¤¿à¤¨ à¤…à¤šà¤¾à¤¨à¤•, à¤à¤• à¤œà¤¼à¤¬à¤°à¤¦à¤¸à¥à¤¤ à¤§à¤®à¤¾à¤•à¤¾ à¤¹à¥à¤†à¥¤ ${seed.placeHindi} à¤•à¥€ à¤¦à¥€à¤µà¤¾à¤°à¥‡à¤‚ à¤¹à¤¿à¤² à¤—à¤ˆà¤‚à¥¤ à¤…à¤—à¤²à¥‡ à¤­à¤¾à¤— à¤®à¥‡à¤‚ à¤…à¤¸à¤²à¥€ à¤²à¤¡à¤¼à¤¾à¤ˆ à¤¶à¥à¤°à¥‚ à¤¹à¥‹à¤—à¥€à¥¤`, `But suddenly, a massive explosion occurred. The walls of ${seed.placeEnglish} shook. Part 2 will begin the real fight.`, 'massive cinematic explosion dust'],
    ],
    2: [
      [`à¤§à¤®à¤¾à¤•à¥‡ à¤•à¥‡ à¤¬à¤¾à¤¦ à¤§à¥à¤‚à¤† à¤¹à¤Ÿà¤¾ à¤¤à¥‹ ${seed.protagonistHindi} à¤–à¤¡à¤¼à¤¾ à¤¥à¤¾, à¤‰à¤¸à¤•à¥‡ à¤¹à¤¾à¤¥à¥‹à¤‚ à¤®à¥‡à¤‚ ${seed.objectHindi} à¤®à¤œà¤¬à¥‚à¤¤à¥€ à¤¸à¥‡ à¤ªà¤•à¤¡à¤¼à¤¾ à¤¥à¤¾à¥¤`, `When the smoke cleared after the explosion, ${seed.protagonistHindi} stood tall, holding the ${seed.objectEnglish} firmly.`, 'smoke clearing hero stands tall'],
      [`"à¤¤à¥à¤® à¤…à¤•à¥‡à¤²à¥‡ à¤¨à¤¹à¥€à¤‚ à¦šà¦°à¦® à¤¹à¥‹," ${seed.allyHindi} à¤¨à¥‡ à¤•à¤¹à¤¾, à¤”à¤° à¤‰à¤¸à¤•à¥‡ à¤¸à¤¾à¤¥ à¤–à¤¡à¤¼à¥€ à¤¹à¥‹ à¤—à¤ˆà¥¤`, `"You are not alone," ${seed.allyHindi} said, standing beside him.`, 'allies standing together cinematic'],
      [`${seed.threatHindi} à¤…à¤¬ à¤ªà¥‚à¤°à¥€ à¤¤à¤¾à¤•à¤¤ à¤¸à¥‡ à¤µà¤¾à¤° à¤•à¤°à¤¨à¥‡ à¤µà¤¾à¤²à¤¾ à¤¥à¤¾à¥¤ à¤–à¤¤à¤°à¤¾ à¤ªà¤¹à¤²à¥‡ à¤¸à¥‡ à¤¦à¤¸ à¤—à¥à¤¨à¤¾ à¤œà¥à¤¯à¤¾à¤¦à¤¾ à¤¥à¤¾à¥¤ ${seed.sensoryHindi} à¤¹à¤° à¤¤à¤°à¤« à¤«à¥ˆà¤² à¤—à¤¯à¤¾à¥¤`, `${seed.threatEnglish} was about to strike with full force. The danger was ten times greater. ${seed.sensoryEnglish} spread everywhere.`, 'intense battle threat approaching'],
      [`${seed.protagonistHindi} à¤•à¥‹ à¤à¤• à¤«à¥ˆà¤¸à¤²à¤¾ à¤²à¥‡à¤¨à¤¾ à¤¥à¤¾: à¤•à¥à¤¯à¤¾ à¤µà¥‹ ${seed.objectHindi} à¤•à¤¾ à¤‡à¤¸à¥à¤¤à¥‡à¤®à¤¾à¤² à¤•à¤°à¥‡à¤—à¤¾ à¤¯à¤¾ à¤…à¤ªà¤¨à¥‡ à¤‰à¤¸à¥‚à¤²à¥‹à¤‚ à¤ªà¤° à¤Ÿà¤¿à¤•à¥‡à¤—à¤¾?`, `${seed.protagonistHindi} had to make a decision: would he use the ${seed.objectEnglish} or stick to his principles?`, 'hero thinking tough decision focus'],
      [`à¤‰à¤¸à¤¨à¥‡ à¤à¤• à¤—à¤¹à¤°à¥€ à¤¸à¤¾à¤‚à¤¸ à¤²à¥€à¥¤ "à¤®à¥ˆà¤‚ à¤®à¥à¤•à¤¾à¤¬à¤²à¤¾ à¤•à¤°à¥‚à¤à¤—à¤¾à¥¤" à¤…à¤—à¤²à¥‡ à¤­à¤¾à¤— à¤®à¥‡à¤‚ à¤¹à¥‹à¤—à¤¾ à¤…à¤‚à¤¤à¤¿à¤® à¤«à¥ˆà¤¸à¤²à¤¾à¥¤`, `He took a deep breath. "I will fight." Part 3 will have the final outcome.`, 'hero deep breath cinematic stare'],
    ],
    3: [
      [`${seed.protagonistHindi} à¤¨à¥‡ à¤†à¤–à¤¿à¤°à¥€ à¤µà¤¾à¤° à¤•à¤¿à¤¯à¤¾! ${seed.objectHindi} à¤¸à¥‡ à¤¨à¤¿à¤•à¤²à¥€ à¤Šà¤°à¥à¤œà¤¾ à¤¨à¥‡ à¤ªà¥‚à¤°à¥‡ ${seed.placeHindi} à¤•à¥‹ à¤°à¥‹à¤¶à¤¨ à¤•à¤° à¤¦à¤¿à¤¯à¤¾à¥¤`, `${seed.protagonistHindi} delivered the final strike! The energy from the ${seed.objectEnglish} illuminated the entire ${seed.placeEnglish}.`, 'final strike energy burst cinematic'],
      [`${seed.threatHindi} à¤²à¤¡à¤¼à¤–à¤¡à¤¼à¤¾ à¤•à¤° à¤—à¤¿à¤° à¤ªà¤¡à¤¼à¤¾à¥¤ à¤œà¥€à¤¤ à¤¹à¤¾à¤¸à¤¿à¤² à¤¹à¥à¤ˆ à¤¥à¥€, à¤²à¥‡à¤•à¤¿à¤¨ à¤•à¥€à¤®à¤¤ à¤­à¤¾à¤°à¥€ à¤¥à¥€à¥¤`, `${seed.threatEnglish} stumbled and fell. Victory was achieved, but the price was heavy.`, 'villain falling defeat triumph'],
      [`${seed.allyHindi} à¤¨à¥‡ à¤¦à¥Œà¤¡à¤¼à¤•à¤° ${seed.protagonistHindi} à¤•à¥‹ à¤—à¤²à¥‡ à¤²à¤—à¤¾ à¤²à¤¿à¤¯à¤¾à¥¤ à¤¹à¤µà¤¾ à¤®à¥‡à¤‚ ${seed.sensoryHindi} à¤…à¤¬ à¤­à¥€ à¤®à¤¹à¤¸à¥‚à¤¸ à¤¹à¥‹ à¤°à¤¹à¤¾ à¤¥à¤¾, à¤²à¥‡à¤•à¤¿à¤¨ à¤‡à¤¸ à¤¬à¤¾à¤° à¤‡à¤¸à¤®à¥‡à¤‚ à¤¸à¥à¤•à¥‚à¤¨ à¤¥à¤¾à¥¤`, `${seed.allyHindi} ran and hugged ${seed.protagonistHindi}. The ${seed.sensoryEnglish} could still be felt in the air, but this time it brought peace.`, 'emotional hug peace cinematic lighting'],
      [`à¤§à¥‚à¤² à¤¬à¥ˆà¤  à¤—à¤ˆ à¤¥à¥€à¥¤ ${seed.objectHindi} à¤…à¤¬ à¤¸à¥à¤°à¤•à¥à¤·à¤¿à¤¤ à¤¥à¤¾à¥¤`, `The dust had settled. The ${seed.objectEnglish} was now safe.`, 'dust settling safe object glowing'],
      [`à¤•à¤¹à¤¾à¤¨à¥€ à¤¯à¤¹à¤¾à¤ à¤–à¤¤à¥à¤® à¤¨à¤¹à¥€à¤‚ à¤¹à¥‹à¤¤à¥€, à¤¦à¥‹à¤¸à¥à¤¤à¥‹à¤‚à¥¤ à¤à¤¸à¥€ à¤”à¤° à¤¬à¥à¤²à¥‰à¤•à¤¬à¤¸à¥à¤Ÿà¤° à¤•à¤¹à¤¾à¤¨à¤¿à¤¯à¥‹à¤‚ à¤•à¥‡ à¤²à¤¿à¤ à¤¹à¤®à¥‡à¤¶à¤¾ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‡à¤‚à¥¤`, `The story does not end here, friends. Always stay tuned for more blockbuster stories like this.`, 'hero walking into sunset cinematic end'],
    ],
  };

  const templates = genericTemplates[effectivePartNumber];
  const supplementalTemplates = {
    1: [
      [
        `\u0916\u091f-\u0916\u091f \u0915\u0940 \u0906\u0935\u093e\u091c\u093c \u0938\u0947 ${seed.protagonistHindi} \u091c\u092e \u0917\u092f\u093e\u0964 \u0909\u0938\u0928\u0947 \u0926\u0930\u0935\u093e\u091c\u093c\u0947 \u0915\u0947 \u092a\u093e\u0938 \u0938\u093e\u0902\u0938 \u0930\u094b\u0915 \u0932\u0940\u0964`,
        `${seed.protagonistHindi} froze at the hard knocking sound and held his breath near the door.`,
        'metal door knock closeup',
      ],
      [
        `"\u0906\u0935\u093e\u091c\u093c \u092e\u0924 \u0915\u0930\u094b," ${seed.allyHindi} \u0928\u0947 \u092b\u0941\u0938\u092b\u0941\u0938\u093e\u092f\u093e\u0964 ${seed.sensoryHindi} \u0905\u092d\u0940 \u0914\u0930 \u092d\u0940 \u0917\u0939\u0930\u093e \u0939\u094b \u0917\u092f\u093e\u0964`,
        `"Do not make a sound," ${seed.allyHindi} whispered. ${seed.sensoryEnglish} suddenly felt much heavier.`,
        'whisper in dark corridor',
      ],
    ],
    2: [
      [
        `\u091b\u0928\u094d\u0928 \u0938\u0947 \u0915\u0941\u091b \u0917\u093f\u0930\u093e\u0964 ${seed.protagonistHindi} \u0928\u0947 \u0926\u0947\u0916\u093e \u0915\u093f \u0930\u093e\u0938\u094d\u0924\u093e \u0905\u092c \u0906\u0927\u093e \u0939\u0940 \u092c\u091a\u093e \u0939\u0948\u0964`,
        `Something clanged to the floor. ${seed.protagonistHindi} realized only half the escape route was left.`,
        'broken escape route closeup',
      ],
      [
        `"${seed.objectHindi} \u0915\u094b \u0932\u0947\u0915\u0930 \u092d\u093e\u0917\u094b!" ${seed.allyHindi} \u091a\u093f\u0932\u094d\u0932\u093e\u0908\u0964 ${seed.threatHindi} \u0905\u092c \u092c\u0939\u0941\u0924 \u092a\u093e\u0938 \u0925\u093e\u0964`,
        `"Run with the ${seed.objectEnglish}!" ${seed.allyHindi} shouted. ${seed.threatEnglish} was now dangerously close.`,
        'urgent escape shout scene',
      ],
    ],
    3: [
      [
        `\u0915\u0921\u093c\u093e\u0915 \u0915\u0947 \u0938\u093e\u0925 \u091c\u092e\u0940\u0928 \u0939\u093f\u0932\u0940\u0964 ${seed.protagonistHindi} \u092b\u093f\u0930 \u092d\u0940 \u0930\u0941\u0915\u093e \u0928\u0939\u0940\u0902\u0964`,
        `The ground cracked beneath them, but ${seed.protagonistHindi} still did not stop.`,
        'ground crack final clash',
      ],
      [
        `"${seed.allyHindi}, \u0905\u092c \u092a\u0940\u091b\u0947 \u092e\u0924 \u0926\u0947\u0916\u0928\u093e," ${seed.protagonistHindi} \u0928\u0947 \u0915\u0939\u093e\u0964 \u0906\u0916\u093c\u093f\u0930\u0940 \u0915\u0926\u092e \u0909\u0938\u0940 \u092a\u0932 \u0909\u0920\u093e\u0964`,
        `"${seed.allyHindi}, do not look back now," ${seed.protagonistHindi} said. The final move happened in that same instant.`,
        'final move closeup',
      ],
    ],
  };
  const templatePool = [...templates, ...(supplementalTemplates[effectivePartNumber] || [])].slice(0, 7);

  const vibeMap = {
    action_blockbuster: 'high octane cinematic action color grading',
    romantic_drama: 'bollywood cinematic romantic soft lighting',
    epic_historical: 'epic historical baahubali cinematic colors',
    heist_thriller: 'slick neo noir heist cinematic lighting',
    underdog_sports: 'gritty inspirational sports cinematic style',
  };
  const vibe = vibeMap[arc.type] || 'dramatic cinematic movie style';
  const portrait = `cinematic hero portrait, ${vibe}`;

  const scenes = templatePool.map(([hi, en, search], index) => normalizeScene({
    sentenceHindi: hi,
    sentenceEnglish: en,
    durationWeight: index === 0 ? 1.4 : index === templatePool.length - 1 ? 1.5 : 1.08,
    literalSearchTerm: search,
    fallbackVibeTerm: vibe,
    portraitSearchTerm: portrait,
  }, index));

  const hiText = scenes.map(s => s.sentenceHindi).join(' ');
  const enText = scenes.map(s => s.sentenceEnglish).join(' ');

  const hookTexts = {
    action_blockbuster: { 1: 'MISSION SHURU', 2: 'DHOKA HUA', 3: 'AAKHRI WAR' },
    romantic_drama: { 1: 'DOORI PYAR', 2: 'DARD BADA', 3: 'MILAN YAAN' },
    epic_historical: { 1: 'YUDH AARAMBH', 2: 'SENA TAIYAR', 3: 'RAJ TILAK' },
    heist_thriller: { 1: 'TARGET LOCK', 2: 'PLAN FLOP', 3: 'THE ESCAPE' },
    underdog_sports: { 1: 'NUKSAAN HUA', 2: 'MEHNAT KI', 3: 'JEET HASIL' },
  };
  const hook = hookTexts[arc.type] ? hookTexts[arc.type][effectivePartNumber] : 'NEXT SCENE';

  const bgmMap = {
    action_blockbuster: 'High energy action trailer music, heavy brass, driving synths, 128 BPM',
    romantic_drama: 'Emotional orchestral romance, acoustic guitar, soft piano, 80 BPM',
    epic_historical: 'Epic cinematic war drums, massive choir, orchestral horns, 100 BPM',
    heist_thriller: 'Slick heist groove, walking bassline, snapping fingers, tense synth, 110 BPM',
    underdog_sports: 'Inspirational sports training anthem, driving rock guitars, snare rolls, 120 BPM',
  };
  const bgm = bgmMap[arc.type] || 'Epic cinematic trailer music, 120 BPM';

  return {
    scriptTextHindi: sanitizeHindiStoryText(hiText),
    scriptTextEnglish: enText,
    partSummary: buildFallbackSummary(seed, arc, partNumber),
    scenes,
    hookText: hook,
    bgmPrompt: bgm,
    patternInterrupts: normalizePatternInterrupts([], 48),
    visualCues: scenes.map((scene, index) => {
      const motion = index % 3 === 0 ? 'Crash Zoom' : index % 3 === 1 ? 'Slow Push-In' : 'Whip Pan';
      return `[${motion}][${scene.literalSearchTerm}]`;
    }),
    characterLock: `${seed.characterDescription}, blockbuster movie protagonist avatar, dramatic cinematic rim light`,
  };
}

function buildFallbackSummary(seed, arc, partNumber) {
  const effectivePartNumber = getEffectiveStoryPartNumber(partNumber);
  const summaries = {
    1: `${seed.protagonistHindi} faced a massive challenge with ${seed.threatEnglish} at ${seed.placeEnglish}. The ${seed.objectEnglish} was introduced. Tension escalated into a cinematic set-piece.`,
    2: `The stakes got higher as ${seed.threatEnglish} pushed them to the brink. ${seed.allyHindi} stood by ${seed.protagonistHindi} making a hard choice regarding the ${seed.objectEnglish}.`,
    3: `The final cinematic climax occurred. ${seed.protagonistHindi} faced ${seed.threatEnglish} directly, achieved victory, and walked away heroically with ${seed.allyHindi}.`,
  };
  return summaries[effectivePartNumber] || `Part ${partNumber} advanced the cinematic arc.`;
}

async function generateStoryPart(arc, subject, seed, partNumber, previousSummary, recoveryLog) {
  const prompt = buildPrompt(arc, subject, seed, partNumber, previousSummary);
  const maxAttempts = 3;
  const qualityTarget = Math.max(5, parseInt(process.env.STORY_MIN_QUALITY_SCORE || '12', 10) || 12);
  let bestCandidate = null;
  let bestScore = -1;
  let bestSource = null;

  const captureCandidate = (sourceLabel, parsed, detailLabel) => {
    if (!parsed) {
      return false;
    }
    const score = scoreStoryQuality(parsed);
    if (score > bestScore) {
      bestCandidate = parsed;
      bestScore = score;
      bestSource = sourceLabel;
    }
    if (score >= qualityTarget) {
      recoveryLog.push(`Story Part ${partNumber}: ${detailLabel} (quality score: ${score}).`);
      return true;
    }
    recoveryLog.push(`Story Part ${partNumber}: ${sourceLabel} quality score ${score} below target ${qualityTarget}.`);
    return false;
  };

  if (process.env.GEMINI_API_KEY) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        let attemptPrompt = prompt;
        if (attempt === 1) {
          attemptPrompt += '\n\nIMPORTANT: Your previous response was too short or failed validation. Write AT LEAST 130 Hindi words. Include AT LEAST 3 direct dialogue lines in quotation marks. Return ONLY valid JSON.';
        } else if (attempt === 2) {
          attemptPrompt += '\n\nCRITICAL RETRY: Previous attempts failed. You MUST write 140+ Hindi words. Include 3+ quoted dialogues. Return ONLY the JSON object, no markdown fences, no explanation.';
        }
        const useRelaxed = attempt >= 2;
        const parsed = parseStoryResponse(await callGeminiStory(attemptPrompt), { relaxed: useRelaxed });
        if (captureCandidate('Gemini', parsed, `generated by Gemini on attempt ${attempt + 1}`)) {
          return parsed;
        }
        if (!parsed) {
          recoveryLog.push(`Story Part ${partNumber}: Gemini attempt ${attempt + 1} response failed validation${attempt < maxAttempts - 1 ? ', retrying with stronger prompt' : ''}.`);
        }
      } catch (error) {
        recoveryLog.push(`Story Part ${partNumber}: Gemini failed - ${String(error && error.message ? error.message : error).slice(0, 140)}`);
      }
    }
  }

  if (process.env.OLLAMA_STORY_MODEL || process.env.OLLAMA_STORY_MODELS) {
    try {
      const parsed = parseStoryResponse(await callOllamaStory(prompt));
      if (captureCandidate('Ollama', parsed, 'generated by Ollama local model')) {
        return parsed;
      }
      if (!parsed) {
        recoveryLog.push(`Story Part ${partNumber}: Ollama response failed validation.`);
      }
    } catch (error) {
      recoveryLog.push(`Story Part ${partNumber}: Ollama failed - ${String(error && error.message ? error.message : error).slice(0, 140)}`);
    }
  }

  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const parsed = parseStoryResponse(await callDeepSeekStory(prompt));
      if (captureCandidate('DeepSeek', parsed, 'generated by DeepSeek')) {
        return parsed;
      }
      if (!parsed) {
        recoveryLog.push(`Story Part ${partNumber}: DeepSeek response failed validation.`);
      }
    } catch (error) {
      recoveryLog.push(`Story Part ${partNumber}: DeepSeek failed - ${String(error && error.message ? error.message : error).slice(0, 140)}`);
    }
  }

  if (process.env.TOGETHER_API_KEY) {
    try {
      const togetherResponse = await fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.TOGETHER_STORY_MODEL || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2048,
          temperature: 0.85,
        }),
        signal: AbortSignal.timeout(STORY_TIMEOUT_MS),
      });
      if (togetherResponse.ok) {
        const togetherData = await togetherResponse.json();
        const togetherText = togetherData && togetherData.choices && togetherData.choices[0] ? togetherData.choices[0].message.content : '';
        const parsed = parseStoryResponse(togetherText);
        if (captureCandidate('Together AI', parsed, 'generated by Together AI')) {
          return parsed;
        }
        if (!parsed) {
          recoveryLog.push(`Story Part ${partNumber}: Together AI response failed validation.`);
        }
      } else {
        recoveryLog.push(`Story Part ${partNumber}: Together AI HTTP ${togetherResponse.status}.`);
      }
    } catch (error) {
      recoveryLog.push(`Story Part ${partNumber}: Together AI failed - ${String(error && error.message ? error.message : error).slice(0, 140)}`);
    }
  }

  if (bestCandidate) {
    recoveryLog.push(`Story Part ${partNumber}: using best available ${bestSource} candidate (quality score: ${bestScore}) after all providers missed target ${qualityTarget}.`);
    return bestCandidate;
  }

  recoveryLog.push(`Story Part ${partNumber}: used rich deterministic Hindi fallback.`);
  return buildFallbackPart(seed, arc, partNumber);
}

function selectNewSeries(state, options = {}) {
  const recentSeries = new Set(
    (Array.isArray(options.recentSeriesTitles) && options.recentSeriesTitles.length
      ? options.recentSeriesTitles
      : getRecentStorySeriesTitles()
    ).map((title) => normalizeStorySeriesTitle(title))
  );
  const completed = new Set((state.completedSeries || []).map((item) => item && item.subject).filter(Boolean));
  const arcPriority = {
    mythological_revenge: 5,
    supernatural_thriller: 4,
    psychological_mystery: 3,
    scifi_horror: 2,
    crime_noir: 1,
  };
  const arcs = [...STORY_ARCS].sort((left, right) => {
    const scoreDelta = (arcPriority[right.type] || 0) - (arcPriority[left.type] || 0);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return Math.random() - 0.5;
  });
  for (const arc of arcs) {
    const fresh = arc.subjects.filter((subject) => !completed.has(subject) && !recentSeries.has(normalizeStorySeriesTitle(subject)));
    if (fresh.length) {
      const subject = pick(fresh);
      return { arc, subject, baseTitle: subject, startedAt: new Date().toISOString(), seed: createSeed(arc), partsCompleted: [], partSummaries: [], generatedParts: [] };
    }
  }
  for (const arc of arcs) {
    const notRecent = arc.subjects.filter((subject) => !recentSeries.has(normalizeStorySeriesTitle(subject)));
    if (notRecent.length) {
      const subject = pick(notRecent);
      return { arc, subject, baseTitle: subject, startedAt: new Date().toISOString(), seed: createSeed(arc), partsCompleted: [], partSummaries: [], generatedParts: [] };
    }
  }
  state.completedSeries = [];
  const arc = STORY_ARCS[0];
  return { arc, subject: arc.subjects[0], baseTitle: arc.subjects[0], startedAt: new Date().toISOString(), seed: createSeed(arc), partsCompleted: [], partSummaries: [], generatedParts: [] };
}

function getRecentStorySeriesTitles(days = 21) {
  return [...new Set(
    loadRecentPerformanceEntries({ days, uploadedOnly: true })
      .filter((entry) => entry && entry.contentKind === 'story' && entry.seriesTitle)
      .map((entry) => normalizeStorySeriesTitle(entry.seriesTitle))
      .filter(Boolean)
  )];
}

function buildPartTitle(baseTitle, partNumber) {
  if (partNumber === 1) return `${baseTitle} (Part 1)`;
  if (partNumber === STORY_PART_COUNT) return `${baseTitle} - Final Reveal (Part ${partNumber})`;
  return `${baseTitle} - The Truth (Part ${partNumber})`;
}

function getBgmMoodForPart(partNumber) {
  return 'story_calm';
}

function getStoryFollowOutro(partNumber) {
  if (partNumber < STORY_PART_COUNT) {
    return {
      hindi: '\u0905\u0917\u0932\u093e \u092d\u093e\u0917 \u0926\u0947\u0916\u0928\u0947 \u0915\u0947 \u0932\u093f\u090f \u091c\u0941\u095c\u0947 \u0930\u0939\u094b\u0964',
      english: buildStoryValuePromiseCta(partNumber),
    };
  }
  return {
    hindi: '\u090f\u0947\u0938\u0940 \u0914\u0930 \u0915\u0939\u093e\u0928\u093f\u092f\u094b\u0902 \u0915\u0947 \u0932\u093f\u090f \u091c\u0941\u095c\u0947 \u0930\u0939\u094b\u0964',
    english: buildStoryValuePromiseCta(3),
  };
}

function ensureStoryFollowOutro(part, partNumber) {
  const outro = getStoryFollowOutro(partNumber);
  const scenes = Array.isArray(part && part.scenes) ? part.scenes.map((scene) => ({ ...scene })) : [];
  if (scenes.length === 0) {
    return part;
  }

  const lastIndex = scenes.length - 1;
  const lastScene = { ...scenes[lastIndex] };
  const baseHindi = sanitizeHindiStoryText(String(lastScene.sentenceHindi || '').replace(/\s*à¤…à¤—à¤²à¤¾ à¤­à¤¾à¤— à¤¦à¥‡à¤–à¤¨à¥‡ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤?$/u, '').replace(/\s*à¤à¤¸à¥€ à¤”à¤° à¤•à¤¹à¤¾à¤¨à¤¿à¤¯à¥‹à¤‚ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤?$/u, '').trim());
  const baseEnglish = repairText(String(lastScene.sentenceEnglish || '').replace(/\s*Follow for[\s\S]*$/i, '').trim());
  lastScene.sentenceHindi = baseHindi ? `${baseHindi} ${outro.hindi}`.trim() : outro.hindi;
  lastScene.sentenceEnglish = baseEnglish ? `${baseEnglish} ${outro.english}`.trim() : outro.english;
  lastScene.sentence = lastScene.sentenceEnglish;
  scenes[lastIndex] = normalizeScene(lastScene, lastIndex);

  const scriptTextHindi = sanitizeHindiStoryText(String(part && part.scriptTextHindi ? part.scriptTextHindi : '').replace(/\s*à¤…à¤—à¤²à¤¾ à¤­à¤¾à¤— à¤¦à¥‡à¤–à¤¨à¥‡ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤?$/u, '').replace(/\s*à¤à¤¸à¥€ à¤”à¤° à¤•à¤¹à¤¾à¤¨à¤¿à¤¯à¥‹à¤‚ à¤•à¥‡ à¤²à¤¿à¤ à¤œà¥à¤¡à¤¼à¥‡ à¤°à¤¹à¥‹à¥¤?$/u, '').trim());
  const scriptTextEnglish = repairText(String(part && part.scriptTextEnglish ? part.scriptTextEnglish : '').replace(/\s*Follow for[\s\S]*$/i, '').trim());

  return {
    ...part,
    scenes,
    scriptText: `${scriptTextHindi} ${outro.hindi}`.trim(),
    scriptTextHindi: `${scriptTextHindi} ${outro.hindi}`.trim(),
    scriptTextEnglish: `${scriptTextEnglish} ${outro.english}`.trim(),
  };
}

async function ensureSeriesGenerated(series, recoveryLog) {
  if (series.seed == null) series.seed = createSeed(series.arc);
  // Ensure seed has sensory anchors
  if (!series.seed.sensoryHindi && series.arc.sensoryAnchors) {
    series.seed.sensoryHindi = pick(series.arc.sensoryAnchors);
    series.seed.sensoryEnglish = pick(series.arc.sensoryAnchorsEn);
  }
  if (Array.isArray(series.generatedParts) && series.generatedParts.length === STORY_PART_COUNT && series.generatedParts.every((part) => isValidStoryPart(part))) return series;
  const generatedParts = [];
  const partSummaries = [];
  for (let partNumber = 1; partNumber <= STORY_PART_COUNT; partNumber += 1) {
    const generated = await generateStoryPart(series.arc, series.subject, series.seed, partNumber, partSummaries.join('\n'), recoveryLog);
    const part = {
      topic: buildPartTitle(series.baseTitle, partNumber),
      scriptText: sanitizeHindiStoryText(generated.scriptTextHindi),
      scriptTextHindi: sanitizeHindiStoryText(generated.scriptTextHindi),
      scriptTextEnglish: romanizeStoryNames(generated.scriptTextEnglish),
      scenes: generated.scenes.map((scene, index) => normalizeScene(scene, index)),
      contentType: 'story',
      language: 'hi',
      storyPart: partNumber,
      seriesTitle: series.baseTitle,
      bgmMood: getBgmMoodForPart(partNumber),
      bgmPrompt: generated.bgmPrompt || null,
      hookText: generated.hookText || null,
      patternInterrupts: Array.isArray(generated.patternInterrupts) ? generated.patternInterrupts : [],
      visualCues: Array.isArray(generated.visualCues) ? generated.visualCues : [],
      narratorProfile: process.env.DEFAULT_HINDI_STORY_NARRATOR_PROFILE || 'owned-story-calm-v2',
      characterLock: generated.characterLock || (series.seed ? series.seed.characterDescription : null),
    };
    console.log(`[TELEMETRY] generateStoryPack: Prepared part ${partNumber} with lang=${part.language} type=${part.contentType}`);

    const finalizedPart = compactStoryPart(ensureStoryFollowOutro(compactStoryPart(part), partNumber));
    if (!isValidStoryPart(finalizedPart)) {
      throw new Error(`Story engine generated invalid part ${partNumber}: ${getStoryPartValidationIssues(finalizedPart).join('; ')}`);
    }
    generatedParts.push(finalizedPart);
    // Use specific summary from generation, not generic
    const summary = generated.partSummary || buildFallbackSummary(series.seed, series.arc, partNumber);
    partSummaries.push(summary);
  }
  series.generatedParts = generatedParts;
  series.partSummaries = partSummaries.map((summary, index) => `Part ${index + 1}: ${summary}`);
  return series;
}

async function getNextStoryPart(recoveryLog = []) {
  const state = loadState();
  if (!state.currentSeries || state.currentSeries.partsCompleted.length >= STORY_PART_COUNT) {
    if (state.currentSeries && state.currentSeries.subject) state.completedSeries.push({ subject: state.currentSeries.subject, completedAt: new Date().toISOString() });
    state.currentSeries = selectNewSeries(state);
    console.log(`   New Hindi story series: "${state.currentSeries.baseTitle}"`);
  }
  state.currentSeries = await ensureSeriesGenerated(state.currentSeries, recoveryLog);
  const partNumber = state.currentSeries.partsCompleted.length + 1;
  const storyPart = state.currentSeries.generatedParts[partNumber - 1];
  if (!storyPart || !isValidStoryPart(storyPart)) throw new Error('Story engine could not prepare a valid story part.');
  state.currentSeries.partsCompleted.push(partNumber);
  saveState(state);
  return repairValue({
    topic: storyPart.topic,
    scriptText: storyPart.scriptTextHindi,
    scriptTextHindi: storyPart.scriptTextHindi,
    scriptTextEnglish: storyPart.scriptTextEnglish,
    scenes: storyPart.scenes,
    contentType: 'story',
    language: 'hi',
    storyPart: partNumber,
    seriesTitle: state.currentSeries.baseTitle,
    bgmMood: storyPart.bgmMood,
    bgmPrompt: storyPart.bgmPrompt || null,
    hookText: storyPart.hookText || null,
    patternInterrupts: Array.isArray(storyPart.patternInterrupts) ? storyPart.patternInterrupts : [],
    visualCues: Array.isArray(storyPart.visualCues) ? storyPart.visualCues : [],
    narratorProfile: storyPart.narratorProfile || process.env.DEFAULT_HINDI_STORY_NARRATOR_PROFILE || 'owned-story-calm-v2',
    characterLock: storyPart.characterLock || (state.currentSeries.seed ? state.currentSeries.seed.characterDescription : null),
  });
}

async function generateFreshStoryPack(recoveryLog = [], options = {}) {
  const state = loadState();
  const recentSeriesTitles = Array.isArray(options.recentSeriesTitles) && options.recentSeriesTitles.length
    ? options.recentSeriesTitles
    : getRecentStorySeriesTitles();
  const series = await ensureSeriesGenerated(selectNewSeries(state, { recentSeriesTitles }), recoveryLog);
  return repairValue({
    seriesTitle: series.baseTitle,
    storyVideos: series.generatedParts.map((storyPart, index) => ({
      topic: storyPart.topic,
      scriptText: storyPart.scriptTextHindi,
      scriptTextHindi: storyPart.scriptTextHindi,
      scriptTextEnglish: storyPart.scriptTextEnglish,
      scenes: storyPart.scenes,
      contentType: 'story',
      language: 'hi',
      storyPart: index + 1,
      seriesTitle: series.baseTitle,
      bgmMood: storyPart.bgmMood,
      bgmPrompt: storyPart.bgmPrompt || null,
      hookText: storyPart.hookText || null,
      patternInterrupts: Array.isArray(storyPart.patternInterrupts) ? storyPart.patternInterrupts : [],
      visualCues: Array.isArray(storyPart.visualCues) ? storyPart.visualCues : [],
      narratorProfile: storyPart.narratorProfile || process.env.DEFAULT_HINDI_STORY_NARRATOR_PROFILE || 'owned-story-calm-v2',
      characterLock: storyPart.characterLock || (series.seed ? series.seed.characterDescription : null),
    })),
  });
}

module.exports = {
  getNextStoryPart,
  generateFreshStoryPack,
  loadState,
  saveState,
  __test: {
    scoreStoryQuality,
    isValidStoryPart,
    getStoryPartValidationIssues,
  },
};

