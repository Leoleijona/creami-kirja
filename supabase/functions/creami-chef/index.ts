// Creami-ammattilainen: chat endpoint for Creami-kirja.
// Keeps the API key server-side (Supabase secret OPENAI_API_KEY or ANTHROPIC_API_KEY) and caps daily usage.
// Actions: "chat" (converse in Finnish, may propose a recipe) and "save" (insert a proposal into recipes).
// The chef's instructions live in the table chef_prompt (id='main') so they can be tuned with one SQL
// statement instead of redeploying; FALLBACK below is only used if that row is missing.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://leoleijona.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const DAILY_CAP = Number(Deno.env.get("CHEF_DAILY_CAP") ?? "60");       // requests per 24 h, protects the API bill
const MAX_MSG = 2000, MAX_TURNS = 24;
// Whichever key is present decides the provider. CHEF_MODEL pins one model; otherwise the best model the
// account can actually use wins (the list is tried in order, falling back when a model is unknown).
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const PINNED = Deno.env.get("CHEF_MODEL");
const EFFORT = Deno.env.get("CHEF_EFFORT") ?? "low";   // gpt-5 spends max_completion_tokens on reasoning first; keep it light
const OPENAI_MODELS = PINNED ? [PINNED] : ["gpt-5", "gpt-4.1", "gpt-4o"];
const ANTHROPIC_MODELS = PINNED ? [PINNED] : ["claude-sonnet-5", "claude-haiku-4-5-20251001"];

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
});
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: cors(origin) });

const FALLBACK = `Olet "Creami-ammattilainen", suomenkielinen jäätelöasiantuntija Ninja Creami Deluxe NC502EU -laitteelle. Vastaa suomeksi ja lyhyesti.
Ohjelmat: ICE CREAM, LITE ICE CREAM, GELATO, SORBET, FROZEN YOGHURT, MILKSHAKE, FRAPPÉ, FROZEN DRINK, SLUSHI, MIX-IN, RE-SPIN.
Astia 709 ml: kauhottavat 600–650 ml MAX-viivaan; juotavat pakastetaan 550–590 ml DRINKABLE-viivaan ja nestettä lisätään 50–60 ml vasta ennen ajoa. Pakastus 24 h pystyasennossa tasaisella alustalla. Ksantaani ¼ tl sekoittimen käydessä.
Kotona aina (merkitse "p": true): Puhdistamo vanilja- ja suklaaheraproteiini, alluloosi, ksantaani, vaniljauute, maapähkinäjauhe, suola, vesi. Älä kysy näistä. Muille aineksille suomalainen kaupan tuotenimi kenttään "s".
Kysy puuttuvat ainekset valmis määrä ehdottaen. Jos aineksista ei tulisi hyvää, sano se rehellisesti äläkä anna reseptiä.
Kun resepti on valmis, lisää vastauksen loppuun koodilohko \`\`\`creami jossa on vain JSON: {"id","name","cat","program","who","freeze","respin","time","macros":{"protein","kcal"},"ing":[{"n","a","s","p"}],"steps":[],"tips"}.`;

