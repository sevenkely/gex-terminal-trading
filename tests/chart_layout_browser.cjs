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
 await page.goto('http://127.0.0.1:8010');

 await page.waitForFunction(()=>window.state?.bars.size>0);
 console.log(await page.evaluate(()=>Object.fromEntries(['topbar','tape','workspace-bar','chart-toolbar','data-toolbar','feed-warning','chart-area','flow-inspector'].map(id=>[id,Math.round(document.getElementById(id).getBoundingClientRect().height)]))));
 await page.screenshot({path:'.cache/ui/final-essential-desktop.png'});
 assert(await page.locator('#context-levels').isVisible());
 assert.equal(await page.evaluate(()=>state.lines.cw0.options().title),'Call Wall 1');
 assert.equal(await page.locator('#legend-lines').isVisible(),false);
 assert.equal(await page.locator('#sb-tabs').isVisible(),false);
 assert(await page.locator('#essential-context').isVisible());
 await page.locator('#cockpit-detail').click();assert(await page.locator('#sb-tabs').isVisible());
 await page.locator('#cockpit-detail').click();
 await page.locator('#price-reset').click();assert.equal(await page.evaluate(()=>state.fit),false);
 await page.locator('#price-fullscreen').click();assert(await page.locator('body').evaluate(el=>el.classList.contains('zen')));
 await page.locator('#price-fullscreen').click();assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('zen')),false);
 await page.locator('#inspection-open').click();assert(await page.locator('#inspection-dialog').isVisible());
 await page.locator('#inspection-dialog .dialog-close').click();
 await page.locator('#intervals [data-iv="15m"]').click();
 await page.waitForFunction(()=>state.interval==='15m'&&localStorage.getItem('gex.chart.interval')==='15m');
 await page.reload();await page.waitForFunction(()=>window.state?.bars.size>0);
 assert.equal(await page.evaluate(()=>state.interval),'15m');
 assert(await page.locator('body').evaluate(el=>el.classList.contains('essential')));
 for(const viewport of [{width:1366,height:768},{width:1024,height:900},{width:390,height:844}]){
   await page.setViewportSize(viewport);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
   await page.waitForTimeout(150);const bounds=await page.locator('#chart-area').boundingBox();console.log(viewport,bounds.height);assert(bounds.height>=330);
   await page.screenshot({path:'.cache/ui/final-essential-'+viewport.width+'.png',fullPage:true});
 }
 assert.deepEqual(errors,[]);await browser.close();console.log('Chart-first layout passed.');
})().catch(async e=>{console.error(e);if(launchedBrowser)await launchedBrowser.close();process.exitCode=1;});
