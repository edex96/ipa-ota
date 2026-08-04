const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`
const day = (s) => (s ? new Date(s).toISOString().slice(0, 10) : '—')

function layout(title, body) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head><body>
<main>${body}</main>
</body></html>`
}

const TYPE_HINT = {
  'ad-hoc': 'Installs only on the UDIDs baked into the profile.',
  development: 'Needs Developer Mode on iOS 16+.',
  enterprise: 'Any device, but the certificate must be trusted after install.',
  'app-store': 'Cannot be installed over the air.',
}

export function homePage(uploads, base) {
  const rows = uploads
    .map(
      (u) => `<tr>
  <td><a href="/i/${u.id}">${esc(u.app.name)}</a><br><small>${esc(u.app.bundleId)}</small></td>
  <td>${esc(u.app.version)}${u.app.build ? ` (${esc(u.app.build)})` : ''}</td>
  <td><span class="tag t-${esc(u.app.profile.type)}">${esc(u.app.profile.type)}</span></td>
  <td>${mb(u.size)}</td>
  <td>${u.installs || 0}${u.maxInstalls ? ` / ${u.maxInstalls}` : ''}</td>
  <td>${day(u.expiresAt) === '—' ? 'never' : day(u.expiresAt)}</td>
  <td><form method="post" action="/delete/${u.id}" onsubmit="return confirm('Delete ${esc(u.app.name)}?')"><button class="link danger">delete</button></form></td>
</tr>`,
    )
    .join('')

  return layout(
    'IPA OTA — self-hosted',
    `<h1>IPA over-the-air install</h1>
<p class="sub">Upload an <code>.ipa</code>, get a link your iPhone can install from Safari. Serving on <code>${esc(base)}</code>.</p>

<form class="card" method="post" action="/upload" enctype="multipart/form-data">
  <label class="drop">
    <input type="file" name="ipa" accept=".ipa" required>
    <span>Choose an .ipa file</span>
  </label>
  <div class="grid">
    <label>Password <small>optional</small>
      <input type="password" name="password" autocomplete="off" placeholder="leave empty for none">
    </label>
    <label>Expires in <small>days, 0 = never</small>
      <input type="number" name="days" value="7" min="0" max="365">
    </label>
    <label>Max installs <small>0 = unlimited</small>
      <input type="number" name="maxInstalls" value="0" min="0">
    </label>
  </div>
  <button class="primary">Upload &amp; create link</button>
</form>

${
  uploads.length
    ? `<h2>Uploads</h2>
<div class="card scroll"><table>
<thead><tr><th>App</th><th>Version</th><th>Signing</th><th>Size</th><th>Installs</th><th>Expires</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>`
    : '<p class="sub">No uploads yet.</p>'
}`,
  )
}

export function installPage({ meta, base, installUrl, manifestUrl, qr, blocked, insecure, key }) {
  const a = meta.app
  const p = a.profile
  const suffix = key ? `?k=${key}` : ''

  const warn = a.warnings.map((w) => `<li>${esc(w)}</li>`).join('')

  const banner = blocked
    ? `<div class="banner err"><strong>Unavailable.</strong> ${esc(blocked)}</div>`
    : insecure
      ? `<div class="banner err"><strong>HTTPS required.</strong> iOS ignores <code>itms-services://</code> manifests served over plain HTTP.
         Expose this server over HTTPS (e.g. <code>pnpm run tunnel</code>) and reopen the link from the public URL.</div>`
      : ''

  const action = blocked
    ? ''
    : `<a class="install ${insecure ? 'disabled' : ''}" href="${esc(installUrl)}">Install ${esc(a.name)}</a>
       <p class="sub center">Open this page in <strong>Safari</strong> on the iPhone. Other browsers cannot trigger an install.</p>
       ${qr ? `<div class="qr"><img src="${esc(qr)}" alt="QR code to this page" width="200" height="200"><small>Scan with the iPhone camera</small></div>` : ''}`

  return layout(
    `Install ${a.name}`,
    `<div class="head">
  ${meta.hasIcon ? `<img class="icon" src="/i/${meta.id}/icon.png${suffix}" alt="" width="72" height="72">` : '<div class="icon ph"></div>'}
  <div>
    <h1>${esc(a.name)}</h1>
    <p class="sub">${esc(a.version)}${a.build ? ` (${esc(a.build)})` : ''} · ${esc(a.bundleId)}</p>
  </div>
</div>

${banner}
${action}

<div class="card">
  <h2>Build</h2>
  <dl>
    <dt>Signing</dt><dd><span class="tag t-${esc(p.type)}">${esc(p.type)}</span> <small>${esc(TYPE_HINT[p.type] || '')}</small></dd>
    <dt>Profile</dt><dd>${esc(p.name || '—')}</dd>
    <dt>Team</dt><dd>${esc(p.team || '—')}${p.teamIds?.length ? ` <small>(${esc(p.teamIds.join(', '))})</small>` : ''}</dd>
    <dt>Expires</dt><dd>${day(p.expires) === '—' ? '—' : esc(day(p.expires))}</dd>
    <dt>Min iOS</dt><dd>${esc(a.minOs || '—')}</dd>
    <dt>SDK</dt><dd>${esc(a.sdk || '—')}</dd>
    <dt>Size</dt><dd>${mb(meta.size)}</dd>
    <dt>Installs</dt><dd>${meta.installs || 0}${meta.maxInstalls ? ` of ${meta.maxInstalls}` : ''}</dd>
  </dl>
</div>

${
  p.devices?.length
    ? `<details class="card"><summary>${p.devices.length} provisioned UDID${p.devices.length > 1 ? 's' : ''}</summary>
<div class="scroll"><ul class="udids">${p.devices.map((d) => `<li><code>${esc(d)}</code></li>`).join('')}</ul></div></details>`
    : p.allDevices
      ? '<p class="sub">Enterprise profile — provisions all devices, no UDID list.</p>'
      : ''
}

${warn ? `<div class="card notes"><h2>Before you install</h2><ul>${warn}</ul></div>` : ''}

<details class="card"><summary>Raw links</summary>
<ul class="links">
  <li><code>${esc(installUrl)}</code></li>
  <li><a href="${esc(manifestUrl)}">manifest.plist</a></li>
  <li><a href="/i/${meta.id}/app.ipa${suffix}">app.ipa</a></li>
</ul></details>

<p class="sub"><a href="/">← all uploads</a></p>`,
  )
}

export function passwordPage(id, error) {
  return layout(
    'Password required',
    `<h1>Password required</h1>
${error ? `<div class="banner err">${esc(error)}</div>` : ''}
<form class="card" method="post" action="/i/${esc(id)}/unlock">
  <label>Password<input type="password" name="password" autofocus required></label>
  <button class="primary">Unlock</button>
</form>`,
  )
}

export function errorPage(msg, code = 400) {
  return {
    code,
    html: layout(
      'Error',
      `<h1>Something went wrong</h1><div class="banner err">${esc(msg)}</div><p class="sub"><a href="/">← back</a></p>`,
    ),
  }
}
