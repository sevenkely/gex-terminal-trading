/* Offline fixture UI integration checks. npm install --prefix .cache/ui playwright @sparticuz/chromium */
const assert = require('node:assert/strict');
const {launchBrowser,waitForFixture}=require('./browser_helpers.cjs');
let launchedBrowser;

(async()=>{
 const browser=await launchBrowser();launchedBrowser=browser;


 const page=await browser.newPage({locale:"fr-FR",viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror', e=>errors.push(e.message));


 const base=process.env.GEX_REACT_URL||'http://127.0.0.1:8010/react/';
 await waitForFixture(base);
 assert.equal((await (await page.request.get(new URL('/api/health',base).href)).json()).demo,true,'Run the isolated ui_fixture, never the market server.');
 const bars=(await (await page.request.get(new URL('/api/history/BTC?interval=5m',base).href)).json()).bars;
 const fakeFlow=bars.slice(-8).map((bar,i)=>({t:bar.time,big_n:2,big_total:1000+i*100,big_buy:700,big_sell:300,big_unknown:0,abs_n:i%2,abs_buy:i%2?500:0,abs_sell:0,delta:400}));
 await page.route('**/api/flow/BTC/bars?*',route=>route.fulfill({json:{available:true,bars:fakeFlow,unit:'USD',contract:'BTC-PERPETUAL',exchange:'DERIBIT',first_observed_ts:fakeFlow[0].t}}));
 await page.route('**/api/gex/BTC?filter=0dte*',async route=>{const response=await route.fetch(),value=await response.json();await route.fulfill({json:{...value,available:false,meta:{...value.meta,available:false,filtered_contracts:0},call_wall:null,put_wall:null,zero_gex:null,gamma_flip:null,regime:'unavailable'}})});
 await page.routeWebSocket('**/ws/**',ws=>{const url=new URL(ws.url()),symbol=url.pathname.split('/').at(-1),empty=url.searchParams.get('filter')==='0dte';ws.send(JSON.stringify({type:'init',price:symbol==='BTC'?100000:symbol==='SPY'?600:6000,mode:'SIM',data_status:{available:!empty,chain_age_seconds:0}}));});
 await page.goto(base);
 await page.waitForSelector('[data-testid="market-chart"]');
 await page.getByRole('button',{name:'Indicateurs',exact:false}).click();
 await page.getByLabel('Période',{exact:true}).selectOption('weekly');
 await page.getByLabel('Nombre de niveaux',{exact:true}).fill('24');
 await page.getByLabel('Base de calcul',{exact:true}).selectOption('15m');
 await page.getByRole('tab',{name:'02 · VWAP'}).click();
 await page.getByLabel('Réinitialisation',{exact:true}).selectOption('monthly');
 await page.getByLabel('Bandes',{exact:true}).selectOption('percent');
 await page.getByLabel('Nombre de bandes (±)',{exact:true}).fill('3');
 await page.getByRole('button',{name:'Fermer',exact:true}).click();
 const options=await page.evaluate(()=>JSON.parse(localStorage.getItem('gex.react.workspace.v1')).state.indicators);
 assert.equal(options.vp.rows,24);assert.equal(options.vp.period,'weekly');assert.equal(options.vwap.period,'monthly');assert.equal(options.vwap.bands,'percent');
 await page.getByRole('button',{name:'30m',exact:true}).click();
 assert.match(await page.locator('.indicator-caption').innerText(),/Base 15m/);
 await page.getByRole('button',{name:'Indicateurs',exact:false}).click();
 await page.getByRole('button',{name:'Choisir sur le graphique'}).click();
 const bounds=await page.locator('[data-testid="market-chart"]').boundingBox();
 await page.mouse.click(bounds.x+bounds.width*.55,bounds.y+bounds.height*.35);
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('gex.react.workspace.v1')).state.anchors.BTC?.vp>0);
 const anchor=await page.evaluate(()=>JSON.parse(localStorage.getItem('gex.react.workspace.v1')).state.anchors.BTC.vp);
 await page.reload();await page.waitForSelector('[data-testid="market-chart"]');
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('gex.react.workspace.v1')).state.anchors.BTC.vp),anchor);
 await page.getByRole('button',{name:'Ligne horizontale',exact:true}).click();
 const rect=await page.locator('[data-testid="market-chart"]').boundingBox();
 await page.mouse.click(rect.x+300,rect.y+150);
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('gex.react.draw.BTC')||'[]').length===1);
 await page.getByRole('button',{name:'Tendance · deux clics',exact:true}).click();
 await page.mouse.click(rect.x+350,rect.y+160);await page.waitForTimeout(400);await page.mouse.click(rect.x+550,rect.y+210);
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('gex.react.draw.BTC')).length===2);
 await page.getByRole('button',{name:'Annuler le dernier dessin'}).click();
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('gex.react.draw.BTC')).length),1);
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Journal',exact:true}).last().click();
 assert.equal(await page.locator('tbody tr').count(),8);
 await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Focus',exact:true}).click();
 assert.equal(await page.locator('.context-panel').isVisible(),false);
 await page.getByRole('button',{name:'Quitter Focus',exact:true}).click();
 await page.getByRole('button',{name:'0DTE',exact:true}).click();
 await page.getByText('Aucune donnée sur ce filtre',{exact:true}).waitFor();
 assert.equal(await page.locator('.level-card').count(),0);
 await page.getByRole('button',{name:'Afficher ALL',exact:true}).click();
 await page.waitForSelector('.level-card');
 await page.getByRole('button',{name:'Préférences',exact:true}).first().click();
 await page.getByLabel('Intensité des animations').selectOption('off');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('.terminal').getAttribute('data-motion'),'off');
 await page.getByRole('button',{name:'Préférences',exact:true}).first().click();
 await page.getByLabel('Intensité des animations').selectOption('rich');await page.keyboard.press('Escape');
 await page.emulateMedia({reducedMotion:'reduce'});
 await page.waitForFunction(()=>document.querySelector('.terminal').dataset.motion==='off');
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.waitForFunction(()=>document.querySelector('.terminal').dataset.motion==='rich');
 await page.waitForTimeout(500);
 await page.screenshot({path:'.cache/ui/react-desktop.png',fullPage:true});
 for(const viewport of [{width:1366,height:768},{width:1024,height:900},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.waitForTimeout(200);
  await page.waitForFunction(()=>{const host=document.querySelector('[data-testid="market-chart"]'),chart=host.querySelector('.tv-lightweight-charts');return chart&&chart.getBoundingClientRect().width<=host.clientWidth+1&&document.documentElement.scrollWidth<=innerWidth+2});
  assert((await page.locator('[data-testid="market-chart"]').boundingBox()).height>=330);
 }
 await page.screenshot({path:'.cache/ui/react-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Indicateurs',exact:false}).click();
 assert(await page.getByRole('button',{name:'Fermer',exact:true}).isVisible());
 assert(await page.locator('dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await page.keyboard.press('Escape');
 await page.setViewportSize({width:1440,height:1000});
 // A failed source must not keep candles from the preceding instrument.
 await page.route('**/api/history/SPY?*',route=>route.fulfill({status:503,json:{error:'offline'}}));
 await page.getByRole('button',{name:/SPY.*SPDR/}).click();
 await page.getByText('Historique indisponible',{exact:true}).waitFor();
 assert(await page.getByRole('heading',{name:'SPDR S&P 500'}).isVisible());
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('gex.react.workspace.v1')).state.indicators.vp.anchor),null);
 assert.deepEqual(errors,[]);
 // Cookie login protocol; token is never put in localStorage.
 const gated=await browser.newPage({viewport:{width:1200,height:900}});let authorized=false;
 await gated.route('**/api/symbols',route=>authorized?route.continue():route.fulfill({status:401,json:{detail:'read token required'}}));
 await gated.route('**/api/session',route=>{authorized=true;return route.fulfill({json:{ok:true}})});
 await gated.goto(base);await gated.getByLabel('Jeton de lecture').fill('fixture-read-token');
 await gated.getByRole('button',{name:'Ouvrir la session'}).click();
 await gated.waitForSelector('.terminal');
 assert.equal(await gated.evaluate(()=>JSON.stringify({...localStorage}).includes('fixture-read-token')),false);
 await gated.close();
 await browser.close();console.log('React browser: real build, VP/VWAP preferences and anchors, drawing/undo, flow journal, empty 0DTE, interval/base isolation, responsive, reduced motion, source failure and read-session UI passed.');
})().catch(async e=>{console.error(e);if(launchedBrowser)await launchedBrowser.close();process.exitCode=1});
