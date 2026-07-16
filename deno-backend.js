/* ============================================================
   ACOLITE — Backend (Deno Deploy, 100 % gratuit)
   ============================================================
   RÔLE : garder tes clés API SECRÈTES (même rôle que worker.js,
   mais hébergé sur Deno Deploy au lieu de Cloudflare).

   ── DÉPLOIEMENT (5 min, sans carte bancaire) ────────────────
   1. https://dash.deno.com → connexion avec ton compte GitHub
   2. New Playground → colle CE fichier → Save & Deploy (Ctrl+S)
   3. Menu du projet → Settings :
        · renomme le projet (ex : acolite) → l'URL devient
          https://acolite.deno.dev
        · Environment Variables → Add Variable :
            GEMINI_KEY        = ta clé AIza… (aistudio.google.com/apikey)
            GROQ_KEY          = ta clé gsk_…
            TRAVELPAYOUTS_KEY = ton token
            ALLOWED_ORIGIN    = https://lechat45.github.io
   4. Copie l'URL du projet dans config.js → proxy
   5. VIDE les clés de config.js : elles ne servent plus !

   Gratuit : 1 000 000 requêtes / mois.
============================================================ */

const RELAY_HOSTS = ['engine.hotellook.com', 'yasen.hotellook.com', 'api.travelpayouts.com'];

Deno.serve(async (request) => {
  const env = (k) => Deno.env.get(k) || '';
  const origin = request.headers.get('Origin') || '';
  const allowed = env('ALLOWED_ORIGIN') || '*';
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

  try {
    /* ---- Ce que le backend sait faire (le front l'interroge au démarrage) ---- */
    if (path === '/capabilities') {
      return json({
        gemini: !!env('GEMINI_KEY'),
        groq: !!env('GROQ_KEY'),
        travelpayouts: !!env('TRAVELPAYOUTS_KEY'),
      });
    }

    /* ---- Liste des modèles Gemini disponibles ---- */
    if (path === '/gemini/models') {
      if (!env('GEMINI_KEY')) return json({ error: 'GEMINI_KEY non configurée' }, 501);
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${env('GEMINI_KEY')}&pageSize=100`);
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---- Génération Gemini : POST {model, body} ---- */
    if (path === '/gemini') {
      if (!env('GEMINI_KEY')) return json({ error: 'GEMINI_KEY non configurée' }, 501);
      const { model, body } = await request.json();
      const m = String(model || 'gemini-2.5-flash').replace(/[^a-zA-Z0-9.\-_]/g, '');
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${env('GEMINI_KEY')}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---- Génération Groq : POST {body} ---- */
    if (path === '/groq') {
      if (!env('GROQ_KEY')) return json({ error: 'GROQ_KEY non configurée' }, 501);
      const { body } = await request.json();
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env('GROQ_KEY')}` },
        body: JSON.stringify(body),
      });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---- Prix d'hôtels : le token est injecté ICI, jamais dans le navigateur ---- */
    if (path === '/hotels') {
      if (!env('TRAVELPAYOUTS_KEY')) return json({ error: 'TRAVELPAYOUTS_KEY non configurée' }, 501);
      const p = url.searchParams;
      const api = new URL('https://engine.hotellook.com/api/v2/cache.json');
      ['location', 'checkIn', 'checkOut', 'adults', 'children', 'currency', 'limit'].forEach(k => {
        if (p.get(k)) api.searchParams.set(k, p.get(k));
      });
      api.searchParams.set('token', env('TRAVELPAYOUTS_KEY'));
      const r = await fetch(api.toString(), { headers: { Accept: 'application/json' } });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    /* ---- Relais CORS générique (compat : ?url=…) ---- */
    const target = url.searchParams.get('url');
    if (target) {
      let u;
      try { u = new URL(target); } catch { return json({ error: 'URL invalide' }, 400); }
      if (!RELAY_HOSTS.includes(u.hostname)) return json({ error: 'Domaine non autorisé : ' + u.hostname }, 403);
      const r = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
      return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return json({ error: 'Route inconnue', routes: ['/capabilities', '/gemini', '/gemini/models', '/groq', '/hotels', '/?url='] }, 404);
  } catch (e) {
    return json({ error: 'Backend : ' + e.message }, 502);
  }
});
