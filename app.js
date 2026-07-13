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
const LS_GEMM  = 'acolite_gem_model';   // modèle Gemini auto-détecté
const LS_GROQ  = 'acolite_groq_key';
const LS_GROQM = 'acolite_groq_model';
const LS_TP    = 'acolite_tp_token';
const LS_TRIP  = 'acolite_trip_v2';
/* Ordre de préférence — le premier dispo sur la clé sera utilisé */
const GEM_PREFERRED = ['gemini-2.5-flash','gemini-flash-latest','gemini-2.0-flash','gemini-2.5-flash-lite','gemini-2.5-pro','gemini-pro-latest'];

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

function save(){ localStorage.setItem(LS_TRIP, JSON.stringify(state)); }
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
const groqModel = () => localStorage.getItem(LS_GROQM) || 'llama-3.3-70b-versatile';
const tpKey   = () => CFG.travelpayouts || localStorage.getItem(LS_TP) || '';
const hasGroq = () => useBackend() || !!groqKey();

/* --- Découverte automatique du modèle Gemini disponible sur la clé --- */
async function resolveGemModel(key, force = false){
  if(!force){
    const cached = localStorage.getItem(LS_GEMM);
    if(cached) return cached;
  }
  const r = await fetch(useBackend()
    ? `${API()}/gemini/models`
    : `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=100`);
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
  localStorage.setItem(LS_GEMM, pick);
  return pick;
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

async function gemini(prompt, expectJson = true, maxTok = 4096, _retry = false, temp = 0.85){
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
  if(expectJson) body.generationConfig.responseMimeType = 'application/json';
  const r = useBackend()
    ? await fetch(`${API()}/gemini`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ model, body })      /* aucune clé ne quitte le navigateur */
      })
    : await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,{
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  if(r.status === 404 && !_retry){
    /* modèle mis en cache devenu obsolète → re-détection puis retry */
    localStorage.removeItem(LS_GEMM);
    await resolveGemModel(key, true);
    return gemini(prompt, expectJson, maxTok, true);
  }
  if((r.status === 429 || r.status === 503) && !_retry){
    /* surcharge passagère → une seule nouvelle tentative après 1,6 s */
    await new Promise(res => setTimeout(res, 1600));
    return gemini(prompt, expectJson, maxTok, true, temp);
  }
  if(!r.ok){
    const msg = await gemErrMsg(r);
    toast('⚠️ ' + msg);
    if(r.status === 429) throw new Error('RATE');
    throw new Error('BAD_KEY');
  }
  const d = await r.json();
  let txt = (d.candidates?.[0]?.content?.parts || []).map(p=>p.text||'').join('');
  if(!txt) { toast('⚠️ Réponse vide de Gemini, réessaie'); throw new Error('EMPTY'); }
  if(!expectJson) return txt;
  txt = txt.replace(/```json|```/g,'').trim();
  return parseAI(txt);
}

async function groq(prompt, expectJson = true, maxTok = 2048){
  const body = {
    model: groqModel(),
    messages: [{ role:'user', content: prompt + (expectJson ? '\nRéponds UNIQUEMENT avec un objet JSON valide, rien d\'autre.' : '') }],
    temperature: 0.7,
    max_tokens: maxTok
  };
  if(expectJson) body.response_format = { type:'json_object' };
  const r = useBackend()
    ? await fetch(`${API()}/groq`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ body })             /* la clé Groq reste sur le serveur */
      })
    : await fetch('https://api.groq.com/openai/v1/chat/completions',{
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + groqKey() },
        body: JSON.stringify(body)
      });
  if(r.status === 401){ toast('Clé Groq invalide — vérifie dans ⚙'); throw new Error('BAD_GROQ'); }
  if(r.status === 429){ throw new Error('GROQ_RATE'); }
  if(!r.ok) throw new Error('GROQ_HTTP ' + r.status);
  const d = await r.json();
  let txt = d.choices?.[0]?.message?.content || '';
  if(!expectJson) return txt;
  txt = txt.replace(/```json|```/g,'').trim();
  return parseAI(txt, false);
}

