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
        store_type VARCHAR(20) DEFAULT '',
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
    // 兼容已存在的 stores 表：添加 store_type 字段
    try {
      await connection.execute(`ALTER TABLE stores ADD COLUMN store_type VARCHAR(20) DEFAULT '' AFTER platform`)
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

    // 采购账号表（确保在关联表之前创建）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS purchase_accounts (
        id INT PRIMARY KEY AUTO_INCREMENT,
        account VARCHAR(100) DEFAULT '',
        password VARCHAR(200) DEFAULT '',
        platform VARCHAR(20) DEFAULT '',
        online TINYINT DEFAULT 0,
        owner_id INT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_account_owner (account, owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 用户-采购账号关联表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_purchase_accounts (
        user_id INT NOT NULL,
        account_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, account_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (account_id) REFERENCES purchase_accounts(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 用户令牌表（登录 token 存储）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        id INT PRIMARY KEY AUTO_INCREMENT,
        user_id INT NOT NULL,
        token VARCHAR(200) NOT NULL UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_token (token),
        KEY idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 兼容已存在的 users 表：添加 parent_id 字段（主账号为 NULL，子账号指向主账号 id）
    try {
      await connection.execute(`ALTER TABLE users ADD COLUMN parent_id INT DEFAULT NULL AFTER role`)
    } catch (e) { /* 字段已存在 */ }

    // 兼容已存在的 stores 表：添加 owner_id 字段（归属主账号）
    try {
      await connection.execute(`ALTER TABLE stores ADD COLUMN owner_id INT DEFAULT NULL`)
    } catch (e) { /* 字段已存在 */ }

    // 兼容已存在的 warehouses 表：添加 owner_id 字段（归属主账号）
    try {
      await connection.execute(`ALTER TABLE warehouses ADD COLUMN owner_id INT DEFAULT NULL`)
    } catch (e) { /* 字段已存在 */ }

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

    // 供店订单表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS supply_orders (
        id INT PRIMARY KEY AUTO_INCREMENT,
        store_id INT NOT NULL,
        order_id VARCHAR(50) NOT NULL,
        b_order_id VARCHAR(50) DEFAULT '',
        order_date VARCHAR(30) DEFAULT '',
        finish_time VARCHAR(30) DEFAULT '',
        stock_time VARCHAR(30) DEFAULT '',
        total_amount DECIMAL(12,2) DEFAULT 0,
        goods_amount DECIMAL(12,2) DEFAULT 0,
        freight_price DECIMAL(12,2) DEFAULT 0,
        order_state INT DEFAULT 0,
        status_text VARCHAR(30) DEFAULT '',
        jd_order_state_desc VARCHAR(30) DEFAULT '',
        paid TINYINT DEFAULT 0,
        wait_pay TINYINT DEFAULT 0,
        lock_flag TINYINT DEFAULT 0,
        dealer_code VARCHAR(50) DEFAULT '',
        dealer_name VARCHAR(100) DEFAULT '',
        supplier_name VARCHAR(100) DEFAULT '',
        receiver_name VARCHAR(50) DEFAULT '',
        receiver_phone VARCHAR(30) DEFAULT '',
        receiver_address VARCHAR(500) DEFAULT '',
        receiver_full_address VARCHAR(500) DEFAULT '',
        shipment_num VARCHAR(50) DEFAULT '',
        shipment_company_name VARCHAR(50) DEFAULT '',
        sku_id VARCHAR(50) DEFAULT '',
        product_name VARCHAR(300) DEFAULT '',
        product_image VARCHAR(500) DEFAULT '',
        unit_price DECIMAL(12,2) DEFAULT 0,
        jd_price DECIMAL(12,2) DEFAULT 0,
        quantity INT DEFAULT 0,
        outer_sku_id VARCHAR(50) DEFAULT '',
        sku_count INT DEFAULT 1,
        all_skus JSON,
        order_source_desc VARCHAR(50) DEFAULT '',
        source_type VARCHAR(30) DEFAULT '',
        raw_data LONGTEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_store_order (store_id, order_id),
        KEY idx_store_status (store_id, status_text),
        KEY idx_order_date (order_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 销售订单表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS sales_orders (
        id INT PRIMARY KEY AUTO_INCREMENT,
        store_id INT NOT NULL,
        order_id VARCHAR(50) NOT NULL,
        order_state INT DEFAULT 0,
        status_text VARCHAR(30) DEFAULT '',
        order_time VARCHAR(30) DEFAULT '',
        payment_time VARCHAR(30) DEFAULT '',
        ship_time VARCHAR(30) DEFAULT '',
        finish_time VARCHAR(30) DEFAULT '',
        total_amount DECIMAL(12,2) DEFAULT 0,
        goods_amount DECIMAL(12,2) DEFAULT 0,
        shipping_fee DECIMAL(12,2) DEFAULT 0,
        payment_method VARCHAR(30) DEFAULT '',
        buyer_name VARCHAR(50) DEFAULT '',
        buyer_phone VARCHAR(30) DEFAULT '',
        buyer_address VARCHAR(500) DEFAULT '',
        logistics_company VARCHAR(50) DEFAULT '',
        logistics_no VARCHAR(100) DEFAULT '',
        sku_id VARCHAR(50) DEFAULT '',
        product_name VARCHAR(300) DEFAULT '',
        product_image VARCHAR(500) DEFAULT '',
        unit_price DECIMAL(12,2) DEFAULT 0,
        quantity INT DEFAULT 0,
        item_count INT DEFAULT 1,
        all_items JSON,
        raw_data LONGTEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_order_id (order_id),
        KEY idx_store_status (store_id, status_text),
        KEY idx_order_time (order_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 兼容已存在的 sales_orders 表：唯一键从 (store_id,order_id) 改为 order_id 单列唯一
    try {
      await connection.execute(`ALTER TABLE sales_orders DROP INDEX uk_store_order`)
      console.log('[DB] 已删除旧唯一键 uk_store_order')
    } catch (e) { /* 键不存在 */ }
    try {
      await connection.execute(`DELETE t1 FROM sales_orders t1 INNER JOIN sales_orders t2 ON t1.order_id = t2.order_id AND t1.id > t2.id`)
      console.log('[DB] 已清理重复订单数据')
      await connection.execute(`ALTER TABLE sales_orders ADD UNIQUE KEY uk_order_id (order_id)`)
      console.log('[DB] 已添加新唯一键 uk_order_id')
    } catch (e) { /* 键已存在 */ }

    // 兼容已存在的 sales_orders 表：添加 purchase_status 字段
    try {
      await connection.execute(`ALTER TABLE sales_orders ADD COLUMN purchase_status VARCHAR(30) NOT NULL DEFAULT '未采购' COMMENT '采购状态：未采购/已采购（三方代发）/已采购（仓库转发）/已忽略' AFTER sys_remark`)
    } catch (e) { /* 字段已存在 */ }

    // 兼容已存在的 purchase_accounts 表：添加 account+owner_id 唯一索引
    try {
      // 先清理同 account+owner_id 的重复数据，保留最新一条
      await connection.execute(`DELETE t1 FROM purchase_accounts t1 INNER JOIN purchase_accounts t2 ON t1.account = t2.account AND t1.owner_id = t2.owner_id AND t1.id > t2.id`)
      await connection.execute(`ALTER TABLE purchase_accounts ADD UNIQUE KEY uk_account_owner (account, owner_id)`)
      console.log('[DB] 已添加 purchase_accounts.uk_account_owner 唯一索引')
    } catch (e) { /* 索引已存在 */ }

    // 兼容已存在的 purchase_orders 表：添加 created_by 字段
    try {
      await connection.execute(`ALTER TABLE purchase_orders ADD COLUMN created_by INT DEFAULT NULL COMMENT '创建者用户ID' AFTER owner_id`)
      console.log('[DB] 已添加 purchase_orders.created_by 字段')
    } catch (e) { /* 字段已存在 */ }

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

    // 数据迁移：为已有数据设置归属关系
    // 子账号默认挂载到 id=1 的主账号下
    await connection.execute(`UPDATE users SET parent_id = 1 WHERE user_type = 'sub' AND parent_id IS NULL`)
    // 已有店铺和仓库默认归属 id=1 的主账号
    await connection.execute(`UPDATE stores SET owner_id = 1 WHERE owner_id IS NULL`)
    await connection.execute(`UPDATE warehouses SET owner_id = 1 WHERE owner_id IS NULL`)

    // ============ 仓库管理相关表 ============

    // 库存表（当前库存）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory (
        id INT PRIMARY KEY AUTO_INCREMENT,
        warehouse_id INT NOT NULL,
        sku VARCHAR(100) NOT NULL,
        product_name VARCHAR(300) NOT NULL DEFAULT '',
        quantity INT NOT NULL DEFAULT 0,
        warn_quantity INT NOT NULL DEFAULT 10,
        batch_no VARCHAR(50) DEFAULT '',
        supplier VARCHAR(100) DEFAULT '',
        location VARCHAR(100) DEFAULT '',
        owner_id INT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_wh_sku (warehouse_id, sku),
        KEY idx_warehouse (warehouse_id),
        KEY idx_owner (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 入库记录表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS stock_in_records (
        id INT PRIMARY KEY AUTO_INCREMENT,
        warehouse_id INT NOT NULL,
        sku VARCHAR(100) NOT NULL,
        product_name VARCHAR(300) NOT NULL DEFAULT '',
        quantity INT NOT NULL,
        batch_no VARCHAR(50) DEFAULT '',
        supplier VARCHAR(100) DEFAULT '',
        location VARCHAR(100) DEFAULT '',
        remark VARCHAR(500) DEFAULT '',
        operator_id INT DEFAULT NULL,
        operator_name VARCHAR(50) DEFAULT '',
        owner_id INT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_warehouse (warehouse_id),
        KEY idx_sku (sku),
        KEY idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 出库记录表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS stock_out_records (
        id INT PRIMARY KEY AUTO_INCREMENT,
        warehouse_id INT NOT NULL,
        sku VARCHAR(100) NOT NULL,
        product_name VARCHAR(300) NOT NULL DEFAULT '',
        quantity INT NOT NULL,
        type ENUM('sale', 'supply', 'transfer', 'other') DEFAULT 'sale',
        related_order VARCHAR(100) DEFAULT '',
        remark VARCHAR(500) DEFAULT '',
        operator_id INT DEFAULT NULL,
        operator_name VARCHAR(50) DEFAULT '',
        owner_id INT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_warehouse (warehouse_id),
        KEY idx_sku (sku),
        KEY idx_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 库存盘点表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_checks (
        id INT PRIMARY KEY AUTO_INCREMENT,
        check_no VARCHAR(20) NOT NULL,
        warehouse_id INT NOT NULL,
        total_items INT NOT NULL DEFAULT 0,
        diff_count INT NOT NULL DEFAULT 0,
        status ENUM('pending', 'checking', 'completed', 'cancelled') DEFAULT 'checking',
        operator_id INT DEFAULT NULL,
        operator_name VARCHAR(50) DEFAULT '',
        owner_id INT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_check_no (check_no),
        KEY idx_warehouse (warehouse_id),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 盘点明细表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS inventory_check_items (
        id INT PRIMARY KEY AUTO_INCREMENT,
        check_id INT NOT NULL,
        inventory_id INT NOT NULL,
        sku VARCHAR(100) NOT NULL,
        product_name VARCHAR(300) NOT NULL DEFAULT '',
        system_quantity INT NOT NULL DEFAULT 0,
        actual_quantity INT DEFAULT NULL,
        diff_quantity INT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_check (check_id),
        FOREIGN KEY (check_id) REFERENCES inventory_checks(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    console.log('[DB] 数据库初始化完成')
  } finally {
    connection.release()
  }
}

module.exports = { pool, initDB }
