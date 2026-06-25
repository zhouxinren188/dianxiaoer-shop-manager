const pool = require('./db')

// 定价表（单位：分）
const TIER_PRICING = {
  basic:    { monthly: 9800,  quarterly: 29800,  yearly: 108800 },
  standard: { monthly: 19800, quarterly: 59800,  yearly: 188800 },
  premium:  { monthly: 49800, quarterly: 148800, yearly: 588800 }
}

const TIER_LABELS = { basic: '基础版', standard: '标准版', premium: '高级版', store: '店铺订阅' }
const PLAN_PERIOD_LABELS = { monthly: '月度', quarterly: '季度', half_yearly: '半年', yearly: '年度' }

// 按店铺订阅定价（单位：分/店）
const STORE_PLAN_PRICING = {
  monthly: 1500,
  quarterly: 4500,
  half_yearly: 6800
}

// 生成订单号
function generateOrderNo() {
  const now = new Date()
  const dateStr = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0')
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase()
  return `DX${dateStr}${rand}`
}

// 创建订单
async function createOrder(username, ownerId, tier, plan, discountAmount = 0) {
  const originalAmount = TIER_PRICING[tier]?.[plan]
  if (!originalAmount) throw new Error('Invalid tier or plan')

  const finalAmount = originalAmount - discountAmount
  const orderNo = generateOrderNo()

  await pool.execute(
    `INSERT INTO subscription_orders (order_no, owner_id, username, tier, plan, amount, original_amount, discount_amount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [orderNo, ownerId, username, tier, plan, finalAmount, originalAmount, discountAmount]
  )

  return {
    orderNo,
    amount: finalAmount,
    originalAmount,
    discountAmount,
    plan,
    tier,
    label: `${TIER_LABELS[tier]}${PLAN_PERIOD_LABELS[plan]}`
  }
}

// 查询订单
async function getOrder(orderNo) {
  const [rows] = await pool.execute(
    'SELECT * FROM subscription_orders WHERE order_no = ?',
    [orderNo]
  )
  return rows[0] || null
}

// 更新订单为已支付，返回是否实际更新（防止并发重复处理）
async function markOrderPaid(orderNo, wxTransactionId) {
  const [result] = await pool.execute(
    `UPDATE subscription_orders SET status = 'paid', paid_at = NOW(), wx_transaction_id = ?
     WHERE order_no = ? AND status = 'pending'`,
    [wxTransactionId || '', orderNo]
  )
  return result.affectedRows > 0
}

// 更新订单的微信支付信息
async function updateOrderWxInfo(orderNo, wxCodeUrl) {
  await pool.execute(
    'UPDATE subscription_orders SET wx_code_url = ? WHERE order_no = ?',
    [wxCodeUrl || '', orderNo]
  )
}

// 过期超时未支付的订单（30分钟）
async function expireOldOrders() {
  await pool.execute(
    `UPDATE subscription_orders SET status = 'expired'
     WHERE status = 'pending' AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)`
  )
}

// 记录支付日志
async function logPaymentEvent(orderNo, eventType, rawData) {
  await pool.execute(
    `INSERT INTO subscription_payment_logs (order_no, event_type, raw_data)
     VALUES (?, ?, ?)`,
    [orderNo || '', eventType, typeof rawData === 'string' ? rawData : JSON.stringify(rawData)]
  )
}

// 检查是否是首次付费
async function isFirstPayment(ownerId) {
  const [rows] = await pool.execute(
    "SELECT COUNT(*) as count FROM subscription_orders WHERE owner_id = ? AND status = 'paid'",
    [ownerId]
  )
  return rows[0].count === 0
}

// 按店铺创建订阅订单
async function createStoreOrder(username, ownerId, storeIds, plan) {
  const pricePerStore = STORE_PLAN_PRICING[plan]
  if (!pricePerStore) throw new Error('Invalid plan for store subscription')

  const storeCount = storeIds.length
  const totalAmount = pricePerStore * storeCount
  const orderNo = generateOrderNo()
  const tier = 'store'

  await pool.execute(
    `INSERT INTO subscription_orders (order_no, owner_id, username, tier, plan, amount, original_amount, discount_amount, status, store_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [orderNo, ownerId, username, tier, plan, totalAmount, totalAmount, 0, JSON.stringify(storeIds)]
  )

  return {
    orderNo,
    amount: totalAmount,
    originalAmount: totalAmount,
    discountAmount: 0,
    plan,
    tier,
    label: `${PLAN_PERIOD_LABELS[plan] || plan}`,
    storeIds
  }
}

module.exports = {
  createOrder,
  createStoreOrder,
  getOrder,
  markOrderPaid,
  updateOrderWxInfo,
  expireOldOrders,
  logPaymentEvent,
  isFirstPayment,
  TIER_PRICING,
  STORE_PLAN_PRICING,
  TIER_LABELS,
  PLAN_PERIOD_LABELS
}
