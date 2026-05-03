-- 为采购订单表添加 account_id 字段
-- 用于记录订单是通过哪个采购账号创建的
-- 执行此迁移后，物流查询将使用订单关联的账号Cookie，而非随机选择

ALTER TABLE purchase_orders
ADD COLUMN account_id INT DEFAULT NULL COMMENT '采购账号ID',
ADD INDEX idx_account_id (account_id);

-- 说明：
-- 1. account_id 为 NULL 表示历史订单（迁移前创建）
-- 2. 新订单在创建时应记录 account_id
-- 3. 物流查询优先使用 account_id 获取Cookie，如果为NULL则 fallback 到当前逻辑
