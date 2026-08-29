import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import imageStorage from '../server/services/inventory-image-storage.js'
import productInput from '../server/services/inventory-product-input.js'

const {
  INVENTORY_IMAGE_PUBLIC_PATH,
  MAX_INVENTORY_IMAGE_BYTES,
  detectInventoryImageType,
  resolveManagedInventoryImagePath,
  saveInventoryImage
} = imageStorage
const { normalizeInventoryCreateInput, normalizeInventoryUpdateInput } = productInput

const tempDirs = []

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

function createTempDir() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxe-inventory-images-'))
  tempDirs.push(tempDir)
  return tempDir
}

describe('inventory product input', () => {
  it('normalizes a mobile create payload without requiring a user-facing SKU', () => {
    expect(normalizeInventoryCreateInput({
      warehouse_id: '7',
      product_name: '  仓库商品  ',
      price: '12.345',
      warn_quantity: '0',
      quantity: '3',
      location: ' A-01 '
    })).toEqual({
      warehouseId: 7,
      productName: '仓库商品',
      price: 12.35,
      image: '',
      warnQuantity: 0,
      quantity: 3,
      location: 'A-01',
      batchNo: '',
      supplier: ''
    })
  })

  it('rejects missing names and negative inventory values', () => {
    expect(() => normalizeInventoryCreateInput({ warehouse_id: 1 })).toThrow('商品名称不能为空')
    expect(() => normalizeInventoryCreateInput({
      warehouse_id: 1,
      product_name: '商品',
      quantity: -1
    })).toThrow('当前库存必须是大于等于0的整数')
  })

  it('only includes explicitly supplied update fields', () => {
    expect(normalizeInventoryUpdateInput({ price: '8.6', supplier: ' 供应商 ' })).toEqual({
      price: 8.6,
      supplier: '供应商'
    })
  })
})

describe('inventory product image storage', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0, 0, 0, 0, 0])
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const webp = Buffer.from('RIFF0000WEBP', 'ascii')

  it('detects supported formats from file signatures rather than client MIME', () => {
    expect(detectInventoryImageType(jpeg)).toEqual({ extension: 'jpg', mimeType: 'image/jpeg' })
    expect(detectInventoryImageType(png)).toEqual({ extension: 'png', mimeType: 'image/png' })
    expect(detectInventoryImageType(webp)).toEqual({ extension: 'webp', mimeType: 'image/webp' })
    expect(detectInventoryImageType(Buffer.from('<html></html>'))).toBeNull()
  })

  it('stores images under an owner-specific random path', async () => {
    const rootDir = createTempDir()
    const result = await saveInventoryImage({ buffer: jpeg, ownerId: 12, rootDir })

    expect(result.relativePath).toMatch(/^12\/\d+-[0-9a-f-]{36}\.jpg$/)
    expect(fs.readFileSync(result.filePath)).toEqual(jpeg)

    const publicUrl = `http://example.test${INVENTORY_IMAGE_PUBLIC_PATH}/${result.relativePath}`
    expect(resolveManagedInventoryImagePath(publicUrl, { rootDir, ownerId: 12 })).toBe(result.filePath)
    expect(resolveManagedInventoryImagePath(publicUrl, { rootDir, ownerId: 13 })).toBeNull()
  })

  it('rejects oversized or disguised files and refuses path traversal URLs', async () => {
    const rootDir = createTempDir()
    await expect(saveInventoryImage({
      buffer: Buffer.alloc(MAX_INVENTORY_IMAGE_BYTES + 1, 0xff),
      ownerId: 1,
      rootDir
    })).rejects.toThrow('商品图片不能超过2MB')
    await expect(saveInventoryImage({
      buffer: Buffer.from('<script>alert(1)</script>'),
      ownerId: 1,
      rootDir
    })).rejects.toThrow('仅支持 JPG、PNG 或 WebP 图片')
    expect(resolveManagedInventoryImagePath(
      `http://example.test${INVENTORY_IMAGE_PUBLIC_PATH}/1/../../secret.jpg`,
      { rootDir }
    )).toBeNull()
  })
})