/* --- Auto-réparation JSON : récupère les réponses IA mal formées --- */
async function parseAI(txt, allowRepair = true){
  try{ return JSON.parse(txt); }catch(e){}
  const a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  if(a > -1 && b > a){ try{ return JSON.parse(txt.slice(a, b + 1)); }catch(e){} }
  if(allowRepair && hasGroq()){
    try{
      const fixed = await groq('Ce JSON est invalide. Corrige-le sans changer son contenu. Réponds UNIQUEMENT avec le JSON corrigé, rien d\'autre :\n' + txt.slice(0, 6000), false, 4096);
      return JSON.parse(fixed.replace(/```json|```/g,'').trim());
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

function loaderHTML(msg){ return `<div class="loader"><div class="orbit"></div>${esc(msg)}</div>`; }
function errHTML(msg){ return `<div class="err">⚠️ ${esc(msg)}</div>`; }
function badge(via){ return via === 'groq' ? '<span class="ai-badge groq">⚡ Groq</span>' : '<span class="ai-badge gemini">✦ Gemini</span>'; }

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
- Destination souhaitée : ${p.dest || 'libre, à proposer'}
- Limites & conditions : ${p.free || 'aucune'}`;
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
    free:  $('#fFree').value.trim().slice(0,600) + (extra ? ' | Affinage : ' + String(extra).slice(0,600) : '')
  };
}

async function proposeTrips(extra = '', lucky = false){
  const prefs = readPrefs(extra);
  state.prefs = prefs; save();
  const zone = $('#zoneResults');
  zone.innerHTML = `<div class="card">${loaderHTML(lucky ? "Roulette mondiale en cours… 🎲" : "Acolite explore le monde pour toi…")}</div>`;
  toast('🔎 Acolite prépare tes propositions…');
  $('#btnGo').disabled = true; $('#btnLucky').disabled = true;

  const prompt = `Tu es Acolite, un expert voyage français, chaleureux et concret.
${ctx()}
${lucky ? 'MODE SURPRISE : propose des destinations inattendues, originales, auxquelles le voyageur ne penserait jamais, mais qui collent quand même au budget et à la période.' : ''}
TOUT DOIT ÊTRE TROUVÉ DÈS MAINTENANT : pour CHAQUE proposition, tu donnes déjà le transport (mode, prix A/R, durée) ET le logement (type, quartier réel, prix/nuit). Le voyageur doit pouvoir comparer sans rien avoir à deviner. Uniquement des quartiers qui EXISTENT VRAIMENT.

QUESTIONS DE PRÉCISION : si des infos te manquent pour viser juste (rythme, ambiance, priorités, contraintes), pose 2 ou 3 questions courtes dans "questions", chacune avec 2 à 4 options cliquables. Si le voyageur a déjà tout précisé, renvoie "questions":[].

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
   {"texte":"question courte et UTILE pour préciser le voyage","options":["3-4 réponses courtes"]}
 ]
}
"questions" : 1 à 3 questions qui aideraient VRAIMENT à préciser le voyage (dates exactes ? quartier ambiance ? priorité visites/repos ? contrainte transport ?). Jamais de question dont la réponse est déjà dans le contexte.`;

  try{
    const d = await gemini(prompt, true, 8192);
    state.destinations = d.destinations || [];
    state.seen = [...new Set([...(state.seen||[]), ...state.destinations.map(x=>x.nom)])].slice(-15);
    state.lastProps = d; save();
    renderDestinations(d);
    gotoStep(2);
    /* → Questions de précision AVANT que tu ne choisisses : la pop-up s'ouvre ici */
    const qs = (d.questions || []).filter(q => q && q.texte);
    if(qs.length && !state._qsDone) openQsPopup(qs);
  }catch(e){
    if(e.message !== 'NO_KEY') zone.innerHTML = `<div class="card">${errHTML("Impossible de contacter Gemini. Vérifie ta clé ou ta connexion.")}</div>`;
    else zone.innerHTML = '';
  }
  $('#btnGo').disabled = false; $('#btnLucky').disabled = false;
}

function renderDestinations(d){
  const zone = $('#zoneResults');
  const n = (d.destinations||[]).length;
  let html = `<div class="card"><h2>${n > 1 ? 'Compare tes ' + n + ' voyages' : 'Ton voyage sur mesure'} 🎒 <span class="ai-badge gemini">✦ Gemini</span></h2>
  <p class="sub">${n > 1 ? 'Des propositions volontairement différentes. Compare-les point par point et clique sur celle qui te fait vibrer.' : 'Acolite a concentré ses efforts sur la formule idéale pour ta destination. Clique dessus pour lancer l\'organisation.'}</p>
  <div class="dest-grid">`;
  (d.destinations||[]).forEach((x,i)=>{
    const tIco = ({avion:'✈️',train:'🚆',voiture:'🚗'})[x.transport_conseille]||'✈️';
    html += `<div class="dest" data-i="${i}">
      <div class="flag">${esc(x.drapeau||'📍')}</div>
      <h3>${esc(x.nom)}</h3><div class="country">${esc(x.pays)}</div>
      <p>${esc(x.resume)}</p>
      <div class="dest-facts">
        <div class="fact"><span class="fk">💶 Budget total</span><span class="fv">${esc(x.budget_estime)}</span></div>
        <div class="fact"><span class="fk">${tIco} ${esc(x.transport_conseille||'avion')}</span><span class="fv">${esc(x.transport_prix||'—')}${x.transport_duree ? ' · ' + esc(x.transport_duree) : ''}</span></div>
        <div class="fact"><span class="fk">🏨 ${esc(String(x.logement_type||'logement').split('(')[0].trim())}</span><span class="fv">${esc(x.logement_quartier||'—')}${x.logement_prix ? ' · ' + esc(x.logement_prix) + '/nuit' : ''}</span></div>
        <div class="fact"><span class="fk">☀️ Météo</span><span class="fv">${esc(x.meteo_periode)}</span></div>
        <div class="fact"><span class="fk">⏱ Durée idéale</span><span class="fv">${esc(x.duree_ideale)}</span></div>
        <div class="fact"><span class="fk">🗣️ Langue</span><span class="fv">${esc(x.langue||'—')}</span></div>
      </div>
      ${(x.transport_pourquoi || x.logement_pourquoi) ? `<p class="hint" style="margin-top:8px">${x.transport_pourquoi ? '✈️ ' + esc(x.transport_pourquoi) : ''}${x.transport_pourquoi && x.logement_pourquoi ? ' · ' : ''}${x.logement_pourquoi ? '🏨 ' + esc(x.logement_pourquoi) : ''}</p>` : ''}
      <div class="tags" style="margin-top:10px">${(x.points_forts||[]).map(p=>`<span class="tag">${esc(p)}</span>`).join('')}</div>
      <button class="btn sm" style="width:100%;justify-content:center;margin-top:6px">Choisir ce voyage →</button>
    </div>`;
  });
  html += `</div>`;
  const qs = (d.questions || (d.question_affinage?.texte ? [d.question_affinage] : [])).filter(q => q && q.texte);
  if(qs.length){
    html += `<div class="divider"></div>
    <h3>🎯 Précisons ton voyage</h3>
    <p class="hint" style="margin:4px 0 10px">Réponds à une question — les propositions sont refaites en tenant compte de ta réponse.</p>`;
    qs.forEach(q => {
      html += `<h4 style="margin:10px 0 6px;font-family:'Sora'">${esc(q.texte)}</h4>
      <div class="chips">${(q.options||[]).map(o=>`<div class="chip refine" data-q="${esc(q.texte)}" data-r="${esc(o)}">${esc(o)}</div>`).join('')}</div>`;
    });
  }
  html += `</div>`;
  zone.innerHTML = html;

  $$('.dest').forEach(el => el.onclick = () => chooseTrip(+el.dataset.i));
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
  h.push({ nom: t.nom, pays: t.pays, quand: Date.now() });
  localStorage.setItem(LS_HIST, JSON.stringify(h.slice(-10)));
}

function chooseTrip(i){
  state.trip = state.destinations[i];
  pushHistory(state.trip);
  state.cache = {}; state.checklist = {}; state.spends = []; state.chatLog = []; state.notes = ''; state.resas = [];
  state._geo = null; state.planAnswers = []; state._qsDone = false; _onSiteDone = false;
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
      <button class="pass-change" data-changedest title="Changer de destination">↩</button>
    </div>

    <div class="pass-info">
      <div class="pi"><span class="pk">Destination</span><span class="pv">${esc(t.nom)} ${esc(t.drapeau || '')}</span></div>
      <div class="pi"><span class="pk">Dates</span><span class="pv">${esc(dates)}${nuits ? ` · ${nuits} n.` : ''}</span></div>
      <div class="pi"><span class="pk">Passagers</span><span class="pv">${esc(pax)}</span></div>
      <div class="pi"><span class="pk">Budget</span><span class="pv">${esc(budget)}${logt ? ` · ${esc(logt)}` : ''}</span></div>
    </div>

    <div class="pass-tear">
      <div class="barcode">${'<i></i>'.repeat(26)}</div>
      <div class="pass-acts">
        <button class="pact" data-passpng title="Télécharger le ticket avec son QR code">📷<span>Ticket</span></button>
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
async function geoPlace(name){
  try{
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=fr&format=json`);
    const d = await r.json();
    return d.results?.[0] || null;
  }catch(e){ return null; }
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
  const t = state.trip; if(!t) return '';
  const key = t.nom + ',' + t.pays;
  let R = state.cache._real;
  if(!R || R.key !== key){
    R = { key };
    try{
      const [g1, g2] = await Promise.all([ geoPlace(state.prefs?.from || 'Paris'), geoPlace(t.nom) ]);
      if(g1 && g2) R.dist = Math.round(havKm(g1, g2));
      if(g2){
        const depDate = state.prefs?.depart ? new Date(state.prefs.depart) : null;
        const farAway = depDate && (depDate - Date.now()) > 16 * 86400000;
        if(farAway){
          /* départ lointain → climat réel du même mois l'an dernier (archive Open-Meteo) */
          const y = depDate.getFullYear() - 1, m = String(depDate.getMonth() + 1).padStart(2, '0');
          const last = new Date(y, depDate.getMonth() + 1, 0).getDate();
          const wa = await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${g2.latitude}&longitude=${g2.longitude}&start_date=${y}-${m}-01&end_date=${y}-${m}-${last}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`).then(r=>r.json()).catch(()=>null);
          if(wa?.daily?.temperature_2m_max?.length){
            const rain = Math.round((wa.daily.precipitation_sum||[]).reduce((a,b)=>a+(b||0),0));
            R.meteo = `climat typique du mois du voyage (relevés réels ${m}/${y}) : ${_avg(wa.daily.temperature_2m_min)}°C à ${_avg(wa.daily.temperature_2m_max)}°C, ${rain} mm de pluie sur le mois`;
            R.mNums = { min:_avg(wa.daily.temperature_2m_min), max:_avg(wa.daily.temperature_2m_max), rain: Math.min(90, Math.round(rain/3)) };
          }
        }
        if(!R.meteo){
          const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${g2.latitude}&longitude=${g2.longitude}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_mean&forecast_days=7&timezone=auto`).then(r=>r.json());
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
Contrôle STRICTEMENT et uniquement ces 6 points :
1. "budget.total" respecte-t-il le budget demandé par personne ?
2. Le nombre d'entrées de "programme" correspond-il à la durée demandée ?
3. Le transport choisi est-il cohérent avec la distance et les limites du voyageur ?
4. COHÉRENCE GÉOGRAPHIQUE : chaque journée regroupe-t-elle des lieux PROCHES les uns des autres ? Signale toute journée qui fait traverser la ville en zigzag (ex : un lieu au nord, puis au sud, puis de nouveau au nord).
5. Les lieux cités existent-ils VRAIMENT dans cette ville, et sont-ils ouverts à la période du voyage (attention aux jours fériés signalés) ?
6. Le programme est-il réaliste en temps (pas 6 musées dans une seule journée) ?
Réponds en JSON : {"ok":true} si tout est cohérent, sinon {"ok":false,"problemes":["max 4 incohérences, courtes et factuelles"]}`, true, 700);
    if(v?.ok !== false || !(v.problemes||[]).length){ d._checked = 'ok'; return d; }
    const d2 = await gemini(basePrompt + `\n\nATTENTION — une relecture indépendante a détecté ces incohérences dans une première version. Corrige-les IMPÉRATIVEMENT :\n- ${v.problemes.join('\n- ')}`, true, 8192, false, 0.4);
    d2._checked = 'fixed';
    return d2;
  }catch(e){ return d; }
}

async function loadPlan(force = false){
  const zone = $('#zonePlan');
  if(state.cache.plan && !force){ renderPlan(state.cache.plan); syncModeFromPlan(state.cache.plan); return; }
  zone.innerHTML = loaderHTML('Acolite organise ton voyage de A à Z…');
  const t = state.trip;
  const answers = (state.planAnswers||[]).join(' · ');
  const realCtx = await realData();
  /* Le transport et le logement ont DÉJÀ été trouvés à l'étape 2 : on les garde et on approfondit */
  const dejaTrouve = (t.transport_conseille || t.logement_quartier)
    ? `\nCHOIX DÉJÀ VALIDÉS À L'ÉTAPE 2 (le voyageur les a acceptés en choisissant ce voyage — GARDE-LES, sauf si les données réelles les contredisent) :
- Transport : ${t.transport_conseille || '?'}${t.transport_prix ? ` (${t.transport_prix})` : ''}${t.transport_duree ? `, ${t.transport_duree}` : ''}
- Logement : ${t.logement_type || '?'} dans le quartier ${t.logement_quartier || '?'}${t.logement_prix ? ` (${t.logement_prix}/nuit)` : ''}
TON TRAVAIL : approfondir (détails pratiques, programme jour par jour, budget précis), PAS tout recommencer.\n`
    : '';
  const prompt = `Tu es Acolite, organisateur de voyage expert. ${ctx()}
${realCtx}${dejaTrouve}
Destination validée : ${t.nom} (${t.pays}).
RÈGLE ABSOLUE : ne cite que des quartiers, lieux et établissements RÉELS et vérifiables. En cas de doute, omets plutôt qu'inventer.
Si les données réelles incluent un trajet en train ou un taux de change, appuie ton choix de transport et tes conversions de budget DESSUS.
${answers ? 'RÉPONSES du voyageur à tes questions précédentes (à intégrer au plan) : ' + answers : ''}

MISSION : organise TOUT le voyage. C'est TOI qui décides du transport (avion, train ou voiture) en fonction du budget, de la distance depuis ${state.prefs.from} et des limites du voyageur — justifie ton choix. Trouve le meilleur type de logement et le quartier. Structure le séjour. Reste STRICTEMENT dans le budget.
INTERDIT de poser des questions : renvoie "questions":[]. Le voyageur a déjà tout précisé, construis le voyage complet directement.

Réponds UNIQUEMENT en JSON. Commence OBLIGATOIREMENT par le champ "analyse" (raisonnement interne, jamais montré) AVANT le reste :
{
 "analyse":"3-4 phrases : comparaison chiffrée des transports possibles (durée/prix vs données réelles), quartier optimal et pourquoi, points de vigilance budget",
 "transport":{
   "mode":"avion" ou "train" ou "voiture",
   "pourquoi":"2 phrases : pourquoi CE transport vu le budget et les conditions",
   "details":"trajet concret : aéroports/gares/axes, durée, ce qu'il faut réserver",
   "prix_estime":"fourchette réaliste A/R par personne"
 },
 "logement":{
   "type":"1 ou 2 mots MAXIMUM : hôtel, appartement, auberge, villa…",
   "quartier":"quartier précis recommandé",
   "prix_nuit":"fourchette en € uniquement, ex 80-120€ (sans le mot nuit)",
   "pourquoi":"1 phrase"
 },
 "programme":[{"jour":1,"resume":"le thème du jour en 1 ligne","lieux":["2-4 lieux RÉELS visités ce jour (monuments, quartiers, sites précis)"]}],
 "budget":{"total":nombre entier en euros par personne,"repartition":"1 phrase : transport X€ + logement Y€ + vie sur place Z€"},
 "conseil_cle":"LE conseil le plus important pour ce voyage",
 "questions":[{"texte":"question courte","options":["3-4 réponses courtes"]}]
}
Le programme couvre toute la durée (${state.prefs.days}), 1 ligne par jour.`;
  try{
    let d = await gemini(prompt, true, 8192, false, 0.45);
    d = await reviewPlan(d, prompt);
    state.cache.plan = d; save();
    renderPlan(d);
    syncModeFromPlan(d);
  }catch(e){
    if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Organisation impossible pour le moment, réessaie.');
  }
}

/* ============================================================
   HOTELLOOK (Travelpayouts) — vrais prix d'hôtels dans l'app
   Endpoint cache.json : prix agrégés Booking/Expedia/Agoda.
   Repli automatique sur les liens comparateurs si indisponible.
============================================================ */
/* Relais CORS : Hotellook n'envoie pas les en-têtes CORS, le navigateur
   refuse donc de lire sa réponse. On passe par un relais qui, lui, les ajoute.
   Ordre : ton Worker Cloudflare (config.js) → relais publics → appel direct. */
function relays(){
  const own = API();
  const list = [];
  if(own) list.push({ nom:'ton backend', wrap: u => `${own}/?url=${encodeURIComponent(u)}` });
  list.push({ nom:'relais public 1', wrap: u => `https://corsproxy.io/?url=${encodeURIComponent(u)}` });
  list.push({ nom:'relais public 2', wrap: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` });
  list.push({ nom:'direct', wrap: u => u });
  return list;
}

async function loadHotels(force = false){
  const zone = $('#zoneHotels');
  if(!zone) return;
  const t = state.trip;
  const d = stayDates();
  const token = tpKey();
  if(!t || !d || (!token && !useBackend())){
    zone.innerHTML = `<p class="hint">Renseigne une date de départ à l'étape 1 pour voir les prix réels des hôtels ici.</p>`;
    return;
  }
  const ck = `hot_${t.nom}_${d.in}`;
  if(state.cache[ck] && !force){ renderHotels(state.cache[ck]); return; }
  zone.innerHTML = loaderHTML('Recherche des prix réels (Booking, Expedia, Agoda…)');
  const A = state.prefs?.adults || 2, K = state.prefs?.kids || 0;
  const qs = `location=${encodeURIComponent(t.nom)}&checkIn=${d.in}&checkOut=${d.out}`
    + `&adults=${A}${K ? '&children=' + K : ''}&currency=eur&limit=10`;
  /* backend : le token est ajouté côté serveur → il ne transite jamais par le navigateur */
  if(useBackend()){
    try{
      const res = await fetch(`${API()}/hotels?${qs}`);
      if(res.ok){
        const data = await res.json();
        const rows = (Array.isArray(data) ? data : []).filter(h => h.priceFrom || h.priceAvg);
        if(rows.length){
          rows.sort((a, b) => (a.priceFrom || a.priceAvg) - (b.priceFrom || b.priceAvg));
          state.cache[ck] = rows.slice(0, 8); save();
          renderHotels(state.cache[ck], 'ton backend');
          return;
        }
      }
    }catch(e){}
  }
  const api = `https://engine.hotellook.com/api/v2/cache.json?${qs}&token=${encodeURIComponent(token)}`;

  /* on garde en mémoire le relais qui a marché → direct au but la fois suivante */
  const memo = localStorage.getItem('acolite_relay');
  const chain = relays();
  const ordered = memo ? [...chain.filter(r => r.nom === memo), ...chain.filter(r => r.nom !== memo)] : chain;
  const errs = [];

  for(const r of ordered){
    try{
      const res = await fetch(r.wrap(api), { headers: { 'Accept':'application/json' } });
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const txt = await res.text();
      let data;
      try{ data = JSON.parse(txt); }catch(e){ throw new Error('réponse illisible'); }
      const rows = (Array.isArray(data) ? data : []).filter(h => h.priceFrom || h.priceAvg);
      if(!rows.length) throw new Error('aucun tarif pour ces dates');
      rows.sort((a, b) => (a.priceFrom || a.priceAvg) - (b.priceFrom || b.priceAvg));
      state.cache[ck] = rows.slice(0, 8); save();
      localStorage.setItem('acolite_relay', r.nom);
      renderHotels(state.cache[ck], r.nom);
      return;
    }catch(e){
      const cors = e instanceof TypeError || e.name === 'TypeError' || /failed to fetch|load failed|networkerror/i.test(e.message||'');
      errs.push(`${r.nom} : ${cors ? 'bloqué par le navigateur (CORS)' : e.message}`);
    }
  }
  localStorage.removeItem('acolite_relay');
  zone.innerHTML = `<p class="hint">Prix en direct indisponibles. Les comparateurs ci-dessous sont déjà pré-remplis — ou <strong>déploie ton relais gratuit</strong> (fichier <code>worker.js</code>, 2 min sur Cloudflare) et colle son URL dans <code>config.js</code> → <code>proxy</code>.
    <a href="#" id="hotRetry" style="color:var(--accent-orange);font-weight:900">Réessayer</a></p>
    <details style="margin-top:6px"><summary class="hint" style="cursor:pointer">Détail technique</summary>
      <p class="hint" style="margin-top:4px">${errs.map(esc).join('<br>')}</p></details>`;
}

function renderHotels(rows, via){
  const t = state.trip || {}, d = stayDates();
  const nights = d ? Math.max(1, Math.round((new Date(d.out) - new Date(d.in)) / 86400000)) : 1;
  const quartier = (state.cache.plan?.logement?.quartier || '').toLowerCase();
  $('#zoneHotels').innerHTML = rows.map(h => {
    const price = h.priceFrom || h.priceAvg;
    const perNight = Math.round(price / nights);
    const stars = '★'.repeat(Math.min(5, h.stars || 0));
    const near = quartier && (h.location?.name||'').toLowerCase().includes(quartier);
    const link = `https://search.hotellook.com/?destination=${encodeURIComponent(t.nom)}&checkIn=${d.in}&checkOut=${d.out}&adults=${state.prefs?.adults||2}&hotelName=${encodeURIComponent(h.hotelName||'')}`;
    return `<div class="item">
      <div class="emo">🏨</div>
      <div style="flex:1;min-width:0">
        <h4>${esc(h.hotelName||'Hôtel')} ${stars ? `<span style="color:var(--accent-orange)">${stars}</span>` : ''}</h4>
        <p>${h.location?.name ? esc(h.location.name) : ''}${near ? ' · <strong>quartier conseillé ✔</strong>' : ''}${h.stars ? ' · ' + h.stars + '★' : ''}</p>
        <a class="tl-loc" href="${esc(link)}" target="_blank" rel="noopener" style="margin-top:8px">🎫 Voir cette offre</a>
      </div>
      <div class="side">
        <span class="tag money">💶 ${perNight} €/nuit</span>
        <span class="tag">${Math.round(price)} € total</span>
      </div>
    </div>`;
  }).join('') + `<p class="hint">Prix réels agrégés (Booking, Expedia, Agoda…) pour ${nights} nuit(s), ${state.prefs?.adults||2} adulte(s)${via && via !== 'direct' ? ` · via ${esc(via)}` : ''}. Vérifie le tarif final sur le site avant de réserver.</p>`;
}

document.addEventListener('click', e => {
  if(e.target.id === 'hotRetry'){ e.preventDefault(); loadHotels(true); }
});

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

function renderPlan(d){
  const icons = {avion:'✈️', train:'🚆', voiture:'🚗'};
  const tr = d.transport||{}, lg = d.logement||{}, bd = d.budget||{};
  const qs = (d.questions||[]).filter(q=>q && q.texte);
  const A = (state.prefs?.adults||1) + (state.prefs?.kids||0);
  const dts = stayDates();
  const nuits = dts ? Math.max(1, Math.round((new Date(dts.out) - new Date(dts.in)) / 86400000)) : null;

  let html = `
    <p class="sub" style="margin:-4px 0 12px">Le voyage qu'Acolite a construit pour toi${nuits ? `, sur ${nuits} nuit(s)` : ''}${A > 1 ? `, pour ${A} personnes` : ''}. ${d._checked === 'fixed' ? '⚠️ Une seconde IA a relu le plan et corrigé des incohérences.' : d._checked ? '✔ Budget, durée et transport relus par une seconde IA.' : ''}</p>

    <h3 style="margin:0 0 10px">📋 L'essentiel</h3>
    <div class="plan-grid">
      <div class="plan-stat"><div class="k">Comment y aller</div><div class="v">${icons[tr.mode]||'✈️'} ${esc(tr.mode||'?')}</div><div class="s">${esc(tr.prix_estime||'')}</div></div>
      <div class="plan-stat"><div class="k">Où dormir</div><div class="v">🏨 ${esc(String(lg.type||'?').split('(')[0].trim().slice(0,26))}</div><div class="s">${esc(lg.quartier||'')}${lg.prix_nuit ? ' · ' + esc(String(lg.prix_nuit).replace(/\s*\/?\s*nuit/gi,'')) + '/nuit' : ''}</div></div>
      <div class="plan-stat"><div class="k">Ce que ça coûte</div><div class="v">${esc(String(bd.total||'?'))} €</div><div class="s">par personne${A > 1 && bd.total ? ` · ${bd.total * A} € au total` : ''}</div></div>
      ${state.cache._real?.mNums ? `<div class="plan-stat wx"><canvas id="wxCv" width="48" height="48"></canvas><div><div class="k">Le temps qu'il fera</div><div class="v">${esc(String(state.cache._real.mNums.min))}–${esc(String(state.cache._real.mNums.max))}°C</div><div class="s">pluie ${esc(String(state.cache._real.mNums.rain))}%</div></div></div>` : ''}
    </div>

    <div class="divider"></div>
    <h3 style="margin:0 0 10px">🧠 Pourquoi ces choix</h3>
    <div class="item" style="align-items:flex-start"><div class="emo">${icons[tr.mode]||'✈️'}</div>
      <div style="flex:1"><h4>Y aller en ${esc(tr.mode||'transport')}</h4><p>${esc(tr.pourquoi||'—')}</p>
      ${tr.details ? `<p class="hint" style="margin-top:4px">${esc(tr.details)}</p>` : ''}</div></div>
    <div class="item" style="align-items:flex-start"><div class="emo">🏨</div>
      <div style="flex:1"><h4>Dormir à ${esc(lg.quartier||'—')}</h4><p>${esc(lg.pourquoi||'—')}</p></div></div>
    ${bd.repartition ? `<div class="item" style="align-items:flex-start"><div class="emo">💶</div>
      <div style="flex:1"><h4>Le budget en détail</h4><p>${esc(bd.repartition)}</p></div></div>` : ''}
    ${d.conseil_cle ? `<div class="item" style="align-items:flex-start;background:var(--primary)"><div class="emo">💡</div>
      <div style="flex:1"><h4 style="color:#101010">Le conseil à retenir</h4><p style="color:#101010">${esc(d.conseil_cle)}</p></div></div>` : ''}

    <div class="divider"></div>
    <h3 style="margin:0 0 4px">📆 Ton programme, jour par jour</h3>
    <p class="hint" style="margin:0 0 12px">Une journée ne te convient pas ? Le bouton 🔄 la refait à elle seule (pluie, fatigue, budget…).</p>
    ${(d.programme||[]).map(jr=>`
      <div class="item" style="align-items:flex-start">
        <span class="tl-time" style="flex-shrink:0">J${esc(String(jr.jour))}</span>
        <div style="flex:1;min-width:0">
          <h4>${esc(jr.resume)}</h4>
          ${(jr.lieux||[]).length ? `<p class="hint" style="margin:3px 0 0">📍 ${jr.lieux.map(esc).join(' · ')}</p>` : ''}
        </div>
        <button class="btn sm ghost" data-planb="${esc(String(jr.jour))}" title="Refaire cette journée" style="flex-shrink:0;padding:6px 9px">🔄</button>
      </div>`).join('')}`;

  if(qs.length){
    html += `<div class="divider"></div><h3 style="margin:0 0 4px">🤔 Affine encore</h3>
      <p class="hint" style="margin:0 0 10px">Réponds et Acolite adapte le voyage.</p>`;
    qs.forEach(q=>{
      html += `<h4 style="margin:10px 0 6px;font-family:'Sora'">${esc(q.texte)}</h4>
      <div class="chips">${(q.options||[]).map(o=>`<div class="chip planq" data-q="${esc(q.texte)}" data-a="${esc(o)}">${esc(o)}</div>`).join('')}</div>`;
    });
  }

  html += `
    <div class="divider"></div>
    <h3 style="margin:0 0 4px">👉 Et maintenant ?</h3>
    <p class="hint" style="margin:0 0 4px"><strong>Réservation</strong> : tous les liens (billets, hôtels avec prix réels, activités), déjà pré-remplis.<br>
    <strong>Simulation</strong> : les vrais prix des vols et des trains, jour par jour, pour choisir le bon moment.</p>
    <div class="row" style="margin-top:14px">
      <button class="btn sm ghost" id="btnPlanRedo">🔄 Tout réorganiser</button>
      <button class="btn sm ghost" data-changedest>↩ Changer de destination</button>
    </div>`;

  $('#zonePlan').innerHTML = html;
  fitStats();
  refreshPasses();
  startWx();
}
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

/* --- Accordéons + boutons "changer de destination" (CSP stricte : aucun onclick inline) --- */
document.addEventListener('click', e => {
  const acc = e.target.closest('[data-acc]');
  if(acc){ acc.parentElement.classList.toggle('open'); return; }
  if(e.target.closest('[data-changedest]')) changeDest();
});


/* --- Pop-up Questions : réponses obligatoires avant le voyage final --- */
let _qsList = [];
function openQsPopup(qs){
  _qsList = qs.slice(0, 3);
  const pg = $('#qsProg');
  if(pg) pg.innerHTML = _qsList.map(() => '<i></i>').join('');
  $('#zoneQs').innerHTML = _qsList.map((q, i) => `
    <h4 style="margin:14px 0 6px;font-family:'Sora'">${i+1}. ${esc(q.texte)}</h4>
    <div class="chips" data-qi="${i}">${(q.options||[]).map(o=>`<div class="chip qsopt" data-qi="${i}" data-a="${esc(o)}">${esc(o)}</div>`).join('')}</div>`).join('');
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
  if(e.target.id === 'btnPlanRedo'){ loadPlan(true); return; }
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
    <div class="bud-bar">${(d.postes||[]).map((p,i)=>`<i style="width:${(+p.montant/sum*100).toFixed(1)}%;background:${BUD_COLORS[i%BUD_COLORS.length]}"></i>`).join('')}</div>
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
  const est = (state.cache.plan?.budget?.total || 0) * A || state.cache.bud?.total_estime || 0;
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
   INFOS UTILES (light → Groq)
============================================================ */
async function loadInfo(){
  const zone = $('#zoneInfo');
  if(state.cache.info){ renderInfo(state.cache.info, state.cache.infoVia); return; }
  zone.innerHTML = loaderHTML('Vérification des formalités…');
  const t = state.trip;
  const prompt = `Tu es Acolite. Un voyageur FRANÇAIS part à ${t.nom} (${t.pays}). ${ctx()}
Réponds UNIQUEMENT en JSON :
{
 "formalites":"papiers nécessaires pour un français : CNI/passeport, visa oui/non, validité requise — 1-2 phrases",
 "sante":"vaccins recommandés, eau du robinet potable ou non, précautions — 1-2 phrases",
 "securite":"niveau général, arnaques classiques à touristes, quartiers à éviter — 2 phrases",
 "argent":"monnaie, taux approximatif vs euro, paiement carte accepté ?, pourboire local — 2 phrases",
 "electricite":"type de prise, adaptateur nécessaire pour un français ?",
 "telephone":"le forfait FR fonctionne-t-il ? roaming/eSIM conseillé ?",
 "urgences":"numéros d'urgence locaux (police, ambulance) + '112 si UE'",
 "meilleur_moment":"meilleure période de l'année pour visiter, en 1 phrase"
}`;
  try{
    const {data, via} = await ai('light', prompt);
    state.cache.info = data; state.cache.infoVia = via; save();
    renderInfo(data, via);
  }catch(e){ if(e.message!=='NO_KEY') zone.innerHTML = errHTML('Chargement impossible.'); }
}
function renderInfo(d, via){
  $('#infoBadge').style.display = via==='groq' ? '' : 'none';
  const rows = [
    ['🛂','Formalités', d.formalites], ['💉','Santé', d.sante], ['🛡️','Sécurité', d.securite],
    ['💱','Argent', d.argent], ['🔌','Électricité', d.electricite], ['📱','Téléphone', d.telephone],
    ['🚨','Urgences', d.urgences], ['📅','Meilleur moment', d.meilleur_moment]
  ];
  $('#zoneInfo').innerHTML = rows.filter(r=>r[2]).map(r=>`
    <div class="item"><div class="emo">${r[0]}</div><div><h4>${r[1]}</h4><p>${esc(r[2])}</p></div></div>`).join('');
}


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
  try{
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(t.nom)}&count=1&language=fr`);
    const d = await r.json();
    const g = d.results?.[0];
    if(g){ state._geo = g; return g; }
  }catch(e){}
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
const setUser = u => localStorage.setItem(LS_USER, JSON.stringify(u));

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

async function issueCode(u){
  const code = String(Math.floor(100000 + Math.random()*900000));
  u.codeH = await sha('code::' + code);
  u.codeAt = Date.now();
  u.tries = 0;
  delete u.code; /* plus jamais de code en clair dans le stockage */
  setUser(u);
  return code;
}

async function sendVerifyEmail(email, code){
  const ej = CFG.emailjs || {};
  if(ej.publicKey && ej.serviceId && ej.templateId){
    try{
      const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          service_id: ej.serviceId, template_id: ej.templateId, user_id: ej.publicKey,
          template_params: { to_email: email, code: code }
        })
      });
      if(r.ok){ $('#vfDemo').textContent = ''; toast('📬 Code envoyé à ' + email); return true; }
    }catch(e){}
    toast('⚠️ Envoi email échoué — mode démo activé');
  }
  /* Mode démo : pas de service email configuré → code affiché */
  $('#vfDemo').textContent = '🧪 Mode démo (EmailJS non configuré dans config.js) — ton code : ' + code;
  return false;
}

