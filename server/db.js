const mysql = require('mysql2/promise')

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3307,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'jd123456',
  database: process.env.DB_NAME || 'dianxiaoer',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
}

const pool = mysql.createPool(dbConfig)

async function initDB() {
  // 先创建数据库（如果不存在）
  const tempPool = mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    waitForConnections: true,
    connectionLimit: 1
  })
  const tempConn = await tempPool.getConnection()
  try {
    await tempConn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    console.log('[DB] 数据库已创建或已存在')
  } finally {
    tempConn.release()
    await tempPool.end()
  }

  const connection = await pool.getConnection()
  try {
    // 用户表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT PRIMARY KEY AUTO_INCREMENT,
        username VARCHAR(50) NOT NULL UNIQUE,
        real_name VARCHAR(50) NOT NULL,
        phone VARCHAR(20) DEFAULT '',
        password_hash VARCHAR(255) DEFAULT '',
        user_type ENUM('master', 'sub') DEFAULT 'sub',
        role ENUM('super_admin', 'admin', 'staff') DEFAULT 'staff',
        status ENUM('enabled', 'disabled') DEFAULT 'enabled',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 店铺表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS stores (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        platform VARCHAR(20) DEFAULT '',
        account VARCHAR(100) DEFAULT '',
        password VARCHAR(200) DEFAULT '',
        merchant_id VARCHAR(50) DEFAULT '',
        shop_id VARCHAR(50) DEFAULT '',
        tags JSON,
        online TINYINT DEFAULT 0,
        status ENUM('enabled', 'disabled') DEFAULT 'enabled',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    // 兼容已存在的 stores 表：添加 password 字段
    try {
      await connection.execute(`ALTER TABLE stores ADD COLUMN password VARCHAR(200) DEFAULT '' AFTER account`)
    } catch (e) { /* 字段已存在 */ }

    // 仓库表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS warehouses (
        id INT PRIMARY KEY AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(50) DEFAULT '',
        location VARCHAR(200) DEFAULT '',
        contact VARCHAR(50) DEFAULT '',
        phone VARCHAR(20) DEFAULT '',
        status ENUM('enabled', 'disabled') DEFAULT 'enabled',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    // 兼容已存在的表：添加 contact / phone 字段
    try {
      await connection.execute(`ALTER TABLE warehouses ADD COLUMN contact VARCHAR(50) DEFAULT ''`)
    } catch (e) { /* 字段已存在 */ }
    try {
      await connection.execute(`ALTER TABLE warehouses ADD COLUMN phone VARCHAR(20) DEFAULT ''`)
    } catch (e) { /* 字段已存在 */ }

    // 用户-店铺关联表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_stores (
        user_id INT NOT NULL,
        store_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, store_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 用户-仓库关联表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_warehouses (
        user_id INT NOT NULL,
        warehouse_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, warehouse_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // Cookie 表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cookies (
        id INT PRIMARY KEY AUTO_INCREMENT,
        store_id INT NOT NULL,
        cookie_data LONGTEXT,
        domain VARCHAR(50) DEFAULT '',
        saved_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_store_id (store_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 插入默认数据
    const [rows] = await connection.execute("SELECT COUNT(*) as count FROM users")
    if (rows[0].count === 0) {
      await connection.execute(`
        INSERT INTO users (id, username, real_name, phone, password_hash, user_type, role, status, created_at)
        VALUES (1, 'admin', '系统管理员', '13800138000', 'admin', 'master', 'super_admin', 'enabled', NOW()),
               (2, 'staff01', '张三', '13900139000', '123456', 'sub', 'staff', 'enabled', NOW())
      `)
    }

    const [storeRows] = await connection.execute("SELECT COUNT(*) as count FROM stores")
    if (storeRows[0].count === 0) {
      await connection.execute(`
        INSERT INTO stores (name, platform, account, merchant_id, shop_id, tags, online, status)
        VALUES ('京东旗舰店', 'jd', 'jdshop001', 'M001', 'S001', '["自营"]', 1, 'enabled'),
               ('天猫专营店', 'tmall', 'tmall001', 'M002', 'S002', '["品牌"]', 0, 'enabled'),
               ('淘宝小店', 'taobao', 'tb001', 'M003', 'S003', '[]', 1, 'disabled')
      `)
    }

    const [whRows] = await connection.execute("SELECT COUNT(*) as count FROM warehouses")
    if (whRows[0].count === 0) {
      await connection.execute(`
        INSERT INTO warehouses (name, code, location, status)
        VALUES ('默认仓库', 'WH001', '浙江省杭州市', 'enabled'),
               ('华东仓', 'WH002', '江苏省苏州市', 'enabled'),
               ('华南仓', 'WH003', '广东省深圳市', 'enabled'),
               ('华北仓', 'WH004', '北京市', 'disabled')
      `)
    }

    // 默认分配
    await connection.execute(`
      INSERT IGNORE INTO user_stores (user_id, store_id) VALUES (2, 1)
    `)
    await connection.execute(`
      INSERT IGNORE INTO user_warehouses (user_id, warehouse_id) VALUES (2, 1)
    `)

    console.log('[DB] 数据库初始化完成')
  } finally {
    connection.release()
  }
}

module.exports = { pool, initDB }
