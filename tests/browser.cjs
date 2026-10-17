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
 if(process.env.GEX_TEST_VIEWER_TOKEN) {
   await page.locator('#access-overlay').waitFor({state:'visible'});
   await page.locator('#access-token').fill(process.env.GEX_TEST_VIEWER_TOKEN);
   await page.locator('#access-form button').click();
 }

 await page.waitForFunction(()=>window.state?.profile?.strikes?.length>0);
 assert.match(await page.locator('#feed-warning').innerText(),/DÉMONSTRATION/);
 await page.locator('#filters [data-f="0dte"]').click();
 await page.waitForFunction(()=>window.state.filter==='0dte' && window.state.dataStatus?.available);
 assert.equal(await page.locator('#expiry-empty').isVisible(),false);
 assert((await page.locator('#filter-summary').innerText()).includes('62 séries'));
 // Exercise real rendering with an empty response; no silent ALL fallback.
 await page.route('**/api/gex/SPX?filter=0dte*',async route=>{
   const response=await route.fetch();const data=await response.json();
   Object.assign(data,{available:false,strikes:[],net_gex:[],call_gex:[],put_gex:[],call_oi:[],put_oi:[],regime:'unavailable',gamma_flip:null,zero_gex:null,call_wall:null,put_wall:null,walls:{call:[],put:[],flip:null,pain:null}});
   Object.assign(data.meta,{available:false,filtered_contracts:0,filtered_oi:0});
   await route.fulfill({json:data});
 });
 await page.evaluate(()=>{closeWS();return loadGex();});
 assert(await page.locator('#expiry-empty').isVisible());
 assert.match(await page.locator('#hero-regime').innerText(),/INDISPONIBLE/);
 assert.equal(await page.evaluate(()=>state.filter),'0dte');
 await page.locator('#expiry-show-all').click();
 await page.waitForFunction(()=>state.filter==='all' && state.dataStatus?.available);
 await page.evaluate(()=>{setMode('STALE');});
 assert.match(await page.locator('#feed-warning').innerText(),/FLUX INTERROMPU/);
 await page.evaluate(()=>computeSession([{time:Date.now()/1000,open:1,high:1,low:1,close:1,volume:0}]));
 assert.equal(await page.evaluate(()=>state.sess),null);
 // Verify session boundaries without waiting for a real trading day.
 assert.equal(await page.evaluate(()=>sessionBars([
 {time:Date.parse('2026-10-15T23:00:00Z')/1000,volume:10},
 {time:Date.parse('2026-10-16T14:00:00Z')/1000,volume:10}], 'ES', 'eth').length),2);
 assert.equal(await page.evaluate(()=>sessionBars([
 {time:Date.parse('2026-10-15T14:00:00Z')/1000,volume:10},
 {time:Date.parse('2026-10-16T14:00:00Z')/1000,volume:10}], 'SPX', 'rth').length),1);
 await page.locator('#settings-btn').click();
 assert(await page.locator('#admin-token').isVisible());
 await page.locator('#admin-token').fill('wrong-token');
 await page.locator('#admin-token').dispatchEvent('change');
 await page.waitForFunction(()=>document.getElementById('rs-msg').textContent.includes('verrouillée'));
 await page.locator('#modal-close').click();
 await page.locator('#scen-toggle').click();
 await page.locator('#sc-time').evaluate(el=>{el.value='120';});
 await page.locator('#sc-time').dispatchEvent('input');
 await page.waitForFunction(()=>document.getElementById('sc-time-v').textContent==='+120 min');
 await page.waitForFunction(()=>document.getElementById('sc-out').textContent.includes('ZERO-GEX'));
 await page.locator('#sc-close').click();
 await page.locator('[data-p="research"]').click();
 await page.waitForFunction(()=>document.getElementById('opt-status').textContent.includes('Aucun fournisseur'));
 await page.waitForFunction(()=>document.getElementById('risk-sensitivities').textContent.includes('Vanna'));
 await page.screenshot({path:'.cache/ui/reliability-desktop.png'});
 await page.locator('[data-p="validation"]').click();
 await page.waitForFunction(()=>document.getElementById('diagnostics-state').textContent.includes('NON SIGNÉE'));
 await page.locator('#bt-run').click();
 await page.waitForFunction(()=>document.getElementById('backtest-result').textContent.includes('Choisir ES'));
 await page.setViewportSize({width:1024,height:900});
 assert(await page.locator('#filters').isVisible());
 assert.equal(errors.length,0,errors.join('\n'));
 console.log('Browser: viewer login, full/empty synthetic 0DTE, ALL recovery, stale warning, zero-volume VWAP, sessions, admin lock, research, validation and responsive controls passed.');
 await browser.close();
})().catch(async e=>{console.error(e); if(launchedBrowser) await launchedBrowser.close(); process.exitCode=1;});
