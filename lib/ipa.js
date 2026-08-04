import yauzl from 'yauzl'
import plist from 'simple-plist'
import { fromCgbi } from './pngfix.js'

const INFO_RE = /^Payload\/[^/]+\.app\/Info\.plist$/
const PROV_RE = /^Payload\/[^/]+\.app\/embedded\.mobileprovision$/
const ICON_RE = /^Payload\/[^/]+\.app\/[^/]*(AppIcon|Icon)[^/]*\.png$/i

function openZip(path) {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (err, zip) =>
      err
        ? reject(new Error('Could not read the archive — an .ipa must be a valid zip file.'))
        : resolve(zip),
    )
  })
}

/** Single pass over the archive, buffering only the entries we care about. */
function readWanted(path, want) {
  return openZip(path).then(
    (zip) =>
      new Promise((resolve, reject) => {
        const found = new Map()
        zip.on('entry', (entry) => {
          if (entry.fileName.endsWith('/') || !want(entry.fileName)) return zip.readEntry()
          zip.openReadStream(entry, (err, stream) => {
            if (err) return reject(err)
            const chunks = []
            stream.on('data', (c) => chunks.push(c))
            stream.on('error', reject)
            stream.on('end', () => {
              found.set(entry.fileName, Buffer.concat(chunks))
              zip.readEntry()
            })
          })
        })
        zip.on('error', reject)
        zip.on('end', () => resolve(found))
        zip.readEntry()
      }),
  )
}

/**
 * An .mobileprovision is a DER-encoded CMS blob with an XML plist payload.
 * Rather than pull in an ASN.1 parser we slice out the plist directly.
 */
function parseProvisioning(buf) {
  const start = buf.indexOf('<?xml')
  const end = buf.indexOf('</plist>')
  if (start === -1 || end === -1) return null
  try {
    return plist.parse(buf.subarray(start, end + 8).toString('utf8'))
  } catch {
    return null
  }
}

function profileType(prov) {
  if (!prov) return 'unsigned / unreadable profile'
  const ents = prov.Entitlements || {}
  if (prov.ProvisionsAllDevices) return 'enterprise'
  if (ents['get-task-allow']) return 'development'
  if (Array.isArray(prov.ProvisionedDevices) && prov.ProvisionedDevices.length) return 'ad-hoc'
  return 'app-store'
}

/** Biggest icon wins, but prefer the standard high-res home-screen sizes. */
function pickIcon(icons) {
  if (!icons.length) return null
  const preferred = icons.filter(([name]) => /(60x60@2x|60x60@3x|76x76@2x|83\.5x83\.5)/i.test(name))
  const pool = preferred.length ? preferred : icons
  return pool.sort((a, b) => b[1].length - a[1].length)[0]
}

export async function inspectIpa(path) {
  const files = await readWanted(
    path,
    (n) => INFO_RE.test(n) || PROV_RE.test(n) || ICON_RE.test(n),
  )

  const infoEntry = [...files].find(([n]) => INFO_RE.test(n))
  if (!infoEntry) throw new Error('Not a valid .ipa — no Payload/*.app/Info.plist inside')

  const info = plist.parse(infoEntry[1])
  const provEntry = [...files].find(([n]) => PROV_RE.test(n))
  const prov = provEntry ? parseProvisioning(provEntry[1]) : null
  const icon = pickIcon([...files].filter(([n]) => ICON_RE.test(n)))
  // Xcode ships CgBI-optimized icons that no desktop browser can render; null means
  // it was a variant we cannot convert, so we show no icon rather than a broken one.
  const iconBuffer = icon ? fromCgbi(icon[1]) : null

  const platforms = info.CFBundleSupportedPlatforms || []
  const type = profileType(prov)
  const devices = Array.isArray(prov?.ProvisionedDevices) ? prov.ProvisionedDevices : []
  const expires = prov?.ExpirationDate ? new Date(prov.ExpirationDate) : null

  const warnings = []
  if (platforms.includes('iPhoneSimulator'))
    warnings.push('This is a Simulator build — it can never install on a physical device.')
  if (type === 'app-store')
    warnings.push(
      'Signed with an App Store distribution profile — iOS will refuse to install it over the air. Re-sign as Ad Hoc, Development or Enterprise.',
    )
  if (!prov)
    warnings.push(
      'No readable embedded.mobileprovision — the app is probably unsigned and will not install.',
    )
  if (expires && expires < new Date())
    warnings.push(`Provisioning profile expired on ${expires.toISOString().slice(0, 10)}.`)
  if (type === 'enterprise')
    warnings.push(
      'Enterprise build: after installing, trust the developer in Settings › General › VPN & Device Management.',
    )
  if (type === 'development')
    warnings.push(
      'Development build: on iOS 16+ enable Settings › Privacy & Security › Developer Mode, then reboot.',
    )
  if (type === 'ad-hoc' || type === 'development')
    warnings.push(
      `Only the ${devices.length} UDID(s) baked into the profile can install this build.`,
    )

  return {
    name: info.CFBundleDisplayName || info.CFBundleName || info.CFBundleExecutable || 'App',
    bundleId: info.CFBundleIdentifier,
    version: info.CFBundleShortVersionString || '',
    build: info.CFBundleVersion || '',
    minOs: info.MinimumOSVersion || '',
    platforms,
    sdk: info.DTSDKName || '',
    profile: prov
      ? {
          type,
          name: prov.Name || '',
          team: prov.TeamName || '',
          teamIds: prov.TeamIdentifier || [],
          appId: prov.Entitlements?.['application-identifier'] || '',
          created: prov.CreationDate ? new Date(prov.CreationDate).toISOString() : null,
          expires: expires ? expires.toISOString() : null,
          allDevices: !!prov.ProvisionsAllDevices,
          devices,
        }
      : { type, devices: [] },
    iconName: iconBuffer ? icon[0].split('/').pop() : null,
    iconBuffer,
    warnings,
  }
}

/** Apple's OTA manifest. iOS fetches this via itms-services:// and installs what it points at. */
export function buildManifest({ ipaUrl, bundleId, version, title, iconUrl }) {
  const items = [
    {
      assets: [
        { kind: 'software-package', url: ipaUrl },
        ...(iconUrl
          ? [
              { kind: 'display-image', 'needs-shine': false, url: iconUrl },
              { kind: 'full-size-image', 'needs-shine': false, url: iconUrl },
            ]
          : []),
      ],
      metadata: {
        'bundle-identifier': bundleId,
        'bundle-version': version || '1.0',
        kind: 'software',
        title,
      },
    },
  ]
  return plist.stringify({ items })
}
