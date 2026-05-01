#!/usr/bin/env node
/**
 * 店小二后端一键部署脚本 (Windows 服务器 + NSSM)
 * 用法: node deploy.js [server|api|all]
 *   - server: 仅部署主API服务 (端口3002)
 *   - api:    仅部署认证API服务 (端口3000)
 *   - all:    部署全部 (默认)
 */

const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')
const AdmZip = require('adm-zip')

// ========== 部署配置 ==========

const DEPLOY_CONFIG = {
  // SSH 连接
  ssh: {
    host: '150.158.54.108',
    port: 22,
    username: 'administrator',
    privateKeyPath: path.join(__dirname, 'server-key', 'id_rsa')
  },

  // 服务定义
  services: {
    server: {
      name: 'dianxiaoer-server',
      localDir: path.join(__dirname, 'server'),
      remoteDir: 'C:\\Users\\Administrator\\dianxiaoer-server',
      exclude: ['node_modules', 'logs', 'out.log', 'err.log', '*.log']
    },
    api: {
      name: 'dianxiaoer-api',
      localDir: path.join(__dirname, 'server-api'),
      remoteDir: 'C:\\dianxiaoer-api',
      exclude: ['node_modules', 'logs', 'data', 'certs', '.env', '*.log']
    }
  },

  // NSSM 路径
  nssm: 'C:\\nssm\\nssm.exe'
}

// ========== 工具函数 ==========

function log(tag, msg) {
  const time = new Date().toLocaleTimeString()
  console.log(`[${time}] [${tag}] ${msg}`)
}

function shouldExclude(filePath, excludePatterns) {
  const name = path.basename(filePath)
  return excludePatterns.some(pattern => {
    if (pattern.startsWith('*.')) {
      return name.endsWith(pattern.slice(1))
    }
    return name === pattern
  })
}

// 打包目录为 zip
function packDir(localDir, exclude) {
  const zip = new AdmZip()
  const baseName = path.basename(localDir)

  function addDirectory(dirPath, zipPath) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const entryZipPath = zipPath ? `${zipPath}/${entry.name}` : entry.name

      if (shouldExclude(fullPath, exclude)) continue

      if (entry.isDirectory()) {
        addDirectory(fullPath, entryZipPath)
      } else {
        zip.addLocalFile(fullPath, zipPath || '')
      }
    }
  }

  addDirectory(localDir, '')
  const outputPath = path.join(__dirname, `${baseName}-deploy.zip`)
  zip.writeZip(outputPath)
  const size = (fs.statSync(outputPath).size / 1024).toFixed(1)
  log('打包', `${baseName} -> ${outputPath} (${size} KB)`)
  return outputPath
}

// 创建 SSH 连接
function createConnection() {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    const connectConfig = {
      host: DEPLOY_CONFIG.ssh.host,
      port: DEPLOY_CONFIG.ssh.port,
      username: DEPLOY_CONFIG.ssh.username,
      readyTimeout: 30000
    }

    const keyPath = DEPLOY_CONFIG.ssh.privateKeyPath
    if (fs.existsSync(keyPath)) {
      connectConfig.privateKey = fs.readFileSync(keyPath)
      log('SSH', `使用私钥: ${keyPath}`)
    } else {
      reject(new Error(`SSH 私钥不存在: ${keyPath}`))
      return
    }

    conn.on('ready', () => {
      log('SSH', `已连接到 ${DEPLOY_CONFIG.ssh.host}`)
      resolve(conn)
    })
    conn.on('error', reject)
    conn.connect(connectConfig)
  })
}

// 执行远程命令
function remoteExec(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = '', stderr = ''
      stream.on('data', d => {
        const s = d.toString()
        stdout += s
        process.stdout.write(s)
      })
      stream.stderr.on('data', d => {
        const s = d.toString()
        stderr += s
        process.stderr.write(s)
      })
      stream.on('close', (code) => {
        resolve({ code, stdout, stderr })
      })
    })
  })
}

// SFTP 上传
function sftpUpload(conn, localPath, remotePath) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err)
      log('上传', `${path.basename(localPath)} -> ${remotePath}`)
      sftp.fastPut(localPath, remotePath, (err) => {
        if (err) return reject(err)
        log('上传', '完成')
        resolve()
      })
    })
  })
}

// ========== 部署单个服务 ==========

