# QCDashboard

Production planning and QC dashboard for Siam Carpets.

## Source layout

- `index.html`: GitHub Pages frontend.
- `apps-script/index.html`: Apps Script web app frontend. Keep this file identical to the root `index.html`.
- `apps-script/Code.js`: Google Apps Script API and Google Sheets persistence.
- `apps-script/appsscript.json`: Apps Script manifest.
- `scripts/audit-html.js`: static DOM and inline-handler integrity check.

## Development safety

Production must stay on its existing numbered deployment while changes are tested through the `@HEAD`
development deployment. Do not create a second Production deployment.

Validate before every push:

```powershell
node C:\Users\walai\.skywork\skills\siam-carpets-production-workflow\scripts\validate_inline_js.js apps-script\index.html
node --check apps-script\Code.js
node scripts\audit-html.js index.html
git diff --check
```

## Apps Script properties

Configure these in Apps Script Project Settings. Never commit their values:

- `LINE_CHANNEL_ACCESS_TOKEN`: LINE Messaging API channel access token.
- `LINE_GROUP_ID`: optional group or room target. Blank uses broadcast fallback.
- `DASHBOARD_WRITE_KEY`: optional phased protection for write/delete endpoints.
- `SUPABASE_URL`: optional Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: optional server-side Supabase service role key.

When `DASHBOARD_WRITE_KEY` is enabled, enter the same value in the dashboard connection settings on
each authorized browser. Read-only dashboard endpoints remain available without it.

## Data compatibility

Existing order, QC, issue, template, and staff sheets are preserved. New shared browser data is stored
in `DashboardSharedRecords` only after a user changes that data. An initial read does not create the
sheet or overwrite an existing browser cache.
