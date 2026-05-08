const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const HOST = '150.158.54.108'
const KEY_PATH = path.join(__dirname, 'server-key', 'id_rsa')
const LOCAL = path.join(__dirname, 'dist', 'dianxiaoer-setup-1.3.22.exe')
const REMOTE = 'C:/Users/Administrator/dianxiaoer-api/updates/dianxiaoer-setup-1.3.22.exe'
const CHUNK_SIZE = 30 * 1024 * 1024

const fileSize = fs.statSync(LOCAL).size
const totalChunks = Math.ceil(fileSize / CHUNK_SIZE)

console.log('File size:', fileSize, '(' + (fileSize/1024/1024).toFixed(1) + ' MB)')
console.log('Chunks:', totalChunks, '@ 30MB each')

function uploadChunk(chunkIndex) {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err) }

        const start = chunkIndex * CHUNK_SIZE
        const end = Math.min(start + CHUNK_SIZE, fileSize)
        console.log('  Chunk ' + (chunkIndex+1) + '/' + totalChunks + ': bytes ' + start + '-' + (end-1))

        const readStream = fs.createReadStream(LOCAL, { start, end: end - 1 })
        const writeStream = sftp.createWriteStream(REMOTE, { start })

        writeStream.on('close', () => {
          console.log('  Chunk ' + (chunkIndex+1) + ' done')
          sftp.end()
          conn.end()
          resolve()
        })
        writeStream.on('error', (e) => { conn.end(); reject(e) })
        readStream.on('error', (e) => { conn.end(); reject(e) })
        readStream.pipe(writeStream)
      })
    })
    conn.on('error', (e) => { reject(e) })
    conn.connect({ host: HOST, port: 22, username: 'administrator', privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 60000, keepaliveInterval: 5000, keepaliveCountMax: 50 })
  })
}

async function main() {
  // First create/truncate target file on server
  console.log('Creating target file on server...')
  const conn0 = new Client()
  await new Promise((resolve, reject) => {
    conn0.on('ready', resolve)
    conn0.on('error', reject)
    conn0.connect({ host: HOST, port: 22, username: 'administrator', privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000 })
  })

  await new Promise((resolve, reject) => {
    conn0.exec('echo. > "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\dianxiaoer-setup-1.3.22.exe"', (err, stream) => {
      if (err) return reject(err)
      stream.on('close', () => { console.log('Target file created'); resolve() })
      stream.stderr.on('data', d => process.stderr.write(d))
    })
  })
  conn0.end()

  // Upload chunks
  for (let i = 0; i < totalChunks; i++) {
    let success = false
    for (let retry = 0; retry < 3 && !success; retry++) {
      try {
        await uploadChunk(i)
        success = true
      } catch (e) {
        console.error('  Chunk ' + (i+1) + ' attempt ' + (retry+1) + ' failed: ' + e.message)
        if (retry < 2) {
          console.log('  Retrying in 3s...')
          await new Promise(r => setTimeout(r, 3000))
        }
      }
    }
    if (!success) {
      console.error('FATAL: Chunk ' + (i+1) + ' failed after 3 retries')
      process.exit(1)
    }
    // Delay between chunks
    if (i < totalChunks - 1) await new Promise(r => setTimeout(r, 2000))
  }

  // Verify file size on server
  console.log('\nVerifying...')
  const connV = new Client()
  await new Promise((resolve, reject) => {
    connV.on('ready', resolve)
    connV.on('error', reject)
    connV.connect({ host: HOST, port: 22, username: 'administrator', privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000 })
  })

  await new Promise((resolve) => {
    connV.exec('dir "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\dianxiaoer-setup-1.3.22.exe"', (err, stream) => {
      let out = ''
      stream.on('data', d => out += d.toString())
      stream.on('close', () => {
        console.log(out.trim().substring(0, 400))
        connV.end()
        resolve()
      })
    })
  })

  console.log('\nExpected size:', fileSize)
  console.log('Upload complete!')
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
