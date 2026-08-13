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
        real_name VARCHAR(50) DEFAULT '',
        phone VARCHAR(20) DEFAULT '',
        password_hash VARCHAR(255) DEFAULT '',
        user_type ENUM('master', 'sub') DEFAULT 'sub',
        role ENUM('admin', 'staff') DEFAULT 'staff',
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
        setup_status ENUM('pending', 'active') DEFAULT 'active',
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
    try {
      await connection.execute(`ALTER TABLE stores ADD COLUMN setup_status ENUM('pending', 'active') DEFAULT 'active' AFTER status`)
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
    // 兼容已存在的 stores 表：添加 last_sync_at 字段（同步锁时间戳）
    try {
      await connection.execute(`ALTER TABLE stores ADD COLUMN last_sync_at DATETIME DEFAULT NULL`)
    } catch (e) { /* 字段已存在 */ }
    // 兼容已存在的 stores 表：添加 last_sync_device_id 字段（同步锁设备标识）
    try {
      await connection.execute(`ALTER TABLE stores ADD COLUMN last_sync_device_id VARCHAR(100) DEFAULT NULL AFTER last_sync_at`)
    } catch (e) { /* 字段已存在 */ }
    // 兼容已存在的 stores 表：添加 subscription_end 字段（店铺到期时间）
    try {
      await connection.execute(`ALTER TABLE stores ADD COLUMN subscription_end DATE DEFAULT NULL AFTER status`)
    } catch (e) { /* 字段已存在 */ }
    // 初始化所有店铺到期时间为 2026-06-30
    try {
      await connection.execute(`UPDATE stores SET subscription_end = '2026-06-30' WHERE subscription_end IS NULL`)
    } catch (e) { /* 忽略错误 */ }

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
        revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
        source_device_id VARCHAR(100) DEFAULT '',
        source_type VARCHAR(30) DEFAULT 'legacy',
        fingerprint CHAR(64) DEFAULT '',
        last_verified_at DATETIME DEFAULT NULL,
        saved_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_store_id (store_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // Cookie 版本字段：服务端版本用于阻止旧设备把新 Cookie 反向覆盖。
    try { await connection.execute(`ALTER TABLE cookies ADD COLUMN revision BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER domain`) } catch (e) { /* 字段已存在 */ }
    try { await connection.execute(`ALTER TABLE cookies ADD COLUMN source_device_id VARCHAR(100) DEFAULT '' AFTER revision`) } catch (e) { /* 字段已存在 */ }
    try { await connection.execute(`ALTER TABLE cookies ADD COLUMN source_type VARCHAR(30) DEFAULT 'legacy' AFTER source_device_id`) } catch (e) { /* 字段已存在 */ }
    try { await connection.execute(`ALTER TABLE cookies ADD COLUMN fingerprint CHAR(64) DEFAULT '' AFTER source_type`) } catch (e) { /* 字段已存在 */ }
    try { await connection.execute(`ALTER TABLE cookies ADD COLUMN last_verified_at DATETIME DEFAULT NULL AFTER fingerprint`) } catch (e) { /* 字段已存在 */ }

    // 每台设备分别上报店铺健康状态；店铺总体在线状态由最近验证成功的设备汇总得出。
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS store_device_status (
        store_id INT NOT NULL,
        device_id VARCHAR(100) NOT NULL,
        online TINYINT NOT NULL DEFAULT 0,
        last_verified_at DATETIME DEFAULT NULL,
        last_failure_at DATETIME DEFAULT NULL,
        failure_reason VARCHAR(255) DEFAULT '',
        cookie_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (store_id, device_id),
        KEY idx_store_recent_online (store_id, online, last_verified_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    try { await connection.execute(`ALTER TABLE store_device_status ADD KEY idx_store_recent_report (store_id, online, updated_at)`) } catch (e) { /* 索引已存在 */ }

    // 商家ID归并锁：按主账号+商家ID串行完成“查询并归并”，避免并发登录产生重复店铺。
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS store_merchant_locks (
        owner_id INT NOT NULL,
        merchant_id VARCHAR(50) NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (owner_id, merchant_id)
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
        buyer_message TEXT DEFAULT NULL COMMENT '买家留言（从平台同步）',
        order_remark TEXT DEFAULT NULL COMMENT '订单备注（商家在平台填写的备注，从平台同步）',
        sms_content TEXT DEFAULT NULL COMMENT '最近一次成功发送的短信内容',
        sms_sent_at DATETIME DEFAULT NULL COMMENT '最近一次短信发送时间',
        sms_send_count INT NOT NULL DEFAULT 0 COMMENT '短信发送次数',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_store_order (store_id, order_id),
        KEY idx_store_status (store_id, status_text),
        KEY idx_order_time (order_time)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 兼容已存在的 sales_orders 表：添加买家留言字段
    try {
      await connection.execute(`ALTER TABLE sales_orders ADD COLUMN buyer_message TEXT DEFAULT NULL COMMENT '买家留言（从平台同步）' AFTER raw_data`)
    } catch (e) { /* 字段已存在 */ }
    // 兼容已存在的 sales_orders 表：添加订单备注字段
    try {
      await connection.execute(`ALTER TABLE sales_orders ADD COLUMN order_remark TEXT DEFAULT NULL COMMENT '订单备注（商家在平台填写的备注，从平台同步）' AFTER buyer_message`)
    } catch (e) { /* 字段已存在 */ }
    // 兼容已存在的 sales_orders 表：添加库存分配状态字段
    try {
      await connection.execute(`ALTER TABLE sales_orders ADD COLUMN stock_status TINYINT NOT NULL DEFAULT 0 COMMENT '库存分配: 0=未处理, 1=延迟发货, 2=仓库直发(已扣库存)'`)
    } catch (e) { /* 字段已存在 */ }
    // 兼容已存在的 sales_orders 表：添加问题事件标记字段
    try {
      await connection.execute(`ALTER TABLE sales_orders ADD COLUMN issue_event VARCHAR(50) DEFAULT NULL COMMENT '问题事件标记（如职业打假、超时未发货等）'`)
    } catch (e) { /* 字段已存在 */ }
    // 兼容已存在的 sales_orders 表：添加短信通知摘要字段
    try {
      await connection.execute(`ALTER TABLE sales_orders ADD COLUMN sms_content TEXT DEFAULT NULL COMMENT '最近一次成功发送的短信内容'`)
    } catch (e) { /* 字段已存在 */ }
    try {
      await connection.execute(`ALTER TABLE sales_orders ADD COLUMN sms_sent_at DATETIME DEFAULT NULL COMMENT '最近一次短信发送时间'`)
    } catch (e) { /* 字段已存在 */ }
    try {
      await connection.execute(`ALTER TABLE sales_orders ADD COLUMN sms_send_count INT NOT NULL DEFAULT 0 COMMENT '短信发送次数'`)
    } catch (e) { /* 字段已存在 */ }

    // 短信发送记录：第三方密钥只保存在服务端环境变量，本表不保存任何密钥
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS sms_send_records (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        request_id VARCHAR(64) NOT NULL,
        owner_id INT NOT NULL,
        sender_user_id INT NOT NULL,
        sales_order_id INT NOT NULL,
        store_id INT NOT NULL,
        order_no VARCHAR(50) NOT NULL,
        phone VARCHAR(30) NOT NULL,
        sign_name VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        sms_count INT NOT NULL DEFAULT 1,
        status ENUM('sending', 'success', 'failed') NOT NULL DEFAULT 'sending',
        provider_response TEXT DEFAULT NULL,
        error_message VARCHAR(500) DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        sent_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_sms_request (owner_id, request_id),
        KEY idx_sms_order (sales_order_id, created_at),
        KEY idx_sms_owner (owner_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    // 打假人信息库
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS fraudster_buyers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        buyer_account VARCHAR(255) NOT NULL COMMENT '买家账号',
        buyer_name VARCHAR(255) DEFAULT NULL COMMENT '买家姓名',
        buyer_phone VARCHAR(50) DEFAULT NULL COMMENT '买家手机号',
        buyer_address TEXT DEFAULT NULL COMMENT '收货地址',
        source_order_id VARCHAR(100) DEFAULT NULL COMMENT '来源订单ID',
        source_order_no VARCHAR(100) DEFAULT NULL COMMENT '来源订单号',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_buyer_account (buyer_account)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='打假人信息库'
    `)

    // 插入默认数据
    const [rows] = await connection.execute("SELECT COUNT(*) as count FROM users")
    if (rows[0].count === 0) {
      await connection.execute(`
        INSERT INTO users (id, username, real_name, phone, password_hash, user_type, role, status, created_at)
        VALUES (1, 'admin', '', '13800138000', 'admin', 'master', 'admin', 'enabled', NOW()),
               (2, 'staff01', '', '13900139000', '123456', 'sub', 'staff', 'enabled', NOW())
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

    // SKU绑定表（关联店铺SKU到仓库库存）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS sku_bindings (
        id INT PRIMARY KEY AUTO_INCREMENT,
        store_id INT NOT NULL,
        sku_id VARCHAR(100) NOT NULL,
        inventory_id INT NOT NULL,
        warehouse_id INT NOT NULL,
        package_num INT NOT NULL DEFAULT 1 COMMENT '包装规格：1个店铺SKU对应多少个仓库SKU',
        owner_id INT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_store_sku (store_id, sku_id),
        KEY idx_inventory (inventory_id),
        KEY idx_owner (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    // 兼容已存在的 sku_bindings 表：添加 package_num 字段
    try {
      await connection.execute(`ALTER TABLE sku_bindings ADD COLUMN package_num INT NOT NULL DEFAULT 1 COMMENT '包装规格：1个店铺SKU对应多少个仓库SKU'`)
    } catch (e) { /* 字段已存在 */ }

    // 售后纠纷指标表（按店铺存储各平台运营待办数据）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS store_aftersale_metrics (
        id INT PRIMARY KEY AUTO_INCREMENT,
        store_id INT NOT NULL,
        platform VARCHAR(20) DEFAULT '',
        overdue_orders INT DEFAULT 0,
        pending_follow_ups INT DEFAULT 0,
        cancelled_orders INT DEFAULT 0,
        pending_review_aftersales INT DEFAULT 0,
        pending_process_aftersales INT DEFAULT 0,
        pending_receive_aftersales INT DEFAULT 0,
        pending_reply_disputes INT DEFAULT 0,
        pending_evidence_disputes INT DEFAULT 0,
        pending_execute_disputes INT DEFAULT 0,
        pending_compensation INT DEFAULT 0,
        pending_warnings INT DEFAULT 0,
        pending_violations INT DEFAULT 0,
        pending_industry_complaints INT DEFAULT 0,
        pending_task_orders INT DEFAULT 0,
        raw_data LONGTEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_store_platform (store_id, platform)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // ======== 采购相关索引优化 ========
    // purchase_orders 表缺少的关键索引（全表扫描是首页加载慢的主因）
    try { await connection.execute('CREATE INDEX idx_owner_id ON purchase_orders(owner_id)') } catch(e) { /* 索引已存在 */ }
    try { await connection.execute('CREATE INDEX idx_owner_status ON purchase_orders(owner_id, status)') } catch(e) { /* 索引已存在 */ }
    try { await connection.execute('CREATE INDEX idx_owner_platform ON purchase_orders(owner_id, platform)') } catch(e) { /* 索引已存在 */ }
    try { await connection.execute('CREATE INDEX idx_created_by ON purchase_orders(created_by)') } catch(e) { /* 索引已存在 */ }
    // 复合索引：服务端分页筛选优化（owner_id + status + platform 三条件联合查询）
    try { await connection.execute('CREATE INDEX idx_owner_status_platform ON purchase_orders(owner_id, status, platform)') } catch(e) { /* 索引已存在 */ }
    // purchase_accounts 表缺少的索引
    try { await connection.execute('CREATE INDEX idx_pa_owner_id ON purchase_accounts(owner_id)') } catch(e) { /* 索引已存在 */ }
    // user_purchase_accounts 表缺少的索引（子账号权限查询核心）
    try { await connection.execute('CREATE INDEX idx_upa_user_id ON user_purchase_accounts(user_id)') } catch(e) { /* 索引已存在 */ }
    try { await connection.execute('CREATE INDEX idx_upa_account_id ON user_purchase_accounts(account_id)') } catch(e) { /* 索引已存在 */ }

    // ======== 采购单订单金额字段 ========
    try {
      await connection.execute("ALTER TABLE purchase_orders ADD COLUMN total_amount DECIMAL(12,2) DEFAULT 0 COMMENT '订单金额(实付总额)'")
    } catch(e) { /* 列已存在 */ }
    try {
      await connection.execute("ALTER TABLE purchase_orders ADD COLUMN shipping_fee DECIMAL(12,2) DEFAULT 0 COMMENT '运费'")
    } catch(e) { /* 列已存在 */ }

    // ======== 云仓销售订单定位版本 ========
    // 异常查询号和年份来自关联 sales_orders.order_id / YEAR(sales_orders.order_time)，
    // 不使用采购单 created_at，也不要求人工确认年份。
    try {
      await connection.execute("ALTER TABLE purchase_orders ADD COLUMN cloud_locator_version BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '云仓关联销售订单定位版本'")
    } catch(e) { /* 列已存在 */ }
    try { await connection.execute('CREATE INDEX idx_purchase_cloud_sales_locator ON purchase_orders(owner_id, sales_order_id, sales_order_no)') } catch(e) { /* 索引已存在 */ }

    // ======== 淘宝物流取件信息 ========
    try {
      await connection.execute("ALTER TABLE purchase_orders ADD COLUMN pickup_code VARCHAR(100) DEFAULT '' COMMENT '物流取件码'")
    } catch(e) { /* 列已存在 */ }
    try {
      await connection.execute("ALTER TABLE purchase_orders ADD COLUMN pickup_address VARCHAR(500) DEFAULT '' COMMENT '物流取件地址'")
    } catch(e) { /* 列已存在 */ }

    // ======== 采购物流时效学习样本 ========
    // 仅保存省/市/区县和时间节点，不保存收件人、电话或完整收货地址。
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS shipping_timeliness_observations (
        id BIGINT PRIMARY KEY AUTO_INCREMENT,
        purchase_order_id INT NOT NULL,
        owner_id INT DEFAULT NULL,
        platform_order_no VARCHAR(100) DEFAULT '',
        platform VARCHAR(20) DEFAULT '',
        source_key VARCHAR(180) DEFAULT '',
        origin_raw VARCHAR(100) DEFAULT '',
        origin_province VARCHAR(40) NOT NULL,
        origin_city VARCHAR(60) DEFAULT '',
        origin_county VARCHAR(60) DEFAULT '',
        destination_province VARCHAR(40) NOT NULL,
        destination_city VARCHAR(60) DEFAULT '',
        destination_county VARCHAR(60) DEFAULT '',
        ordered_at DATETIME DEFAULT NULL,
        picked_up_at DATETIME DEFAULT NULL,
        signed_at DATETIME DEFAULT NULL,
        dispatch_hours DECIMAL(10,2) DEFAULT NULL,
        transit_hours DECIMAL(10,2) DEFAULT NULL,
        total_hours DECIMAL(10,2) DEFAULT NULL,
        outcome VARCHAR(30) DEFAULT 'delivered',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_purchase_order (purchase_order_id),
        KEY idx_route_city (origin_province, origin_city, destination_province, destination_city),
        KEY idx_route_province (origin_province, destination_province),
        KEY idx_origin_dispatch (origin_province, origin_city, ordered_at),
        KEY idx_source_outcome (source_key, outcome),
        KEY idx_signed_at (signed_at),
        KEY idx_owner (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    try {
      await connection.execute("ALTER TABLE shipping_timeliness_observations ADD COLUMN total_hours DECIMAL(10,2) DEFAULT NULL AFTER transit_hours")
    } catch(e) { /* 列已存在 */ }
    try {
      await connection.execute("ALTER TABLE shipping_timeliness_observations ADD COLUMN source_key VARCHAR(180) DEFAULT '' AFTER platform")
    } catch(e) { /* 列已存在 */ }
    try {
      await connection.execute("ALTER TABLE shipping_timeliness_observations ADD COLUMN outcome VARCHAR(30) DEFAULT 'delivered' AFTER total_hours")
    } catch(e) { /* 列已存在 */ }
    try {
      await connection.execute('ALTER TABLE shipping_timeliness_observations MODIFY picked_up_at DATETIME DEFAULT NULL, MODIFY signed_at DATETIME DEFAULT NULL, MODIFY transit_hours DECIMAL(10,2) DEFAULT NULL')
    } catch(e) { /* 已兼容可空字段 */ }
    try {
      await connection.execute('CREATE INDEX idx_source_outcome ON shipping_timeliness_observations(source_key, outcome)')
    } catch(e) { /* 索引已存在 */ }
    try {
      await connection.execute('CREATE INDEX idx_origin_dispatch ON shipping_timeliness_observations(origin_province, origin_city, ordered_at)')
    } catch(e) { /* 索引已存在 */ }

    // ======== 采购单售后状态字段 ========
    try {
      await connection.execute("ALTER TABLE purchase_orders ADD COLUMN aftersale_status VARCHAR(30) DEFAULT 'none' COMMENT '售后状态: none/pending_refund/pending_merchant_handle/pending_return_refund/pending_return_tracking/closed'")
    } catch(e) { /* 列已存在 */ }
    try {
      await connection.execute('ALTER TABLE purchase_orders ADD COLUMN aftersale_remark TEXT DEFAULT NULL COMMENT \'售后备注\'')
    } catch(e) { /* 列已存在 */ }
    try { await connection.execute('CREATE INDEX idx_owner_aftersale ON purchase_orders(owner_id, aftersale_status)') } catch(e) { /* 索引已存在 */ }

    // 迁移旧数据：将 pending_after_sale 状态拆分为 status=completed + aftersale_status=pending_refund
    try {
      const [result] = await connection.execute("UPDATE purchase_orders SET status='completed', aftersale_status='pending_refund' WHERE status='pending_after_sale'")
      if (result.affectedRows > 0) {
        console.log(`[DB] 已迁移 ${result.affectedRows} 条 pending_after_sale 记录`)
      }
    } catch(e) {
      console.warn('[DB] 迁移 pending_after_sale 记录失败:', e.message)
    }

    // ======== 云仓助手机器码绑定与中央任务基础设施 ========
    // 机器码只是设备路由标识，不承担身份认证。绑定单位是主账号体系（租户），
    // 主账号和已授权子账号共享；同一个机器码不能被无关主账号体系占用。
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_machine_bindings (
        id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        owner_id INT NOT NULL,
        machine_code VARCHAR(12) NOT NULL,
        binding_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        bound_by INT NOT NULL,
        bound_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_cloud_binding_owner (owner_id),
        UNIQUE KEY uk_cloud_binding_machine (machine_code),
        CONSTRAINT fk_cloud_binding_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_machine_binding_audit (
        id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        owner_id INT NOT NULL,
        actor_user_id INT NOT NULL,
        action VARCHAR(20) NOT NULL,
        old_machine_code VARCHAR(12) DEFAULT '',
        new_machine_code VARCHAR(12) DEFAULT '',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_cloud_binding_audit_owner (owner_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 云仓助手运行状态。机器码只负责路由，执行器使用独立凭据认证。
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_executor_machines (
        machine_code VARCHAR(12) PRIMARY KEY,
        status VARCHAR(20) NOT NULL DEFAULT 'offline',
        active_executor_instance_id VARCHAR(100) DEFAULT '',
        protocol_version VARCHAR(20) DEFAULT '',
        executor_version VARCHAR(50) DEFAULT '',
        capabilities_json JSON DEFAULT NULL,
        printer_available TINYINT NOT NULL DEFAULT 0,
        login_environment_available TINYINT NOT NULL DEFAULT 0,
        last_heartbeat_at DATETIME(3) DEFAULT NULL,
        last_failure_reason VARCHAR(255) DEFAULT '',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_cloud_machine_heartbeat (status, last_heartbeat_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_executor_instances (
        executor_instance_id VARCHAR(100) PRIMARY KEY,
        machine_code VARCHAR(12) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'offline',
        protocol_version VARCHAR(20) DEFAULT '',
        executor_version VARCHAR(50) DEFAULT '',
        capabilities_json JSON DEFAULT NULL,
        printer_available TINYINT NOT NULL DEFAULT 0,
        login_environment_available TINYINT NOT NULL DEFAULT 0,
        started_at DATETIME(3) DEFAULT NULL,
        last_heartbeat_at DATETIME(3) DEFAULT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_cloud_instance_machine (machine_code, status, last_heartbeat_at),
        CONSTRAINT fk_cloud_instance_machine FOREIGN KEY (machine_code)
          REFERENCES cloud_executor_machines(machine_code) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_executor_enrollments (
        enrollment_id VARCHAR(64) PRIMARY KEY,
        owner_id INT NOT NULL,
        machine_code VARCHAR(12) NOT NULL,
        code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        used_at DATETIME(3) DEFAULT NULL,
        issued_by_user_id INT NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_cloud_enrollment_code_hash (code_hash),
        KEY idx_cloud_enrollment_machine (machine_code, expires_at),
        KEY idx_cloud_enrollment_owner (owner_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_executor_credentials (
        credential_id VARCHAR(64) PRIMARY KEY,
        client_id VARCHAR(64) NOT NULL,
        machine_code VARCHAR(12) NOT NULL,
        secret_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        issued_at DATETIME(3) NOT NULL,
        last_used_at DATETIME(3) DEFAULT NULL,
        revoked_at DATETIME(3) DEFAULT NULL,
        revoke_reason VARCHAR(80) DEFAULT '',
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_cloud_executor_client (client_id),
        KEY idx_cloud_credential_machine (machine_code, status),
        CONSTRAINT fk_cloud_credential_machine FOREIGN KEY (machine_code)
          REFERENCES cloud_executor_machines(machine_code) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_executor_access_tokens (
        token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        credential_id VARCHAR(64) NOT NULL,
        machine_code VARCHAR(12) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        last_used_at DATETIME(3) DEFAULT NULL,
        revoked_at DATETIME(3) DEFAULT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_cloud_token_credential (credential_id, expires_at),
        KEY idx_cloud_token_machine (machine_code, expires_at),
        CONSTRAINT fk_cloud_token_credential FOREIGN KEY (credential_id)
          REFERENCES cloud_executor_credentials(credential_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // order_ref_id 是中央服务生成的不透明订单引用。具体业务订单映射待接口确认后写入 aliases。
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_order_refs (
        order_ref_id VARCHAR(64) PRIMARY KEY,
        owner_id INT NOT NULL,
        purchase_order_id INT DEFAULT NULL,
        created_by_user_id INT NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_cloud_order_ref_purchase (owner_id, purchase_order_id),
        KEY idx_cloud_order_ref_owner (owner_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    // 兼容已由上一版基础设施创建的表。
    try { await connection.execute('ALTER TABLE cloud_order_refs ADD COLUMN purchase_order_id INT DEFAULT NULL AFTER owner_id') } catch(e) { /* 列已存在 */ }
    try { await connection.execute('CREATE UNIQUE INDEX uk_cloud_order_ref_purchase ON cloud_order_refs(owner_id, purchase_order_id)') } catch(e) { /* 索引已存在 */ }

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_order_ref_aliases (
        id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        order_ref_id VARCHAR(64) NOT NULL,
        namespace VARCHAR(50) NOT NULL,
        scope_json JSON DEFAULT NULL,
        alias_value VARCHAR(255) NOT NULL,
        alias_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        verified TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_cloud_order_alias (namespace, alias_fingerprint),
        KEY idx_cloud_alias_order_ref (order_ref_id),
        CONSTRAINT fk_cloud_alias_order_ref FOREIGN KEY (order_ref_id)
          REFERENCES cloud_order_refs(order_ref_id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_order_workflows (
        workflow_id VARCHAR(64) PRIMARY KEY,
        order_ref_id VARCHAR(64) NOT NULL,
        owner_id INT NOT NULL,
        created_by_user_id INT NOT NULL,
        state VARCHAR(40) NOT NULL,
        state_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        poll_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
        next_check_at DATETIME(3) DEFAULT NULL,
        current_task_id VARCHAR(64) DEFAULT NULL,
        target_machine_code VARCHAR(12) NOT NULL,
        binding_version BIGINT UNSIGNED NOT NULL,
        locator_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
        last_observed_status VARCHAR(80) DEFAULT '',
        last_observed_at DATETIME(3) DEFAULT NULL,
        last_reason VARCHAR(80) DEFAULT '',
        last_message_redacted VARCHAR(500) DEFAULT '',
        review_reason VARCHAR(80) DEFAULT '',
        review_required_at DATETIME(3) DEFAULT NULL,
        review_resolved_at DATETIME(3) DEFAULT NULL,
        forwarded_applied_at DATETIME(3) DEFAULT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        completed_at DATETIME(3) DEFAULT NULL,
        KEY idx_cloud_workflow_order (order_ref_id),
        KEY idx_cloud_workflow_schedule (state, next_check_at),
        KEY idx_cloud_workflow_owner (owner_id, created_at),
        CONSTRAINT fk_cloud_workflow_order_ref FOREIGN KEY (order_ref_id)
          REFERENCES cloud_order_refs(order_ref_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    try { await connection.execute('ALTER TABLE cloud_order_workflows ADD COLUMN locator_version BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER binding_version') } catch(e) { /* 列已存在 */ }

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_order_tasks (
        task_id VARCHAR(64) PRIMARY KEY,
        workflow_id VARCHAR(64) NOT NULL,
        trace_id VARCHAR(64) NOT NULL,
        order_ref_id VARCHAR(64) NOT NULL,
        requested_by_user_id INT NOT NULL,
        poll_sequence BIGINT UNSIGNED DEFAULT NULL,
        protocol_version VARCHAR(20) NOT NULL,
        command VARCHAR(50) NOT NULL,
        idempotency_key VARCHAR(80) NOT NULL,
        payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        requested_by_json JSON NOT NULL,
        target_machine_code VARCHAR(12) NOT NULL,
        confirmation_json JSON DEFAULT NULL,
        params_json JSON NOT NULL,
        scheduled_for DATETIME(3) DEFAULT NULL,
        created_at DATETIME(3) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        transport_status VARCHAR(30) NOT NULL DEFAULT 'pending',
        execution_status VARCHAR(30) DEFAULT NULL,
        reason VARCHAR(80) DEFAULT '',
        message_redacted VARCHAR(500) DEFAULT '',
        lease_id VARCHAR(64) DEFAULT '',
        lease_fencing_token BIGINT UNSIGNED DEFAULT NULL,
        lease_expires_at DATETIME(3) DEFAULT NULL,
        last_renewed_at DATETIME(3) DEFAULT NULL,
        claimed_executor_instance_id VARCHAR(100) DEFAULT '',
        received_at DATETIME(3) DEFAULT NULL,
        started_at DATETIME(3) DEFAULT NULL,
        completed_at DATETIME(3) DEFAULT NULL,
        delivery_received TINYINT NOT NULL DEFAULT 0,
        delivery_executed TINYINT NOT NULL DEFAULT 0,
        delivery_replayed TINYINT NOT NULL DEFAULT 0,
        business_confirmed TINYINT NOT NULL DEFAULT 0,
        verification_confirmed TINYINT NOT NULL DEFAULT 0,
        observed_status VARCHAR(80) DEFAULT '',
        observed_at DATETIME(3) DEFAULT NULL,
        executor_receipt_id VARCHAR(100) DEFAULT '',
        result_redacted_json JSON DEFAULT NULL,
        response_redacted_json JSON DEFAULT NULL,
        response_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
        result_recorded_at DATETIME(3) DEFAULT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_cloud_task_idempotency (idempotency_key),
        KEY idx_cloud_task_workflow (workflow_id, created_at),
        KEY idx_cloud_task_claim (target_machine_code, transport_status, scheduled_for, expires_at),
        CONSTRAINT fk_cloud_task_workflow FOREIGN KEY (workflow_id)
          REFERENCES cloud_order_workflows(workflow_id),
        CONSTRAINT fk_cloud_task_order_ref FOREIGN KEY (order_ref_id)
          REFERENCES cloud_order_refs(order_ref_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
    try { await connection.execute('ALTER TABLE cloud_order_tasks ADD COLUMN response_redacted_json JSON DEFAULT NULL AFTER result_redacted_json') } catch(e) { /* 列已存在 */ }
    try { await connection.execute('ALTER TABLE cloud_order_tasks ADD COLUMN result_recorded_at DATETIME(3) DEFAULT NULL AFTER response_hash') } catch(e) { /* 列已存在 */ }

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_order_write_locks (
        order_ref_id VARCHAR(64) PRIMARY KEY,
        workflow_id VARCHAR(64) NOT NULL,
        task_id VARCHAR(64) NOT NULL,
        fencing_token BIGINT UNSIGNED NOT NULL,
        lease_expires_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_cloud_write_lock_expiry (lease_expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS cloud_task_events (
        id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
        workflow_id VARCHAR(64) NOT NULL,
        task_id VARCHAR(64) DEFAULT NULL,
        event_type VARCHAR(80) NOT NULL,
        actor_type VARCHAR(30) DEFAULT '',
        actor_id VARCHAR(100) DEFAULT '',
        data_redacted_json JSON DEFAULT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_cloud_event_workflow (workflow_id, created_at),
        KEY idx_cloud_event_task (task_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // ======== 订阅系统相关表 ========

    // 订阅表（按 owner_id 唯一，一个主账号一条订阅）
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INT PRIMARY KEY AUTO_INCREMENT,
        owner_id INT NOT NULL UNIQUE,
        username VARCHAR(50) DEFAULT '',
        trial_end DATETIME DEFAULT NULL,
        subscription_end DATETIME DEFAULT NULL,
        subscription_tier VARCHAR(20) DEFAULT NULL,
        status ENUM('trial', 'active', 'expired') DEFAULT 'trial',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_owner (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 订阅订单表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS subscription_orders (
        id INT PRIMARY KEY AUTO_INCREMENT,
        order_no VARCHAR(50) NOT NULL UNIQUE,
        owner_id INT NOT NULL,
        username VARCHAR(50) DEFAULT '',
        tier VARCHAR(20) NOT NULL,
        plan VARCHAR(20) NOT NULL,
        amount INT NOT NULL,
        original_amount INT NOT NULL,
        discount_amount INT DEFAULT 0,
        status ENUM('pending', 'paid', 'expired') DEFAULT 'pending',
        wx_transaction_id VARCHAR(100) DEFAULT '',
        wx_code_url TEXT,
        paid_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_owner (owner_id),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    // 支付日志表
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS subscription_payment_logs (
        id INT PRIMARY KEY AUTO_INCREMENT,
        order_no VARCHAR(50) DEFAULT '',
        event_type VARCHAR(50) NOT NULL,
        raw_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_order (order_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)

    console.log('[DB] 数据库初始化完成')
  } finally {
    connection.release()
  }
}

// MySQL 连接池保活：定时执行 SELECT 1 防止连接超时断开
function startKeepAlive(intervalMs = 30 * 60 * 1000) {
  setInterval(async () => {
    try {
      await pool.execute('SELECT 1')
    } catch (e) {
      console.warn('[DB] keep-alive query failed:', e.message)
    }
  }, intervalMs)
  console.log('[DB] MySQL keep-alive started (interval:', intervalMs / 1000, 's)')
}

module.exports = { pool, initDB, startKeepAlive }
