-- 查看当前所有店铺信息
SELECT id, name, platform, merchant_id, shop_id, account, status FROM stores ORDER BY id;

-- 查看"兔乐兔店"的订单数量
SELECT COUNT(*) as order_count FROM sales_orders WHERE store_id = (SELECT id FROM stores WHERE name = '兔乐兔店');

-- 查看"兔乐兔店"的部分订单（前20条）
SELECT so.id, so.order_id, so.store_id, s.name as store_name, s.merchant_id, so.order_time, so.total_amount, so.buyer_name
FROM sales_orders so
LEFT JOIN stores s ON so.store_id = s.id
WHERE s.name = '兔乐兔店'
ORDER BY so.order_time DESC
LIMIT 20;
