const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const resp = await page.goto('http://localhost:3000/video-creator', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 2500));
  const url = page.url();
  const title = await page.title();
  const isLogin = /sign-in|login|clerk/i.test(url) || await page.$('input[name="identifier"]') !== null;
  const themeBtns = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('button svg.lucide-sun, button svg.lucide-moon'));
    return svgs.length;
  });
  await page.screenshot({ path: '_vc-shot.png' });
  console.log(JSON.stringify({ status: resp.status(), finalUrl: url, title, isLogin, themeToggleButtons: themeBtns }, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
