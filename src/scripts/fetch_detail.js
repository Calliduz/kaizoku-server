const puppeteer = require("../utils/puppeteerPool");
const fs = require("fs");

async function testDetail() {
  const browser = await puppeteer.acquire();
  const page = await browser.newPage();
  try {
    const url = "https://gogoanime.by/series/sousou-no-frieren-2nd-season-eng/";
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const html = await page.evaluate(() => document.body.innerHTML);
    fs.writeFileSync(
      "C:/Users/chuchi/Desktop/Repositories/kaizoku/kaizoku-server/detail.html",
      html,
    );
    console.log("Detail dumped to detail.html");
  } catch (e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

testDetail();
