/* ============================================================
   ACOLITE v2 — copilote de voyage dual-AI
   ✦ Gemini = tâches lourdes (destinations, itinéraires, budget…)
   ⚡ Groq   = tâches simples déléguées (valise, phrases, infos, concierge)
   Fichier unique · zéro backend · localStorage
============================================================ */

/* ============================================================
   ÉCRAN DE DÉMARRAGE — placé TOUT EN HAUT, sans aucune dépendance.
   Il se retire quoi qu'il arrive : si le reste du fichier plante,
   l'erreur s'affiche à l'écran au lieu de bloquer sur le splash.
============================================================ */
(function(){
  var boot = document.getElementById('boot');
  if(!boot) return;
  var bar = boot.querySelector('.boot-bar i');
  var lbl = document.getElementById('bootStep');
  var steps = [[18,'Chargement des styles'],[42,'Réveil du copilote'],[68,'Connexion aux moteurs de prix'],[88,'Préparation de ton voyage'],[100,'Prêt au décollage ✈️']];
  var i = 0, dead = false;

  function hide(){
    if(dead) return;
    dead = true;
    boot.classList.add('gone');
    setTimeout(function(){ if(boot.parentNode) boot.parentNode.removeChild(boot); }, 500);
  }
  function tick(){
    if(dead) return;
    if(i >= steps.length){ setTimeout(hide, 250); return; }
    var s = steps[i++];
    if(bar) bar.style.width = s[0] + '%';
    if(lbl) lbl.textContent = s[1];
    setTimeout(tick, 190);
  }
  tick();

  /* sécurité : jamais bloqué plus de 5 s */
  setTimeout(hide, 5000);

  /* si le script plante pendant le démarrage, on le DIT au lieu de rester figé */
  window.addEventListener('error', function(e){
    if(dead) return;
    if(lbl){
      lbl.style.color = '#FF6B00';
      lbl.style.fontSize = '.62rem';
      lbl.textContent = '⚠️ ' + (e.message || 'erreur au démarrage');
    }
    setTimeout(hide, 2500);
  });
  window.__acoliteBoot = { hide: hide };
})();

const LS_GEM   = 'acolite_gemini_key';
const LS_GEMM  = 'acolite_gem_model_v2';   // modèle Gemini auto-détecté (v2 : re-détection après passage à la génération 3.x)
const LS_GROQ  = 'acolite_groq_key';
const LS_GROQM = 'acolite_groq_model';
const LS_TP    = 'acolite_tp_token';
const LS_TRIP  = 'acolite_trip_v2';
/* Ordre de préférence — le premier dispo sur la clé sera utilisé */
/* Du meilleur au plus prudent — la bascule automatique descend cette liste
   quand un modèle est saturé (503) ou hors quota (429). */
const GEM_PREFERRED = ['gemini-3.5-flash','gemini-3-flash-preview','gemini-2.5-flash','gemini-flash-latest','gemini-2.0-flash','gemini-2.5-flash-lite','gemini-2.5-pro','gemini-pro-latest'];

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

let state = {
  step: 1,
  prefs: null,
  destinations: [],
  trip: null,
  mode: 'plane',
  cache: {},          // réponses IA
  checklist: {},      // valise cochée
  spends: [],         // dépenses réelles
  chatLog: [],        // concierge
  notes: '',          // carnet
  resas: [],          // réservations
  planAnswers: [],    // réponses aux questions du plan
  propAnswers: []     // réponses d'affinage des propositions
};

/* Écriture localStorage tolérante : en navigation privée ou stockage plein,
   setItem lève une exception — ici on ne casse jamais le flux appelant. */
function lsSet(k, v){ try{ localStorage.setItem(k, v); return true; }catch(e){ return false; } }

/* save() ne doit JAMAIS lever d'exception : il est appelé partout (choix du voyage,
   navigation, dépenses…) et un quota dépassé bloquerait l'action en cours. */
function save(){
  try{
    localStorage.setItem(LS_TRIP, JSON.stringify(state));
  }catch(e){
    /* stockage plein → on ne garde que l'essentiel et on réessaie */
    try{
      const slim = {
        ...state,
        cache: { plan: state.cache?.plan, _real: state.cache?._real },
        chatLog: (state.chatLog || []).slice(-10)
      };
      localStorage.setItem(LS_TRIP, JSON.stringify(slim));
      state.cache = slim.cache;
      toast('💾 Stockage plein — cache allégé');
    }catch(e2){
      toast('⚠️ Sauvegarde impossible (stockage plein ou désactivé)');
    }
  }
  /* Envoi vers le compte, groupé et silencieux. Placé APRÈS le try/catch
     local : la sauvegarde dans le navigateur doit réussir même sans réseau,
     et une panne de synchronisation ne doit jamais bloquer l'utilisateur. */
  try{ if(typeof pushSync === 'function') pushSync(); }catch(e3){}
}
function load(){
  try{ const s = JSON.parse(localStorage.getItem(LS_TRIP)); if(s) state = {...state, ...s}; }catch(e){}
}

let toastT;
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(()=>t.classList.remove('show'), 3200);
}

/* ============================================================
   ROUTEUR IA — heavy → Gemini · light → Groq (si clé) sinon Gemini
============================================================ */
const CFG = window.ACOLITE_KEYS || {};
/* Backend Cloudflare : si configuré, les clés restent CÔTÉ SERVEUR.
   Le navigateur n'en envoie aucune — c'est le mode recommandé en public. */
const API = () => (CFG.proxy || '').replace(/\/+$/, '');
const useBackend = () => !!API();
const gemKey  = () => CFG.gemini || localStorage.getItem(LS_GEM)  || '';
const groqKey = () => CFG.groq || localStorage.getItem(LS_GROQ) || '';
/* Du meilleur au plus prudent — bascule automatique si Groq retire un modèle */
const GROQ_PREFERRED = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];
const groqModel = () => localStorage.getItem(LS_GROQM) || GROQ_PREFERRED[0];
const tpKey   = () => CFG.travelpayouts || localStorage.getItem(LS_TP) || '';
const hasGroq = () => useBackend() || !!groqKey();

/* ============================================================
   RÉSEAU FAIBLE — le site doit rester utilisable en 2G/EDGE,
   en tunnel, ou avec une connexion qui saute. Trois leviers :
   1) détection (API Network Information + mesure des échecs)
   2) délais et charges allégés quand ça rame
   3) file de reprise : ce qui a échoué repart dès le retour du réseau
============================================================ */
let _netFails = 0;                       /* échecs réseau consécutifs */
const _netQueue = [];                    /* actions à rejouer au retour du réseau */
function netInfo(){ return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null; }
/* connexion lente : hors-ligne, 2g/slow-2g, économiseur de données, ou 3 échecs d'affilée */
function netSlow(){
  if(!navigator.onLine) return true;
  const c = netInfo();
  if(c){
    if(c.saveData) return true;
    if(/^(slow-2g|2g)$/.test(c.effectiveType || '')) return true;
  }
  return _netFails >= 3;
}
/* délai adapté : on laisse plus de temps quand le réseau est mauvais */
const netTimeout = base => netSlow() ? Math.round(base * 1.8) : base;
function netRetry(label, fn){                       /* rejoue `fn` au retour du réseau */
  if(_netQueue.some(x => x.label === label)) return;
  _netQueue.push({ label, fn });
  updateNetBadge();
}
function flushNetQueue(){
  if(!navigator.onLine || !_netQueue.length) return;
  const jobs = _netQueue.splice(0, _netQueue.length);
  updateNetBadge();
  toast(`📶 Connexion revenue — reprise de ${jobs.length} élément(s)`);
  jobs.forEach(j => { try{ j.fn(); }catch(e){} });
}
function updateNetBadge(){
  const b = $('#netBadge'); if(!b) return;
  const off = !navigator.onLine, slow = netSlow();
  b.hidden = !off && !slow;
  b.className = 'net-badge' + (off ? ' off' : '');
  b.textContent = off
    ? `📴 Hors connexion${_netQueue.length ? ` · ${_netQueue.length} en attente` : ''} — ton voyage reste consultable`
    : `🐢 Réseau lent — Acolite allège les chargements`;
}
addEventListener('online',  () => { _netFails = 0; updateNetBadge(); flushNetQueue(); });
addEventListener('offline', () => { updateNetBadge(); });
netInfo()?.addEventListener?.('change', updateNetBadge);

/* fetch avec délai maximal : sans ça, un appel IA qui reste bloqué fait tourner
   le loader à l'infini. Au-delà de `ms`, on annule et l'appelant affiche l'erreur.
   Compte aussi les échecs pour détecter une connexion qui rame. */
function fetchT(url, opts = {}, ms = 45000){
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), netTimeout(ms));
  return fetch(url, { ...opts, signal: ac.signal })
    .then(r => { _netFails = 0; if(!navigator.onLine) updateNetBadge(); return r; })
    .catch(err => { _netFails++; if(_netFails === 3) updateNetBadge(); throw err; })
    .finally(() => clearTimeout(id));
}

/* --- Découverte automatique du modèle Gemini disponible sur la clé --- */
async function resolveGemModel(key, force = false){
  if(GEM_OVERRIDE) return GEM_OVERRIDE; /* bascule anti-saturation en cours */
  /* Réglage "Modèle" du panneau Préférences */
  if(SET?.model && SET.model !== 'auto') return SET.model;
  if(!force){
    const cached = localStorage.getItem(LS_GEMM);
    if(cached) return cached;
  }
  const r = await fetchT(useBackend()
    ? `${API()}/gemini/models`
    : `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=100`, {}, 10000);
  if(!r.ok){
    const msg = await gemErrMsg(r);
    throw new Error('LIST:' + msg);
  }
  const d = await r.json();
  const names = (d.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => (m.name || '').replace('models/',''));
  const pick = GEM_PREFERRED.find(p => names.includes(p))
    || names.find(n => n.includes('flash') && !n.includes('image') && !n.includes('tts'))
    || names[0];
  if(!pick) throw new Error('LIST:Aucun modèle compatible sur cette clé.');
  lsSet(LS_GEMM, pick);
  lsSet('acolite_gem_names', JSON.stringify(names)); /* pour la bascule auto */
  return pick;
}

/* Bascule automatique : quand un modèle est saturé (503) ou hors quota (429),
   on prend le suivant de GEM_PREFERRED disponible sur la clé. */
let GEM_OVERRIDE = ''; /* prioritaire le temps de la session, remis à zéro au rechargement */
function nextGemModel(current){
  let names = [];
  try{ names = JSON.parse(localStorage.getItem('acolite_gem_names')) || []; }catch(e){}
  const chain = GEM_PREFERRED.filter(m => !names.length || names.includes(m));
  const i = chain.indexOf(current);
  return chain[i + 1] || (i === -1 ? chain[0] : null);
}

/* --- Message d'erreur lisible depuis la réponse Google --- */
async function gemErrMsg(r){
  let apiMsg = '';
  try{ const j = await r.json(); apiMsg = j.error?.message || ''; }catch(e){}
  if(r.status === 400 && /API key not valid|API_KEY_INVALID/i.test(apiMsg)) return 'Clé API invalide — vérifie qu\'elle est bien copiée en entier';
  if(r.status === 403 && /SERVICE_DISABLED|has not been used|is disabled/i.test(apiMsg)) return 'API "Generative Language" désactivée sur ce projet Google — crée la clé depuis aistudio.google.com/apikey';
  if(r.status === 403) return 'Accès refusé (403) — clé restreinte ? Vérifie les restrictions de la clé';
  if(r.status === 429) return 'Quota gratuit atteint — attends 1 min ou passe sur Groq ⚡';
  if(r.status === 404) return 'Modèle introuvable (404)';
  if(r.status === 503) return 'Gemini surchargé (503), réessaie dans quelques secondes';
  return `Erreur ${r.status}${apiMsg ? ' — ' + apiMsg.slice(0,120) : ''}`;
}

async function gemini(prompt, expectJson = true, maxTok = 4096, _retry = false, temp = 0.85, _hops = 0){
  const key = gemKey();
  if(!key && !useBackend()){ toast('⚠️ Clé Gemini absente de config.js'); throw new Error('NO_KEY'); }
  let model;
  try{
    model = await resolveGemModel(key);
  }catch(e){
    const m = String(e.message||'').replace(/^LIST:/,'') || 'Connexion à Gemini impossible';
    toast('⚠️ ' + m);
    throw new Error('BAD_KEY');
  }
  const body = {
    contents: [{ role:'user', parts:[{ text: prompt }] }],
    generationConfig: { temperature: temp, maxOutputTokens: maxTok }
  };
  /* Réflexion des modèles récents : leurs tokens de "pensée" comptent dans
     maxOutputTokens (réponse vide sinon → EMPTY).
     - appels courts : réflexion coupée → réponse immédiate, jamais vide
     - appels lourds (propositions, plan…) : réflexion ACTIVÉE pour la qualité,
       avec de la place réservée EN PLUS du budget de réponse */
  const gc = body.generationConfig, isPro = /pro/.test(model);
  if(/2\.5-flash/.test(model)){
    gc.thinkingConfig = { thinkingBudget: maxTok < 2048 ? 0 : 2048 };
    if(maxTok >= 2048) gc.maxOutputTokens = maxTok + 2048;
  }else if(/gemini-3|flash-latest/.test(model) && !isPro){
    if(maxTok < 2048) gc.thinkingConfig = { thinkingBudget: 0 };
    else gc.maxOutputTokens = maxTok + 4096;          /* réflexion dynamique */
  }else if(isPro && /2\.5|gemini-3|latest/.test(model)){
    gc.maxOutputTokens = maxTok + 4096;               /* Pro : réflexion non désactivable */
  }
  /* plafond de sortie du modèle : 8192 pour la génération 2.0, 32768 au-delà */
  gc.maxOutputTokens = Math.min(gc.maxOutputTokens, /2\.0/.test(model) ? 8192 : 32768);
  if(expectJson) gc.responseMimeType = 'application/json';
  const r = useBackend()
    ? await fetchT(`${API()}/gemini`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ model, body })      /* aucune clé ne quitte le navigateur */
      })
    : await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if(r.status === 404 && !_retry){
    /* modèle mis en cache devenu obsolète → re-détection puis retry */
    localStorage.removeItem(LS_GEMM);
    GEM_OVERRIDE = '';
    await resolveGemModel(key, true);
    return gemini(prompt, expectJson, maxTok, true, temp, _hops);
  }
  if((r.status === 429 || r.status === 503) && !_retry){
    /* surcharge passagère → une seule nouvelle tentative après 1,6 s */
    await new Promise(res => setTimeout(res, 1600));
    return gemini(prompt, expectJson, maxTok, true, temp, _hops);
  }
  if((r.status === 429 || r.status === 503) && _hops < 3){
    /* toujours saturé (503) ou hors quota (429) → modèle suivant de la liste */
    const next = nextGemModel(model);
    if(next && next !== model){
      GEM_OVERRIDE = next;
      lsSet(LS_GEMM, next);
      return gemini(prompt, expectJson, maxTok, false, temp, _hops + 1);
    }
  }
  if(!r.ok){
    const msg = await gemErrMsg(r);
    toast('⚠️ ' + msg);
    if(r.status === 429) throw new Error('RATE');
    throw new Error('BAD_KEY');
  }
  const d = await r.json();
  let txt = (d.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('');
  if(!txt){
    /* réponse vide (réflexion trop longue ?) → une relance avec le double de place */
    if(!_retry) return gemini(prompt, expectJson, maxTok * 2, true, temp, _hops);
    toast('⚠️ Réponse vide de Gemini, réessaie'); throw new Error('EMPTY');
  }
  if(!expectJson) return txt;
  txt = txt.replace(/```json|```/g,'').trim();
  return parseAI(txt);
}

async function groq(prompt, expectJson = true, maxTok = 2048, _retryModel = false){
  const body = {
    model: groqModel(),
    messages: [{ role:'user', content: prompt + (expectJson ? '\nRéponds UNIQUEMENT avec un objet JSON valide, rien d\'autre.' : '') }],
    temperature: 0.7,
    max_tokens: maxTok
  };
  /* gpt-oss "réfléchit" avant de répondre : effort bas = réponse rapide qui ne
     mange pas le budget de tokens. (llama refuse ce paramètre → conditionnel) */
  if(/gpt-oss/.test(body.model)) body.reasoning_effort = 'low';
  if(expectJson) body.response_format = { type:'json_object' };
  const r = useBackend()
    ? await fetchT(`${API()}/groq`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ body })             /* la clé Groq reste sur le serveur */
      })
    : await fetchT('https://api.groq.com/openai/v1/chat/completions',{
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + groqKey() },
        body: JSON.stringify(body)
      });
  if(r.status === 401){ toast('Clé Groq invalide — vérifie dans ⚙'); throw new Error('BAD_GROQ'); }
  if(r.status === 429){ throw new Error('GROQ_RATE'); }
  if(r.status === 404 && !_retryModel){
    /* modèle retiré par Groq → on passe au suivant de la liste et on mémorise */
    const cur = groqModel();
    const next = GROQ_PREFERRED[GROQ_PREFERRED.indexOf(cur) + 1] || GROQ_PREFERRED.find(m => m !== cur);
    if(next && next !== cur){ lsSet(LS_GROQM, next); return groq(prompt, expectJson, maxTok, true); }
  }
  if(!r.ok) throw new Error('GROQ_HTTP ' + r.status);
  const d = await r.json();
  let txt = d.choices?.[0]?.message?.content || '';
  if(!txt) throw new Error('GROQ_EMPTY'); /* contenu vide → ai() bascule sur Gemini */
  if(!expectJson) return txt;
  txt = txt.replace(/```json|```/g,'').trim();
  return parseAI(txt, false);
}

/* --- Auto-réparation JSON : récupère les réponses IA mal formées --- */
async function parseAI(txt, allowRepair = true){
  const tryP = s => { try{ return JSON.parse(s); }catch(e){ return undefined; } };
  /* nettoie ce qui casse le plus souvent le JSON des LLM : fences + virgules traînantes */
  const clean = s => s.replace(/```json|```/gi, '').replace(/,\s*([}\]])/g, '$1').trim();
  let v = tryP(txt);            if(v !== undefined) return v;
  v = tryP(clean(txt));         if(v !== undefined) return v;
  /* isole le plus grand objet {...} OU tableau [...] présent dans la réponse */
  const slice = (open, close) => {
    const a = txt.indexOf(open), b = txt.lastIndexOf(close);
    return (a > -1 && b > a) ? clean(txt.slice(a, b + 1)) : null;
  };
  for(const cand of [slice('{', '}'), slice('[', ']')]){
    if(cand){ v = tryP(cand); if(v !== undefined) return v; }
  }
  if(allowRepair && hasGroq()){
    try{
      const fixed = await groq('Ce JSON est invalide. Corrige-le sans changer son contenu. Réponds UNIQUEMENT avec le JSON corrigé, rien d\'autre :\n' + txt.slice(0, 6000), false, 4096);
      v = tryP(clean(fixed)); if(v !== undefined) return v;
    }catch(e){}
  }
  throw new Error('BAD_JSON');
}

/* ai('heavy'|'light', prompt) — retourne {data, via} */
async function ai(kind, prompt, expectJson = true, maxTok = 4096){
  if(kind === 'light' && hasGroq()){
    try{
      const data = await groq(prompt, expectJson, Math.min(maxTok, 4096));
      return { data, via:'groq' };
    }catch(e){
      // fallback silencieux sur Gemini si Groq plante (rate limit…)
      if(e.message === 'BAD_GROQ') throw e;
    }
  }
  const data = await gemini(prompt, expectJson, maxTok);
  return { data, via:'gemini' };
}

/* ---- Mascotte Acolite : la Terre aux grands yeux, qui regarde autour d'elle
   pendant que l'IA réfléchit. SVG inline → net partout, zéro fichier, hors-ligne. ---- */
function mascotSVG(cls = ''){
  return `<svg class="mascot ${cls}" viewBox="0 0 100 100" role="img" aria-label="Acolite réfléchit">
    <defs><clipPath id="mGlobeClip"><circle cx="50" cy="50" r="45"/></clipPath></defs>
    <circle class="m-ocean" cx="50" cy="50" r="45"/>
    <g clip-path="url(#mGlobeClip)" class="m-land">
      <ellipse cx="24" cy="29" rx="14" ry="10" transform="rotate(-20 24 29)"/>
      <ellipse cx="29" cy="67" rx="9"  ry="14" transform="rotate(14 29 67)"/>
      <ellipse cx="71" cy="24" rx="17" ry="9"  transform="rotate(8 71 24)"/>
      <ellipse cx="68" cy="66" rx="11" ry="14" transform="rotate(-10 68 66)"/>
      <ellipse cx="50" cy="12" rx="20" ry="6"/>
    </g>
    <circle class="m-rim" cx="50" cy="50" r="45"/>
    <g class="m-eyes">
      <ellipse class="m-white" cx="36" cy="46" rx="15" ry="19"/>
      <ellipse class="m-white" cx="66" cy="46" rx="14" ry="18"/>
      <g class="m-pupils">
        <circle class="m-pupil" cx="38" cy="48" r="8"/>
        <circle class="m-pupil" cx="68" cy="48" r="7.5"/>
        <circle class="m-shine" cx="41.5" cy="43.5" r="2.4"/>
        <circle class="m-shine" cx="71"   cy="43.5" r="2.1"/>
      </g>
    </g>
  </svg>`;
}
function loaderHTML(msg){ return `<div class="loader">${mascotSVG()}<span class="loader-msg">${esc(msg)}</span></div>`; }
/* La mascotte tient lieu de logo. On masque le SVG aux lecteurs d'écran :
   le mot « Acolite » juste à côté dit déjà de quoi il s'agit, et l'étiquette
   par défaut du SVG (« Acolite réfléchit ») serait fausse ici. */
document.querySelectorAll('.logo-mark').forEach(el => {
  el.innerHTML = mascotSVG();
  el.setAttribute('aria-hidden', 'true');
});

/* ---- La mascotte prend vie ----
   Clic → elle saute. Et de temps en temps, à intervalle ALÉATOIRE, une
   mascotte visible réagit toute seule (pirouette, saut, sursaut) : c'est ce
   qui la rend imprévisible plutôt que mécanique. Tout est coupé si
   l'utilisateur a demandé de réduire les animations. */
const MASCOT_REACTIONS = ['m-hop', 'm-spin', 'm-wiggle'];
function motionOff(){
  return document.documentElement.classList.contains('no-motion')
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
function mascotReact(m, cls){
  if(!m || motionOff()) return;
  MASCOT_REACTIONS.forEach(c => m.classList.remove(c));
  void m.offsetWidth;                     /* redémarre l'animation même si déjà jouée */
  m.classList.add(cls);
  m.addEventListener('animationend', () => m.classList.remove(cls), { once:true });
}
/* clic : saut, où que soit la mascotte (logo, chargements…) */
document.addEventListener('click', e => {
  const m = e.target.closest?.('.mascot');
  if(m) mascotReact(m, 'm-hop');
});
/* vie spontanée : une réaction au hasard, à un moment au hasard */
(function mascotLife(){
  const wait = 4000 + Math.random() * 6000;        /* entre 4 et 10 s */
  setTimeout(() => {
    if(!motionOff()){
      const vis = [...document.querySelectorAll('.mascot')].filter(m => m.getClientRects().length);
      if(vis.length){
        const m = vis[Math.floor(Math.random() * vis.length)];
        mascotReact(m, MASCOT_REACTIONS[Math.floor(Math.random() * MASCOT_REACTIONS.length)]);
      }
    }
    mascotLife();                                   /* on relance avec un nouveau délai */
  }, wait);
})();
/* errHTML(msg, retryId?) : si un retryId est fourni ET enregistré dans _retryFns,
   un bouton « Réessayer » relance l'action fautive. */
const _retryFns = {};
function errHTML(msg, retryId){
  return `<div class="err">⚠️ ${esc(msg)}${retryId ? `<button class="btn sm ghost err-retry" data-retry="${esc(retryId)}">↻ Réessayer</button>` : ''}</div>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-retry]');
  if(b && typeof _retryFns[b.dataset.retry] === 'function') _retryFns[b.dataset.retry]();
});
function badge(via){ return via === 'groq' ? '<span class="ai-badge groq">⚡ Groq</span>' : '<span class="ai-badge gemini">✦ Gemini</span>'; }

/* --- Skeletons : silhouettes de chargement (perçu plus rapide qu'un spinner) --- */
function skelCards(n = 3){
  const one = `<div class="skel-card"><div class="skel skel-line lg"></div><div class="skel skel-line"></div><div class="skel skel-line sm"></div><div class="skel-row"><span class="skel skel-pill"></span><span class="skel skel-pill"></span><span class="skel skel-pill"></span></div></div>`;
  return `<div class="dest-grid">${one.repeat(n)}</div>`;
}
function skelPlan(){
  return `<div class="skel-plan">
    <div class="skel-row" style="gap:10px">${'<span class="skel skel-stat"></span>'.repeat(3)}</div>
    <div class="skel skel-line lg" style="margin-top:16px"></div>
    <div class="skel skel-line"></div><div class="skel skel-line sm"></div>
    <div class="skel skel-line" style="margin-top:14px"></div><div class="skel skel-line sm"></div>
  </div>`;
}
/* --- Progression « vivante » : fait défiler des messages pendant une génération longue.
   Retourne une fonction stop() à appeler quand c'est fini. --- */
function progress(el, msgs){
  if(!el) return () => {};
  let i = 0;
  el.innerHTML = `<div class="card">${loaderHTML(msgs[0])}</div>`;
  const set = () => { const m = el.querySelector('.loader-msg'); if(m) m.textContent = msgs[i % msgs.length]; };
  const id = setInterval(() => { i++; set(); }, 2600);
  return () => clearInterval(id);
}

/* ---------- Contexte voyage ---------- */
function ctx(){
  const p = state.prefs || {}, t = state.trip || {};
  let saison = '';
  if(p.depart){
    const mo = new Date(p.depart + 'T12:00:00');
    if(!isNaN(mo)) saison = mo.toLocaleDateString('fr-FR', { month:'long', year:'numeric' });
  }
  return `Date d'aujourd'hui : ${new Date().toLocaleDateString('fr-FR')}.
CONTEXTE VOYAGEUR :
- Départ : ${p.from || 'non précisé'}${saison ? `\n- Mois du voyage (calculé) : ${saison} — raisonne selon cette saison précise` : ''}
- Destination choisie : ${t.nom || '?'}, ${t.pays || ''}
- Durée : ${p.days || '?'} · Période : ${p.when || 'flexible'}
- Budget/pers : ${p.budget || '?'} · Voyageurs : ${p.adults||2} adulte(s)${p.kids ? ' + ' + p.kids + ' enfant(s)' : ''}
- Destination souhaitée : ${p.dest || 'libre, à proposer'}${p.vibe ? `\n- Ambiance recherchée : ${p.vibe}` : ''}${p.withWho ? `\n- Voyage ${p.withWho}` : ''}${p.stay ? `\n- Style d'hébergement préféré : ${p.stay}` : ''}${p.transport ? `\n- MOYEN DE TRANSPORT IMPOSÉ par le voyageur : ${p.transport}. Construis le trajet avec ce mode, même s'il n'est pas le plus rapide. S'il est réellement impossible (mer à traverser, distance absurde), dis-le franchement et explique pourquoi avant de proposer autre chose.` : ''}
- Limites & conditions : ${p.free || 'aucune'}
${prefsBlock()}
RÈGLES DE QUALITÉ (toujours valables) :
- Uniquement des lieux, quartiers, établissements et transports RÉELS et vérifiables — au moindre doute, préfère l'option la plus connue plutôt que d'inventer.
- Prix en euros, réalistes pour la saison et l'année indiquées ; donne des fourchettes plutôt que des chiffres trop précis.
- Respecte STRICTEMENT le budget et les limites du voyageur.
- TUTOIE toujours le voyageur (jamais de vouvoiement), ton chaleureux et naturel.${p.kids ? '\n- Des ENFANTS voyagent : adapte chaque conseil (rythme, distances, activités, restaurants) à leur présence.' : ''}`;
}

/* ============================================================
   ÉTAPE 1 — ENVIES → PROPOSITIONS  (Gemini · heavy)
============================================================ */
function readPrefs(extra){
  return {
    from:  $('#fFrom').value.trim() || 'Paris',
    dest:  $('#fDest').value.trim(),
    days:  $('#fDays').value,
    when:  $('#fWhen').value.trim(),
    budget:$('#fBudget').value,
    adults:+$('#fAdults').value || 2,
    kids:  +$('#fKids').value || 0,
    depart:$('#fDepart').value,
    vibe:  $('#fVibe')?.value || '',
    withWho:$('#fWith')?.value || '',
    stay:  $('#fStay')?.value || '',
    transport: $('#fTransport')?.value || '',
    free:  $('#fFree').value.trim().slice(0,600) + (extra ? ' | Affinage : ' + String(extra).slice(0,600) : '')
  };
}

let _genBusy = false;   /* garde anti double-appel des générations IA */
async function proposeTrips(extra = '', lucky = false, country = ''){
  if(_genBusy) return;
  _genBusy = true;
  _retryFns.propose = () => proposeTrips(extra, lucky, country);
  const prefs = readPrefs(extra);
  state.prefs = prefs; save();
  const zone = $('#zoneResults');
  const msgs = country
    ? [`Acolite cherche LE bon coin en/au ${country}… 🎯`, 'Il compare les villes et les ambiances…', 'Vérification budget, saison & accès…', 'Presque prêt…']
    : lucky
    ? ['Roulette mondiale en cours… 🎲', 'Tirage de destinations inattendues…', 'Vérification budget & saison…', 'Presque prêt…']
    : ['Acolite explore le monde pour toi… 🌍', 'Analyse de tes envies & ton budget…', 'Sélection de destinations réelles…', 'Transport & quartier pour chacune…', 'Presque prêt…'];
  zone.innerHTML = `<div class="card">${loaderHTML(msgs[0])}</div>` + skelCards(3);
  let mi = 0;
  const msgTimer = setInterval(() => { mi++; const m = zone.querySelector('.loader-msg'); if(m) m.textContent = msgs[mi % msgs.length]; }, 2600);
  searchBar(true, lucky ? 'Roulette mondiale en cours… 🎲' : 'Acolite explore le monde…');
  $('#btnGo').disabled = true; $('#btnLucky').disabled = true; if($('#btnCountry')) $('#btnCountry').disabled = true;

  const prompt = `Tu es Acolite, un expert voyage français, chaleureux et concret.
${ctx()}
${lucky ? 'MODE SURPRISE : propose des destinations inattendues, originales, auxquelles le voyageur ne penserait jamais, mais qui collent quand même au budget et à la période.' : ''}
${country ? `MODE « SURPRISE DANS UN PAYS » : le voyageur veut absolument voyager en/au ${country}, mais il te laisse CHOISIR l'endroit précis. Propose UNE SEULE destination : une ville, une région ou un lieu PRÉCIS et RÉEL de ${country} — de préférence pas le plus évident/touristique — parfaitement adapté à son budget, sa période et ses envies. Dans "resume", explique clairement POURQUOI c'est LE bon choix surprise dans ce pays. Ignore la règle du nombre de propositions ci-dessous : ici, exactement UNE.` : ''}
TOUT DOIT ÊTRE TROUVÉ DÈS MAINTENANT : pour CHAQUE proposition, tu donnes déjà le transport (mode, prix A/R, durée) ET le logement (type, quartier réel, prix/nuit). Le voyageur doit pouvoir comparer sans rien avoir à deviner. Uniquement des quartiers qui EXISTENT VRAIMENT.

QUESTIONS DE PRÉCISION : si des infos te manquent pour viser juste (rythme, ambiance, priorités, contraintes), pose 2 ou 3 questions courtes dans "questions", chacune avec un nombre PAIR d'options cliquables (exactement 2 ou 4, jamais 3). Si le voyageur a déjà tout précisé, renvoie "questions":[].

${(state.seen||[]).length && !prefs.dest ? 'DÉJÀ PROPOSÉ à ce voyageur (ne PAS reproposer sauf s\'il le demande) : ' + state.seen.join(', ') + '.' : ''}
${(getHistory()||[]).length ? 'VOYAGES DÉJÀ CHOISIS par ce voyageur par le passé : ' + getHistory().map(h=>h.nom).join(', ') + ' — ne les repropose pas, mais inspire-toi de ses goûts.' : ''}
DÉCIDE toi-même du NOMBRE de propositions (1 à 3) selon la demande :
- La demande désigne UNE VILLE précise → UNE SEULE proposition : la meilleure formule pour cette ville, très travaillée.
- Un PAYS ou une région → 2 ou 3 villes/zones DIFFÉRENTES de ce pays.
- Demande ouverte → 3 destinations VRAIMENT différentes.
INTERDICTION ABSOLUE de proposer des voyages qui se ressemblent : chaque proposition doit différer clairement des autres (ville différente, OU ambiance/gamme de budget/rythme radicalement différents). Ne remplis jamais avec des variantes cosmétiques.
Respecte STRICTEMENT le budget, les limites, la durée et la période — attention à la météo saisonnière.
RÈGLE ABSOLUE : uniquement des villes et lieux RÉELS. Budgets réalistes pour la saison. En cas de doute, prudence plutôt qu'invention.
${prefs.free && prefs.free.includes('Affinage') ? "Le voyageur a déjà répondu à des questions d'affinage (voir contexte) : intègre ces réponses et ne repose JAMAIS une question déjà répondue." : ''}

Réponds UNIQUEMENT en JSON valide, structure exacte. Commence OBLIGATOIREMENT par le champ "analyse" (ton raisonnement interne, jamais montré au voyageur) AVANT les destinations :
{
 "analyse":"3-4 phrases : profil du voyageur, contraintes clés (budget/saison/distance), pièges à éviter, angle distinct choisi pour chaque proposition",
 "destinations":[
   {
     "nom":"...", "pays":"...", "drapeau":"emoji drapeau",
     "resume":"2 phrases vendeuses et concrètes",
     "budget_estime":"ex: ~850€/pers tout compris",
     "duree_ideale":"ex: 5-7 jours",
     "meteo_periode":"ex: 26°C, ensoleillé",
     "points_forts":["3 à 4 atouts courts"],
     "acces":"avion" ou "voiture" ou "train" ou "avion ou voiture",
     "iata":"code IATA aéroport principal, ex CDG, sinon null",
     "ville_aeroport":"nom ville aéroport le plus proche",
     "langue":"langue principale parlée",
     "monnaie":"monnaie locale",
     "transport_conseille":"avion" ou "train" ou "voiture",
     "transport_pourquoi":"6-10 mots : pourquoi ce transport vu le budget/conditions",
     "transport_prix":"fourchette A/R par personne, ex 90-140€",
     "transport_duree":"durée porte-à-porte, ex 2h15 de vol + 1h de transferts",
     "logement_type":"1 ou 2 mots MAX : hôtel, appartement, auberge, villa…",
     "logement_quartier":"LE quartier précis conseillé (nom réel), ex Trastevere",
     "logement_prix":"fourchette par nuit, ex 80-120€",
     "logement_pourquoi":"6-10 mots : pourquoi ce quartier"
   }
 ],
 "questions":[
   {"texte":"question courte et UTILE pour préciser le voyage","options":["2 ou 4 réponses courtes — toujours un nombre PAIR"]}
 ]
}
"questions" : 1 à 3 questions qui aideraient VRAIMENT à préciser le voyage (dates exactes ? quartier ambiance ? priorité visites/repos ? contrainte transport ?). Jamais de question dont la réponse est déjà dans le contexte.`;

  try{
    let d = await gemini(prompt, true, 8192);
    if(SET?.verif !== false && !lucky) d = await reviewProps(d, prompt);
    state.destinations = d.destinations || [];
    state.seen = [...new Set([...(state.seen||[]), ...state.destinations.map(x=>x.nom)])].slice(-15);
    state.lastProps = d; save();
    renderDestinations(d);
    gotoStep(2);
    /* → Questions de précision AVANT que tu ne choisisses : la pop-up s'ouvre ici */
    const qs = (d.questions || []).filter(q => q && q.texte);
    if(qs.length && !state._qsDone) openQsPopup(qs);
    else { $('#ovQs').classList.remove('show'); $('#zoneQs').innerHTML = ''; }
  }catch(e){
    const msg = e.message === 'RATE' ? 'Quota IA atteint — réessaie dans 1 min ou passe sur Groq ⚡.'
      : (e.name === 'AbortError' ? 'Délai dépassé — le serveur IA n’a pas répondu.' : 'Impossible de contacter Gemini. Vérifie ta clé ou ta connexion.');
    if(e.message !== 'NO_KEY') zone.innerHTML = `<div class="card">${errHTML(msg, 'propose')}</div>`;
    else zone.innerHTML = '';
  }finally{
    clearInterval(msgTimer);
    _genBusy = false;
  }
  searchBar(false);
  $('#btnGo').disabled = false; $('#btnLucky').disabled = false; if($('#btnCountry')) $('#btnCountry').disabled = false;
}

/* "Hôtel familial ou appart-hôtel" → "Hôtel familial" ; "180-250€ par nuit" → "180-250€" */
const shortType = s => String(s || 'logement').split(/\s*(?:\(|\bou\b|\/)/i)[0].trim().slice(0, 18) || 'logement';
const cleanPrix = s => String(s || '').replace(/\s*(par|\/)\s*nuit/gi, '').trim();

function renderDestinations(d){
  const zone = $('#zoneResults');
  const n = (d.destinations||[]).length;
  let html = `<div class="card"><h2>${n > 1 ? 'Compare tes voyages' : 'Ton voyage sur mesure'} 🎒 <span class="ai-badge gemini">✦ Gemini</span></h2>
  <p class="sub">${n > 1 ? 'Des propositions volontairement différentes. Compare-les point par point et clique sur celle qui te fait vibrer.' : 'Acolite a concentré ses efforts sur la formule idéale pour ta destination. Clique dessus pour lancer l\'organisation.'}</p>
  <div class="dest-grid">`;
  (d.destinations||[]).forEach((x,i)=>{
    const tIco = ({avion:'✈️',train:'🚆',voiture:'🚗'})[x.transport_conseille]||'✈️';
    html += `<div class="dest" data-i="${i}">
      <div class="dest-main">
        <div class="flag">${esc(x.drapeau||'📍')}</div>
        <h3>${esc(x.nom)}</h3><div class="country">${esc(x.pays)}</div>
        <p>${esc(x.resume)}</p>
      </div>
      <div class="dest-facts">
        <div class="fact"><span class="fk">💶 Budget</span><span class="fv">${esc(x.budget_estime)}</span></div>
        <div class="fact"><span class="fk">${tIco} ${esc(x.transport_conseille||'avion')}</span><span class="fv">${esc(x.transport_prix||'—')}${x.transport_duree ? ` · ${esc(x.transport_duree)}` : ''}</span></div>
        <div class="fact"><span class="fk">🏨 ${esc(shortType(x.logement_type))}</span><span class="fv">${esc(x.logement_quartier||'—')}${x.logement_prix ? ` · ${esc(cleanPrix(x.logement_prix))}/nuit` : ''}</span></div>
        <div class="fact"><span class="fk">☀️ Météo</span><span class="fv">${esc(x.meteo_periode)}</span></div>
        <div class="fact"><span class="fk">⏱ Durée</span><span class="fv">${esc(x.duree_ideale)}</span></div>
        <div class="fact"><span class="fk">🗣️ Langue</span><span class="fv">${esc(x.langue||'—')}</span></div>
      </div>
      ${(x.transport_pourquoi || x.logement_pourquoi) ? `<p class="hint" style="margin-top:8px">${x.transport_pourquoi ? '✈️ ' + esc(x.transport_pourquoi) : ''}${x.transport_pourquoi && x.logement_pourquoi ? ' · ' : ''}${x.logement_pourquoi ? '🏨 ' + esc(x.logement_pourquoi) : ''}</p>` : ''}
      <div class="tags" style="margin-top:10px">${(x.points_forts||[]).map(p=>`<span class="tag">${esc(p)}</span>`).join('')}</div>
      <button class="btn sm" style="width:100%;justify-content:center;margin-top:6px">Choisir ce voyage →</button>
    </div>`;
  });
  html += `</div>`;
  /* Les questions ne s'affichent QUE dans la pop-up — jamais dans la page. */
  html += `</div>`;

  /* Comparatif côte à côte — tout aligné, point par point (uniquement si plusieurs propositions) */
  if(n > 1){
    const D = d.destinations;
    const rows = [
      ['💶 Budget',    D.map(x => esc(x.budget_estime || '—'))],
      ['✈️ Transport', D.map(x => `${esc(x.transport_conseille || 'avion')} · ${esc(x.transport_prix || '—')}`)],
      ['🏨 Logement',  D.map(x => `${esc(shortType(x.logement_type))}${x.logement_quartier ? ' · ' + esc(x.logement_quartier) : ''}`)],
      ['☀️ Météo',     D.map(x => esc(x.meteo_periode || '—'))],
      ['⏱ Durée',      D.map(x => esc(x.duree_ideale || '—'))],
      ['🗣️ Langue',    D.map(x => esc(x.langue || '—'))]
    ];
    html += `<div class="card"><h3 style="margin:0 0 4px">📊 Comparatif</h3>
      <p class="sub" style="margin:0 0 10px">Tout est aligné — compare point par point, puis choisis ta colonne.</p>
      <div class="cmp-wrap"><table class="cmp">
        <thead><tr><th></th>${D.map((x, i) => `<th data-i="${i}"><span class="cmp-flag">${esc(x.drapeau || '📍')}</span><br>${esc(x.nom)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(r => `<tr><th scope="row">${r[0]}</th>${r[1].map(v => `<td>${v}</td>`).join('')}</tr>`).join('')}
          <tr class="cmp-actions"><td></td>${D.map((x, i) => `<td><button class="btn sm cmp-choose" data-i="${i}">Choisir →</button></td>`).join('')}</tr>
        </tbody>
      </table></div></div>`;
  }
  /* Affinage en langage libre : « pas tout à fait ça… » → relance en tenant compte du feedback */
  html += `<div class="card">
    <h3 style="margin:0 0 4px">✍️ Pas tout à fait ça ?</h3>
    <p class="sub" style="margin:0 0 10px">Dis à Acolite ce qui cloche, il repropose en en tenant compte.</p>
    <div class="refine-bar">
      <input id="refineInp" class="refine-inp" type="text" placeholder="ex : plus près de la mer, moins cher, plus animé…" aria-label="Ce qui ne va pas dans les propositions">
      <button class="btn sm" id="refineGo">Reproposer →</button>
    </div>
  </div>`;
  zone.innerHTML = html;

  $$('.dest').forEach(el => el.onclick = () => chooseTrip(+el.dataset.i));
  $$('.cmp-choose, .cmp th[data-i]').forEach(el => el.onclick = () => chooseTrip(+el.dataset.i));
  const doRefine = () => {
    const inp = $('#refineInp'); const v = (inp?.value || '').trim();
    if(!v) return;
    state.propAnswers = [...(state.propAnswers || []), 'Précision : ' + v].slice(-12);
    save();
    toast('🎯 Acolite réajuste ses propositions…');
    proposeTrips(state.propAnswers.join(' · '));
  };
  const rgo = $('#refineGo'); if(rgo) rgo.onclick = doRefine;
  const rinp = $('#refineInp'); if(rinp) rinp.addEventListener('keydown', e => { if(e.key === 'Enter') doRefine(); });
  $$('.chip.refine').forEach(el => el.onclick = () => {
    state.propAnswers = state.propAnswers || [];
    state.propAnswers.push(`${el.dataset.q || 'Affinage'} → ${el.dataset.r}`.slice(0,200));
    state.propAnswers = state.propAnswers.slice(-12);
    save();
    toast('✔ ' + el.dataset.r);
    proposeTrips(state.propAnswers.join(' · '));
  });
}

const LS_HIST = 'acolite_history';
function getHistory(){ try{ return JSON.parse(localStorage.getItem(LS_HIST)) || []; }catch(e){ return []; } }
function pushHistory(t){
  const h = getHistory().filter(x => x.nom !== t.nom);
  /* on garde le voyage COMPLET + un instantané des préférences → permet de le rouvrir */
  h.push({ nom: t.nom, pays: t.pays, drapeau: t.drapeau, budget_estime: t.budget_estime,
           quand: Date.now(), trip: t, prefs: state.prefs || null });
  try{ localStorage.setItem(LS_HIST, JSON.stringify(h.slice(-10))); }
  catch(e){ /* quota → on retombe sur une version légère */
    try{ localStorage.setItem(LS_HIST, JSON.stringify(h.slice(-10).map(x => ({ nom:x.nom, pays:x.pays, drapeau:x.drapeau, budget_estime:x.budget_estime, quand:x.quand, trip:x.trip })))); }catch(_){}
  }
  renderGallery();
}

/* --- Galerie « Mes voyages » : reprendre un voyage déjà exploré --- */
let _galExpanded = false;   /* affiche-t-on TOUS les voyages, ou les 3 premiers ? */
function renderGallery(){
  const box = $('#galleryList'), card = $('#tripGallery');
  if(!box || !card) return;
  const h = getHistory().slice().reverse();
  if(!h.length){ card.hidden = true; box.innerHTML = ''; return; }
  card.hidden = false;
  /* au-delà de 3 voyages, on n'en montre que 3 — un bouton déplie le reste */
  const LIMITE = 3;
  const trop = h.length > LIMITE;
  const visibles = (trop && !_galExpanded) ? h.slice(0, LIMITE) : h;
  box.innerHTML = visibles.map((x, i) => `
    <div class="gal">
      <div class="gal-flag">${esc(x.drapeau || '📍')}</div>
      <div class="gal-info">
        <b>${esc(x.nom)}</b>
        <span>${esc(x.pays || '')}${x.budget_estime ? ' · ' + esc(x.budget_estime) : ''}</span>
      </div>
      <button class="btn sm ghost gal-open" data-gi="${i}">${x.trip ? 'Rouvrir →' : 'Reproposer'}</button>
    </div>`).join('')
    + (trop ? `<button class="btn ghost sm gal-toggle" id="galToggle">${
        _galExpanded ? '▲ Afficher moins' : `▼ Voir tous mes voyages (${h.length})`}</button>` : '');
}
document.addEventListener('click', e => {
  if(e.target.id === 'galToggle'){ _galExpanded = !_galExpanded; renderGallery(); }
});
function reopenTrip(i){
  const x = getHistory().slice().reverse()[i];
  if(!x) return;
  if(!x.trip){ const f = $('#fDest'); if(f) f.value = x.nom; gotoStep(1); toast('Destination pré-remplie 👍'); return; }
  state.trip = x.trip;
  if(x.prefs) state.prefs = x.prefs;
  state.cache = {}; state.checklist = {}; state.spends = []; state.chatLog = []; state.notes = ''; state.resas = [];
  state._geo = null; state.planAnswers = []; state._qsDone = false; _onSiteDone = false;
  _pcPhotos = null;   /* sinon la carte postale garderait les photos du voyage précédent */
  state.board = { votes:{}, comments:{} };
  save();
  unlockSteps();
  toast(`On repart pour ${x.trip.nom} ! ✈️`);
  gotoStep(3);
}
document.addEventListener('click', e => {
  const g = e.target.closest('.gal-open');
  if(g){ reopenTrip(+g.dataset.gi); }
});

function chooseTrip(i){
  state.trip = state.destinations[i];
  pushHistory(state.trip);
  state.cache = {}; state.checklist = {}; state.spends = []; state.chatLog = []; state.notes = ''; state.resas = [];
  state._geo = null; state.planAnswers = []; state._qsDone = false; _onSiteDone = false;
  _pcPhotos = null;   /* photos de carte postale liées au voyage précédent */
  state.board = { votes:{}, comments:{} };   /* votes/commentaires liés à l'ancien voyage */
  save();
  unlockSteps();
  toast(`Cap sur ${state.trip.nom} ! ✈️`);
  gotoStep(3);
}

/* ============================================================
   BOARDING PASS
============================================================ */
function passHTML(){
  const t = state.trip, p = state.prefs || {};
  if(!t) return '';
  const from = (p.from || 'PAR').slice(0,3).toUpperCase();
  const to   = (t.iata || t.nom.slice(0,3)).toUpperCase();
  const plan = state.cache.plan;
  const d    = stayDates();
  const jj   = s => s.split('-').reverse().slice(0,2).join('/');
  const dates = d ? `${jj(d.in)} → ${jj(d.out)}` : (p.when || 'dates flexibles');
  const nuits = d ? Math.max(1, Math.round((new Date(d.out) - new Date(d.in)) / 86400000)) : null;
  const pax   = `${p.adults || 1} ad.${p.kids ? ` + ${p.kids} enf.` : ''}`;
  /* on garde un type de logement COURT : "Appartement ou Hôtel familial" → "Appartement" */
  const logt = plan?.logement
    ? String(plan.logement.type || '').split(/\s*(?:\(|ou |\/)/)[0].trim().slice(0, 16)
    : '';
  const budget = plan?.budget?.total ? `${plan.budget.total} €` : (t.budget_estime || '—').replace(/\/pers.*$/i, '');

  return `<div class="pass">
    <div class="pass-top">
      <div class="pass-route">
        <span class="iata">${esc(from)}</span>
        <span class="dash"></span>
        <span class="plane">✈</span>
        <span class="dash"></span>
        <span class="iata">${esc(to)}</span>
      </div>
      <button class="pass-change" data-changedest title="Changer de destination" aria-label="Changer de destination">↩</button>
    </div>

    <div class="pass-info">
      <div class="pi"><span class="pk">Destination</span><span class="pv">${esc(t.nom)} ${esc(t.drapeau || '')}</span></div>
      <div class="pi"><span class="pk">Dates</span><span class="pv">${esc(dates)}${nuits ? ` · ${nuits} n.` : ''}</span></div>
      <div class="pi"><span class="pk">Passagers</span><span class="pv">${esc(pax)}</span></div>
      <div class="pi"><span class="pk">Budget</span><span class="pv">${esc(budget)}${logt ? ` · ${esc(logt)}` : ''}</span></div>
    </div>

    <div class="pass-tear">
      <div class="pass-acts">
        <button class="pact" data-passpng title="Télécharger le ticket avec son QR code">📷<span>Ticket</span></button>
        <button class="pact" data-postcard title="Créer une carte postale à partager">🖼️<span>Postale</span></button>
        <button class="pact" data-sharelink title="Partager un lien qui importe ce voyage">🔗<span>Lien</span></button>
        <button class="pact" data-ics title="Ajouter le programme à ton agenda">📅<span>Agenda</span></button>
      </div>
    </div>
    <p class="pass-note">Ticket souvenir — ne permet pas d'embarquer. Le QR sert uniquement à importer ce voyage dans Acolite.</p>
  </div>`;
}
function changeDest(){ gotoStep(1); }
window.changeDest = changeDest;
function refreshPasses(){
  const h = passHTML();
  ['#passSlot2','#passSlot3','#passSlot4','#passSlot5'].forEach(s=>{ const el=$(s); if(el) el.innerHTML=h; });
}

/* ============================================================
   NAVIGATION
============================================================ */
function unlockSteps(){
  $$('.step').forEach(s => {
    const n = +s.dataset.step;
    if(n === 2) s.classList.toggle('locked', !(state.destinations||[]).length);
    if(n === 3) s.classList.toggle('locked', !state.trip);
  });
}
let _onSiteDone = false;
function openSub(t){
  $$('.subtab').forEach(x => x.classList.toggle('on', x.dataset.t === t));
  Object.entries(TAB_PANELS).forEach(([k, sel]) => $(sel)?.classList.toggle('hidden', k !== t));
}
function gotoStep(n, sub){
  n = Math.min(n, 3);
  if(n === 2 && !(state.destinations||[]).length){ toast('Remplis d’abord le questionnaire 😉'); return; }
  if(n === 3 && !state.trip){ toast('Choisis d’abord un des 3 voyages 😉'); return; }
  state.step = n; save();
  $$('.step').forEach(s => s.classList.toggle('active', +s.dataset.step === n));
  [1,2,3].forEach(i => $('#view'+i).classList.toggle('hidden', i !== n));
  refreshPasses();
  window.scrollTo({top:0, behavior:'smooth'});
  if(n === 3) loadPlan();
}
$$('.step').forEach(s => s.onclick = () => { if(!s.classList.contains('locked')) gotoStep(+s.dataset.step); });

/* ============================================================
   ÉTAPE 2 — PLAN CLÉ EN MAIN (Gemini · heavy)
   L'IA choisit le transport, le logement, organise le séjour,
   pose ses questions — le voyageur n'a plus qu'à valider.
============================================================ */
function syncModeFromPlan(d){
  const map = {avion:'plane', train:'train', voiture:'car'};
  const m = map[d?.transport?.mode];
  if(m && !state.modeManual) state.mode = m;
  save();
  $('#tgPlane').classList.toggle('on', state.mode==='plane');
  $('#tgCar').classList.toggle('on', state.mode==='car');
  $('#tgTrain').classList.toggle('on', state.mode==='train');
}

/* ============================================================
   DONNÉES RÉELLES GRATUITES — ancrent l'IA dans le concret
   (Open-Meteo géocodage+météo, Wikipédia, prix de vols captés)
============================================================ */
async function geoPlace(name, cc){
  try{
    const r = await fetchT(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=fr&format=json`, {}, 7000);
    const d = await r.json();
    const res = d.results || [];
    if(!res.length) return null;
    /* si on connaît le pays attendu, on privilégie le résultat qui y correspond
       (évite p.ex. « Shenandoah » qui tombe au Kansas au lieu de la Virginie) */
    if(cc){ const m = res.find(x => (x.country_code || '').toUpperCase() === cc); if(m) return m; }
    return res[0];
  }catch(e){ return null; }
}
/* ---- Hébergements RÉELS via OpenStreetMap (Overpass) ----
   Gratuit, sans clé, sans conditions restrictives — contrairement à Airbnb,
   dont l'API est fermée aux partenaires. On n'a pas les prix, mais on a des
   établissements qui existent vraiment et leur position exacte. L'IA choisit
   alors DANS cette liste au lieu de puiser dans sa mémoire. */
/* Deux serveurs : l'instance publique limite le débit (429) dès qu'on
   enchaîne les requêtes. On bascule sur le miroir avant d'abandonner. */
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter',
                       'https://overpass.kumi.systems/api/interpreter'];
const OSM_STAY_KINDS = 'hotel|guest_house|hostel|apartment|chalet|motel';
const OSM_STAY_FR = { hotel:'hôtel', guest_house:'chambre d’hôtes', hostel:'auberge',
                      apartment:'appartement', chalet:'chalet', motel:'motel' };
async function osmStays(lat, lon, radiusM = 3500){
  const ck = `osm_stay_${lat.toFixed(3)}_${lon.toFixed(3)}_${radiusM}`;
  if(state.cache[ck]) return state.cache[ck];
  /* ce chemin touche RÉELLEMENT le réseau : c'est ici, et seulement ici,
     qu'on renonce en connexion dégradée. Le reste de loadHotels continue. */
  if(netSlow()) return [];
  const q = `[out:json][timeout:20];nwr(around:${radiusM},${lat},${lon})`
    + `[tourism~"^(${OSM_STAY_KINDS})$"][name];out center 60;`;
  let d = null;
  for(const url of OVERPASS_URLS){
    try{
      const r = await fetchT(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q)
      }, netTimeout(12000));
      /* 429 = quota, pas panne réseau : on essaie le miroir SANS compter
         d'échec réseau, sinon netSlow() basculerait et couperait le prix
         des vols alors que la connexion va très bien. */
      if(r.status === 429 || r.status >= 500) continue;
      if(!r.ok) return [];
      d = await r.json();
      break;
    }catch(e){ _netFails++; }
  }
  if(!d) return [];
  try{
    const ref = { latitude: lat, longitude: lon };
    const rows = (d.elements || []).map(e => {
      const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon;
      if(la == null || lo == null || !e.tags?.name) return null;
      return {
        nom: String(e.tags.name).slice(0, 80),
        type: OSM_STAY_FR[e.tags.tourism] || e.tags.tourism,
        etoiles: e.tags.stars ? +e.tags.stars : null,
        km: +havKm(ref, { latitude: la, longitude: lo }).toFixed(2)
      };
    }).filter(Boolean)
      .sort((a, b) => a.km - b.km)
      .slice(0, 22);
    state.cache[ck] = rows; save();
    return rows;
  }catch(e){ return []; }
}
/* met la liste OSM en forme pour le prompt (vide = on n'ajoute rien) */
function osmStayCtx(rows){
  if(!rows || !rows.length) return '';
  const l = rows.map(h => `- ${h.nom} (${h.type}${h.etoiles ? `, ${h.etoiles}★` : ''}, à ${h.km} km du centre du quartier)`).join('\n');
  return `\nHÉBERGEMENTS RÉELS relevés sur OpenStreetMap autour du quartier visé (données vérifiées, pas d'invention) :\n${l}\n`
    + `Choisis EN PRIORITÉ dans cette liste. Tu ne peux proposer un établissement absent de la liste que si aucun ne convient au budget ou au type demandé — dans ce cas il doit être tout aussi réel et vérifiable.\n`;
}

/* code pays ISO à partir du nom FR du pays (pour biaiser le géocodage) */
function ccFor(pays){ return COUNTRY_CC[String(pays || '').trim().toLowerCase()] || ''; }
/* nettoie un libellé de lieu pour le géocodeur : « Washington D.C. (Dulles) » → « Washington » */
function cleanPlace(s){
  return String(s || '').split(/[(,/]/)[0].replace(/\b[A-Z]\.?[A-Z]\.?\b/g, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
}
function havKm(a, b){
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLa = rad(b.latitude - a.latitude), dLo = rad(b.longitude - a.longitude);
  const h = Math.sin(dLa/2)**2 + Math.cos(rad(a.latitude))*Math.cos(rad(b.latitude))*Math.sin(dLo/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const _avg = arr => Math.round(arr.reduce((x,y)=>x+y,0) / arr.length);

const COUNTRY_CC = { 'france':'FR','italie':'IT','espagne':'ES','portugal':'PT','allemagne':'DE','autriche':'AT','belgique':'BE','pays-bas':'NL','suisse':'CH','royaume-uni':'GB','angleterre':'GB','irlande':'IE','écosse':'GB','grèce':'GR','croatie':'HR','slovénie':'SI','hongrie':'HU','pologne':'PL','tchéquie':'CZ','république tchèque':'CZ','slovaquie':'SK','roumanie':'RO','bulgarie':'BG','suède':'SE','norvège':'NO','danemark':'DK','finlande':'FI','islande':'IS','estonie':'EE','lettonie':'LV','lituanie':'LT','luxembourg':'LU','malte':'MT','chypre':'CY','états-unis':'US','etats-unis':'US','canada':'CA','mexique':'MX','brésil':'BR','argentine':'AR','chili':'CL','japon':'JP','corée du sud':'KR','chine':'CN','inde':'IN','thaïlande':'TH','vietnam':'VN','indonésie':'ID','malaisie':'MY','singapour':'SG','australie':'AU','nouvelle-zélande':'NZ','maroc':'MA','tunisie':'TN','égypte':'EG','afrique du sud':'ZA','turquie':'TR','albanie':'AL','serbie':'RS','monténégro':'ME','bosnie-herzégovine':'BA','macédoine du nord':'MK','ukraine':'UA','géorgie':'GE','arménie':'AM' };

async function realData(){
  if(SET?.reels === false) return '';   /* le voyageur a désactivé les données réelles */
  const t = state.trip; if(!t) return '';
  const key = t.nom + ',' + t.pays;
  let R = state.cache._real;
  if(!R || R.key !== key){
    R = { key };
    try{
      const [g1, g2] = await Promise.all([ geoPlace(cleanPlace(state.prefs?.from || 'Paris')), geocode() ]);
      if(g1 && g2) R.dist = Math.round(havKm(g1, g2));
      if(g2){
        const depDate = state.prefs?.depart ? new Date(state.prefs.depart) : null;
        const farAway = depDate && (depDate - Date.now()) > 16 * 86400000;
        if(farAway){
          /* départ lointain → climat réel du même mois l'an dernier (archive Open-Meteo) */
          const y = depDate.getFullYear() - 1, m = String(depDate.getMonth() + 1).padStart(2, '0');
          const last = new Date(y, depDate.getMonth() + 1, 0).getDate();
          const wa = await fetchT(`https://archive-api.open-meteo.com/v1/archive?latitude=${g2.latitude}&longitude=${g2.longitude}&start_date=${y}-${m}-01&end_date=${y}-${m}-${last}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`, {}, 7000).then(r=>r.json()).catch(()=>null);
          if(wa?.daily?.temperature_2m_max?.length){
            const rain = Math.round((wa.daily.precipitation_sum||[]).reduce((a,b)=>a+(b||0),0));
            R.meteo = `climat typique du mois du voyage (relevés réels ${m}/${y}) : ${_avg(wa.daily.temperature_2m_min)}°C à ${_avg(wa.daily.temperature_2m_max)}°C, ${rain} mm de pluie sur le mois`;
            R.mNums = { min:_avg(wa.daily.temperature_2m_min), max:_avg(wa.daily.temperature_2m_max), rain: Math.min(90, Math.round(rain/3)) };
          }
        }
        if(!R.meteo){
          const w = await fetchT(`https://api.open-meteo.com/v1/forecast?latitude=${g2.latitude}&longitude=${g2.longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_mean&forecast_days=7&timezone=auto`, {}, 7000).then(r=>r.json());
          if(w.daily?.temperature_2m_max?.length){
            R.meteo = `${_avg(w.daily.temperature_2m_min)}°C à ${_avg(w.daily.temperature_2m_max)}°C, probabilité de pluie ${_avg(w.daily.precipitation_probability_mean||[0])}% (relevé réel, 7 prochains jours)`;
            R.mNums = { min:_avg(w.daily.temperature_2m_min), max:_avg(w.daily.temperature_2m_max), rain:_avg(w.daily.precipitation_probability_mean||[0]) };
          }
        }
      }
    }catch(e){}
    const _wikiP = fetch(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.nom)}`)
      .then(r => r.ok ? r.json() : null).then(wk => { if(wk?.extract) R.wiki = wk.extract.slice(0, 400); }).catch(()=>{});
    /* Wikivoyage : conseils orientés voyageur (quartiers, transports, arnaques) */
    const _wvP = fetch(`https://fr.wikivoyage.org/api/rest_v1/page/summary/${encodeURIComponent(t.nom)}`)
      .then(r => r.ok ? r.json() : null).then(wv => { if(wv?.extract) R.wv = wv.extract.slice(0, 350); }).catch(()=>{});
    /* Jours fériés officiels du pays pendant le séjour (Nager.Date, sans clé) */
    const _holP = (async () => { try{
      const dts = stayDates();
      if(!dts) return;
      const cc = COUNTRY_CC[String(t.pays||'').toLowerCase()];
      if(!cc) return;
      const yr = dts.in.slice(0, 4);
      const hs = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${yr}/${cc}`).then(r => r.ok ? r.json() : null);
      if(!Array.isArray(hs)) return;
      const inRange = hs.filter(h => h.date >= dts.in && h.date <= dts.out)
        .map(h => `${h.date} (${h.localName})`);
      if(inRange.length) R.feries = inRange.join(', ');
    }catch(e){} })();
    /* horaires de train réels (Deutsche Bahn) — seulement si le rail est plausible */
    const _trainP = (async () => { try{
      if(!R.dist || R.dist < 1600){
        const tOut = new Promise(res => setTimeout(() => res(null), 8000));
        const sPair = Promise.all([ dbStation(state.prefs?.from || 'Paris'), dbStation(t.nom) ]).catch(() => null);
        const st = await Promise.race([sPair, tOut]);
        if(st && st[0] && st[1]){
          const rj = await Promise.race([
            fetch(`${DB_API}/journeys?from=${st[0].id}&to=${st[1].id}&results=3&tickets=true&language=fr`),
            tOut
          ]);
          if(rj && rj.ok){
            const dj = await rj.json();
            const js = (dj.journeys||[]).filter(j => j.legs?.length);
            if(js.length){
              const best = js[0];
              const dep = new Date(best.legs[0].departure), arr = new Date(best.legs[best.legs.length-1].arrival);
              const mins = Math.round((arr - dep) / 60000);
              const chg = Math.max(0, best.legs.filter(l => !l.walking).length - 1);
              const prices = js.map(j => j.price?.amount).filter(Boolean);
              if(mins > 0) R.train = `${Math.floor(mins/60)}h${String(mins%60).padStart(2,'0')} de trajet, ${chg} correspondance(s)${prices.length ? ', à partir de ' + Math.min(...prices).toFixed(0) + ' €' : ''} (horaires réels Deutsche Bahn)`;
            }
          }
        }
      }
    }catch(e){} })();
    /* taux de change réel (Frankfurter, BCE) */
    const _fxP = (async () => { try{
      const code = ((t.monnaie||'').toUpperCase().match(/\b(?!EUR)[A-Z]{3}\b/)||[])[0];
      if(code){
        const rf = await fetch(`https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${code}`);
        if(rf.ok){
          const df = await rf.json();
          if(df.rates?.[code]) R.fx = `1 € = ${df.rates[code].toFixed(2)} ${code} (taux réel du jour, BCE)`;
        }
      }
    }catch(e){} })();
    await Promise.allSettled([_wikiP, _wvP, _holP, _trainP, _fxP]);
    state.cache._real = R; save();
  }
  const L = [];
  if(R.dist) L.push(`Distance ${state.prefs?.from || 'départ'} → ${t.nom} : environ ${R.dist} km à vol d'oiseau (calcul réel)`);
  if(R.meteo) L.push(`Météo réelle à ${t.nom} en ce moment : ${R.meteo}`);
  if(state.cache.realPrice) L.push(`Prix de vol réel constaté par nos moteurs : ${state.cache.realPrice}`);
  if(R.train) L.push(`Trajet en TRAIN réel ${state.prefs?.from || 'départ'} → ${t.nom} : ${R.train}`);
  if(R.fx) L.push(`Taux de change réel : ${R.fx} — utilise CE taux pour toute conversion de budget`);
  if(R.wiki) L.push(`Contexte factuel (Wikipédia) : ${R.wiki}`);
  if(R.wv) L.push(`Infos voyageur (Wikivoyage) : ${R.wv}`);
  if(R.feries) L.push(`JOURS FÉRIÉS OFFICIELS pendant le séjour : ${R.feries} — beaucoup de commerces/musées ferment ou sont bondés ces jours-là : adapte le programme et préviens dans "conseil_cle"`);
  return L.length ? `\nDONNÉES RÉELLES VÉRIFIÉES — appuie-toi dessus, ne les contredis JAMAIS :\n- ${L.join('\n- ')}\n` : '';
}

/* --- Relecture croisée : Groq vérifie le plan de Gemini, Gemini corrige si besoin --- */
async function reviewPlan(d, basePrompt){
  if(!hasGroq()) return d;
  try{
    const v = await groq(`Tu es un vérificateur impitoyable de plans de voyage. ${ctx()}
PLAN À VÉRIFIER (JSON) : ${JSON.stringify(d).slice(0, 5500)}
Contrôle STRICTEMENT et uniquement ces 7 points :
1. "budget.total" respecte-t-il le budget demandé par personne ?
2. Le nombre d'entrées de "programme" correspond-il à la durée demandée ?
3. Le transport choisi est-il cohérent avec la distance, la POLLUTION (si un mode nettement moins polluant est comparable en temps/prix, le plan doit le justifier) et les limites du voyageur ?
4. COHÉRENCE GÉOGRAPHIQUE : chaque journée regroupe-t-elle des lieux PROCHES les uns des autres ? Signale toute journée qui fait traverser la ville en zigzag (ex : un lieu au nord, puis au sud, puis de nouveau au nord).
5. Les lieux cités existent-ils VRAIMENT dans cette ville, et sont-ils ouverts à la période du voyage (attention aux jours fériés signalés) ?
6. Le programme est-il réaliste en temps (pas 6 musées dans une seule journée), avec un premier et un dernier jour ALLÉGÉS (arrivée/départ) ?
7. Le QUARTIER du logement est-il cohérent avec le point d'arrivée (aéroport/gare) ET les lieux du programme ?
8. Si le voyage est MULTI-BASES ("logement.etapes") : l'ordre des bases est-il géographiquement logique (pas de retour en arrière), chaque base a-t-elle ≥ 2 nuits, la somme des nuits colle-t-elle à la durée, et les trajets entre bases sont-ils comptés dans le budget ?
Réponds en JSON : {"ok":true} si tout est cohérent, sinon {"ok":false,"problemes":["max 4 incohérences, courtes et factuelles"]}`, true, 700);
    if(v?.ok !== false || !(v.problemes||[]).length){ d._checked = 'ok'; return d; }
    const d2 = await gemini(basePrompt + `\n\nATTENTION — une relecture indépendante a détecté ces incohérences dans une première version. Corrige-les IMPÉRATIVEMENT :\n- ${v.problemes.join('\n- ')}`, true, 8192, false, 0.4);
    d2._checked = 'fixed';
    return d2;
  }catch(e){ return d; }
}

/* Relecture croisée des PROPOSITIONS (étape 1) : Groq vérifie, Gemini corrige si besoin.
   Réglable via SET.verif ; jamais en mode surprise (on y veut de la liberté). */
async function reviewProps(d, basePrompt){
  if(!hasGroq() || !(d.destinations||[]).length) return d;
  try{
    const v = await groq(`Tu es un vérificateur voyage strict. ${ctx()}
PROPOSITIONS À VÉRIFIER (JSON) : ${JSON.stringify(d.destinations).slice(0, 4500)}
Contrôle UNIQUEMENT :
1. "budget_estime" respecte-t-il le budget/personne demandé ?
2. "meteo_periode" est-elle cohérente avec la saison RÉELLE du voyage (mois indiqué) ?
3. Les villes et quartiers sont-ils RÉELS et vraiment DIFFÉRENTS entre les propositions (pas de doublons déguisés) ?
4. "transport_prix" est-il réaliste depuis le point de départ ?
Réponds en JSON : {"ok":true} si tout est bon, sinon {"ok":false,"problemes":["max 3 incohérences, courtes et factuelles"]}`, true, 650);
    if(v?.ok !== false || !(v.problemes||[]).length) return d;
    const d2 = await gemini(basePrompt + `\n\nATTENTION — une relecture indépendante a détecté ces problèmes dans une première version. Corrige-les IMPÉRATIVEMENT en gardant EXACTEMENT la même structure JSON :\n- ${v.problemes.join('\n- ')}`, true, 8192);
    return d2;
  }catch(e){ return d; }
}

async function loadPlan(force = false){
  const zone = $('#zonePlan');
  if(state.cache.plan && !force){ renderPlan(state.cache.plan); syncModeFromPlan(state.cache.plan); return; }
  const t = state.trip;
  if(!t){ zone.innerHTML = errHTML('Choisis d’abord un voyage.'); return; }
  if(_genBusy) return;
  _genBusy = true;
  _retryFns.plan = () => loadPlan(true);
  const p = state.prefs || {};   /* prefs peut être null (voyage rouvert sans préférences) */
  const msgs = ['Acolite organise ton voyage de A à Z… 🧭', 'Comparaison des transports (prix / durée)…', 'Choix du quartier idéal…', 'Programme jour par jour…',
    ...(SET?.verif !== false ? ['Relecture par une 2ᵉ IA…'] : []), 'Presque prêt…'];
  zone.innerHTML = `<div class="card">${loaderHTML(msgs[0])}</div>` + skelPlan();
  let mi = 0;
  const msgTimer = setInterval(() => { mi++; const m = zone.querySelector('.loader-msg'); if(m) m.textContent = msgs[mi % msgs.length]; }, 2600);
  const answers = (state.planAnswers||[]).join(' · ');
  /* budget de temps : les données réelles ne doivent JAMAIS bloquer le plan
     (réseau lent/coupé → on continue sans elles au bout de 12 s) */
  const realCtx = await Promise.race([ realData(), new Promise(r => setTimeout(() => r(''), 12000)) ]);
  /* Le transport et le logement ont DÉJÀ été trouvés à l'étape 2 : on les garde et on approfondit */
  const dejaTrouve = (t.transport_conseille || t.logement_quartier)
    ? `\nCHOIX DÉJÀ VALIDÉS À L'ÉTAPE 2 (le voyageur les a acceptés en choisissant ce voyage — GARDE-LES, sauf si les données réelles les contredisent) :
- Transport : ${t.transport_conseille || '?'}${t.transport_prix ? ` (${t.transport_prix})` : ''}${t.transport_duree ? `, ${t.transport_duree}` : ''}
- Logement : ${t.logement_type || '?'} dans le quartier ${t.logement_quartier || '?'}${t.logement_prix ? ` (${t.logement_prix}/nuit)` : ''}
TON TRAVAIL : approfondir (détails pratiques, programme jour par jour, budget précis), PAS tout recommencer.\n`
    : '';
  /* chiffres CO₂ réels injectés dans l'étape transport (aller-retour, par personne) */
  const _dist = state.cache._real?.dist;
  const _A = (p.adults || 1) + (p.kids || 0);
  const co2Ctx = _dist
    ? `CO₂ ESTIMÉ pour ${Math.round(_dist)} km (aller-retour, par personne, calcul réel) : avion ~${Math.round(_dist*2*CO2_G_KM.avion/1000)} kg · train ~${Math.round(_dist*2*CO2_G_KM.train/1000)} kg · voiture ~${Math.round(_dist*2*CO2_G_KM.voiture/Math.max(1,_A)/1000)} kg (partagée entre ${_A} voyageur(s)).`
    : '';
  const prompt = `Tu es Acolite, organisateur de voyage expert. ${ctx()}
${realCtx}${co2Ctx ? co2Ctx + '\n' : ''}${dejaTrouve}
Destination validée : ${t.nom} (${t.pays})${t.ville_aeroport ? ` · point d'arrivée probable : ${t.ville_aeroport}${t.iata ? ' (' + t.iata + ')' : ''}` : ''}.
RÈGLE ABSOLUE : ne cite que des quartiers, lieux et établissements RÉELS et vérifiables. En cas de doute, omets plutôt qu'inventer.
Si les données réelles incluent un trajet en train ou un taux de change, appuie ton choix de transport et tes conversions de budget DESSUS.
${answers ? 'RÉPONSES du voyageur à tes questions précédentes (à intégrer au plan) : ' + answers : ''}

MISSION : organise TOUT le voyage en suivant STRICTEMENT cet ordre d'analyse, chaque étape s'appuyant sur la précédente :
ÉTAPE 1 — LE LIEU EXACT : si la destination est un pays ou une zone large, choisis LA ville/zone précise où aller (et dis pourquoi). Sinon, confirme la ville et identifie le point d'arrivée concret (aéroport, gare).
CAS MULTI-PAYS / ITINÉRANT : si le voyage couvre PLUSIEURS pays ou villes (ex : « Italie puis Slovénie », roadtrip), découpe-le en 2-3 BASES maximum (villes-étapes dans un ordre géographique logique, JAMAIS de retour en arrière, minimum 2 nuits par base). Remplis alors "logement.etapes" (une entrée par base) et donne à chaque jour du programme son champ "base". Les trajets ENTRE bases (mode, durée, prix réels) vont dans "transport.details" et comptent dans le budget.
ÉTAPE 2 — LE TRANSPORT : compare avion / train / voiture sur QUATRE critères : pollution (utilise les chiffres CO₂ ci-dessus), temps de trajet porte-à-porte, prix, et conditions du voyageur (budget, enfants, transports à éviter, météo/saison). Tranche et justifie.
ÉTAPE 3 — LES LIEUX PRINCIPAUX : liste les 5 à 8 endroits incontournables de la ville/zone (monuments, quartiers, sites naturels), avec leur position relative (nord/sud/centre…).
ÉTAPE 4 — LE LOGEMENT : choisis le quartier en croisant DEUX critères : la proximité/liaison avec le point d'arrivée de l'étape 1-2 (aéroport/gare) ET l'accès facile aux lieux principaux de l'étape 3. Explique ce compromis.
ÉTAPE 5 — LE PROGRAMME : organise les jours en regroupant les lieux de l'étape 3 par PROXIMITÉ GÉOGRAPHIQUE et facilité d'accès depuis le logement (pas de zigzag). MÉTÉO : si la météo réelle annonce de la pluie, place les lieux INTÉRIEURS (musées, marchés couverts) sur les jours à risque et le plein air sur les meilleurs jours. JOUR 1 : l'heure d'arrivée est inconnue sauf indication du voyageur → ne planifie que l'après-midi/soirée (installation + 1 activité douce près du logement) ; dernier jour = départ (allégé).
ÉTAPE 6 — SUR PLACE & RÉSERVATIONS : indique comment se déplacer ENTRE les lieux (pass/carte de transport local avec prix réel, ou à pied), et liste ce qui doit se réserver À L'AVANCE (monuments avec quota, restaurants courus) avec le délai conseillé.
Reste STRICTEMENT dans le budget à chaque étape.
QUESTIONS : si un VRAI doute subsiste (notamment : un événement/festival a lieu pendant le séjour — le voyageur veut-il y assister ? ou un choix qui change le programme), pose 1-2 questions courtes dans "questions" avec un nombre PAIR d'options (2 ou 4). Sinon renvoie "questions":[].

Réponds UNIQUEMENT en JSON. Commence OBLIGATOIREMENT par le champ "analyse" (raisonnement interne, jamais montré) qui suit les 5 étapes DANS L'ORDRE :
{
 "analyse":{
   "etape1_lieu":"ville/zone choisie + point d'arrivée (aéroport/gare) et pourquoi",
   "etape2_transport":"comparaison chiffrée CO₂/durée/prix/conditions des 3 modes + le gagnant",
   "etape3_lieux":["5-8 lieux principaux avec position (ex : Alfama — centre-est)"],
   "etape4_logement":"quartier choisi = compromis arrivée ↔ lieux principaux, en 1-2 phrases",
   "etape5_programme":"logique de regroupement géographique des jours + gestion météo/jour 1, en 1-2 phrases",
   "etape6_surplace":"déplacements sur place + ce qui se réserve tôt, en 1 phrase"
 },
 "transport":{
   "mode":"avion" ou "train" ou "voiture",
   "pourquoi":"2 phrases : pourquoi CE transport vu le budget et les conditions",
   "details":"trajet concret : aéroports/gares/axes, durée, ce qu'il faut réserver",
   "prix_estime":"fourchette réaliste A/R par personne"
 },
 "logement":{
   "type":"1 ou 2 mots MAXIMUM : hôtel, appartement, auberge, villa…",
   "quartier":"quartier précis recommandé (voyage à 1 base) OU la base principale",
   "prix_nuit":"fourchette en € uniquement, ex 80-120€ (sans le mot nuit)",
   "pourquoi":"1 phrase",
   "etapes":[{"ville":"base","quartier":"quartier réel","nuits":nombre,"prix_nuit":"80-120€"}] — UNIQUEMENT si multi-bases, sinon omets ce champ
 },
 "programme":[{"jour":1,"resume":"le thème du jour en 1 ligne","lieux":["2-4 lieux RÉELS visités ce jour (monuments, quartiers, sites précis)"],"base":"ville-étape du jour — UNIQUEMENT si multi-bases"}],
 "budget":{"total":nombre entier en euros par personne,"repartition":"1 phrase : transport X€ + logement Y€ + vie sur place Z€"},
 "sur_place":"1-2 phrases : comment se déplacer entre les lieux (pass/carte de transport local avec prix, marche…)",
 "a_reserver":["2 à 4 réservations à faire À L'AVANCE, chacune avec le délai (ex : Tour de Belém — 1 semaine avant)"],
 "conseil_cle":"LE conseil le plus important pour ce voyage",
 "questions":[{"texte":"question courte","options":["2 ou 4 réponses courtes — nombre PAIR"]}]
}
Le programme couvre toute la durée (${p.days || 'du séjour'}), 1 ligne par jour.`;
  try{
    const tok = { court: 4096, normal: 8192, long: 12288 }[SET?.detail || 'normal'];
    let d = await gemini(prompt, true, tok, false, 0.45);
    if(SET?.verif !== false) d = await reviewPlan(d, prompt);   /* relecture croisée : réglable */
    state.cache.plan = d; save();
    renderPlan(d);
    syncModeFromPlan(d);
  }catch(e){
    const msg = e.name === 'AbortError' ? 'Délai dépassé — le serveur IA n’a pas répondu.' : 'Organisation impossible pour le moment.';
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML(msg, 'plan');
  }finally{
    clearInterval(msgTimer);
    _genBusy = false;
  }
}

/* --- Événements & festivals aux dates du voyage (light → Groq) --- */
let _evBusy = false;   /* évite deux recherches simultanées (prefetch + onglet) */
async function loadEvents(){
  const t = state.trip;
  if(!t) return;
  const zone = $('#zoneEvents');            /* peut être absent : on précharge quand même */
  const d = stayDates();
  const ck = `events_${t.nom}_${d ? d.in : 'flex'}`;
  if(state.cache[ck]){ renderEvents(state.cache[ck]); return; }
  if(_evBusy) return;
  _evBusy = true;
  _retryFns.events = loadEvents;
  if(zone) zone.innerHTML = loaderHTML('Recherche des événements…');
  const when = d ? `entre le ${d.in} et le ${d.out}` : (state.prefs?.when || 'à la période prévue');
  const prompt = `Tu es Acolite, connaisseur de ${t.nom} (${t.pays}). ${ctx()}
Liste les ÉVÉNEMENTS marquants à ${t.nom} pendant le séjour (${when}) : festivals, fêtes locales, grands marchés, matchs importants, expositions, ET jours fériés (musées/commerces fermés).
N'indique QUE des événements plausibles et récurrents à cette période. Si tu n'es pas certain d'une date, reste vague sur la date plutôt que d'inventer. Maximum 6.
Réponds UNIQUEMENT en JSON : {"events":[{"nom":"...","quand":"date ou période","type":"festival|fête|marché|sport|expo|férié","note":"1 phrase : intérêt ou impact pratique"}]}`;
  try{
    const { data } = await ai('light', prompt);
    state.cache[ck] = data; save();
    renderEvents(data);
  }catch(e){ if(e.message !== 'NO_KEY' && zone) zone.innerHTML = errHTML('Événements indisponibles pour le moment.', 'events'); }
  finally{ _evBusy = false; }
}
function renderEvents(data){
  const zone = $('#zoneEvents'); if(!zone) return;
  const ev = (data?.events || []).filter(e => e && e.nom);
  const ico = { festival:'🎪', 'fête':'🎉', fete:'🎉', marché:'🛍️', marche:'🛍️', sport:'⚽', expo:'🖼️', 'férié':'📛', ferie:'📛' };
  if(!ev.length){ zone.innerHTML = `<p class="hint" style="margin:0">Rien de notable repéré à ces dates — tu auras la ville pour toi 😉</p>`; return; }
  const prog = state.cache.plan?.programme || [];
  zone.innerHTML = ev.map((e, i) => {
    const deja = prog.some(j => (j.lieux || []).some(l => String(l).toLowerCase() === String(e.nom).toLowerCase()));
    return `<div class="item" style="align-items:flex-start">
      <div class="emo">${ico[String(e.type||'').toLowerCase()] || '📅'}</div>
      <div style="flex:1;min-width:0">
        <h4>${esc(e.nom)} ${e.quand ? `<span class="tag cyan" style="font-size:.66rem">${esc(e.quand)}</span>` : ''}</h4>
        <p class="hint" style="margin:2px 0 0">${esc(e.note || '')}</p>
      </div>
      <div class="side">${deja
        ? `<span class="tag ok" style="font-size:.62rem">✔ au programme</span>`
        : `<button class="btn sm ghost" data-addev="${i}" title="Ajouter cette visite au programme">➕ Ajouter</button>`}</div>
    </div>`;
  }).join('');
  state.cache._evList = ev; save();
}

/* Ajoute un événement à une journée du programme (celle qui correspond à sa date
   si on la reconnaît, sinon la 1ʳᵉ journée libre) */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-addev]');
  if(!b) return;
  const ev = (state.cache._evList || [])[+b.dataset.addev];
  const plan = state.cache.plan;
  if(!ev || !plan?.programme?.length){ toast('Génère d’abord le programme'); return; }
  const dts = stayDates();
  let cible = null;
  /* si l'événement porte une date du séjour → on vise CE jour-là */
  const m = String(ev.quand || '').match(/(\d{4})-(\d{2})-(\d{2})/) || String(ev.quand || '').match(/(\d{1,2})[\/\s]/);
  if(dts && m){
    const jourIso = m[0].length === 10 ? m[0] : null;
    if(jourIso){
      const idx = Math.round((new Date(jourIso) - new Date(dts.in)) / 86400000) + 1;
      cible = plan.programme.find(j => +j.jour === idx) || null;
    }
  }
  if(!cible) cible = plan.programme.reduce((a, j) => (j.lieux||[]).length < (a.lieux||[]).length ? j : a, plan.programme[0]);
  cible.lieux = [...(cible.lieux || []), ev.nom];
  delete state.cache.days?.[cible.jour];      /* le détail horaire doit être refait */
  save();
  renderPlan(plan);
  toast(`✔ « ${String(ev.nom).slice(0, 28)} » ajouté au jour ${cible.jour}`);
  setTimeout(() => document.querySelector(`[data-daybox="${CSS.escape(String(cible.jour))}"]`)?.closest('.day-block')?.scrollIntoView({ block:'center' }), 120);
});

/* ============================================================
   HOTELLOOK (Travelpayouts) — vrais prix d'hôtels dans l'app
   Endpoint cache.json : prix agrégés Booking/Expedia/Agoda.
   Repli automatique sur les liens comparateurs si indisponible.
============================================================ */
/* Hotellook (Travelpayouts) a été ARRÊTÉ par son éditeur : son API renvoie 404
   et aucun relais n'y change quoi que ce soit. On s'appuie donc sur l'IA, qui
   connaît de vrais établissements, + des liens de réservation pré-remplis. */
async function loadHotels(force = false){
  const zone = $('#zoneHotels');
  if(!zone) return;
  const t = state.trip;
  if(!t){ zone.innerHTML = `<p class="hint">Choisis d'abord une destination.</p>`; return; }
  const d = stayDates();
  const lg = state.cache.plan?.logement || {};
  const ville = lg.etapes?.[0]?.ville || cleanPlace(t.ville_aeroport) || t.nom;
  const quartier = lg.etapes?.[0]?.quartier || lg.quartier || '';
  const ck = `stay_${ville}_${quartier}_${d ? d.in : 'flex'}`;
  if(state.cache[ck] && !force){ renderHotels(state.cache[ck]); return; }
  _retryFns.hotels = () => loadHotels(true);
  zone.innerHTML = loaderHTML('Sélection des meilleurs logements…');
  const A = state.prefs?.adults || 2, K = state.prefs?.kids || 0;
  const nuits = d ? Math.max(1, Math.round((new Date(d.out) - new Date(d.in)) / 86400000)) : null;
  /* on ancre l'IA sur des établissements réels avant de lui demander de choisir.
     Si le géocodage ou Overpass échoue, osmCtx reste vide et rien ne change. */
  let osmCtx = '';
  try{
    const g = await geoPlace(quartier ? `${quartier} ${ville}` : ville, ccFor(t.pays)) || await geoPlace(ville, ccFor(t.pays));
    if(g) osmCtx = osmStayCtx(await osmStays(+g.latitude, +g.longitude));
  }catch(e){}
  const prompt = `Tu es Acolite, connaisseur de l'hébergement à ${ville}${quartier ? ` (quartier ${quartier})` : ''}. ${ctx()}${osmCtx}
Propose les 4 MEILLEURS hébergements RÉELS et vérifiables pour ce séjour${nuits ? ` de ${nuits} nuit(s)` : ''}, ${A} adulte(s)${K ? ` et ${K} enfant(s)` : ''}.
Uniquement des établissements qui EXISTENT vraiment (nom exact tel qu'il apparaît sur Booking). Priorité au quartier conseillé${quartier ? ` (${quartier})` : ''}, puis à la proximité des lieux du programme.
Varie les gammes en restant dans le budget. Classe-les du meilleur rapport qualité/prix au plus haut de gamme.
Réponds UNIQUEMENT en JSON :
{"hotels":[{"nom":"nom exact","type":"hôtel|appartement|auberge","quartier":"quartier réel","prix_nuit":"fourchette en € ex 90-130€","note":"ex 8,6/10 si connue sinon null","pourquoi":"1 phrase concrète : ce qui le rend adapté"}]}`;
  try{
    const { data } = await ai('light', prompt);
    const rows = (data?.hotels || []).filter(h => h && h.nom).slice(0, 4);
    if(!rows.length) throw new Error('vide');
    state.cache[ck] = rows; save();
    renderHotels(rows);
  }catch(e){
    if(e.message !== 'NO_KEY') zone.innerHTML = errHTML('Sélection indisponible — les comparateurs ci-dessous restent pré-remplis.', 'hotels');
  }
}

function renderHotels(rows){
  const zone = $('#zoneHotels'); if(!zone) return;
  const t = state.trip || {}, d = stayDates();
  const A = state.prefs?.adults || 2;
  const ICO = { hôtel:'🏨', hotel:'🏨', appartement:'🏠', auberge:'🎒', villa:'🏡' };
  zone.innerHTML = rows.map((h, i) => {
    /* lien Booking pré-rempli avec le NOM exact + tes dates → l'utilisateur voit le vrai prix du jour */
    const q = `${h.nom} ${h.quartier || ''} ${t.nom || ''}`.trim();
    const book = `https://www.booking.com/searchresults.fr.html?ss=${encodeURIComponent(q)}`
      + (d ? `&checkin=${d.in}&checkout=${d.out}` : '') + `&group_adults=${A}`;
    return `<div class="item" style="align-items:flex-start">
      <div class="emo">${ICO[String(h.type||'').toLowerCase()] || '🏨'}</div>
      <div style="flex:1;min-width:0">
        <h4>${esc(h.nom)}${i === 0 ? ' <span class="tag ok" style="font-size:.6rem">meilleur choix</span>' : ''}</h4>
        <p>${esc(h.pourquoi || '')}</p>
        <p class="hint" style="margin:3px 0 0">📍 ${esc(h.quartier || '—')}${h.note ? ` · ⭐ ${esc(String(h.note))}` : ''}</p>
        <a class="tl-loc" href="${esc(book)}" target="_blank" rel="noopener" style="margin-top:8px">🎫 Voir le prix &amp; réserver</a>
      </div>
      <div class="side"><span class="tag money">💶 ${esc(h.prix_nuit || '?')}</span></div>
    </div>`;
  }).join('') + `<p class="hint">Établissements réels sélectionnés pour ton quartier et ton budget. <strong>Le prix exact du jour s'affiche sur Booking</strong> (dates déjà pré-remplies) — vérifie avant de réserver.</p>`;
}

/* --- Liens logement pré-remplis (comparateurs + sites directs) --- */
function stayDates(){
  const p = state.prefs || {};
  if(!p.depart) return null;
  let days = 7;
  const m = String(p.days||'').match(/\d+/g);
  if(/semaine/i.test(p.days||'')) days = (m ? +m[m.length-1] : 1) * 7;
  else if(m) days = +m[m.length-1];
  days = Math.min(30, Math.max(2, days));
  return { in: p.depart, out: addDays(p.depart, days) };
}
function stayLinks(place){
  const p = state.prefs || {}, t = state.trip || {};
  const q = `${place ? place + ', ' : ''}${t.nom || ''}`;
  const d = stayDates();
  const A = p.adults || 2, K = p.kids || 0;
  const enc = encodeURIComponent;
  return {
    cozy:    `https://www.cozycozy.com/fr/s/${enc(((t.nom||'') + (t.pays ? '--' + t.pays : '')).toLowerCase())}`,
    hometogo:`https://www.hometogo.fr/search/?q=${enc(q)}${d ? `&arrival=${d.in}&departure=${d.out}` : ''}&adults=${A + K}`,
    booking: `https://www.booking.com/searchresults.fr.html?ss=${enc(q)}${d ? `&checkin=${d.in}&checkout=${d.out}` : ''}&group_adults=${A}${K ? `&group_children=${K}` : ''}`,
    airbnb:  `https://www.airbnb.fr/s/${enc(q)}/homes?adults=${A}${K ? `&children=${K}` : ''}${d ? `&checkin=${d.in}&checkout=${d.out}` : ''}`,
    abritel: `https://www.abritel.fr/search?destination=${enc(q)}${d ? `&startDate=${d.in}&endDate=${d.out}` : ''}&adults=${A}`
  };
}

/* ============================================================
   EMPREINTE CARBONE — estimation A/R par personne + alternative plus sobre
============================================================ */
const CO2_G_KM = { avion: 250, voiture: 190, train: 30, bus: 60 };   /* g CO₂ par km */
function carbonHTML(mode){
  const dist = state.cache._real?.dist;        /* km, aller simple (données réelles) */
  if(!dist || dist < 5) return '';
  const A = (state.prefs?.adults || 1) + (state.prefs?.kids || 0);
  const kg = m => {
    let f = CO2_G_KM[m] ?? CO2_G_KM.avion;
    if(m === 'voiture') f = f / Math.max(1, A);   /* la voiture se partage entre passagers */
    return Math.round(dist * 2 * f / 1000);
  };
  const m = ['avion','train','voiture'].includes(mode) ? mode : 'avion';
  const mine = kg(m);
  const best = ['train','voiture','avion'].filter(x => x !== m).map(x => ({ x, v: kg(x) })).sort((a,b) => a.v - b.v)[0];
  const gain = best && best.v < mine ? Math.round((1 - best.v / mine) * 100) : 0;
  const ICO = { avion:'✈️', train:'🚆', voiture:'🚗' };
  return `<div class="divider"></div>
    <h3 style="margin:0 0 4px">🌍 Empreinte carbone</h3>
    <p class="hint" style="margin:0 0 10px">Estimation aller-retour par personne, sur ~${Math.round(dist)} km de trajet.</p>
    <div class="item" style="align-items:flex-start">
      <div class="emo">${ICO[m] || '🌍'}</div>
      <div style="flex:1;min-width:0">
        <h4>${mine} kg de CO₂ · en ${esc(m)}</h4>
        <p class="hint" style="margin:2px 0 0">${gain
          ? `En ${esc(best.x)}, ce serait ~${best.v} kg — <strong>${gain} % de moins</strong>.`
          : `C'est déjà l'option la plus sobre sur ce trajet 👏`}</p>
      </div>
    </div>`;
}

/* ============================================================
   MODE « JOUR J » — pendant le voyage, la journée du jour en avant
============================================================ */
function todayHTML(){
  const d = stayDates(); if(!d) return '';
  const now = new Date(), start = new Date(d.in + 'T00:00:00'), end = new Date(d.out + 'T23:59:59');
  if(isNaN(start) || now < start || now > end) return '';
  const idx = Math.floor((now - start) / 86400000) + 1;
  const prog = state.cache.plan?.programme || [];
  const jr = prog.find(x => +x.jour === idx);
  return `<div class="card today-card">
    <h3 style="margin:0 0 4px">📍 Aujourd'hui — jour ${idx}${prog.length ? ` / ${prog.length}` : ''}</h3>
    ${jr ? `<h4 style="margin:6px 0 4px">${esc(jr.resume || '')}</h4>
        ${(jr.lieux || []).length ? `<p class="hint" style="margin:0">📍 ${jr.lieux.map(esc).join(' · ')}</p>` : ''}
        <button class="btn sm" data-daydetail="${esc(String(idx))}" style="margin-top:10px">🕘 Détailler ma journée</button>`
      : `<p class="sub" style="margin:0">Journée libre — profite bien !</p>`}
  </div>`;
}

/* ============================================================
   VUE « TON VOYAGE » — une barre d'onglets, un panneau à la fois.
   Fini le mur qui défile : chaque écran tient et se lit d'un coup.
============================================================ */
let _planTab = 'programme';                     /* onglet actif, mémorisé entre les rendus */
const _openDays = new Set();                    /* journées dépliées : survivent au changement d'onglet */
const _comDrafts = {};                          /* commentaires en cours de frappe, par journée */
/* Tout le contenu du voyage vit dans ces onglets, sous la carte « Ton
   voyage » qui ne garde que le résumé (trajet + conseil). */
const PLAN_TABS = [
  { id:'programme', ico:'📆', nom:'Programme' },
  { id:'logement',  ico:'🏨', nom:'Logement'  },
  { id:'transport', ico:'🚆', nom:'Transport' },
  { id:'events',    ico:'🎉', nom:'Événements'},
  { id:'budget',    ico:'💶', nom:'Budget' }
];

/* ---- Panneau 1 : le programme jour par jour ---- */
/* ---- Le programme jour par jour : cœur de la vue, toujours affiché ---- */
function panProgramme(d){
  const jours = d.programme || [];
  /* le conseil clé, remonté ici depuis l'ancienne carte « Ton voyage » */
  const tip = d.conseil_cle ? `<div class="key-tip"><span class="kt-emo">💡</span><p>${esc(d.conseil_cle)}</p></div>` : '';
  if(!jours.length) return tip + `<p class="hint">Aucune journée planifiée pour l'instant.</p>`;
  return tip
    + `<p class="pan-intro">Ton programme jour par jour. Une journée ne te va pas ? <strong>Vois-la heure par heure</strong>, ou demande à Acolite de la <strong>refaire</strong>.</p>`
    + jours.map(jr => `
      <div class="day-block">
        <div class="day-row">
          <span class="day-num">J${esc(String(jr.jour))}</span>
          <div class="day-txt">
            <h4>${esc(jr.resume || '')}</h4>
            ${jr.base ? `<span class="day-base">📍 ${esc(jr.base)}</span>` : ''}
            ${(jr.lieux||[]).length ? `<p>${jr.lieux.map(esc).join(' · ')}</p>` : ''}
          </div>
        </div>
        <div class="day-acts">
          <button class="day-act" data-daydetail="${esc(String(jr.jour))}">🕘 Voir heure par heure</button>
          <button class="day-act" data-planb="${esc(String(jr.jour))}">🔄 Refaire ce jour</button>
        </div>
        ${state.cache.maps?.[jr.jour] ? `<img class="daymap" src="${state.cache.maps[jr.jour]}" alt="Carte du jour ${esc(String(jr.jour))}">` : ''}
        ${collabBarHTML(jr.jour)}
        ${(() => {
          /* une journée dépliée le reste : on la ré-affiche depuis le cache */
          const ouvert = _openDays.has(String(jr.jour)) && state.cache.days?.[jr.jour];
          return `<div class="day-detail" data-daybox="${esc(String(jr.jour))}" data-open="${ouvert ? '1' : '0'}">${
            ouvert ? timelineHTML(state.cache.days[jr.jour]) : ''}</div>`;
        })()}
      </div>`).join('');
}

/* ---- Onglet Transport ---- */
function panTransport(d){
  const tr = d.transport || {};
  const icons = { avion:'✈️', train:'🚆', voiture:'🚗' };
  return `
    ${tripRouteHTML(d)}
    <div class="info-card">
      <div class="ic-head"><span>${icons[tr.mode]||'✈️'}</span><h4>Pourquoi ${esc(tr.mode||'ce transport')} ?</h4>${tr.prix_estime ? `<b>${esc(tr.prix_estime)}</b>` : ''}</div>
      <p>${esc(tr.pourquoi || '—')}</p>
      ${tr.details ? `<p class="ic-note">${esc(tr.details)}</p>` : ''}
    </div>
    ${d.sur_place ? `<div class="info-card">
      <div class="ic-head"><span>🚇</span><h4>Se déplacer sur place</h4></div><p>${esc(d.sur_place)}</p></div>` : ''}
    ${carbonHTML(tr.mode)}`;
}

/* ---- Onglet Logement ---- */
function panLogement(d){
  const lg = d.logement || {};
  return `
    <div class="pan-lead">
      <h4>${(lg.etapes||[]).length ? 'Voyage en étapes' : esc(String(lg.type||'Logement')) + (lg.quartier ? ' · ' + esc(lg.quartier) : '')}</h4>
      <p>${esc(lg.pourquoi || '—')}</p>
      ${(lg.etapes||[]).length
        ? `<div class="etapes">${lg.etapes.map(e=>`<div class="etape"><b>${esc(e.ville||'')}</b><span>${esc(e.quartier||'')} · ${esc(String(e.nuits??'?'))} nuit(s)${e.prix_nuit ? ' · ' + esc(e.prix_nuit) : ''}</span></div>`).join('')}</div>`
        : (lg.prix_nuit ? `<p class="pan-price">💶 ${esc(lg.prix_nuit)} / nuit</p>` : '')}
    </div>
    <h5 class="pan-sub">Où dormir concrètement</h5>
    <div id="zoneHotels"></div>`;
}

/* ---- Onglet Événements : plus de bouton, la recherche se fait toute seule
   pendant l'organisation du voyage (comme les prix réels) ---- */
function panEvents(){
  const t = state.trip, d = stayDates();
  const ck = t ? `events_${t.nom}_${d ? d.in : 'flex'}` : null;
  const contenu = (ck && state.cache[ck]) ? '' : loaderHTML('Recherche des événements…');
  return `
    <p class="pan-intro">Festivals, fêtes, marchés et jours fériés pendant ton séjour. Ajoute ceux qui te tentent à ton programme.</p>
    <div id="zoneEvents">${contenu}</div>`;
}

/* ---- Onglet Budget ---- */
function panBudget(d){
  const bd = d.budget || {};
  const A = (state.prefs?.adults||1) + (state.prefs?.kids||0);
  const btNum = parseInt((String(bd.total).replace(/\s/g,'').match(/\d+/)||[])[0], 10) || 0;
  return `
    <div class="info-card">
      <div class="ic-head"><span>💶</span><h4>Budget estimé</h4><b>${esc(String(bd.total||'?'))} € / pers.</b></div>
      ${A > 1 && btNum ? `<p class="ic-note">${btNum * A} € au total pour ${A} personnes</p>` : ''}
      ${bd.repartition ? `<p>${esc(bd.repartition)}</p>` : ''}
    </div>
    ${(d.a_reserver||[]).length ? `<div class="info-card">
      <div class="ic-head"><span>🎟️</span><h4>À réserver tôt</h4></div>
      ${d.a_reserver.map(r=>`<p class="ic-todo">${esc(r)}</p>`).join('')}</div>` : ''}`;
}

/* Le bandeau de trajet : il vit désormais en tête de l'onglet Transport
   (la carte « Ton voyage » a été retirée). #realPrice y est rempli par
   autoRealPrices dès que l'onglet Transport s'affiche. */
function tripRouteHTML(d){
  const icons = { avion:'✈️', train:'🚆', voiture:'🚗' };
  const tr = d.transport || {}, bd = d.budget || {};
  const dts = stayDates();
  const nuits = dts ? Math.max(1, Math.round((new Date(dts.out) - new Date(dts.in)) / 86400000)) : null;
  const dep = cleanPlace(state.prefs?.from || '') || 'Départ';
  const arr = String(state.trip?.nom || '').split('→').pop().trim() || '—';
  return `
    <div class="trip-route">
      <div class="tr-top">
        <span class="tr-mode">${icons[tr.mode]||'✈️'}</span>
        <div class="tr-journey">
          <span class="tr-pt">${esc(dep)}</span>
          <span class="tr-arrow" aria-hidden="true">→</span>
          <span class="tr-pt">${esc(arr)}</span>
        </div>
        ${d._checked ? `<span class="tr-check" title="Plan relu par une 2ᵉ IA">✔</span>` : ''}
      </div>
      <div class="tr-facts">
        <span class="tr-fact">${icons[tr.mode]||'✈️'} ${esc(String(tr.mode||'—').toUpperCase())}</span>
        ${tr.prix_estime ? `<span class="tr-fact">💶 ${esc(tr.prix_estime)}</span>` : ''}
        ${nuits ? `<span class="tr-fact">🌙 ${nuits} nuit${nuits>1?'s':''}</span>` : ''}
        ${bd.total ? `<span class="tr-fact">👛 ${esc(String(bd.total))} €/pers</span>` : ''}
      </div>
      <div class="tr-real" id="realPrice"></div>
    </div>`;
}

function renderPlan(d){
  /* #zonePlan ne porte plus que l'encart « aujourd'hui » (vide hors séjour) :
     le trajet est passé dans l'onglet Transport, le conseil dans Programme. */
  const zp = $('#zonePlan'); if(zp) zp.innerHTML = todayHTML();
  renderSections(d);
  refreshPasses();
  startWx();
  /* on cherche les événements dès l'organisation du voyage : ils sont prêts
     (en cache) quand l'utilisateur ouvre l'onglet, sans bouton à presser */
  loadEvents();
}

/* La barre d'onglets et son panneau, dans leur carte à part sous le voyage.
   Séparé de renderPlan pour qu'un changement d'onglet ne re-rende JAMAIS le
   programme (sinon on perdrait les journées dépliées et les commentaires
   en cours de frappe). */
function renderSections(d){
  const panels = { programme: panProgramme, transport: panTransport, logement: panLogement, events: panEvents, budget: panBudget };
  const zone = $('#zoneSections');
  if(!zone) return;
  zone.innerHTML = `
    <div class="card sections-card">
      <div class="plan-tabs" role="tablist" aria-label="Détails du voyage">
        ${PLAN_TABS.map(t => `<button class="plan-tab${t.id === _planTab ? ' on' : ''}" data-plantab="${t.id}" role="tab" aria-selected="${t.id === _planTab}">
          <span>${t.ico}</span>${esc(t.nom)}</button>`).join('')}
      </div>
      <div class="plan-panel">${(panels[_planTab] || panTransport)(d)}</div>
    </div>`;
  if(_planTab === 'logement') loadHotels();
  if(_planTab === 'events') loadEvents();
  /* le bandeau trajet (avec #realPrice) est dans l'onglet Transport : on
     déclenche le prix réel quand cet onglet s'affiche. On passe le mode DU
     PLAN (avion/train/voiture), pas state.mode qui a un autre vocabulaire. */
  if(_planTab === 'transport') autoRealPrices(d.transport?.mode);
}

/* changement d'onglet : on ne re-rend QUE la barre des détails */
function goPlanTab(id, focus){
  if(!state.cache.plan) return;
  _planTab = id;
  renderSections(state.cache.plan);
  if(focus) $(`[data-plantab="${id}"]`)?.focus();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-plantab]');
  if(!b) return;
  goPlanTab(b.dataset.plantab);
  $('.plan-tabs')?.scrollIntoView({ block:'nearest' });
});
/* navigation clavier ← → (promise par role="tablist", donc on la tient) */
document.addEventListener('keydown', e => {
  const b = e.target.closest?.('[data-plantab]');
  if(!b) return;
  const ids = PLAN_TABS.map(t => t.id);
  const i = ids.indexOf(b.dataset.plantab);
  let n = -1;
  if(e.key === 'ArrowRight') n = (i + 1) % ids.length;
  else if(e.key === 'ArrowLeft') n = (i - 1 + ids.length) % ids.length;
  else if(e.key === 'Home') n = 0;
  else if(e.key === 'End') n = ids.length - 1;
  if(n < 0) return;
  e.preventDefault();
  goPlanTab(ids[n], true);
});

addEventListener('resize', () => { if($('#zonePlan')?.querySelector('.plan-stat')) fitStats(); });

document.addEventListener('click', e => {
  if(e.target.id === 'btnJournal'){
    const txt = $('#jrText').value.trim();
    if(!txt && !_jrPhotos.length){ toast('Écris quelque chose ou ajoute une photo 😉'); return; }
    const j = getJournal();
    const k = _jrKey();
    j[k] = j[k] || [];
    j[k].push({ jour: +$('#jrDay').value || 1, texte: txt.slice(0, 1200), photos: _jrPhotos, ts: Date.now() });
    if(saveJournal(j)){
      renderJournal();
      toast('📓 Souvenir enregistré');
    }
    return;
  }
  const del = e.target.closest('[data-jr]');
  if(del){
    if(!confirm('Supprimer ce souvenir ?')) return;
    const j = getJournal(), k = _jrKey();
    const sorted = (j[k]||[]).slice().sort((a,b) => a.jour - b.jour || a.ts - b.ts);
    const victim = sorted[+del.dataset.jr];
    j[k] = (j[k]||[]).filter(x => x.ts !== victim.ts);
    saveJournal(j); renderJournal();
  }
});


/* ============================================================
   ALERTE PRIX — mémorise le prix du vol et signale les baisses
============================================================ */
const LS_PRICES = 'acolite_prices';
function trackPrice(prix, source){
  if(!state.trip || !prix) return;
  let all;
  try{ all = JSON.parse(localStorage.getItem(LS_PRICES)) || {}; }catch(e){ all = {}; }
  const k = `${state.trip.nom}_${state.prefs?.depart || 'flex'}`;
  const hist = all[k] || [];
  const last = hist[hist.length - 1];
  /* on n'enregistre qu'un point par jour et par source */
  const today = new Date().toISOString().slice(0, 10);
  if(!last || last.d !== today || last.p !== prix){
    hist.push({ p: prix, d: today, s: source });
    all[k] = hist.slice(-30);
    try{ localStorage.setItem(LS_PRICES, JSON.stringify(all)); }catch(e){}
  }
  /* comparaison avec le meilleur prix connu (hors aujourd'hui) */
  const anciens = hist.filter(h => h.d !== today);
  if(!anciens.length) return;
  const ref = Math.min(...anciens.map(h => h.p));
  const diff = prix - ref;
  const bar = $('#priceAlert');
  if(!bar) return;
  if(diff <= -5){
    bar.style.display = 'block';
    bar.className = 'item';
    bar.innerHTML = `<div class="emo">📉</div><p style="flex:1;font-weight:800">Bonne nouvelle : le vol a <strong>baissé de ${Math.abs(Math.round(diff))} €</strong> depuis ta dernière recherche (${ref} € → ${prix} €). C'est peut-être le moment de réserver.</p>`;
  } else if(diff >= 15){
    bar.style.display = 'block';
    bar.className = 'item';
    bar.innerHTML = `<div class="emo">📈</div><p style="flex:1;font-weight:800">Le vol a <strong>augmenté de ${Math.round(diff)} €</strong> depuis ta dernière recherche (${ref} € → ${prix} €). Les prix montent à l'approche du départ — ne tarde pas trop.</p>`;
  } else {
    bar.style.display = 'none';
  }
}


/* --- PLAN B : régénère UNE seule journée (sans tout refaire) --- */
async function planB(jour){
  const d = state.cache.plan;
  if(!d?.programme) return;
  const jr = d.programme.find(x => +x.jour === +jour);
  if(!jr) return;
  const raison = prompt(`Pourquoi refaire le jour ${jour} ?\n(ex : il pleut, on est fatigués, trop cher, déjà vu…)`, 'il pleut');
  if(raison === null) return;
  toast('🔄 Nouvelle version du jour ' + jour + '…');
  try{
    const autres = d.programme.filter(x => +x.jour !== +jour).map(x => `J${x.jour} : ${x.resume} (${(x.lieux||[]).join(', ')})`).join('\n');
    const R = state.cache._real || {};
    const nd = await gemini(`Tu réorganises UNE SEULE journée d'un voyage à ${state.trip.nom}, ${state.trip.pays}.

JOUR À REFAIRE : jour ${jour} — actuellement "${jr.resume}" (${(jr.lieux||[]).join(', ')}).
RAISON DU CHANGEMENT : "${String(raison).slice(0,160)}"
${R.meteo ? `MÉTÉO RÉELLE : ${R.meteo}` : ''}
${R.feries ? `JOURS FÉRIÉS : ${R.feries}` : ''}

AUTRES JOURNÉES (ne les répète PAS, ne propose PAS les mêmes lieux) :
${autres || 'aucune'}

Propose une nouvelle journée qui répond à la raison donnée (s'il pleut → activités d'intérieur ; fatigue → rythme doux ; trop cher → gratuit).
Uniquement des lieux qui EXISTENT VRAIMENT, regroupés dans le même quartier.
Réponds UNIQUEMENT en JSON : {"jour":${jour},"resume":"phrase courte","lieux":["Lieu 1","Lieu 2","Lieu 3"]}`, true, 900, false, 0.6);
    if(!nd?.resume) throw new Error('vide');
    d.programme = d.programme.map(x => +x.jour === +jour ? { jour:+jour, resume:nd.resume, lieux:nd.lieux || [] } : x);
    state.cache.plan = d; save();
    renderPlan(d);
    toast('✅ Jour ' + jour + ' réorganisé');
  }catch(e){ toast('❌ Impossible de refaire cette journée'); }
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-planb]');
  if(b) planB(b.dataset.planb);
});

/* ============================================================
   TABLEAU PARTAGÉ — votes 👍/👎 et commentaires par journée.
   Pensé pour planifier À PLUSIEURS : l'état voyage avec la
   sauvegarde-fichier / l'import, chacun ajoute ses votes.
============================================================ */
function boardState(){
  state.board = state.board || { votes:{}, comments:{} };
  state.board.votes = state.board.votes || {};
  state.board.comments = state.board.comments || {};
  return state.board;
}
const voterName = () => (getUser()?.pseudo || 'Moi').slice(0, 20);
function collabBarHTML(jour){
  const b = boardState(), j = String(jour);
  const votes = b.votes[j] || {};
  const up = Object.values(votes).filter(v => v === 'up').length;
  const down = Object.values(votes).filter(v => v === 'down').length;
  const mine = votes[voterName()];
  const coms = b.comments[j] || [];
  return `<div class="day-collab">
    <button class="cvote ${mine === 'up' ? 'on' : ''}" data-vote="${esc(j)}:up" title="J'aime cette journée">👍 <b>${up}</b></button>
    <button class="cvote ${mine === 'down' ? 'on' : ''}" data-vote="${esc(j)}:down" title="Pas fan de cette journée">👎 <b>${down}</b></button>
    <button class="cvote" data-comtoggle="${esc(j)}" title="Commentaires de l'équipe">💬 <b>${coms.length}</b></button>
    <span class="collab-hint">planifiez à plusieurs</span>
  </div>
  <div class="day-comments" data-combox="${esc(j)}" hidden>
    <div class="com-list">${coms.map(c => `<p><b>${esc(c.who)}</b> ${esc(c.txt)}</p>`).join('') || '<p class="hint" style="margin:0">Aucun commentaire — lance la discussion !</p>'}</div>
    <div class="com-bar">
      <input class="com-inp" data-cominp="${esc(j)}" maxlength="180" value="${esc(_comDrafts[j] || '')}" placeholder="ex : plutôt le matin ? on ajoute un resto ?">
      <button class="btn sm" data-comsend="${esc(j)}">Envoyer</button>
    </div>
  </div>`;
}
function refreshCollabBar(jour){
  const j = String(jour);
  const block = document.querySelector(`[data-daybox="${CSS.escape(j)}"]`)?.closest('.day-block');
  if(!block) return;
  const bar = block.querySelector('.day-collab'), box = block.querySelector('.day-comments');
  if(!bar || !box) return;
  const wasOpen = !box.hidden;
  const draft = box.querySelector('.com-inp')?.value || '';   /* ne perd pas un commentaire en cours de frappe */
  const tmp = document.createElement('div'); tmp.innerHTML = collabBarHTML(j);
  bar.replaceWith(tmp.children[0]);
  box.replaceWith(tmp.children[0]);
  if(wasOpen){ const nb = block.querySelector('.day-comments'); if(nb) nb.hidden = false; }
  if(draft){ const ni = block.querySelector('.com-inp'); if(ni) ni.value = draft; }
}
document.addEventListener('click', e => {
  const v = e.target.closest('[data-vote]');
  if(v){
    const [j, dir] = v.dataset.vote.split(':');
    const b = boardState(); b.votes[j] = b.votes[j] || {};
    const me = voterName();
    b.votes[j][me] = b.votes[j][me] === dir ? undefined : dir;   /* re-clic = retire le vote */
    if(!b.votes[j][me]) delete b.votes[j][me];
    save(); refreshCollabBar(j);
    return;
  }
  const ct = e.target.closest('[data-comtoggle]');
  if(ct){
    const box = document.querySelector(`[data-combox="${CSS.escape(ct.dataset.comtoggle)}"]`);
    if(box) box.hidden = !box.hidden;
    return;
  }
  const cs = e.target.closest('[data-comsend]');
  if(cs){
    const j = cs.dataset.comsend;
    const inp = document.querySelector(`[data-cominp="${CSS.escape(j)}"]`);
    const txt = (inp?.value || '').trim();
    if(!txt) return;
    const b = boardState(); b.comments[j] = b.comments[j] || [];
    b.comments[j].push({ who: voterName(), txt: txt.slice(0, 180), ts: Date.now() });
    delete _comDrafts[j];          /* envoyé → le brouillon n'a plus lieu d'être */
    save(); refreshCollabBar(j);
    const box = document.querySelector(`[data-combox="${CSS.escape(j)}"]`); if(box) box.hidden = false;
    toast('💬 Commentaire ajouté — partage la sauvegarde à ton co-voyageur');
  }
});
document.addEventListener('keydown', e => {
  if(e.key === 'Enter' && e.target.matches?.('[data-cominp]')){
    document.querySelector(`[data-comsend="${CSS.escape(e.target.dataset.cominp)}"]`)?.click();
  }
});
/* garde le texte en cours de frappe même si on change d'onglet */
document.addEventListener('input', e => {
  if(e.target.matches?.('[data-cominp]')) _comDrafts[e.target.dataset.cominp] = e.target.value;
});

/* ============================================================
   PROGRAMME HEURE PAR HEURE — détaille une journée du plan
============================================================ */
async function loadDayDetail(jour){
  const t = state.trip; if(!t) return;
  const box = document.querySelector(`[data-daybox="${jour}"]`);
  if(!box) return;
  if(box.dataset.open === '1'){ box.innerHTML = ''; box.dataset.open = '0'; _openDays.delete(String(jour)); return; }  /* re-clic = replie */
  box.dataset.open = '1';
  _openDays.add(String(jour));   /* mémorisé : survit à un changement d'onglet */
  state.cache.days = state.cache.days || {};
  if(state.cache.days[jour]){ box.innerHTML = timelineHTML(state.cache.days[jour]); return; }
  box.innerHTML = loaderHTML('Construction de la journée heure par heure…');
  const jr = (state.cache.plan?.programme || []).find(x => String(x.jour) === String(jour)) || {};
  const pace = { doux:'doux (peu d\'activités, du temps libre)', equilibre:'équilibré (2-3 activités)', intense:'intense (programme dense)' }[SET?.rythme] || 'équilibré';
  const prompt = `Tu es Acolite, guide local expert de ${t.nom} (${t.pays}). ${ctx()}
Détaille HEURE PAR HEURE le JOUR ${jour} du séjour.
Thème de la journée : ${jr.resume || 'à toi de le définir'}
Lieux déjà prévus ce jour (à intégrer, dans un ordre logique et géographiquement cohérent) : ${(jr.lieux || []).join(', ') || 'à toi de choisir'}
Rythme souhaité : ${pace}.
Programme RÉALISTE : horaires cohérents, temps de trajet inclus, pauses repas. Uniquement des lieux RÉELS et vérifiables.
Réponds UNIQUEMENT en JSON :
{"titre_journee":"thème du jour","etapes":[{"heure":"09:00","titre":"...","description":"1-2 phrases concrètes avec un vrai conseil","lieu":"nom précis pour Google Maps ou null","type":"visite|repas|pause|trajet"}]}
Entre 6 et 9 étapes.`;
  try{
    const d = await gemini(prompt, true, 4096, false, 0.5);
    state.cache.days[jour] = d; save();
    box.innerHTML = timelineHTML(d);
  }catch(e){
    if(e.message !== 'NO_KEY') box.innerHTML = errHTML('Journée indisponible pour le moment.', 'day' + jour);
    _retryFns['day' + jour] = () => { box.dataset.open = '0'; loadDayDetail(jour); };
  }
}
document.addEventListener('click', e => {
  const d = e.target.closest('[data-daydetail]');
  if(d) loadDayDetail(d.dataset.daydetail);
});

/* --- Accordéons + boutons "changer de destination" (CSP stricte : aucun onclick inline) --- */
document.addEventListener('click', e => {
  const acc = e.target.closest('[data-acc]');
  if(acc){ acc.parentElement.classList.toggle('open'); return; }
  if(e.target.closest('[data-changedest]')) changeDest();
});


/* --- Pop-up Questions : réponses obligatoires avant le voyage final --- */
let _qsList = [];
/* Garantit un nombre PAIR de choix par question (2 ou 4) : on retire le dernier si le compte est impair */
function evenOptions(opts){
  const o = (opts || []).filter(x => x != null && String(x).trim() !== '').slice(0, 4);
  if(o.length % 2 === 1) o.pop();          /* 3 → 2, 1 → 0 */
  return o;
}
function openQsPopup(qs){
  _qsList = qs.map(q => ({ ...q, options: evenOptions(q.options) }))
             .filter(q => q.options.length >= 2)   /* une question sans au moins 2 choix pairs n'a pas de sens */
             .slice(0, 3);
  if(!_qsList.length){ $('#ovQs').classList.remove('show'); $('#zoneQs').innerHTML = ''; return; }
  const pg = $('#qsProg');
  if(pg) pg.innerHTML = _qsList.map(() => '<i></i>').join('');
  $('#zoneQs').innerHTML = _qsList.map((q, i) => `
    <h4 style="margin:14px 0 6px;font-family:'Sora'">${i+1}. ${esc(q.texte)}</h4>
    <div class="chips even" data-qi="${i}">${q.options.map(o=>`<div class="chip qsopt" data-qi="${i}" data-a="${esc(o)}">${esc(o)}</div>`).join('')}</div>`).join('');
  $('#btnQsGo').disabled = true;
  $('#ovQs').classList.add('show');
}
document.addEventListener('click', e => {
  const c = e.target.closest('.chip.qsopt');
  if(c){
    $$(`.chip.qsopt[data-qi="${c.dataset.qi}"]`).forEach(x => x.classList.remove('on'));
    c.classList.add('on');
    const reste = $$('#zoneQs .chips').filter(g => !g.querySelector('.on')).length;
    $('#btnQsGo').disabled = reste > 0;
    $$('#qsProg i').forEach((el, i) => el.classList.toggle('on', !!$$('#zoneQs .chips')[i]?.querySelector('.on')));
    const btn = $('#btnQsGo');
    if(btn) btn.textContent = reste ? `Encore ${reste} question${reste > 1 ? 's' : ''}…` : '✅ Affiner mes propositions';
    return;
  }
  if(e.target.id === 'btnQsGo'){
    $$('#zoneQs .chip.qsopt.on').forEach(c2 => {
      state.propAnswers = state.propAnswers || [];
      state.propAnswers.push(`${_qsList[+c2.dataset.qi]?.texte} → ${c2.dataset.a}`.slice(0, 200));
    });
    state.propAnswers = (state.propAnswers || []).slice(-12);
    state._qsDone = true; save();
    $('#ovQs').classList.remove('show');
    toast('🎯 Merci — Acolite affine tes propositions…');
    proposeTrips(state.propAnswers.join(' · '));   /* on relance les PROPOSITIONS avec les réponses */
    return;
  }
  if(e.target.id === 'btnQsSkip'){
    state._qsDone = true; save();
    $('#ovQs').classList.remove('show');
    toast('Ok, Acolite garde ses propositions actuelles 👍');
  }
});

/* --- Pop-up Réservation : tous les liens + prix réels d'hôtels --- */
function buildResa(){
  const t = state.trip || {}, p = state.prefs || {};
  const enc = encodeURIComponent;
  const L = stayLinks(state.cache.plan?.logement?.quartier || '');
  const d = stayDates();
  const q = `${p.from||'Paris'} ${t.nom||''}`;
  const gf = `https://www.google.com/travel/flights?q=${enc('vols ' + q + (d ? ' le ' + d.in : ''))}`;
  const sky = `https://www.skyscanner.fr/`;
  const rya = `https://www.ryanair.com/fr/fr`;
  const sncf = `https://www.sncf-connect.com/`;
  const trl = `https://www.thetrainline.com/fr`;
  const omio = `https://www.omio.fr/`;
  const car = `https://www.google.com/maps/dir/${enc(p.from||'Paris')}/${enc((t.nom||'')+', '+(t.pays||''))}`;
  const gyg = `https://www.getyourguide.fr/s/?q=${enc(t.nom||'')}`;
  const cvt = `https://www.civitatis.com/fr/recherche/?q=${enc(t.nom||'')}`;
  const ta  = `https://www.tripadvisor.fr/Search?q=${enc(t.nom||'')}`;
  const B = (href, label, solid) => `<a class="btn sm${solid ? '' : ' ghost'}" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
  $('#zoneResa').innerHTML = `
    <h3 style="margin:6px 0 8px">✈️ Billets de transport</h3>
    <div class="row">${B(gf,'Google Flights',1)}${B(sky,'Skyscanner')}${B(rya,'Ryanair')}</div>
    <div class="row" style="margin-top:8px">${B(sncf,'🚆 SNCF Connect',1)}${B(trl,'Trainline')}${B(omio,'Omio')}</div>
    <div class="row" style="margin-top:8px">${B(car,'🚗 Itinéraire voiture (Maps)')}</div>
    <div class="divider"></div>
    <h3 style="margin:0 0 8px">🏨 Logement — prix réels</h3>
    <div id="zoneHotels"></div>
    <h3 style="margin:14px 0 8px">🔎 Comparer tous les logements</h3>
    <div class="row">${B(L.cozy,'Cozycozy — comparateur',1)}${B(L.hometogo,'HomeToGo — comparateur',1)}</div>
    <div class="row" style="margin-top:8px">${B(L.booking,'Booking')}${B(L.airbnb,'Airbnb')}${B(L.abritel,'Abritel')}</div>
    <p class="hint">Recherches pré-remplies : ${esc(state.cache.plan?.logement?.quartier || t.nom || '')}${d ? ', du ' + esc(d.in) + ' au ' + esc(d.out) : ''}, ${p.adults||2} adulte(s)${p.kids ? ' + ' + p.kids + ' enfant(s)' : ''}.</p>
    <div class="divider"></div>
    <h3 style="margin:0 0 8px">🎡 Activités & visites</h3>
    <div class="row">${B(gyg,'GetYourGuide',1)}${B(cvt,'Civitatis')}${B(ta,'Tripadvisor')}</div>`;
}

const _e1 = $('#btnOpenResa'); if(_e1) _e1.onclick = () => {
  if(!state.trip){ toast('Choisis d’abord un voyage 😉'); return; }
  buildResa();
  $('#ovResa').classList.add('show');
  loadHotels();
};
const _e2 = $('#btnOpenSim'); if(_e2) _e2.onclick = () => {
  if(!state.trip){ toast('Choisis d’abord un voyage 😉'); return; }
  $('#ovSim').classList.add('show');
  loadTransport();
};
document.addEventListener('click', e => {
  /* la barrière de confidentialité obligatoire ne se ferme NI par la croix
     (absente) NI par un clic sur le fond : il faut accepter */
  if(_privacyGate && e.target.closest('#ovPrivacy')) return;
  const c = e.target.closest('[data-close]');
  if(c){ $('#' + c.dataset.close).classList.remove('show'); return; }
  if(e.target.classList?.contains('overlay')) e.target.classList.remove('show');
});

function planValidate(){
  const d = state.cache.plan;
  if(!d){ toast("Le plan n'est pas encore prêt"); return; }
  const map = {avion:'plane', train:'train', voiture:'car'};
  state.mode = map[d.transport?.mode] || 'plane';
  state.modeManual = false;
  state.planOk = true;
  delete state.cache['transport_' + state.mode];
  save();
  loadTransport();
  toast(`Plan validé — billets ${d.transport?.mode||''} juste en dessous 🎫`);
  $('#zoneTransport').scrollIntoView({behavior:'smooth', block:'start'});
}

/* Délégation : boutons du plan (la zone est re-rendue) */
document.addEventListener('click', e => {
  if(e.target.id === 'btnPlanOk'){ planValidate(); return; }
  if(e.target.id === 'btnPlanRedo' || e.target.id === 'btnPlanRedo2'){ loadPlan(true); return; }
  const q = e.target.closest('.chip.planq');
  if(q){
    state.planAnswers = state.planAnswers || [];
    state.planAnswers.push(`${q.dataset.q} → ${q.dataset.a}`.slice(0,200));
    state.planAnswers = state.planAnswers.slice(-12);
    save();
    toast('Réponse prise en compte ✔');
    loadPlan(true);
  }
});

/* ============================================================
   ÉTAPE 3 — Y ALLER  (Gemini · heavy)
============================================================ */
const _e3 = $('#tgPlane'); if(_e3) _e3.onclick = () => setMode('plane');
const _e4 = $('#tgCar'); if(_e4) _e4.onclick   = () => setMode('car');
const _e5 = $('#tgTrain'); if(_e5) _e5.onclick = () => setMode('train');
function setMode(m){
  state.mode = m; state.modeManual = true; save();
  $('#tgPlane').classList.toggle('on', m==='plane');
  $('#tgCar').classList.toggle('on', m==='car');
  $('#tgTrain').classList.toggle('on', m==='train');
  loadTransport();
}

async function loadTransport(){
  const zone = $('#zoneTransport');
  const t = state.trip, p = state.prefs;
  const key = 'transport_' + state.mode;
  $('#tgPlane').classList.toggle('on', state.mode==='plane');
  $('#tgCar').classList.toggle('on', state.mode==='car');
  $('#tgTrain').classList.toggle('on', state.mode==='train');
  if(state.cache[key]){ renderTransport(state.cache[key]); return; }
  const msgs = {plane:'Analyse des vols…', car:'Calcul de la route…', train:'Recherche des lignes ferroviaires…'};
  zone.innerHTML = loaderHTML(msgs[state.mode]);

  let prompt;
  if(state.mode === 'plane'){
    prompt = `Tu es Acolite, expert voyage. ${ctx()}
Le voyageur part en AVION de ${p.from} vers ${t.nom} (${t.pays}).
Réponds UNIQUEMENT en JSON :
{
 "aeroport_depart":"nom + code IATA le plus pratique depuis ${p.from}",
 "iata_depart":"code IATA seul, ex CDG",
 "aeroport_arrivee":"nom + code IATA",
 "iata_arrivee":"code IATA seul",
 "duree_vol":"ex: 2h15 direct",
 "prix_estime":"fourchette A/R réaliste pour cette période",
 "compagnies":["3-4 compagnies pertinentes sur cette ligne"],
 "conseils":["4 conseils concrets : quand réserver, quel jour partir moins cher, bagages, transfert aéroport→centre-ville avec prix"]
}`;
  } else if(state.mode === 'car'){
    prompt = `Tu es Acolite, expert voyage. ${ctx()}
Le voyageur part en VOITURE de ${p.from} vers ${t.nom} (${t.pays}).
Réponds UNIQUEMENT en JSON :
{
 "distance":"ex: 950 km",
 "duree":"ex: 8h30 sans pause",
 "cout_estime":"carburant + péages, fourchette réaliste",
 "itineraire_resume":"axes principaux, ex: A6 puis A7…",
 "pauses":["2-3 super étapes sur la route (ville + pourquoi s'y arrêter)"],
 "conseils":["4 conseils concrets : vignettes/péages du pays, meilleure heure de départ, stationnement sur place, points de vigilance"]
}`;
  } else {
    prompt = `Tu es Acolite, expert voyage. ${ctx()}
Le voyageur part en TRAIN de ${p.from} vers ${t.nom} (${t.pays}).
Réponds UNIQUEMENT en JSON :
{
 "faisable":"oui" ou "non" ou "compliqué",
 "trajet":"description du trajet type : gares, correspondances, ex: Paris Gare de Lyon → Milan (Frecciarossa) → …",
 "duree":"durée totale estimée",
 "prix_estime":"fourchette réaliste A/R",
 "compagnies":["compagnies ferroviaires concernées"],
 "conseils":["4 conseils : quand réserver, pass éventuels (Interrail…), trains de nuit s'il y en a, alternative si le train est peu adapté"]
}`;
  }

  try{
    const d = await gemini(prompt);
    state.cache[key] = d; save();
    renderTransport(d);
  }catch(e){
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Analyse impossible pour le moment.');
  }
}

function renderTransport(d){
  const zone = $('#zoneTransport');
  const t = state.trip, p = state.prefs;
  if(state.mode === 'plane'){
    const from = d.iata_depart || 'PAR', to = d.iata_arrivee || (t.iata||'');
    const gf  = `https://www.google.com/travel/flights?q=${encodeURIComponent(`vols de ${p.from} à ${t.ville_aeroport || t.nom}`)}&hl=fr`;
    const ky  = `https://www.kayak.fr/flights/${encodeURIComponent(from)}-${encodeURIComponent(to)}`;
    const sky = `https://www.skyscanner.fr/transport/vols/${encodeURIComponent(from.toLowerCase())}/${encodeURIComponent(to.toLowerCase())}/`;
    zone.innerHTML = `
      <div class="grid" style="margin-bottom:14px">
        <div class="item"><div class="emo">🛫</div><div><h4>Départ</h4><p>${esc(d.aeroport_depart)}</p></div></div>
        <div class="item"><div class="emo">🛬</div><div><h4>Arrivée</h4><p>${esc(d.aeroport_arrivee)}</p></div></div>
        <div class="item"><div class="emo">⏱</div><div><h4>Durée</h4><p>${esc(d.duree_vol)}</p></div></div>
        <div class="item"><div class="emo">💶</div><div><h4>Prix estimé A/R</h4><p>${esc(d.prix_estime)}</p></div></div>
      </div>
      <div class="divider"></div>
      <h3 style="margin-bottom:10px">Chercher les billets 🎫</h3>
      <div class="row">
        <a class="btn" href="${esc(gf)}" target="_blank" rel="noopener">Google Flights</a>
        <a class="btn ghost" href="${esc(ky)}" target="_blank" rel="noopener">Kayak</a>
        <a class="btn ghost" href="${esc(sky)}" target="_blank" rel="noopener">Skyscanner</a>
      </div>
      <p class="hint">Les liens ouvrent la recherche pré-remplie — compare les prix sur les trois.</p>
      <div class="divider"></div>
      <h3 style="margin-bottom:6px">💸 Prix réels en direct <span class="tag cyan" style="margin-left:6px">API Ryanair · sans clé</span> <span class="tag" style="margin-left:4px">🌍 Aviasales · token gratuit</span></h3>
      <p class="hint" style="margin:0 0 12px">Deux moteurs : <strong>Ryanair</strong> (sans clé, low-cost only — Paris = BVA) et <strong>Toutes compagnies</strong> via Aviasales (Air France, easyJet, Transavia, Vueling… — token gratuit à coller dans ⚙). Codes ville acceptés côté Aviasales : PAR, LON, ROM…</p>
      <div class="grid tight" style="margin-bottom:12px">
        <div class="field"><label>Départ (IATA)</label><input id="ryFrom" maxlength="3" style="text-transform:uppercase" value="${esc(from)}"></div>
        <div class="field"><label>Arrivée (IATA)</label><input id="ryTo" maxlength="3" style="text-transform:uppercase" value="${esc(to)}"></div>
        <div class="field"><label>Date aller</label><input id="ryDate" type="date" value="${esc(ryDefaultDate())}"></div>
        <div class="field"><label>Flexibilité</label>
          <select id="ryFlex"><option value="3">± 3 jours</option><option value="7" selected>± 7 jours</option><option value="14">± 14 jours</option></select>
        </div>
        <div class="field"><label>Durée sur place</label>
          <select id="ryStay"><option value="3">2-3 nuits</option><option value="7" selected>5-8 nuits</option><option value="14">10-15 nuits</option></select>
        </div>
      </div>
      <div class="row">
        <button class="btn sm" id="btnRyRT">🔍 A/R Ryanair</button>
        <button class="btn sm ghost" id="btnRyCal">📅 Calendrier Ryanair</button>
        <button class="btn sm violet" id="btnTpAll">🌍 Toutes compagnies</button>
      </div>
      <div id="zoneRy" style="margin-top:14px"></div>`;
  } else if(state.mode === 'car'){
    const saddr = encodeURIComponent(p.from);
    const daddr = encodeURIComponent(`${t.nom}, ${t.pays}`);
    const embed = `https://maps.google.com/maps?saddr=${saddr}&daddr=${daddr}&hl=fr&output=embed`;
    const open  = `https://www.google.com/maps/dir/${saddr}/${daddr}`;
    zone.innerHTML = `
      <div class="grid" style="margin-bottom:14px">
        <div class="item"><div class="emo">📏</div><div><h4>Distance</h4><p>${esc(d.distance)}</p></div></div>
        <div class="item"><div class="emo">⏱</div><div><h4>Durée</h4><p>${esc(d.duree)}</p></div></div>
        <div class="item"><div class="emo">💶</div><div><h4>Coût estimé</h4><p>${esc(d.cout_estime)}</p></div></div>
        <div class="item"><div class="emo">🛣</div><div><h4>Itinéraire</h4><p>${esc(d.itineraire_resume)}</p></div></div>
      </div>
      <div class="map-box" style="margin-bottom:16px"><iframe src="${esc(embed)}" loading="lazy"></iframe></div>
      <div class="row" style="margin-bottom:16px"><a class="btn" href="${esc(open)}" target="_blank" rel="noopener">🗺️ Ouvrir dans Google Maps</a></div>
`;
  } else {
    const trl = `https://www.thetrainline.com/fr`;
    const sncf = `https://www.sncf-connect.com/`;
    const omio = `https://www.omio.fr/`;
    const fais = {oui:'✅ Faisable', 'non':'❌ Peu adapté', 'compliqué':'⚠️ Compliqué mais possible'};
    zone.innerHTML = `
      <div class="grid" style="margin-bottom:14px">
        <div class="item"><div class="emo">🚦</div><div><h4>Verdict</h4><p>${esc(fais[d.faisable]||d.faisable)}</p></div></div>
        <div class="item"><div class="emo">⏱</div><div><h4>Durée</h4><p>${esc(d.duree)}</p></div></div>
        <div class="item"><div class="emo">💶</div><div><h4>Prix estimé A/R</h4><p>${esc(d.prix_estime)}</p></div></div>
        <div class="item"><div class="emo">🚆</div><div><h4>Trajet</h4><p>${esc(d.trajet)}</p></div></div>
      </div>
      <div class="divider"></div>
      <h3 style="margin-bottom:10px">Chercher les billets 🎫</h3>
      <div class="row">
        <a class="btn" href="${trl}" target="_blank" rel="noopener">Trainline</a>
        <a class="btn ghost" href="${sncf}" target="_blank" rel="noopener">SNCF Connect</a>
        <a class="btn ghost" href="${omio}" target="_blank" rel="noopener">Omio</a>
      </div>
      <div class="divider"></div>
      <h3 style="margin-bottom:6px">🚄 Horaires réels en direct <span class="tag cyan" style="margin-left:6px">API Deutsche Bahn · gratuite sans clé</span></h3>
      <p class="hint" style="margin:0 0 12px">Vrais horaires (et parfois prix) interrogés en live via le réseau DB : Allemagne + liaisons internationales (France, Benelux, Suisse, Autriche, Italie du nord, Danemark…). Si rien ne sort, la liaison n'est pas dans le réseau DB — utilise Trainline.</p>
      <div class="grid tight" style="margin-bottom:12px">
        <div class="field"><label>Gare / ville de départ</label><input id="dbFrom" value="${esc(p.from||'')}"></div>
        <div class="field"><label>Gare / ville d'arrivée</label><input id="dbTo" value="${esc(t.nom)}"></div>
        <div class="field"><label>Départ le</label><input id="dbWhen" type="datetime-local" value="${esc(ryDefaultDate())}T09:00"></div>
      </div>
      <button class="btn sm" id="btnDb">🔍 Chercher les trains</button>
      <div id="zoneDb" style="margin-top:14px"></div>`;
  }
}

/* ============================================================
   PRIX RÉELS AUTOMATIQUES — se lancent seuls au rendu du plan,
   sans que le voyageur ait à cliquer sur quoi que ce soit.
   ✈️ Ryanair farfnd · 🚄 Deutsche Bahn · 🚗 calcul carburant+péage
============================================================ */
const FUEL_L100 = 6.5, FUEL_EUR_L = 1.85, TOLL_EUR_KM = 0.09;   /* moyennes Europe 2026 */

/* prix voiture : carburant + péages, aller-retour, divisé par les passagers */
function carPriceAuto(){
  const dist = state.cache._real?.dist;
  if(!dist) return null;
  const route = dist * 1.25;                       /* vol d'oiseau → route réelle */
  const A = Math.max(1, (state.prefs?.adults || 1) + (state.prefs?.kids || 0));
  const total = route * 2 * (FUEL_L100 / 100 * FUEL_EUR_L + TOLL_EUR_KM);
  return { total: Math.round(total), perPax: Math.round(total / A), km: Math.round(route) };
}

/* vol le moins cher (Ryanair, API publique sans clé) */
async function planePriceAuto(){
  const t = state.trip, p = state.prefs || {};
  const to = (t?.iata || '').toUpperCase().replace(/[^A-Z]/g, '');
  if(to.length !== 3 || !p.depart) return null;
  const AIRPORTS = { paris:'BVA', lyon:'LYS', marseille:'MRS', bordeaux:'BOD', nantes:'NTE', toulouse:'TLS',
                     lille:'LIL', nice:'NCE', bruxelles:'CRL', 'genève':'GVA', geneve:'GVA' };
  const from = AIRPORTS[cleanPlace(p.from || 'Paris').toLowerCase()] || 'BVA';
  const stay = Math.max(2, Math.min(21, daysFromPrefs ? daysFromPrefs() : 7));
  const url = `https://services-api.ryanair.com/farfnd/v4/roundTripFares?departureAirportIataCode=${from}&arrivalAirportIataCode=${to}`
    + `&outboundDepartureDateFrom=${p.depart}&outboundDepartureDateTo=${addDays(p.depart, 3)}`
    + `&inboundDepartureDateFrom=${addDays(p.depart, Math.max(1, stay - 1))}&inboundDepartureDateTo=${addDays(p.depart, stay + 3)}`
    + `&market=fr-fr&adultPaxCount=${p.adults || 1}&currency=EUR&limit=6&durationFrom=1&durationTo=${stay + 3}`;
  try{
    const r = await fetchT(url, {}, 9000);
    if(!r.ok) return null;
    const d = await r.json();
    const f = (d.fares || []).filter(x => x?.summary?.price?.value).sort((a, b) => a.summary.price.value - b.summary.price.value)[0];
    if(!f) return null;
    return { prix: Math.round(f.summary.price.value), from, to,
             aller: f.outbound?.departureDate?.slice(0, 10), retour: f.inbound?.departureDate?.slice(0, 10) };
  }catch(e){ return null; }
}

/* Charge en tâche de fond le prix réel du mode choisi, puis met à jour la tuile
   « Y aller » sans re-rendre tout le plan. Silencieux si indisponible. */
async function autoRealPrices(mode){
  const slot = $('#realPrice');
  if(!slot) return;
  const ck = `rp_${mode}_${state.trip?.nom}_${state.prefs?.depart || 'flex'}`;
  if(state.cache[ck]){ slot.innerHTML = state.cache[ck]; return; }
  let html = '';
  /* voiture et train ne demandent AUCUN réseau (calcul local / données déjà en cache) :
     ils s'affichent même en connexion dégradée. */
  if(mode === 'voiture'){
    const c = carPriceAuto();
    if(c) html = `<span class="rp-ok">🚗 <strong>≈ ${c.perPax} €/pers</strong> A/R · ${c.km} km · carburant + péages</span>`;
  }else if(mode === 'train'){
    const tr = state.cache._real?.train;
    if(tr) html = `<span class="rp-ok">🚄 <strong>${esc(tr)}</strong></span>`;
  }else{
    /* l'avion exige un appel réseau → on s'abstient si la connexion rame, et on rejoue plus tard */
    if(netSlow()){
      slot.innerHTML = `<span class="rp-idle">réseau limité — prix chargé au retour du réseau</span>`;
      netRetry('prix-avion', () => autoRealPrices(mode));
      return;
    }
    slot.innerHTML = `<span class="rp-load">recherche du prix réel…</span>`;
    const f = await planePriceAuto();
    if(f) html = `<span class="rp-ok">✈️ <strong>dès ${f.prix} € A/R</strong> · ${esc(f.from)}→${esc(f.to)}${f.aller ? ` · ${esc(f.aller)}` : ''} <em>(Ryanair, aujourd'hui)</em></span>`;
  }
  if(!html){ slot.innerHTML = `<span class="rp-idle">prix du jour à vérifier sur les liens de réservation</span>`; return; }
  state.cache[ck] = html; save();
  slot.innerHTML = html;
}

/* ============================================================
   BILLETS EN DIRECT — APIs publiques gratuites sans clé
   ✈️ Ryanair farfnd (prix réels) · 🚄 v6.db.transport.rest (horaires DB)
============================================================ */
function ryDefaultDate(){
  const base = state.prefs?.depart ? new Date(state.prefs.depart) : new Date(Date.now() + 14*864e5);
  return base.toISOString().slice(0,10);
}
const addDays = (iso, n) => { const d = new Date(iso); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); };
const frDate = iso => new Date(iso).toLocaleDateString('fr-FR',{weekday:'short',day:'numeric',month:'short'});
const frTime = iso => new Date(iso).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'});

/* --- ✈️ Ryanair : meilleurs A/R sur une fenêtre de dates --- */
async function ryRoundTrip(){
  const zone = $('#zoneRy');
  const from = $('#ryFrom').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const to   = $('#ryTo').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const date = $('#ryDate').value;
  const flex = +$('#ryFlex').value, stay = +$('#ryStay').value;
  if(from.length!==3 || to.length!==3 || !date){ toast('Renseigne 2 codes IATA + une date'); return; }
  zone.innerHTML = loaderHTML('Interrogation des tarifs Ryanair…');
  const outFrom = addDays(date, -Math.min(flex, Math.floor((new Date(date)-Date.now())/864e5)));
  const outTo   = addDays(date, flex);
  const inFrom  = addDays(date, Math.max(1, stay - 2));
  const inTo    = addDays(date, stay + flex);
  const url = `https://services-api.ryanair.com/farfnd/v4/roundTripFares?departureAirportIataCode=${from}&arrivalAirportIataCode=${to}`
    + `&outboundDepartureDateFrom=${outFrom}&outboundDepartureDateTo=${outTo}`
    + `&inboundDepartureDateFrom=${inFrom}&inboundDepartureDateTo=${inTo}`
    + `&market=fr-fr&adultPaxCount=${state.prefs?.adults||1}&currency=EUR&limit=16&durationFrom=1&durationTo=${stay+flex}`;
  try{
    const r = await fetch(url);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const fares = (d.fares||[]).filter(f=>f.outbound && f.inbound)
      .sort((a,b)=>(a.summary?.price?.value??9e9)-(b.summary?.price?.value??9e9)).slice(0,6);
    if(!fares.length){
      zone.innerHTML = errHTML(`Aucun vol Ryanair ${from} → ${to} sur cette période. Ligne non desservie ou dates complètes — essaie le calendrier du mois, ou change d'aéroport (Paris = BVA).`);
      return;
    }
    zone.innerHTML = `<h3 style="margin-bottom:10px">Meilleurs allers-retours trouvés 🔥</h3>` + fares.map((f,i)=>{
      const o = f.outbound, b = f.inbound;
      const dOut = o.departureDate.slice(0,10), dIn = b.departureDate.slice(0,10);
      const book = `https://www.ryanair.com/fr/fr/trip/flights/select?adults=${state.prefs?.adults||1}&teens=0&children=0&infants=0&isReturn=true&dateOut=${dOut}&dateIn=${dIn}&originIata=${from}&destinationIata=${to}&tpAdults=${state.prefs?.adults||1}&tpStartDate=${dOut}&tpEndDate=${dIn}&tpOriginIata=${from}&tpDestinationIata=${to}`;
      return `<div class="item">
        <div class="emo">${i===0?'🏆':'✈️'}</div>
        <div style="flex:1">
          <h4>${esc(frDate(o.departureDate))} → ${esc(frDate(b.departureDate))}</h4>
          <p>Aller ${esc(frTime(o.departureDate))} (${esc(o.price?.value?.toFixed(2))} €) · Retour ${esc(frTime(b.departureDate))} (${esc(b.price?.value?.toFixed(2))} €)<br>
          ${esc(o.departureAirport?.name||from)} ⇄ ${esc(o.arrivalAirport?.name||to)}</p>
          <a class="tl-loc" href="${esc(book)}" target="_blank" rel="noopener" style="margin-top:8px">🎫 Réserver sur Ryanair</a>
        </div>
        <div class="side"><span class="tag money" style="font-size:.85rem">💶 ${esc(f.summary?.price?.value?.toFixed(2))} € A/R</span></div>
      </div>`;
    }).join('') + `<p class="hint">Prix réels au moment de la recherche, hors bagages/options. ${fares[0].summary?.price?.value ? 'Le moins cher : <strong>'+fares[0].summary.price.value.toFixed(2)+' € A/R</strong>.' : ''}</p>`;
    if(fares[0]?.summary?.price?.value){
      const v = +fares[0].summary.price.value.toFixed(0);
      state.cache.realPrice = `à partir de ${v} € A/R par personne (Ryanair, ${new Date().toLocaleDateString('fr-FR')})`;
      trackPrice(v, 'Ryanair');
      save();
    }
  }catch(e){
    zone.innerHTML = errHTML('API Ryanair injoignable (adblocker ? réseau ?). Réessaie ou passe par les liens Google Flights/Kayak au-dessus.');
  }
}

/* --- ✈️ Ryanair : calendrier des prix du mois (aller simple / jour) --- */
async function ryCalendar(){
  const zone = $('#zoneRy');
  const from = $('#ryFrom').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const to   = $('#ryTo').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const date = $('#ryDate').value || ryDefaultDate();
  if(from.length!==3 || to.length!==3){ toast('Renseigne 2 codes IATA'); return; }
  zone.innerHTML = loaderHTML('Chargement du calendrier des prix…');
  const month = date.slice(0,7) + '-01';
  try{
    const r = await fetch(`https://services-api.ryanair.com/farfnd/v4/oneWayFares/${from}/${to}/cheapestPerDay?outboundMonthOfDate=${month}&currency=EUR`);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const days = (d.outbound?.fares||[]).filter(f=>!f.unavailable && f.price);
    if(!days.length){ zone.innerHTML = errHTML(`Aucun vol ${from} → ${to} ce mois-ci (ligne non desservie ?).`); return; }
    const min = Math.min(...days.map(f=>f.price.value));
    zone.innerHTML = `<h3 style="margin-bottom:10px">📅 Aller simple ${esc(from)} → ${esc(to)} — ${new Date(month).toLocaleDateString('fr-FR',{month:'long',year:'numeric'})}</h3>
      <div style="display:flex;flex-wrap:wrap;gap:7px">` +
      days.map(f=>{
        const best = f.price.value === min;
        return `<div style="min-width:74px;text-align:center;padding:9px 6px;border-radius:var(--r-md);border:2px solid ${best?'var(--ok)':'var(--stroke)'};background:${best?'rgba(34,197,94,.15)':'var(--secondary)'}">
          <div style="font-size:.68rem;color:var(--txt-2)">${esc(frDate(f.day))}</div>
          <div style="font-family:'Sora';font-weight:900;font-size:.9rem;color:${best?'var(--ok)':'var(--txt)'}">${f.price.value.toFixed(0)}€</div>
          ${f.soldOut?'<div style="font-size:.6rem;color:var(--danger)">complet</div>':''}
        </div>`;
      }).join('') +
      `</div><p class="hint">💚 = jour le moins cher du mois (${min.toFixed(2)} €, aller simple). Astuce : décale ton départ de 1-2 jours et économise gros.</p>`;
  }catch(e){
    zone.innerHTML = errHTML('Calendrier indisponible — API Ryanair injoignable.');
  }
}

/* --- 🌍 Aviasales (Travelpayouts) : prix réels TOUTES compagnies --- */
const AIRLINES = {
  AF:'Air France', U2:'easyJet', FR:'Ryanair', TO:'Transavia France', HV:'Transavia',
  VY:'Vueling', W6:'Wizz Air', W4:'Wizz Air Malta', LH:'Lufthansa', KL:'KLM', BA:'British Airways',
  IB:'Iberia', AZ:'ITA Airways', TP:'TAP Portugal', LX:'Swiss', OS:'Austrian', SN:'Brussels Airlines',
  EW:'Eurowings', SK:'SAS', AY:'Finnair', LO:'LOT', A3:'Aegean', PC:'Pegasus', TK:'Turkish Airlines',
  EK:'Emirates', QR:'Qatar Airways', EY:'Etihad', AT:'Royal Air Maroc', TU:'Tunisair', AH:'Air Algérie',
  DY:'Norwegian', D8:'Norwegian', EI:'Aer Lingus', UX:'Air Europa', EN:'Air Dolomiti', V7:'Volotea',
  XK:'Air Corsica', BF:'French Bee', SS:'Corsair', TX:'Air Caraïbes', ZB:'Air Albania', JU:'Air Serbia'
};
const airlineName = c => AIRLINES[c] || c || '—';

async function tpSearch(){
  const zone = $('#zoneRy');
  const token = tpKey();
  if(!token){
    zone.innerHTML = errHTML('Token Travelpayouts absent de config.js.');
    return;
  }
  const from = $('#ryFrom').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const to   = $('#ryTo').value.trim().toUpperCase().replace(/[^A-Z]/g,'').slice(0,3);
  const date = $('#ryDate').value || ryDefaultDate();
  const stay = +$('#ryStay').value;
  if(from.length<2 || to.length<2){ toast('Renseigne 2 codes IATA'); return; }
  zone.innerHTML = loaderHTML('Interrogation Aviasales — toutes compagnies…');
  const ret = addDays(date, stay);
  const base = `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=${from}&destination=${to}`
    + `&one_way=false&unique=false&sorting=price&direct=false&currency=eur&cy=eur&market=fr&limit=12&page=1&token=${encodeURIComponent(token)}`;
  try{
    /* 1er essai : dates précises · 2e essai : mois entier (le cache Aviasales est plus riche au mois) */
    let r = await fetch(`${base}&departure_at=${date}&return_at=${ret}`);
    let d = r.ok ? await r.json() : null;
    let broad = false;
    if(!d || !d.success || !(d.data||[]).length){
      broad = true;
      r = await fetch(`${base}&departure_at=${date.slice(0,7)}&return_at=${ret.slice(0,7)}`);
      d = r.ok ? await r.json() : null;
    }
    if(!d || d.success === false){
      const err = d?.error || '';
      zone.innerHTML = errHTML(/token/i.test(err) ? 'Token Travelpayouts invalide — vérifie dans ⚙.' : 'Aviasales : ' + (err || 'réponse invalide.'));
      return;
    }
    const rows = (d.data||[]).slice(0,10);
    if(!rows.length){
      zone.innerHTML = errHTML(`Aucun prix en cache pour ${from} → ${to}. L'API Aviasales sert les prix des recherches récentes des utilisateurs : essaie des codes VILLE (PAR, LON, ROM…) ou une grande ligne.`);
      return;
    }
    zone.innerHTML = `<h3 style="margin-bottom:10px">🌍 Toutes compagnies — ${esc(from)} ⇄ ${esc(to)}${broad ? ' <span class="tag" style="margin-left:6px">mois entier</span>' : ''}</h3>` +
      rows.map((f,i)=>{
        const dep = f.departure_at, ret2 = f.return_at;
        const dd = dep ? dep.slice(8,10)+dep.slice(5,7) : '', rr = ret2 ? ret2.slice(8,10)+ret2.slice(5,7) : '';
        const link = f.link ? 'https://www.aviasales.com' + f.link : `https://www.aviasales.com/search/${from}${dd}${to}${rr}1`;
        const stops = (f.transfers||0) + (f.return_transfers||0);
        return `<div class="item">
          <div class="emo" style="display:flex;align-items:center">${i===0?'🏆':`<img src="https://pics.avs.io/60/30/${esc(f.airline)}.png" alt="${esc(f.airline)}" style="height:20px;border-radius:4px" onerror="this.replaceWith('✈️')">`}</div>
          <div style="flex:1">
            <h4>${esc(airlineName(f.airline))} <span class="tag" style="margin-left:6px">${stops===0?'direct':stops+' escale'+(stops>1?'s':'')}</span></h4>
            <p>Aller ${esc(frDate(dep))} à ${esc(frTime(dep))}${ret2 ? ` · Retour ${esc(frDate(ret2))}` : ''} · vol ${esc(f.airline)}${esc(String(f.flight_number||''))}</p>
            <a class="tl-loc" href="${esc(link)}" target="_blank" rel="noopener" style="margin-top:8px">🎫 Voir sur Aviasales</a>
          </div>
          <div class="side"><span class="tag money" style="font-size:.85rem">💶 ${esc(String(f.price))} € A/R</span></div>
        </div>`;
      }).join('') +
      `<p class="hint">Prix issus du cache Aviasales (recherches réelles des dernières 48h, toutes compagnies confondues) — clique sur "Voir" pour le tarif à la seconde.</p>`;
    if(rows[0]?.price){
      state.cache.realPrice = `à partir de ${rows[0].price} € A/R par personne (toutes compagnies, ${new Date().toLocaleDateString('fr-FR')})`;
      trackPrice(+rows[0].price, 'toutes compagnies');
      save();
    }
  }catch(e){
    zone.innerHTML = errHTML('API Aviasales injoignable (adblocker ? réseau ?).');
  }
}

/* --- 🚄 Deutsche Bahn : horaires réels --- */
const DB_API = 'https://v6.db.transport.rest';
async function dbStation(q){
  const r = await fetch(`${DB_API}/locations?query=${encodeURIComponent(q)}&results=1&poi=false&addresses=false`);
  if(!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return d[0] || null;
}
async function dbSearch(){
  const zone = $('#zoneDb');
  const qFrom = $('#dbFrom').value.trim(), qTo = $('#dbTo').value.trim();
  const when = $('#dbWhen').value;
  if(!qFrom || !qTo){ toast('Renseigne les 2 gares'); return; }
  zone.innerHTML = loaderHTML('Recherche des gares…');
  try{
    const [a, b] = await Promise.all([dbStation(qFrom), dbStation(qTo)]);
    if(!a || !b){ zone.innerHTML = errHTML(`Gare introuvable : ${!a?qFrom:qTo}. Essaie le nom de la gare principale (ex : "Paris Est").`); return; }
    zone.innerHTML = loaderHTML(`${a.name} → ${b.name}…`);
    const dep = when ? new Date(when).toISOString() : new Date().toISOString();
    const r = await fetch(`${DB_API}/journeys?from=${a.id}&to=${b.id}&departure=${encodeURIComponent(dep)}&results=5&tickets=true&language=fr`);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const js = d.journeys || [];
    if(!js.length){ zone.innerHTML = errHTML('Aucun trajet trouvé dans le réseau DB pour cette liaison — passe par Trainline.'); return; }
    zone.innerHTML = `<h3 style="margin-bottom:10px">🚄 ${esc(a.name)} → ${esc(b.name)}</h3>` + js.map(j=>{
      const legs = (j.legs||[]).filter(l=>!l.walking);
      if(!legs.length) return '';
      const dep0 = legs[0], arrN = legs[legs.length-1];
      const durMs = new Date(arrN.arrival||arrN.plannedArrival) - new Date(dep0.departure||dep0.plannedDeparture);
      const dur = `${Math.floor(durMs/36e5)}h${String(Math.round(durMs%36e5/6e4)).padStart(2,'0')}`;
      const changes = legs.length - 1;
      const lines = legs.map(l=>l.line?.name).filter(Boolean).join(' → ');
      const price = j.price?.amount ? `${j.price.amount.toFixed(2)} ${j.price.currency==='EUR'?'€':j.price.currency}` : null;
      const delay = dep0.departureDelay ? Math.round(dep0.departureDelay/60) : 0;
      return `<div class="item">
        <div class="emo">🚆</div>
        <div style="flex:1">
          <h4>${esc(frTime(dep0.departure||dep0.plannedDeparture))} → ${esc(frTime(arrN.arrival||arrN.plannedArrival))}
            <span class="tag cyan" style="margin-left:6px">⏱ ${dur}</span>
            <span class="tag" style="margin-left:4px">${changes===0?'direct':changes+' corresp.'}</span>
            ${delay>0?`<span class="tag money" style="margin-left:4px">⚠️ +${delay} min</span>`:''}
          </h4>
          <p>${esc(lines)} · le ${esc(frDate(dep0.departure||dep0.plannedDeparture))}${dep0.departurePlatform?` · voie ${esc(dep0.departurePlatform)}`:''}</p>
        </div>
        ${price?`<div class="side"><span class="tag money">💶 ${esc(price)}</span></div>`:''}
      </div>`;
    }).join('') + `<p class="hint">Horaires temps réel (retards inclus) via le réseau Deutsche Bahn. Les prix ne sont affichés que sur les liaisons vendues par DB.</p>`;
  }catch(e){
    zone.innerHTML = errHTML('API Deutsche Bahn injoignable (limite 100 req/min) — réessaie dans quelques secondes.');
  }
}

/* Délégation : les blocs sont re-rendus, donc handlers au niveau document */
document.addEventListener('click', e => {
  if(e.target.id === 'btnRyRT')  ryRoundTrip();
  if(e.target.id === 'btnRyCal') ryCalendar();
  if(e.target.id === 'btnTpAll') tpSearch();
  if(e.target.id === 'btnDb')    dbSearch();
});

/* ============================================================
   ÉTAPE 3 — DORMIR  (Gemini · heavy)
============================================================ */
const _e6 = $('#btnStayGo'); if(_e6) _e6.onclick = () => { delete state.cache.stay; save(); loadStay(); };

async function loadStay(){
  const zone = $('#zoneStay');
  if(state.cache.stay){ renderStay(state.cache.stay); return; }
  zone.innerHTML = loaderHTML('Repérage des meilleurs quartiers…');
  const t = state.trip;
  const styp = $('#stayType').value, sprio = $('#stayPrio').value;
  const prompt = `Tu es Acolite, expert voyage. ${ctx()}
Recommande où loger à ${t.nom} (${t.pays}) pour ce profil.
${state.cache.plan?.logement ? 'PLAN VALIDÉ — le voyageur a accepté : ' + state.cache.plan.logement.type + ' dans le quartier ' + state.cache.plan.logement.quartier + ' (~' + state.cache.plan.logement.prix_nuit + '). Mets ce quartier en premier et propose 2 alternatives.' : ''}
${styp ? 'Type de logement souhaité : ' + styp + '.' : ''}
${sprio ? 'Priorité du voyageur : ' + sprio + '.' : ''}
Réponds UNIQUEMENT en JSON :
{
 "quartiers":[
   {"nom":"...","emoji":"un emoji","pourquoi":"2 phrases : ambiance + pour qui c'est idéal","prix_nuit":"fourchette €/nuit réaliste","ideal_pour":"ex: couples, familles…"}
 ],
 "type_conseille":"1 phrase : hôtel / appart / auberge selon le profil et pourquoi",
 "conseils":["3 conseils réservation : quand réserver, arnaques à éviter, quartiers à éviter le soir si pertinent"]
}
Donne exactement 3 quartiers.`;
  try{
    const d = await gemini(prompt);
    state.cache.stay = d; save();
    renderStay(d);
  }catch(e){
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Recherche logement impossible pour le moment.');
  }
}

function renderStay(d){
  const t = state.trip;
  const booking = q => `https://www.booking.com/searchresults.fr.html?ss=${encodeURIComponent(q)}`;
  const airbnb  = q => `https://www.airbnb.fr/s/${encodeURIComponent(q)}/homes`;
  const hostel  = q => `https://www.hostelworld.com/s?q=${encodeURIComponent(q)}`;
  $('#zoneStay').innerHTML = `
    <div class="item"><div class="emo">🎯</div><p style="margin-top:4px"><strong>Le bon plan pour toi :</strong> ${esc(d.type_conseille)}</p></div>
    <h3 style="margin:16px 0 10px">Les 3 quartiers où viser</h3>
    ${(d.quartiers||[]).map(q=>`
      <div class="item">
        <div class="emo">${esc(q.emoji||'🏘️')}</div>
        <div style="flex:1">
          <h4>${esc(q.nom)} <span class="tag" style="margin-left:6px">${esc(q.ideal_pour||'')}</span></h4>
          <p>${esc(q.pourquoi)}</p>
          <div class="row" style="margin-top:9px">
            <a class="btn sm" href="${booking(q.nom + ', ' + t.nom)}" target="_blank" rel="noopener">Booking</a>
            <a class="btn sm ghost" href="${airbnb(q.nom + ', ' + t.nom)}" target="_blank" rel="noopener">Airbnb</a>
          </div>
        </div>
        <div class="side"><span class="tag money">💶 ${esc(q.prix_nuit)}</span></div>
      </div>`).join('')}
    <h3 style="margin:16px 0 8px">Conseils réservation</h3>
    ${(d.conseils||[]).map(c=>`<div class="item"><div class="emo">💡</div><p style="margin-top:4px">${esc(c)}</p></div>`).join('')}
    <div class="divider"></div>
    <div class="row">
      <a class="btn" href="${booking(t.nom)}" target="_blank" rel="noopener">🏨 Booking</a>
      <a class="btn ghost" href="${airbnb(t.nom)}" target="_blank" rel="noopener">Airbnb</a>
      <a class="btn ghost" href="${hostel(t.nom)}" target="_blank" rel="noopener">Hostelworld</a>
    </div>`;
}

/* ============================================================
   ÉTAPE 4 — SUR PLACE
============================================================ */

function setMap(q){
  $('#mapFrame').src = `https://maps.google.com/maps?q=${encodeURIComponent(q)}&hl=fr&z=14&output=embed`;
}
window.setMap = setMap;

/* Délégation : tout élément avec data-loc met à jour la carte */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-loc]');
  if(!el) return;
  const q = el.dataset.loc + (state.trip ? ', ' + state.trip.nom : '');
  setMap(q);
  toast('📍 ' + el.dataset.loc);
  $('#mapFrame').scrollIntoView({behavior:'smooth', block:'center'});
});

/* --- sous-onglets --- */
const TAB_PANELS = {iti:'#pIti', food:'#pFood', shop:'#pShop', spec:'#pSpec', bag:'#pBag', talk:'#pTalk', bud:'#pBud', info:'#pInfo', act:'#pAct', tools:'#pTools', note:'#pNote'};
$$('.subtab').forEach(el => el.onclick = () => {
  $$('.subtab').forEach(x=>x.classList.remove('on')); el.classList.add('on');
  Object.entries(TAB_PANELS).forEach(([k,sel]) => $(sel).classList.toggle('hidden', k !== el.dataset.t));
});

/* ============================================================
   ITINÉRAIRE (Gemini · heavy)
============================================================ */
function itiPrompt(day){
  const t = state.trip;
  const pace = $('#itiPace').value, wish = $('#itiWish').value.trim();
  const start = $('#itiStart').value, end = $('#itiEnd').value, move = $('#itiMove').value;
  return `Tu es Acolite, guide local expert de ${t.nom} (${t.pays}). ${ctx()}
Construis le programme du JOUR ${day} du séjour.
- Rythme : ${pace} · Journée de ${start} à ${end} · Déplacements : ${move}
${wish ? '- Envie particulière : '+wish : ''}
Programme RÉALISTE : horaires cohérents, temps de trajet inclus, pauses repas.
Si jour > 1, varie par rapport aux grands classiques du jour 1.
Réponds UNIQUEMENT en JSON :
{
 "titre_journee":"thème du jour",
 "etapes":[
   {"heure":"09:00","titre":"...","description":"1-2 phrases concrètes avec un vrai conseil","lieu":"nom précis du lieu pour Google Maps ou null","type":"visite|repas|pause|trajet"}
 ]
}
Entre 6 et 9 étapes.`;
}

function timelineHTML(d){
  const icons = {visite:'🏛️', repas:'🍽️', pause:'☕', trajet:'🚶'};
  return `<div class="timeline">
    ${(d.etapes||[]).map((e,i)=>`
      <div class="tl-item" style="animation-delay:${i*0.06}s">
        <div class="tl-time">${esc(e.heure)} ${icons[e.type]||'📍'}</div>
        <div class="tl-title">${esc(e.titre)}</div>
        <div class="tl-desc">${esc(e.description)}</div>
        ${e.lieu ? `<span class="tl-loc" data-loc="${esc(e.lieu)}">📍 Voir sur la carte</span>` : ''}
      </div>`).join('')}
  </div>`;
}

const _e7 = $('#btnIti'); if(_e7) _e7.onclick = async () => {
  const zone = $('#zoneIti');
  const day = $('#itiDay').value;
  zone.innerHTML = loaderHTML('Construction de ton programme…');
  $('#btnIti').disabled = true;
  try{
    const d = await gemini(itiPrompt(day));
    zone.innerHTML = `<h3 style="margin-bottom:14px">✨ Jour ${esc(day)} — ${esc(d.titre_journee)}</h3>` + timelineHTML(d);
  }catch(e){
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Génération impossible, réessaie.');
  }
  $('#btnIti').disabled = false;
};

/* --- tout le séjour d'un coup --- */
function daysFromPrefs(){
  const d = (state.prefs?.days || '').toLowerCase();
  if(d.includes('week-end')) return 3;
  if(d.includes('deux')) return 14;
  if(d.includes('trois')) return 14;
  return 7;
}

const _e8 = $('#btnItiAll'); if(_e8) _e8.onclick = async () => {
  const zone = $('#zoneItiAll');
  const t = state.trip;
  const n = Math.min(daysFromPrefs(), 10);
  zone.innerHTML = loaderHTML(`Planification des ${n} jours… (ça peut prendre ~30s)`);
  $('#btnItiAll').disabled = true;
  const pace = $('#itiPace').value, move = $('#itiMove').value;
  const prompt = `Tu es Acolite, guide local expert de ${t.nom} (${t.pays}). ${ctx()}
Construis le programme COMPLET du séjour sur ${n} jours. Rythme : ${pace}. Déplacements : ${move}.
Chaque jour a un thème différent, sans répéter les lieux. Jour 1 = incontournables. Prévois une demi-journée détente vers le milieu.
Réponds UNIQUEMENT en JSON :
{
 "jours":[
   {"jour":1,"titre":"thème","etapes":[{"heure":"09:00","titre":"...","description":"1 phrase concrète","lieu":"lieu précis ou null","type":"visite|repas|pause|trajet"}]}
 ]
}
4 à 6 étapes par jour, pour rester lisible.`;
  try{
    const d = await gemini(prompt, true, 8192);
    state.cache.fullPlan = d; save();
    renderFullPlan(d);
  }catch(e){
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Trop gros pour cette fois — réessaie ou génère jour par jour.');
  }
  $('#btnItiAll').disabled = false;
};

function renderFullPlan(d){
  $('#zoneItiAll').innerHTML = `<div class="divider"></div><h3 style="margin-bottom:12px">📆 Ton séjour complet</h3>` +
    (d.jours||[]).map((j,i)=>`
      <div class="acc ${i===0?'open':''}">
        <div class="acc-head" data-acc>
          Jour ${esc(j.jour)} — ${esc(j.titre)} <span class="arr">›</span>
        </div>
        <div class="acc-body">${timelineHTML(j)}</div>
      </div>`).join('');
}

/* ============================================================
   RESTOS (Gemini · heavy — connaissance locale précise)
============================================================ */
const _e9 = $('#btnFoodGo'); if(_e9) _e9.onclick = () => { delete state.cache.food; save(); loadFood(); };

async function loadFood(){
  const zone = $('#zoneFood');
  if(state.cache.food){ renderFood(state.cache.food); return; }
  zone.innerHTML = loaderHTML('Dégustation en cours…');
  const t = state.trip;
  const fb = $('#foodBud').value, ft = $('#foodType').value;
  const prompt = `Tu es Acolite, fin gourmet local de ${t.nom} (${t.pays}). ${ctx()}
${fb ? 'Budget resto souhaité : ' + fb + '.' : ''}
${ft ? 'Envie : ' + ft + '.' : ''}
Réponds UNIQUEMENT en JSON :
{"restos":[
 {"nom":"nom réel et connu du resto","emoji":"1 emoji plat","style":"ex: trattoria familiale","plat_star":"le plat à commander","budget":"€ / €€ / €€€","quartier":"quartier","pourquoi":"1 phrase qui donne faim"}
]}
Exactement 5 restos VARIÉS, vraiment réputés à ${t.nom}.`;
  try{
    const d = await gemini(prompt);
    state.cache.food = d; save();
    renderFood(d);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement des restos impossible.'); }
}
function renderFood(d){
  const t = state.trip;
  $('#zoneFood').innerHTML = (d.restos||[]).map(r=>`
    <div class="item">
      <div class="emo">${esc(r.emoji||'🍽️')}</div>
      <div style="flex:1">
        <h4>${esc(r.nom)} <span class="tag" style="margin-left:6px">${esc(r.style)}</span></h4>
        <p><strong>À commander :</strong> ${esc(r.plat_star)} — ${esc(r.pourquoi)}</p>
        <div class="row" style="margin-top:8px">
          <span class="tl-loc" data-loc="${esc(r.nom)}">📍 Carte</span>
          <a class="tl-loc" href="https://www.google.com/maps/search/${encodeURIComponent(r.nom + ' ' + t.nom)}" target="_blank" rel="noopener">↗ Google Maps</a>
        </div>
      </div>
      <div class="side"><span class="tag money">${esc(r.budget)}</span><p style="font-size:.72rem;margin-top:5px">${esc(r.quartier)}</p></div>
    </div>`).join('');
}

/* ============================================================
   COURSES (light → Groq)
============================================================ */
async function loadShop(){
  const zone = $('#zoneShop');
  if(state.cache.shop){ renderShop(state.cache.shop, state.cache.shopVia); return; }
  zone.innerHTML = loaderHTML('Repérage des supermarchés…');
  const t = state.trip;
  const prompt = `Tu es Acolite, expert du quotidien à ${t.nom} (${t.pays}). ${ctx()}
Réponds UNIQUEMENT en JSON :
{
 "supermarches":[{"nom":"chaîne réelle du pays","niveau":"discount|standard|premium","astuce":"1 phrase utile (horaires, ce qu'on y trouve, prix)"}],
 "marches":[{"nom":"marché local réel","quand":"jours/horaires","pourquoi":"1 phrase"}],
 "budget_conseils":["3 conseils concrets pour manger pas cher sur place"]
}
3 supermarchés, 1-2 marchés.`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.shop = data; state.cache.shopVia = via; save();
    renderShop(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderShop(d, via){
  const lvl = {discount:'💸 Discount', standard:'🛒 Standard', premium:'✨ Premium'};
  $('#zoneShop').innerHTML = `
    <h3 style="margin-bottom:10px">Supermarchés ${badge(via)}</h3>
    ${(d.supermarches||[]).map(s=>`
      <div class="item"><div class="emo">🛒</div>
        <div style="flex:1"><h4>${esc(s.nom)} <span class="tag cyan" style="margin-left:6px">${lvl[s.niveau]||esc(s.niveau)}</span></h4><p>${esc(s.astuce)}</p></div>
        <div class="side"><span class="tl-loc" data-loc="${esc(s.nom)}">📍</span></div>
      </div>`).join('')}
    <h3 style="margin:14px 0 10px">Marchés locaux</h3>
    ${(d.marches||[]).map(m=>`
      <div class="item"><div class="emo">🧺</div>
        <div style="flex:1"><h4>${esc(m.nom)}</h4><p>${esc(m.pourquoi)} · <strong>${esc(m.quand)}</strong></p></div>
        <div class="side"><span class="tl-loc" data-loc="${esc(m.nom)}">📍</span></div>
      </div>`).join('')}
    <h3 style="margin:14px 0 10px">Manger malin</h3>
    ${(d.budget_conseils||[]).map(c=>`<div class="item"><div class="emo">💡</div><p style="margin-top:4px">${esc(c)}</p></div>`).join('')}`;
}

/* ============================================================
   SPÉCIALITÉS (light → Groq)
============================================================ */
async function loadSpec(){
  const zone = $('#zoneSpec');
  if(state.cache.spec){ renderSpec(state.cache.spec, state.cache.specVia); return; }
  zone.innerHTML = loaderHTML('Enquête gourmande…');
  const t = state.trip;
  const prompt = `Tu es Acolite, passionné de gastronomie de ${t.nom} (${t.pays}). ${ctx()}
Réponds UNIQUEMENT en JSON :
{
 "specialites":[{"nom":"plat/produit local","emoji":"1 emoji","description":"c'est quoi, en 1-2 phrases appétissantes","ou_gouter":"type d'endroit ou lieu précis","prix":"fourchette locale"}],
 "conseils_locaux":["3-4 conseils culture food locale : usages à table, pourboire, horaires des repas, pièges à touristes"]
}
5-6 spécialités emblématiques.`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.spec = data; state.cache.specVia = via; save();
    renderSpec(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderSpec(d, via){
  $('#zoneSpec').innerHTML = `
    <div style="margin-bottom:10px">${badge(via)}</div>
    ${(d.specialites||[]).map(s=>`
      <div class="item"><div class="emo">${esc(s.emoji||'🥘')}</div>
        <div style="flex:1"><h4>${esc(s.nom)}</h4><p>${esc(s.description)}<br><strong>Où :</strong> ${esc(s.ou_gouter)}</p></div>
        <div class="side"><span class="tag money">${esc(s.prix)}</span></div>
      </div>`).join('')}
    <h3 style="margin:14px 0 10px">Les codes locaux 🤝</h3>
    ${(d.conseils_locaux||[]).map(c=>`<div class="item"><div class="emo">💡</div><p style="margin-top:4px">${esc(c)}</p></div>`).join('')}`;
}

/* ============================================================
   VALISE (light → Groq) — checklist persistée
============================================================ */
async function loadBag(){
  const zone = $('#zoneBag');
  if(state.cache.bag){ renderBag(state.cache.bag, state.cache.bagVia); return; }
  zone.innerHTML = loaderHTML('Préparation de ta checklist…');
  const t = state.trip;
  const R = state.cache._real || {};
  const d = stayDates();
  const nuits = d ? Math.max(1, Math.round((new Date(d.out) - new Date(d.in)) / 86400000)) : null;
  const prompt = `Tu es Acolite. ${ctx()}
Génère la checklist valise idéale pour ce voyage à ${t.nom} (${t.pays}).
${R.meteo ? `MÉTÉO RÉELLE MESURÉE (adapte les vêtements À CES CHIFFRES, ne les contredis pas) : ${R.meteo}` : ''}
${nuits ? `DURÉE EXACTE : ${nuits} nuit(s) — dimensionne les quantités (nombre de t-shirts, sous-vêtements…) sur cette durée précise.` : ''}
${state.cache.plan?.programme?.length ? `PROGRAMME PRÉVU (prévois les tenues adaptées) : ${state.cache.plan.programme.map(j => j.resume).join(' | ')}` : ''}
${state.prefs?.kids ? `Voyage AVEC ${state.prefs.kids} enfant(s) : ajoute le nécessaire.` : ''}
Adapte aux activités probables et au profil.
Réponds UNIQUEMENT en JSON :
{"categories":[
 {"nom":"ex: Vêtements","emoji":"1 emoji","items":["6-10 items courts et concrets, quantités incluses si utile"]}
]}
4-5 catégories (Vêtements, Documents & argent, Tech, Santé & trousse, Spécifique destination).`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.bag = data; state.cache.bagVia = via; save();
    renderBag(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderBag(d, via){
  $('#bagBadge').style.display = via==='groq' ? '' : 'none';
  let html = '';
  (d.categories||[]).forEach((c,ci)=>{
    html += `<h3 style="margin:${ci?14:0}px 0 9px">${esc(c.emoji||'📦')} ${esc(c.nom)}</h3>`;
    (c.items||[]).forEach((it,ii)=>{
      const k = ci + '_' + ii;
      html += `<div class="check ${state.checklist[k]?'done':''}" data-ck="${k}">
        <div class="box">${state.checklist[k]?'✔':''}</div><span>${esc(it)}</span>
      </div>`;
    });
  });
  $('#zoneBag').innerHTML = html;
  updateBagProg();
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-ck]');
  if(!el) return;
  const k = el.dataset.ck;
  state.checklist[k] = !state.checklist[k];
  save();
  el.classList.toggle('done', state.checklist[k]);
  el.querySelector('.box').textContent = state.checklist[k] ? '✔' : '';
  updateBagProg();
  const boxes = $$('#zoneBag .check');
  if(boxes.length && boxes.every(b => b.classList.contains('done'))){ confetti(); toast('🎉 Valise bouclée à 100 % !'); }
});
function updateBagProg(){
  const total = $$('#zoneBag .check').length;
  const done  = $$('#zoneBag .check.done').length;
  $('#bagProg').style.width = total ? Math.round(done/total*100)+'%' : '0%';
  const cnt = $('#bagCnt');
  if(cnt) cnt.textContent = total ? `${done}/${total}` : '';
}

/* ============================================================
   PHRASES (light → Groq)
============================================================ */
async function loadTalk(){
  const zone = $('#zoneTalk');
  if(state.cache.talk){ renderTalk(state.cache.talk, state.cache.talkVia); return; }
  zone.innerHTML = loaderHTML('Traduction en cours…');
  const t = state.trip;
  const prompt = `Tu es Acolite. Destination : ${t.nom} (${t.pays}), langue locale : ${t.langue || 'langue du pays'}.
Si la langue locale est le français, donne plutôt les expressions/argot local typiques de la région.
Réponds UNIQUEMENT en JSON :
{"langue":"nom de la langue","phrases":[
 {"fr":"phrase en français","local":"traduction en langue locale","pron":"prononciation phonétique à la française"}
]}
12 phrases : bonjour/merci/svp, se présenter, commander au resto, demander l'addition, demander son chemin, prix, urgence, "c'est délicieux", "je ne parle pas [langue]", au revoir.`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.talk = data; state.cache.talkVia = via; save();
    renderTalk(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderTalk(d, via){
  $('#talkBadge').style.display = via==='groq' ? '' : 'none';
  $('#zoneTalk').innerHTML = `<h3 style="margin-bottom:12px">Langue : ${esc(d.langue||'')}</h3>` +
    (d.phrases||[]).map(p=>`
      <div class="phrase">
        <div class="fr">${esc(p.fr)}</div>
        <div class="loc">${esc(p.local)}</div>
        <div class="pron">🔊 ${esc(p.pron)}</div>
      </div>`).join('');
}

/* ============================================================
   BUDGET (Gemini · heavy) + tracker dépenses
============================================================ */
const BUD_COLORS = ['#00F0FF','#A855F7','#FFE600','#FF6B00','#22C55E','#EF4444'];

async function loadBudget(){
  const zone = $('#zoneBud');
  if(state.cache.bud){ renderBudget(state.cache.bud); return; }
  zone.innerHTML = loaderHTML('Calcul du budget…');
  const t = state.trip;
  const prompt = `Tu es Acolite, expert budget voyage. ${ctx()}
Estime le budget TOTAL réaliste par personne pour ce séjour à ${t.nom} (${t.pays}), en euros.
Réponds UNIQUEMENT en JSON :
{
 "total_estime":nombre entier en euros,
 "postes":[
   {"nom":"Transport aller-retour","montant":nombre,"detail":"1 phrase"},
   {"nom":"Logement","montant":nombre,"detail":"1 phrase"},
   {"nom":"Repas","montant":nombre,"detail":"1 phrase"},
   {"nom":"Activités & visites","montant":nombre,"detail":"1 phrase"},
   {"nom":"Transports sur place","montant":nombre,"detail":"1 phrase"},
   {"nom":"Extra & imprévus","montant":nombre,"detail":"1 phrase"}
 ],
 "astuces":["3 astuces concrètes pour réduire ce budget de 20-30%"]
}`;
  try{
    const d = await gemini(prompt);
    state.cache.bud = d; save();
    renderBudget(d);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Calcul impossible pour le moment.'); }
}
function renderBudget(d){
  const total = d.total_estime || (d.postes||[]).reduce((a,p)=>a+(+p.montant||0),0);
  const sum = (d.postes||[]).reduce((a,p)=>a+(+p.montant||0),0) || 1;
  $('#zoneBud').innerHTML = `
    <div class="row" style="justify-content:space-between">
      <div><div class="hint" style="margin:0">ESTIMATION TOTALE / PERSONNE <span class="ai-badge gemini">✦ Gemini</span></div>
      <div class="spend-total">${total} €</div></div>
    </div>
    <div class="bud-bar">${(d.postes||[]).map((p,i)=>`<i style="width:${((+p.montant||0)/sum*100).toFixed(1)}%;background:${BUD_COLORS[i%BUD_COLORS.length]}"></i>`).join('')}</div>
    <div class="legend">${(d.postes||[]).map((p,i)=>`<span><span class="sw" style="background:${BUD_COLORS[i%BUD_COLORS.length]}"></span>${esc(p.nom)} <b>${esc(p.montant)}€</b></span>`).join('')}</div>
    ${(d.postes||[]).map((p,i)=>`<div class="item"><div class="emo" style="font-size:1.1rem;color:${BUD_COLORS[i%BUD_COLORS.length]}">■</div><div style="flex:1"><h4>${esc(p.nom)}</h4><p>${esc(p.detail)}</p></div><div class="side"><span class="tag money">${esc(p.montant)} €</span></div></div>`).join('')}
    <h3 style="margin:14px 0 8px">Réduire la note 📉</h3>
    ${(d.astuces||[]).map(a=>`<div class="item"><div class="emo">💡</div><p style="margin-top:4px">${esc(a)}</p></div>`).join('')}`;
}

/* --- dépenses réelles --- */
const _e10 = $('#btnSpend'); if(_e10) _e10.onclick = () => {
  const label = $('#spLabel').value.trim() || 'Dépense';
  const amount = parseFloat($('#spAmount').value);
  if(isNaN(amount) || amount <= 0){ toast('Entre un montant valide 💶'); return; }
  state.spends.push({ label, amount, ts: Date.now() });
  save();
  $('#spLabel').value = ''; $('#spAmount').value = '';
  renderSpends();
};
function renderSpends(){
  const zone = $('#zoneSpends');
  if(!zone) return;
  const total = state.spends.reduce((a, s) => a + s.amount, 0);
  /* budget de référence : celui du plan IA en priorité, sinon l'estimation détaillée */
  const A = (state.prefs?.adults || 1) + (state.prefs?.kids || 0);
  const btPlan = parseInt((String(state.cache.plan?.budget?.total || '').replace(/\s/g,'').match(/\d+/)||[])[0], 10) || 0;
  const est = btPlan * A || state.cache.bud?.total_estime || 0;
  const d = stayDates();
  let bar = '';
  if(est){
    const pct = Math.round(total / est * 100);
    /* rythme attendu : où devrais-tu en être aujourd'hui ? */
    let attendu = null;
    if(d){
      const dep = new Date(d.in), fin = new Date(d.out), now = new Date();
      const nDays = Math.max(1, Math.round((fin - dep) / 86400000));
      const passed = Math.min(nDays, Math.max(0, Math.ceil((now - dep) / 86400000)));
      if(passed > 0 && now <= fin) attendu = Math.round(est * passed / nDays);
    }
    const derive = attendu ? total - attendu : 0;
    const alerte = attendu && Math.abs(derive) > est * 0.08;
    bar = `
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
        <div class="spend-total">${total.toFixed(2)} €</div>
        <span class="tag ${pct > 100 ? 'money' : 'cyan'}">${pct}% du budget (${est} €)</span>
      </div>
      <div class="progress"><i style="width:${Math.min(100, pct)}%;background:${pct > 100 ? 'var(--accent-orange)' : 'var(--primary)'}"></i></div>
      ${alerte ? `<p class="hint" style="margin-top:8px;font-weight:800;color:${derive > 0 ? 'var(--accent-orange)' : 'inherit'}">
        ${derive > 0
          ? `⚠️ Tu dépenses plus vite que prévu : ${Math.round(derive)} € au-dessus du rythme (tu devrais être à ~${attendu} € à ce stade). Lève le pied ou ajuste ton budget.`
          : `✅ Tu es en dessous du rythme prévu : ${Math.abs(Math.round(derive))} € d'avance (attendu ~${attendu} € à ce stade). Tu peux te faire plaisir.`}</p>` : ''}
      ${pct > 100 ? `<p class="hint" style="margin-top:6px;font-weight:800;color:var(--accent-orange)">🚨 Budget dépassé de ${Math.round(total - est)} €.</p>` : ''}`;
  }
  if(!state.spends.length){
    zone.innerHTML = bar + `<p class="hint">Aucune dépense enregistrée. Ajoute-les au fil du séjour : Acolite compare en direct avec le budget prévu par l'IA et te prévient si tu dérives.</p>`;
    return;
  }
  zone.innerHTML = bar + state.spends.map((s, i) => `
      <div class="item" style="padding:10px 14px">
        <div class="emo" style="font-size:1rem">💳</div>
        <div style="flex:1;min-width:0">
          <p style="margin-top:2px">${esc(s.label)}</p>
          <p class="hint" style="margin:0">${new Date(s.ts).toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}</p>
        </div>
        <div class="side row"><span class="tag money">${s.amount.toFixed(2)} €</span><span class="spend-del" data-sp="${i}">🗑</span></div>
      </div>`).join('');
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-sp]');
  if(!el) return;
  state.spends.splice(+el.dataset.sp, 1);
  save(); renderSpends();
});



/* ============================================================
   EXPORT .md
============================================================ */
const _e11 = $('#btnExport'); if(_e11) _e11.onclick = () => {
  if(!state.trip){ toast('Choisis d’abord une destination'); return; }
  const t = state.trip, p = state.prefs || {}, c = state.cache;
  let md = `# ✈️ Voyage Acolite — ${t.nom}, ${t.pays}\n\n`;
  md += `- **Départ :** ${p.from||''}\n- **Durée :** ${p.days||''}\n- **Période :** ${p.when||'flexible'}\n- **Budget :** ${t.budget_estime||''}\n- **Voyageurs :** ${p.who||''}\n\n${t.resume||''}\n`;
  if(c.plan){
    const pl = c.plan;
    md += `\n## 🤖 Plan Acolite${state.planOk ? ' (validé ✅)' : ''}\n`;
    md += `- **Transport choisi :** ${pl.transport?.mode||''} — ${pl.transport?.pourquoi||''} (${pl.transport?.prix_estime||''})\n`;
    md += `- **Logement :** ${pl.logement?.type||''} à ${pl.logement?.quartier||''} (${pl.logement?.prix_nuit||''}/nuit)\n`;
    md += `- **Budget total :** ${pl.budget?.total||''} €/pers — ${pl.budget?.repartition||''}\n`;
    (pl.programme||[]).forEach(j=> md += `- Jour ${j.jour} : ${j.resume}\n`);
    if(pl.sur_place) md += `- **Sur place :** ${pl.sur_place}\n`;
    (pl.a_reserver||[]).forEach(r=> md += `- 🎟️ À réserver tôt : ${r}\n`);
    md += `- 💡 ${pl.conseil_cle||''}\n`;
  }
  const tr = c['transport_'+state.mode];
  if(tr){
    md += `\n## 🛫 Transport (${state.mode})\n`;
    Object.entries(tr).forEach(([k,v])=>{
      if(Array.isArray(v)) md += `- **${k} :**\n` + v.map(x=>`  - ${x}`).join('\n') + '\n';
      else md += `- **${k} :** ${v}\n`;
    });
  }
  if(c.stay){
    md += `\n## 🏨 Logement\n${c.stay.type_conseille||''}\n`;
    (c.stay.quartiers||[]).forEach(q=> md += `- **${q.nom}** (${q.prix_nuit}) — ${q.pourquoi}\n`);
  }
  if(c.fullPlan){
    md += `\n## 📆 Programme\n`;
    (c.fullPlan.jours||[]).forEach(j=>{
      md += `\n### Jour ${j.jour} — ${j.titre}\n`;
      (j.etapes||[]).forEach(e=> md += `- **${e.heure}** ${e.titre}${e.lieu?` _(${e.lieu})_`:''} — ${e.description}\n`);
    });
  }
  if(c.food){ md += `\n## 🍽️ Restos\n`; (c.food.restos||[]).forEach(r=> md += `- **${r.nom}** (${r.budget}, ${r.quartier}) — à commander : ${r.plat_star}\n`); }
  if(c.spec){ md += `\n## 🥘 Spécialités\n`; (c.spec.specialites||[]).forEach(s=> md += `- **${s.nom}** (${s.prix}) — ${s.description} Où : ${s.ou_gouter}\n`); }
  if(c.shop){ md += `\n## 🛒 Courses\n`; (c.shop.supermarches||[]).forEach(s=> md += `- ${s.nom} (${s.niveau}) — ${s.astuce}\n`); }
  if(c.bag){ md += `\n## 🎒 Valise\n`; (c.bag.categories||[]).forEach(cat=>{ md += `\n**${cat.nom}**\n`; (cat.items||[]).forEach(i=> md += `- [ ] ${i}\n`); }); }
  if(c.talk){ md += `\n## 🗣️ Phrases utiles (${c.talk.langue||''})\n`; (c.talk.phrases||[]).forEach(ph=> md += `- ${ph.fr} → **${ph.local}** _(${ph.pron})_\n`); }
  if(c.bud){ md += `\n## 💶 Budget estimé : ${c.bud.total_estime} €/pers\n`; (c.bud.postes||[]).forEach(po=> md += `- ${po.nom} : ${po.montant} €\n`); }
  if(c.act){ md += `\n## 🎡 Activités\n`; (c.act.activites||[]).forEach(a=> md += `- **${a.nom}** (${a.prix}, ${a.duree}) — ${a.description}\n`); }
  if(c.info){
    md += `\n## 🛟 Infos pratiques\n`;
    Object.entries(c.info).forEach(([k,v])=> md += `- **${k} :** ${v}\n`);
  }
  if(state.resas.length){
    md += `\n## 📎 Réservations\n`;
    state.resas.forEach(r=> md += `- ${r.type} — ${r.ref}${r.link?` (${r.link})`:''}\n`);
  }
  if(state.notes.trim()){ md += `\n## 📝 Notes\n${state.notes}\n`; }
  if(state.spends.length){
    const tot = state.spends.reduce((a,s)=>a+s.amount,0);
    md += `\n## 💳 Dépenses réelles : ${tot.toFixed(2)} €\n`;
    state.spends.forEach(s=> md += `- ${s.label} : ${s.amount.toFixed(2)} €\n`);
  }
  md += `\n---\n_Généré par Acolite ✦ Gemini ⚡ Groq_\n`;
  const blob = new Blob([md], {type:'text/markdown'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `acolite-${t.nom.toLowerCase().replace(/[^a-z0-9]+/g,'-')}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Voyage exporté 📄');
};

/* ============================================================
   CARTES HORS-LIGNE — une carte par journée (tuiles OSM → image
   en cache local) : consultable sans réseau + intégrée au carnet
============================================================ */
const _lon2t = (lon, z) => (lon + 180) / 360 * Math.pow(2, z);
const _lat2t = (lat, z) => (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, z);
function loadTileImg(url){
  return new Promise(res => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = url;
  });
}
async function buildDayMap(jour){
  const t = state.trip, plan = state.cache.plan;
  const jr = (plan?.programme || []).find(x => String(x.jour) === String(jour));
  if(!t || !jr) return null;
  const cc = ccFor(t.pays);
  /* géocode les lieux du jour (les monuments échouent parfois → on garde ceux trouvés) */
  const lieux = (jr.lieux || []).filter(Boolean).slice(0, 4);
  const found = [];
  for(const l of lieux){
    const g0 = await geoPlace(cleanPlace(l), cc);
    if(g0) found.push({ nom: l, lat: +g0.latitude, lon: +g0.longitude });
  }
  /* repli : la base du jour (multi-étapes) sinon le centre-ville */
  if(!found.length){
    const g0 = (jr.base ? await geoPlace(cleanPlace(jr.base), cc) : null) || await geocode();
    if(!g0) return null;
    found.push({ nom: jr.base || t.nom, lat: +g0.latitude, lon: +g0.longitude });
  }
  /* filtre les points aberrants (géocodage parti dans un autre pays : > 80 km du 1er) */
  const ref = found[0];
  const pts = found.filter(p => havKm({latitude:ref.lat, longitude:ref.lon}, {latitude:p.lat, longitude:p.lon}) < 80);
  /* zoom qui fait tenir tous les points dans 3×2 tuiles */
  let z = 15;
  for(; z > 10; z--){
    const xs = pts.map(p => _lon2t(p.lon, z)), ys = pts.map(p => _lat2t(p.lat, z));
    if(Math.max(...xs) - Math.min(...xs) < 2.4 && Math.max(...ys) - Math.min(...ys) < 1.5) break;
  }
  const cx = pts.reduce((a, p) => a + _lon2t(p.lon, z), 0) / pts.length;
  const cy = pts.reduce((a, p) => a + _lat2t(p.lat, z), 0) / pts.length;
  const startX = Math.floor(cx - 1.5), startY = Math.floor(cy - 1);
  /* 3×2 tuiles de 256 → 768×512 */
  const cv = document.createElement('canvas'); cv.width = 768; cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#e8e4da'; g.fillRect(0, 0, 768, 512);
  const jobs = [];
  for(let dx = 0; dx < 3; dx++) for(let dy = 0; dy < 2; dy++)
    jobs.push(loadTileImg(`https://tile.openstreetmap.org/${z}/${startX + dx}/${startY + dy}.png`)
      .then(im => ({ im, dx, dy })));
  const tiles = await Promise.all(jobs);
  const okTiles = tiles.filter(x => x.im);
  if(!okTiles.length) return null;              /* aucun réseau/tuile → pas de carte */
  okTiles.forEach(({ im, dx, dy }) => g.drawImage(im, dx * 256, dy * 256, 256, 256));
  /* pins numérotés */
  pts.forEach((p, i) => {
    const x = (_lon2t(p.lon, z) - startX) * 256, y = (_lat2t(p.lat, z) - startY) * 256;
    if(x < 8 || y < 8 || x > 760 || y > 504) return;
    g.fillStyle = '#101010'; g.beginPath(); g.arc(x + 2, y + 2, 15, 0, 7); g.fill();
    g.fillStyle = '#FFE600'; g.beginPath(); g.arc(x, y, 15, 0, 7); g.fill();
    g.strokeStyle = '#101010'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#101010'; g.font = '900 16px Sora, Arial'; g.textAlign = 'center';
    g.fillText(String(i + 1), x, y + 6); g.textAlign = 'left';
  });
  /* bandeau titre + légende + attribution */
  g.fillStyle = '#FFE600'; g.fillRect(0, 0, 768, 40);
  g.strokeStyle = '#101010'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, 765, 37);
  g.fillStyle = '#101010'; g.font = '900 19px Sora, Arial';
  g.fillText(`Jour ${jour} — ${String(jr.resume || '').slice(0, 44)}`, 14, 27);
  const leg = pts.map((p, i) => `${i + 1}·${String(p.nom).split(',')[0].slice(0, 18)}`).join('   ');
  g.fillStyle = 'rgba(255,255,255,.94)'; g.fillRect(0, 512 - 30, 768, 30);
  g.fillStyle = '#101010'; g.font = '700 13px Inter, Arial';
  g.fillText(leg.slice(0, 88), 12, 512 - 10);
  g.textAlign = 'right'; g.fillStyle = '#555'; g.font = '600 11px Arial';
  g.fillText('© OpenStreetMap contributors', 758, 512 - 10); g.textAlign = 'left';
  return cv.toDataURL('image/jpeg', 0.72);
}
async function prepareOfflineMaps(){
  const plan = state.cache.plan;
  if(!state.trip || !(plan?.programme || []).length){ toast('Génère d’abord le plan (étape 3) 😉'); return; }
  const btn = $('#btnMaps'); if(btn){ btn.disabled = true; }
  state.cache.maps = state.cache.maps || {};
  let ok = 0, ko = 0;
  for(const jr of plan.programme){
    if(state.cache.maps[jr.jour]){ ok++; continue; }
    toast(`🗺️ Carte du jour ${jr.jour}…`);
    try{
      const url = await buildDayMap(jr.jour);
      if(url){ state.cache.maps[jr.jour] = url; ok++; save(); }
      else ko++;
    }catch(e){ ko++; }
  }
  if(btn) btn.disabled = false;
  renderPlan(plan);   /* réaffiche avec les vignettes cartes */
  toast(ok ? `🗺️ ${ok} carte(s) prête(s) hors-ligne ✔${ko ? ` (${ko} indisponible(s))` : ''}` : '🗺️ Cartes indisponibles — vérifie ta connexion');
}
const _eMaps = $('#btnMaps'); if(_eMaps) _eMaps.onclick = prepareOfflineMaps;

/* ============================================================
   CARNET DE VOYAGE (PDF) — plan complet + réservations, pensé
   pour être imprimé/enregistré en PDF AVANT le départ (hors-ligne)
============================================================ */
function buildDossierHTML(){
  const t = state.trip, p = state.prefs || {}, pl = state.cache.plan || {}, d = stayDates();
  const days = state.cache.days || {};
  const esc2 = esc;
  const dates = d ? `${d.in} → ${d.out}` : (p.when || 'dates flexibles');
  const A = `${p.adults || 2} adulte(s)${p.kids ? ' + ' + p.kids + ' enfant(s)' : ''}`;
  let h = `<div class="cover">
    <p class="brand">ACOLITE · CARNET DE VOYAGE</p>
    <h1>${esc2(t.nom)}</h1>
    <div class="rule"></div>
    <p class="meta">${esc2(t.pays || '')}${t.pays ? ' · ' : ''}${esc2(dates)}<br>${esc2(A)} · départ de ${esc2(p.from || '—')}</p>
  </div>`;
  h += `<section><h2>L'essentiel</h2><table>
    <tr><th>Transport</th><td>${esc2(pl.transport?.mode || '—')} · ${esc2(pl.transport?.prix_estime || '')}<br>${esc2(pl.transport?.details || '')}</td></tr>
    <tr><th>Logement</th><td>${(pl.logement?.etapes || []).length
      ? pl.logement.etapes.map(e => `${esc2(e.ville || '')} — ${esc2(e.quartier || '')} · ${esc2(String(e.nuits ?? '?'))} nuit(s)${e.prix_nuit ? ' · ' + esc2(e.prix_nuit) + '/nuit' : ''}`).join('<br>')
      : `${esc2(pl.logement?.type || '—')} · quartier ${esc2(pl.logement?.quartier || '—')} · ${esc2(pl.logement?.prix_nuit || '')}/nuit`}</td></tr>
    <tr><th>Budget</th><td>${esc2(String(pl.budget?.total ?? '—'))} €/pers — ${esc2(pl.budget?.repartition || '')}</td></tr>
    ${pl.sur_place ? `<tr><th>Sur place</th><td>${esc2(pl.sur_place)}</td></tr>` : ''}
  </table></section>`;
  if(state.resas?.length){
    h += `<section><h2>Réservations &amp; références</h2><table class="refs">` +
      state.resas.map(r => `<tr><th>${esc2(r.type)}</th><td><strong>${esc2(r.ref)}</strong>${r.link ? `<span class="lnk">${esc2(r.link)}</span>` : ''}</td></tr>`).join('') +
      `</table></section>`;
  }
  if((pl.a_reserver || []).length){
    h += `<section><h2>À réserver à l'avance</h2><ul>` + pl.a_reserver.map(r => `<li>${esc2(r)}</li>`).join('') + `</ul></section>`;
  }
  if((pl.programme || []).length){
    h += `<section><h2>Programme jour par jour</h2>`;
    pl.programme.forEach(j => {
      h += `<div class="dj"><h3>Jour ${esc2(String(j.jour))} — ${esc2(j.resume || '')}${j.base ? ` <small>(${esc2(j.base)})</small>` : ''}</h3>`;
      if((j.lieux || []).length) h += `<p class="lieux">📍 ${j.lieux.map(esc2).join(' · ')}</p>`;
      if(state.cache.maps?.[j.jour]) h += `<img class="djmap" src="${state.cache.maps[j.jour]}" alt="Carte jour ${esc2(String(j.jour))}">`;
      const det = days[j.jour];
      if(det?.etapes?.length){
        h += `<ul class="heures">` + det.etapes.map(e =>
          `<li><strong>${esc2(e.heure || '')}</strong> ${esc2(e.titre || '')}${e.lieu ? ` <em>(${esc2(e.lieu)})</em>` : ''} — ${esc2(e.description || '')}</li>`).join('') + `</ul>`;
      }
      const coms = state.board?.comments?.[String(j.jour)] || [];
      if(coms.length) h += `<p class="lieux">💬 ${coms.map(c => `<strong>${esc2(c.who)}</strong> : ${esc2(c.txt)}`).join(' · ')}</p>`;
      h += `</div>`;
    });
    h += `</section>`;
  }
  const info = state.cache['cinfo_' + (t.pays || t.nom)];
  if(info){
    const rows = [['🛂 Formalités', info.visa], ['🔌 Prises', info.prise], ['🚨 Urgences', info.urgence], ['💶 Pourboire', info.pourboire],
                  ['🚰 Eau', info.eau], ['🕐 Décalage', info.decalage], ['💉 Santé', info.sante]].filter(r => r[1]);
    if(rows.length) h += `<section><h2>Infos pratiques</h2><table>` +
      rows.map(r => `<tr><th>${r[0]}</th><td>${esc2(String(r[1]))}</td></tr>`).join('') + `</table></section>`;
  }
  if(pl.conseil_cle) h += `<section><h2>Le conseil à retenir</h2><p>${esc2(pl.conseil_cle)}</p></section>`;
  if((state.notes || '').trim()) h += `<section><h2>Mes notes</h2><p>${esc2(state.notes).replace(/\n/g, '<br>')}</p></section>`;
  h += `<footer>Ticket souvenir — ne permet pas d'embarquer. Prix et horaires : estimations à vérifier. acolite</footer>`;
  return h;
}
function openDossier(){
  if(!state.trip){ toast('Choisis d’abord un voyage'); return; }
  if(!state.cache.plan){ toast('Génère d’abord le plan (étape 3) 😉'); return; }
  const dz = $('#dossier');
  dz.innerHTML = buildDossierHTML();
  dz.hidden = false;
  const done = () => { dz.hidden = true; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();   /* le voyageur choisit « Enregistrer en PDF » */
  toast('📄 Choisis « Enregistrer au format PDF » dans la fenêtre d’impression');
}
const _eDos = $('#btnDossier'); if(_eDos) _eDos.onclick = openDossier;

/* --- Signal hors-ligne : rassure le voyageur, son plan reste là --- */
window.addEventListener('offline', () => toast('📴 Hors connexion — ton plan reste consultable dans Acolite'));

/* --- Sauvegarde / restauration du voyage complet (fichier .json) ---
   Sécurise les données contre un vidage du localStorage / changement d'appareil. */
function backupTrip(){
  try{
    const data = { _acolite: 'trip-backup', v: 1, when: Date.now(), state };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `acolite-voyage-${String(state.trip?.nom || 'brouillon').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('💾 Voyage sauvegardé dans un fichier');
  }catch(e){ toast('Sauvegarde impossible'); }
}
function restoreTrip(file){
  const rd = new FileReader();
  rd.onload = () => {
    try{
      const data = JSON.parse(rd.result);
      const s = (data && data.state) ? data.state : data;   /* tolère un state brut */
      const looksAcolite = data?._acolite === 'trip-backup' || (s && ['trip','prefs','cache','destinations'].some(k => k in s));
      if(!s || typeof s !== 'object' || Array.isArray(s) || !looksAcolite) throw new Error('bad');
      state = { ...state, ...s };
      save();
      _pcPhotos = null;   /* invalide les photos de la carte postale */
      toast('📂 Voyage importé ✔');
      renderGallery();
      if(state.trip){ unlockSteps(); gotoStep(Math.min(3, state.step || 3)); }
      else gotoStep(1);
    }catch(e){ toast('Fichier invalide — ce n’est pas une sauvegarde Acolite'); }
  };
  rd.onerror = () => toast('Lecture du fichier impossible');
  rd.readAsText(file);
}
const _eBk = $('#btnBackup'); if(_eBk) _eBk.onclick = backupTrip;
const _eRs = $('#btnRestore'); if(_eRs) _eRs.onclick = () => $('#restoreFile')?.click();
const _eRf = $('#restoreFile'); if(_eRf) _eRf.onchange = (e) => { const f = e.target.files?.[0]; if(f) restoreTrip(f); e.target.value = ''; };

/* ============================================================
   ACTIVITÉS & EXPÉRIENCES (Gemini · heavy)
============================================================ */
async function loadAct(){
  const zone = $('#zoneAct');
  const t = state.trip;
  // liens de résa (toujours dispo)
  const gyg = `https://www.getyourguide.fr/-l0/?q=${encodeURIComponent(t.nom)}`;
  const civ = `https://www.civitatis.com/fr/?ns_campaign=acolite#s=${encodeURIComponent(t.nom)}`;
  const tam = `https://www.tripadvisor.fr/Search?q=${encodeURIComponent(t.nom + ' activités')}`;
  $('#actLinks').innerHTML = `
    <a class="btn" href="${gyg}" target="_blank" rel="noopener">GetYourGuide</a>
    <a class="btn ghost" href="${civ}" target="_blank" rel="noopener">Civitatis</a>
    <a class="btn ghost" href="${tam}" target="_blank" rel="noopener">Tripadvisor</a>`;
  if(state.cache.act){ renderAct(state.cache.act); return; }
  zone.innerHTML = loaderHTML('Repérage des meilleures activités…');
  const prompt = `Tu es Acolite, guide local de ${t.nom} (${t.pays}). ${ctx()}
Liste les meilleures activités et expériences à vivre sur place, adaptées au profil.
Réponds UNIQUEMENT en JSON :
{"activites":[
 {"nom":"nom de l'activité/lieu","emoji":"1 emoji","categorie":"incontournable|nature|culture|sensation|détente|photo|famille","description":"1-2 phrases concrètes","duree":"ex: 2h","prix":"gratuit / fourchette €","reserver":"oui" ou "non","astuce":"1 conseil (meilleur horaire, coupe-file…)"}
]}
Exactement 7 activités VARIÉES et vraiment marquantes à ${t.nom}.`;
  try{
    const d = await gemini(prompt);
    state.cache.act = d; save();
    renderAct(d);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderAct(d){
  const t = state.trip;
  const catCol = {incontournable:'money', nature:'', culture:'cyan', sensation:'', 'détente':'cyan', photo:'', famille:'cyan'};
  $('#zoneAct').innerHTML = (d.activites||[]).map(a=>`
    <div class="item">
      <div class="emo">${esc(a.emoji||'🎡')}</div>
      <div style="flex:1">
        <h4>${esc(a.nom)} <span class="tag ${catCol[a.categorie]||''}" style="margin-left:6px">${esc(a.categorie)}</span></h4>
        <p>${esc(a.description)}<br><strong>💡 </strong>${esc(a.astuce)}</p>
        <div class="row" style="margin-top:8px">
          <span class="tl-loc" data-loc="${esc(a.nom)}">📍 Carte</span>
          ${a.reserver==='oui' ? `<a class="tl-loc" href="https://www.getyourguide.fr/s/?q=${encodeURIComponent(a.nom + ' ' + t.nom)}" target="_blank" rel="noopener">🎫 Réserver</a>` : ''}
        </div>
      </div>
      <div class="side"><span class="tag money">${esc(a.prix)}</span><p style="font-size:.72rem;margin-top:5px">⏱ ${esc(a.duree)}</p></div>
    </div>`).join('');
}

/* ============================================================
   OUTILS — APIs publiques gratuites, données réelles
   Open-Meteo (géo + météo) · Frankfurter (devises) · Groq (traduction)
============================================================ */
async function loadTools(){
  loadMeteo(); loadTimeAndCurrency(); startCountdown();
}

// --- Géocodage (Open-Meteo geocoding, sans clé) ---
async function geocode(){
  if(state._geo) return state._geo;
  const t = state.trip;
  if(!t) return null;
  const cc = ccFor(t.pays);
  for(const nom of [...new Set([t.ville_aeroport, t.nom, t.pays].map(cleanPlace).filter(Boolean))]){
    const g = await geoPlace(nom, cc);
    if(g){ state._geo = g; return g; }
  }
  return null;
}

// --- Météo 7 jours (Open-Meteo, données réelles gratuites) ---
async function loadMeteo(){
  const zone = $('#zoneMeteo');
  const g = await geocode();
  if(!g){ zone.innerHTML = errHTML('Localisation introuvable pour la météo.'); return; }
  try{
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=7`);
    const d = await r.json();
    const wmo = c => {
      if(c===0) return ['☀️','Ensoleillé'];
      if(c<=2) return ['🌤️','Peu nuageux'];
      if(c===3) return ['☁️','Couvert'];
      if(c<=48) return ['🌫️','Brouillard'];
      if(c<=67) return ['🌧️','Pluie'];
      if(c<=77) return ['🌨️','Neige'];
      if(c<=82) return ['🌦️','Averses'];
      if(c<=99) return ['⛈️','Orage'];
      return ['🌡️','—'];
    };
    const days = d.daily.time.map((t,i)=>{
      const w = wmo(d.daily.weather_code[i]);
      const dt = new Date(t);
      const jour = dt.toLocaleDateString('fr-FR',{weekday:'short',day:'numeric'});
      return `<div class="item" style="flex-direction:column;align-items:center;text-align:center;min-width:92px;padding:12px 8px;box-shadow:none">
        <div style="font-size:.74rem;color:var(--txt-2);text-transform:capitalize">${jour}</div>
        <div style="font-size:1.6rem;margin:4px 0">${w[0]}</div>
        <div style="font-size:.72rem;color:var(--txt-2)">${w[1]}</div>
        <div style="font-family:'Sora';font-weight:900;margin-top:4px">${Math.round(d.daily.temperature_2m_max[i])}°<span style="color:var(--txt-2);font-weight:400"> / ${Math.round(d.daily.temperature_2m_min[i])}°</span></div>
        <div style="font-size:.7rem;color:#00F0FF;margin-top:3px;font-weight:800">💧 ${d.daily.precipitation_probability_max[i]??0}%</div>
      </div>`;
    }).join('');
    zone.innerHTML = `<div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:6px">${days}</div>`;
  }catch(e){ zone.innerHTML = errHTML('Météo indisponible pour le moment.'); }
}

// --- Heure locale + devises ---
async function loadTimeAndCurrency(){
  const g = await geocode();
  const t = state.trip;
  // heure locale via le timezone renvoyé par la météo
  try{
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m&timezone=auto`);
    const d = await r.json();
    const tz = d.timezone;
    const now = new Date();
    const localStr = now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',timeZone:tz});
    const hereStr  = now.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Paris'});
    const offH = Math.round((d.utc_offset_seconds - now.getTimezoneOffset()*-60)/3600);
    const decal = offH===0 ? 'Même fuseau qu\'en France' : `${offH>0?'+':''}${offH}h par rapport à la France`;
    $('#zoneTime').innerHTML = `<div class="emo">🕐</div><div style="flex:1"><h4>Il est <span style="background:var(--primary);padding:2px 6px;border:1px solid var(--stroke)">${localStr}</span> à ${esc(t.nom)}</h4><p>${decal} · Fuseau ${esc(tz)} · (${hereStr} en France)</p></div>`;
  }catch(e){ $('#zoneTime').innerHTML = `<div class="emo">🕐</div><p style="margin-top:4px">Heure locale indisponible.</p>`; }
  // devises via Frankfurter (BCE, gratuit sans clé)
  const cur = (t.monnaie||'').match(/[A-Z]{3}/)?.[0] || guessCurrency(t.monnaie);
  renderCurrency(cur);
}
function guessCurrency(name){
  const m = {'euro':'EUR','livre':'GBP','dollar':'USD','yen':'JPY','franc suisse':'CHF','couronne':'SEK','zloty':'PLN','forint':'HUF','dirham':'MAD','roupie':'INR','baht':'THB','peso':'MXN','real':'BRL','rand':'ZAR','lira':'TRY','won':'KRW','yuan':'CNY','rouble':'RUB','dinar':'TND'};
  const l = (name||'').toLowerCase();
  for(const k in m) if(l.includes(k)) return m[k];
  return 'USD';
}
async function renderCurrency(cur){
  const zone = $('#zoneCur');
  if(cur === 'EUR'){ zone.innerHTML = `<div class="item"><div class="emo">💶</div><p style="margin-top:4px">La destination est en <strong>zone euro</strong> — aucune conversion nécessaire !</p></div>`; return; }
  try{
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?base=EUR&symbols=${cur}`);
    const d = await r.json();
    const rate = d.rates?.[cur];
    if(!rate) throw 0;
    zone.innerHTML = `
      <div class="item"><div class="emo">💱</div><div style="flex:1">
        <h4>1 € = <span style="background:var(--primary);padding:2px 6px;border:1px solid var(--stroke)">${rate.toFixed(2)} ${esc(cur)}</span></h4>
        <p>Taux officiel BCE du jour · 1 ${esc(cur)} = ${(1/rate).toFixed(3)} €</p></div></div>
      <div class="row" style="margin-top:6px">
        <input id="curEur" type="number" placeholder="Montant en €" style="flex:1;min-width:120px" oninput="convCur(${rate},'eur')">
        <span style="align-self:center;color:var(--txt);font-weight:900">⇄</span>
        <input id="curLoc" type="number" placeholder="Montant en ${esc(cur)}" style="flex:1;min-width:120px" oninput="convCur(${rate},'loc')">
      </div>`;
  }catch(e){ zone.innerHTML = errHTML('Taux de change indisponible.'); }
}
window.convCur = (rate, from) => {
  const e = $('#curEur'), l = $('#curLoc');
  if(from==='eur'){ l.value = e.value ? (parseFloat(e.value)*rate).toFixed(2) : ''; }
  else { e.value = l.value ? (parseFloat(l.value)/rate).toFixed(2) : ''; }
};

// --- Traducteur express (light → Groq) ---
const _e12 = $('#btnTr'); if(_e12) _e12.onclick = async () => {
  const q = $('#trInp').value.trim();
  if(!q) return;
  const t = state.trip;
  $('#zoneTr').innerHTML = loaderHTML('Traduction…');
  const prompt = `Traduis cette phrase française vers ${t.langue || 'la langue locale de ' + t.pays}.
Phrase : "${q}"
Réponds UNIQUEMENT en JSON : {"local":"la traduction","pron":"prononciation phonétique à la française"}`;
  try{
    const {data, via} = await ai('light', prompt);
    $('#trBadge').style.display = via==='groq' ? '' : 'none';
    $('#zoneTr').innerHTML = `<div class="phrase"><div class="fr">${esc(q)}</div><div class="loc">${esc(data.local)}</div><div class="pron">🔊 ${esc(data.pron)}</div></div>`;
  }catch(e){ if(e.message!=='NO_KEY') $('#zoneTr').innerHTML = errHTML('Traduction impossible.'); }
};
const _trI = $('#trInp'); if(_trI) _trI.addEventListener('keydown', e => { if(e.key==='Enter') $('#btnTr')?.click(); });

// --- Compte à rebours ---
let countT;
function startCountdown(){
  clearInterval(countT);
  const dep = state.prefs?.depart;
  const zone = $('#zoneCount');
  if(!dep){ zone.innerHTML = `<div class="emo">🎉</div><p style="margin-top:4px">Renseigne ta date de départ à l'étape 1 pour lancer le compte à rebours.</p>`; return; }
  const target = new Date(dep + 'T00:00:00');
  const tick = () => {
    if(!state.trip){ clearInterval(countT); return; }   /* voyage changé entre-temps → on arrête */
    const diff = target - new Date();
    if(diff <= 0){ zone.innerHTML = `<div class="emo">🏖️</div><p style="margin-top:4px"><strong>C'est parti — bon voyage à ${esc(state.trip.nom)} !</strong></p>`; clearInterval(countT); return; }
    const j = Math.floor(diff/864e5), h = Math.floor(diff%864e5/36e5), m = Math.floor(diff%36e5/6e4);
    zone.innerHTML = `<div class="emo">⏳</div><div style="flex:1"><h4>Départ dans <span style="background:var(--primary);padding:2px 6px;border:1px solid var(--stroke)">${j} jours ${h}h ${m}min</span></h4><p>Le ${target.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'})} · direction ${esc(state.trip.nom)} ${esc(state.trip.drapeau||'')}</p></div>`;
  };
  tick(); countT = setInterval(tick, 30000);
}

/* ============================================================
   CARNET — notes + réservations (localStorage)
============================================================ */
let noteT;
function initNote(){
  const a = $('#noteArea');
  a.value = state.notes || '';
  a.oninput = () => {
    state.notes = a.value;
    clearTimeout(noteT);
    noteT = setTimeout(()=>{ save(); $('#noteSaved').textContent = 'Enregistré ✓ ' + new Date().toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}); }, 500);
  };
}
const _e13 = $('#btnRes'); if(_e13) _e13.onclick = () => {
  const ref = $('#resRef').value.trim();
  if(!ref){ toast('Ajoute au moins une référence'); return; }
  state.resas.push({ type: $('#resType').value, ref, link: $('#resLink').value.trim() });
  save();
  $('#resRef').value = ''; $('#resLink').value = '';
  renderResas();
  toast('Réservation ajoutée 📎');
};
function renderResas(){
  const zone = $('#zoneRes');
  if(!state.resas.length){ zone.innerHTML = `<p class="hint">Aucune réservation enregistrée. Garde tes numéros de résa à portée de main.</p>`; return; }
  zone.innerHTML = state.resas.map((r,i)=>`
    <div class="item" style="padding:12px 14px">
      <div class="emo">${esc(r.type.split(' ')[0])}</div>
      <div style="flex:1"><h4>${esc(r.type.replace(/^\S+\s/,''))}</h4><p>${esc(r.ref)}${r.link?` · <a href="${esc(r.link)}" target="_blank" rel="noopener" style="color:var(--accent-orange);font-weight:900">ouvrir ↗</a>`:''}</p></div>
      <div class="side"><span class="spend-del" data-res="${i}">🗑</span></div>
    </div>`).join('');
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-res]');
  if(!el) return;
  state.resas.splice(+el.dataset.res, 1);
  save(); renderResas();
});

/* ============================================================
   UI GÉNÉRALE
============================================================ */
const _e14 = $('#btnGo'); if(_e14) _e14.onclick = () => { state.propAnswers = []; state._qsDone = false; proposeTrips(); };
const _e15 = $('#btnLucky'); if(_e15) _e15.onclick = () => { state.propAnswers = []; state._qsDone = false; proposeTrips('', true); };
const _e15b = $('#btnCountry'); if(_e15b) _e15b.onclick = () => {
  const c = $('#fDest').value.trim();
  if(!c){ toast('Écris un pays dans « Destination souhaitée » 😉'); $('#fDest').focus(); return; }
  state.propAnswers = []; state._qsDone = false;
  proposeTrips('', false, c);
};



const _e16 = $('#btnReset'); if(_e16) _e16.onclick = () => {
  if(!confirm('Repartir de zéro ? (tes clés API sont conservées)')) return;
  localStorage.removeItem(LS_TRIP);
  location.reload();
};

/* ============================================================
   COMPTE — création, connexion, vérification par email
   Stockage local (test) · envoi du code via EmailJS si configuré,
   sinon mode démo (code affiché à l'écran).
============================================================ */
const LS_USER = 'acolite_user';
const LS_AUTH = 'acolite_logged';
const getUser = () => { try{ return JSON.parse(localStorage.getItem(LS_USER)); }catch(e){ return null; } };
const setUser = u => lsSet(LS_USER, JSON.stringify(u));

async function sha(txt){
  try{
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(txt));
    return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
  }catch(e){ /* contexte non sécurisé (file://) → hash simple de secours */
    let h = 0; for(const c of txt){ h = (h*31 + c.charCodeAt(0)) >>> 0; } return 'x' + h.toString(16);
  }
}

function authErr(msg){ const el = $('#authErr'); if(!msg){ el.classList.add('hidden'); return; } el.textContent = msg; el.classList.remove('hidden'); }
function authShow(which){
  ['authSignup','authLogin','authVerify'].forEach(id => $('#'+id).classList.toggle('hidden', id !== which));
  authErr('');
  $('#authSub').textContent = which==='authSignup' ? "Crée ton compte pour commencer l'aventure."
    : which==='authLogin' ? 'Content de te revoir !' : 'Dernière étape : vérifie ton email.';
}


/* ============================================================
   COMPTES CÔTÉ SERVEUR
   Le navigateur ne génère plus aucun code et n'envoie plus aucun email :
   il demande, le serveur décide. C'est ce qui empêche de s'approprier
   l'adresse d'un autre en lisant le code dans la console.
============================================================ */
const LS_TOKEN = 'acolite_token';
const authToken = () => { try{ return localStorage.getItem(LS_TOKEN) || ''; }catch(e){ return ''; } };
const setToken = t => lsSet(LS_TOKEN, t);
const clearToken = () => { try{ localStorage.removeItem(LS_TOKEN); }catch(e){} };

/* Appel au backend. Renvoie toujours { ok, data } — jamais d'exception,
   pour qu'un réseau coupé n'interrompe pas l'action en cours. */
async function srvFetch(path, { method = 'GET', body = null, auth = false } = {}){
  const base = (CFG.proxy || '').replace(/\/+$/, '');
  if(!base) return { ok:false, data:{ error:"Le serveur n'est pas configuré" } };
  const headers = {};
  if(body) headers['Content-Type'] = 'application/json';
  if(auth) headers.Authorization = 'Bearer ' + authToken();
  try{
    const r = await fetchT(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    }, netTimeout(15000));
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }catch(e){
    return { ok:false, data:{ error:'Serveur injoignable — vérifie ta connexion' } };
  }
}

/* --- Synchronisation des voyages ---
   On n'envoie PAS l'état brut : state.cache.maps contient les cartes
   hors-ligne en JPEG base64 (des centaines de Ko), qui feraient dépasser
   la limite du serveur — le voyage ne serait alors jamais enregistré.
   Ces images se régénèrent sur l'autre appareil ; on ne synchronise que
   ce qui ne se recalcule pas : le voyage et ce que l'IA a produit. */
function slimTrip(){
  const { cache, ...rest } = state || {};
  const c = cache || {};
  return {
    ...rest,
    cache: {                       /* on garde le fruit du raisonnement IA… */
      plan: c.plan, _real: c._real, hotels: c.hotels,
      events: c.events, transport: c.transport,
    },                             /* …mais jamais les images (maps, postcard) */
  };
}
function histLocal(){
  try{ return JSON.parse(localStorage.getItem(LS_HIST)) || []; }catch(e){ return []; }
}
function syncPayload(){
  return { trip: slimTrip(), history: histLocal() };
}
let _syncT = null;
let _syncWarned = false;   /* on ne prévient qu'une fois par session */
function pushSync(){
  if(!authToken()) return;
  clearTimeout(_syncT);                       /* on groupe les rafales de save() */
  _syncT = setTimeout(async () => {
    const r = await srvFetch('/sync', { method:'POST', body:{ payload: syncPayload() }, auth:true });
    /* un échec de synchro ne doit pas passer inaperçu : c'est ce qui nous
       avait fait croire que « ça marche » alors que le serveur refusait */
    if(!r.ok && !_syncWarned){
      _syncWarned = true;
      toast(r.status === 413
        ? '⚠️ Voyage trop lourd pour la synchro — il reste sur cet appareil'
        : '⚠️ Synchronisation en pause — tes voyages restent sur cet appareil');
    }else if(r.ok){ _syncWarned = false; }
  }, 1500);
}
/* Première connexion : si le compte est vide et que l'appareil a des voyages,
   on ENVOIE le local. Sinon le serveur fait foi. On n'efface jamais un
   travail existant sans qu'il ait été sauvegardé d'abord. */
async function pullSync(){
  if(!authToken()) return;
  const r = await srvFetch('/sync', { auth:true });
  if(!r.ok) return;
  const dist = r.data && r.data.payload;
  const localVide = !state.trip && !(state.destinations || []).length;
  if(!dist){
    if(!localVide) await srvFetch('/sync', { method:'POST', body:{ payload: syncPayload() }, auth:true });
    return;
  }
  if(dist.trip){
    /* on greffe le voyage distant en gardant les images déjà présentes
       sur CET appareil (cartes hors-ligne) : elles ne voyagent pas, mais
       si elles sont là, autant les conserver */
    const localMaps = state.cache?.maps;
    state = dist.trip;
    if(localMaps){ state.cache = state.cache || {}; state.cache.maps = localMaps; }
    save();
  }
  if(Array.isArray(dist.history)) lsSet(LS_HIST, JSON.stringify(dist.history));
  /* on ré-affiche ce qui vient d'arriver, comme au démarrage */
  try{
    renderGallery();
    if(state.lastProps) renderDestinations(state.lastProps);
    if(state.step > 1) gotoStep(Math.min(state.step, 3));
  }catch(e){}
}


const _e17 = $('#goLogin'); if(_e17) _e17.onclick  = () => authShow('authLogin');
const _e18 = $('#goSignup'); if(_e18) _e18.onclick = () => authShow('authSignup');
const _e19 = $('#vfBack'); if(_e19) _e19.onclick   = () => { localStorage.removeItem(LS_USER); authShow('authSignup'); };

/* garde anti double-clic : une inscription lancée deux fois enverrait
   deux codes et déclencherait l'anti-spam du serveur */
let authBusy = false;
const authWait = (btn, on) => { authBusy = on; if(btn) btn.disabled = on; };

const _e20 = $('#btnSignup'); if(_e20) _e20.onclick = async () => {
  if(authBusy) return;
  const email = $('#auEmail').value.trim().toLowerCase();
  const pseudo = $('#auPseudo').value.trim();
  const p1 = $('#auPass').value, p2 = $('#auPass2').value;
  if(!pseudo) return authErr('Choisis un pseudo.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authErr('Adresse email invalide.');
  if(p1.length < 8) return authErr('Mot de passe : 8 caractères minimum.');
  if(p1 !== p2) return authErr('Les deux mots de passe ne correspondent pas.');
  if(!$('#auPrivacy')?.checked) return authErr('Merci d’accepter la politique de confidentialité.');
  lsSet(LS_PRIVACY, PRIVACY_VERSION);           /* acceptation enregistrée */
  authErr(''); authWait(_e20, true);
  const r = await srvFetch('/auth/signup', { method:'POST', body:{ email, password:p1 } });
  authWait(_e20, false);
  if(!r.ok) return authErr(r.data.error || 'Inscription impossible.');
  /* le pseudo reste local : le serveur n'en a pas besoin */
  setUser({ email, pseudo, created: Date.now() });
  $('#vfEmail').textContent = email;
  authShow('authVerify');
  toast('📬 Code envoyé — pense à regarder tes indésirables');
};

const _e21 = $('#btnResend'); if(_e21) _e21.onclick = async () => {
  if(authBusy) return;
  const u = getUser(); if(!u) return;
  authWait(_e21, true);
  const r = await srvFetch('/auth/forgot', { method:'POST', body:{ email:u.email } });
  authWait(_e21, false);
  authErr(r.ok ? '' : (r.data.error || 'Envoi impossible.'));
  if(r.ok) toast('📬 Nouveau code envoyé');
};

const _e22 = $('#btnVerify'); if(_e22) _e22.onclick = async () => {
  if(authBusy) return;
  const u = getUser(); if(!u) return;
  const code = $('#vfCode').value.trim();
  authErr(''); authWait(_e22, true);
  const r = await srvFetch('/auth/verify', { method:'POST', body:{ email:u.email, code } });
  authWait(_e22, false);
  if(!r.ok) return authErr(r.data.error || 'Code incorrect.');
  setToken(r.data.token);
  lsSet(LS_AUTH, '1');
  await pullSync();
  enterApp();
  toast('Compte vérifié — bienvenue ! 🎉');
};

const _e23 = $('#btnLogin'); if(_e23) _e23.onclick = async () => {
  if(authBusy) return;
  const email = $('#loEmail').value.trim().toLowerCase();
  const pass = $('#loPass').value;
  authErr(''); authWait(_e23, true);
  const r = await srvFetch('/auth/login', { method:'POST', body:{ email, password:pass } });
  authWait(_e23, false);
  /* compte existant mais adresse jamais confirmée : le serveur a renvoyé
     un code, on bascule sur l'écran de vérification */
  if(!r.ok && r.data && r.data.etape === 'verification'){
    setUser({ ...(getUser() || {}), email });
    $('#vfEmail').textContent = email;
    authShow('authVerify');
    return authErr(r.data.error || '');
  }
  if(!r.ok) return authErr(r.data.error || 'Connexion impossible.');
  setToken(r.data.token);
  const prev = getUser() || {};
  setUser({ ...prev, email, pseudo: prev.email === email ? prev.pseudo : (prev.pseudo || email.split('@')[0]) });
  lsSet(LS_AUTH, '1');
  await pullSync();
  enterApp();
  toast('Re-bonjour ' + email.split('@')[0] + ' 👋');
};

function enterApp(){
  $('#authWrap').classList.add('hidden');
  /* si la politique a changé depuis la dernière acceptation, on la redemande
     avant tout le reste */
  if(!requirePrivacy()) return;
  renderProfile(); renderSettings(); renderGallery(); showOnboard(); checkNews();
}

/* ============================================================
   NOUVEAUTÉS — journal des mises à jour.
   Pour publier une màj : ajoute une entrée EN HAUT de CHANGELOG
   (date au format AAAA-MM-JJ) et incrémente CACHE dans sw.js.
============================================================ */
const CHANGELOG = [
  { v:'3.4', date:'2026-07-23', titre:'Mascotte joueuse, confidentialité et page épurée', items:[
    '🌍 Clique sur la mascotte : elle saute ! Et elle réagit toute seule de temps en temps',
    '🔒 Une politique de confidentialité claire, à accepter à la création du compte',
    '🧳 Dans « Mes voyages », un bouton déplie tous tes voyages au-delà de trois',
    '🧹 Page « Ton voyage » épurée : le trajet passe dans l’onglet Transport, le conseil dans Programme',
    '🧭 Le bandeau de trajet est plus lisible : départ, arrivée et infos en étiquettes'
  ]},
  { v:'3.3', date:'2026-07-23', titre:'Un bandeau de trajet plus clair et des événements automatiques', items:[
    '🧭 Le bandeau de ton trajet est redessiné : le départ et l’arrivée en grand, les infos en étiquettes lisibles',
    '🎉 Plus besoin de cliquer « Voir les événements » : Acolite les cherche dès qu’il organise ton voyage',
    '➕ Ils sont prêts dans l’onglet Événements, à ajouter à ton programme en un clic'
  ]},
  { v:'3.2', date:'2026-07-23', titre:'La page « Ton voyage » remise au clair', items:[
    '🧳 « Ton voyage » ne montre plus que ton trajet en un coup d’œil',
    '🎛️ Une barre juste en dessous range TOUT le reste : Programme · Logement · Transport · Événements · Budget',
    '🕘 Les boutons d’une journée sont enfin explicites : « Voir heure par heure » et « Refaire ce jour »',
    '🎫 « Réserver » se replie comme « Gérer ce voyage » — la page respire'
  ]},
  { v:'3.1', date:'2026-07-23', titre:'La synchronisation des voyages fonctionne', items:[
    '☁️ Tes voyages remontent bien sur ton compte, même les gros — seules les cartes hors-ligne restent sur chaque appareil (elles se refont toutes seules)',
    '🔔 Si la synchro échoue, tu es prévenu au lieu de le découvrir trop tard'
  ]},
  { v:'3.0', date:'2026-07-23', titre:'Ton compte te suit sur tous tes appareils', items:[
    '☁️ Tes voyages sont enregistrés sur ton compte — retrouve-les sur ton téléphone comme sur ton ordinateur',
    '🔐 Ton mot de passe n’est plus jamais stocké en clair, et ton code de vérification arrive par email',
    '🔑 Mot de passe oublié : reçois un code et choisis-en un nouveau',
    '🗑️ Supprimer ton compte efface aussi tout ce qui était enregistré côté serveur'
  ]},
  { v:'2.4', date:'2026-07-22', titre:'Des détails plus confortables', items:[
    '🚆 Le choix du transport devient un menu déroulant, comme les autres questions',
    '👍 Les boutons j’aime, j’aime pas et commentaire sont mieux espacés dans chaque journée',
    '💛 Le bloc « donne ton avis » a été redessiné'
  ]},
  { v:'2.3', date:'2026-07-22', titre:'Tu choisis comment tu voyages', items:[
    '🚆 Nouveau choix dans le questionnaire : train, voiture, avion ou peu importe — Acolite construit le trajet avec ce que tu as choisi',
    '🌍 Le logo est plus grand, la mascotte se voit enfin',
    '🧳 Quand Acolite ne propose qu’un seul voyage, il se déploie en largeur sur ordinateur',
    '🧹 La fiche pratique a été retirée'
  ]},
  { v:'2.2', date:'2026-07-22', titre:'Des logements qui existent vraiment', items:[
    '🏨 Acolite relève les hébergements réels autour de ton quartier sur OpenStreetMap, puis choisit dedans',
    '📍 Chaque proposition existe donc pour de vrai, avec sa distance au quartier conseillé',
    '🔗 Les liens Airbnb, Booking et Abritel restent pré-remplis avec tes dates pour voir les prix du jour'
  ]},
  { v:'2.1', date:'2026-07-22', titre:'Des boutons et des cartes bien alignés', items:[
    '🔘 Les 4 boutons du questionnaire font tous la même taille — plus aucun tout seul sur sa ligne',
    '🧱 « Réserver » et « À savoir avant de partir » ont désormais la même hauteur',
    '📌 Le bouton « fiche pratique » se cale en bas de sa carte, sur toute la largeur'
  ]},
  { v:'2.0', date:'2026-07-22', titre:'La mascotte prend la place du logo', items:[
    '🌍 Le globe aux grands yeux remplace le carré orange, en haut à gauche',
    '🧭 Carte · Voyage · Profil filent tout au bout de la barre',
    '🪜 Questions · Les choix · Ton voyage sont bien détachés les uns des autres',
    '✨ « Quoi de neuf » se lit comme une frise : les versions s’enchaînent, la dernière est mise en avant'
  ]},
  { v:'1.9', date:'2026-07-22', titre:'Un écran d’ordinateur mieux rempli', items:[
    '🎯 Les 3 étapes et les onglets ne s’étirent plus aux quatre coins de l’écran',
    '🔘 Les boutons se rangent en ligne au lieu d’empiler quatre barres',
    '💛 Le bloc « donne ton avis » est plus clair, et ne tombe plus juste après la suppression de compte'
  ]},
  { v:'1.8', date:'2026-07-22', titre:'Une barre en haut, et un mode sombre qui ne pique plus les yeux', items:[
    '🧭 Sur ordinateur, Carte · Voyage · Profil passent dans une barre en haut du site',
    '🌙 Mode sombre : quand tu écris dans une case, le texte reste lisible — la case ne vire plus au blanc',
    '🌙 L’étape verrouillée et les cartes survolées ne s’éclairent plus en blanc non plus',
    '📱 Sur téléphone, la barre reste en bas, à portée de pouce'
  ]},
  { v:'1.7', date:'2026-07-22', titre:'Acolite s’installe enfin sur grand écran', items:[
    '🖥️ Sur ordinateur, la barre du bas devient un petit îlot posé au centre — fini le bandeau qui traverse tout l’écran',
    '🧳 Dans « Ton voyage », « Réserver » et « À savoir avant de partir » se placent côte à côte : deux fois moins à faire défiler',
    '💶 Le budget s’affiche sur une seule ligne au lieu de deux',
    '📱 Rien ne change sur téléphone'
  ]},
  { v:'1.6', date:'2026-07-22', titre:'Une mascotte pendant les chargements', items:[
    '🌍 Le globe d’Acolite tourne les yeux partout pendant que l’IA réfléchit',
    '✨ Il remplace l’ancien rond qui tournait, sur tous les écrans de chargement',
    '♿ Animation coupée automatiquement si tu as réduit les animations sur ton appareil'
  ]},
  { v:'1.5', date:'2026-07-21', titre:'Prix réels automatiques et vue voyage épurée', items:[
    '💶 Prix réels du transport chargés tout seuls — plus aucun bouton « simuler »',
    '🏨 Vrais logements sélectionnés pour ton quartier, avec lien de réservation pré-rempli',
    '🧭 Vue « Ton voyage » repensée en onglets : Programme · Logement · Événements · Budget',
    '➕ Ajoute un événement à ton programme en un clic',
    '🐢 Mode réseau faible : chargements allégés et reprise automatique au retour du réseau',
    '📄 Carnet PDF entièrement redessiné'
  ]},
  { v:'1.4', date:'2026-07-20', titre:'Hors-ligne, multi-pays et voyage à plusieurs', items:[
    '🗺️ Cartes de chaque journée téléchargeables : consultables sans réseau',
    '📄 Carnet de voyage en PDF : plan complet + n° de réservation, à emporter',
    '🌍 Voyages multi-pays : découpage en étapes, logement et jours par ville',
    '👍 Tableau partagé : votes et commentaires sur chaque journée',
    '🧭 Vue « Ton voyage » réorganisée : le programme d’abord, le détail replié'
  ]},
  { v:'1.3', date:'2026-07-19', titre:'L’IA raisonne dans l’ordre', items:[
    '🧠 Nouveau pipeline : ville → transport (CO₂, temps, prix) → lieux → logement → jours',
    '🕘 Programme heure par heure pour chaque journée',
    '🌍 Empreinte carbone du trajet avec l’alternative plus sobre',
    '📍 Mode « Jour J » : ta journée en cours mise en avant pendant le voyage'
  ]},
  { v:'1.2', date:'2026-07-18', titre:'Souvenirs et personnalisation', items:[
    '🖼️ Carte postale : 8 modèles, 6 styles, tes photos ou celles du web',
    '🎫 Ticket d’embarquement souvenir avec code-barres',
    '🎨 Thème clair / sombre / système et valeurs par défaut du questionnaire'
  ]},
  { v:'1.1', date:'2026-07-17', titre:'Comparer et retrouver ses voyages', items:[
    '📊 Comparatif des propositions côte à côte',
    '🧳 Galerie « Mes voyages » pour rouvrir un voyage passé',
    '💾 Sauvegarde et import du voyage en fichier'
  ]}
];
const APP_VERSION = CHANGELOG[0].v;
const LS_SEEN_V = 'acolite_seen_version';
/* date longue « 20 juillet 2026 » (distincte de frDate, utilisée pour les vols) */
const newsDate = iso => { const d = new Date(iso + 'T12:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' }); };

/* Chaque nouveauté commence par un emoji. On le détache pour qu'il serve
   de puce : sinon on lit « • 🎯 Les 3 étapes… », deux puces pour une. */
/* Construite via new RegExp et non en littéral : \p{...} est de l'ES2018,
   et un littéral non supporté serait une SyntaxError qui empêcherait TOUT
   app.js de s'exécuter. Ici, au pire, on retombe sur la puce ronde. */
let NEWS_EMO = null;
try { NEWS_EMO = new RegExp('^(\\p{Extended_Pictographic}\\uFE0F?)\\s*', 'u'); } catch(e){}
function newsItemHTML(txt){
  const m = NEWS_EMO ? txt.match(NEWS_EMO) : null;
  const emo = m ? m[1] : '•';
  const rest = m ? txt.slice(m[0].length) : txt;
  return `<li><span class="ni-emo" aria-hidden="true">${esc(emo)}</span><span>${esc(rest)}</span></li>`;
}
function newsHTML(list){
  return list.map((e, i) => `<article class="news-entry${i === 0 ? ' latest' : ''}">
    <div class="news-head">
      <span class="news-v">v${esc(e.v)}</span>
      <span class="news-date">${esc(newsDate(e.date))}</span>
      ${i === 0 ? '<span class="news-new">nouveau</span>' : ''}
    </div>
    <h4>${esc(e.titre)}</h4>
    <ul class="news-items">${e.items.map(newsItemHTML).join('')}</ul>
  </article>`).join('');
}
function openNews(all){
  const seen = localStorage.getItem(LS_SEEN_V);
  /* à l'ouverture auto : seulement les versions non vues ; sinon tout l'historique */
  const list = all ? CHANGELOG : CHANGELOG.slice(0, Math.max(1, CHANGELOG.findIndex(e => e.v === seen)));
  const body = $('#newsBody');
  const intro = all
    ? `<p class="news-intro">Tout ce qui a changé depuis le début, du plus récent au plus ancien.</p>`
    : `<div class="news-hello">${mascotSVG()}<p>Acolite a été mis à jour pendant ton absence — voici ce qui change.</p></div>`;
  if(body) body.innerHTML = intro + `<div class="news-rail">${newsHTML(list)}</div>`;
  $('#ovNews')?.classList.add('show');
}
function closeNews(){
  lsSet(LS_SEEN_V, APP_VERSION);
  $('#ovNews')?.classList.remove('show');
}
/* à l'ouverture : si la version a changé depuis la dernière visite → on annonce */
function checkNews(){
  const seen = localStorage.getItem(LS_SEEN_V);
  if(seen === APP_VERSION) return;
  if(!seen){ lsSet(LS_SEEN_V, APP_VERSION); return; }   /* 1ʳᵉ visite : l'onboarding suffit */
  openNews(false);
}
{
  const ok = $('#newsOk'); if(ok) ok.onclick = closeNews;
  const pf = $('#pfNews'); if(pf) pf.onclick = () => openNews(true);
  const v = $('#pfVersion'); if(v) v.textContent = `· version ${APP_VERSION}`;
}

/* ============================================================
   POLITIQUE DE CONFIDENTIALITÉ
   Acceptée au moins une fois à l'inscription. Si le texte change, on
   incrémente PRIVACY_VERSION : tous les utilisateurs devront ré-accepter
   à leur prochaine ouverture (comparaison avec la version mémorisée).
   ⚠️ Texte fourni de bonne foi, sans valeur d'avis juridique — à faire
   relire par un professionnel avant une mise en production sérieuse.
============================================================ */
const PRIVACY_VERSION = '2026-07-23';
const LS_PRIVACY = 'acolite_privacy';
const privacyAccepted = () => { try{ return localStorage.getItem(LS_PRIVACY) === PRIVACY_VERSION; }catch(e){ return false; } };
function privacyHTML(){
  return `
  <p class="sub" style="margin:0 0 14px">En vigueur au ${esc(PRIVACY_VERSION)}. Acolite est un service <strong>gratuit</strong>, sans publicité et sans revente de données.</p>
  <div class="legal">
    <h4>1. Qui traite tes données</h4>
    <p>Acolite est une application de préparation de voyage. Elle est éditée à titre personnel et proposée en démonstration, « en l'état ».</p>
    <h4>2. Ce que nous conservons</h4>
    <p>• <strong>Ton compte</strong> : ton adresse email et un mot de passe <em>chiffré</em> (jamais lisible en clair), sur notre serveur.<br>
    • <strong>Tes voyages, notes et préférences</strong> : d'abord dans ton navigateur ; si tu as un compte, une copie est enregistrée sur le serveur pour te suivre d'un appareil à l'autre.<br>
    • Nous ne collectons ni ta localisation précise, ni tes contacts, et n'installons aucun traceur publicitaire.</p>
    <h4>3. Services tiers</h4>
    <p>Pour fonctionner, Acolite transmet le strict nécessaire à : un fournisseur d'intelligence artificielle (pour construire ton voyage), un service d'envoi d'email (pour ton code de vérification), et des sources ouvertes de données de transport, météo, cartes et taux de change. Ces prestataires ont leurs propres règles de confidentialité.</p>
    <h4>4. Durée & suppression</h4>
    <p>Tes données sont conservées tant que ton compte existe. Tu peux <strong>tout supprimer définitivement</strong> à tout moment depuis ton profil : ton compte et toutes les données associées, côté serveur comme dans ce navigateur, sont alors effacés.</p>
    <h4>5. Tes droits</h4>
    <p>Tu peux consulter, corriger ou effacer tes données directement dans l'application. Pour toute autre demande, la suppression de compte reste la voie la plus sûre.</p>
    <h4>6. Limites & responsabilité</h4>
    <p>Les itinéraires, prix, horaires et conseils sont générés automatiquement et peuvent comporter des <strong>erreurs ou des informations périmées</strong>. Ils sont donnés à titre indicatif : <strong>vérifie toujours</strong> auprès des transporteurs, hébergeurs et autorités avant de réserver ou de partir. Acolite ne saurait être tenu responsable d'un dommage, d'une perte ou d'une dépense résultant de l'usage de ces informations, ni d'une interruption du service. Tu utilises Acolite sous ta propre responsabilité.</p>
    <h4>7. Évolutions</h4>
    <p>Cette politique peut évoluer. En cas de changement important, ton acceptation te sera redemandée à l'ouverture de l'application.</p>
  </div>`;
}
let _privacyGate = false;   /* true = acceptation obligatoire (bloque la fermeture) */
function openPrivacy(gate){
  _privacyGate = !!gate;
  const b = $('#privacyBody'); if(b) b.innerHTML = privacyHTML();
  $('#privacyClose')?.classList.toggle('hidden', _privacyGate);   /* pas de croix si obligatoire */
  $('#privacyAccept')?.classList.toggle('hidden', !_privacyGate); /* bouton accepter seulement en mode obligatoire */
  $('#ovPrivacy')?.classList.add('show');
}
function acceptPrivacy(){
  lsSet(LS_PRIVACY, PRIVACY_VERSION);
  $('#ovPrivacy')?.classList.remove('show');
  const cb = $('#auPrivacy'); if(cb) cb.checked = true;
  /* si on était sur la barrière obligatoire (utilisateur déjà connecté),
     on reprend l'entrée dans l'app maintenant que c'est accepté */
  if(_privacyGate){ _privacyGate = false; enterApp(); }
}
{
  const op = $('#openPrivacy'); if(op) op.onclick = () => openPrivacy(false);
  const pa = $('#privacyAccept'); if(pa) pa.onclick = acceptPrivacy;
  const pf = $('#pfPrivacy'); if(pf) pf.onclick = () => openPrivacy(false);
}
/* Barrière : un utilisateur connecté qui n'a pas accepté la version en cours
   doit le faire avant d'utiliser l'app. Appelée à l'entrée. */
function requirePrivacy(){
  if(privacyAccepted()) return true;
  openPrivacy(true);
  return false;
}

/* --- Onboarding première visite (3 slides, mémorisé) --- */
const ONB_KEY = 'acolite_onboarded';
const ONB_STEPS = [
  { emoji:'🌍', title:'Décris tes envies', text:'Ton budget, tes dates, ton ambiance. Acolite imagine des destinations sur mesure — jamais une liste générique.' },
  { emoji:'🧭', title:'Compare & choisis', text:'Des propositions volontairement différentes, alignées point par point. Tu choisis celle qui te fait vibrer.' },
  { emoji:'🎒', title:'Ton voyage clé en main', text:'Programme jour par jour, budget, hôtels et vols réels, ticket d’embarquement… et tout reste accessible hors-ligne.' }
];
let _onbI = 0;
function renderOnboard(){
  const s = ONB_STEPS[_onbI];
  $('#onboardEmoji').textContent = s.emoji;
  $('#onboardTitle').textContent = s.title;
  $('#onboardText').textContent = s.text;
  $('#onboardDots').innerHTML = ONB_STEPS.map((_, i) => `<i class="${i === _onbI ? 'on' : ''}"></i>`).join('');
  $('#onboardNext').textContent = _onbI === ONB_STEPS.length - 1 ? "C'est parti ! 🚀" : 'Suivant →';
}
function showOnboard(){
  if(localStorage.getItem(ONB_KEY)) return;
  const ov = $('#onboard'); if(!ov) return;
  _onbI = 0; renderOnboard(); ov.hidden = false;
}
function closeOnboard(){ try{ localStorage.setItem(ONB_KEY, '1'); }catch(e){} const ov = $('#onboard'); if(ov) ov.hidden = true; }
{
  const nx = $('#onboardNext'); if(nx) nx.onclick = () => { if(_onbI < ONB_STEPS.length - 1){ _onbI++; renderOnboard(); } else closeOnboard(); };
  const sk = $('#onboardSkip'); if(sk) sk.onclick = closeOnboard;
}
function requireAuth(){
  const u = getUser();
  /* la présence d'un jeton fait foi : c'est le serveur qui tranchera à la
     première synchronisation si la session est encore valable */
  if(u && authToken() && localStorage.getItem(LS_AUTH) === '1'){
    enterApp();
    pullSync();
    return;
  }
  $('#authWrap').classList.remove('hidden');
  if(!u) authShow('authSignup');
  else if(u.email && !authToken()) authShow('authLogin');
  else authShow('authSignup');
}

/* ============================================================
   CATÉGORIES — 🗺️ Carte · 🤖 Voyage · 👤 Profil
============================================================ */
function switchCat(cat){
  $$('.catnav button').forEach(b => b.classList.toggle('on', b.dataset.cat === cat));
  $('#catTrip').classList.toggle('hidden', cat !== 'trip');
  $('#catMap').classList.toggle('hidden', cat !== 'map');
  $('#catProfile').classList.toggle('hidden', cat !== 'profile');
  window.scrollTo({top:0});
  if(cat === 'map') buildProjectMap();
  if(cat === 'profile'){ renderProfile(); renderSettings(); }
  /* états vides : pas de voyage → invitations plutôt qu'écrans vides */
  const noTrip = !state.trip;
  $('#catMap')?.classList.toggle('empty', noTrip);
  const me = $('#mapEmpty'); if(me) me.hidden = !noTrip;
  const pe = $('#profileEmpty'); if(pe) pe.hidden = !noTrip;
}
$$('.catnav button').forEach(b => b.onclick = () => switchCat(b.dataset.cat));
document.addEventListener('click', e => {
  if(e.target.id === 'mapEmptyGo' || e.target.id === 'profileEmptyGo'){ switchCat('trip'); gotoStep(1); }
});

/* ============================================================
   ACCESSIBILITÉ — puces (.chip) activables au clavier partout
============================================================ */
function a11yEnhanceChips(root){
  (root || document).querySelectorAll('.chip:not([data-a11y])').forEach(c => {
    c.setAttribute('tabindex', '0');
    c.setAttribute('role', 'button');
    c.setAttribute('data-a11y', '1');
  });
}
new MutationObserver(muts => {
  for(const m of muts) for(const n of m.addedNodes){
    if(n.nodeType !== 1) continue;
    if(n.matches?.('.chip:not([data-a11y])')){ n.setAttribute('tabindex','0'); n.setAttribute('role','button'); n.setAttribute('data-a11y','1'); }
    if(n.querySelector?.('.chip:not([data-a11y])')) a11yEnhanceChips(n);
  }
}).observe(document.body, { childList:true, subtree:true });
document.addEventListener('keydown', e => {
  const c = e.target.closest?.('.chip[role="button"]');
  if(c && (e.key === 'Enter' || e.key === ' ')){ e.preventDefault(); c.click(); }
});
a11yEnhanceChips(document);

/* ============================================================
   PRÉFÉRENCES — pilotent l'IA ET l'interface
============================================================ */
const LS_SET = 'acolite_settings';
const SET_DEF = {
  style: [],            /* détente, culture, aventure… (multi) */
  rythme: 'equilibre',
  food: 'aucun',
  acces: 'non',
  eviter: [],           /* modes de transport à éviter */
  model: 'auto',
  detail: 'normal',
  verif: true,          /* relecture croisée par une 2e IA */
  reels: true,          /* données réelles (météo, trains, fériés…) */
  font: 100,
  motion: true,         /* animations */
  theme: 'auto',        /* auto (système) | light | dark */
  homeCity: '',         /* ville de départ pré-remplie à chaque nouveau voyage */
  defAdults: 2,         /* voyageurs par défaut */
  defKids: 0
};
let SET = { ...SET_DEF };
function loadSettings(){
  try{ SET = { ...SET_DEF, ...(JSON.parse(localStorage.getItem(LS_SET)) || {}) }; }catch(e){ SET = { ...SET_DEF }; }
  applySettings();
}
function saveSettings(){
  try{ localStorage.setItem(LS_SET, JSON.stringify(SET)); }catch(e){}
  applySettings();
}
function applySettings(){
  document.documentElement.style.fontSize = (SET.font || 100) + '%';
  document.documentElement.classList.toggle('no-motion', !SET.motion);
  applyTheme();
}

/* Ce bloc part dans TOUS les prompts : l'IA connaît enfin tes goûts */
function prefsBlock(){
  const L = [];
  if(SET.style?.length) L.push(`Style de voyage recherché : ${SET.style.join(', ')}`);
  const R = { doux:'rythme DOUX : peu d\'activités par jour, du temps libre, pas de course',
              equilibre:'rythme ÉQUILIBRÉ : 2-3 activités par jour',
              intense:'rythme INTENSE : programme dense, on optimise chaque heure' };
  L.push(R[SET.rythme] || R.equilibre);
  const F = { vege:'végétarien', vegan:'végan', halal:'halal', casher:'casher', sansgluten:'sans gluten' };
  if(F[SET.food]) L.push(`Alimentation ${F[SET.food]} : les restaurants et adresses proposés DOIVENT proposer cette option`);
  if(SET.acces === 'oui') L.push("ACCESSIBILITÉ : le voyageur est à mobilité réduite — privilégie les lieux accessibles, évite les escaliers, sentiers escarpés et longues marches, et signale-le");
  if(SET.eviter?.length){
    const M = { avion:"l'AVION", train:'le TRAIN', voiture:'la VOITURE' };
    const noms = SET.eviter.map(x => M[x]).filter(Boolean);
    L.push(`TRANSPORTS À ÉVITER : le voyageur ne veut PAS prendre ${noms.join(' ni ')}. Propose autre chose (${['avion','train','voiture','bus','ferry'].filter(x => !SET.eviter.includes(x)).join(', ')}). Si vraiment aucune alternative n'existe, dis-le clairement et explique pourquoi.`);
  }
  const D = { court:'Sois CONCIS : phrases courtes, va à l\'essentiel.',
              normal:'', long:'Sois DÉTAILLÉ : explique tes choix, donne des astuces concrètes et des alternatives.' };
  if(D[SET.detail]) L.push(D[SET.detail]);
  return L.length ? `\nPRÉFÉRENCES PERMANENTES DU VOYAGEUR (à respecter dans TOUTES tes réponses) :\n- ${L.join('\n- ')}\n` : '';
}

/* --- Rendu du panneau Préférences --- */
const OPT = {
  stStyle:  { key:'style',  multi:true,  items:[['detente','🏖️ Détente'],['culture','🏛️ Culture'],['aventure','🥾 Aventure'],['fete','🎉 Fête'],['nature','🌿 Nature'],['gastro','🍽️ Gastronomie'],['famille','👨‍👩‍👧 Famille'],['romantique','💘 Romantique']] },
  stRythme: { key:'rythme', items:[['doux','🐢 Doux'],['equilibre','⚖️ Équilibré'],['intense','⚡ Intense']] },
  stFood:   { key:'food',   items:[['aucun','🍽️ Aucune contrainte'],['vege','🥗 Végétarien'],['vegan','🌱 Végan'],['halal','☪️ Halal'],['casher','✡️ Casher'],['sansgluten','🌾 Sans gluten']] },
  stAcces:  { key:'acces',  items:[['non','✅ Aucun besoin'],['oui','♿ Mobilité réduite']] },
  stEco:    { key:'eviter', multi:true, items:[['avion','✈️ Éviter l\'avion'],['train','🚆 Éviter le train'],['voiture','🚗 Éviter la voiture']] },
  stTheme:  { key:'theme',  items:[['auto','🖥️ Système'],['light','☀️ Clair'],['dark','🌙 Sombre']] },
  stIA:     { key:null,     toggles:[['verif','🔍 Relecture par une 2e IA'],['reels','📡 Données réelles (météo, trains, fériés)']] },
  stUI:     { key:null,     toggles:[['motion','✨ Animations']] }
};
function renderSettings(){
  Object.entries(OPT).forEach(([id, cfg]) => {
    const box = $('#' + id);
    if(!box) return;
    if(cfg.toggles){
      box.innerHTML = cfg.toggles.map(([k, lbl]) =>
        `<div class="chip ${SET[k] ? 'on' : ''}" data-tog="${k}">${lbl} ${SET[k] ? '✔' : ''}</div>`).join('');
      return;
    }
    box.innerHTML = cfg.items.map(([v, lbl]) => {
      const on = cfg.multi ? (SET[cfg.key] || []).includes(v) : SET[cfg.key] === v;
      return `<div class="chip ${on ? 'on' : ''}" data-set="${cfg.key}" data-val="${v}" data-multi="${cfg.multi ? 1 : 0}">${lbl}</div>`;
    }).join('');
  });
  const m = $('#stModel'); if(m) m.value = SET.model;
  const dt = $('#stDetail'); if(dt) dt.value = SET.detail;
  const f = $('#stFont'); if(f) f.value = SET.font;
  const fv = $('#stFsVal'); if(fv) fv.textContent = SET.font + ' %';
  const hc = $('#stHome'); if(hc) hc.value = SET.homeCity || '';
  const sa = $('#stAdults'); if(sa) sa.value = String(SET.defAdults ?? 2);
  const sk = $('#stKids'); if(sk) sk.value = String(SET.defKids ?? 0);
}
/* Valeurs par défaut → pré-remplissage du questionnaire (uniquement si vide) */
function applyTripDefaults(){
  const from = $('#fFrom'); if(from && !from.value.trim() && SET.homeCity) from.value = SET.homeCity;
  const ad = $('#fAdults'); if(ad && SET.defAdults) ad.value = String(SET.defAdults);
  const ki = $('#fKids'); if(ki && SET.defKids !== undefined) ki.value = String(SET.defKids);
}
{
  const hc = $('#stHome'); if(hc) hc.onchange = () => { SET.homeCity = hc.value.trim().slice(0, 60); saveSettings(); applyTripDefaults(); toast('🏠 Ville de départ par défaut enregistrée'); };
  const sa = $('#stAdults'); if(sa) sa.onchange = () => { SET.defAdults = +sa.value || 2; saveSettings(); applyTripDefaults(); };
  const sk = $('#stKids'); if(sk) sk.onchange = () => { SET.defKids = +sk.value || 0; saveSettings(); applyTripDefaults(); };
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-set]');
  if(c){
    const k = c.dataset.set, v = c.dataset.val;
    if(c.dataset.multi === '1'){
      const arr = SET[k] || [];
      SET[k] = arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v];
    } else SET[k] = v;
    saveSettings(); renderSettings();
    toast('✔ Préférence enregistrée — l\'IA en tiendra compte');
    return;
  }
  const tg = e.target.closest('[data-tog]');
  if(tg){
    SET[tg.dataset.tog] = !SET[tg.dataset.tog];
    saveSettings(); renderSettings();
    return;
  }
  if(e.target.id === 'stReset'){
    if(!confirm('Réinitialiser toutes tes préférences ?')) return;
    SET = { ...SET_DEF };
    saveSettings(); renderSettings();
    toast('↺ Préférences réinitialisées');
  }
});
document.addEventListener('change', e => {
  if(e.target.id === 'stModel'){ SET.model = e.target.value; localStorage.removeItem(LS_GEMM); saveSettings(); toast('🤖 Modèle : ' + e.target.selectedOptions[0].text); }
  if(e.target.id === 'stDetail'){ SET.detail = e.target.value; saveSettings(); }
});
document.addEventListener('input', e => {
  if(e.target.id !== 'stFont') return;
  SET.font = +e.target.value;
  $('#stFsVal').textContent = SET.font + ' %';
  saveSettings();
});

/* --- Barre "l'IA cherche" : remplace la nav du bas pendant la réflexion --- */
const SB_MSG = [
  'Acolite explore le monde…',
  'Il compare les destinations…',
  'Il vérifie les vols et les prix…',
  'Il repère les bons quartiers…',
  'Il finalise tes propositions…'
];
let _sbTimer = null;
function searchBar(on, first){
  const bar = $('#searchBar'), nav = $('.catnav');
  if(!bar || !nav) return;
  clearInterval(_sbTimer);
  if(on){
    let i = 0;
    const mk = $('#sbMascot');
    if(mk && !mk.querySelector('.mascot')) mk.innerHTML = mascotSVG();   /* la mascotte veille pendant la recherche */
    $('#sbText').textContent = first || SB_MSG[0];
    bar.hidden = false;
    nav.style.display = 'none';          /* les 3 boutons laissent la place à la barre */
    _sbTimer = setInterval(() => {
      i = (i + 1) % SB_MSG.length;
      $('#sbText').textContent = SB_MSG[i];
    }, 2200);
  } else {
    bar.hidden = true;
    nav.style.display = '';
  }
}

/* --- Carte du projet : sélecteur de trajet + carte plein cadre --- */
async function projRoute(route){
  const frame = $('#projMap');
  if(!frame) return;
  const t = state.trip || {};
  const q = state.cache.plan?.logement?.quartier;

  /* On tente, dans l'ordre : la ville-étape du jour (multi-bases) → le quartier →
     la ville de l'aéroport → la ville → le pays. Le géocodeur connaît mal les monuments. */
  const raw = route.walk
    ? [route.ville, q, t.ville_aeroport, t.nom, t.pays]
    : [t.ville_aeroport, t.nom, t.pays];
  const essais = [...new Set(raw.map(cleanPlace).filter(Boolean))];
  const cc = ccFor(t.pays);
  let g = null;
  for(const nom of essais.filter(Boolean)){
    const ck = 'geo_' + cc + '_' + nom;
    if(state.cache[ck]){ g = state.cache[ck]; break; }
    const r = await geoPlace(nom, cc);
    if(r){
      g = { lat:+r.latitude, lon:+r.longitude };
      state.cache[ck] = g; save();
      break;
    }
  }
  if(!g){
    frame.src = 'https://www.openstreetmap.org/export/embed.html?bbox=-10,35,30,60&layer=mapnik';
    $('#zoneStops').innerHTML = '';
    return;
  }
  const d = route.walk ? 0.014 : 0.06;
  frame.src = `https://www.openstreetmap.org/export/embed.html`
    + `?bbox=${g.lon - d * 1.6},${g.lat - d},${g.lon + d * 1.6},${g.lat + d}`
    + `&layer=mapnik&marker=${g.lat},${g.lon}`;

  /* Les étapes du jour, cliquables : chacune ouvre le lieu dans Maps */
  const stops = $('#zoneStops');
  if(!stops) return;
  if(!route.walk || !route.stops.length){
    stops.innerHTML = '';
    return;
  }
  stops.innerHTML = route.stops.map((s, i) => {
    const nom = s.split(',')[0];
    const url = `https://www.google.com/maps/search/${encodeURIComponent(s)}`;
    return `<a class="stop" href="${esc(url)}" target="_blank" rel="noopener"><b>${i + 1}</b> ${esc(nom)}</a>`;
  }).join('');
}

function buildProjectMap(){
  const t = state.trip, p = state.prefs || {}, c = state.cache;
  const sel = $('#mapDay');
  if(!sel) return;
  if(!t){
    sel.innerHTML = '<option>Aucun voyage en cours</option>';
    sel.disabled = true;
    $('#projMap').src = 'https://www.openstreetmap.org/export/embed.html?bbox=-10,35,30,60&layer=mapnik';
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(
        pos => {
          const la = pos.coords.latitude, lo = pos.coords.longitude;
          $('#projMap').src = `https://www.openstreetmap.org/export/embed.html?bbox=${lo-0.05},${la-0.03},${lo+0.05},${la+0.03}&layer=mapnik&marker=${la},${lo}`;
        },
        () => {}, { timeout: 6000 }
      );
    }
    return;
  }
  sel.disabled = false;
  const routes = [];
  routes.push({ label:`${({plane:'✈️',train:'🚆',car:'🚗'})[state.mode]||'✈️'} Aller — ${p.from || 'départ'} → ${t.nom}`,
                saddr: p.from || 'Paris', stops:[`${t.nom}, ${t.pays}`], walk:false });
  const base = c.plan?.logement?.quartier ? `${c.plan.logement.quartier}, ${t.nom}` : `${t.nom}, ${t.pays}`;
  const days = (c.plan?.programme || []).map(x => ({ jour:x.jour, resume:x.resume, lieux:x.lieux || [], base:x.base }));
  days.forEach(x => {
    /* multi-bases : les lieux du jour se rattachent à SA ville-étape, pas au nom de l'itinéraire */
    const ville = x.base || t.nom;
    const lieux = (x.lieux || []).filter(Boolean).map(l => `${l}, ${ville}`).slice(0, 8);
    if(lieux.length){
      routes.push({
        label: `🗓️ Jour ${x.jour} — ${x.base ? x.base + ' · ' : ''}${String(x.resume || '').slice(0, 26)}`,
        saddr: x.base ? `${x.base}` : base, stops: lieux, walk: true, ville: x.base || ''
      });
    }
  });
  window._projRoutes = routes;
  sel.innerHTML = routes.map((r, i) => `<option value="${i}">${esc(r.label)}</option>`).join('');
  sel.value = '0';
  const r0 = routes[0];
  projRoute(r0);
  updateProjOpen(r0);
}
function updateProjOpen(r){
  const a = $('#projOpen');
  if(a) a.href = 'https://www.google.com/maps/dir/' + [r.saddr, ...r.stops].map(encodeURIComponent).join('/');
}
document.addEventListener('change', e => {
  if(e.target.id !== 'mapDay') return;
  const r = (window._projRoutes || [])[+e.target.value];
  if(!r) return;
  projRoute(r);
  updateProjOpen(r);
});
/* ‹ › : passer au trajet précédent/suivant sans ouvrir la liste */
function mapStep(dir){
  const sel = $('#mapDay'), routes = window._projRoutes || [];
  if(!sel || sel.disabled || routes.length < 2) return;
  const i = (+sel.value + dir + routes.length) % routes.length;
  sel.value = String(i);
  projRoute(routes[i]);
  updateProjOpen(routes[i]);
}
/* 🧭 : centre la carte sur la position réelle du voyageur (pratique sur place) */
function mapLocate(){
  if(!navigator.geolocation){ toast('Géolocalisation indisponible sur cet appareil'); return; }
  toast('🧭 Recherche de ta position…');
  navigator.geolocation.getCurrentPosition(
    pos => {
      const la = pos.coords.latitude, lo = pos.coords.longitude, d = 0.008;
      $('#projMap').src = `https://www.openstreetmap.org/export/embed.html?bbox=${lo-d*1.6},${la-d},${lo+d*1.6},${la+d}&layer=mapnik&marker=${la},${lo}`;
      toast('📍 Te voilà !');
    },
    () => toast('Position refusée ou introuvable'),
    { timeout: 8000 }
  );
}
document.addEventListener('click', e => {
  if(e.target.id === 'mapPrev') mapStep(-1);
  if(e.target.id === 'mapNext') mapStep(1);
  if(e.target.id === 'mapLocate') mapLocate();
});

/* --- Profil : infos + stats + paramètres --- */
function renderProfile(){
  const u = getUser(); if(!u) return;
  const pseudo = u.pseudo || u.email.split('@')[0];
  $('#pfAvatar').textContent = pseudo;
  $('#pfEmail').innerHTML = `${esc(pseudo)} <span style="cursor:pointer;font-size:.9rem" id="pfEditPseudo" title="Changer de pseudo">✏️</span>`;
  /* connecté = vérifié : le serveur refuse la connexion tant que l'adresse
     n'est pas confirmée, il n'y a donc plus d'état intermédiaire à afficher */
  $('#pfMeta').innerHTML = `${esc(u.email)} · ${authToken() ? '☁️ synchronisé' : '📴 hors ligne'}`
    + (u.created ? ` · membre depuis le ${new Date(u.created).toLocaleDateString('fr-FR')}` : '');
  const _e24 = $('#pfEditPseudo'); if(_e24) _e24.onclick = () => {
    const np = prompt('Ton nouveau pseudo :', pseudo);
    if(np && np.trim()){ u.pseudo = np.trim().slice(0,20); setUser(u); renderProfile(); toast('Pseudo mis à jour ✔'); }
  };
}
const _e25 = $('#pfExport'); if(_e25) _e25.onclick = () => $('#btnExport').click();
const _e26 = $('#pfNewTrip'); if(_e26) _e26.onclick = () => $('#btnReset').click();
const _e27 = $('#pfLogout'); if(_e27) _e27.onclick = async () => {
  /* on ferme la session côté serveur AVANT d'oublier le jeton, sinon elle
     resterait ouverte jusqu'à son expiration */
  await srvFetch('/auth/logout', { method:'POST', auth:true });
  clearToken();
  localStorage.removeItem(LS_AUTH);
  toast('À bientôt 👋');
  requireAuth();
};
const LS_THEME = 'acolite_theme';
const _sysDark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
/* 3 modes : auto (suit le système) · light · dark.
   On reste compatible avec l'ancien réglage stocké dans LS_THEME. */
function themeMode(){
  if(SET?.theme) return SET.theme;
  return localStorage.getItem(LS_THEME) === 'dark' ? 'dark' : 'auto';
}
function applyTheme(){
  const mode = themeMode();
  const dark = mode === 'dark' || (mode === 'auto' && _sysDark());
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const m = document.createElement('meta');
  m.name = 'theme-color';
  m.content = dark ? '#0B0B10' : '#FFE600';
  document.head.appendChild(m);
}
/* le mode « Système » réagit en direct au changement de thème de l'appareil */
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if(themeMode() === 'auto') applyTheme(); });
const _e28 = $('#pfTheme'); if(_e28) _e28.onclick = () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  SET.theme = dark ? 'light' : 'dark';
  saveSettings(); renderSettings();
  toast(SET.theme === 'dark' ? '🌙 Vol de nuit activé' : '☀️ Retour au jour');
};
applyTheme();

/* Changement de mot de passe : on passe par un code envoyé à l'adresse.
   Plus sûr que l'ancien mot de passe seul — si quelqu'un s'installe sur une
   session ouverte, il ne peut pas verrouiller le compte sans accès à l'email.
   Le serveur ferme d'ailleurs toutes les autres sessions au passage. */
const _e29 = $('#pfChangePass'); if(_e29) _e29.onclick = async () => {
  const u = getUser(); if(!u) return;
  if(!confirm(`Un code va être envoyé à ${u.email} pour confirmer le changement. Continuer ?`)) return;
  const r0 = await srvFetch('/auth/forgot', { method:'POST', body:{ email:u.email } });
  if(!r0.ok) return toast('❌ ' + (r0.data.error || 'Envoi impossible'));
  toast('📬 Code envoyé — regarde tes indésirables');
  const code = (prompt('Code reçu par email (6 chiffres) :') || '').trim();
  if(!code) return;
  const np = prompt('Nouveau mot de passe (8 caractères minimum) :'); if(np === null) return;
  if(np.length < 8){ toast('❌ 8 caractères minimum'); return; }
  const r = await srvFetch('/auth/reset', { method:'POST', body:{ email:u.email, code, password:np } });
  if(!r.ok) return toast('❌ ' + (r.data.error || 'Changement impossible'));
  setToken(r.data.token);          /* l'ancienne session vient d'être fermée */
  toast('🔑 Mot de passe changé ✔');
};

/* Le changement d'adresse reposait sur le mot de passe stocké dans le
   navigateur. Les comptes vivant désormais sur le serveur, il faudra une
   route dédiée (vérifier l'ancienne adresse, puis la nouvelle). En
   attendant on le dit franchement plutôt que de laisser un bouton mort. */
const _e30 = $('#pfChangeEmail'); if(_e30) _e30.onclick = () => {
  toast('✉️ Changement d’adresse bientôt disponible');
};

const _e31 = $('#pfClearCache'); if(_e31) _e31.onclick = () => {
  if(!confirm('Vider le cache IA ? Le voyage, tes notes et tes dépenses sont conservés — seuls les contenus générés par l\'IA (plan, itinéraire, restos…) seront recalculés.')) return;
  state.cache = {}; save();
  toast('🧹 Cache IA vidé — contenus régénérés à la prochaine visite');
};

const _e32 = $('#pfMyData'); if(_e32) _e32.onclick = () => {
  const data = { compte: getUser(), voyage: state, exporte_le: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'acolite-mes-donnees.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('📄 Données téléchargées');
};

/* Suppression de compte : confirmation DANS l'app.
   (confirm()/prompt() sont bloqués dans les PWA installées : le bouton
   semblait ne rien faire — c'était ça, le bug.) */
const _e33 = $('#pfDelete'); if(_e33) _e33.onclick = () => {
  const u = getUser();
  $('#delPseudo').textContent = u?.pseudo || 'SUPPRIMER';
  $('#delConfirm').value = '';
  $('#delGo').disabled = true;
  $('#ovDel').classList.add('show');
};
document.addEventListener('input', e => {
  if(e.target.id !== 'delConfirm') return;
  const attendu = ($('#delPseudo').textContent || '').trim();
  $('#delGo').disabled = e.target.value.trim() !== attendu;
});
document.addEventListener('click', async e => {
  if(e.target.id !== 'delGo') return;
  const attendu = ($('#delPseudo').textContent || '').trim();
  if(($('#delConfirm').value || '').trim() !== attendu){ toast('❌ Pseudo incorrect'); return; }
  /* on efface d'abord le compte SUR LE SERVEUR : effacer le navigateur en
     premier ferait perdre le jeton, et les données resteraient en base */
  if(authToken()){
    const r = await srvFetch('/account', { method:'DELETE', auth:true });
    if(!r.ok){ toast('❌ ' + (r.data.error || 'Suppression impossible — réessaie')); return; }
  }
  Object.keys(localStorage)
    .filter(k => k.startsWith('acolite_'))
    .forEach(k => localStorage.removeItem(k));
  location.reload();
});

/* --- Filet de sécurité global : une erreur JS ne meurt plus en silence --- */
let _lastErrToast = 0;
window.addEventListener('error', () => {
  const now = Date.now();
  if(now - _lastErrToast > 8000){ _lastErrToast = now; try{ toast("⚠️ Oups, un pépin technique — recharge la page si ça persiste"); }catch(e){} }
});
window.addEventListener('unhandledrejection', e => {
  const m = String(e.reason?.message||'');
  if(['NO_KEY','BAD_KEY','RATE','EMPTY','BAD_JSON','GROQ_RATE'].some(x=>m.includes(x))) return; /* déjà gérés par toast dédié */
  const now = Date.now();
  if(now - _lastErrToast > 8000){ _lastErrToast = now; try{ toast("⚠️ Une action a échoué — réessaie"); }catch(err){} }
});

/* --- Voyage <-> QR : encodage compact + import --- */
function tripPayload(){
  const t = state.trip, p = state.prefs || {};
  if(!t) return null;
  const o = { v:1,
    trip: { nom:t.nom, pays:t.pays, drapeau:t.drapeau, iata:t.iata, budget_estime:t.budget_estime, langue:t.langue, monnaie:t.monnaie, transport_conseille:t.transport_conseille },
    prefs: { from:p.from, days:p.days, when:p.when, depart:p.depart, adults:p.adults, kids:p.kids, budget:p.budget, free:(String(p.free||'').split(' | Affinage')[0]).slice(0,120) }
  };
  return 'ACOLITE1:' + btoa(unescape(encodeURIComponent(JSON.stringify(o))));
}
function importPayload(str){
  if(!String(str).startsWith('ACOLITE1:')) throw new Error('format');
  const o = JSON.parse(decodeURIComponent(escape(atob(str.slice(9)))));
  if(!o.trip?.nom) throw new Error('vide');
  if(!confirm(`Importer le voyage "${o.trip.nom}, ${o.trip.pays}" ?\nTon voyage en cours sera remplacé (ton compte est conservé).`)) return false;
  state.trip = o.trip;
  state.prefs = { ...(state.prefs||{}), ...(o.prefs||{}) };
  state.destinations = [o.trip];
  state.cache = {}; state.checklist = {}; state.spends = []; state.notes = ''; state.resas = [];
  state.planAnswers = []; state._qsDone = false; state.modeManual = false;
  _pcPhotos = null;   /* photos de carte postale liées au voyage précédent */
  state.board = { votes:{}, comments:{} };   /* votes/commentaires liés à l'ancien voyage */
  save(); unlockSteps();
  switchCat('trip');
  gotoStep(3);
  toast(`🎫 Voyage importé : cap sur ${o.trip.nom} !`);
  return true;
}

/* --- Chargeurs de libs QR (cdnjs, à la demande, jamais bloquant) --- */
const _lib = {};
function loadLib(name, src, test){
  if(_lib[name]) return _lib[name];
  _lib[name] = new Promise((res, rej) => {
    if(test()) return res();
    const sc = document.createElement('script');
    const to = setTimeout(() => { _lib[name] = null; rej(new Error(name)); }, 8000);
    sc.src = src;
    sc.onload = () => { clearTimeout(to); test() ? res() : rej(new Error(name)); };
    sc.onerror = () => { clearTimeout(to); _lib[name] = null; rej(new Error(name)); };
    document.head.appendChild(sc);
  });
  return _lib[name];
}
const loadQRGen  = () => loadLib('qrgen', 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js', () => !!window.QRCode);
const loadQRRead = () => loadLib('qrread', 'https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js', () => !!window.jsQR);

/* --- Scanner : caméra ou photo -> import du voyage --- */
let _scanStream = null, _scanRun = false;
async function openScan(){
  $('#ovScan').classList.add('show');
  $('#scanMsg').textContent = '';
  try{ await loadQRRead(); }catch(e){ $('#scanMsg').textContent = '⚠️ Lecteur QR indisponible hors-ligne — réessaie connecté.'; return; }
  try{
    _scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode:'environment' } });
    const v = $('#scanVideo');
    v.srcObject = _scanStream; await v.play();
    _scanRun = true;
    const cv = document.createElement('canvas'), g = cv.getContext('2d');
    (function tick(){
      if(!_scanRun) return;
      if(v.videoWidth && g){
        cv.width = v.videoWidth; cv.height = v.videoHeight;
        g.drawImage(v, 0, 0);
        const img = g.getImageData(0, 0, cv.width, cv.height);
        const q = window.jsQR(img.data, img.width, img.height);
        if(q && q.data.startsWith('ACOLITE1:')){
          closeScan();
          try{ importPayload(q.data); }catch(e){ toast('❌ QR illisible'); }
          return;
        }
      }
      requestAnimationFrame(tick);
    })();
  }catch(e){
    $('#scanMsg').textContent = '📷 Caméra indisponible ou refusée — choisis plutôt une photo du ticket ci-dessous.';
  }
}
function closeScan(){
  _scanRun = false;
  if(_scanStream){ _scanStream.getTracks().forEach(t => t.stop()); _scanStream = null; }
  $('#ovScan').classList.remove('show');
}
const _cscanFile = $('#scanFile'); if(_cscanFile) _cscanFile.onchange = async e => {
  const f = e.target.files[0]; if(!f) return;
  try{ await loadQRRead(); }catch(err){ $('#scanMsg').textContent = '⚠️ Lecteur QR indisponible hors-ligne.'; return; }
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext('2d');
    if(!g){ $('#scanMsg').textContent = '❌ Lecture impossible.'; return; }
    g.drawImage(img, 0, 0);
    const q = window.jsQR(g.getImageData(0,0,cv.width,cv.height).data, cv.width, cv.height);
    if(q && q.data.startsWith('ACOLITE1:')){ closeScan(); try{ importPayload(q.data); }catch(er){ toast('❌ QR illisible'); } }
    else $('#scanMsg').textContent = '❌ Aucun QR Acolite détecté sur cette photo.';
  };
  img.src = URL.createObjectURL(f);
};
document.addEventListener('click', e => {
  if(e.target.id === 'btnScanTicket' || e.target.id === 'pfScan'){ openScan(); return; }
  if(e.target.closest('[data-closescan]')) closeScan();
});

/* --- Partage par lien : #v=payload → import direct à l'ouverture --- */
async function shareLink(){
  const pl = tripPayload();
  if(!pl){ toast('Choisis d’abord un voyage'); return; }
  const url = location.origin + location.pathname + '#v=' + encodeURIComponent(pl);
  const txt = `Mon voyage à ${state.trip.nom} sur Acolite ✈️`;
  try{
    if(navigator.share){ await navigator.share({ title:'Acolite', text:txt, url }); return; }
    await navigator.clipboard.writeText(url);
    toast('🔗 Lien copié — envoie-le à tes amis');
  }catch(e){
    if(e.name !== 'AbortError') prompt('Copie ce lien :', url);
  }
}
document.addEventListener('click', e => { if(e.target.closest('[data-sharelink]')) shareLink(); });

/* import automatique si l'app est ouverte avec #v=… */
function checkImportHash(){
  const m = location.hash.match(/[#&]v=([^&]+)/);
  if(!m) return;
  history.replaceState(null, '', location.pathname);
  try{ importPayload(decodeURIComponent(m[1])); }
  catch(e){ toast('❌ Lien de voyage invalide'); }
}

/* --- Export .ics : le programme dans ton agenda (Google/Apple/Outlook) --- */
function exportICS(){
  const t = state.trip, plan = state.cache.plan, d = stayDates();
  if(!t || !plan?.programme?.length || !d){ toast('Il faut un voyage avec une date de départ'); return; }
  const pad = n => String(n).padStart(2, '0');
  const fmt = dt => `${dt.getUTCFullYear()}${pad(dt.getUTCMonth()+1)}${pad(dt.getUTCDate())}`;
  const start = new Date(d.in + 'T00:00:00Z');
  const ev = (i, j) => {
    const day = new Date(start.getTime() + i * 86400000);
    const end = new Date(day.getTime() + 86400000);
    const lieux = (j.lieux||[]).join(', ');
    return ['BEGIN:VEVENT',
      `UID:acolite-${Date.now()}-${i}@acolite`,
      `DTSTAMP:${fmt(new Date())}T000000Z`,
      `DTSTART;VALUE=DATE:${fmt(day)}`,
      `DTEND;VALUE=DATE:${fmt(end)}`,
      `SUMMARY:J${j.jour} ${t.drapeau||''} ${String(j.resume||'').replace(/[,;\\]/g, ' ').slice(0,70)}`,
      lieux ? `DESCRIPTION:${lieux.replace(/[,;\\]/g, ' ').slice(0,180)}` : '',
      `LOCATION:${String(t.nom).replace(/[,;\\]/g,' ')}`,
      'END:VEVENT'].filter(Boolean).join('\r\n');
  };
  const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Acolite//FR','CALSCALE:GREGORIAN',
    ...plan.programme.map((j, i) => ev(i, j)), 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type:'text/calendar' }));
  a.download = `acolite-${String(t.nom).toLowerCase().replace(/[^a-z0-9]+/g,'-')}.ics`;
  a.click(); URL.revokeObjectURL(a.href);
  toast('📅 Programme exporté — ouvre-le pour l’ajouter à ton agenda');
}
document.addEventListener('click', e => { if(e.target.closest('[data-ics]')) exportICS(); });

/* --- Boarding pass → image PNG partageable (canvas maison) --- */
async function passPNG(){
  const t = state.trip, p = state.prefs || {};
  if(!t){ toast('Choisis d’abord un voyage'); return; }
  const W = 1200, H = 560, M = 30;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  if(!g){ toast('Canvas indisponible'); return; }
  const K = '#101010', Y = '#FFE600', WH = '#FFFFFF', P = '#F4F3EF';
  const plan = state.cache.plan || {}, d = stayDates(), u = getUser();
  const CW = W - M * 2, CH = H - M * 2 - 12;        /* carte */
  const STUB = 300;                                  /* largeur du talon */
  /* la police du site, si elle est déjà chargée sur la page */
  try{ await document.fonts.load('900 76px Sora'); await document.fonts.load('800 15px Sora'); }catch(e){}
  const fit = (txt, size, max, weight = '700', fam = 'Inter, Arial') => {
    let px = size;
    do { g.font = `${weight} ${px}px ${fam}`; px -= 1; } while(g.measureText(txt).width > max && px > 9);
    return g.font;
  };
  /* fond papier + trame de points (comme le site) */
  g.fillStyle = P; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.10)';
  for(let dy = 8; dy < H; dy += 22) for(let dx = 8; dx < W; dx += 22){ g.beginPath(); g.arc(dx, dy, 1.6, 0, 7); g.fill(); }
  /* ombre dure sur le bas et la droite — SANS trou dans les coins (bas-gauche / haut-droit) */
  const SH = 12, ov = 4;                     /* ov : couvre le débord du trait de bord (7px) */
  g.fillStyle = K;
  g.fillRect(M - ov, M + CH, CW + SH + ov, SH);   /* bande basse : part du coin bas-gauche */
  g.fillRect(M + CW, M - ov, SH, CH + SH + ov);   /* bande droite : part du coin haut-droit */
  g.fillStyle = Y; g.fillRect(M, M, CW - STUB, CH);
  g.fillStyle = WH; g.fillRect(M + CW - STUB, M, STUB, CH);

  /* ---- CORPS ---- */
  /* logo : carré noir + A jaune, comme l'écran de démarrage */
  g.fillStyle = K; g.fillRect(M + 34, M + 26, 46, 46);
  g.fillStyle = Y; g.textAlign = 'center';
  g.font = '900 30px Sora, Arial';
  g.fillText('A', M + 57, M + 60);
  g.textAlign = 'left';
  g.fillStyle = K;
  g.font = '900 26px Sora, Arial';
  g.fillText('ACOLITE · BOARDING PASS', M + 96, M + 58);
  g.fillRect(M + 96, M + 68, 372, 5);
  /* route : départ à gauche, arrivée alignée à droite, avion au centre */
  const from = (p.from || 'PAR').slice(0, 3).toUpperCase();
  const to = (t.iata || t.nom.slice(0, 3)).toUpperCase();
  const bodyR = M + CW - STUB - 34;                  /* bord droit interne du corps */
  g.font = '900 76px Sora, Arial';
  /* espacement entre lettres : sinon le Y colle au O et le code devient illisible */
  const LS = 9;
  const spacedW = s => { let w = 0; for(const ch of s) w += g.measureText(ch).width + LS; return Math.max(0, w - LS); };
  const drawSpaced = (s, x, y) => { let cx = x; for(const ch of s){ g.fillText(ch, cx, y); cx += g.measureText(ch).width + LS; } };
  const wFrom = spacedW(from);
  const wTo = spacedW(to);
  drawSpaced(from, M + 34, M + 168);
  drawSpaced(to, bodyR - wTo, M + 168);
  g.setLineDash([13, 9]); g.lineWidth = 5;
  g.beginPath(); g.moveTo(M + 52 + wFrom, M + 142); g.lineTo(bodyR - wTo - 18, M + 142); g.stroke();
  g.setLineDash([]);
  const midX = (M + 52 + wFrom + bodyR - wTo - 18) / 2;
  g.fillStyle = Y; g.beginPath(); g.arc(midX, M + 140, 30, 0, 7); g.fill();
  g.strokeStyle = K; g.lineWidth = 4; g.stroke();
  g.fillStyle = K; g.textAlign = 'center';
  g.font = '900 32px Arial';
  g.fillText('✈', midX, M + 152);
  g.textAlign = 'left';
  /* graine déterministe → siège/porte/vol stables pour un même voyage (déco souvenir) */
  const seed = [...(from + to + (d ? d.in : '') + (t.nom || ''))].reduce((a, ch) => a + ch.charCodeAt(0), 7);
  const seat = `${1 + seed % 42}${'ABCDEF'[seed % 6]}`;
  const gate = `${'ABCDE'[seed % 5]}${1 + seed % 45}`;
  const flight = `ACO ${1000 + seed % 8999}`;
  /* infos : 9 cases sur 3 rangées, étiquette au-dessus de la valeur */
  const cells = [
    ['PASSAGER', (u?.pseudo || 'Voyageur').toUpperCase()],
    ['DESTINATION', `${t.nom}`.toUpperCase() + (t.drapeau ? ' ' + t.drapeau : '')],
    ['DATES', d ? `${d.in.split('-').reverse().slice(0,2).join('/')} → ${d.out.split('-').reverse().slice(0,2).join('/')}` : (p.when || 'FLEXIBLES').toUpperCase()],
    ['VOYAGEURS', `${p.adults || 2} ADULTE(S)${p.kids ? ` + ${p.kids} ENFANT(S)` : ''}`],
    ['SÉJOUR', [plan.transport?.mode, plan.logement ? String(plan.logement.type || '').split(/[( ]|ou /)[0].trim() : '', plan.logement?.quartier].filter(Boolean).join(' · ').toUpperCase() || (p.days || '—').toUpperCase()],
    ['BUDGET', plan.budget?.total ? `${plan.budget.total} € / PERS.` : (t.budget_estime || '—').toUpperCase()],
    ['SIÈGE', seat],
    ['PORTE', gate],
    ['VOL', flight]
  ];
  const colW = 258;
  cells.forEach((c, i) => {
    const x = M + 34 + (i % 3) * colW;
    const y = M + 232 + Math.floor(i / 3) * 74;
    g.fillStyle = 'rgba(16,16,16,0.62)';
    g.font = '800 14px Sora, Arial';
    g.fillText(c[0], x, y);
    g.fillStyle = K;
    g.font = fit(c[1], 25, colW - 24, '800');
    /* si même à la taille mini le texte déborde (nom de destination très long) → coupe avec … */
    let val = c[1];
    if(g.measureText(val).width > colW - 24){
      while(val.length > 1 && g.measureText(val + '…').width > colW - 24) val = val.slice(0, -1);
      val = val.replace(/\s+$/, '') + '…';
    }
    g.fillText(val, x, y + 30);
  });
  /* bandeau noir de mentions, en bas du corps */
  g.fillStyle = K;
  g.fillRect(M, M + CH - 58, CW - STUB, 58);
  g.fillStyle = Y;
  g.font = '800 13px Inter, Arial';
  g.fillText("TICKET SOUVENIR — NE PERMET PAS D'EMBARQUER NI DE VOYAGER.", M + 34, M + CH - 34);
  g.fillStyle = WH;
  g.font = '600 13px Inter, Arial';
  g.fillText("Le QR sert uniquement à importer ce voyage dans l'application Acolite.", M + 34, M + CH - 14);

  /* bord du ticket */
  g.strokeStyle = K; g.lineWidth = 7; g.strokeRect(M, M, CW, CH);
  const px0 = M + CW - STUB;
  /* ligne de déchirure (perforation) entre corps et talon : pointillés nets, pleine hauteur.
     Pointillés BLANCS sur la partie basse (bande noire des mentions) pour rester visibles. */
  g.lineCap = 'round';
  g.setLineDash([4, 12]); g.lineWidth = 6;
  const bandTop = M + CH - 58;
  g.strokeStyle = K; g.beginPath(); g.moveTo(px0, M + 12); g.lineTo(px0, bandTop); g.stroke();
  g.strokeStyle = WH; g.beginPath(); g.moveTo(px0, bandTop); g.lineTo(px0, M + CH - 12); g.stroke();
  g.setLineDash([]); g.lineCap = 'butt';

  /* ---- TALON : QR encadré avec ombre dure ---- */
  const sx = px0 + STUB / 2;
  let qrOK = false;
  try{
    await loadQRGen();
    const tmp = document.createElement('div');
    new QRCode(tmp, { text: tripPayload(), width: 170, height: 170, correctLevel: QRCode.CorrectLevel.M });
    await new Promise(r => setTimeout(r, 80));
    const q = tmp.querySelector('canvas') || tmp.querySelector('img');
    if(q){
      g.fillStyle = K; g.fillRect(sx - 92 + 7, M + 60 + 7, 190, 190);   /* ombre dure */
      g.fillStyle = WH; g.fillRect(sx - 92, M + 60, 190, 190);
      g.strokeStyle = K; g.lineWidth = 4; g.strokeRect(sx - 92, M + 60, 190, 190);
      g.drawImage(q, sx - 85, M + 70, 170, 170);
      qrOK = true;
    }
  }catch(e){}
  g.fillStyle = K;
  g.textAlign = 'center';
  if(!qrOK){
    g.font = '900 17px Sora, Arial';
    g.fillText('QR INDISPONIBLE', sx, M + 150);
    g.font = '600 12px Inter, Arial';
    g.fillText('hors-ligne — regénère le ticket', sx, M + 172);
  }
  g.font = '900 16px Sora, Arial';
  g.fillText('SCANNE-MOI', sx, M + 296);
  g.font = '600 12px Inter, Arial';
  g.fillText('dans l\'application Acolite', sx, M + 316);
  g.fillText('pour importer ce voyage', sx, M + 334);
  /* séparateur pointillé + route + numéro de ticket */
  g.setLineDash([10, 8]); g.lineWidth = 3;
  g.beginPath(); g.moveTo(sx - 105, M + 358); g.lineTo(sx + 105, M + 358); g.stroke();
  g.setLineDash([]);
  g.font = fit(`${from} ✈ ${to}`, 30, STUB - 60, '900', 'Sora, Arial');
  g.fillText(`${from} ✈ ${to}`, sx, M + 402);
  g.font = '800 13px Inter, Arial';
  g.fillStyle = 'rgba(16,16,16,0.62)';
  g.fillText(`N° ACO-${from}${to}-${new Date().getFullYear()}`, sx, M + 424);
  /* faux code-barres (déco souvenir, non scannable) */
  const bcW = STUB - 96, bcX = sx - bcW / 2, bcY = M + 444, bcH = 30;
  g.fillStyle = K; let bx = bcX, si = seed || 7;
  while(bx < bcX + bcW - 1){
    si = (si * 16807) % 2147483647; const w = 1 + (si % 5);
    if(bx + w > bcX + bcW) break;
    g.fillRect(bx, bcY, w, bcH); bx += w;
    si = (si * 16807) % 2147483647; bx += 1 + (si % 4);
  }
  g.textAlign = 'left';

  cv.toBlob(async b => {
    const name = `acolite-${t.nom.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    const file = typeof File !== 'undefined' ? new File([b], name, { type: 'image/png' }) : null;
    if(file && navigator.canShare?.({ files: [file] })){
      try{
        await navigator.share({ files: [file], title: 'Mon ticket Acolite', text: `Mon voyage à ${t.nom} ✈️` });
        toast('📤 Ticket partagé — le QR est scannable dans Acolite');
        return;
      }catch(e){ if(e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('📷 Ticket téléchargé — le QR est scannable dans Acolite');
  }, 'image/png');
}
document.addEventListener('click', e => { if(e.target.closest('[data-passpng]')) passPNG(); });

/* ============================================================
   CARTE POSTALE — choix du style + mise en page des photos
   Photos : Wikipédia si dispo, sinon vignette illustrée. Export canvas.
============================================================ */
const PC_STYLES  = [
  {id:'pop', nom:'Pop'}, {id:'polaroid', nom:'Polaroïd'}, {id:'retro', nom:'Rétro'},
  {id:'noir', nom:'Cinéma'}, {id:'azur', nom:'Bord de mer'}, {id:'kraft', nom:'Kraft'}
];
const PC_LAYOUTS = [{id:'grande', nom:'Une grande'}, {id:'duo', nom:'Deux'}, {id:'collage', nom:'Collage'}];
let _pcStyle = 'pop', _pcLayout = 'grande', _pcPhotos = null, _pcTemplate = 'classique';

async function fetchWikiThumb(name){
  try{
    const r = await fetchT(`https://fr.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name)}`, {}, 8000);
    if(!r.ok) return null;
    const d = await r.json();
    const src = d.thumbnail?.source || d.originalimage?.source || null;
    if(!src) return null;
    /* évite drapeaux / blasons / armoiries (souvent renvoyés pour une ville) — pas des photos de voyage */
    if(/flag|drapeau|bandeira|bandera|coat|_coa|\bcoa\b|arms|escudo|escut|wappen|wapen|blason|bras[aã]o|stemma|armoiries|gonfalone|seal|crest|emblem|logo|\.svg/i.test(src)) return null;
    return src.replace(/\/\d+px-/, '/640px-');
  }catch(e){ return null; }
}
function pcLoadImg(url){
  return new Promise(res => {
    if(!url) return res(null);
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = url;
  });
}
function pcChips(){
  const tp = $('#pcTemplates'), st = $('#pcStyles'), ly = $('#pcLayouts');
  if(tp) tp.innerHTML = PC_TEMPLATES.map(m => `<div class="pc-chip ${m.id===_pcTemplate?'on':''}" data-pctpl="${m.id}">${m.nom}</div>`).join('');
  if(st) st.innerHTML = PC_STYLES.map(s => `<div class="pc-chip ${s.id===_pcStyle?'on':''}" data-pcstyle="${s.id}">${s.nom}</div>`).join('');
  if(ly) ly.innerHTML = PC_LAYOUTS.map(l => `<div class="pc-chip ${l.id===_pcLayout?'on':''}" data-pclayout="${l.id}">${l.nom}</div>`).join('');
  /* le modèle « Dos de carte » n'utilise qu'une vignette → la disposition n'a pas d'effet */
  const lyGroup = $('#pcLayoutGroup');
  if(lyGroup) lyGroup.style.display = _pcTemplate === 'dos' ? 'none' : '';
}
async function openPostcard(){
  const t = state.trip; if(!t) return;
  $('#ovPostcard').classList.add('show');
  pcChips();
  if($('#pcLoading')) $('#pcLoading').style.display = '';
  if($('#pcImg')) $('#pcImg').removeAttribute('src');
  if(!_pcPhotos){
    /* on privilégie les LIEUX (photos de monuments) puis la ville, puis le pays */
    const places = [...((state.cache.plan?.programme || []).flatMap(j => j.lieux || [])), t.nom, t.pays].filter(Boolean);
    const uniq = [...new Set(places)].slice(0, 4);
    const imgs = await Promise.all(uniq.map(async n => pcLoadImg(await fetchWikiThumb(n))));
    _pcPhotos = uniq.map((cap, i) => ({ cap, img: imgs[i] }));
  }
  renderPostcard();
}
function pcCover(g, img, x, y, w, h){
  const ir = img.width / img.height, rr = w / h;
  let sw, sh, sx, sy;
  if(ir > rr){ sh = img.height; sw = sh * rr; sx = (img.width - sw) / 2; sy = 0; }
  else { sw = img.width; sh = sw / rr; sx = 0; sy = (img.height - sh) / 2; }
  g.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}
/* Photo BIEN CADRÉE : l'image entière est visible (jamais rognée),
   posée sur une version floutée d'elle-même qui remplit le cadre. */
function pcPhoto(g, img, x, y, w, h){
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  try{ g.filter = 'blur(18px) brightness(.6)'; }catch(e){}
  pcCover(g, img, x - 24, y - 24, w + 48, h + 48);   /* fond flou débordant */
  try{ g.filter = 'none'; }catch(e){}
  const ir = img.width / img.height, rr = w / h;
  let dw, dh;
  if(ir > rr){ dw = w; dh = w / ir; } else { dh = h; dw = h * ir; }
  g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);  /* image entière, centrée */
  g.restore();
}
/* Emplacement vide : juste une icône + le mot PHOTO (l'utilisateur y mettra sa photo). */
function pcTile(g, x, y, w, h){
  g.fillStyle = '#E7E2D6'; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 2; g.setLineDash([9, 7]);
  g.strokeRect(x + 9, y + 9, w - 18, h - 18); g.setLineDash([]);
  const cx = x + w / 2, cy = y + h / 2, u = Math.min(w, h);
  g.fillStyle = 'rgba(0,0,0,.4)'; g.textAlign = 'center';
  g.font = `${Math.round(u * 0.24)}px Arial`;
  g.fillText('📷', cx, cy + u * 0.02);
  g.font = `900 ${Math.max(12, Math.round(u * 0.11))}px Sora, Arial`;
  g.fillText('PHOTO', cx, cy + u * 0.28);
  g.textAlign = 'left';
}
/* cachet d'oblitération circulaire (comme sur une vraie enveloppe) */
function pcPostmark(g, cx, cy, r, txt, sub){
  g.save();
  g.globalAlpha = .55; g.strokeStyle = '#2b2b2b'; g.lineWidth = 3;
  g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
  g.beginPath(); g.arc(cx, cy, r - 7, 0, 7); g.stroke();
  g.textAlign = 'center'; g.fillStyle = '#2b2b2b';
  g.font = `900 ${Math.round(r * 0.30)}px Sora, Arial`;
  g.fillText(String(txt || '').slice(0, 9).toUpperCase(), cx, cy - 1);
  g.font = `700 ${Math.round(r * 0.21)}px Inter, Arial`;
  g.fillText(String(sub || '').slice(0, 12), cx, cy + r * 0.34);
  /* petites barres d'oblitération */
  g.lineWidth = 2;
  for(let i = -2; i <= 2; i++){ g.beginPath(); g.moveTo(cx + r + 6, cy + i * 7); g.lineTo(cx + r + 40, cy + i * 7); g.stroke(); }
  g.restore(); g.textAlign = 'left';
}
/* faux timbre postal */
function pcStamp(g, x, y){
  const w = 84, h = 100;
  g.fillStyle = '#FFFDF3'; g.fillRect(x, y, w, h);
  g.strokeStyle = '#2b2b2b'; g.lineWidth = 2; g.setLineDash([4, 4]);
  g.strokeRect(x + 5, y + 5, w - 10, h - 10); g.setLineDash([]);
  g.textAlign = 'center';
  g.fillStyle = '#C0392B'; g.font = '34px Arial'; g.fillText('✈', x + w / 2, y + h / 2 + 8);
  g.fillStyle = '#2b2b2b'; g.font = '900 10px Sora, Arial'; g.fillText('PAR AVION', x + w / 2, y + h - 14);
  g.textAlign = 'left';
}
/* La disposition dépend UNIQUEMENT du choix de l'utilisateur : les emplacements
   en trop affichent un pavé « PHOTO » (avant, 1 seule photo forçait la grande image). */
function pcLayoutRects(pz, layout){
  const gp = 14, rects = [];
  if(layout === 'grande'){ rects.push([pz.x, pz.y, pz.w, pz.h]); }
  else if(layout === 'duo'){
    const w = (pz.w - gp) / 2;
    rects.push([pz.x, pz.y, w, pz.h], [pz.x + w + gp, pz.y, w, pz.h]);
  }else{ /* collage 2x2 */
    const w = (pz.w - gp) / 2, h = (pz.h - gp) / 2;
    rects.push([pz.x, pz.y, w, h], [pz.x + w + gp, pz.y, w, h], [pz.x, pz.y + h + gp, w, h], [pz.x + w + gp, pz.y + h + gp, w, h]);
  }
  return rects;
}
/* Palettes de couleurs — indépendantes du MODÈLE (qui, lui, réorganise les infos) */
const PC_PALETTES = {
  pop:      { bg:'#FFE600', ink:'#101010', band:'#101010', bandInk:'#FFE600', border:10, bandFill:true,  sub:'rgba(255,230,0,.9)',  hlt:'rgba(255,230,0,.65)', accent:'#FFE600', frame:6 },
  polaroid: { bg:'#ECECEC', ink:'#141414', band:'#FFFFFF', bandInk:'#141414', border:6,  bandFill:true,  sub:'#555',               hlt:'#8a8a8a',             accent:'#FF6B00', frame:3 },
  retro:    { bg:'#F1E7CE', ink:'#3B2E20', band:'#F1E7CE', bandInk:'#3B2E20', border:6,  bandFill:false, sub:'#6b5a44',            hlt:'#8a7a63',             accent:'#C0392B', frame:3 },
  noir:     { bg:'#14171C', ink:'#F2F2F2', band:'#14171C', bandInk:'#F5F5F5', border:4,  bandFill:false, sub:'#9AA3AD',            hlt:'#6E7681',             accent:'#E23B3B', frame:2 },
  azur:     { bg:'#DFF3F7', ink:'#0E3A46', band:'#FFFFFF', bandInk:'#0E3A46', border:7,  bandFill:true,  sub:'#3d7d8c',            hlt:'#6fa3ae',             accent:'#00A6C0', frame:4 },
  kraft:    { bg:'#C9A66B', ink:'#2E2013', band:'#C9A66B', bandInk:'#2E2013', border:7,  bandFill:false, sub:'#5b4227',            hlt:'#6f5334',             accent:'#7A4E2D', frame:4 }
};
/* MODÈLES : chacun réorganise complètement les informations et la mise en page */
const PC_TEMPLATES = [
  { id:'classique', nom:'📐 Classique' },
  { id:'magazine',  nom:'📰 Magazine' },
  { id:'dos',       nom:'✉️ Dos de carte' },
  { id:'pellicule', nom:'🎞️ Pellicule' },
  { id:'mosaique',  nom:'🧩 Mosaïque' },
  { id:'passeport', nom:'🛂 Passeport' },
  { id:'minimal',   nom:'✦ Minimal' },
  { id:'vertical',  nom:'📱 Portrait', w:700, h:1000 }   /* format vertical */
];

/* Infos du voyage, préparées une fois pour tous les modèles */
function pcInfo(t){
  const d = stayDates();
  return {
    nom: String(t.nom || '').toUpperCase(),
    pays: String(t.pays || '').toUpperCase(),
    dates: d ? `${d.in.split('-').reverse().slice(0,2).join('/')} – ${d.out.split('-').reverse().slice(0,2).join('/')}` : String(state.prefs?.when || 'souvenir').toUpperCase(),
    hl: (state.cache.plan?.programme || []).flatMap(j => j.lieux || []).filter(Boolean).slice(0, 4)
  };
}
/* règle la taille de police pour tenir dans `max` */
function pcFit(g, txt, max, start, weight = '900', fam = 'Sora, Arial'){
  let fs = start;
  do { g.font = `${weight} ${fs}px ${fam}`; fs -= 2; } while(g.measureText(txt).width > max && fs > 14);
  return Math.min(g.measureText(txt).width, max);
}
/* texte à lettres espacées (petites capitales type « eyebrow ») */
function pcTrack(g, txt, x, y, sp = 3){
  let cx = x; for(const ch of String(txt)){ g.fillText(ch, cx, y); cx += g.measureText(ch).width + sp; }
  return cx - x - sp;
}
/* dessine les photos dans des rectangles, avec le traitement propre au style */
function pcDrawPhotos(g, rects, photos, style, S, bare){
  rects.forEach((r, i) => {
    const p = photos[i] || {};
    const [x, y, w, h] = r;
    if(!bare && style === 'polaroid'){
      const fr = 12, capH = 26;
      g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(x + 5, y + 6, w, h);
      g.fillStyle = '#fff'; g.fillRect(x, y, w, h);
      g.strokeStyle = '#141414'; g.lineWidth = 3; g.strokeRect(x, y, w, h);
      const ix = x + fr, iy = y + fr, iw = w - 2 * fr, ih = h - fr - capH;
      if(p.img) pcPhoto(g, p.img, ix, iy, iw, ih); else pcTile(g, ix, iy, iw, ih);
      return;
    }
    if(!bare && style === 'pop'){ g.fillStyle = '#101010'; g.fillRect(x + 8, y + 8, w, h); }
    if(!bare && style === 'azur'){ g.fillStyle = '#fff'; g.fillRect(x - 6, y - 6, w + 12, h + 12); }
    if(p.img) pcPhoto(g, p.img, x, y, w, h); else pcTile(g, x, y, w, h);
    if(!bare){ g.strokeStyle = S.ink; g.lineWidth = S.frame; g.strokeRect(x, y, w, h); }
  });
}

/* ---- MODÈLE 1 : Classique (photos en haut, bandeau d'infos en bas) ---- */
function tplClassique(g, W, H, { S, I, style, layout, photos }){
  const pad = 30, bandH = 168;
  pcDrawPhotos(g, pcLayoutRects({ x:pad, y:pad, w:W - 2*pad, h:H - 2*pad - bandH - 8 }, layout), photos, style, S);
  const by = H - pad - bandH;
  if(S.bandFill){
    g.fillStyle = S.band; g.fillRect(pad, by, W - 2*pad, bandH);
    g.strokeStyle = S.ink; g.lineWidth = S.frame; g.strokeRect(pad, by, W - 2*pad, bandH);
  }else{
    g.strokeStyle = S.ink; g.globalAlpha = .35; g.lineWidth = 2;
    g.beginPath(); g.moveTo(pad + 4, by + 2); g.lineTo(W - pad - 4, by + 2); g.stroke(); g.globalAlpha = 1;
  }
  const tx = pad + 24;
  pcStamp(g, W - pad - 104, by + 16);
  g.textAlign = 'left';
  g.font = '800 12px Sora, Arial'; g.fillStyle = S.hlt;
  pcTrack(g, 'CARNET DE VOYAGE', tx, by + 30, 3);          /* sur-titre */
  const tw = pcFit(g, I.nom, W - 2*pad - 150, 58);
  g.fillStyle = S.bandInk; g.fillText(I.nom, tx, by + 78);
  g.fillStyle = S.accent; g.fillRect(tx, by + 90, tw, 7);
  g.font = '800 22px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, by + 124);
  if(I.hl.length){ g.font = '700 17px Inter, Arial'; g.fillStyle = S.hlt; g.fillText('📍 ' + I.hl.slice(0,3).join('  ·  ').slice(0,62), tx, by + 152); }
  g.textAlign = 'right'; g.font = '900 19px Sora, Arial'; g.fillStyle = S.bandInk;
  g.fillText('ACOLITE ✈', W - pad - 20, by + bandH - 14); g.textAlign = 'left';
}

/* ---- MODÈLE 2 : Magazine (photo plein cadre, titre en surimpression) ---- */
function tplMagazine(g, W, H, { S, I, layout, photos, style }){
  pcDrawPhotos(g, pcLayoutRects({ x:0, y:0, w:W, h:H }, layout), photos, style, S, true);
  const gr = g.createLinearGradient(0, H * .38, 0, H);
  gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(.55, 'rgba(0,0,0,.55)'); gr.addColorStop(1, 'rgba(0,0,0,.9)');
  g.fillStyle = gr; g.fillRect(0, H * .38, W, H * .62);
  g.fillStyle = S.accent; g.fillRect(0, 0, W, 12);            /* bandeau accent en haut */
  const tx = 48;
  g.textAlign = 'left';
  /* sur-titre façon magazine, en haut à gauche */
  g.fillStyle = 'rgba(255,255,255,.9)'; g.font = '800 13px Sora, Arial';
  pcTrack(g, 'CARNET DE VOYAGE', tx, 56, 4);
  const tw = pcFit(g, I.nom, W - 210, 86);
  g.fillStyle = '#fff'; g.fillText(I.nom, tx, H - 112);
  g.fillStyle = S.accent; g.fillRect(tx, H - 96, tw, 9);
  g.font = '800 25px Inter, Arial'; g.fillStyle = 'rgba(255,255,255,.92)';
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, H - 54);
  if(I.hl.length){ g.font = '700 18px Inter, Arial'; g.fillStyle = 'rgba(255,255,255,.72)'; g.fillText('📍 ' + I.hl.slice(0,3).join('  ·  ').slice(0,64), tx, H - 22); }
  pcStamp(g, W - 132, 32);
  g.textAlign = 'right'; g.font = '900 18px Sora, Arial'; g.fillStyle = 'rgba(255,255,255,.85)';
  g.fillText('ACOLITE ✈', W - 40, H - 22); g.textAlign = 'left';
}

/* ---- MODÈLE 3 : Dos de carte (message à gauche, timbre + adresse à droite) ---- */
function tplDos(g, W, H, { S, I, photos, style }){
  const pad = 44, mid = W / 2;
  g.strokeStyle = S.ink; g.globalAlpha = .45; g.lineWidth = 3;
  g.beginPath(); g.moveTo(mid, pad); g.lineTo(mid, H - pad); g.stroke(); g.globalAlpha = 1;
  /* gauche : vignette photo + « message » */
  const lx = pad + 12, tw2 = 200, th = 148, p0 = photos[0] || {};
  g.fillStyle = '#fff'; g.fillRect(lx - 7, pad + 4, tw2 + 14, th + 14);
  g.strokeStyle = S.ink; g.lineWidth = 3; g.strokeRect(lx - 7, pad + 4, tw2 + 14, th + 14);
  if(p0.img) pcPhoto(g, p0.img, lx, pad + 11, tw2, th); else pcTile(g, lx, pad + 11, tw2, th);
  let my = pad + th + 82;
  g.textAlign = 'left';
  const lw = mid - pad - 60;
  const tw3 = pcFit(g, I.nom, lw, 46);
  g.fillStyle = S.ink; g.fillText(I.nom, lx, my);
  g.fillStyle = S.accent; g.fillRect(lx, my + 13, tw3, 6);
  my += 54;
  g.font = '700 19px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays} · ${I.dates}`, lx, my); my += 36;
  g.font = '600 17px Inter, Arial'; g.fillStyle = S.hlt;
  I.hl.slice(0, 4).forEach(l => { if(my < H - pad){ g.fillText('·  ' + String(l).slice(0, 32), lx, my); my += 28; } });
  /* droite : timbre + lignes d'adresse */
  const rx = mid + 46;
  /* en-tête façon vraie carte postale */
  g.font = '800 13px Sora, Arial'; g.fillStyle = S.hlt;
  pcTrack(g, 'CARTE POSTALE · CORRESPONDANCE', rx, pad + 22, 3);
  pcStamp(g, W - pad - 96, pad + 44);
  pcPostmark(g, W - pad - 124, pad + 88, 38, I.pays.slice(0, 3), I.dates.slice(0, 5));
  g.strokeStyle = S.ink; g.globalAlpha = .3; g.lineWidth = 2;
  for(let i = 0, ay = H / 2 - 4; i < 4; i++, ay += 46){ g.beginPath(); g.moveTo(rx, ay); g.lineTo(W - pad - 16, ay); g.stroke(); }
  g.globalAlpha = 1;
  g.fillStyle = S.ink; g.font = '800 21px Inter, Arial';
  g.fillText(I.nom.slice(0, 22), rx + 6, H / 2 - 12);
  g.font = '700 18px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(I.pays, rx + 6, H / 2 + 34);
  g.fillText(I.dates, rx + 6, H / 2 + 80);
  g.textAlign = 'right'; g.font = '900 17px Sora, Arial'; g.fillStyle = S.ink;
  g.fillText('ACOLITE ✈', W - pad, H - pad + 10); g.textAlign = 'left';
}

/* ---- MODÈLE 4 : Pellicule (bande de film + infos dessous) ---- */
function tplPellicule(g, W, H, { S, I, layout, photos, style }){
  const sy = 64, sh = 312;
  g.fillStyle = '#111'; g.fillRect(0, sy, W, sh);
  g.fillStyle = S.bg;
  for(let x = 16; x < W - 12; x += 44){ g.fillRect(x, sy + 13, 23, 16); g.fillRect(x, sy + sh - 29, 23, 16); }
  /* marquages de pellicule (numéros de vue + marque du film) */
  g.fillStyle = '#E8A33D'; g.font = '700 12px monospace'; g.textAlign = 'left';
  g.fillText('ACOLITE 400  ·  12A   13   13A   14', 30, sy + 40);
  g.fillText('→  ' + I.dates, 30, sy + sh - 34);
  const n = layout === 'grande' ? 1 : layout === 'duo' ? 2 : 4;
  const gp = 12, iw = (W - 60 - gp * (n - 1)) / n, iy = sy + 44, ih = sh - 88;
  const rects = []; for(let i = 0; i < n; i++) rects.push([30 + i * (iw + gp), iy, iw, ih]);
  pcDrawPhotos(g, rects, photos, style, S, true);
  const tx = 44; const y = sy + sh + 72;
  g.textAlign = 'left';
  const tw = pcFit(g, I.nom, W - 250, 62);
  g.fillStyle = S.ink; g.fillText(I.nom, tx, y);
  g.fillStyle = S.accent; g.fillRect(tx, y + 14, tw, 7);
  g.font = '800 22px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, y + 56);
  if(I.hl.length){ g.font = '700 17px Inter, Arial'; g.fillStyle = S.hlt; g.fillText('📍 ' + I.hl.slice(0,3).join('  ·  ').slice(0,58), tx, y + 88); }
  pcStamp(g, W - 138, H - 156);
  g.textAlign = 'right'; g.font = '900 17px Sora, Arial'; g.fillStyle = S.ink;
  g.fillText('ACOLITE ✈', W - 44, H - 26); g.textAlign = 'left';
}

/* ---- MODÈLE 5 : Mosaïque (1 grande + 2 petites, bloc d'infos en surimpression) ---- */
function tplMosaique(g, W, H, { S, I, photos, style }){
  const pad = 26, gp = 12;
  const bigW = (W - 2*pad) * .60, colW = (W - 2*pad) - bigW - gp, zh = H - 2*pad, rh = (zh - gp) / 2;
  pcDrawPhotos(g, [[pad, pad, bigW, zh]], [photos[0] || {}], style, S, true);
  pcDrawPhotos(g, [[pad + bigW + gp, pad, colW, rh], [pad + bigW + gp, pad + rh + gp, colW, rh]],
               [photos[1] || {}, photos[2] || {}], style, S, true);
  /* bloc d'infos posé sur la grande photo */
  const bw = bigW - 32, bh = 158, bx = pad + 16, by = H - pad - 20 - bh;
  g.fillStyle = S.ink; g.globalAlpha = .92; g.fillRect(bx, by, bw, bh); g.globalAlpha = 1;
  g.fillStyle = S.accent; g.fillRect(bx, by, 8, bh);
  const tx = bx + 26;
  g.textAlign = 'left'; g.fillStyle = S.bg;
  g.font = '800 12px Sora, Arial'; pcTrack(g, 'CARNET DE VOYAGE', tx, by + 30, 3);
  pcFit(g, I.nom, bw - 52, 46); g.fillStyle = S.bg; g.fillText(I.nom, tx, by + 76);
  g.font = '800 19px Inter, Arial'; g.globalAlpha = .8;
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, by + 108);
  if(I.hl.length){ g.font = '700 15px Inter, Arial'; g.globalAlpha = .62; g.fillText('📍 ' + I.hl.slice(0,2).join('  ·  ').slice(0,40), tx, by + 136); }
  g.globalAlpha = 1;
  pcStamp(g, W - pad - 100, pad + 14);
  /* signature posée sur une photo → blanc + ombre pour rester lisible */
  g.textAlign = 'right'; g.font = '900 16px Sora, Arial';
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillText('ACOLITE ✈', W - pad - 11, H - pad - 7);
  g.fillStyle = '#fff'; g.fillText('ACOLITE ✈', W - pad - 12, H - pad - 8); g.textAlign = 'left';
}

/* ---- MODÈLE 6 : Passeport (page de passeport + tampon d'entrée) ---- */
function tplPasseport(g, W, H, { S, I, photos }){
  const pad = 42;
  g.textAlign = 'left'; g.fillStyle = S.ink; g.font = '900 20px Sora, Arial';
  pcTrack(g, 'PASSEPORT · PASSPORT', pad, pad + 24, 4);
  g.strokeStyle = S.ink; g.globalAlpha = .35; g.lineWidth = 2;
  g.beginPath(); g.moveTo(pad, pad + 42); g.lineTo(W - pad, pad + 42); g.stroke(); g.globalAlpha = 1;
  const pw = 186, ph = 236, px = pad, py = pad + 70, p0 = photos[0] || {};
  g.fillStyle = '#fff'; g.fillRect(px - 5, py - 5, pw + 10, ph + 10);
  g.strokeStyle = S.ink; g.lineWidth = 3; g.strokeRect(px - 5, py - 5, pw + 10, ph + 10);
  if(p0.img) pcPhoto(g, p0.img, px, py, pw, ph); else pcTile(g, px, py, pw, ph);
  const fx = px + pw + 54; let fy = py + 10;
  const field = (lbl, val) => {
    g.font = '700 12px Inter, Arial'; g.fillStyle = S.hlt; pcTrack(g, lbl, fx, fy, 2);
    g.fillStyle = S.ink; pcFit(g, String(val || '—'), W - fx - pad, 30);
    g.fillText(String(val || '—'), fx, fy + 36); fy += 78;
  };
  field('DESTINATION / DESTINATION', I.nom);
  field('PAYS / COUNTRY', I.pays);
  field('DATES / DATES', I.dates);
  pcPostmark(g, W - pad - 96, H - pad - 118, 44, I.pays.slice(0, 3), I.dates.slice(0, 5));
  /* bande lisible par machine, façon passeport */
  g.fillStyle = S.ink; g.globalAlpha = .1; g.fillRect(pad, H - pad - 54, W - 2*pad, 54); g.globalAlpha = 1;
  g.font = '700 17px monospace'; g.fillStyle = S.ink;
  const mrz = ('ACO<' + I.nom.replace(/[^A-Z0-9]/gi, '<') + '<<' + I.pays.replace(/[^A-Z0-9]/gi, '<')).slice(0, 42).padEnd(42, '<');
  g.fillText(mrz, pad + 12, H - pad - 20);
}

/* ---- MODÈLE 7 : Minimal (une photo centrée, typo aérée) ---- */
function tplMinimal(g, W, H, { S, I, photos, style }){
  const pw = W * .52, ph = H * .44, px = (W - pw) / 2, py = H * .12, p0 = photos[0] || {};
  if(p0.img) pcPhoto(g, p0.img, px, py, pw, ph); else pcTile(g, px, py, pw, ph);
  g.strokeStyle = S.ink; g.lineWidth = 2; g.strokeRect(px, py, pw, ph);
  g.textAlign = 'center';
  const cy = py + ph + 62;
  g.fillStyle = S.hlt; g.font = '800 11px Sora, Arial';
  const ew = g.measureText('CARNET DE VOYAGE').width + 15 * 3;
  pcTrack(g, 'CARNET DE VOYAGE', W / 2 - ew / 2, cy - 34, 3);
  pcFit(g, I.nom, W * .8, 52); g.fillStyle = S.ink; g.fillText(I.nom, W / 2, cy);
  g.fillStyle = S.accent; g.fillRect(W / 2 - 32, cy + 18, 64, 5);
  g.font = '700 20px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays}  ·  ${I.dates}`, W / 2, cy + 60);
  if(I.hl.length){ g.font = '600 16px Inter, Arial'; g.fillStyle = S.hlt; g.fillText(I.hl.slice(0,3).join('   ·   ').slice(0,56), W / 2, cy + 92); }
  g.font = '900 15px Sora, Arial'; g.fillStyle = S.ink; g.fillText('ACOLITE ✈', W / 2, H - 34);
  g.textAlign = 'left';
}

/* ---- MODÈLE 8 : Portrait (format vertical, façon story) ---- */
function tplVertical(g, W, H, { S, I, layout, photos, style }){
  const pad = 26, pzh = H * .54;
  pcDrawPhotos(g, pcLayoutRects({ x: pad, y: pad, w: W - 2*pad, h: pzh }, layout), photos, style, S);
  const tx = pad + 8; let y = pad + pzh + 78;
  g.textAlign = 'left';
  g.font = '800 12px Sora, Arial'; g.fillStyle = S.hlt;
  pcTrack(g, 'CARNET DE VOYAGE', tx, y - 48, 3);
  const tw = pcFit(g, I.nom, W - 2*pad - 16, 58);
  g.fillStyle = S.ink; g.fillText(I.nom, tx, y);
  g.fillStyle = S.accent; g.fillRect(tx, y + 16, tw, 8);
  g.font = '800 21px Inter, Arial'; g.fillStyle = S.sub;
  g.fillText(`${I.pays}  ·  ${I.dates}`, tx, y + 58);
  g.font = '700 17px Inter, Arial'; g.fillStyle = S.hlt;
  let ly = y + 100;
  I.hl.slice(0, 4).forEach(l => { if(ly < H - 70){ g.fillText('📍 ' + String(l).slice(0, 28), tx, ly); ly += 30; } });
  pcStamp(g, W - pad - 96, pad + pzh + 16);
  g.textAlign = 'right'; g.font = '900 17px Sora, Arial'; g.fillStyle = S.ink;
  g.fillText('ACOLITE ✈', W - pad - 8, H - 28); g.textAlign = 'left';
}

function drawPostcard(g, W, H, style, layout, photos, t){
  const S = PC_PALETTES[style] || PC_PALETTES.pop;   /* style inconnu → repli sûr */
  const I = pcInfo(t);
  g.fillStyle = S.bg; g.fillRect(0, 0, W, H);
  const TPL = { classique: tplClassique, magazine: tplMagazine, dos: tplDos, pellicule: tplPellicule,
                mosaique: tplMosaique, passeport: tplPasseport, minimal: tplMinimal, vertical: tplVertical };
  (TPL[_pcTemplate] || tplClassique)(g, W, H, { S, I, style, layout, photos });
  g.strokeStyle = S.ink; g.lineWidth = S.border; g.strokeRect(S.border / 2, S.border / 2, W - S.border, H - S.border);
}
function renderPostcard(){
  const t = state.trip; if(!t) return;
  /* chaque modèle peut imposer son format (ex : « Portrait » est vertical) */
  const tpl = PC_TEMPLATES.find(x => x.id === _pcTemplate) || PC_TEMPLATES[0];
  const W = tpl.w || 1000, H = tpl.h || 700;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  drawPostcard(cv.getContext('2d'), W, H, _pcStyle, _pcLayout, _pcPhotos || [], t);
  window._pcCanvas = cv;
  const img = $('#pcImg');
  if(img){ img.onload = () => { const l = $('#pcLoading'); if(l) l.style.display = 'none'; }; img.src = cv.toDataURL('image/png'); }
}
document.addEventListener('click', e => {
  if(e.target.closest('[data-postcard]')){ openPostcard(); return; }
  const tp = e.target.closest('[data-pctpl]');
  if(tp){ _pcTemplate = tp.dataset.pctpl; pcChips(); renderPostcard(); return; }
  const st = e.target.closest('[data-pcstyle]');
  if(st){ _pcStyle = st.dataset.pcstyle; pcChips(); renderPostcard(); return; }
  const ly = e.target.closest('[data-pclayout]');
  if(ly){ _pcLayout = ly.dataset.pclayout; pcChips(); renderPostcard(); return; }
});
/* --- Tes propres photos --- */
function pcUseFiles(files){
  const arr = [...files].filter(f => /^image\//.test(f.type)).slice(0, 4);
  if(!arr.length){ toast('Choisis des images 📷'); return; }
  /* data: URL (et non blob:) car la CSP img-src n'autorise pas blob: */
  Promise.all(arr.map(f => new Promise(res => {
    const rd = new FileReader();
    rd.onload = () => { const im = new Image(); im.onload = () => res({ cap:'', img: im }); im.onerror = () => res(null); im.src = rd.result; };
    rd.onerror = () => res(null);
    rd.readAsDataURL(f);
  }))).then(ps => {
    const ok = ps.filter(Boolean);
    if(!ok.length){ toast('Photos illisibles'); return; }
    _pcPhotos = ok;
    /* on ne force la disposition que si elle est trop petite pour montrer toutes les photos —
       sinon on respecte le choix de l'utilisateur (ex : 1 photo en « Collage »). */
    const slots = { grande:1, duo:2, collage:4 }[_pcLayout] || 1;
    if(ok.length > slots) _pcLayout = ok.length >= 3 ? 'collage' : 'duo';
    pcChips(); renderPostcard();
    toast(`📸 ${ok.length} photo(s) ajoutée(s)`);
  });
}
const _ePcMine = $('#pcMine'); if(_ePcMine) _ePcMine.onclick = () => $('#pcFile')?.click();
const _ePcFile = $('#pcFile'); if(_ePcFile) _ePcFile.onchange = e => { const fs = e.target.files; if(fs?.length) pcUseFiles(fs); e.target.value = ''; };
const _ePcWeb = $('#pcWeb'); if(_ePcWeb) _ePcWeb.onclick = async () => {
  const t = state.trip; if(!t) return;
  if($('#pcLoading')){ $('#pcLoading').textContent = 'Recherche de photos…'; $('#pcLoading').style.display = ''; }
  if($('#pcImg')) $('#pcImg').removeAttribute('src');
  const places = [...((state.cache.plan?.programme || []).flatMap(j => j.lieux || [])), t.nom, t.pays].filter(Boolean);
  const uniq = [...new Set(places)].slice(0, 4);
  const imgs = await Promise.all(uniq.map(async n => pcLoadImg(await fetchWikiThumb(n))));
  _pcPhotos = uniq.map((cap, i) => ({ cap, img: imgs[i] }));
  const found = _pcPhotos.filter(p => p.img).length;
  renderPostcard();
  toast(found ? `🌐 ${found} photo(s) trouvée(s)` : 'Aucune photo trouvée — ajoute les tiennes 📸');
};
const _ePcD = $('#pcDownload'); if(_ePcD) _ePcD.onclick = () => {
  if(!window._pcCanvas) return;
  window._pcCanvas.toBlob(b => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = `acolite-postcard-${String(state.trip?.nom||'voyage').toLowerCase().replace(/[^a-z0-9]+/g,'-')}.png`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('🖼️ Carte postale téléchargée');
  }, 'image/png');
};
const _ePcS = $('#pcShare'); if(_ePcS) _ePcS.onclick = () => {
  if(!window._pcCanvas) return;
  window._pcCanvas.toBlob(async b => {
    const file = typeof File !== 'undefined' ? new File([b], 'postcard.png', { type:'image/png' }) : null;
    if(file && navigator.canShare?.({ files:[file] })){
      try{ await navigator.share({ files:[file], title:'Ma carte postale Acolite', text:`Mon voyage à ${state.trip?.nom} ✈️` }); return; }
      catch(e){ if(e.name === 'AbortError') return; }
    }
    _ePcD.click();
  }, 'image/png');
};

/* --- Ajuste la taille des valeurs pour qu'aucun mot ne soit coupé --- */
function fitStats(){
  $$('.plan-stat .v').forEach(el => {
    let px = 16;
    el.style.fontSize = px + 'px';
    while(el.scrollWidth > el.clientWidth + 1 && px > 9){
      px -= 0.5;
      el.style.fontSize = px + 'px';
    }
  });
}

/* --- Météo animée en canvas (soleil / nuages / pluie / neige selon données réelles) --- */
let _wxRun = 0;
function startWx(){
  const cv = $('#wxCv'), m = state.cache._real?.mNums;
  if(!cv || !m) return;
  const g = cv.getContext('2d');
  if(!g) return;
  const my = ++_wxRun;
  const mode = m.min <= 1 && m.rain > 25 ? 'snow' : m.rain > 55 ? 'rain' : m.rain > 25 ? 'cloud' : 'sun';
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const drops = Array.from({length: 7}, (_, i) => ({ x: 8 + i * 6.5, y: Math.random() * 56 }));
  let f = 0;
  (function tick(){
    if(my !== _wxRun || !cv.isConnected) return;
    f++;
    g.clearRect(0, 0, 56, 56);
    const INK = dark() ? '#F4F3EF' : '#101010';
    if(mode === 'sun' || mode === 'cloud'){
      /* soleil qui tourne */
      const cx = mode === 'sun' ? 28 : 20, cy = mode === 'sun' ? 28 : 20, r = mode === 'sun' ? 11 : 8;
      g.save(); g.translate(cx, cy); g.rotate(f * 0.02);
      g.strokeStyle = INK; g.lineWidth = 2.5;
      for(let i = 0; i < 8; i++){ g.rotate(Math.PI / 4); g.beginPath(); g.moveTo(r + 4, 0); g.lineTo(r + 9, 0); g.stroke(); }
      g.restore();
      g.fillStyle = '#FFE600'; g.strokeStyle = INK; g.lineWidth = 2.5;
      g.beginPath(); g.arc(cx, cy, r, 0, 7); g.fill(); g.stroke();
    }
    if(mode !== 'sun'){
      /* nuage qui dérive */
      const ox = 6 * Math.sin(f * 0.03);
      g.fillStyle = dark() ? '#1B1B26' : '#fff'; g.strokeStyle = INK; g.lineWidth = 2.5;
      g.beginPath();
      g.arc(22 + ox, 32, 9, Math.PI * 0.5, Math.PI * 1.5);
      g.arc(30 + ox, 26, 8, Math.PI * 0.8, Math.PI * 1.98);
      g.arc(38 + ox, 32, 9, Math.PI * 1.5, Math.PI * 0.5);
      g.closePath(); g.fill(); g.stroke();
    }
    if(mode === 'rain' || mode === 'snow'){
      g.strokeStyle = mode === 'rain' ? '#00A8C0' : INK;
      g.fillStyle = g.strokeStyle; g.lineWidth = 2;
      drops.forEach(dp => {
        dp.y += mode === 'rain' ? 1.8 : 0.7;
        if(dp.y > 56) dp.y = 40;
        if(dp.y > 38){
          if(mode === 'rain'){ g.beginPath(); g.moveTo(dp.x, dp.y); g.lineTo(dp.x - 2, dp.y + 5); g.stroke(); }
          else { g.beginPath(); g.arc(dp.x + 2 * Math.sin(f * 0.1 + dp.x), dp.y, 1.8, 0, 7); g.fill(); }
        }
      });
    }
    requestAnimationFrame(tick);
  })();
}

/* --- Confettis 🎉 (valise complétée à 100 %) --- */
function confetti(){
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;inset:0;z-index:90;pointer-events:none';
  cv.width = innerWidth; cv.height = innerHeight;
  document.body.appendChild(cv);
  const g = cv.getContext('2d');
  if(!g){ cv.remove(); return; }
  const C = ['#FFE600', '#00F0FF', '#FF6B00', '#A855F7', '#22C55E', '#101010'];
  const ps = Array.from({length: 120}, () => ({
    x: Math.random() * cv.width, y: -20 - Math.random() * cv.height * 0.5,
    s: 6 + Math.random() * 8, v: 2.4 + Math.random() * 3.6,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.25,
    c: C[Math.floor(Math.random() * C.length)]
  }));
  let n = 0;
  (function tick(){
    g.clearRect(0, 0, cv.width, cv.height);
    ps.forEach(q => {
      q.y += q.v; q.r += q.vr;
      g.save(); g.translate(q.x, q.y); g.rotate(q.r);
      g.fillStyle = q.c; g.fillRect(-q.s/2, -q.s/2, q.s, q.s);
      g.restore();
    });
    if(++n < 150) requestAnimationFrame(tick); else cv.remove();
  })();
}


/* --- PWA : app installable + hors-ligne --- */
if('serviceWorker' in navigator){
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

/* bandeau hors-ligne (mode avion : l'app reste utilisable, l'IA non) */
function netBanner(){
  let b = $('#offBar');
  if(!navigator.onLine){
    if(!b){
      b = document.createElement('div');
      b.id = 'offBar';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:80;background:var(--accent-orange);color:#101010;border-bottom:3px solid var(--stroke);font-weight:900;font-size:.78rem;text-align:center;padding:7px 12px';
      b.textContent = '✈️ Hors-ligne — ton voyage reste consultable, l’IA et les prix reviendront avec le réseau';
      document.body.appendChild(b);
    }
  } else if(b) b.remove();
}
addEventListener('online', netBanner);
addEventListener('offline', netBanner);
netBanner();

/* bouton "Installer l'app" (Android/Chrome) — apparaît dans le Profil quand c'est possible */
let _deferredPrompt = null;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredPrompt = e;
  const it = $('#pwaItem');
  if(it) it.style.display = '';
});
document.addEventListener('click', async e => {
  if(e.target.id !== 'pfInstall') return;
  if(!_deferredPrompt){ toast('Sur iPhone : Partager → « Sur l’écran d’accueil »'); return; }
  _deferredPrompt.prompt();
  await _deferredPrompt.userChoice;
  _deferredPrompt = null;
  $('#pwaItem').style.display = 'none';
});

/* ---------- Boot ---------- */
loadSettings();
load();
checkImportHash();
if(state.prefs){
  $('#fFrom').value = state.prefs.from || '';
  $('#fWhen').value = state.prefs.when || '';
  if(state.prefs.depart) $('#fDepart').value = state.prefs.depart;
  if(state.prefs.dest) $('#fDest').value = state.prefs.dest;
  if(state.prefs.adults) $('#fAdults').value = state.prefs.adults;
  if(state.prefs.kids !== undefined) $('#fKids').value = state.prefs.kids;
  if(state.prefs.free) $('#fFree').value = (state.prefs.free||'').split(' | Affinage :')[0];
  if(state.prefs.transport) $('#fTransport').value = state.prefs.transport;
}else{
  applyTripDefaults();   /* pas encore de voyage → on pré-remplit avec les valeurs par défaut */
}
unlockSteps();
if(state.lastProps) renderDestinations(state.lastProps);
if(state.step > 1) gotoStep(Math.min(state.step, 3));
requireAuth();

/* app.js est arrivé au bout : le vérificateur de démarrage ne déclenchera pas d'alerte */
if(window.__ACOLITE) window.__ACOLITE.loaded = true;