async function deployService(conn, serviceKey) {
  const svc = DEPLOY_CONFIG.services[serviceKey]
  log('部署', `========== ${svc.name} ==========`)

  // 1. 检查本地目录
  if (!fs.existsSync(svc.localDir)) {
    throw new Error(`本地目录不存在: ${svc.localDir}`)
  }

  // 2. 打包
  log('部署', '[1/4] 打包代码...')
  const zipPath = packDir(svc.localDir, svc.exclude)
  const zipName = path.basename(zipPath)
  const remoteZip = `${svc.remoteDir}\\${zipName}`

  try {
    // 3. 确保远程目录存在
    await remoteExec(conn, `if not exist "${svc.remoteDir}" mkdir "${svc.remoteDir}"`)

    // 4. 停止服务
    log('部署', '[2/4] 停止服务...')
    await remoteExec(conn, `"${DEPLOY_CONFIG.nssm}" stop ${svc.name} 2>nul & echo ok`)

    // 5. 上传
    log('部署', '[3/4] 上传文件...')
    await sftpUpload(conn, zipPath, remoteZip.replace(/\\/g, '/'))

    // 6. 解压并安装依赖、启动服务
    log('部署', '[4/4] 解压 & 安装依赖 & 启动...')
    const deployCmd = [
      `cd /d "${svc.remoteDir}"`,
      // 使用 PowerShell 解压 zip (覆盖已有文件)
      `powershell -Command "Expand-Archive -Path '${remoteZip}' -DestinationPath '${svc.remoteDir}' -Force"`,
      // 删除 zip
      `del /f "${remoteZip}"`,
      // 安装 npm 依赖
      `npm install --production`,
      // 启动 NSSM 服务
      `"${DEPLOY_CONFIG.nssm}" start ${svc.name}`,
      `echo [完成] ${svc.name} 部署成功`
    ].join(' && ')

    const result = await remoteExec(conn, deployCmd)
    if (result.code !== 0) {
      log('警告', `${svc.name} 部署命令退出码: ${result.code}`)
    }
  } finally {
    // 清理本地 zip
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath)
    }
  }
}

// ========== 主流程 ==========

async function main() {
  const target = process.argv[2] || 'all'
  const validTargets = ['server', 'api', 'all']
  if (!validTargets.includes(target)) {
    console.error(`用法: node deploy.js [${validTargets.join('|')}]`)
    process.exit(1)
  }

  console.log('========================================')
  console.log('  店小二 - 一键部署 (Windows + NSSM)')
  console.log('========================================')
  console.log(`  目标: ${target}`)
  console.log(`  服务器: ${DEPLOY_CONFIG.ssh.host}`)
  console.log('')

  let conn
  try {
    // 连接服务器
    conn = await createConnection()

    // 检查 NSSM 是否存在
    const nssmCheck = await remoteExec(conn, `if exist "${DEPLOY_CONFIG.nssm}" (echo NSSM_OK) else (echo NSSM_MISSING)`)
    if (nssmCheck.stdout.includes('NSSM_MISSING')) {
      log('错误', `服务器上未找到 NSSM: ${DEPLOY_CONFIG.nssm}`)
      log('提示', '请先在服务器上安装 NSSM 并运行 nssm-install.bat')
      process.exit(1)
    }

    // 部署服务
    if (target === 'server' || target === 'all') {
      await deployService(conn, 'server')
    }
    if (target === 'api' || target === 'all') {
      await deployService(conn, 'api')
    }

    // 检查服务状态
    console.log('')
    log('状态', '========== 服务状态 ==========')
    if (target === 'server' || target === 'all') {
      await remoteExec(conn, `"${DEPLOY_CONFIG.nssm}" status dianxiaoer-server`)
    }
    if (target === 'api' || target === 'all') {
      await remoteExec(conn, `"${DEPLOY_CONFIG.nssm}" status dianxiaoer-api`)
    }

    console.log('\n========================================')
    console.log('  部署完成！')
    if (target === 'server' || target === 'all') {
      console.log(`  主API:   http://${DEPLOY_CONFIG.ssh.host}:3001`)
    }
    if (target === 'api' || target === 'all') {
      console.log(`  认证API: https://${DEPLOY_CONFIG.ssh.host}:3002`)
    }
    console.log('========================================')

  } catch (err) {
    log('错误', err.message)
    process.exit(1)
  } finally {
    if (conn) conn.end()
  }
}

main()
