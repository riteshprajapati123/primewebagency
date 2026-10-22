# Media storage

Uploaded image files are stored outside `public/`. Development defaults to `storage/media/`; the public `/media/:storageKey` route serves a file only when its generated key exists in `public.gallery_images`.

The upload API accepts JPEG, PNG, WebP, and GIF, checks the file signature against the declared content type, caps files at 5 MiB, and generates UUID filenames. The database stores metadata and the generated key, not an absolute filesystem path.

For production, set `MEDIA_STORAGE_DIR` to durable private storage outside `public/`. Render's local filesystem is ephemeral by default; a persistent disk is supported on paid web services and must be mounted at `/var/data` with `MEDIA_STORAGE_DIR=/var/data/prime-web-agency/media`. Back up that volume together with PostgreSQL. A Render persistent disk is attached to one service instance, so this file storage design is not suitable for horizontal scaling; use shared object storage/CDN for multiple instances. Do not run a production migration until you have reviewed its SQL, taken and verified a database backup, and explicitly approved the change.

The additive database migration is `prime-web-agency/migrations/001_gallery_images.sql`. The application uses the same `DATABASE_URL` loaded by `dotenv` as the rest of the API.

## Local admin bootstrap

Admin access is never granted from the public registration form. To promote an existing active customer on a local PostgreSQL instance, run:

```powershell
npm.cmd run admin:promote -- <exact-existing-email>
```

The utility refuses non-local database hosts, requires exactly one active customer match, displays only a masked email and account metadata, and waits for the operator to type `PROMOTE <exact-email>`. It updates only that account and verifies the affected row before commit. Do not run it unless you intend to grant that account administrator access.

## Customer service requests and private attachments

