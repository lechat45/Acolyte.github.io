/* ============================================================
   ACOLITE — Vérificateur de démarrage
   Chargé AVANT app.js. Si app.js n'arrive pas (fichier absent,
   mauvais dossier, cache périmé), il l'affiche clairement
   au lieu de laisser l'app figée sur l'écran de démarrage.
============================================================ */
(function () {
  window.__ACOLITE = { loaded: false, errors: [] };

  window.addEventListener('error', function (e) {
    window.__ACOLITE.errors.push(e.message || 'erreur inconnue');
  });

  setTimeout(function () {
    if (window.__ACOLITE.loaded) return;      /* app.js a démarré : rien à faire */

    var boot = document.getElementById('boot');
    var host = boot || document.body;
    var err = window.__ACOLITE.errors[0];

    var box = document.createElement('div');
    box.style.cssText =
      'position:fixed;inset:0;z-index:999;background:#F4F3EF;color:#101010;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      "font-family:system-ui,sans-serif;overflow:auto";
    box.innerHTML =
      '<div style="max-width:440px;background:#fff;border:4px solid #101010;box-shadow:8px 8px 0 #101010;padding:20px">' +
        '<div style="background:#FF6B00;border:3px solid #101010;display:inline-block;padding:4px 10px;font-weight:900;font-size:.7rem;letter-spacing:.1em">DÉMARRAGE IMPOSSIBLE</div>' +
        '<h2 style="font-size:1.15rem;margin:14px 0 8px;font-weight:900">Le fichier <code>app.js</code> n\'a pas pu être chargé.</h2>' +
        (err
          ? '<p style="font-size:.85rem;font-weight:600;margin-bottom:12px">Erreur JavaScript :<br><code style="background:#FFE600;padding:2px 5px;display:inline-block;margin-top:4px;word-break:break-word">' + String(err).slice(0, 200) + '</code></p>'
          : '<p style="font-size:.85rem;font-weight:600;margin-bottom:12px">Le navigateur ne l\'a pas trouvé (erreur 404 probable).</p>') +
        '<p style="font-size:.85rem;font-weight:700;margin-bottom:6px">À vérifier :</p>' +
        '<ul style="font-size:.82rem;font-weight:600;line-height:1.6;padding-left:18px">' +
          '<li><strong>app.js</strong>, <strong>style.css</strong> et <strong>config.js</strong> sont dans le <u>même dossier</u> que index.html</li>' +
          '<li>Les noms sont exacts (minuscules, sans espace)</li>' +
          '<li>Vide le cache : <strong>Ctrl+Maj+R</strong> (ou désinstalle puis réinstalle la PWA)</li>' +
          '<li>Sur GitHub : le commit contient bien les 3 fichiers</li>' +
        '</ul>' +
        '<button id="acoReload" style="margin-top:16px;width:100%;background:#FFE600;border:3px solid #101010;box-shadow:4px 4px 0 #101010;padding:11px;font-weight:900;cursor:pointer;font-size:.9rem">↻ Recharger sans le cache</button>' +
      '</div>';
    document.body.appendChild(box);
    if (boot) boot.style.display = 'none';

    var btn = document.getElementById('acoReload');
    if (btn) btn.onclick = function () {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (rs) {
          rs.forEach(function (r) { r.unregister(); });
          if (window.caches) caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); });
          setTimeout(function () { location.reload(true); }, 300);
        });
      } else {
        location.reload(true);
      }
    };
  }, 3500);
})();
