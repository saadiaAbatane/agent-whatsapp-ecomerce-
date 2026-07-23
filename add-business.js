import fs from "fs";
import dotenv from "dotenv";
import { query, pool } from "./db.js";

dotenv.config();

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage : node add-business.js chemin/vers/entreprise.json");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));

async function main() {
  const result = await query(
    `INSERT INTO entreprises
      (phone_number_id, whatsapp_token, nom_entreprise, secteur, ton, langues, infos_livraison, informations_generales, numero_notification, champs_commande_requis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      data.phone_number_id,
      data.whatsapp_token,
      data.nom_entreprise,
      data.secteur,
      data.ton,
      data.langues,
      data.infos_livraison,
      data.informations_generales,
      data.numero_notification,
      data.champs_commande_requis,
    ]
  );

  const entrepriseId = result.rows[0].id;
  console.log(`✅ Entreprise créée avec l'id ${entrepriseId} : ${data.nom_entreprise}`);

  for (const p of data.produits || []) {
    await query(
      `INSERT INTO produits (entreprise_id, nom, description, tailles, couleurs, prix, disponible)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [entrepriseId, p.nom, p.description, p.tailles, p.couleurs, p.prix, p.disponible !== false]
    );
  }
  console.log(`✅ ${data.produits?.length || 0} produits ajoutés`);

  await pool.end();
}

main().catch((err) => {
  console.error("Erreur :", err);
  process.exit(1);
});
