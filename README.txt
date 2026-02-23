Workforce + Neon (Fix A: Netlify Function Proxy)

What this package contains
- index.html              Your app (patched to call /.netlify/functions/sql)
- netlify/functions/sql.mjs   Netlify Function that runs SQL on Neon using pg
- package.json            Installs pg
- netlify.toml            Points Netlify to the functions folder

STEP-BY-STEP (do these in order)

1) Create a NEW Neon project
   - neon.tech → New Project
   - Copy the *pooled* connection string (postgresql://...pooler.../db?sslmode=require)

2) Create a GitHub repo and upload THIS FOLDER contents
   - Upload index.html, package.json, netlify.toml, and netlify/functions/sql.mjs

3) Connect Netlify to the GitHub repo
   - Netlify → Add new site → Import from Git → pick your repo → Deploy
   - (No build command needed)

4) Add Neon secret to Netlify (IMPORTANT)
   - Netlify → Site settings → Environment variables → Add variable:
     Key:   NEON_DATABASE_URL
     Value: (paste your Neon pooled connection string)

5) Redeploy
   - Netlify → Deploys → Trigger deploy

6) Test the function
   Open:
     https://YOUR-SITE.netlify.app/.netlify/functions/sql
   You should see:
     POST only

Notes
- Do NOT put Neon API keys or connection strings inside index.html.
- All database credentials live in Netlify Environment Variables.