const _e17 = $('#goLogin'); if(_e17) _e17.onclick  = () => authShow('authLogin');
const _e18 = $('#goSignup'); if(_e18) _e18.onclick = () => authShow('authSignup');
const _e19 = $('#vfBack'); if(_e19) _e19.onclick   = () => { localStorage.removeItem(LS_USER); authShow('authSignup'); };

const _e20 = $('#btnSignup'); if(_e20) _e20.onclick = async () => {
  const email = $('#auEmail').value.trim().toLowerCase();
  const pseudo = $('#auPseudo').value.trim();
  const p1 = $('#auPass').value, p2 = $('#auPass2').value;
  if(!pseudo) return authErr('Choisis un pseudo.');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return authErr('Adresse email invalide.');
  if(p1.length < 8) return authErr('Mot de passe : 8 caractères minimum.');
  if(p1 !== p2) return authErr('Les deux mots de passe ne correspondent pas.');
  const u = { email, pseudo, hash: await sha(email + '::' + p1), verified:false, created: Date.now() };
  const code = await issueCode(u);
  $('#vfEmail').textContent = email;
  authShow('authVerify');
  sendVerifyEmail(email, code);
};

const _e21 = $('#btnResend'); if(_e21) _e21.onclick = async () => {
  const u = getUser(); if(!u) return;
  const code = await issueCode(u);
  sendVerifyEmail(u.email, code);
};

