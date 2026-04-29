const fs = require('fs')
const path = require('path')

// 生成一个最小的 32x32 32bpp ICO 文件（蓝色方块）
const width = 32
const height = 32
const bpp = 32
const rowSize = width * 4
const imageSize = rowSize * height
const xorMaskSize = imageSize
const andMaskSize = ((width + 31) >> 5) * 4 * height

// ICO Header (6 bytes)
const icoHeader = Buffer.alloc(6)
icoHeader.writeUInt16LE(0, 0) // Reserved
icoHeader.writeUInt16LE(1, 2) // Type: Icon
icoHeader.writeUInt16LE(1, 4) // Count: 1 image

// ICONDIRENTRY (16 bytes)
const dirEntry = Buffer.alloc(16)
dirEntry.writeUInt8(width, 0)
dirEntry.writeUInt8(height, 1)
dirEntry.writeUInt8(0, 2) // Colors
dirEntry.writeUInt8(0, 3) // Reserved
dirEntry.writeUInt16LE(1, 4) // Color planes
dirEntry.writeUInt16LE(bpp, 6) // Bits per pixel
dirEntry.writeUInt32LE(40 + xorMaskSize + andMaskSize, 8) // Size of image data
dirEntry.writeUInt32LE(22, 12) // Offset to image data

// BITMAPINFOHEADER (40 bytes)
const bmpHeader = Buffer.alloc(40)
bmpHeader.writeUInt32LE(40, 0) // Header size
bmpHeader.writeInt32LE(width, 4) // Width
bmpHeader.writeInt32LE(height * 2, 8) // Height (XOR + AND)
bmpHeader.writeUInt16LE(1, 12) // Planes
bmpHeader.writeUInt16LE(bpp, 14) // Bits per pixel
bmpHeader.writeUInt32LE(0, 16) // Compression
bmpHeader.writeUInt32LE(0, 20) // Image size
bmpHeader.writeUInt32LE(0, 24) // X ppm
bmpHeader.writeUInt32LE(0, 28) // Y ppm
bmpHeader.writeUInt32LE(0, 32) // Colors used
bmpHeader.writeUInt32LE(0, 36) // Important colors

// XOR mask (BGRA, bottom-up)
const xorMask = Buffer.alloc(xorMaskSize)
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = ((height - 1 - y) * width + x) * 4
    xorMask[idx] = 0xE6     // B (antd blue)
    xorMask[idx + 1] = 0x6C // G
    xorMask[idx + 2] = 0x18 // R
    xorMask[idx + 3] = 0xFF // A
  }
}

// AND mask (1bpp, all 0 = fully opaque/visible)
const andMask = Buffer.alloc(andMaskSize)
andMask.fill(0)

const icoPath = path.join(__dirname, '..', 'resources', 'icon.ico')
const icoData = Buffer.concat([icoHeader, dirEntry, bmpHeader, xorMask, andMask])
fs.writeFileSync(icoPath, icoData)

console.log('Created icon.ico at:', icoPath)
