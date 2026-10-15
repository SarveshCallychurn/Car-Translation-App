# Car Manual Translator (Japanese → English)

Take or upload a photo of a Japanese car manual page, label or dashboard message and get an English translation.
Static page (`public/`) + one Netlify Function (`netlify/functions/translate.mjs`) that calls Google's Gemini API (free tier).
Your API key stays on the server and is never exposed to visitors.

## Deploy (GitHub route, recommended)

1. Get a **free** API key at https://aistudio.google.com/apikey (sign in with a Google account; no credit card needed).
2. Create a new GitHub repository and upload everything in this folder.
3. In Netlify: **Add new site → Import an existing project → GitHub**, pick the repo.
   Leave the build command empty. Publish directory and functions folder are read from `netlify.toml`.
4. Before the first deploy (or right after), open **Site configuration → Environment variables** and add:
   - `GEMINI_API_KEY` = your free key
5. Deploy (or trigger **Deploys → Trigger deploy** after adding the variable).
6. Open your `*.netlify.app` URL on your phone. Optionally rename it under **Domain management**.

## Deploy (CLI route)

```bash
npm install -g netlify-cli
cd car-translator-netlify
netlify login
netlify init                      # create & link a new site
netlify env:set GEMINI_API_KEY your-free-key-here
netlify deploy --prod
```

## Test locally

```bash
cp .env.example .env              # put your real key in .env
netlify dev                       # http://localhost:8888
```

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | (required) | Your free Google AI Studio key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Any free-tier Gemini Flash model that accepts images |
| `RATE_LIMIT` | `10` | Max translations per visitor (IP) per hour |

## Notes

- Everything here runs on free tiers (Netlify hosting + Google's free Gemini tier), so it costs nothing as long as you
  don't enable billing on your Google project. Free tiers have daily/per-minute limits shared by ALL visitors; when
  they run out, people see a "quota used up, try later" message until it resets.
- Google's free tier may use submitted content to improve its products, so avoid photographing anything private
  (documents with personal details). Check Google's current terms for the free tier.
- The built-in rate limit is best-effort (kept in memory per function instance). For stronger protection,
  add Netlify's rate limiting rules, Cloudflare in front, or an access code.
- Netlify functions have a time limit (10 s by default, up to 26 s on request/paid plans).
  Results stream in as they're written, but very dense pages may time out: photograph one section at a time,
  or try a different `GEMINI_MODEL`.
- To install on a phone: open the site in the browser → Share / menu → **Add to Home Screen**.
