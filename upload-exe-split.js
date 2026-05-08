const { Client } = require('ssh2')
const fs = require('fs')
const path = require('path')

const HOST = '150.158.54.108'
const KEY_PATH = path.join(__dirname, 'server-key', 'id_rsa')
const LOCAL = path.join(__dirname, 'dist', 'dianxiaoer-setup-1.3.23.exe')
const REMOTE_DIR = 'C:/Users/Administrator/dianxiaoer-api/updates'
const REMOTE = REMOTE_DIR + '/dianxiaoer-setup-1.3.23.exe'
const PART_SIZE = 20 * 1024 * 1024 // 20MB per part

const fileSize = fs.statSync(LOCAL).size
const totalParts = Math.ceil(fileSize / PART_SIZE)

console.log('File:', fileSize, 'bytes, Parts:', totalParts)

async function sshExec(cmd) {
  const conn = new Client()
  await new Promise((resolve, reject) => {
    conn.on('ready', resolve)
    conn.on('error', reject)
    conn.connect({ host: HOST, port: 22, username: 'administrator', privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 30000, keepaliveInterval: 5000 })
  })
  const result = await new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = '', stderr = ''
      stream.on('data', d => stdout += d.toString())
      stream.stderr.on('data', d => stderr += d.toString())
      stream.on('close', code => resolve({ code, stdout, stderr }))
    })
  })
  conn.end()
  return result
}

async function uploadPart(partIndex) {
  const start = partIndex * PART_SIZE
  const end = Math.min(start + PART_SIZE, fileSize)
  const partFile = LOCAL + '.part' + partIndex
  const remotePart = REMOTE_DIR + '/temp_part_' + partIndex

  // Extract part from exe
  const buf = Buffer.alloc(end - start)
  const fd = fs.openSync(LOCAL, 'r')
  fs.readSync(fd, buf, 0, end - start, start)
  fs.closeSync(fd)
  fs.writeFileSync(partFile, buf)

  return new Promise((resolve, reject) => {
    const conn = new Client()
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); fs.unlinkSync(partFile); return reject(err) }
        sftp.fastPut(partFile, remotePart, { concurrency: 1, chunkSize: 5 * 1024 * 1024 }, (err) => {
          fs.unlinkSync(partFile) // cleanup local part
          if (err) { console.error('  Part ' + (partIndex+1) + ' upload failed:', err.message); conn.end(); return reject(err) }
          console.log('  Part ' + (partIndex+1) + '/' + totalParts + ' uploaded (' + ((end-start)/1024/1024).toFixed(1) + ' MB)')
          sftp.end()
          conn.end()
          resolve()
        })
      })
    })
    conn.on('error', e => { try { fs.unlinkSync(partFile) } catch(ex) {} reject(e) })
    conn.connect({ host: HOST, port: 22, username: 'administrator', privateKey: fs.readFileSync(KEY_PATH), readyTimeout: 60000, keepaliveInterval: 5000, keepaliveCountMax: 100 })
  })
}

async function main() {
  try {
    // Delete old temp parts on server
    console.log('Cleaning up old temp files...')
    await sshExec('del /Q "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\temp_part_*" 2>nul')

    // Upload parts
    for (let i = 0; i < totalParts; i++) {
      let ok = false
      for (let retry = 0; retry < 3 && !ok; retry++) {
        try {
          await uploadPart(i)
          ok = true
        } catch (e) {
          console.log('  Retry ' + (retry+1) + ' for part ' + (i+1) + '...')
          await new Promise(r => setTimeout(r, 3000))
        }
      }
      if (!ok) {
        console.error('FATAL: Part ' + (i+1) + ' failed after 3 retries')
        process.exit(1)
      }
      await new Promise(r => setTimeout(r, 1000))
    }

    // Reassemble on server using copy /b
    console.log('\nReassembling on server...')
    let copyCmd = 'copy /b "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\temp_part_0"'
    for (let i = 1; i < totalParts; i++) {
      copyCmd += '+"C:\\Users\\Administrator\\dianxiaoer-api\\updates\\temp_part_' + i + '"'
    }
    copyCmd += ' "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\dianxiaoer-setup-1.3.23.exe" /y'

    const assembleResult = await sshExec(copyCmd)
    console.log('Assemble:', assembleResult.stdout.trim().substring(0, 200))

    // Cleanup temp parts
    console.log('Cleaning temp files...')
    await sshExec('del /Q "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\temp_part_*" 2>nul')

    // Verify file size
    console.log('Verifying...')
    const verify = await sshExec('dir "C:\\Users\\Administrator\\dianxiaoer-api\\updates\\dianxiaoer-setup-1.3.23.exe"')
    console.log(verify.stdout.trim().substring(0, 400))
    console.log('Expected size:', fileSize)

    console.log('\nDone!')
  } catch (e) {
    console.error('Fatal:', e.message)
    process.exit(1)
  }
}

main()
