-- 创建同步锁表
CREATE TABLE IF NOT EXISTS sync_locks (
  id INT PRIMARY KEY AUTO_INCREMENT,
  store_id INT NOT NULL,
  type VARCHAR(50) NOT NULL DEFAULT 'sales',
  device_id VARCHAR(255),
  locked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  INDEX idx_store_type (store_id, type),
  INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