const _e22 = $('#btnVerify'); if(_e22) _e22.onclick = async () => {
  const u = getUser(); if(!u) return;
  if(u.codeAt && Date.now() - u.codeAt > 15*60*1000)
    return authErr('Code expiré (15 min) — clique sur "Renvoyer le code".');
  const input = $('#vfCode').value.trim();
  const okPlain = u.code && input === u.code; /* compat anciens comptes */
  const okHash  = u.codeH && (await sha('code::' + input)) === u.codeH;
  if(!okPlain && !okHash){
    u.tries = (u.tries||0) + 1; setUser(u);
    if(u.tries >= 5){ u.codeH = null; u.code = null; setUser(u); return authErr('Trop d\'essais — code invalidé. Clique sur "Renvoyer le code".'); }
    return authErr(`Code incorrect (${5 - u.tries} essai${5-u.tries>1?'s':''} restant) — vérifie tes emails et les spams.`);
  }
  u.verified = true; delete u.code; delete u.codeH; delete u.tries; delete u.codeAt; setUser(u);
  localStorage.setItem(LS_AUTH, '1');
  authErr('');
  enterApp();
  toast('Compte vérifié — bienvenue ! 🎉');
};

const _e23 = $('#btnLogin'); if(_e23) _e23.onclick = async () => {
  const u = getUser();
  const email = $('#loEmail').value.trim().toLowerCase();
  if(!u || u.email !== email) return authErr('Aucun compte avec cet email sur cet appareil.');
  if(await sha(email + '::' + $('#loPass').value) !== u.hash) return authErr('Mot de passe incorrect.');
  if(!u.verified){
    const code = await issueCode(u);
    $('#vfEmail').textContent = u.email; authShow('authVerify'); sendVerifyEmail(u.email, code);
    return;
  }
  localStorage.setItem(LS_AUTH, '1');
  enterApp();
  toast('Re-bonjour ' + email.split('@')[0] + ' 👋');
};

