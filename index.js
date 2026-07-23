import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
import FormData from "form-data";
import { query } from "./db.js";

dotenv.config();

const app = express();
app.use(express.json());

const { WEBHOOK_VERIFY_TOKEN, GROQ_API_KEY, PORT = 3000 } = process.env;

const conversations = new Map();
const entrepriseCache = new Map();

async function getEntrepriseByPhoneNumberId(phoneNumberId) {
  if (entrepriseCache.has(phoneNumberId)) {
    return entrepriseCache.get(phoneNumberId);
  }

  const result = await query(
    "SELECT * FROM entreprises WHERE phone_number_id = $1 AND actif = true",
    [phoneNumberId]
  );

  if (result.rows.length === 0) return null;

  const entreprise = result.rows[0];

  const produitsResult = await query(
    "SELECT * FROM produits WHERE entreprise_id = $1 AND disponible = true",
    [entreprise.id]
  );
  entreprise.produits = produitsResult.rows;

  entrepriseCache.set(phoneNumberId, entreprise);
  setTimeout(() => entrepriseCache.delete(phoneNumberId), 5 * 60 * 1000);

  return entreprise;
}

function buildSystemPrompt(entreprise) {
  const produitsListe = entreprise.produits
    .map(
      (p) =>
        `- ${p.nom} : ${p.description || ""} | Tailles : ${(p.tailles || []).join(", ") || "N/A"} | Couleurs : ${(p.couleurs || []).join(", ") || "N/A"} | Prix : ${p.prix} DH | Disponible`
    )
    .join("\n");

  const champsRequis = entreprise.champs_commande_requis.join(", ");
  const jsonTemplate = entreprise.champs_commande_requis
    .map((champ) => `"${champ}":"..."`)
    .join(",");

  return `Tu es l'assistant WhatsApp de ${entreprise.nom_entreprise}, une entreprise de ${entreprise.secteur || "commerce"}.

Informations générales :
${entreprise.informations_generales || "Aucune information supplémentaire."}

Informations de livraison :
${entreprise.infos_livraison || "Non précisé."}

Catalogue produits disponible :
${produitsListe || "Aucun produit enregistré pour l'instant."}

Langue :
- Réponds toujours dans la même langue que celle utilisée par le client (${entreprise.langues.join(" ou ")}).

Ton rôle :
- Répondre aux questions sur les produits du catalogue ci-dessus uniquement — n'invente jamais de produit hors catalogue.
- Aider les clients à passer commande en récupérant ces informations : ${champsRequis}.

Ton ton : ${entreprise.ton}.

Règles strictes :
- Si un produit demandé n'est pas dans le catalogue, dis-le clairement.
- Ne jamais inventer de prix, délais ou disponibilité.
- Dès que tu as récupéré TOUTES les informations requises (${champsRequis}) :
  1. Récapitule la commande et confirme qu'elle est transmise à l'équipe.
  2. Termine ta réponse par cette ligne exacte (marqueur technique invisible pour le client) :
  [COMMANDE_COMPLETE]{${jsonTemplate}}
- N'utilise ce marqueur JAMAIS avant d'avoir toutes les informations.
- Reste concis, adapté à WhatsApp.`;
}

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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    const phoneNumberId = change?.value?.metadata?.phone_number_id;

    if (!message || !phoneNumberId) return;

    const entreprise = await getEntrepriseByPhoneNumberId(phoneNumberId);
    if (!entreprise) {
      console.error(`❌ Aucune entreprise trouvée pour phone_number_id ${phoneNumberId}`);
      return;
    }

    const from = message.from;
    let userText = message.text?.body;

    if (!userText && message.type === "audio") {
      console.log(`🎤 [${entreprise.nom_entreprise}] Message vocal reçu de ${from}, transcription...`);
      try {
        userText = await transcribeAudio(entreprise, message.audio.id);
        console.log(`📝 [${entreprise.nom_entreprise}] Transcription : ${userText}`);
      } catch (err) {
        console.error("Erreur de transcription audio :", err);
        await sendWhatsAppMessage(
          entreprise,
          from,
          "Désolé, je n'ai pas pu comprendre votre message vocal. Pouvez-vous l'écrire en texte ?"
        );
        return;
      }
    }

    if (!userText) {
      console.log(`[${entreprise.nom_entreprise}] Message non pris en charge (image, vidéo...), ignoré`);
      return;
    }

    console.log(`📩 [${entreprise.nom_entreprise}] Message de ${from} : ${userText}`);

    const rawReply = await askGroq(entreprise, from, userText);
    const { cleanReply, order } = extractOrder(rawReply);

    await sendWhatsAppMessage(entreprise, from, cleanReply);

    if (order) {
      await saveOrder(entreprise, from, order);
      await notifyOwner(entreprise, from, order);
    }
  } catch (err) {
    console.error("Erreur lors du traitement du message :", err);
  }
});

