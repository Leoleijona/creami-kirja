# Creami-kirja

Leon ja äidin yhteinen Ninja Creami Deluxe (NC502EU) -reseptikirja. Yksi HTML-sivu (`index.html`), tietokantana Supabase.

- Sovellus: GitHub Pages (tämä repo)
- Reseptit: Supabase-taulu `recipes` on totuus; `node data/sync_from_live.js` päivittää paikallisen kopion `data/recipes.json` + `data/seed/`
- Uudet reseptit lisätään aina ehdotuksina (`status: "ehdotus"`), ja ne menevät kirjaan vasta kun käyttäjä painaa *Pidetään*