The additive migration `prime-web-agency/migrations/003_lead_requests_and_attachments.sql` extends the existing `leads` table and creates `lead_attachments`. Run it against the application's configured PostgreSQL database before deploying the updated server. Existing lead records are retained; existing media files are not modified. Apply once with:

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f prime-web-agency/migrations/003_lead_requests_and_attachments.sql
```

The customer inquiry endpoint stores validated JPEG, PNG, and WebP files under generated UUID names in `MEDIA_STORAGE_DIR`. Attachment metadata is stored in PostgreSQL and files remain outside the public web root. Only an authenticated administrator can retrieve them through the lead attachment API. Configure `MEDIA_STORAGE_DIR` to a persistent private volume in production.

## WhatsApp Cloud API notifications

Automatic sending requires a server-side Cloud API token, Business Phone Number ID, and supported Graph API version. Choose the business recipient in the Admin Panel; if blank, the server falls back to `WHATSAPP_NOTIFY_RECIPIENT`/`WHATSAPP_BUSINESS_RECIPIENT`, then the existing Brand Settings WhatsApp contact. `WHATSAPP_APP_SECRET` and `WHATSAPP_WEBHOOK_VERIFY_TOKEN` are used for signed status webhooks. A WhatsApp Business Account ID is not needed by the implemented phone-number message endpoints. Keep tokens and webhook secrets in server environment only; never put them in browser code or commit them. Use placeholders in deployment templates, not real credentials.

A Graph API acceptance is recorded as `accepted`; it is not reported as delivered. Signed webhook callbacks update later delivery states. If automatic sending is not configured or fails, the lead and attachments remain saved and the Admin Panel shows the status and retry action. The customer confirmation provides a manual WhatsApp fallback when a recipient is configured. A manual `wa.me` link opens a prefilled message; it does not send automatically or attach files.

## WhatsApp delivery, settings, and durable queue

Apply `prime-web-agency/migrations/004_whatsapp_notification_queue.sql` after migrations 001–003. It creates singleton notification settings and a durable PostgreSQL queue; it does not change existing customer, lead, project, service, or media rows.

Configure the server environment (never frontend files) with placeholders like these:

```dotenv
WHATSAPP_CLOUD_API_TOKEN=<Meta system-user access token>
WHATSAPP_PHONE_NUMBER_ID=<Cloud API phone-number ID>
WHATSAPP_API_VERSION=<supported Graph API version, for example vXX.X>
WHATSAPP_APP_SECRET=<Meta app secret for signed webhooks>
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<private webhook verification string>
```

The older `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_BUSINESS_PHONE_NUMBER_ID` names remain supported as aliases. `WHATSAPP_NOTIFY_RECIPIENT` or `WHATSAPP_BUSINESS_RECIPIENT` is an optional server-side recipient fallback. The number saved in Admin Panel notification settings takes precedence; if empty, the existing Brand Settings WhatsApp contact is used next. Do not put access tokens in PostgreSQL brand settings or browser code.

For outbound notifications the application uses approved WhatsApp message templates, because a business-initiated notification may not use free-form text outside the customer service window. Create and get approval for a business notification template (default name `prime_new_lead`, language `en`) with this body and six text parameters in order: `New request {{1}}. Customer: {{2}}. Phone: {{3}}. Service: {{4}}. Price: {{5}}. Message and attachments: {{6}}.` The parameters are request reference, customer name, phone, service, quoted price, and message plus attachment count. If customer confirmations are enabled, also approve the customer template (default `prime_request_received`, language `en`) with two body parameters: `We received your request {{1}} for {{2}}. Our team will contact you soon.` The parameters are request reference and agency name. Configure the exact approved names and language codes in the Admin Panel. A rejected or missing template is reported from the provider and does not roll back the saved lead.

Notification jobs and attachment jobs are committed with their lead or project records. A small in-process poller claims due jobs with PostgreSQL row locks and `SKIP LOCKED`, so multiple server instances do not claim the same pending row at once. Scheduled jobs survive restarts. The scheduler rechecks current toggles and timezone windows before sending, supports overnight windows, retries transient provider failures with bounded backoff, and leaves permanent provider rejections visible for an administrator retry. Provider API acceptance is shown as `accepted`, never as delivered; signed webhook status callbacks can advance it to sent, delivered, read, or failed.

The Admin Panel offers **Test Connection** (a real Graph API phone-number lookup) and **Send Test Message** (a real message using the configured approved notification template). Test messages are rate limited. A successful API response means WhatsApp accepted the test; delivery is only confirmed by a later webhook event. No automatic delivery can be verified until real Meta credentials, an approved template, the correct phone-number ID, recipient, and webhook configuration are provided.

## Advertisement management

Apply `prime-web-agency/migrations/005_advertisements.sql` and `006_advertisement_placements.sql` once before using the Ads Management section. They add advertisements, private advertisement media metadata, and placement switches without changing existing rows. Uploaded media uses the configured private `MEDIA_STORAGE_DIR`, is addressed by generated UUID names through `/media/`, and is capped at 5 MiB for images and 8 MiB for MP4/WebM video. Ad deletion removes the ad record only; media is retained to avoid deleting any file still in use. Public ads are returned only when their placement and ad are enabled, published, and within the optional schedule. Admin access is available in the Admin Panel navigation after signing in as an administrator.

`prime-web-agency/migrations/007_approved_reviews.sql` adds an empty review table for admin-managed testimonials. Only reviews with recorded attribution consent and admin approval are included by the public endpoint. No reviews are pre-populated.

On Windows PowerShell, apply the WhatsApp migration from the project root with:

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f prime-web-agency/migrations/004_whatsapp_notification_queue.sql
```

Confirm both `public.whatsapp_notification_settings` and `public.whatsapp_notification_queue` exist before restarting. The migration is transactional and idempotent for the tables/indexes it creates; it does not drop or rebuild existing tables. Restart with `npm.cmd start` after configuring the server-side environment. The included package does not define a migration runner, so apply SQL explicitly with `psql` or pgAdmin Query Tool.
