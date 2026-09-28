# Automatic refresh and competitor measurements

Orders and own stock synchronize through Supabase Cron every five minutes. At the start of each hour the same job also updates visits, buy-box metrics, search volumes and same-EAN competitor offers. No open browser is required for this synchronization.

The dashboard reloads stored data every minute while visible and when returning to the tab. Applied overview and product date selections are preserved. Failed reloads retain existing data and retry on the next tick. The status shows the last successful synchronization.

The sync endpoint authenticates either the existing internal service-role caller or a dedicated random token held in Supabase Vault as mat_home_sync_cron. Its SHA-256 hash is embedded in the function. A partial unique index prevents simultaneous runs. Running records older than ten minutes are marked failed before claiming a new run. Restoring the job in another project requires generating a new Vault secret and updating CRON_TOKEN_HASH in the function before deploying. Never put the plaintext token in GitHub.

## Competitor measurements

The GitHub-hosted browser runner was blocked by Bol's IP filtering. The active measurement route is the existing Codex browser automation, at 09:00 and 21:00 Europe/Amsterdam. This route requires the local Mac and Codex to be available.

Use the configured product and seller, wait for the add-to-cart confirmation, open the basket, choose Aantal > Meer, enter 999, press Tab, then wait for the asynchronous quantity adjustment and corresponding stock warning. Read both dropdowns and spinbuttons. Restore the basket after each measurement.

On 28 September the missing seller for JURABABY KIRA was verified as AT4. Vicco Wicko 80x76 was successfully measured after waiting for the asynchronous adjustment. All sixteen active targets now have saved measurements. The worker ingestion endpoint rejects null, empty and errored quantities, so failed runs cannot become zero-stock readings.

Validation: scheduled fast and manual full synchronization returned success; requests without authentication returned 401. Frontend regression tests cover independent date filters, visibility, overlapping refreshes, network failures and signed-out state. Run `node tests/automatic-refresh.cjs`.
