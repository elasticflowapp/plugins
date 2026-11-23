// Just enough PNG to cut the empty bottom off a screenshot.
//
// A preview is a picture of a browser window, 1024×640. A short page fills the
// top of it and leaves the rest blank, and a card that is two thirds blank
// says little about what the page is. So the blank rows at the bottom of the
// WINDOW are cut: the rows identical to the last row are dropped, down to a
// minimum height. This knows nothing about where the page ends — a tall page
// with a blank band across the bottom of the window is cut the same way, and
// what is lost is blank rows either way. Nothing is scaled or redrawn — the
// rows that remain are the browser's own pixels.
//
// Only what a browser's screenshot is (8-bit RGB or RGBA, not interlaced) is
// handled; anything else is returned as it came.
//
// The same module as the Claude Code client's (packages/ef-share-plugin/src/lib/png.ts),
// without its types; the same file in the Codex and the Antigravity client.

import { inflateSync, deflateSync } from "node:zlib"

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, "latin1")
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, tail])
}

/** The pixels of an 8-bit RGB / RGBA, non-interlaced PNG — or null for anything else. */
export function decodePng(png) {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null
  let width = 0, height = 0, bpp = 0
  const idat = []
  for (let at = 8; at + 12 <= buf.length;) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString("latin1", at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + length)
    if (data.length !== length) return null
    if (type === "IHDR") {
      if (data.length < 13) return null
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8], color = data[9], interlace = data[12]
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return null
      bpp = color === 6 ? 4 : 3
    } else if (type === "IDAT") idat.push(data)
    else if (type === "IEND") break
    at += 12 + length
  }
  if (!bpp || width < 1 || height < 1 || width > 8192 || height > 8192 || idat.length === 0) return null
  const stride = width * bpp
  let raw
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height }) } catch { return null }
  if (raw.length !== (stride + 1) * height) return null
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? pixels[dst + x - bpp] : 0
      const up = y > 0 ? pixels[dst + x - stride] : 0
      const upLeft = y > 0 && x >= bpp ? pixels[dst + x - stride - bpp] : 0
      let predict = 0
      if (filter === 1) predict = left
      else if (filter === 2) predict = up
      else if (filter === 3) predict = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft)
        predict = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) return null
      pixels[dst + x] = (raw[src + x] + predict) & 0xff
    }
  }
  return { width, height, bpp, pixels }
}

/** A PNG of `bitmap`. Each row is stored as its difference from the row above — small for a page's flat areas. */
export function encodePng(bitmap) {
  const { width, height, bpp, pixels } = bitmap
  const stride = width * bpp
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1)
    raw[dst] = y === 0 ? 0 : 2
    for (let x = 0; x < stride; x++) {
      const v = pixels[y * stride + x]
      raw[dst + 1 + x] = y === 0 ? v : (v - pixels[(y - 1) * stride + x]) & 0xff
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = bpp === 4 ? 6 : 2
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}

/**
 * `png` without the blank rows at its bottom: every trailing row identical to
 * the last one is dropped, leaving `pad` of them as margin and never fewer
 * than `minHeight` rows. Returns the input when there is nothing worth cutting
 * or the picture is not one this module reads.
 */
export function trimPngBottom(png, opts) {
  // the caller compares by identity to know whether anything was cut
  const original = Buffer.isBuffer(png) ? png : Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  let bitmap
  try { bitmap = decodePng(png) } catch { bitmap = null } // a damaged file is kept as it came, never a throw
  if (!bitmap) return original
  const { width, height, bpp, pixels } = bitmap
  const stride = width * bpp
  const last = pixels.subarray((height - 1) * stride, height * stride)
  let content = height - 1
  while (content > 0 && pixels.subarray((content - 1) * stride, content * stride).equals(last)) content--
  // `content` is now the first row of the identical run at the bottom
  const keep = Math.min(height, Math.max(opts.minHeight, content + opts.pad))
  if (keep > height - 16) return original
  return encodePng({ width, height: keep, bpp, pixels: pixels.subarray(0, keep * stride) })
}

/**
 * True when every pixel of `png` is the same colour — a page that drew
 * nothing. False for a picture this module does not read.
 */
export function isFlatPng(png) {
  let bitmap
  try { bitmap = decodePng(png) } catch { bitmap = null }
  if (!bitmap) return false
  const { bpp, pixels } = bitmap
  for (let i = bpp; i < pixels.length; i++) if (pixels[i] !== pixels[i % bpp]) return false
  return true
}
