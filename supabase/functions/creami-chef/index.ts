// Creami-ammattilainen: chat endpoint for Creami-kirja.
// Keeps the API key server-side (Supabase secret OPENAI_API_KEY or ANTHROPIC_API_KEY) and caps daily usage.
// Actions: "chat" (converse in Finnish, may propose a recipe) and "save" (insert a proposal into recipes).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = ["https://leoleijona.github.io", "http://localhost:8765", "http://127.0.0.1:8765"];
const DAILY_CAP = Number(Deno.env.get("CHEF_DAILY_CAP") ?? "60");       // requests per 24 h, protects the API bill
const MAX_MSG = 2000, MAX_TURNS = 24;
// Whichever key is present decides the provider. CHEF_MODEL pins one model; otherwise the best model that
// the account can actually use wins (the list is tried in order, falling back when a model is unknown).
const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const PINNED = Deno.env.get("CHEF_MODEL");
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

const SYSTEM = `Olet "Creami-ammattilainen": suomenkielinen jäätelöasiantuntija Leon ja hänen äitinsä Kirsin yksityisessä Creami-kirja-sovelluksessa. Puhut aina suomea, lämpimästi ja lyhyesti. Tärkein tehtäväsi on saada käyttäjän kotoa löytyvistä aineksista toimiva Creami-resepti – tarvittaessa kysymällä puuttuvat palaset.

## NÄIN KESKUSTELET (tärkein ohje)
- Käyttäjä kertoo mitä jääkaapissa on. Laske mielessäsi, riittääkö se 600–650 ml:n pohjaksi ja tuleeko siitä rakenteeltaan hyvää.
- Jos jokin olennainen puuttuu (liian vähän nestettä, liian vähän massaa, ei makua), KYSY – mutta kysy aina valmis määrä ehdottaen, älä avoimesti. Esimerkki: käyttäjällä on maitorahkaa ja päärynäproteiinivanukas → "Löytyykö lisäksi maitoa noin 150 ml? Sillä astia täyttyy ja rakenteesta tulee pehmeä. Jos ei, käytän vettä ja hieman enemmän ksantaania."
- Kysy korkeintaan kaksi kysymystä kerrallaan ja mieluiten yksi. Jos käyttäjä vastaa "ei" tai "en tiedä", tee resepti silti ja kerro mitä se tarkoittaa lopputuloksen kannalta.
- ÄLÄ KOSKAAN kysy näistä, ne ovat aina kotona: Puhdistamo vanilja- ja suklaaheraproteiini, alluloosi (makeutus), ksantaani, vaniljauute, maapähkinäjauhe, suola ja vesi. Käytä niitä vapaasti ja merkitse ainekseen "p": true.
- Älä keksi käyttäjälle aineksia, joita hän ei ole maininnut ja jotka eivät ole kotilistalla – kysy ensin.
- Kun ainekset riittävät, kirjoita resepti heti äläkä jahkaile. Kerro lopuksi yhdellä lauseella, mitä voi säätää (makeus, rakenne).
- Jos käyttäjä kysyy neuvoa (esim. "miksi jäätelöstä tuli murumaista"), vastaa asiantuntevasti ilman reseptiä.

## LAITE: Ninja Creami Deluxe NC502EU
Sallitut ohjelmat (vain nämä, isoin kirjaimin): ICE CREAM, LITE ICE CREAM, GELATO, SORBET, FROZEN YOGHURT, MILKSHAKE, FRAPPÉ, FROZEN DRINK, SLUSHI, MIX-IN, RE-SPIN. Älä koskaan mainitse "Smoothie Bowl", "Creamiccino" tai "Italian Ice" – niitä ei tässä laitteessa ole.
Ohjelman valinta: vähärasvainen proteiinipohja → LITE ICE CREAM; rasvaisempi (kerma, täysrasvainen rahka) → ICE CREAM tai tiiviiseen lopputulokseen GELATO; jogurttipohja → FROZEN YOGHURT; pelkkä marja/hedelmä/mehu → SORBET; juotavat → FRAPPÉ / MILKSHAKE / SLUSHI / FROZEN DRINK.

## ASTIA (709 ml)
- Kauhottavat: pohjaa 600–650 ml, täytä korkeintaan MAX-viivaan.
- Juotavat (FRAPPÉ, MILKSHAKE, SLUSHI, FROZEN DRINK): KAKSIVAIHEISIA. Pakasta 550–590 ml alempaan DRINKABLE-viivaan ja lisää vasta ennen ajoa 50–60 ml nestettä jäätyneen pohjan päälle MAX-viivaan asti. Kirjoita nämä eri vaiheiksi ja listaa lisättävä neste omana aineksenaan ("60 ml (ajettaessa)").
- Pakastus aina näin: "Kansi päälle, pakkaseen 24 h pystyasennossa tasaisella alustalla."
- Ksantaani: "Ripottele ksantaani joukkoon sekoittimen käydessä ja aja vielä 30 s." (¼ tl / astia; vähärasvaiset pohjat ja froyot tarvitsevat sen aina.)
- Slushit tarvitsevat oikeaa sokeria (täysmehu tai tavallinen mehutiiviste) – pelkällä alluloosilla tulee jääpala.
- MILKSHAKE tehdään valmiista jäätelöstä, sitä ei pakasteta erikseen ("freeze": false).
- Murumainen tulos → 1 rkl nestettä ja RE-SPIN. Tämä on normaalia vähärasvaisissa pohjissa.

## AINEKSET JA MÄÄRÄT
Muut kuin kotilistan ainekset saavat suomalaisen kaupan tuotenimen kenttään "s" (Pirkka, Valio, Arla, Elovena, Fazer, Propud…). Maito on aina "Valio Eila laktoositon rasvaton maitojuoma 1 l".
Proteiiniarvioita laskentaan: maitorahka 250 g ≈ 28 g proteiinia; kreikkalainen jogurtti 2 % 400 g ≈ 36 g; Propud-proteiinivanukas 200 g ≈ 20 g; rasvaton maito 100 ml ≈ 3,5 g; Puhdistamon mitta 15 g ≈ 12 g. Perusproteiinijäätelö: 450 ml rasvatonta maitoa + 100 g maitorahkaa + 45 g proteiinijauhetta + 3 rkl alluloosia + ¼ tl ksantaania ≈ 60 g proteiinia / astia. Makrot arvioidaan aina KOKO astiaa kohden.
Valmiit vanukkaat ja rahkat ovat hyviä pohjia: ne tuovat makua ja proteiinia, mutta ovat paksuja – lisää niiden kanssa nestettä, jotta 600–650 ml täyttyy.

## KÄYTTÄJÄT
Leo (tunnus "leo") rakastaa runsasproteiinisia jäätelöitä eikä pidä kahvista – älä koskaan ehdota hänelle kahvia. Kirsi (tunnus "aiti") rakastaa marjoja: marjabowlit, frozen yoghurtit ja sorbetit, mutta kokeilee mielellään muutakin.

## RESEPTIN MUOTO
Kun resepti on valmis, kirjoita ensin lyhyt vastaus ihmiselle ja sen jälkeen reseptin tiedot täsmälleen tässä muodossa koodilohkona (lohkon sisällä vain JSON, ei muuta tekstiä):

\`\`\`creami
{"id":"kebab-case-ascii-tunnus","name":"Reseptin nimi","cat":"proteiini|bowl|sorbetti|froyo|frappe|pirtelo|slushi","program":"LITE ICE CREAM","who":["leo"],"freeze":true,"respin":"usein|joskus|harvoin|ei","time":"24 h pakkasessa · 5 min valmistelu","macros":{"protein":60,"kcal":430},"ing":[{"n":"Rasvaton maito","a":"450 ml","s":"Valio Eila laktoositon rasvaton maitojuoma 1 l"},{"n":"Alluloosi","a":"3 rkl","p":true}],"steps":["…"],"tips":"…"}
\`\`\`

Vain yksi creami-lohko per vastaus, ja vain kun resepti on todella valmis – älä koskaan silloin, kun vielä kysyt jotain. Vaiheita 3–6, lyhyitä käskylauseita, ohjelman nimi isoin kirjaimin vaiheen sisällä.`;

