# Agent IA WhatsApp

Webhook Node.js/Express qui connecte WhatsApp Cloud API (Meta) à Claude (Anthropic)
pour répondre automatiquement 24h/24.

## 1. Installation

```bash
npm install
cp .env.example .env
```

Puis remplis `.env` avec :
- `WHATSAPP_TOKEN` → le token d'accès copié depuis le dashboard Meta (page "Étape 1. Essayez !")
- `WHATSAPP_PHONE_NUMBER_ID` → `1254752391048082` (déjà dans .env.example, à confirmer)
- `WEBHOOK_VERIFY_TOKEN` → invente une chaîne secrète toi-même (ex: `mon_token_secret_123`), tu la réutiliseras dans le dashboard Meta
- `ANTHROPIC_API_KEY` → ta clé API Claude (console.anthropic.com)

## 2. Lancer le serveur en local

```bash
npm start
```

Le serveur tourne sur `http://localhost:3000`.

## 3. Exposer le serveur publiquement (pour que Meta puisse l'atteindre)

Tant que tu n'as pas déployé sur Railway/Render, utilise **ngrok** pour tester en local :

```bash
npx ngrok http 3000
```

Ngrok te donne une URL publique du type `https://xxxx.ngrok-free.app` → note-la,
tu vas t'en servir pour configurer le webhook.

## 4. Configurer le webhook dans le dashboard Meta

Dans ton app Meta → WhatsApp → Configuration :
- **URL de rappel (Callback URL)** : `https://xxxx.ngrok-free.app/webhook`
- **Token de vérification** : la même valeur que `WEBHOOK_VERIFY_TOKEN` dans ton `.env`
- Clique sur "Vérifier et enregistrer"
- Abonne-toi (Subscribe) au champ **messages**

## 5. Tester

Envoie un message WhatsApp à ton numéro de test Meta depuis ton téléphone.
Tu devrais voir dans les logs du serveur le message reçu, puis recevoir
une réponse générée par Claude sur WhatsApp.

## Prochaines étapes (pas encore incluses dans ce code)

- Remplacer la mémoire en RAM (`Map`) par une vraie base de données (SQLite/Postgres)
- Générer un token WhatsApp **permanent** (via un utilisateur système Meta)
- Gérer les autres types de messages (images, audio, boutons...)
- Ajouter une logique d'escalade vers un humain
- Déployer sur Railway/Render pour un fonctionnement 24h/24
