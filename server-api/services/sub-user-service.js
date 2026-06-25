const pool = require('./db')
const { TIER_PRICING } = require('./sub-order-service')

const PLAN_DAYS = {
  monthly: 30,
  quarterly: 90,
  half_yearly: 180,
  yearly: 365
}

const TIER_LABELS = { basic: '基础版', standard: '标准版', premium: '高级版', store: '店铺订阅' }

// 查找或创建订阅记录（按 owner_id 唯一查找）
async function findOrCreateSubscription(ownerId, username) {
  if (!ownerId) throw new Error('owner_id is required')

  const [rows] = await pool.execute(
    'SELECT * FROM subscriptions WHERE owner_id = ?',
    [ownerId]
  )

  if (rows.length > 0) {
    // 更新 username（每次登录可能不同）
    if (username && rows[0].username !== username) {
      await pool.execute(
        'UPDATE subscriptions SET username = ? WHERE owner_id = ?',
        [username, ownerId]
      )
    }
    // 重新查询确保返回最新数据
    const [latest] = await pool.execute(
      'SELECT * FROM subscriptions WHERE owner_id = ?',
      [ownerId]
    )
    return latest[0]
  }

  // 新建订阅记录，7天试用
  await pool.execute(
    `INSERT INTO subscriptions (owner_id, username, trial_end, subscription_end, subscription_tier, status)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY), NULL, NULL, 'trial')`,
    [ownerId, username || '']
  )

  const [newRows] = await pool.execute(
    'SELECT * FROM subscriptions WHERE owner_id = ?',
    [ownerId]
  )
  return newRows[0]
}

// 计算用户当前状态
function getUserStatus(sub) {
  const now = new Date()

  if (sub.subscription_end && new Date(sub.subscription_end) > now) {
    return 'active'
  }
  if (sub.trial_end && new Date(sub.trial_end) > now) {
    return 'trial'
  }
  return 'expired'
}

// 计算剩余天数
function getDaysRemaining(sub) {
  const now = new Date()
  const status = getUserStatus(sub)

  if (status === 'active') {
    return Math.ceil((new Date(sub.subscription_end) - now) / (24 * 60 * 60 * 1000))
  }
  if (status === 'trial') {
    return Math.ceil((new Date(sub.trial_end) - now) / (24 * 60 * 60 * 1000))
  }
  return 0
}

// 计算用户当前版本
function getUserTier(sub) {
  const status = getUserStatus(sub)
  if (status === 'trial') return 'basic'
  if (status === 'active') return sub.subscription_tier || 'basic'
  return sub.subscription_tier || 'basic'
}

// 计算当前订阅剩余价值（用于升级抵扣）
function calculateRemainingValue(sub) {
  const status = getUserStatus(sub)
  if (status !== 'active') return { dailyRate: 0, daysRemaining: 0, remainingValue: 0 }

  const currentTier = getUserTier(sub)
  const yearlyPrice = TIER_PRICING[currentTier]?.yearly || 0
  const dailyRate = Math.floor(yearlyPrice / 365)
  const daysRemaining = getDaysRemaining(sub)
  const remainingValue = Math.floor(daysRemaining * dailyRate)

  return { dailyRate, daysRemaining, remainingValue }
}

// 延长订阅
async function extendSubscription(ownerId, plan, tier, isUpgrade = false) {
  const days = PLAN_DAYS[plan]
  if (!days) throw new Error('Invalid plan')

  const [rows] = await pool.execute(
    'SELECT * FROM subscriptions WHERE owner_id = ?',
    [ownerId]
  )
  if (rows.length === 0) throw new Error('Subscription not found')

  const sub = rows[0]
  const now = new Date()
  let baseDate

  if (isUpgrade) {
    // 升级补差价：剩余价值已折算抵扣，从付款时刻起算新周期
    baseDate = now
  } else if (sub.subscription_end && new Date(sub.subscription_end) > now) {
    // 续费：从当前订阅结束时间延长
    baseDate = new Date(sub.subscription_end)
  } else {
    // 新订阅：从现在开始
    baseDate = now
  }

  const newEnd = new Date(baseDate.getTime() + days * 24 * 60 * 60 * 1000)

  if (tier) {
    await pool.execute(
      `UPDATE subscriptions SET subscription_end = ?, status = 'active', subscription_tier = ? WHERE owner_id = ?`,
      [newEnd, tier, ownerId]
    )
  } else {
    await pool.execute(
      `UPDATE subscriptions SET subscription_end = ?, status = 'active' WHERE owner_id = ?`,
      [newEnd, ownerId]
    )
  }

  return newEnd
}

// 纯查询订阅状态（不创建记录）
async function getSubscriptionStatus(ownerId) {
  const [rows] = await pool.execute(
    'SELECT * FROM subscriptions WHERE owner_id = ?',
    [ownerId]
  )
  if (rows.length === 0) {
    return { status: 'none', tier: null, exists: false }
  }
  const sub = rows[0]
  const status = getUserStatus(sub)
  const tier = getUserTier(sub)
  return { status, tier, exists: true, sub }
}

// 延长单个店铺的到期时间
async function extendStoreSubscription(storeIds, plan) {
  const days = PLAN_DAYS[plan]
  if (!days) throw new Error('Invalid plan')
  if (!Array.isArray(storeIds) || storeIds.length === 0) return

  const now = new Date()
  const newEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  const newEndStr = newEnd.toISOString().slice(0, 10)

  for (const storeId of storeIds) {
    // 查询当前到期时间
    const [rows] = await pool.execute(
      'SELECT subscription_end FROM stores WHERE id = ?',
      [storeId]
    )
    if (rows.length === 0) continue

    const currentEnd = rows[0].subscription_end
    let finalEnd

    if (currentEnd && new Date(currentEnd) > now) {
      // 续费：从当前到期时间延长
      finalEnd = new Date(new Date(currentEnd).getTime() + days * 24 * 60 * 60 * 1000)
    } else {
      // 新订阅：从现在开始
      finalEnd = newEnd
    }

    const finalEndStr = finalEnd.toISOString().slice(0, 10)
    await pool.execute(
      'UPDATE stores SET subscription_end = ? WHERE id = ?',
      [finalEndStr, storeId]
    )
  }

  return newEnd
}

// 获取单个订阅记录
async function getSubscription(ownerId) {
  const [rows] = await pool.execute(
    'SELECT * FROM subscriptions WHERE owner_id = ?',
    [ownerId]
  )
  return rows[0] || null
}

module.exports = {
  findOrCreateSubscription,
  getUserStatus,
  getDaysRemaining,
  getUserTier,
  calculateRemainingValue,
  extendSubscription,
  extendStoreSubscription,
  getSubscriptionStatus,
  getSubscription,
  PLAN_DAYS,
  TIER_LABELS
}