const textOf = (data: any) => OPENAI_KEY
  ? String(data.choices?.[0]?.message?.content ?? "").trim()
  : (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();

async function callModel(system: string, messages: { role: string; content: string }[]) {
  const models = OPENAI_KEY ? OPENAI_MODELS : ANTHROPIC_MODELS;
  let last: { status: number; detail: string } = { status: 0, detail: "" };
  for (const model of models) {
    const reasoning = /^(gpt-5|o[1-9])/.test(model);
    const res = OPENAI_KEY
      ? await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({
            model,
            max_completion_tokens: reasoning ? 5000 : 1800,
            ...(reasoning ? { reasoning_effort: EFFORT } : {}),
            messages: [{ role: "system", content: system }, ...messages],
          }),
        })
      : await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 1800, system, messages }),
        });
    if (res.ok) {
      const data = await res.json();
      const text = textOf(data);
      if (text) return { ok: true as const, data, text, model };
      // A reasoning model can spend its whole budget on thinking and answer nothing; try the next model.
      console.error("empty", model, JSON.stringify(data.usage ?? {}));
      last = { status: 0, detail: "empty" };
      continue;
    }
    const detail = await res.text();
    last = { status: res.status, detail };
    console.error("upstream", model, res.status, detail.slice(0, 300));
    // Unknown / unavailable model for this account: try the next one. Other errors are real.
    const unknownModel = (res.status === 400 || res.status === 404 || res.status === 403) && /model/i.test(detail);
    if (!unknownModel) break;
  }
  return { ok: false as const, ...last };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin" }, 403, origin);

  if (!OPENAI_KEY && !ANTHROPIC_KEY) return json({ error: "no_key", message: "Ammattilainen ei ole vielä käytössä: API-avain puuttuu Supabasesta." }, 503, origin);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await db.from("chef_log").select("id", { count: "exact", head: true }).gte("at", since);
  if ((count ?? 0) >= DAILY_CAP) return json({ error: "cap", message: "Ammattilainen on jutellut tänään jo paljon. Kokeile huomenna uudelleen." }, 429, origin);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400, origin); }
  const who = body.who === "aiti" ? "aiti" : "leo";

  // --- Save a proposed recipe into the book (RLS keeps the app itself read-only on recipes) ---
  if (body.action === "save") {
    const r = body.recipe as Record<string, unknown> | undefined;
    const id = String(r?.id ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60);
    if (!r || !id || !r.name || !Array.isArray(r.ing) || !Array.isArray(r.steps)) return json({ error: "bad_recipe" }, 400, origin);
    const { data: top } = await db.from("recipes").select("data");
    const maxOrder = (top ?? []).reduce((m, row) => Math.max(m, Number((row.data as any)?.order ?? 0)), 0);
    const doc = { ...r, id, status: "ehdotus", added: Date.now(), order: maxOrder + 1, source: "chef" };
    const { error } = await db.from("recipes").insert({ id, data: doc });
    if (error) return json({ error: "exists", message: "Tämän niminen resepti on jo kirjassa." }, 409, origin);
    await db.from("chef_log").insert({ who, kind: "save" });
    return json({ ok: true, id }, 200, origin);
  }

  // --- Chat ---
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw.slice(-MAX_TURNS)
    .filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, MAX_MSG) }));
  if (!messages.length) return json({ error: "empty" }, 400, origin);

  const [{ data: rows }, { data: promptRow }] = await Promise.all([
    db.from("recipes").select("data"),
    db.from("chef_prompt").select("text").eq("id", "main").maybeSingle(),
  ]);
  const names = (rows ?? []).map((x) => (x.data as any)?.name).filter(Boolean).join(", ").slice(0, 2500);
  const system = (promptRow?.text || FALLBACK)
    + `\n\nKÄYTTÄJÄ JUURI NYT: ${who === "aiti" ? "Kirsi (tunnus \"aiti\")" : "Leo (tunnus \"leo\")"}. Aseta reseptin "who"-kenttään tämä tunnus (tai molemmat, jos resepti sopii kummallekin).`
    + `\n\nKIRJASSA JO OLEVAT RESEPTIT (älä ehdota näistä kopiota, vaan jotain uutta): ${names}`;

  const out = await callModel(system, messages);
  if (!out.ok) {
    return json({ error: "upstream", message: out.status === 401 ? "API-avain ei kelpaa." : out.status === 429 ? "Tekoälypalvelu on ruuhkainen tai saldo on lopussa." : "Ammattilaiseen ei juuri nyt saada yhteyttä." }, 502, origin);
  }
  const data = out.data, text = out.text;
  await db.from("chef_log").insert({
    who, kind: out.model,
    in_tokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0,
    out_tokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0,
  });
  return json({ text }, 200, origin);
});
