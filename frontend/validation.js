/* Operational checks and explicitly costed paper evaluation, independent of live chart. */
"use strict";
(() => {
 let report=null, reportSymbol=null;
 const $v=id=>document.getElementById(id);
 const active=()=>$v('sbp-validation').classList.contains('active');
 function line(el,text) {const p=document.createElement('div');p.textContent=text;el.appendChild(p);}
 async function diagnostics() {
  if(!active()) return;
  const el=$v('diagnostics-state');
  try {
   const r=await fetch('/api/diagnostics');if(!r.ok) throw new Error(`Diagnostic indisponible (${r.status})`);
   const d=await r.json();el.replaceChildren();
   line(el,`Recette live : NON SIGNÉE · ${Object.keys(d.sources).length} sources chargées`);
   line(el,`Serveur : ${Math.round(d.operational.uptime_seconds)} s · p95 ${d.operational.latency_p95_ms?.toFixed(0) ?? '—'} ms · erreurs ${d.operational.server_errors}`);
   line(el,`Ticks enregistrés : ${d.recording.enabled ? 'activés' : 'désactivés'} · ${d.recording.written} écrits · ${d.recording.dropped} perdus`);
   line(el,`Disque libre : ${(d.operational.disk_free_bytes/1024**3).toFixed(1)} Go`);
   for(const warning of d.alerts) line(el,`⚠ ${warning}`);
   if(d.rollover?.pending?.length) line(el,'⚠ Changement de contrat détecté : vérifier et reconnecter Rithmic.');
  } catch(e){el.textContent=e.message;}
 }
 const now=Date.now();$v('bt-start').value=new Date(now-4*3600e3).toISOString().slice(0,16);$v('bt-end').value=new Date(now).toISOString().slice(0,16);
 $v('diagnostics-refresh').addEventListener('click',diagnostics);
 document.querySelector('[data-p="validation"]').addEventListener('click',diagnostics);
 $v('backtest-form').addEventListener('submit',async e=>{
  e.preventDefault();const el=$v('backtest-result');el.replaceChildren();
  const symbol=state.symbol;
  if(!FUTURES.has(symbol)) {line(el,'Choisir ES, NQ ou GC. Un indice/proxy ne fournit pas de prix directement exécutable.');return;}
  const start=Date.parse($v('bt-start').value+'Z')/1000,end=Date.parse($v('bt-end').value+'Z')/1000;
  const body={start,end,split_at:start+(end-start)*.7,filter:state.filter,
    level:$v('bt-level').value,strategy:$v('bt-strategy').value,horizon:Number($v('bt-horizon').value),
    commission:Number($v('bt-fees').value),spread_ticks:Number($v('bt-spread').value),slippage_ticks:Number($v('bt-slippage').value)};
  const button=$v('bt-run');button.disabled=true;$v('bt-export').disabled=true;report=null;
  line(el,'Évaluation en cours…');
  try {
   const r=await fetch(`/api/backtest/${symbol}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   const data=await r.json();if(!r.ok) throw new Error(typeof data.detail==='string' ? data.detail : 'Paramètres invalides');
   if(symbol!==state.symbol) return;
   report=data;reportSymbol=symbol;el.replaceChildren();
   line(el,`${symbol} · ${data.summary.trades} trades simulés · résultat net ${data.summary.net_pnl_usd.toFixed(2)} USD`);
   line(el,`Entraînement : ${data.train.trades} trades / ${data.train.net_pnl_usd.toFixed(2)} USD`);
   line(el,`Test : ${data.test.trades} trades / ${data.test.net_pnl_usd.toFixed(2)} USD`);
   line(el,`MAE moyen ${data.summary.mean_mae_points?.toFixed(2) ?? '—'} pts · MFE ${data.summary.mean_mfe_points?.toFixed(2) ?? '—'} pts`);
   line(el,`Couverture non certifiée · ${data.summary.evidence==='insufficient_sample' ? 'ÉCHANTILLON INSUFFISANT' : 'statistiques descriptives seulement'}`);
   line(el,`Exclusions : ${JSON.stringify(data.rejected)}`);line(el,data.limitation);
   if(!data.available) line(el,'Aucun tick enregistré pour cette fenêtre. Activer GEX_RECORD_EVENTS et enregistrer une séance réelle.');
   $v('bt-export').disabled=false;
  } catch(e){el.textContent=e.message;} finally{button.disabled=false;}
 });
 $v('bt-export').addEventListener('click',()=>{
  if(!report || reportSymbol!==state.symbol) return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`paper-evaluation-${reportSymbol}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 });
 setInterval(diagnostics,30000);
})();