function enterApp(){ $('#authWrap').classList.add('hidden'); renderProfile(); }
function requireAuth(){
  const u = getUser();
  if(u && u.verified && localStorage.getItem(LS_AUTH) === '1'){ enterApp(); return; }
  $('#authWrap').classList.remove('hidden');
  if(!u) authShow('authSignup');
  else if(!u.verified){ $('#vfEmail').textContent = u.email; authShow('authVerify'); }
  else authShow('authLogin');
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
  if(cat === 'profile') renderProfile();
}
$$('.catnav button').forEach(b => b.onclick = () => switchCat(b.dataset.cat));

/* --- Carte du projet : ligne de rectangles (chemins) + carte plein cadre --- */
function projRoute(saddr, stops, walk){
  const daddr = stops.map(encodeURIComponent).join('+to:');
  $('#projMap').src = `https://maps.google.com/maps?saddr=${encodeURIComponent(saddr)}&daddr=${daddr}${walk?'&dirflg=w':''}&hl=fr&output=embed`;
}

function buildProjectMap(){
  const t = state.trip, p = state.prefs || {}, c = state.cache;
  const strip = $('#zoneProjRoutes');
  if(!t){
    strip.innerHTML = '';
    /* pas de voyage → carte centrée sur la position de l'utilisateur */
    $('#projMap').src = `https://maps.google.com/maps?q=Europe&hl=fr&z=4&output=embed`;
    if(navigator.geolocation){
      navigator.geolocation.getCurrentPosition(
        pos => { $('#projMap').src = `https://maps.google.com/maps?q=${pos.coords.latitude},${pos.coords.longitude}&hl=fr&z=13&output=embed`; },
        () => {}, { timeout: 6000 }
      );
    }
    return;
  }
  const routes = [];
  routes.push({ label:`${({plane:'✈️',train:'🚆',car:'🚗'})[state.mode]||'🚗'} Aller`,
                saddr: p.from || 'Paris', stops:[`${t.nom}, ${t.pays}`], walk:false });
  const base = c.plan?.logement?.quartier ? `${c.plan.logement.quartier}, ${t.nom}` : `${t.nom}, ${t.pays}`;
  const days = (c.fullPlan?.jours?.length)
    ? c.fullPlan.jours.map(j => ({ jour:j.jour, lieux:(j.etapes||[]).map(e=>e.lieu) }))
    : (c.plan?.programme||[]).map(p => ({ jour:p.jour, lieux:p.lieux||[] }));
  days.forEach(j => {
    const lieux = (j.lieux||[]).filter(Boolean).map(l=>`${l}, ${t.nom}`).slice(0,8);
    if(lieux.length) routes.push({ label:`🗓️ Jour ${j.jour}`, saddr: base, stops: lieux, walk:true });
  });
  window._projRoutes = routes;
  strip.innerHTML = routes.map((r,i)=>`<span class="rt ${i===0?'on':''}" data-projroute="${i}">${esc(r.label)}</span>`).join('')
    + `<a class="rt" id="projOpen" href="#" target="_blank" rel="noopener">↗ Maps</a>`;
  const r0 = routes[0];
  projRoute(r0.saddr, r0.stops, r0.walk);
  updateProjOpen(r0);
}
function updateProjOpen(r){
  const a = $('#projOpen');
  if(a) a.href = 'https://www.google.com/maps/dir/' + [r.saddr, ...r.stops].map(encodeURIComponent).join('/');
}
document.addEventListener('click', e => {
  const rt = e.target.closest('[data-projroute]');
  if(!rt) return;
  $$('#zoneProjRoutes .rt').forEach(x=>x.classList.remove('on'));
  rt.classList.add('on');
  const r = (window._projRoutes||[])[+rt.dataset.projroute];
  if(r){ projRoute(r.saddr, r.stops, r.walk); updateProjOpen(r); }
});

