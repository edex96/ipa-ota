import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import express from 'express'
import multer from 'multer'
import QRCode from 'qrcode'

import { inspectIpa, buildManifest } from './lib/ipa.js'
import { homePage, installPage, passwordPage, errorPage } from './lib/views.js'
import {
  UPLOAD_DIR,
  bumpInstalls,
  dirFor,
  linkBlocked,
  listMeta,
  newId,
  readMeta,
  removeUpload,
  saveMeta,
  tokenFor,
} from './lib/store.js'

const PORT = Number(process.env.PORT || 3000)
// Behind a reverse proxy, bind to loopback so the port is not reachable from outside.
const HOST = process.env.HOST || '0.0.0.0'
const MAX_MB = Number(process.env.MAX_MB || 1024)

const app = express()
app.set('trust proxy', true)
app.use(express.urlencoded({ extended: false }))
// Mounted under /assets so the reverse proxy can expose exactly this prefix without auth —
// install pages are public and still need their css/js.
app.use('/assets', express.static(path.join(process.cwd(), 'public', 'assets')))

const upload = multer({
  dest: path.join(process.cwd(), 'data', 'tmp'),
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    /\.ipa$/i.test(file.originalname) ? cb(null, true) : cb(new Error('Only .ipa files accepted')),
}).single('ipa')

/**
 * PUBLIC_URL wins; otherwise trust the request. Behind a tunnel this resolves to
 * the public https origin, which is exactly what the manifest must contain.
 */
