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


 await page.route('**/api/history/**',async route=>{
   const url=new URL(route.request().url()),iv=url.searchParams.get('interval'),symbol=url.pathname.split('/').at(-1);
   if(symbol==='QQQ'){await route.fulfill({status:503,json:{error:'offline'}});return;}
   const step=({'1m':60,'5m':300,'15m':900,'30m':1800,'1h':3600})[iv]||300;
   const start=Date.parse('2026-10-12T00:00:00Z')/1000,spot=symbol==='BTC'?100000:6000;
   const bars=Array.from({length:Math.floor(8*86400/step)},(_,i)=>{const close=spot+Math.sin(i/15)*5;return {time:start+i*step,open:close-.2,high:close+1,low:close-1,close,volume:i%7===0?0:100+i%30};});
   await route.fulfill({json:{symbol,interval:iv,bars}});
 });
 await page.goto('http://127.0.0.1:8010');
 await page.waitForFunction(()=>window.marketIndicators?.getState().rows>0&&state.bars.size>0);
 await page.locator('#indicators-open').click();
 assert(await page.locator('#indicator-dialog').isVisible());
 await page.selectOption('#ind-vp-period','weekly');
 await page.selectOption('#ind-vp-session','day');
 await page.selectOption('#ind-vp-history','three');
 await page.locator('#ind-vp-rows').fill('24');await page.locator('#ind-vp-rows').dispatchEvent('change');
 assert.equal(await page.evaluate(()=>marketIndicators.getState().options.vp.rows),24);
 assert.equal(await page.evaluate(()=>marketIndicators.getState().profiles.length),2);
 await page.selectOption('#ind-vwap-period','monthly');
 await page.selectOption('#ind-vwap-session','day');
 await page.selectOption('#ind-vwap-bands','percent');
 await page.locator('#ind-vwap-percent').fill('0.5');await page.locator('#ind-vwap-percent').dispatchEvent('change');
 await page.locator('#ind-vwap-bandCount').fill('3');await page.locator('#ind-vwap-bandCount').dispatchEvent('change');
 await page.selectOption('#ind-base','15m');
 await page.waitForFunction(()=>marketIndicators.getState().context==='SPX|15m'&&marketIndicators.getState().rows>0);
 assert.equal(await page.evaluate(()=>marketIndicators.latestVWAP(true)),null); // Fixture points are future-dated: never alert on them.
 const before=await page.evaluate(()=>({value:marketIndicators.getState().curves.at(-1).points.at(-1).value,rows:marketIndicators.getState().rows}));
 await page.waitForTimeout(400);await page.screenshot({path:'.cache/ui/indicators-settings.png',timeout:15000});
 await page.locator('#indicator-dialog .dialog-close').click();
 await page.locator('#intervals [data-iv="30m"]').click();await page.waitForFunction(()=>state.interval==='30m');
 assert.deepEqual(await page.evaluate(()=>({value:marketIndicators.getState().curves.at(-1).points.at(-1).value,rows:marketIndicators.getState().rows})),before);
 await page.locator('#indicators-open').click();await page.locator('[data-anchor="vwap"]').click();
 await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>marketIndicators.getState().options.vwap.period),'monthly');
 await page.locator('#indicators-open').click();await page.locator('[data-anchor="vwap"]').click();
 assert.match(await page.locator('#indicator-summary').innerText(),/Choisir le départ/);
 const chartBounds=await page.locator('#chart').boundingBox();
 await page.mouse.click(chartBounds.x+chartBounds.width*.55,chartBounds.y+chartBounds.height*.4);
 await page.waitForFunction(()=>marketIndicators.getState().options.vwap.anchor>0);
 const anchor=await page.evaluate(()=>marketIndicators.getState().options.vwap.anchor);
 await page.reload();await page.waitForFunction(()=>window.marketIndicators?.getState().rows>0&&state.bars.size>0);
 assert.equal(await page.evaluate(()=>marketIndicators.getState().options.vwap.anchor),anchor);
 assert.equal(await page.evaluate(()=>marketIndicators.getState().options.vp.rows),24);
 await page.locator('#tabs [data-sym="BTC"]').click();
 await page.waitForFunction(()=>marketIndicators.getState().context==='BTC|15m'&&marketIndicators.getState().rows>0);
 assert.equal(await page.evaluate(()=>marketIndicators.getState().options.vwap.anchor),null);
 await page.locator('#indicators-open').click();
 await page.selectOption('#ind-vwap-period','daily');await page.selectOption('#ind-vp-period','daily');await page.selectOption('#ind-vp-history','current');
 await page.locator('#indicator-dialog .dialog-close').click();
 await page.waitForTimeout(1000);await page.screenshot({path:'.cache/ui/indicators-desktop.png'});
 // Zero volume never produces a price/VP; a failed source clears prior results.
 await page.evaluate(()=>{closeWS();});
 await page.route('**/api/history/BTC?*',route=>route.fulfill({json:{bars:[{time:1792411200,open:100,high:101,low:99,close:100,volume:0}]}}));
 await page.evaluate(()=>marketIndicators.refresh());
 assert.equal(await page.evaluate(()=>marketIndicators.getState().profiles.length),0);
 assert.equal(await page.evaluate(()=>marketIndicators.getState().curves.length),0);
 assert.equal(await page.evaluate(()=>marketIndicators.latestVWAP()),null);
 await page.route('**/api/history/BTC?*',route=>route.fulfill({status:503,json:{error:'offline'}}));
 await page.evaluate(()=>marketIndicators.refresh());
 assert.match(await page.locator('#indicator-summary').innerText(),/Source indisponible/);
 assert.equal(await page.evaluate(()=>marketIndicators.getState().rows),0);
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 await page.locator('#indicators-open').click();assert(await page.locator('#indicator-dialog').isVisible());
 assert(await page.evaluate(()=>document.querySelector('#indicator-dialog').scrollWidth<=document.querySelector('#indicator-dialog').clientWidth+1));
 await page.screenshot({path:'.cache/ui/indicators-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);await browser.close();
 console.log('Indicators UI: period/VA/bands settings, fixed calculation base across chart intervals, real chart anchor click, persistence, symbol isolation, zero volume, source failure and mobile passed.');
})().catch(async e=>{console.error(e);if(launchedBrowser)await launchedBrowser.close();process.exitCode=1;});