async function transcribeAudio(entreprise, mediaId) {
  const mediaInfoRes = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${entreprise.whatsapp_token}` },
  });
  const mediaInfo = await mediaInfoRes.json();
  if (!mediaInfo.url) throw new Error("Impossible de récupérer l'URL du média audio");

  const audioRes = await fetch(mediaInfo.url, {
    headers: { Authorization: `Bearer ${entreprise.whatsapp_token}` },
  });
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  const form = new FormData();
  form.append("file", audioBuffer, { filename: "audio.ogg", contentType: "audio/ogg" });
  form.append("model", "whisper-large-v3");

  const transcRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const transcData = await transcRes.json();
  if (!transcData.text) throw new Error("Transcription vide ou échouée");

  return transcData.text;
}

async function askGroq(entreprise, userId, userText) {
  const convKey = `${entreprise.id}:${userId}`;
  const history = conversations.get(convKey) || [];
  history.push({ role: "user", content: userText });

  const systemPrompt = buildSystemPrompt(entreprise);

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      messages: [{ role: "system", content: systemPrompt }, ...history],
    }),
  });

  const data = await response.json();
  const replyText =
    data.choices?.[0]?.message?.content ||
    "Désolé, je n'ai pas pu générer de réponse.";

  history.push({ role: "assistant", content: replyText });
  conversations.set(convKey, history.slice(-20));

  return replyText;
}

function extractOrder(reply) {
  const marker = "[COMMANDE_COMPLETE]";
  const index = reply.indexOf(marker);

  if (index === -1) return { cleanReply: reply, order: null };

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

async function saveOrder(entreprise, clientWhatsapp, order) {
  await query(
    "INSERT INTO commandes (entreprise_id, client_whatsapp, details) VALUES ($1, $2, $3)",
    [entreprise.id, clientWhatsapp, JSON.stringify(order)]
  );
  console.log(`💾 [${entreprise.nom_entreprise}] Commande sauvegardée en base`);
}

async function notifyOwner(entreprise, clientWhatsapp, order) {
  const details = Object.entries(order)
    .map(([key, value]) => `${key} : ${value}`)
    .join("\n");

  const message = `🛍️ Nouvelle commande — ${entreprise.nom_entreprise} !\n\n${details}\n\nClient WhatsApp : ${clientWhatsapp}`;

  await sendWhatsAppMessage(entreprise, entreprise.numero_notification, message);
  console.log(`🔔 [${entreprise.nom_entreprise}] Notification envoyée à ${entreprise.numero_notification}`);
}

async function sendWhatsAppMessage(entreprise, to, text) {
  const url = `https://graph.facebook.com/v25.0/${entreprise.phone_number_id}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${entreprise.whatsapp_token}`,
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
    console.error(`Erreur envoi WhatsApp [${entreprise.nom_entreprise}] :`, data.error);
  } else {
    console.log(`✅ [${entreprise.nom_entreprise}] Réponse envoyée à ${to}`);
  }
}

app.get("/", (req, res) => {
  res.send("Agent IA WhatsApp multi-entreprises — serveur actif ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
});
