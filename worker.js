/* ============================================================
   ACOLITE — Backend (Cloudflare Worker, 100 % gratuit)
   ============================================================
   RÔLE : garder tes clés API SECRÈTES.
   Le navigateur n'envoie AUCUNE clé : il parle à ce Worker,
   et c'est le Worker qui contacte Gemini / Groq / Hotellook
   avec les clés stockées côté serveur.

   Il sert aussi de relais CORS (Hotellook ne l'envoie pas).

   ── DÉPLOIEMENT (5 min, sans carte bancaire) ────────────────
   1. https://dash.cloudflare.com → compte gratuit
   2. Workers & Pages → Create → Create Worker → Deploy
   3. Edit code → colle CE fichier → Deploy
   4. Onglet Settings → Variables and Secrets → Add :
        GEMINI_KEY        = ta clé AIza… (aistudio.google.com/apikey)
        GROQ_KEY          = ta clé gsk_…
        TRAVELPAYOUTS_KEY = ton token
        ALLOWED_ORIGIN    = https://lechat45.github.io   (ton site)
      → coche "Encrypt" pour chaque clé, puis Deploy
   5. Copie l'URL du Worker et colle-la dans config.js → proxy
   6. VIDE les clés de config.js : elles ne servent plus !

   100 000 requêtes/jour gratuites.
============================================================ */

const RELAY_HOSTS = ['engine.hotellook.com', 'yasen.hotellook.com', 'api.travelpayouts.com'];

/* ============================================================
   LIMITATION DE DÉBIT — protège TES quotas d'API
   Quelqu'un qui trouverait l'URL du Worker ne peut pas le vider :
   au-delà de la limite, il reçoit un 429.
   (Compteur en mémoire : suffisant ici, réinitialisé au redémarrage
   de l'isolat. Pour du strict, brancher Cloudflare KV.)
============================================================ */
const LIMITS = { ia: 30, hotels: 60, fenetreMs: 60_000 };   /* par IP et par minute */
const hits = new Map();

function rateLimited(ip, bucket) {
  const now = Date.now();
  const key = bucket + ':' + ip;
  const rec = hits.get(key) || { n: 0, t: now };
  if (now - rec.t > LIMITS.fenetreMs) { rec.n = 0; rec.t = now; }
  rec.n++;
  hits.set(key, rec);
  if (hits.size > 5000) hits.clear();                        /* garde-fou mémoire */
  return rec.n > (LIMITS[bucket] || 60);
}