/* --- Profil : infos + stats + paramètres --- */
function renderProfile(){
  const u = getUser(); if(!u) return;
  const pseudo = u.pseudo || u.email.split('@')[0];
  $('#pfAvatar').textContent = pseudo;
  $('#pfEmail').innerHTML = `${esc(pseudo)} <span style="cursor:pointer;font-size:.9rem" id="pfEditPseudo" title="Changer de pseudo">✏️</span>`;
  $('#pfMeta').innerHTML = `${esc(u.email)} · ${u.verified ? '✅ vérifié' : '⚠️ non vérifié'} · membre depuis le ${new Date(u.created).toLocaleDateString('fr-FR')}`;
  const _e24 = $('#pfEditPseudo'); if(_e24) _e24.onclick = () => {
    const np = prompt('Ton nouveau pseudo :', pseudo);
    if(np && np.trim()){ u.pseudo = np.trim().slice(0,20); setUser(u); renderProfile(); toast('Pseudo mis à jour ✔'); }
  };
}
const _e25 = $('#pfExport'); if(_e25) _e25.onclick = () => $('#btnExport').click();
const _e26 = $('#pfNewTrip'); if(_e26) _e26.onclick = () => $('#btnReset').click();
const _e27 = $('#pfLogout'); if(_e27) _e27.onclick = () => {
  localStorage.removeItem(LS_AUTH);
  toast('À bientôt 👋');
  requireAuth();
};
const LS_THEME = 'acolite_theme';
function applyTheme(){
  const dark = localStorage.getItem(LS_THEME) === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const m = document.createElement('meta');
  m.name = 'theme-color';
  m.content = dark ? '#0B0B10' : '#FFE600';
  document.head.appendChild(m);
}
const _e28 = $('#pfTheme'); if(_e28) _e28.onclick = () => {
  const cur = localStorage.getItem(LS_THEME) === 'dark' ? '' : 'dark';
  cur ? localStorage.setItem(LS_THEME, cur) : localStorage.removeItem(LS_THEME);
  applyTheme();
  toast(cur ? '🌙 Vol de nuit activé' : '☀️ Retour au jour');
};
applyTheme();

