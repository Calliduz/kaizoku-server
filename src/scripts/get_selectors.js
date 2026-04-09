const puppeteerPool = require('../utils/puppeteerPool');

async function testSelectors() {
  const browser = await puppeteerPool.acquire();
  const page = await browser.newPage();
  try {
    await page.goto('https://gogoanime.by/search.html?keyword=naruto', { waitUntil: 'domcontentloaded' });
    
    // Dump outer HTML of the body
    const fullHtml = await page.evaluate(() => document.body.innerHTML);
    require('fs').writeFileSync('C:/Users/chuchi/Desktop/Repositories/kaizoku/kaizoku-server/src/scripts/dump.html', fullHtml);
    console.log("HTML Dumped to src/scripts/dump.html");
    
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

testSelectors();