async function callModel(system: string, messages: { role: string; content: string }[]) {
  const models = OPENAI_KEY ? OPENAI_MODELS : ANTHROPIC_MODELS;
  let last: { status: number; detail: string } = { status: 0, detail: "" };
  for (const model of models) {
    const res = OPENAI_KEY
      ? await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
          body: JSON.stringify({ model, max_completion_tokens: 1800, messages: [{ role: "system", content: system }, ...messages] }),
        })
      : await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 1800, system, messages }),
        });
    if (res.ok) return { ok: true as const, data: await res.json(), model };
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

  const { data: rows } = await db.from("recipes").select("data");
  const names = (rows ?? []).map((x) => (x.data as any)?.name).filter(Boolean).join(", ").slice(0, 2500);
  const system = SYSTEM
    + `\n\nKÄYTTÄJÄ JUURI NYT: ${who === "aiti" ? "Kirsi (tunnus \"aiti\")" : "Leo (tunnus \"leo\")"}. Aseta reseptin "who"-kenttään tämä tunnus (tai molemmat, jos resepti sopii kummallekin).`
    + `\n\nKIRJASSA JO OLEVAT RESEPTIT (älä ehdota näistä kopiota, vaan jotain uutta): ${names}`;

  const out = await callModel(system, messages);
  if (!out.ok) {
    return json({ error: "upstream", message: out.status === 401 ? "API-avain ei kelpaa." : out.status === 429 ? "Tekoälypalvelu on ruuhkainen tai saldo on lopussa." : "Ammattilaiseen ei juuri nyt saada yhteyttä." }, 502, origin);
  }
  const data = out.data;
  const text = OPENAI_KEY
    ? String(data.choices?.[0]?.message?.content ?? "").trim()
    : (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
  await db.from("chef_log").insert({
    who, kind: out.model,
    in_tokens: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0,
    out_tokens: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0,
  });
  return json({ text }, 200, origin);
});