const _e29 = $('#pfChangePass'); if(_e29) _e29.onclick = async () => {
  const u = getUser(); if(!u) return;
  const cur = prompt('Mot de passe actuel :'); if(cur === null) return;
  if(await sha(u.email + '::' + cur) !== u.hash){ toast('❌ Mot de passe actuel incorrect'); return; }
  const np = prompt('Nouveau mot de passe (8 caractères minimum) :'); if(np === null) return;
  if(np.length < 8){ toast('❌ 8 caractères minimum'); return; }
  u.hash = await sha(u.email + '::' + np); setUser(u);
  toast('🔑 Mot de passe changé ✔');
};

const _e30 = $('#pfChangeEmail'); if(_e30) _e30.onclick = async () => {
  const u = getUser(); if(!u) return;
  const ne = (prompt('Nouvelle adresse email :') || '').trim().toLowerCase();
  if(!ne) return;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ne)){ toast('❌ Email invalide'); return; }
  const pw = prompt('Confirme ton mot de passe :'); if(pw === null) return;
  if(await sha(u.email + '::' + pw) !== u.hash){ toast('❌ Mot de passe incorrect'); return; }
  u.email = ne;
  u.hash = await sha(ne + '::' + pw);
  u.verified = false;
  const code = await issueCode(u);
  localStorage.removeItem(LS_AUTH);
  $('#vfEmail').textContent = ne;
  sendVerifyEmail(ne, code);
  requireAuth();
  toast('📧 Vérifie ta nouvelle adresse');
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

