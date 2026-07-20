# ✈️ Acolite — ton copilote de voyage IA

Application web (PWA) qui **imagine, compare et organise un voyage de A à Z** :
propositions de destinations sur mesure, plan complet (transport, logement,
programme jour par jour), budget, ticket souvenir et carte postale à partager.

> **Démo** : 100 % statique — aucun serveur applicatif requis, aucune inscription
> payante, **aucun abonnement**. Les données restent dans le navigateur
> (localStorage) ; un compte local avec vérification par email fait office de
> démonstration d'authentification.

## ✨ Fonctionnalités

- **Pipeline IA ordonné** : ville (si un pays est donné) → transport
  (pollution CO₂ réelle, temps, prix, conditions) → lieux principaux → logement
  (compromis point d'arrivée ↔ lieux) → programme par proximité géographique
  (météo, jour 1 allégé) → déplacements sur place & réservations à faire tôt.
- **Données réelles gratuites** : géocodage + météo (Open-Meteo), horaires de
  train (Deutsche Bahn), jours fériés (Nager.Date), taux de change
  (Frankfurter), contexte Wikipédia/Wikivoyage, prix d'hôtels (Hotellook).
- **Relecture croisée** : une 2ᵉ IA (Groq) vérifie le plan de la 1ʳᵉ (Gemini).
- Comparateur de propositions, questions d'affinage à choix pairs, affinage en
  langage libre, galerie « Mes voyages », export/import fichier.
- Ticket d'embarquement souvenir (PNG + QR d'import), **carte postale**
  personnalisable (8 modèles × 6 styles, tes photos ou photos du web).
- Carte OpenStreetMap par jour du programme, checklist valise, budget & dépenses,
  traducteur express, compte à rebours, mode « Jour J », empreinte carbone.
- PWA installable, hors-ligne (service worker), thème clair/sombre/système.

## 🚀 Lancer en local

Aucune compilation. Sers le dossier tel quel :

```bash
npx serve .        # http://localhost:3000  (lit serve.json pour les en-têtes)
# ou
python -m http.server 8080
```

## 🔑 Configuration des clés IA (`config.js`)

Deux modes (voir les commentaires du fichier) :

| Mode | Comment | Risque |
|---|---|---|
| **Sécurisé** (recommandé, actif par défaut) | `proxy` pointe vers un backend (Val Town / Cloudflare Worker — voir `worker.js`) qui détient les clés Gemini/Groq côté serveur | Aucune clé exposée |
| **Test local** | coller ses clés `gemini`/`groq` directement | Clés lisibles par quiconque ouvre F12 — à réserver au local |

`emailjs` (envoi du code de vérification) utilise une clé **publique par
conception**. Sans configuration, l'app bascule en mode démo : le code
s'affiche à l'écran.

## 📦 Publier (site statique)

Compatible GitHub Pages, Netlify, Cloudflare Pages, etc. — tout est relatif
(`start_url: "./"`), HTTPS requis pour la PWA.

- **Cloudflare/Netlify** : le fichier `_headers` règle le cache
  (HTML/JS/CSS revalidés, icônes en cache long).
- **GitHub Pages** : fonctionne sans réglage ; le service worker gère les
  mises à jour (pense à incrémenter `CACHE` dans `sw.js` à chaque déploiement).

## 🗂 Structure

```
index.html      interface (une seule page, 3 onglets : Carte / Voyage / Profil)
app.js          logique + routeur IA (Gemini heavy · Groq light) + données réelles
style.css       design néo-brutaliste, thèmes clair/sombre
config.js       clés / proxy (voir ci-dessus)
worker.js       backend optionnel (Cloudflare Worker / Val Town)
sw.js           service worker (hors-ligne)
manifest.json   PWA
serve.json      en-têtes en dev (npx serve) · _headers : en production
```

## ⚖️ Notes

- Ticket et carte postale sont des **souvenirs** : ils ne permettent ni
  d'embarquer ni de voyager.
- Prix et horaires affichés = estimations ou données publiques au moment de la
  consultation ; vérifie toujours avant de réserver.