const publicBase = (req) =>
  (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')

const send = (res, { code, html }) => res.status(code).type('html').send(html)

/** Resolves the upload and enforces password + expiry/limit. */
async function guard(req, res) {
  const meta = await readMeta(req.params.id)
  if (!meta) {
    send(res, errorPage('No such link.', 404))
    return null
  }
  if (meta.token && req.query.k !== meta.token) {
    res.status(401).type('html').send(passwordPage(meta.id))
    return null
  }
  return meta
}

app.get('/', async (req, res, next) => {
  try {
    res.type('html').send(homePage(await listMeta(), publicBase(req)))
  } catch (err) {
    next(err)
  }
})

app.post('/upload', (req, res) => {
  upload(req, res, async (err) => {
    if (err)
      return send(
        res,
        errorPage(
          err.code === 'LIMIT_FILE_SIZE'
            ? `File is larger than the ${MAX_MB} MB limit — raise it with MAX_MB=2048.`
            : err.message,
        ),
      )
    if (!req.file) return send(res, errorPage('No file received.'))

    const id = newId()
    try {
      const app_ = await inspectIpa(req.file.path)
      await fs.mkdir(dirFor(id), { recursive: true })
      await fs.rename(req.file.path, path.join(dirFor(id), 'app.ipa'))
      if (app_.iconBuffer) await fs.writeFile(path.join(dirFor(id), 'icon.png'), app_.iconBuffer)

      const days = Number(req.body.days || 0)
      const maxInstalls = Number(req.body.maxInstalls || 0)
      const password = (req.body.password || '').trim()
      const { iconBuffer, ...appMeta } = app_

      await saveMeta({
        id,
        createdAt: new Date().toISOString(),
        fileName: req.file.originalname,
        size: req.file.size,
        installs: 0,
        maxInstalls: maxInstalls > 0 ? maxInstalls : null,
        expiresAt: days > 0 ? new Date(Date.now() + days * 864e5).toISOString() : null,
        token: password ? tokenFor(id, password) : null,
        hasIcon: !!iconBuffer,
        app: appMeta,
      })

      const q = password ? `?k=${tokenFor(id, password)}` : ''
      const url = `/i/${id}${q}`
      // The progress-bar upload wants a target to navigate to, not a 302 body.
      if (req.get('X-Requested-With') === 'xhr') return res.json({ url, id })
      res.redirect(url)
    } catch (e) {
      await removeUpload(id)
      await fs.rm(req.file.path, { force: true })
      send(res, errorPage(e.message))
    }
  })
})

app.post('/i/:id/unlock', async (req, res) => {
  const meta = await readMeta(req.params.id)
  if (!meta) return send(res, errorPage('No such link.', 404))
  const token = tokenFor(meta.id, (req.body.password || '').trim())
  if (token !== meta.token)
    return res.status(401).type('html').send(passwordPage(meta.id, 'Wrong password.'))
  res.redirect(`/i/${meta.id}?k=${token}`)
})

app.get('/i/:id', async (req, res, next) => {
  try {
    const meta = await guard(req, res)
    if (!meta) return

    const base = publicBase(req)
    const key = meta.token || ''
    const suffix = key ? `?k=${key}` : ''
    const manifestUrl = `${base}/i/${meta.id}/manifest.plist${suffix}`
    const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`

    res.type('html').send(
      installPage({
        meta,
        base,
        key,
        installUrl,
        manifestUrl,
        // bare URL, like the copy button: a photo of the screen should not leak the token
        qr: await QRCode.toDataURL(`${base}/i/${meta.id}`, { margin: 1, width: 400 }),
        blocked: linkBlocked(meta),
        insecure: !base.startsWith('https://'),
      }),
    )
  } catch (err) {
    next(err)
  }
})

app.get('/i/:id/manifest.plist', async (req, res, next) => {
  try {
    const meta = await guard(req, res)
    if (!meta) return
    const blocked = linkBlocked(meta)
    if (blocked) return res.status(410).type('text').send(blocked)

    const base = publicBase(req)
    const suffix = meta.token ? `?k=${meta.token}` : ''
    res.type('application/xml').send(
      buildManifest({
        ipaUrl: `${base}/i/${meta.id}/app.ipa${suffix}`,
        iconUrl: meta.hasIcon ? `${base}/i/${meta.id}/icon.png${suffix}` : null,
        bundleId: meta.app.bundleId,
        version: meta.app.version || meta.app.build,
        title: meta.app.name,
      }),
    )
  } catch (err) {
    next(err)
  }
})

app.get('/i/:id/app.ipa', async (req, res, next) => {
  try {
    const meta = await guard(req, res)
    if (!meta) return
    const blocked = linkBlocked(meta)
    if (blocked) return res.status(410).type('text').send(blocked)

    // iOS hitting the payload means an install is actually happening.
    await bumpInstalls(meta.id)
    res.type('application/octet-stream').sendFile(path.join(dirFor(meta.id), 'app.ipa'))
  } catch (err) {
    next(err)
  }
})

app.get('/i/:id/icon.png', async (req, res, next) => {
  try {
    const meta = await guard(req, res)
    if (!meta) return
    res.type('png').sendFile(path.join(dirFor(meta.id), 'icon.png'))
  } catch (err) {
    next(err)
  }
})

// Deliberately not under /i/ — that prefix is public so iOS can fetch manifests,
// while everything else sits behind the reverse proxy's auth.
app.post('/delete/:id', async (req, res) => {
  await removeUpload(req.params.id)
  res.redirect('/')
})

app.use((err, _req, res, _next) => {
  console.error(err)
  send(res, errorPage(err.message || 'Unexpected error', 500))
})

await fs.mkdir(UPLOAD_DIR, { recursive: true })
await fs.mkdir(path.join(process.cwd(), 'data', 'tmp'), { recursive: true })

app.listen(PORT, HOST, () => {
  const lan =
    HOST === '0.0.0.0'
      ? Object.values(os.networkInterfaces())
          .flat()
          .find((i) => i && i.family === 'IPv4' && !i.internal)?.address
      : null
  console.log(`\n  IPA OTA server`)
  console.log(`  local   http://localhost:${PORT}`)
  if (lan) console.log(`  lan     http://${lan}:${PORT}`)
  console.log(
    process.env.PUBLIC_URL
      ? `  public  ${process.env.PUBLIC_URL}`
      : `  public  not set — run "pnpm run tunnel" for an https URL iOS will accept\n`,
  )
})
