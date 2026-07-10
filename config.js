/* ============================================================
   ACOLITE — config.js (clés API de test)
   ⚠️ Lisible publiquement une fois déployé — ok pour du test.
============================================================ */
window.ACOLITE_KEYS = {
  gemini: 'AQ.Ab8RN6LIYqqkAoeMd-Ox6VSfX1S9ZBKMpGHebvmNysr-hUONRw',
  groq: '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',
  travelpayouts: '208c6b60d7782634d9fb3fc244b81143',

  /* Envoi réel du mail de vérification (gratuit, 200 mails/mois) :
     1. Crée un compte sur https://www.emailjs.com
     2. Ajoute un service Gmail → copie le Service ID
     3. Crée un template avec les variables {{to_email}} et {{code}} → copie le Template ID
     4. Récupère ta Public Key (Account → API keys)
     Tant que c'est vide → mode démo : le code s'affiche à l'écran. */
  emailjs: {
    publicKey: '',
    serviceId: '',
    templateId: ''
  }
};
