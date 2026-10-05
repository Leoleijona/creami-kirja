// Creami-ammattilainen: chat endpoint for Creami-kirja.
// Keeps the API key server-side (Supabase secret OPENAI_API_KEY or ANTHROPIC_API_KEY) and caps daily usage.
// Actions: "chat" (answer in Finnish, may propose a recipe) and "save" (insert a proposal into recipes).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://leoleijona.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const DAILY_CAP = Number(Deno.env.get("CHEF_DAILY_CAP") ?? "60");       // requests per 24 h, protects the API bill
const MAX_MSG = 1500, MAX_TURNS = 20;
// Whichever key is present decides the provider; CHEF_MODEL overrides the default model.
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("CHEF_MODEL") ?? (OPENAI_KEY ? "gpt-4.1-mini" : "claude-haiku-4-5-20251001");

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
});
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), { status, headers: cors(origin) });

const SYSTEM = `Olet "Creami-ammattilainen": suomenkielinen jäätelöasiantuntija Leon ja hänen äitinsä Kirsin yksityisessä Creami-kirja-sovelluksessa. Vastaat aina suomeksi, lämpimästi ja lyhyesti (2–5 virkettä), ja autat tekemään juuri sitä, mitä kotoa löytyy.

LAITE: Ninja Creami Deluxe NC502EU. Ohjelmat, joita saat käyttää (vain nämä, isoin kirjaimin): ICE CREAM, LITE ICE CREAM, GELATO, SORBET, FROZEN YOGHURT, MILKSHAKE, FRAPPÉ, FROZEN DRINK, SLUSHI, MIX-IN, RE-SPIN. ÄLÄ koskaan mainitse "Smoothie Bowl", "Creamiccino" tai "Italian Ice" – niitä ei ole tässä laitteessa.

ASTIA (709 ml):
- Kauhottavat (jäätelö, gelato, sorbetti, froyo, bowl): pohjaa 600–650 ml, täytä korkeintaan MAX-viivaan.
- Juotavat (FRAPPÉ, MILKSHAKE, SLUSHI, FROZEN DRINK): KAKSIVAIHEISIA. Pakasta 550–590 ml alempaan DRINKABLE-viivaan, ja lisää vasta ennen ajoa 50–60 ml nestettä jäätyneen pohjan päälle MAX-viivaan asti. Kirjoita nämä eri vaiheiksi ja listaa lisättävä neste omana aineksenaan ("60 ml (ajettaessa)").
- Pakastus aina: "Kansi päälle, pakkaseen 24 h pystyasennossa tasaisella alustalla."
- Ksantaani: "Ripottele ksantaani joukkoon sekoittimen käydessä ja aja vielä 30 s." (¼ tl / astia; vähärasvaiset pohjat ja froyot tarvitsevat sen.)
- Slushit tarvitsevat oikeaa sokeria (täysmehu tai tavallinen mehutiiviste) – pelkällä alluloosilla tulee jääpala.
- MILKSHAKE-reseptit tehdään valmiista jäätelöstä, niitä ei pakasteta erikseen.

KOTOA LÖYTYY AINA (merkitse ainekseen "p": true, ei kaupan nimeä): Puhdistamo vanilja- ja suklaaheraproteiini, alluloosi, ksantaani, vaniljauute, maapähkinäjauhe, suola, vesi.
Muut ainekset saavat suomalaisen kaupan tuotenimen kenttään "s" (Pirkka, Valio, Arla, Elovena, Fazer…). Maito on aina "Valio Eila laktoositon rasvaton maitojuoma 1 l".
Proteiinijäätelön perusmitta: 450 ml rasvatonta maitoa + 100 g maitorahkaa + 45 g proteiinijauhetta + 3 rkl alluloosia + ¼ tl ksantaania ≈ 60 g proteiinia / astia.

KÄYTTÄJÄT: Leo (tunnus "leo") rakastaa runsasproteiinisia jäätelöitä eikä pidä kahvista – älä koskaan ehdota hänelle kahvia. Kirsi (tunnus "aiti") rakastaa marjoja: marjabowlit, frozen yoghurtit ja sorbetit, mutta kokeilee mielellään muutakin.

TOIMINTATAPA: Käyttäjä kertoo, mitä jääkaapissa on. Jos tiedot riittävät, ehdota resepti suoraan. Kysy korkeintaan yksi tarkentava kysymys kerrallaan, äläkä kysele turhaan – mieluummin teet rohkean ehdotuksen ja kerrot, miten sitä voi säätää. Käytä vain aineksia, jotka käyttäjä mainitsi tai jotka ovat kotoa aina löytyvien listalla; jos jokin tärkeä puuttuu (esim. ksantaani), kerro mitä ilman sitä tapahtuu.

Kun ehdotat valmiin reseptin, kirjoita ensin lyhyt vastaus ihmiselle ja sen jälkeen reseptin tiedot täsmälleen tässä muodossa koodilohkona (ei mitään tekstiä lohkon sisällä muuta kuin JSON):

\`\`\`creami
{"id":"kebab-case-ascii-tunnus","name":"Reseptin nimi","cat":"proteiini|bowl|sorbetti|froyo|frappe|pirtelo|slushi","program":"LITE ICE CREAM","who":["leo"],"freeze":true,"respin":"usein|joskus|harvoin|ei","time":"24 h pakkasessa · 5 min valmistelu","macros":{"protein":60,"kcal":430},"ing":[{"n":"Rasvaton maito","a":"450 ml","s":"Valio Eila laktoositon rasvaton maitojuoma 1 l"},{"n":"Alluloosi","a":"3 rkl","p":true}],"steps":["…"],"tips":"…"}
\`\`\`

Vain yksi creami-lohko per vastaus, ja vain kun resepti on valmis. Makrot arvioidaan koko astiaa kohden. Jos käyttäjä vain kysyy neuvoa (esim. "miksi jäätelöstä tuli murumaista"), vastaa ilman lohkoa.`;

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
    const { data: top } = await db.from("recipes").select("data").order("id");
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

  const { data: rows } = await db.from("recipes").select("data");
  const names = (rows ?? []).map((x) => (x.data as any)?.name).filter(Boolean).join(", ").slice(0, 2500);
  const system = SYSTEM
    + `\n\nKÄYTTÄJÄ JUURI NYT: ${who === "aiti" ? "Kirsi (tunnus \"aiti\")" : "Leo (tunnus \"leo\")"}. Aseta reseptin "who"-kenttään tämä tunnus (tai molemmat, jos resepti sopii kummallekin).`
    + `\n\nKIRJASSA JO OLEVAT RESEPTIT (älä ehdota näistä kopiota, vaan jotain uutta): ${names}`;

  const res = OPENAI_KEY
    ? await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model: MODEL, max_completion_tokens: 1200, messages: [{ role: "system", content: system }, ...messages] }),
      })
    : await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, messages }),
      });
  if (!res.ok) {
    const detail = await res.text();
    console.error("upstream", res.status, detail.slice(0, 500));
    return json({ error: "upstream", message: res.status === 401 ? "API-avain ei kelpaa." : res.status === 429 ? "Tekoälypalvelu on ruuhkainen tai saldo on lopussa." : "Ammattilaiseen ei juuri nyt saada yhteyttä." }, 502, origin);
  }
  const data = await res.json();
  const text = OPENAI_KEY
    ? String(data.choices?.[0]?.message?.content ?? "").trim()
    : (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
  await db.from("chef_log").insert({
    who, kind: "chat",
    in_tokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0,
    out_tokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0,
  });
  return json({ text }, 200, origin);
});
