const puppeteer = require('./src/utils/puppeteerPool');
const fs = require('fs');

async function testVideo() {
  const browser = await puppeteer.acquire();
  const page = await browser.newPage();
  try {
    const url = 'https://gogoanime.by/sousou-no-frieren-2nd-season-episode-1-english-subbed/';
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const html = await page.evaluate(() => document.body.innerHTML);
    fs.writeFileSync('C:/Users/chuchi/Desktop/Repositories/kaizoku/kaizoku-server/video.html', html);
    console.log("Video dumped to video.html");
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
testVideo();
