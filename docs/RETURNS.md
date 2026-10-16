# Retouren op het dashboard

- **Openstaande retouren**: aantal aangemelde artikelen met `raw_data.handled = false`, over alle perioden.
- **Totale retouren**: aantal aangemelde artikelen binnen de geselecteerde dashboardperiode, inclusief afgehandelde retouren. De aanmelddatum (`registered_at`, met `return_date` als fallback) geldt in de tijdzone Europe/Amsterdam. De oorspronkelijke besteldatum is niet bepalend.
- De tellers lezen alle pagina's uit `public.returns` en tellen `quantity`. Een retour met meerdere artikelen telt dus als meerdere artikelen.
- Bij het openen en automatisch bijwerken van het dashboard wordt `bol-sync-returns` aangeroepen wanneer de laatste geslaagde retoursynchronisatie minstens vijf minuten oud is. De bestaande knop **Ververs Bol-data** forceert deze synchronisatie ook. De bestaande synchronisatiefunctie haalt zowel openstaande als afgehandelde retouren op en werkt op retourartikel-ID bij.
- Bij een mislukte synchronisatie blijven de laatst beschikbare aantallen zichtbaar, met een waarschuwing en tijdstip. Ontbrekende of onleesbare retourgegevens verschijnen als een streepje, niet als nul. Omzet en orders houden hun bestaande berekening.
- De API gebruikt de bestaande dashboardcode en server-side databaseverbinding. Er worden geen klantgegevens naar de frontend gestuurd.

Controle: `node --test tests/returns.test.mjs` en `node tests/automatic-refresh.cjs` (Node.js 24+).