/* Jeton OpenSky (OAuth2 client credentials), gardé ~25 min en mémoire */
let _osTok = { t: 0, v: null };
async function OPENSKY_TOKEN(env) {
  if (_osTok.v && Date.now() - _osTok.t < 25 * 60 * 1000) return _osTok.v;
  try {
    const r = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.OPENSKY_ID,
        client_secret: env.OPENSKY_SECRET,
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    _osTok = { t: Date.now(), v: d.access_token };
    return d.access_token;
  } catch (e) { return null; }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';
    /* n'autorise que TON site (ou tout le monde si non configuré) */
    const okOrigin = allowed === '*' || origin === allowed || origin.startsWith('http://localhost');
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? (origin || '*') : allowed,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!okOrigin) return json({ error: 'Origine non autorisée' }, 403);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const ip = request.headers.get('CF-Connecting-IP') || 'inconnu';

    try {
      /* ---- Ce que le Worker sait faire (le front l'interroge au démarrage) ---- */
      if (path === '/capabilities') {
        return json({
          gemini: !!env.GEMINI_KEY,
          groq: !!env.GROQ_KEY,
          travelpayouts: !!env.TRAVELPAYOUTS_KEY,
          opensky: !!(env.OPENSKY_ID && env.OPENSKY_SECRET),
          metar: true,
        });
      }

      /* ---- Liste des modèles Gemini disponibles ---- */
      if (path === '/gemini/models') {
        if (!env.GEMINI_KEY) return json({ error: 'GEMINI_KEY non configurée' }, 501);
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_KEY}&pageSize=100`);
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      /* ---- Génération Gemini : POST {model, body} ---- */
      if (path === '/gemini') {
        if (!env.GEMINI_KEY) return json({ error: 'GEMINI_KEY non configurée' }, 501);
        if (rateLimited(ip, 'ia')) return json({ error: 'Trop de requêtes — réessaie dans une minute' }, 429);
        const { model, body } = await request.json();
        const m = String(model || 'gemini-2.5-flash').replace(/[^a-zA-Z0-9.\-_]/g, '');
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env.GEMINI_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        );
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      /* ---- Génération Groq : POST {body} ---- */
      if (path === '/groq') {
        if (!env.GROQ_KEY) return json({ error: 'GROQ_KEY non configurée' }, 501);
        if (rateLimited(ip, 'ia')) return json({ error: 'Trop de requêtes — réessaie dans une minute' }, 429);
        const { body } = await request.json();
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_KEY}` },
          body: JSON.stringify(body),
        });
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      /* ---- Prix d'hôtels : le token est injecté ICI, jamais dans le navigateur ---- */
      if (path === '/hotels') {
        if (!env.TRAVELPAYOUTS_KEY) return json({ error: 'TRAVELPAYOUTS_KEY non configurée' }, 501);
        if (rateLimited(ip, 'hotels')) return json({ error: 'Trop de requêtes — réessaie dans une minute' }, 429);
        const p = url.searchParams;
        const api = new URL('https://engine.hotellook.com/api/v2/cache.json');
        ['location', 'checkIn', 'checkOut', 'adults', 'children', 'currency', 'limit'].forEach(k => {
          if (p.get(k)) api.searchParams.set(k, p.get(k));
        });
        api.searchParams.set('token', env.TRAVELPAYOUTS_KEY);
        const r = await fetch(api.toString(), {
          headers: { Accept: 'application/json' },
          cf: { cacheTtl: 600, cacheEverything: true },
        });
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      /* ---- MÉTÉO AÉRONAUTIQUE (METAR/TAF) — NOAA, 100 % gratuit, sans clé ----
         Sert à estimer un RISQUE DE RETARD : vent, visibilité, orages, neige. */
      if (path === '/metar') {
        if (rateLimited(ip, 'hotels')) return json({ error: 'Trop de requêtes' }, 429);
        const ids = (url.searchParams.get('ids') || '').replace(/[^A-Za-z0-9,]/g, '').slice(0, 40);
        if (!ids) return json({ error: 'Paramètre ?ids= manquant (code OACI, ex LFPG)' }, 400);
        const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${ids}&format=json&taf=false`, {
          headers: { Accept: 'application/json' },
          cf: { cacheTtl: 300, cacheEverything: true },
        });
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      /* ---- SUIVI DE VOL EN DIRECT — OpenSky Network (gratuit, non commercial)
         ⚠️ Nécessite OPENSKY_ID et OPENSKY_SECRET dans les secrets du Worker.
         Donne la position réelle de l'avion (ADS-B). PAS les retards ni les portes :
         OpenSky ne fournit aucune donnée commerciale. */
      if (path === '/flight') {
        if (!env.OPENSKY_ID || !env.OPENSKY_SECRET) return json({ error: 'OPENSKY non configuré' }, 501);
        if (rateLimited(ip, 'ia')) return json({ error: 'Trop de requêtes' }, 429);
        const cs = (url.searchParams.get('callsign') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        if (!cs) return json({ error: 'Paramètre ?callsign= manquant' }, 400);

        /* jeton OAuth2, mis en cache ~25 min */
        let token = await OPENSKY_TOKEN(env);
        if (!token) return json({ error: 'Authentification OpenSky impossible' }, 502);

        const r = await fetch('https://opensky-network.org/api/states/all', {
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          cf: { cacheTtl: 20, cacheEverything: true },
        });
        if (!r.ok) return json({ error: 'OpenSky : ' + r.status }, r.status);
        const data = await r.json();
        const row = (data.states || []).find(s => (s[1] || '').trim().toUpperCase() === cs);
        if (!row) return json({ found: false, message: "Avion non détecté : il est au sol, hors couverture, ou n'a pas décollé." });
        return json({
          found: true,
          callsign: cs,
          pays: row[2],
          lon: row[5], lat: row[6],
          altitude_m: row[13] ?? row[7],
          vitesse_kmh: row[9] ? Math.round(row[9] * 3.6) : null,
          cap: row[10],
          au_sol: row[8],
          montee_ms: row[11],
          vu_il_y_a_s: data.time && row[4] ? data.time - row[4] : null
        });
      }

      /* ---- Relais CORS générique (compat : ?url=…) ---- */
      const target = url.searchParams.get('url');
      if (target) {
        let u;
        try { u = new URL(target); } catch { return json({ error: 'URL invalide' }, 400); }
        if (!RELAY_HOSTS.includes(u.hostname)) return json({ error: 'Domaine non autorisé : ' + u.hostname }, 403);
        const r = await fetch(u.toString(), {
          headers: { Accept: 'application/json' },
          cf: { cacheTtl: 600, cacheEverything: true },
        });
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }

      return json({ error: 'Route inconnue', routes: ['/capabilities', '/gemini', '/gemini/models', '/groq', '/hotels', '/metar', '/flight', '/?url='] }, 404);
    } catch (e) {
      return json({ error: 'Worker : ' + e.message }, 502);
    }
  },
};
