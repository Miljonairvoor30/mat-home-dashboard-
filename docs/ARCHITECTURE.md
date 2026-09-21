# Architectuur

## Huidige opzet

```text
Bol Retailer API
      |
      v
Supabase Edge Functions
      |
      v
Postgres
      |
      v
Dashboard API
      |
      v
GitHub Pages frontend
```

## Later volledig van Supabase af

De frontend gebruikt alleen twee HTTP-endpoints uit `frontend/config.js`. Daardoor kan de backend later worden vervangen door bijvoorbeeld Cloudflare Workers + D1/Postgres, zonder de frontend opnieuw te ontwerpen.
