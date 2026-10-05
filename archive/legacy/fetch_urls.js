require('dotenv').config();
const fetch = require('node-fetch');

async function getUrl(query) {
    const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=1`, {
        headers: { Authorization: process.env.PEXELS_API_KEY }
    });
    const data = await res.json();
    if (data.videos && data.videos.length > 0) {
        const video = data.videos[0];
        const file = video.video_files.find(f => f.quality === 'hd') || video.video_files[0];
        return file.link;
    }
    return null;
}

async function run() {
    const urls = [
        await getUrl('pizza baking'),
        await getUrl('pizza slice'),
        await getUrl('corporate office'),
        await getUrl('stock market chart'),
        await getUrl('business presentation')
    ];
    console.log(JSON.stringify(urls, null, 2));
}

run();
