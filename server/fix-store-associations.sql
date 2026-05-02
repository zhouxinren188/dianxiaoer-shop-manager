-- ====================================
-- 修复子账号店铺关联 SQL 脚本
-- 用途：为所有子账号自动关联其主账号名下的所有店铺
-- 执行方法：在服务器 MySQL 中执行此脚本
-- ====================================

-- 1. 查看当前子账号情况
SELECT '=== 当前子账号列表 ===' AS info;
SELECT id, username, user_type, parent_id, status 
FROM users 
WHERE user_type = 'sub' 
ORDER BY id;

-- 2. 查看每个主账号名下的店铺数量
SELECT '=== 主账号店铺统计 ===' AS info;
SELECT 
  u.id AS master_id,
  u.username AS master_name,
  COUNT(s.id) AS store_count
FROM users u
LEFT JOIN stores s ON u.id = s.owner_id
WHERE u.user_type = 'master'
GROUP BY u.id, u.username;

-- 3. 查看当前 user_stores 关联情况
SELECT '=== 当前店铺关联情况 ===' AS info;
SELECT 
  us.user_id,
  u.username,
  us.store_id,
  s.name AS store_name
FROM user_stores us
JOIN users u ON us.user_id = u.id
JOIN stores s ON us.store_id = s.id
ORDER BY us.user_id, us.store_id;

-- 4. 执行修复：为所有子账号关联其主账号名下的所有店铺
SELECT '=== 开始修复关联 ===' AS info;

INSERT IGNORE INTO user_stores (user_id, store_id)
SELECT sub.id, s.id
FROM users sub
JOIN stores s ON s.owner_id = sub.parent_id
WHERE sub.user_type = 'sub' 
  AND sub.parent_id IS NOT NULL;

-- 5. 验证修复结果
SELECT '=== 修复后的关联情况 ===' AS info;
SELECT 
  us.user_id,
  u.username,
  us.store_id,
  s.name AS store_name
FROM user_stores us
JOIN users u ON us.user_id = u.id
JOIN stores s ON us.store_id = s.id
ORDER BY us.user_id, us.store_id;

SELECT '=== 修复完成 ===' AS info;
