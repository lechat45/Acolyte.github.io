/* ============================================================
   ACOLITE — config.js
   ============================================================
   DEUX MODES :

   ▸ MODE SÉCURISÉ (recommandé si ton site est public)
     Déploie worker.js sur Cloudflare (gratuit), mets tes clés
     DANS LE WORKER (Settings → Variables and Secrets), puis :
        proxy: 'https://acolite.ton-compte.workers.dev'
     et LAISSE LES CLÉS VIDES ci-dessous.
     → Aucune clé ne quitte le navigateur. Personne ne peut les voler.

   ▸ MODE TEST (rapide, mais les clés sont lisibles publiquement)
     Laisse proxy vide et colle tes clés ici.
     ⚠️ N'importe qui peut les récupérer via les outils du navigateur
        (F12 → Sources) et épuiser tes quotas. À réserver au local.
============================================================ */
window.ACOLITE_KEYS = {

  /* ▸ MODE SÉCURISÉ : colle ici l'URL de ton Worker Cloudflare */
  proxy: '',

  /* ▸ MODE TEST uniquement : à VIDER dès que le proxy est en place */
  gemini: 'AQ.Ab8RN6LIYqqkAoeMd-Ox6VSfX1S9ZBKMpGHebvmNysr-hUONRw',
  groq: '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',
  travelpayouts: '208c6b60d7782634d9fb3fc244b81143',

  /* Envoi réel du mail de vérification (gratuit, 200 mails/mois) :
     1. Crée un compte sur https://www.emailjs.com
     2. Ajoute un service Gmail → copie le Service ID
     3. Crée un template avec {{to_email}} et {{code}} → copie le Template ID
     4. Récupère ta Public Key (Account → API keys)
     Tant que c'est vide → mode démo : le code s'affiche à l'écran.
     (La clé publique EmailJS est conçue pour être exposée : pas de risque.) */
  emailjs: {
    publicKey: 'iZ2Y1SA61PxmXDCT5CzeV',
    serviceId: 'service_wiq1wzj',
    templateId: 'template_szov0of'
  }
};
