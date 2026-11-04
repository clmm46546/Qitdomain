# Domain History license server

The extension checks licenses through this small Node.js server. It uses only
Node built-ins and stores license records in `data/licenses.json`; only a
SHA-256 hash of each license key is stored.

## Run locally

Requires Node.js 20 or newer. In PowerShell:

```powershell
$token = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
$token
```

Save that value privately. In PowerShell window 1, set it and start the server:

```powershell
$env:LICENSE_ADMIN_TOKEN = 'paste-the-generated-token-here'
npm --prefix .\license-server start
```

Keep the admin token private. The local server listens on `127.0.0.1:8787`.
In PowerShell window 2, set the same token before running the admin commands
below. Load the extension in Chrome/Edge and enter a key created through the
admin API. License data is written to `license-server/data/licenses.json`.

## Create, list, and revoke licenses

Create a license (omit `expiresAt` for a license without a set expiry):

```powershell
$headers = @{ Authorization = "Bearer $env:LICENSE_ADMIN_TOKEN" }
$license = Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8787/v1/admin/licenses `
  -Headers $headers -ContentType 'application/json' `
  -Body (@{ maxDevices = 1; note = 'Customer name' } | ConvertTo-Json)
$license
```

The response contains the full license key. Save it before giving it to the
customer; it is not stored in plaintext and cannot be recovered later.

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8787/v1/admin/licenses -Headers $headers

Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/v1/admin/licenses/$($license.license.id)/revoke" `
  -Headers $headers

# Free device activations if a customer replaces or resets a device.
Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:8787/v1/admin/licenses/$($license.license.id)/reset-devices" `
  -Headers $headers
```

## Deploy for customers

The local URL is for development only. Before distributing the extension:

1. Deploy `license-server` as a single server instance behind HTTPS/TLS
   termination, on a host that provides persistent disk storage. Set
   `LICENSE_ADMIN_TOKEN` to a new random value (at least 32 bytes),
   `LICENSE_HOST=0.0.0.0`, and `LICENSE_DATA_FILE` to a persistent path.
2. Set `apiBaseUrl` in `license-config.js` to the server's HTTPS URL.
3. Replace the localhost entry in `host_permissions` in `manifest.json` with
   `https://your-license-host.example/*`, then reload and distribute the
   updated extension.
4. Back up the persistent license database and keep the admin token out of the
   extension and source control.

The server does not enable CORS or expose the admin token to the extension.
The extension checks the server at activation and every 60 seconds while the
management page is open. If the server is unreachable, use is blocked. A
revoked license is rejected on the next check; this protects ordinary use, but
cannot prevent a technically capable user from modifying locally installed
extension code.

## API

- `POST /v1/admin/licenses` — create a license. Admin bearer token required.
- `GET /v1/admin/licenses` — list license status and device counts.
- `POST /v1/admin/licenses/:id/revoke` — revoke a license immediately.
- `POST /v1/admin/licenses/:id/reset-devices` — free all device activations.
- `POST /v1/activate` — activate a key on a device.
- `POST /v1/verify` — check that the key and device remain active.
- `GET /health` — health check.
