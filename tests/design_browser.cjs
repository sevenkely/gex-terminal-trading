/* Offline fixture UI integration checks. npm install --prefix .cache/ui playwright @sparticuz/chromium */
const assert = require('node:assert/strict');
const {chromium: pw} = require('../.cache/ui/node_modules/playwright');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const {execFileSync} = require('node:child_process');
let launchedBrowser;

(async()=>{
 const {default: chromium} = await import('../.cache/ui/node_modules/@sparticuz/chromium/build/index.js');
 const cache = path.resolve(__dirname, '../.cache/ui');
 const lib = path.join(cache, 'al2023/lib');
 if (!fs.existsSync(path.join(lib, 'libnss3.so'))) {
   fs.mkdirSync(path.join(cache, 'al2023'), {recursive:true});
   const tar = path.join(cache, 'al2023.tar');
   fs.writeFileSync(tar, zlib.brotliDecompressSync(fs.readFileSync(path.join(cache, 'node_modules/@sparticuz/chromium/bin/al2023.tar.br'))));
   execFileSync('tar', ['xf', tar, '-C', path.join(cache,'al2023')]);
 }
 const browser=await pw.launch({args:chromium.args, executablePath:await chromium.executablePath(),headless:true,
   env:{...process.env, LD_LIBRARY_PATH:[lib,process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}});
 launchedBrowser=browser;

 const page=await browser.newPage({locale:"fr-FR",viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror', e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('gex.tour','1'));

 await page.route('**/api/symbols',async route=>{
   const response=await route.fetch(),rows=await response.json();
   const lookup=Object.fromEntries(rows.map(row=>[row.symbol,row]));
   const extra={ES:7764.25,QQQ:707.87,NQ:29392,GLD:381.45,GC:4181.10};
   const result=['SPX','ES','SPY','QQQ','NQ','GLD','GC','BTC'].map(symbol=>lookup[symbol]||{...lookup.SPX,symbol,price:extra[symbol]});
   await route.fulfill({json:result});
 });
 await page.goto('http://127.0.0.1:8010');
 await page.waitForFunction(()=>window.state?.bars.size>0&&document.querySelectorAll('.instrument-mark').length===8);
 await page.waitForFunction(()=>[...document.querySelectorAll('.instrument-mark')].every(img=>img.complete&&img.naturalWidth>0));
 assert(await page.locator('#tabs button').evaluateAll(tabs=>tabs.every(tab=>{
   const image=tab.querySelector('img').getBoundingClientRect(),symbol=tab.querySelector('.t-sym').getBoundingClientRect();
   return image.right<=symbol.left+1;
 })));
 assert.equal(await page.locator('#tape').isVisible(),false);
 assert.equal(await page.locator('#tape-control').isVisible(),false);
 assert.equal(await page.locator('#motion-level').inputValue(),'rich');
 assert.equal(await page.evaluate(()=>document.body.dataset.motion),'rich');
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('#tabs button.active')).animationName.includes('studio-breathe'));
 await page.locator('#tabs [data-sym="BTC"]').click();
 await page.waitForFunction(()=>state.symbol==='BTC'&&state.bars.size>0&&document.querySelector('#hero-instrument-mark')?.src.includes('bitcoin'));
 await page.waitForFunction(()=>document.querySelector('#essential-gex').textContent!=='—');
 // Capture only after entrance animations have settled, not their first frame.
 await page.waitForTimeout(800);
 await page.screenshot({path:'.cache/ui/design-studio-desktop.png'});
 await page.locator('#cockpit-detail').click();
 await page.waitForTimeout(500);
 await page.screenshot({path:'.cache/ui/design-studio-detailed.png'});
 await page.locator('#cockpit-detail').click();
 await page.selectOption('#motion-level','calm');assert.equal(await page.evaluate(()=>document.body.dataset.motion),'calm');
 await page.selectOption('#motion-level','off');
 assert.equal(await page.locator('.logo svg').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.reload();await page.waitForFunction(()=>window.state?.bars.size>0);
 assert.equal(await page.locator('#motion-level').inputValue(),'off');
 await page.selectOption('#motion-level','rich');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>document.body.dataset.motion==='off');
 assert.equal(await page.locator('.logo svg').evaluate(el=>getComputedStyle(el).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.waitForFunction(()=>document.body.dataset.motion==='rich');
 for(const viewport of [{width:1366,height:768},{width:1024,height:900},{width:390,height:844}]){
   await page.setViewportSize(viewport);await page.waitForTimeout(200);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
   assert((await page.locator('#chart-area').boundingBox()).height>=330);
 }
 await page.screenshot({path:'.cache/ui/design-studio-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);await browser.close();
 console.log('Design studio: 8 local identity marks, removed ticker, rich/calm/off motion, preference persistence, reduced-motion and responsive views passed.');
})().catch(async e=>{console.error(e);if(launchedBrowser)await launchedBrowser.close();process.exitCode=1;});
