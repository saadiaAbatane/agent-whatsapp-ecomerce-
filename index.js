import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WEBHOOK_VERIFY_TOKEN,
  GROQ_API_KEY,
  PORT = 3000,
} = process.env;

console.log("🔍 DEBUG - Token attendu:", JSON.stringify(WEBHOOK_VERIFY_TOKEN));

// Numéro qui reçoit les notifications de nouvelles commandes (toi)
const OWNER_PHONE_NUMBER = "212704282919";

// Fichier où les commandes sont sauvegardées
const ORDERS_FILE = "./commandes.json";

// Historique de conversation en mémoire (par numéro de téléphone)
// ⚠️ En mémoire = perdu au redémarrage du serveur. On branchera une vraie base
// de données (SQLite/Postgres) à l'étape suivante.
const conversations = new Map();

// Prompt système : définit le rôle et le ton de l'agent.
const SYSTEM_PROMPT = `Tu es l'assistant WhatsApp de Saada Style, une boutique de vêtements et mode.

Langue :
- Réponds toujours dans la même langue que celle utilisée par le client (français ou arabe/darija).
- Si le client écrit en arabe (lettres arabes ou darija transcrite en lettres latines), réponds dans le même style.
- Si le message mélange les deux langues, réponds dans la langue dominante du message.

Ton rôle :
- Répondre aux questions sur les produits (tailles, couleurs, matières, prix, disponibilité)
- Aider les clients à passer commande (récupère : article souhaité, taille, couleur, quantité, nom complet, adresse de livraison, numéro de téléphone)
- Informer sur les délais et modes de livraison si demandé

Ton ton : professionnel, direct et efficace. Pas de familiarité excessive, mais reste courtois.

Règles strictes :
- Si tu ne connais pas une information précise (stock exact, prix exact), dis-le clairement et propose de transférer la demande à un membre de l'équipe.
- Ne jamais inventer de prix, de délais ou de disponibilité.
- Dès que tu as récupéré TOUTES ces informations pour une commande : article, taille, couleur, quantité, nom complet, adresse de livraison, numéro de téléphone :
  1. Récapitule la commande clairement au client et confirme qu'elle a bien été transmise à l'équipe.
  2. Termine ta réponse par cette ligne exacte sur une nouvelle ligne (elle ne sera jamais vue par le client, c'est un marqueur technique) :
  [COMMANDE_COMPLETE]{"article":"...","taille":"...","couleur":"...","quantite":"...","nom":"...","adresse":"...","telephone":"..."}
- N'utilise ce marqueur JAMAIS avant d'avoir toutes les informations. Pose des questions une par une s'il en manque.
- Reste concis : des réponses courtes et claires, adaptées à WhatsApp.`;

/**
 * ÉTAPE A — Vérification du webhook par Meta (une seule fois, à la config)
 */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook vérifié par Meta");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * ÉTAPE B — Réception des messages entrants WhatsApp
 */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const userText = message.text?.body;

    if (!userText) {
      console.log("Message reçu sans texte (image, audio...) - non géré pour l'instant");
      return;
    }

    console.log(`📩 Message de ${from} : ${userText}`);

    const rawReply = await askGroq(from, userText);

    // Détecte si une commande complète a été signalée par l'IA
    const { cleanReply, order } = extractOrder(rawReply);

    await sendWhatsAppMessage(from, cleanReply);

    if (order) {
      order.client_whatsapp = from;
      order.date = new Date().toISOString();
      saveOrder(order);
      await notifyOwner(order);
    }
  } catch (err) {
    console.error("Erreur lors du traitement du message :", err);
  }
});

/**
 * Appelle l'API Groq (gratuite) avec l'historique de conversation de l'utilisateur.
 */
async function askGroq(userId, userText) {
  const history = conversations.get(userId) || [];
  history.push({ role: "user", content: userText });

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    }),
  });

  const data = await response.json();
  const replyText =
    data.choices?.[0]?.message?.content ||
    "Désolé, je n'ai pas pu générer de réponse.";

  history.push({ role: "assistant", content: replyText });
  conversations.set(userId, history.slice(-20));

  return replyText;
}

/**
 * Extrait le marqueur [COMMANDE_COMPLETE]{...} de la réponse de l'IA,
 * s'il est présent, et retourne le texte nettoyé (sans le marqueur, invisible pour le client)
 * ainsi que les données de la commande si trouvées.
 */
function extractOrder(reply) {
  const marker = "[COMMANDE_COMPLETE]";
  const index = reply.indexOf(marker);

  if (index === -1) {
    return { cleanReply: reply, order: null };
  }

  const cleanReply = reply.slice(0, index).trim();
  const jsonPart = reply.slice(index + marker.length).trim();

  try {
    const order = JSON.parse(jsonPart);
    return { cleanReply, order };
  } catch (err) {
    console.error("Impossible de parser la commande JSON :", err);
    return { cleanReply, order: null };
  }
}

/**
 * Sauvegarde une commande dans le fichier commandes.json
 */
function saveOrder(order) {
  let orders = [];
  if (fs.existsSync(ORDERS_FILE)) {
    try {
      orders = JSON.parse(fs.readFileSync(ORDERS_FILE, "utf-8"));
    } catch (err) {
      console.error("Erreur lecture commandes.json :", err);
    }
  }
  orders.push(order);
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
  console.log("💾 Commande sauvegardée dans commandes.json");
}

/**
 * Envoie une notification WhatsApp au propriétaire (toi) pour chaque nouvelle commande.
 */
async function notifyOwner(order) {
  const message = `🛍️ Nouvelle commande reçue !

Article : ${order.article}
Taille : ${order.taille}
Couleur : ${order.couleur}
Quantité : ${order.quantite}

Client : ${order.nom}
Téléphone : ${order.telephone}
Adresse : ${order.adresse}

WhatsApp client : ${order.client_whatsapp}`;

  await sendWhatsAppMessage(OWNER_PHONE_NUMBER, message);
  console.log(`🔔 Notification de commande envoyée à ${OWNER_PHONE_NUMBER}`);
}

/**
 * Envoie un message texte via l'API WhatsApp Cloud.
 */
async function sendWhatsAppMessage(to, text) {
  const url = `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await response.json();
  if (data.error) {
    console.error("Erreur envoi WhatsApp :", data.error);
  } else {
    console.log(`✅ Réponse envoyée à ${to}`);
  }
}

app.get("/", (req, res) => {
  res.send("Agent IA WhatsApp — serveur actif ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});