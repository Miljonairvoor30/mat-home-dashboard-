# Security

- Commit nooit Bol-credentials, service-role keys of echte dashboardcodes.
- De frontend bevat uitsluitend publieke API-URL's.
- De dashboardcode wordt lokaal in de browser opgeslagen en als `x-dashboard-code` header verzonden.
- De repo-versie verwacht de hash via `DASHBOARD_CODE_SHA256`; de hash staat dus niet in GitHub.
- Tabellen hebben RLS ingeschakeld en `anon` / `authenticated` hebben geen tabelrechten.
- Edge Functions die service-role gebruiken, houden deze key server-side.
- Voor een volgende versie is Supabase Auth/passkey/magic-link sterker dan een gedeelde dashboardcode.
