# ipa-ota

A ~400-line self-hosted Diawi for `.ipa` files. Upload a build, get a link an iPhone can install
from Safari. Same mechanism Diawi uses: an Apple OTA `manifest.plist` handed to iOS over
`itms-services://`.

```
pnpm install
pnpm start            # http://localhost:3000
```

## The HTTPS requirement

iOS **silently ignores** `itms-services://` manifests that point at plain HTTP, and rejects
self-signed certificates. So `localhost` alone cannot install anything — you need a public HTTPS
origin. Easiest route:

```
brew install cloudflared
pnpm start            # terminal 1
pnpm run tunnel       # terminal 2 → prints https://something.trycloudflare.com
```

Open the printed HTTPS URL on the iPhone and upload/install from there. The server derives every
URL it puts in the manifest from `X-Forwarded-Proto` + `Host`, so a tunnel needs zero config.
If you have your own domain and TLS, pin it instead:

```
PUBLIC_URL=https://ota.yourdomain.com pnpm start
```

The install page shows a red **HTTPS required** banner and disables the button whenever it is
being served over HTTP, so you can't get a confusing silent failure.

## What it does

- **Parses the IPA** — one streaming pass with `yauzl` pulls `Info.plist`,
  `embedded.mobileprovision` and the app icon out of `Payload/*.app/`.
- **Reads the provisioning profile** — the `.mobileprovision` is a DER/CMS blob with an XML plist
  inside; the plist is sliced out directly (no ASN.1 dependency) to get the profile name, team,
  expiry date and the provisioned UDID list. Signing type is inferred:
  `ProvisionsAllDevices` → enterprise, `get-task-allow` → development, UDIDs present → ad-hoc,
  neither → App Store (won't install OTA).
- **Warns before you waste a trip to the phone** — Simulator build, App Store signing, expired
  profile, unsigned binary, plus the trust / Developer Mode steps for the detected signing type.
- **Generates the manifest** on the fly, so the same upload works over localhost, LAN or tunnel
  without regenerating anything.
- **Link options** — optional password, expiry in days, max install count, install counter.
- **QR code** on the install page so you can jump from the desktop to the phone.

## Password model

iOS fetches the manifest and the payload itself, with no cookies and no session. So the password
becomes a token, `sha256(id:password)`, carried as `?k=…` in the manifest and payload URLs. That
token is what's stored on disk — the password itself is never persisted. Wrong or absent token on
any route (page, manifest, ipa, icon) returns the unlock form.

## Layout

```
server.js          routes: upload, install page, manifest.plist, app.ipa, icon, delete
lib/ipa.js         IPA/plist/mobileprovision parsing + OTA manifest generation
lib/store.js       on-disk uploads, tokens, expiry & install-limit checks
lib/views.js       server-rendered HTML
public/style.css   light/dark styling
data/uploads/<id>/ app.ipa, icon.png, meta.json
```

## Config

| Env          | Default | Meaning                                                  |
| ------------ | ------- | -------------------------------------------------------- |
| `PORT`       | `3000`  | listen port                                              |
| `PUBLIC_URL` | unset   | forces the origin used in manifests; else request-derived |
| `MAX_MB`     | `1024`  | upload size limit                                        |

## Deployed instance

Live at **https://ota.example.com** (AlmaLinux 10 box, `REDACTED-HOST`, code in `$OTA_DIR`).

| Piece      | Where                                                                   |
| ---------- | ----------------------------------------------------------------------- |
| Process    | pm2 app `ipa-ota` on `127.0.0.1:3010` (3000 was taken), `ecosystem.config.cjs` |
| Boot       | `pm2-root.service` (enabled) restores from `/root/.pm2/dump.pm2`         |
| Proxy      | `/etc/nginx/conf.d/ota.example.com.conf` — copy of `deploy/nginx.conf`      |
| TLS        | Let's Encrypt `ota.example.com`, certbot auto-renew, HTTP → HTTPS 301  |
| Login      | nginx basic auth, `/etc/nginx/ipa-ota.htpasswd`, user `REDACTED-USER`         |
| Logs       | `/var/log/ipa-ota/{out,err}.log`                                        |
| Prune      | `/etc/cron.d/ipa-ota-prune`, nightly 04:17, drops uploads >30d          |

Redeploy after a push:

```bash
ssh $OTA_SSH 'cd $OTA_DIR && git pull && pnpm install --prod && pm2 restart ipa-ota --update-env'
```

If `deploy/nginx.conf` changed, also copy it up and reload:

```bash
scp deploy/nginx.conf $OTA_SSH:/etc/nginx/conf.d/ota.example.com.conf
ssh $OTA_SSH 'nginx -t && systemctl reload nginx'
```

### Auth boundary

The upload UI is behind basic auth; the install links are not, because iOS fetches the manifest and
the payload itself and has no credentials to send. So:

- **private** — `/` (link list), `/upload`, `/delete/:id`
- **public** — `/i/:id` (install page), `/i/:id/manifest.plist`, `/i/:id/app.ipa`, `/i/:id/icon.png`,
  `/style.css`

An install link is therefore shareable as-is, and a per-link password is the way to lock one down.
Change the login with:

```bash
ssh $OTA_SSH "printf 'REDACTED-USER:%s\n' \"\$(openssl passwd -apr1 'NEWPASS')\" > /etc/nginx/ipa-ota.htpasswd"
```

Because `client_max_body_size` is set in the nginx server block, raising `MAX_MB` in
`ecosystem.config.cjs` past 2048 also means raising it there.

## Scope

This is a local dev-distribution tool: no auth on the upload page, no database, uploads just sit
in `data/`. Don't put it on the open internet as-is — put it behind a tunnel you control, or
add auth in front of `/` and `/upload`.

It also cannot change what iOS will accept. The IPA must already be signed Ad Hoc (with your
device's UDID), Development, or Enterprise. Diawi can't get around that either.
