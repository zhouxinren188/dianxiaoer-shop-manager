const { Client } = require('ssh2')

const HOST = '150.158.54.108'
const PORT = 22
const USERNAME = 'administrator'
const PASSWORD = 'K9#m2$vL5@zQ'
const DB_PASS = 'jd123456'

function execCommand(conn, cmd) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', d => stdout += d.toString())
      stream.stderr.on('data', d => stderr += d.toString())
      stream.on('close', () => resolve({ stdout, stderr }))
    })
  })
}

async function run() {
  const conn = new Client()

  conn.on('ready', async () => {
    console.log('[SSH] Connected')

    try {
      // 1. Check current unique indexes
      console.log('\n--- Current unique indexes ---')
      const r1 = await execCommand(conn,
        `cd C:\\Users\\Administrator\\dianxiaoer-server && node -e "const m=require('mysql2/promise');(async()=>{const c=await m.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});const [r]=await c.execute('SHOW INDEX FROM purchase_accounts WHERE Non_unique=0');r.forEach(x=>console.log(x.Key_name,x.Column_name,x.Seq_in_index));await c.end()})()"`
      )
      console.log(r1.stdout || '(no output)')
      if (r1.stderr) console.log('STDERR:', r1.stderr)

      // 2. Drop old unique indexes (not PRIMARY)
      console.log('\n--- Dropping old unique indexes ---')
      const r2 = await execCommand(conn,
        `cd C:\\Users\\Administrator\\dianxiaoer-server && node -e "const m=require('mysql2/promise');(async()=>{const c=await m.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});const [r]=await c.execute('SHOW INDEX FROM purchase_accounts WHERE Non_unique=0');for(const x of r){if(x.Key_name!=='PRIMARY'){try{await c.execute('ALTER TABLE purchase_accounts DROP INDEX '+x.Key_name);console.log('Dropped:',x.Key_name)}catch(e){console.log('Drop failed:',x.Key_name,e.code)}}};await c.end()})()"`
      )
      console.log(r2.stdout || '(no output)')
      if (r2.stderr) console.log('STDERR:', r2.stderr)

      // 3. Create new unique index: (account, platform, owner_id)
      console.log('\n--- Creating new unique index ---')
      const r3 = await execCommand(conn,
        `cd C:\\Users\\Administrator\\dianxiaoer-server && node -e "const m=require('mysql2/promise');(async()=>{const c=await m.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});try{await c.execute('ALTER TABLE purchase_accounts ADD UNIQUE KEY uk_account_platform_owner (account, platform, owner_id)');console.log('Created: uk_account_platform_owner')}catch(e){console.log('Create failed:',e.message)};await c.end()})()"`
      )
      console.log(r3.stdout || '(no output)')
      if (r3.stderr) console.log('STDERR:', r3.stderr)

      // 4. Verify
      console.log('\n--- Verify new indexes ---')
      const r4 = await execCommand(conn,
        `cd C:\\Users\\Administrator\\dianxiaoer-server && node -e "const m=require('mysql2/promise');(async()=>{const c=await m.createConnection({host:'127.0.0.1',port:3307,user:'root',password:'jd123456',database:'dianxiaoer'});const [r]=await c.execute('SHOW INDEX FROM purchase_accounts WHERE Non_unique=0');r.forEach(x=>console.log(x.Key_name,x.Column_name,x.Seq_in_index));await c.end()})()"`
      )
      console.log(r4.stdout || '(no output)')
      if (r4.stderr) console.log('STDERR:', r4.stderr)

    } catch (e) {
      console.error('Error:', e.message)
    } finally {
      conn.end()
    }
  })

  conn.on('error', err => {
    console.error('SSH error:', err.message)
    process.exit(1)
  })

  conn.connect({ host: HOST, port: PORT, username: USERNAME, password: PASSWORD, readyTimeout: 15000 })
}

run()
