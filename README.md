# MAT Home Dashboard

Eigen GitHub-ready broncode voor het MAT Home bol.com-dashboard.

## Inhoud

- `frontend/` — dependency-vrije frontend, direct geschikt voor GitHub Pages.
- `supabase/functions/` — broncode van de relevante productie-Edge Functions.
- `supabase/migrations/` — reproduceerbaar databaseschema.
- `supabase/seed.sql` — optionele niet-gevoelige startdata voor concurrenttracking.
- `.github/workflows/pages.yml` — gratis deployment van de frontend via GitHub Pages.
- `docs/` — architectuur, security en migratiepad.

## Architectuur nu

`Bol.com -> Supabase database/functions -> GitHub Pages frontend`

GitHub wordt hiermee de bron van waarheid voor alle code. Lovable is niet meer nodig voor hosting of broncode. Supabase blijft voorlopig alleen runtime/database. Later kan de backend verhuizen zonder het dashboard opnieuw te ontwerpen.

## Geen secrets in GitHub

Commit nooit:
- Bol Client ID / Client Secret
- Supabase service-role of secret keys
- het echte dashboardwachtwoord

## GitHub Pages

Na upload naar GitHub:
1. Open de repository.
2. Ga naar `Settings -> Pages`.
3. Kies bij Source `GitHub Actions`.
4. Push naar `main`.

De workflow publiceert automatisch `frontend/`.

## Supabase deploy

```bash
supabase login
supabase link --project-ref kqizlvzcfncfyriwnmpl
supabase secrets set BOL_CLIENT_ID=...
supabase secrets set BOL_CLIENT_SECRET=...
supabase secrets set DASHBOARD_CODE_SHA256=...
supabase db push --dry-run
supabase functions deploy
```

Gebruik nooit een destructieve `db reset --linked` op productie.

## Concurrent-sales

`Concurrent sales (schatting)` rekent voorraaddalingen tussen metingen als geschatte verkopen. Dit zijn geen officiële bol.com-verkoopcijfers. Aanvullingen, retouren en voorraadcorrecties kunnen de schatting beïnvloeden.

De automatische winkelwagenmeting is nog niet opgenomen. Handmatige voorraadmetingen werken via `competitor-sales-api`.
