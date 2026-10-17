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


 const page=await browser.newPage({locale:'fr-FR',viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('gex.tour','1'));
 await page.goto('http://127.0.0.1:8010');
 await page.waitForFunction(()=>window.state?.bars.size>0&&state.ws?.readyState===1);
 await page.evaluate(async()=>{
   closeWS();stopFlowPoll();stopFlowBarsPoll();state.interval='5m';await loadHistory();
   state.flowBars=state.histArr.map((b,i)=>({t:b.time,big_n:i%3+1,big_total:1000+i*10,
     big_buy:600+i*10,big_sell:400,big_unknown:0,abs_n:2,abs_buy:3000,abs_sell:i%2?2000:0,delta:100}));
   state.flowBarsUnit='USD';state.flowBarsContext=flowContext();state.flowCoverageStart=state.flowBars[0].t;
   setBubbles(true);state.chart.timeScale().setVisibleLogicalRange({from:-2,to:62});
 });
 await page.waitForFunction(()=>flowClusters().cells.length>=50);
 const markers=await page.evaluate(()=>{
   // Capture actual canvas labels: absorption never silently disappears on small bubbles.
   const ctx=$('flow-canvas').getContext('2d'),original=ctx.fillText.bind(ctx),labels=[];
   ctx.fillText=(text,...args)=>{labels.push(String(text));original(text,...args);};flowRender();ctx.fillText=original;
   return {cells:flowClusters().cells.length,hits:state.flowHits.length,labels,
     counts:[...new Set(state.flowHits.map(h=>h.cell.t))].map(t=>state.flowHits.filter(h=>h.cell.t===t).length)};
 });
 assert.equal(markers.cells,60);assert.equal(markers.hits,120);assert(markers.counts.every(n=>n===2));
 assert.equal(markers.labels.filter(t=>t.startsWith('A ')).length,60);
 assert(markers.labels.some(t=>t.startsWith('A ')&&t.includes('×2')));
 // Historical candle still exists after zooming away from the recent tape.
 await page.evaluate(()=>state.chart.timeScale().setVisibleLogicalRange({from:0,to:15}));
 assert((await page.evaluate(()=>flowClusters().cells.length))>=15);
 await page.evaluate(()=>state.chart.timeScale().setVisibleLogicalRange({from:-2,to:62}));
 // Big and absorption amounts are not added, scaled together or subtracted in tooltips.
 const hit=await page.evaluate(()=>{flowRender();const h=state.flowHits.find(h=>h.cell.absBuy===3000&&h.w);const r=$('chart-area').getBoundingClientRect();return{x:r.left+h.x,y:r.top+h.y};});
 await page.mouse.move(hit.x,hit.y);
 await page.waitForFunction(()=>!$('flow-tip').hidden);
 assert.match(await page.locator('#flow-tip').innerText(),/épisodes/);
 assert(!/NaN|undefined/.test(await page.locator('#flow-tip').innerText()));
 const styles=await page.evaluate(()=>{
   const bar=state.histArr[0];absorptionStyle.mode='border';let border=decorateFlowBar(bar);
   absorptionStyle.mode='body';let body=decorateFlowBar(bar);
   absorptionStyle.mode='marker';let marker=decorateFlowBar(bar);
   absorptionStyle.mode='border';recolorFlowCandles();return{border,body,marker,up:state.colors.up,buy:absorptionStyle.buy};
 });
 assert.equal(styles.border.color,styles.up);assert.notEqual(styles.border.borderColor,styles.up);
 assert.notEqual(styles.body.color,styles.up);assert.equal(styles.marker.borderColor,styles.up);
 await page.locator('#abs-settings summary').click();
 await page.locator('#abs-buy').evaluate(el=>{el.value='#00aaff';el.dispatchEvent(new Event('input'));});
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('gex.absorption')).buy),'#00aaff');
 await page.locator('#abs-settings summary').click();
 // Stale source/interval rows cannot leak to the new chart.
 assert.equal(await page.evaluate(()=>{const old=state.flowBarsContext;state.flowBarsContext='OTHER|1m|options';const n=flowClusters().cells.length;state.flowBarsContext=old;return n;}),0);
 // Draw using real pointer events, then translate horizontally AND vertically.
 const rect=await page.locator('#draw-canvas').boundingBox();
 await page.locator('#draw-bar [data-tool="rect"]').click();
 await page.mouse.move(rect.x+220,rect.y+180);await page.mouse.down();
 await page.mouse.move(rect.x+420,rect.y+300,{steps:8});await page.mouse.up();
 assert.equal(await page.evaluate(()=>draw.shapes.length),1);
 assert.equal(await page.evaluate(()=>draw.sel),0);
 const before=await page.evaluate(()=>structuredClone(draw.shapes[0]));
 const mid=await page.evaluate(()=>{const p=shapePts(draw.shapes[0]),r=$('draw-canvas').getBoundingClientRect();return{x:r.left+(p[0].x+p[1].x)/2,y:r.top+(p[0].y+p[1].y)/2};});
 await page.mouse.move(mid.x,mid.y);await page.mouse.down();await page.mouse.move(mid.x+60,mid.y+35,{steps:6});await page.mouse.up();
 const moved=await page.evaluate(()=>structuredClone(draw.shapes[0]));
 assert.notEqual(moved.pts[0].t,before.pts[0].t);assert.notEqual(moved.pts[0].p,before.pts[0].p);
 await page.locator('#draw-undo').click();assert.deepEqual(await page.evaluate(()=>draw.shapes[0]),before);
 await page.locator('#draw-redo').click();assert.deepEqual(await page.evaluate(()=>draw.shapes[0]),moved);
 // Reselect without changing a point, modify width/style/fill/opacity and undo style.
 await page.mouse.click(mid.x+60,mid.y+35);
 await page.selectOption('#draw-width','6');await page.selectOption('#draw-dash','dashed');await page.selectOption('#draw-fill','50');
 await page.locator('#draw-opacity').evaluate(el=>{el.value=55;el.dispatchEvent(new Event('input'));});
 assert.equal(await page.evaluate(()=>draw.shapes[0].opacity),.55);
 await page.locator('#draw-undo').click();assert.equal(await page.evaluate(()=>draw.shapes[0].opacity),1);
 await page.locator('#draw-redo').click();
 await page.mouse.click(mid.x+60,mid.y+35);
 // Locked shapes stay selectable, but cannot be moved/deleted/cleared.
 await page.locator('#draw-lock').click();assert(await page.locator('#draw-del').isDisabled());
 const locked=await page.evaluate(()=>structuredClone(draw.shapes[0]));
 await page.mouse.move(mid.x+60,mid.y+35);await page.mouse.down();await page.mouse.move(mid.x+90,mid.y+55);await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>draw.shapes[0]),locked);
 await page.locator('#draw-clear').click();assert.equal(await page.evaluate(()=>draw.shapes.length),1);
 await page.mouse.click(mid.x+60,mid.y+35);await page.locator('#draw-lock').click();
 await page.locator('#draw-dup').click();assert.equal(await page.evaluate(()=>draw.shapes.length),2);
 await page.locator('#draw-del').click();assert.equal(await page.evaluate(()=>draw.shapes.length),1);
 await page.locator('#draw-undo').click();assert.equal(await page.evaluate(()=>draw.shapes.length),2);
 // Endpoint handles are individually editable; not whole-shape movement.
 await page.evaluate(()=>{draw.sel=0;drawOptsSync();queueDraw();});
 const handle=await page.evaluate(()=>{const p=shapePts(draw.shapes[0])[0],r=$('draw-canvas').getBoundingClientRect();return{x:r.left+p.x,y:r.top+p.y};});
 const oldEnd=await page.evaluate(()=>structuredClone(draw.shapes[0].pts[1]));
 await page.mouse.move(handle.x,handle.y);await page.mouse.down();await page.mouse.move(handle.x+15,handle.y-20,{steps:4});await page.mouse.up();
 assert.deepEqual(await page.evaluate(()=>draw.shapes[0].pts[1]),oldEnd);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('gex.draw.SPX')).length),2);
 // Annotations remain in time/price coordinates across interval and symbol changes.
 const persisted=await page.evaluate(()=>localStorage.getItem('gex.draw.SPX'));
 await page.evaluate(()=>{state.symbol='SPY';drawLoad();});assert.equal(await page.evaluate(()=>draw.shapes.length),0);
 await page.evaluate(()=>{state.symbol='SPX';drawLoad();});assert.equal(await page.evaluate(()=>JSON.stringify(draw.shapes)),persisted);
 await page.evaluate(()=>{state.interval='15m';});
 assert.equal(await page.evaluate(()=>JSON.stringify(draw.shapes)),persisted);
 await page.evaluate(()=>{state.interval='5m';draw.sel=-1;drawOptsSync();setDrawTool('none');queueDraw();queueFlow();});
 assert.match(await page.locator('#legend-lines').innerText(),/Call Wall/);
 await page.locator('#abs-settings summary').click();await page.locator('#flow-read').click();
 await page.screenshot({path:'.cache/ui/flow-draw-desktop.png'});
 await page.setViewportSize({width:390,height:844});
 await page.locator('#abs-settings summary').click();
 assert(await page.locator('#abs-buy').isVisible());
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'.cache/ui/flow-draw-mobile.png'});
 assert.deepEqual(errors,[]);
 await browser.close();
 console.log('Flow/draw UI: 60 historical candles, 120 separate markers, numeric absorption, colors, isolation, time+price drag, handles, styles, lock, duplicate/delete, undo/redo, persistence, mobile passed.');
})().catch(async e=>{console.error(e);if(launchedBrowser)await launchedBrowser.close();process.exitCode=1;});
