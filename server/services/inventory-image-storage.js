const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const MAX_INVENTORY_IMAGE_BYTES = 2 * 1024 * 1024
const INVENTORY_IMAGE_PUBLIC_PATH = '/uploads/inventory-products'

function detectInventoryImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' }
  }

  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { extension: 'png', mimeType: 'image/png' }
  }

  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { extension: 'webp', mimeType: 'image/webp' }
  }

  return null
}

function resolveInventoryImageRoot({ dataRoot, serverDir = __dirname } = {}) {
  const configuredRoot = dataRoot || process.env.DXE_DATA_DIR
  const baseRoot = configuredRoot
    ? path.resolve(configuredRoot)
    : path.resolve(serverDir, '..', '..', 'dianxiaoer-data')
  return path.join(baseRoot, 'inventory-images')
}

function normalizeOwnerId(ownerId) {
  const value = Number.parseInt(ownerId, 10)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('无效的商品图片归属用户')
  }
  return String(value)
}

async function saveInventoryImage({ buffer, ownerId, rootDir }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('没有收到商品图片')
  }
  if (buffer.length > MAX_INVENTORY_IMAGE_BYTES) {
    throw new Error('商品图片不能超过2MB')
  }

  const imageType = detectInventoryImageType(buffer)
  if (!imageType) {
    throw new Error('仅支持 JPG、PNG 或 WebP 图片')
  }

  const ownerSegment = normalizeOwnerId(ownerId)
  const imageRoot = path.resolve(rootDir || resolveInventoryImageRoot())
  const ownerDir = path.join(imageRoot, ownerSegment)
  await fs.promises.mkdir(ownerDir, { recursive: true })

  const fileName = `${Date.now()}-${crypto.randomUUID()}.${imageType.extension}`
  const filePath = path.join(ownerDir, fileName)
  await fs.promises.writeFile(filePath, buffer, { flag: 'wx' })

  return {
    fileName,
    filePath,
    ownerSegment,
    relativePath: `${ownerSegment}/${fileName}`,
    mimeType: imageType.mimeType,
    size: buffer.length
  }
}

function resolveManagedInventoryImagePath(imageUrl, { rootDir, ownerId } = {}) {
  if (typeof imageUrl !== 'string' || imageUrl.trim() === '') return null

  let pathname
  try {
    pathname = new URL(imageUrl, 'http://inventory.local').pathname
  } catch (_) {
    return null
  }

  const prefix = `${INVENTORY_IMAGE_PUBLIC_PATH}/`
  if (!pathname.startsWith(prefix)) return null

  const relativePath = decodeURIComponent(pathname.slice(prefix.length))
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^[a-zA-Z0-9.-]+$/.test(parts[1])) {
    return null
  }
  if (ownerId !== undefined && parts[0] !== normalizeOwnerId(ownerId)) return null

  const imageRoot = path.resolve(rootDir || resolveInventoryImageRoot())
  const filePath = path.resolve(imageRoot, parts[0], parts[1])
  const safePrefix = `${imageRoot}${path.sep}`
  return filePath.startsWith(safePrefix) ? filePath : null
}

module.exports = {
  INVENTORY_IMAGE_PUBLIC_PATH,
  MAX_INVENTORY_IMAGE_BYTES,
  detectInventoryImageType,
  resolveInventoryImageRoot,
  resolveManagedInventoryImagePath,
  saveInventoryImage
}
