/* Linked analysis tools. No orders, vendor credentials, or fabricated history. */
"use strict";
(() => {
  const el=id=>document.getElementById(id), KEY='gex.workspace.v1';
  let replaySeq=0;
  let grid=null, selected=null, context='', seq=0, controller=null, replay=[], replayContext='', timer=null, running=false;
  let saved={};try{saved=JSON.parse(localStorage.getItem(KEY)||'{}');}catch{}
  if(!saved || typeof saved!=='object' || Array.isArray(saved))saved={};
  // Keep saved layouts, but introduce the classic landing view once on upgrade.
  if(saved.version!==2){saved.active='classic';saved.version=2;}
  const time=t=>new Date(t*1000).toLocaleString('fr-FR',{timeZone:'UTC'});
  function node(tag,text,parent){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(parent)parent.appendChild(n);return n;}
  function pause(){clearTimeout(timer);timer=null;running=false;el('dock-replay-play').textContent='Lecture';}
  function preset(){
    pause();const mode=el('workspace-preset').value;
    document.body.classList.remove('workspace-classic','workspace-analysis','workspace-focus','workspace-research');
    document.body.classList.add('workspace-'+mode);
    if(mode==='classic'||mode==='research'){document.body.classList.remove('sb-collapsed');el('sb-collapse').textContent='◀';document.querySelector(mode==='classic'?'#sb-tabs [data-p="gex"]':'#sb-tabs [data-p="research"]')?.click();}
    if(mode==='classic')el('exposure-clear').click();
    if(mode==='analysis'||mode==='focus')refresh();
    if(state.chart)requestAnimationFrame(()=>{queueGamma();queueDraw();queueFlow();});
    requestAnimationFrame(draw);
  }
  function apply(view){
    const v=view&&typeof view==='object'?view:{};
    if(['levels','channels','off'].includes(v.overlay))el('workspace-overlay').value=v.overlay;
    if(['3','5','10','15'].includes(v.depth))el('workspace-depth').value=v.depth;
    if(['gamma','vanna'].includes(v.metric))el('exposure-metric').value=v.metric;
    if(['.03','.05','.10'].includes(v.band))el('exposure-band').value=v.band;
    el('workspace-tape').checked=v.tape!==false;
    const width=Number(v.width);if(Number.isFinite(width)&&width>=320&&width<=720)el('exposure-dock').style.width=width+'px';
    document.body.classList.toggle('workspace-no-tape',!el('workspace-tape').checked);
    preset();
  }
  function updateSource(){
    if(!grid)return;
    const meta=grid.meta||{};
    el('dock-source-status').textContent=`${grid.symbol} · source options ${grid.source_symbol} · prix ${grid.price_mode}. Chaîne ${time(grid.chain_ts)} UTC. ${meta.projection?'Projection cash → future ; équivalence du contrat non certifiée. '+(!meta.projection.fresh?'BASIS PÉRIMÉ. ':''):''}OI : ${meta.oi_reference||'date inconnue'}.`;
  }
  function selectionDetail(i,j){
    el('exposure-detail').textContent=`${grid.symbol} · strike ${fmtPrice(grid.strikes[i])} · échéance ${time(grid.expiries[j])} UTC · ${fmtUSD(grid.values[i][j])} (${grid.unit}) · ${grid.counts[i][j]} lignes de chaîne agrégées. Calcul ${time(grid.valuation_time)} UTC. ${grid.meta?.projection?'Strike projeté depuis '+grid.source_symbol+'. ':''}Aucune direction de transaction déduite.`;
  }
  function choose(i,j){
    if(!grid?.counts[i]?.[j])return;
    selected={strike:grid.strikes[i],expiry:grid.expiries[j]};
    state.selectedExposureStrike=selected.strike;
    if(!state.fit)el('fit-toggle').click();
    else state.candles?.applyOptions({autoscaleInfoProvider:original=>levelsAutoscale(original)});
    selectionDetail(i,j);
    document.querySelectorAll('#exposure-table button').forEach(b=>b.classList.toggle('selected',Number(b.dataset.strike)===selected.strike&&Number(b.dataset.expiry)===selected.expiry));draw();
  }
  function render(){
    const table=el('exposure-table');table.replaceChildren();el('exposure-levels').replaceChildren();
    if(!grid?.available){selected=null;state.selectedExposureStrike=null;el('exposure-detail').textContent='Aucune sélection pour cette grille.';el('exposure-status').textContent=grid?.reason||'Données indisponibles';el('dock-symbol').textContent=state.symbol+' · EXPOSITIONS';el('dock-source-status').textContent='Chaîne ou projection indisponible pour '+state.symbol;draw();return;}
    el('dock-symbol').textContent=grid.symbol+' · EXPOSITIONS';updateSource();
    if(document.body.classList.contains('workspace-focus'))el('workspace-status').textContent='GEX calculé '+time(grid.valuation_time)+' UTC · '+grid.price_mode;
    const tz=grid.symbol==='BTC'?'UTC':'America/New_York';
    const date=t=>new Date(t*1000).toLocaleDateString('fr-FR',{timeZone:tz,day:'2-digit',month:'2-digit',year:'2-digit'});
    el('exposure-status').textContent=`${grid.metric==='gamma'?'Gamma':'Vanna'} · ${grid.unit} · calcul ${time(grid.valuation_time)} UTC · chaîne ${Math.max(0,Math.floor((Date.now()/1000-grid.chain_ts)/60))} min · prix ${grid.price_mode}${grid.truncated?' · VUE BORNÉE : '+grid.expiries.length+'/'+grid.total_expiries+' échéances, '+grid.strikes.length+'/'+grid.total_strikes_in_band+' strikes':''}${grid.meta?.projection&&!grid.meta.projection.fresh?' · BASIS PÉRIMÉ':''}`;
    const head=node('thead',null,table),hr=node('tr',null,head);node('th','Strike',hr);
    grid.expiries.forEach(t=>{const th=node('th',date(t),hr);th.title=time(t)+' UTC';});
    const body=node('tbody',null,table),maximum=Math.max(1,...grid.values.flat().map(Math.abs));
    const closest=grid.strikes.reduce((a,k)=>Math.abs(k-grid.spot)<Math.abs(a-grid.spot)?k:a,grid.strikes[0]);
    for(let i=grid.strikes.length-1;i>=0;i--){
      const tr=node('tr',null,body);tr.classList.toggle('spot-row',grid.strikes[i]===closest);
      const th=node('th',fmtPrice(grid.strikes[i]),tr);th.scope='row';th.title=grid.strikes[i]===closest?'Strike visible le plus proche du spot':'';
      grid.expiries.forEach((expiry,j)=>{
        const td=node('td',null,tr),value=grid.values[i][j];
        if(!grid.counts[i][j]){td.textContent='—';return;}
        const button=node('button',fmtUSD(value),td);
        button.dataset.strike=grid.strikes[i];button.dataset.expiry=expiry;
        button.style.background=`rgba(${value<0?'174,110,225':'70,190,211'},${.10+.65*Math.sqrt(Math.abs(value)/maximum)})`;
        button.title=`${fmtPrice(grid.strikes[i])} · ${date(expiry)} · ${value.toLocaleString('fr-FR')} ${grid.unit}`;
        button.addEventListener('click',()=>choose(i,j));
        button.classList.toggle('selected',selected?.strike===grid.strikes[i]&&selected?.expiry===expiry);
      });
    }
    ranked().slice(0,12).forEach(r=>{
      const b=node('button',`${fmtPrice(r.strike)}  ${fmtUSD(r.value)}  · ${Math.round((r.strike/grid.spot-1)*10000)} bps`,el('exposure-levels'));
      b.className='exposure-level';b.addEventListener('click',()=>choose(r.i,r.j));
    });
    if(selected)selectionDetail(grid.strikes.indexOf(selected.strike),grid.expiries.indexOf(selected.expiry));
    draw();
  }
  function ranked(){
    if(!grid?.available)return [];
    return grid.strikes.map((strike,i)=>({strike,i,value:grid.values[i].reduce((a,b)=>a+b,0),j:grid.values[i].reduce((best,v,j,row)=>grid.counts[i][j]&&(!grid.counts[i][best]||Math.abs(v)>Math.abs(row[best]))?j:best,0)})).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value));
  }
  async function refresh(){
    if((!document.body.classList.contains('workspace-analysis')&&!document.body.classList.contains('workspace-focus'))||document.hidden)return;
    const id=++seq,sym=state.symbol,filter=state.filter;
    controller?.abort();controller=new AbortController();
    el('exposure-status').textContent='Actualisation…';
    try{
      const q=new URLSearchParams({filter,metric:el('exposure-metric').value,band:el('exposure-band').value});
      const r=await fetch(`/api/exposure/${sym}?${q}`,{signal:controller.signal});
      if(!r.ok)throw Error(`Exposition indisponible (${r.status})`);
      const data=await r.json();if(id!==seq||sym!==state.symbol||filter!==state.filter)return;
      grid=data;
      if(selected && (!grid.strikes?.includes(selected.strike)||!grid.expiries?.includes(selected.expiry))){selected=null;state.selectedExposureStrike=null;}
      render();
    }catch(e){if(id!==seq||e.name==='AbortError')return;grid=null;selected=null;state.selectedExposureStrike=null;render();el('exposure-status').textContent=e.message;}
  }
  function draw(){
    const canvas=el('workspace-overlay-canvas'),area=el('chart-area'),w=area.clientWidth,h=area.clientHeight,dpr=devicePixelRatio||1;
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    if(!grid?.available||grid.symbol!==state.symbol||grid.filter!==state.filter||!state.candles||el('workspace-overlay').value==='off'||document.body.classList.contains('workspace-research')||document.body.classList.contains('workspace-classic'))return;
    const right=w-(state.chart?.priceScale('right').width?.()||70),mode=el('workspace-overlay').value;
    let rows=ranked().slice(0,Number(el('workspace-depth').value));
    if(selected){rows=rows.filter(r=>r.strike!==selected.strike);rows.unshift({strike:selected.strike,value:0,selected:true});}
    const maximum=Math.max(1,...rows.map(r=>Math.abs(r.value)));
    rows=rows.map(r=>({...r,y:state.candles.priceToCoordinate(r.strike)})).filter(r=>r.y!=null&&r.y>55&&r.y<h-36).sort((a,b)=>a.y-b.y);
    let lastY=-100;
    for(const row of rows){
      const color=row.selected?'#f1cf65':row.value<0?'#b48be5':'#65cbd9';
      ctx.strokeStyle=color;ctx.lineWidth=row.selected?2:1;ctx.setLineDash(row.selected?[]:[4,4]);
      if(mode==='channels'&&!row.selected){ctx.globalAlpha=.1+.12*Math.abs(row.value)/maximum;ctx.fillStyle=color;ctx.fillRect(0,row.y-4,right,8);ctx.globalAlpha=1;}
      ctx.beginPath();ctx.moveTo(0,row.y);ctx.lineTo(right,row.y);ctx.stroke();ctx.setLineDash([]);
      const labelY=Math.max(row.y,lastY+19);if(labelY>h-35)continue;lastY=labelY;
      const text=`${row.selected?'SÉLECTION':grid.metric==='gamma'?'Γ':'V'} ${fmtPrice(row.strike)}${row.selected?'':' · '+fmtUSD(row.value)}`;
      ctx.font='11px monospace';const tw=ctx.measureText(text).width+12;
      ctx.fillStyle='#171c23';ctx.fillRect(Math.max(0,right-tw),labelY-13,tw,17);ctx.fillStyle=color;ctx.fillText(text,Math.max(4,right-tw+6),labelY);
    }
  }
  function replayRender(){
    const detail=el('dock-replay-detail'),canvas=el('dock-replay-chart');const index=Number(el('dock-replay-range').value),row=replay[index];
    const width=Math.max(240,canvas.clientWidth),height=230,dpr=devicePixelRatio||1;canvas.width=width*dpr;canvas.height=height*dpr;
    const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,width,height);
    if(!row){detail.textContent='Aucune observation enregistrée pour cet instrument et ce filtre. Aucun historique reconstitué.';return;}
    detail.textContent=`${index+1}/${replay.length} observations (jusqu’aux 300 dernières) · ${row.symbol} ${row.filter} · ${time(row.recorded_at)} UTC · ${row.price_mode} · prix ${fmtPrice(row.price)} · CW ${fmtPrice(row.levels.call_wall)} / PW ${fmtPrice(row.levels.put_wall)} · chaîne ${time(row.chain_ts)} UTC. SIM exclu ; couverture non certifiée.`;
    const rows=replay.slice(0,index+1),keys=['price','call_wall','put_wall','zero_gex'];
    const value=(r,k)=>k==='price'?r.price:r.levels[k];
    const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
    const vals=rows.flatMap(r=>keys.map(k=>value(r,k))).filter(valid);if(!vals.length)return;
    let low=Math.min(...vals),high=Math.max(...vals);const pad=(high-low||low*.001)*.15;low-=pad;high+=pad;
    const x=t=>8+(width-90)*(t-rows[0].recorded_at)/Math.max(1,row.recorded_at-rows[0].recorded_at),y=p=>22+(height-42)*(high-p)/(high-low);
    keys.forEach((key,i)=>{
      ctx.strokeStyle=['#e4e8ee','#65cbd9','#b48be5','#f1cf65'][i];ctx.lineWidth=key==='price'?2:1;ctx.beginPath();let prev=null;
      rows.forEach(r=>{const v=value(r,key);if(!valid(v)){prev=null;return;}if(!prev||r.recorded_at-prev.recorded_at>90)ctx.moveTo(x(r.recorded_at),y(v));else ctx.lineTo(x(r.recorded_at),y(v));ctx.fillStyle=ctx.strokeStyle;ctx.fillRect(x(r.recorded_at)-1,y(v)-1,2,2);prev=r;});ctx.stroke();
      if(valid(value(row,key))){ctx.fillStyle=ctx.strokeStyle;ctx.font='10px monospace';ctx.fillText(key==='price'?'PRIX':key==='call_wall'?'CW':key==='put_wall'?'PW':'ZERO',width-73,16+i*15);}
    });
  }
  async function replayLoad(){
    pause();const id=++replaySeq,identity=state.symbol+'|'+state.filter;replayContext=identity;replay=[];replayRender();
    try{const r=await fetch(`/api/replay/${state.symbol}?filter=${state.filter}&limit=300`);if(!r.ok)throw Error('Historique indisponible');const data=await r.json();if(id!==replaySeq||identity!==state.symbol+'|'+state.filter||replayContext!==identity)return;
      replay=(data.rows||[]).sort((a,b)=>a.recorded_at-b.recorded_at||a.id-b.id);el('dock-replay-range').max=Math.max(0,replay.length-1);el('dock-replay-range').value=0;el('dock-replay-range').disabled=!replay.length;replayRender();
    }catch(e){if(id===replaySeq)el('dock-replay-detail').textContent=e.message;}
  }
  function playStep(){
    const index=Number(el('dock-replay-range').value);if(!running||replayContext!==state.symbol+'|'+state.filter||index>=replay.length-1){pause();return;}
    const delay=Math.max(1,(replay[index+1].recorded_at-replay[index].recorded_at)*1000/Number(el('dock-replay-speed').value));
    timer=setTimeout(()=>{el('dock-replay-range').value=index+1;replayRender();playStep();},delay);
  }
  el('workspace-preset').addEventListener('change',()=>apply(saved[el('workspace-preset').value]));
  el('workspace-overlay').addEventListener('change',draw);
  el('workspace-depth').addEventListener('change',draw);
  el('exposure-clear').addEventListener('click',()=>{selected=null;state.selectedExposureStrike=null;el('exposure-detail').textContent='Sélectionnez une cellule.';state.candles?.applyOptions({autoscaleInfoProvider:original=>state.fit?levelsAutoscale(original):original()});draw();});
  el('workspace-tape').addEventListener('change',()=>document.body.classList.toggle('workspace-no-tape',!el('workspace-tape').checked));
  el('workspace-save').addEventListener('click',()=>{
    const name=el('workspace-preset').value;
    saved[name]={depth:el('workspace-depth').value,overlay:el('workspace-overlay').value,metric:el('exposure-metric').value,band:el('exposure-band').value,tape:el('workspace-tape').checked,width:el('exposure-dock').offsetWidth};saved.active=name;saved.version=2;
    try{localStorage.setItem(KEY,JSON.stringify(saved));el('workspace-status').textContent='Vue enregistrée sur cet appareil';}catch{el('workspace-status').textContent='Stockage local indisponible';}
  });
  el('workspace-reset').addEventListener('click',()=>{saved={};localStorage.removeItem(KEY);location.reload();});
  ['exposure-metric','exposure-band'].forEach(id=>el(id).addEventListener('change',()=>{selected=null;state.selectedExposureStrike=null;el('exposure-detail').textContent='Sélectionnez une cellule.';refresh();}));
  el('exposure-refresh').addEventListener('click',refresh);
  document.querySelectorAll('#dock-tabs button').forEach(b=>b.addEventListener('click',()=>{
    pause();document.querySelectorAll('#dock-tabs button').forEach(n=>{n.classList.toggle('active',n===b);el('dock-'+n.dataset.view).hidden=n!==b;});
    if(b.dataset.view==='replay'&&replayContext!==state.symbol+'|'+state.filter)replayLoad();
  }));
  el('dock-replay-load').addEventListener('click',replayLoad);
  el('dock-replay-range').addEventListener('input',()=>{pause();replayRender();});
  for(const [id,direction] of [['dock-replay-prev',-1],['dock-replay-next',1]])el(id).addEventListener('click',()=>{pause();el('dock-replay-range').value=Math.max(0,Math.min(replay.length-1,Number(el('dock-replay-range').value)+direction));replayRender();});
  el('dock-replay-play').addEventListener('click',()=>{if(running){pause();return;}if(replay.length<2)return;if(Number(el('dock-replay-range').value)>=replay.length-1)el('dock-replay-range').value=0;running=true;el('dock-replay-play').textContent='Pause';playStep();});
  el('dock-replay-speed').addEventListener('change',()=>{if(running){clearTimeout(timer);playStep();}});
  const handle=el('dock-resize');let resizing=false;
  function width(v){el('exposure-dock').style.width=Math.max(320,Math.min(720,innerWidth*.55,v))+'px';}
  handle.addEventListener('pointerdown',e=>{resizing=true;handle.setPointerCapture(e.pointerId);});
  handle.addEventListener('pointermove',e=>{if(resizing)width(el('exposure-dock').getBoundingClientRect().right-e.clientX);});
  handle.addEventListener('pointerup',()=>resizing=false);handle.addEventListener('pointercancel',()=>resizing=false);
  handle.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();width(el('exposure-dock').offsetWidth+(e.key==='ArrowLeft'?20:-20));}});
  let overlayFrame=null;
  function queueOverlay(){if(overlayFrame!=null)return;overlayFrame=requestAnimationFrame(()=>{overlayFrame=null;draw();});}
  for(const event of ['pointermove','wheel','touchmove'])el('chart-area').addEventListener(event,queueOverlay,{passive:true});
  new ResizeObserver(()=>{queueOverlay();replayRender();}).observe(el('chart-area'));
  window.gexAccessReady.then(()=>{
    if(['classic','analysis','focus','research'].includes(saved.active))el('workspace-preset').value=saved.active;
    apply(saved[el('workspace-preset').value]);
    setInterval(()=>{
      const next=state.symbol+'|'+state.filter;
      if(next!==context){context=next;selected=null;state.selectedExposureStrike=null;grid=null;seq++;controller?.abort();replay=[];replayContext='';replaySeq++;pause();el('exposure-detail').textContent='Sélectionnez une cellule.';render();replayRender();refresh();}
      draw();
    },500);
    setInterval(refresh,15000);
    document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
  });
})();
