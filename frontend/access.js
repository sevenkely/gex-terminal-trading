/* Optional read access: credentials are never put in URLs or localStorage. */
"use strict";
window.gexAccessReady = new Promise(resolve => {
  const originalFetch=window.fetch.bind(window);
  let readRequired=false,resolved=false;
  const overlay=document.getElementById('access-overlay');
  const form=document.getElementById('access-form');
  const message=document.getElementById('access-message');
  window.gexRequireAccess=()=>{overlay.hidden=false;message.textContent='Session de lecture expirée. Authentifiez-vous à nouveau.';};
  window.fetch=async (...args)=>{
    const response=await originalFetch(...args);
    const path=new URL(args[0] instanceof Request ? args[0].url : args[0],location.href).pathname;
    if(readRequired && response.status===401 && path.startsWith('/api/') && !path.startsWith('/api/rithmic') && !['/api/session','/api/access'].includes(path)) window.gexRequireAccess();
    return response;
  };
  async function check() {
    try {
      const r=await fetch('/api/access');
      if(!r.ok) throw new Error('Accès serveur indisponible');
      const state=await r.json();
      readRequired=state.required;
      if(!state.required || state.authorized) {overlay.hidden=true;resolved=true;resolve();return;}
      overlay.hidden=false;
      message.textContent='Jeton de lecture requis. Session de 1 h, conservée dans un cookie HttpOnly.';
    } catch(e) {message.textContent=e.message;setTimeout(check,5000);}
  }
  form.addEventListener('submit',async e=>{
    e.preventDefault();
    const input=document.getElementById('access-token');
    try {
      const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:input.value})});
      input.value='';
      if(!r.ok) {const data=await r.json();throw new Error(data.detail || 'Accès refusé');}
      overlay.hidden=true;
      if(resolved) {location.reload();return;}
      resolved=true;resolve();
    } catch(e){message.textContent=e.message;}
  });
  check();
});
