import zlib from 'node:zlib'

/**
 * Xcode runs app icons through Apple's pngcrush, which emits "iPhone-optimized" PNGs:
 * a private CgBI chunk, IDAT holding a raw deflate stream (no zlib header), channels stored
 * BGRA instead of RGBA, and colour premultiplied by alpha. Safari on the phone reads them;
 * every desktop browser shows a broken image. This converts one back to a standard PNG.
 */

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function* walk(buf) {
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    if (off + 12 + len > buf.length) return
    yield { type, data: buf.subarray(off + 8, off + 8 + len) }
    off += 12 + len
  }
}

export function isCgbi(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return false
  for (const { type } of walk(buf)) {
    if (type === 'CgBI') return true
    if (type === 'IDAT') return false // CgBI always precedes IHDR/IDAT
  }
  return false
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

const paeth = (a, b, c) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Reverse the per-scanline PNG filters in place, returning tightly packed pixel rows. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const row = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null

    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= bpp ? prev[x - bpp] : 0
      const v = row[x]
      cur[x] =
        filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : filter === 4
                  ? v + paeth(a, b, c)
                  : v
    }
  }
  return out
}

/**
 * Returns a standard PNG buffer. Non-CgBI input is passed through untouched;
 * anything this cannot handle (16-bit, palettes, interlacing) returns null so the
 * caller can fall back to no icon rather than serving something broken.
 */
export function fromCgbi(buf) {
  if (!isCgbi(buf)) return buf

  let ihdr = null
  const idat = []
  for (const { type, data } of walk(buf)) {
    if (type === 'IHDR') ihdr = data
    else if (type === 'IDAT') idat.push(data)
  }
  if (!ihdr || !idat.length) return null

  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const depth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) return null

  const bpp = colorType === 6 ? 4 : 3
  let pixels
  try {
    // Apple strips the zlib wrapper, so this is a bare deflate stream.
    pixels = unfilter(zlib.inflateRawSync(Buffer.concat(idat)), width, height, bpp)
  } catch {
    return null
  }

  for (let i = 0; i < pixels.length; i += bpp) {
    const b = pixels[i]
    const g = pixels[i + 1]
    const r = pixels[i + 2]
    if (bpp === 3) {
      pixels[i] = r
      pixels[i + 2] = b
      continue
    }
    const a = pixels[i + 3]
    if (a === 0) {
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0
    } else if (a === 255) {
      pixels[i] = r
      pixels[i + 2] = b
    } else {
      // undo the premultiply, or edges come out dark
      pixels[i] = Math.min(255, Math.round((r * 255) / a))
      pixels[i + 1] = Math.min(255, Math.round((g * 255) / a))
      pixels[i + 2] = Math.min(255, Math.round((b * 255) / a))
    }
  }

  // re-emit with filter 0 on every row; deflate makes the size difference negligible
  const stride = width * bpp
  const scanlines = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0
    pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
