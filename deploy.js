#!/usr/bin/env node
/**
 * 店小二后端一键部署脚本
 * 用法: node deploy.js
 */

const fs = require('fs')
const path = require('path')
const { Client } = require('ssh2')
const archiver = require('archiver')
const readline = require('readline')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(question, defaultValue = '') {
  return new Promise(resolve => {
    const prompt = defaultValue ? `${question} (默认: ${defaultValue}): ` : `${question}: `
    rl.question(prompt, answer => {
      resolve(answer.trim() || defaultValue)
    })
  })
}

// 打包 server 目录
async function packServer() {
  const outputPath = path.join(__dirname, 'server-deploy.tar.gz')
  const output = fs.createWriteStream(outputPath)
  const archive = archiver('tar', { gzip: true })

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      console.log(`[打包] 完成: ${outputPath} (${(archive.pointer() / 1024).toFixed(1)} KB)`)
      resolve(outputPath)
    })
    archive.on('error', reject)
    archive.on('warning', err => {
      if (err.code !== 'ENOENT') reject(err)
    })

    archive.pipe(output)
    archive.directory(path.join(__dirname, 'server'), 'server')
    archive.finalize()
  })
}

// SSH 上传文件并执行命令
async function deployToServer(config, localFile) {
  const conn = new Client()
  const remoteDir = '/opt/dianxiaoer'
  const remoteFile = `${remoteDir}/server-deploy.tar.gz`

  return new Promise((resolve, reject) => {
    conn.on('ready', () => {
      console.log('[SSH] 连接成功')

      conn.sftp((err, sftp) => {
        if (err) return reject(err)

        // 创建远程目录
        conn.exec(`mkdir -p ${remoteDir}`, (err) => {
          if (err) return reject(err)

          console.log('[上传] 正在传输文件...')
          sftp.fastPut(localFile, remoteFile, (err) => {
            if (err) return reject(err)
            console.log('[上传] 完成')

            // 执行远程部署命令
            const deployCmd = `
              set -e
              echo '=== 店小二后端部署 ==='
              cd ${remoteDir}

              echo '[1/6] 解压文件...'
              tar -xzf server-deploy.tar.gz
              cd server

              echo '[2/6] 检查 Node.js...'
              if ! command -v node &> /dev/null; then
                echo 'Node.js 未安装，正在安装...'
                curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
                apt-get install -y nodejs
              fi
              node -v

              echo '[3/6] 检查 MySQL...'
              if ! command -v mysql &> /dev/null; then
                echo 'MySQL 未安装，正在安装...'
                apt-get update
                apt-get install -y mysql-server
                systemctl start mysql
                systemctl enable mysql
              fi

              echo '[4/6] 安装 npm 依赖...'
              npm install --production

              echo '[5/6] 初始化数据库...'
              mysql -u${config.dbUser} -p'${config.dbPassword}' -e "CREATE DATABASE IF NOT EXISTS ${config.dbName} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" 2>/dev/null || true

              echo '[6/6] 启动服务...'
              if command -v pm2 &> /dev/null; then
                pm2 delete dianxiaoer-server 2>/dev/null || true
                pm2 start index.js --name dianxiaoer-server --env DB_HOST=${config.dbHost} --env DB_PORT=${config.dbPort} --env DB_USER=${config.dbUser} --env DB_PASSWORD='${config.dbPassword}' --env DB_NAME=${config.dbName}
                pm2 save
                echo '服务已通过 PM2 启动'
              else
                echo 'PM2 未安装，使用 nohup 启动...'
                export DB_HOST=${config.dbHost}
                export DB_PORT=${config.dbPort}
                export DB_USER=${config.dbUser}
                export DB_PASSWORD='${config.dbPassword}'
                export DB_NAME=${config.dbName}
                nohup node index.js > app.log 2>&1 &
                echo '服务已后台启动'
              fi

              echo '=== 部署完成 ==='
              echo '服务地址: http://${config.host}:3002'
            `

            console.log('[部署] 正在服务器上执行安装...')
            conn.exec(deployCmd, (err, stream) => {
              if (err) return reject(err)

              stream.on('close', (code, signal) => {
                if (code !== 0) {
                  return reject(new Error(`远程命令退出码: ${code}`))
                }
                console.log('[部署] 服务器部署完成')
                conn.end()
                resolve()
              })

              stream.on('data', data => {
                process.stdout.write(data.toString())
              })

              stream.stderr.on('data', data => {
                process.stderr.write(data.toString())
              })
            })
          })
        })
      })
    })

    conn.on('error', reject)

    const connectConfig = {
      host: config.host,
      port: config.port || 22,
      username: config.username,
      readyTimeout: 30000
    }

    if (config.privateKey) {
      connectConfig.privateKey = fs.readFileSync(config.privateKey)
    } else if (config.password) {
      connectConfig.password = config.password
    }

    conn.connect(connectConfig)
  })
}

async function main() {
  console.log('========================================')
  console.log('  店小二后端服务 - 一键部署')
  console.log('========================================\n')

  try {
    // 读取配置文件
    const configPath = path.join(__dirname, 'deploy-config.json')
    let config = {}
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        console.log('[配置] 已读取 deploy-config.json')
      } catch (e) {
        console.warn('[配置] 读取 deploy-config.json 失败，将使用交互模式')
      }
    }

    // 交互式补充缺失的配置
    const defaults = {
      host: '150.158.54.108',
      port: '22',
      username: 'root',
      privateKey: '',
      password: '',
      dbHost: 'localhost',
      dbPort: '3306',
      dbUser: 'root',
      dbPassword: '',
      dbName: 'dianxiaoer'
    }

    for (const [key, defVal] of Object.entries(defaults)) {
      if (!config[key]) {
        const prompt = key === 'dbPassword' || key === 'password'
          ? `${key} (输入时不显示): `
          : `${key} (默认: ${defVal}): `
        const answer = await new Promise(resolve => {
          rl.question(prompt, ans => resolve(ans.trim()))
        })
        config[key] = answer || defVal
      }
    }

    if (!config.privateKey && !config.password) {
      console.error('错误: 必须提供私钥路径或密码')
      process.exit(1)
    }

    if (!config.dbPassword) {
      console.error('错误: MySQL 密码不能为空')
      process.exit(1)
    }

    // 打包
    console.log('\n[1/3] 打包服务端代码...')
    const localFile = await packServer()

    // 部署
    console.log('\n[2/3] 连接远程服务器...')
    await deployToServer(config, localFile)

    // 清理
    console.log('\n[3/3] 清理临时文件...')
    fs.unlinkSync(localFile)

    console.log('\n========================================')
    console.log('  部署成功！')
    console.log(`  API 地址: http://${config.host}:3002`)
    console.log('========================================')

  } catch (err) {
    console.error('\n[错误]', err.message)
    process.exit(1)
  } finally {
    rl.close()
  }
}

main()
