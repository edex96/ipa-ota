// Delete uploads that are past their expiry, hit their install cap, or are simply old.
// Run from cron: node scripts/prune.js [maxAgeDays]
import { listMeta, removeUpload } from '../lib/store.js'

const maxAgeDays = Number(process.argv[2] || process.env.PRUNE_AFTER_DAYS || 30)
const cutoff = Date.now() - maxAgeDays * 864e5
const now = new Date()

let removed = 0
for (const meta of await listMeta()) {
  const expired = meta.expiresAt && new Date(meta.expiresAt) < now
  const usedUp = meta.maxInstalls && meta.installs >= meta.maxInstalls
  const stale = new Date(meta.createdAt).getTime() < cutoff
  if (!expired && !usedUp && !stale) continue

  await removeUpload(meta.id)
  removed++
  const why = expired ? 'expired' : usedUp ? 'install cap reached' : `older than ${maxAgeDays}d`
  console.log(`removed ${meta.id} (${meta.app?.name || '?'}) — ${why}`)
}
console.log(`${new Date().toISOString()} prune done: ${removed} removed`)
