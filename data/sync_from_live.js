// Dumps the live Supabase `recipes` table into data/recipes.json and data/seed/<id>.json (the DB is the source of truth).
// Run: node data/sync_from_live.js
const fs = require("fs"), path = require("path");
const URL = "https://nkhfqgyxronrfsdbeddn.supabase.co/rest/v1/recipes?select=id,data&order=id";
const KEY = "sb_publishable_YgV-RORNesAaMS--00Gz6Q_HB_3C7kk";
(async () => {
  const rows = await (await fetch(URL, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } })).json();
  if (!Array.isArray(rows)) throw new Error(JSON.stringify(rows));
  const recipes = rows.map((r) => ({ ...r.data, id: r.id })).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const dir = path.join(__dirname, "seed"); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  for (const r of recipes) fs.writeFileSync(path.join(dir, r.id + ".json"), JSON.stringify(r, null, 1) + "\n");
  fs.writeFileSync(path.join(__dirname, "recipes.json"), JSON.stringify(recipes, null, 1) + "\n");
  console.log(recipes.length + " reseptiä tallennettu");
})();