const _e33 = $('#pfDelete'); if(_e33) _e33.onclick = () => {
  if(!confirm('Supprimer définitivement ton compte et toutes tes données locales ?')) return;
  localStorage.removeItem(LS_USER); localStorage.removeItem(LS_AUTH); localStorage.removeItem(LS_TRIP);
  location.reload();
};

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
  const fit = (txt, size, max, weight = '700', fam = 'Inter, Arial') => {
    let px = size;
    do { g.font = `${weight} ${px}px ${fam}`; px -= 1; } while(g.measureText(txt).width > max && px > 9);
    return g.font;
  };
  /* fond + ombre dure */
  g.fillStyle = P; g.fillRect(0, 0, W, H);
  g.fillStyle = K; g.fillRect(M + 12, M + 12, CW, CH);
  /* corps jaune + talon blanc */
  g.fillStyle = Y; g.fillRect(M, M, CW - STUB, CH);
  g.fillStyle = WH; g.fillRect(M + CW - STUB, M, STUB, CH);
  g.strokeStyle = K; g.lineWidth = 7; g.strokeRect(M, M, CW, CH);
  /* perforation entre corps et talon */
  const px0 = M + CW - STUB;
  g.setLineDash([12, 9]); g.lineWidth = 4;
  g.beginPath(); g.moveTo(px0, M + 26); g.lineTo(px0, M + CH - 26); g.stroke();
  g.setLineDash([]);
  g.fillStyle = P;
  [M, M + CH].forEach(cy => { g.beginPath(); g.arc(px0, cy, 15, 0, 7); g.fill(); g.lineWidth = 5; g.strokeStyle = K; g.stroke(); });

  /* ---- CORPS ---- */
  g.fillStyle = K;
  g.font = '900 26px Sora, Arial';
  g.fillText('ACOLITE · BOARDING PASS', M + 34, M + 54);
  g.fillRect(M + 34, M + 66, 420, 5);
  /* route */
  const from = (p.from || 'PAR').slice(0, 3).toUpperCase();
  const to = (t.iata || t.nom.slice(0, 3)).toUpperCase();
  g.font = '900 82px Sora, Arial';
  g.fillText(from, M + 34, M + 158);
  const wFrom = g.measureText(from).width;
  const toX = M + 34 + wFrom + 190;
  g.fillText(to, toX, M + 158);
  /* trait pointillé + avion */
  g.setLineDash([13, 9]); g.lineWidth = 5;
  g.beginPath(); g.moveTo(M + 48 + wFrom, M + 132); g.lineTo(toX - 20, M + 132); g.stroke();
  g.setLineDash([]);
  g.font = '900 44px Arial';
  g.fillText('✈', M + 48 + wFrom + (toX - 20 - (M + 48 + wFrom)) / 2 - 22, M + 146);
  /* infos, chacune redimensionnée pour ne jamais déborder */
  const infoW = CW - STUB - 68;
  const rows = [
    ['PASSAGER', `${(u?.pseudo || 'VOYAGEUR').toUpperCase()} · ${p.adults || 2} ADULTE(S)${p.kids ? ` + ${p.kids} ENFANT(S)` : ''}`],
    ['DESTINATION', `${t.nom}, ${t.pays}`.toUpperCase()],
    ['DATES', d ? `${d.in} → ${d.out}` : (p.days || p.when || 'FLEXIBLES').toUpperCase()],
    ['SÉJOUR', [plan.transport?.mode, plan.logement ? String(plan.logement.type || '').split('(')[0].trim() : '', plan.logement?.quartier].filter(Boolean).join(' · ').toUpperCase() || (p.days || '').toUpperCase()],
    ['BUDGET', plan.budget?.total ? `${plan.budget.total} € / PERSONNE` : (t.budget_estime || '—').toUpperCase()]
  ];
  rows.forEach((r, i) => {
    const y = M + 212 + i * 46;
    g.font = '800 15px Sora, Arial';
    g.fillText(r[0], M + 34, y);
    g.font = fit(r[1], 24, infoW - 130, '700');
    g.fillText(r[1], M + 164, y);
  });
  /* mentions bas de carte */
  g.font = '600 14px Inter, Arial';
  g.fillText("Ticket souvenir généré par Acolite — ne permet PAS d'embarquer ni de voyager.", M + 34, M + CH - 38);
  g.fillText("Le QR sert uniquement à importer ce voyage dans l'application Acolite.", M + 34, M + CH - 18);

  /* ---- TALON : QR ---- */
  const sx = px0 + STUB / 2;
  let qrOK = false;
  try{
    await loadQRGen();
    const tmp = document.createElement('div');
    new QRCode(tmp, { text: tripPayload(), width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
    await new Promise(r => setTimeout(r, 80));
    const q = tmp.querySelector('canvas') || tmp.querySelector('img');
    if(q){
      g.drawImage(q, sx - 90, M + 76, 180, 180);
      g.strokeStyle = K; g.lineWidth = 4;
      g.strokeRect(sx - 96, M + 70, 192, 192);
      qrOK = true;
    }
  }catch(e){}
  if(!qrOK){
    g.fillStyle = K;
    let x = sx - 90; while(x < sx + 90){ const w2 = 4 + Math.floor(Math.random() * 9); g.fillRect(x, M + 90, w2, 150); x += w2 + 6; }
  }
  g.fillStyle = K;
  g.textAlign = 'center';
  g.font = '900 15px Sora, Arial';
  g.fillText('SCANNE-MOI', sx, M + 292);
  g.font = '800 12px Inter, Arial';
  g.fillText('dans l\'application Acolite', sx, M + 312);
  g.fillText('pour importer ce voyage', sx, M + 330);
  /* route + code-barres décoratif sur le talon */
  g.font = fit(`${from} ✈ ${to}`, 30, STUB - 50, '900', 'Sora, Arial');
  g.fillText(`${from} ✈ ${to}`, sx, M + 380);
  let bx = sx - 100;
  while(bx < sx + 100){ const w2 = 3 + Math.floor(Math.random() * 7); g.fillRect(bx, M + 400, w2, 46); bx += w2 + 5; }
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
}
unlockSteps();
if(state.lastProps) renderDestinations(state.lastProps);
if(state.step > 1) gotoStep(Math.min(state.step, 3));
requireAuth();

/* app.js est arrivé au bout : le vérificateur de démarrage ne déclenchera pas d'alerte */
if(window.__ACOLITE) window.__ACOLITE.loaded = true;
