/* ============================================================
   Acolite — Panel admin (page autonome, hors application).

   La sécurité NE REPOSE PAS sur ce fichier : il se contente d'afficher ce
   que le serveur veut bien lui donner. C'est le backend qui vérifie que la
   session correspond à ADMIN_EMAIL, et qui ne renvoie QUE des nombres déjà
   agrégés. Deviner l'adresse de cette page ne donne donc accès à rien.

   Script externe (et non en ligne) : la CSP du site interdit les scripts
   en ligne — on ne l'affaiblit pas pour un panel d'administration.
============================================================ */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function show(kind, titre, texte) {
    var el = $('#state');
    el.className = 'msg' + (kind === 'err' ? ' err' : '');
    el.innerHTML = '<h2>' + esc(titre) + '</h2><p>' + esc(texte) + '</p>';
    el.classList.remove('hidden');
    $('#panel').classList.add('hidden');
  }

  function token() {
    try { return localStorage.getItem('acolite_token') || ''; } catch (e) { return ''; }
  }

  function bar(n, max) {
    var pct = max > 0 ? Math.round((n / max) * 100) : 0;
    return '<span class="bar"><i style="width:' + pct + '%"></i></span>';
  }

  function render(d) {
    var c = d.comptes || {}, v = d.voyages || {}, t = d.transports || {};
    var dests = d.destinations || [], mask = d.destinationsMasquees || {}, jeu = d.jeu || [];
    var maxDest = dests.reduce(function (m, x) { return Math.max(m, x.n); }, 0);
    var maxMode = Math.max(t.avion || 0, t.train || 0, t.voiture || 0, t.autre || 0);

    var html = ''
      + '<div class="grid">'
      + '<div class="stat"><div class="k">Comptes</div><div class="v">' + (c.total || 0) + '</div></div>'
      + '<div class="stat"><div class="k">Vérifiés</div><div class="v">' + (c.verifies || 0) + '</div></div>'
      + '<div class="stat"><div class="k">Nouveaux · 7 j</div><div class="v">' + (c.nouveaux7j || 0) + '</div></div>'
      + '<div class="stat"><div class="k">Nouveaux · 30 j</div><div class="v">' + (c.nouveaux30j || 0) + '</div></div>'
      + '<div class="stat"><div class="k">Voyages</div><div class="v">' + (v.total || 0) + '</div></div>'
      + '<div class="stat"><div class="k">Avec un plan</div><div class="v">' + (v.avecPlan || 0) + '</div></div>'
      + '</div>';

    html += '<div class="card"><h2>🌍 Destinations</h2>';
    if (dests.length) {
      html += dests.map(function (x) {
        return '<div class="row"><span>' + esc(x.nom) + '</span>' + bar(x.n, maxDest) + '<span class="n">' + x.n + '</span></div>';
      }).join('');
    } else {
      html += '<p class="note">Aucune destination n\'atteint encore le seuil d\'affichage.</p>';
    }
    if (mask.lieux) {
      html += '<div class="row"><span><em>Autres destinations (masquées)</em></span><span class="n">'
            + mask.voyages + ' voyage(s) · ' + mask.lieux + ' lieu(x)</span></div>';
    }
    html += '<p class="note">🔒 Une destination comptant moins de ' + (d.seuil || 5)
          + ' voyages n\'est jamais nommée : avec peu d\'utilisateurs, elle désignerait quelqu\'un.</p></div>';

    html += '<div class="card"><h2>🚆 Transports choisis</h2>'
      + ['avion', 'train', 'voiture', 'autre'].map(function (k) {
          var ico = { avion: '✈️', train: '🚆', voiture: '🚗', autre: '❓' }[k];
          return '<div class="row"><span>' + ico + ' ' + k + '</span>' + bar(t[k] || 0, maxMode)
               + '<span class="n">' + (t[k] || 0) + '</span></div>';
        }).join('')
      + '</div>';

    if (jeu.length) {
      html += '<div class="card"><h2>🏆 Classement du jeu</h2>'
        + jeu.map(function (s, i) {
            return '<div class="row"><span>' + (i + 1) + '. ' + esc(s.name) + '</span><span class="n">' + s.score + '</span></div>';
          }).join('')
        + '</div>';
    }

    html += '<div class="card"><h2>🔒 Confidentialité</h2><p class="note">'
      + 'Cette page ne reçoit du serveur <strong>que des nombres déjà agrégés</strong>. '
      + 'Aucune adresse email, aucun contenu de voyage, aucune note personnelle ne transite ici — '
      + 'même avec cette session, ces données restent inaccessibles.</p></div>';

    $('#panel').innerHTML = html;
    $('#panel').classList.remove('hidden');
    $('#state').classList.add('hidden');
    $('#stamp').textContent = 'Généré le ' + new Date(d.genere || Date.now()).toLocaleString('fr-FR');
  }

  function load() {
    var base = ((window.ACOLITE_KEYS && window.ACOLITE_KEYS.proxy) || '').replace(/\/+$/, '');
    if (!base) { show('err', 'Serveur non configuré', "L'adresse du serveur est absente de config.js."); return; }
    var tok = token();
    if (!tok) { show('err', 'Accès refusé', "Connecte-toi d'abord sur Acolite avec le compte administrateur, puis reviens sur cette page."); return; }

    show('', 'Chargement…', 'Récupération des statistiques.');
    fetch(base + '/admin/stats', { headers: { Authorization: 'Bearer ' + tok } })
      .then(function (r) {
        if (r.status === 403) { show('err', 'Accès refusé', "Ce compte n'est pas administrateur."); return null; }
        if (r.status === 404) { show('err', 'Serveur non à jour', 'La route /admin/stats est absente : recolle valtown-backend.js dans Val Town.'); return null; }
        if (!r.ok) { show('err', 'Erreur', 'Le serveur a répondu ' + r.status + '.'); return null; }
        return r.json();
      })
      .then(function (d) { if (d) render(d); })
      .catch(function () { show('err', 'Serveur injoignable', 'Vérifie ta connexion.'); });
  }

  $('#refresh').onclick = load;
  load();
})();
