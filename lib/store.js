import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import path from 'node:path'

export const UPLOAD_DIR = path.join(process.cwd(), 'data', 'uploads')

export const newId = () => crypto.randomBytes(4).toString('hex')

/** Derived from the password, so it is safe to hand out in URLs iOS can fetch cookie-free. */
export const tokenFor = (id, password) =>
  crypto.createHash('sha256').update(`${id}:${password}`).digest('hex').slice(0, 24)

export const dirFor = (id) => path.join(UPLOAD_DIR, id)

export async function saveMeta(meta) {
  await fs.mkdir(dirFor(meta.id), { recursive: true })
  await fs.writeFile(path.join(dirFor(meta.id), 'meta.json'), JSON.stringify(meta, null, 2))
}

export async function readMeta(id) {
  if (!/^[a-f0-9]{8}$/.test(id)) return null
  try {
    return JSON.parse(await fs.readFile(path.join(dirFor(id), 'meta.json'), 'utf8'))
  } catch {
    return null
  }
}

export async function listMeta() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true })
  const ids = await fs.readdir(UPLOAD_DIR)
  const all = await Promise.all(ids.map(readMeta))
  return all.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function removeUpload(id) {
  if (!/^[a-f0-9]{8}$/.test(id)) return
  await fs.rm(dirFor(id), { recursive: true, force: true })
}

/** Returns a reason string when the link is no longer usable, else null. */
export function linkBlocked(meta) {
  if (meta.expiresAt && new Date(meta.expiresAt) < new Date()) return 'This link has expired.'
  if (meta.maxInstalls && meta.installs >= meta.maxInstalls)
    return `This link hit its install limit (${meta.maxInstalls}).`
  return null
}

export async function bumpInstalls(id) {
  const meta = await readMeta(id)
  if (!meta) return
  meta.installs = (meta.installs || 0) + 1
  meta.lastInstallAt = new Date().toISOString()
  await saveMeta(meta)
}
