// Upload form: filename feedback + real progress. Falls back to a plain form post
// if anything here is unavailable.
;(function () {
  const form = document.querySelector('form[data-upload]')
  if (form) {
    const input = form.querySelector('input[type=file]')
    const drop = form.querySelector('.drop')
    const label = form.querySelector('[data-filename]')
    const button = form.querySelector('button')
    const bar = form.querySelector('[data-bar]')
    const fill = form.querySelector('[data-fill]')
    const status = form.querySelector('[data-status]')

    const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB'

    input.addEventListener('change', () => {
      const file = input.files[0]
      drop.classList.toggle('picked', !!file)
      label.textContent = file ? `✓ ${file.name} · ${mb(file.size)}` : ''
    })

    // drag & drop onto the label
    drop.addEventListener('dragover', (e) => {
      e.preventDefault()
      drop.classList.add('over')
    })
    drop.addEventListener('dragleave', () => drop.classList.remove('over'))
    drop.addEventListener('drop', (e) => {
      e.preventDefault()
      drop.classList.remove('over')
      const file = e.dataTransfer.files[0]
      if (!file) return
      const dt = new DataTransfer()
      dt.items.add(file)
      input.files = dt.files
      input.dispatchEvent(new Event('change'))
    })

    form.addEventListener('submit', (e) => {
      if (!input.files[0] || !window.XMLHttpRequest) return // let the browser do it
      e.preventDefault()

      const xhr = new XMLHttpRequest()
      const total = input.files[0].size
      form.classList.add('uploading')
      button.disabled = true
      button.textContent = 'Uploading…'
      bar.hidden = false

      xhr.upload.addEventListener('progress', (ev) => {
        const pct = ev.lengthComputable ? (ev.loaded / ev.total) * 100 : (ev.loaded / total) * 100
        fill.style.width = Math.min(100, pct).toFixed(1) + '%'
        status.textContent = `${mb(ev.loaded)} of ${mb(ev.total || total)} · ${Math.min(100, pct).toFixed(0)}%`
      })
      xhr.upload.addEventListener('load', () => {
        fill.style.width = '100%'
        status.textContent = 'Reading the .ipa…'
      })

      xhr.addEventListener('load', () => {
        let url = null
        try {
          url = JSON.parse(xhr.responseText).url
        } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && url) return void (window.location = url)
        // server rendered an error page (or something unexpected) — show it
        document.open()
        document.write(xhr.responseText || `Upload failed (HTTP ${xhr.status})`)
        document.close()
      })
      xhr.addEventListener('error', () => fail('Network error during upload.'))
      xhr.addEventListener('abort', () => fail('Upload cancelled.'))

      function fail(msg) {
        form.classList.remove('uploading')
        button.disabled = false
        button.textContent = 'Upload & create link'
        status.textContent = msg
        status.classList.add('failed')
      }

      xhr.open('POST', form.action)
      xhr.setRequestHeader('X-Requested-With', 'xhr')
      xhr.send(new FormData(form))
    })
  }

  // Copy-link buttons
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy === 'self' ? window.location.href : btn.dataset.copy
      const done = () => {
        const was = btn.textContent
        btn.textContent = 'Copied'
        btn.classList.add('copied')
        setTimeout(() => {
          btn.textContent = was
          btn.classList.remove('copied')
        }, 1600)
      }
      try {
        await navigator.clipboard.writeText(text)
        done()
      } catch {
        // clipboard API needs a secure context; fall back to a hidden textarea
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.append(ta)
        ta.select()
        try {
          document.execCommand('copy')
          done()
        } catch {
          btn.textContent = 'Press ⌘C'
          return
        } finally {
          ta.remove()
        }
      }
    })
  }
})()
