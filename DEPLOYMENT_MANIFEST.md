# Prime Web Agency deployment manifest

## Canonical application root

Deploy from the repository root containing `server.js` and `package.json`. The nested `prime-web-agency/` folder contains schema references and additive migrations, not a second Node application. `server.js` serves `public/` and starts the PostgreSQL-backed API.

## Render Web Service

- Runtime: Node.js `24.21.0` (pinned in `.node-version`)
- Root directory: repository root
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/api/health`
- The app binds to `0.0.0.0` on the Render-provided `PORT`.
- Use a Render Postgres internal connection URL from the same region. Store it as `DATABASE_URL` in Render's secret environment settings. For internal TLS, add `sslmode=require` to the URL; Render requires TLS for external database connections.

No `render.yaml`, GitHub Actions workflow, database resource, or paid compute resource is defined here. Connect the private GitHub repository in Render after reviewing the release contents.

## Custom domain

In the Render service Settings, add `primewebagency.shop` and follow Render's verification flow. In BigRock, open Orders → select the domain → DNS Records (available only when the domain uses BigRock nameservers). Point the apex `@` to Render's root A record target (`216.24.57.1`) and `www` to the service's assigned `*.onrender.com` hostname with a CNAME. Remove conflicting AAAA records and old website A/forwarding records, but preserve mail MX/TXT records. If another provider hosts the active nameservers, make DNS changes there instead.

## Environment variables

Required: `DATABASE_URL`, `JWT_SECRET`. Render provides `PORT` and `NODE_ENV=production`. Set `MEDIA_STORAGE_DIR=/var/data/prime-web-agency/media` only after mounting a persistent disk at `/var/data`. Keep optional WhatsApp variables in Render's secret store. See `.env.example` for names and safe placeholders only.

## Persistent media

Render's filesystem is ephemeral unless a persistent disk is attached. Persistent disks are available only on paid Render services. Uploaded media in `storage/media/` is runtime data. Mount a disk at `/var/data` or use a durable object-store adapter. Do not copy private uploads into `public/`. Back up media together with PostgreSQL. A disk attached to one service instance is not shared storage for horizontal scaling.

Several `storage/media/` files are currently tracked by Git even though `.gitignore` excludes future untracked files. Inventory and back up these files, copy them into durable storage, and verify referenced media before removing them from a release. A historical archive manifest is tracked in Git history; its working-tree deletion is pending. Review the Git status and intended commit carefully before publishing to GitHub.

## Database rollout

The repository has no automatic migration runner or migration ledger. Current migrations run from `prime-web-agency/migrations/001_gallery_images.sql` through `012_project_workflow.sql`. Before production migration, take and verify a backup, inspect the live schema and migration history, review each unapplied SQL file, then apply only unapplied migrations in numeric order after explicit operator approval. Do not configure migrations to run automatically on deploy. Never run `schema.sql` against an existing database; it is a provisioning reference only.

The health endpoint is read-only. On application startup, however, the existing WhatsApp queue worker begins processing pending database jobs; review queue state and notification settings before first connecting this service to production data.

## Release contents and secrets

The release needs `server.js`, `package.json`, `package-lock.json`, active `public/` assets, reviewed migrations, and required scripts/docs. Run `npm ci`; do not deploy `node_modules/`. Exclude `.git/`, `.vscode/`, all `.env` files, `.local-archive/`, `_backup_archive_*/`, `backups/`, logs, temporary files, database dumps, and local runtime media. `.gitignore` does not remove files already tracked. Never commit real credentials or production backups.
