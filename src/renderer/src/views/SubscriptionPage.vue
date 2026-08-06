<template>
  <div class="sub-page">
    <!-- 顶部拖拽区域 -->
    <div class="drag-region-top">
      <div class="win-controls">
        <button class="ctrl-btn" @click="handleMinimize">
          <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
        </button>
        <button class="ctrl-btn close-btn" @click="handleClose">
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>
        </button>
      </div>
    </div>

    <div class="sub-container">
      <!-- 顶部标题 -->
      <div class="sub-header">
        <h1>店小二网店管家</h1>
        <div class="sub-user" v-if="currentUser">账号: {{ currentUser }}</div>
        <div class="sub-status-badge" :class="statusClass" v-if="subStatus">
          {{ statusText }}
          <span v-if="subStatus !== 'expired' && daysRemaining !== null" class="days-remaining">
            (剩余{{ daysRemaining }}天)
          </span>
        </div>
      </div>

      <!-- 版本选择 -->
      <div class="tier-selector" v-show="!paying">
        <div
          v-for="t in tiers"
          :key="t.key"
          class="tier-card"
          :class="{ selected: selectedTier === t.key }"
          @click="selectTier(t.key)"
        >
          <div v-if="t.badge" class="tier-badge">{{ t.badge }}</div>
          <div class="tier-name">{{ t.name }}</div>
        </div>
      </div>

      <!-- 周期选择 -->
      <div class="period-selector" v-show="!paying">
        <div
          v-for="p in periods"
          :key="p.key"
          class="period-card"
          :class="{ selected: selectedPlan === p.key }"
          @click="selectPlan(p.key)"
        >
          <div v-if="p.badge" class="period-badge">{{ p.badge }}</div>
          <div class="period-name">{{ p.name }}</div>
          <div class="period-price">
            {{ getPriceYuan(selectedTier, p.key) }}<span class="unit">元</span>
          </div>
          <div class="period-save" v-if="getSaveAmount(selectedTier, p.key) > 0">
            省{{ getSaveAmount(selectedTier, p.key) }}元
          </div>
        </div>
      </div>

      <!-- 版本功能对比 -->
      <div class="tier-intro" v-show="!paying">
        <div class="tier-intro-title">版本功能对比</div>
        <div class="tier-intro-table">
          <div class="tier-intro-row tier-intro-header">
            <span>功能</span>
            <span>基础版</span>
            <span>标准版</span>
            <span>高级版</span>
          </div>
          <div class="tier-intro-row" v-for="feat in features" :key="feat.name">
            <span>{{ feat.name }}</span>
            <span :class="feat.basic ? 'yes' : 'no'">{{ feat.basic ? '✓' : '—' }}</span>
            <span :class="feat.standard ? 'yes' : 'no'">{{ feat.standard ? '✓' : '—' }}</span>
            <span :class="feat.premium ? 'yes' : 'no'">{{ feat.premium ? '✓' : '—' }}</span>
          </div>
          <div class="tier-intro-row">
            <span>同时在线设备</span>
            <span class="yes">1台</span>
            <span class="yes">2台</span>
            <span class="yes">5台</span>
          </div>
        </div>
      </div>

      <!-- 抵扣信息 -->
      <div class="discount-info" v-show="discountAmount > 0 && !paying">
        <div class="discount-row">
          <span>原价</span>
          <span>{{ originalAmountYuan }}元</span>
        </div>
        <div class="discount-row discount">
          <span>当前版本剩余抵扣</span>
          <span>-{{ discountAmountYuan }}元</span>
        </div>
        <div class="discount-row final">
          <span>实付金额</span>
          <span>{{ finalAmountYuan }}元</span>
        </div>
      </div>

      <!-- 支付按钮 -->
      <button class="pay-btn" v-show="!paying" :disabled="creatingOrder" @click="handlePay">
        {{ creatingOrder ? '正在创建订单...' : '微信扫码支付' }}
      </button>

      <!-- 二维码区域 -->
      <div class="qr-section" v-show="paying">
        <div class="qr-title">请使用微信扫描下方二维码完成支付</div>
        <div class="qr-amount">{{ payAmountYuan }}<span class="unit">元</span></div>
        <div class="qr-box">
          <img v-if="qrDataUrl" :src="qrDataUrl" style="width:220px;height:220px;" alt="支付二维码" />
          <div v-else class="qr-loading">
            <el-icon class="is-loading" :size="32"><Loading /></el-icon>
          </div>
        </div>
        <div class="qr-hint">支付完成后将自动确认，请勿关闭页面</div>
        <div class="qr-status" :class="qrStatusClass">{{ qrStatusText }}</div>
        <button class="qr-cancel" @click="cancelPay">取消支付</button>
      </div>

      <!-- 底部说明 -->
      <div class="sub-footer">
        店小二网店管家 &copy; 2024 | 如有疑问请联系客服
      </div>
    </div>

    <!-- 支付成功弹窗 -->
    <div class="success-overlay" v-show="showSuccess">
      <div class="success-box">
        <div class="success-icon">✓</div>
        <div class="success-title">支付成功</div>
        <div class="success-desc">{{ successDesc }}</div>
        <button class="success-btn" @click="enterApp">进入软件</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Loading } from '@element-plus/icons-vue'
import { checkStatus, createOrder, queryOrder, generateQRCode } from '@/api/subscription'

const router = useRouter()

// ========== 状态 ==========
const currentUser = ref(localStorage.getItem('currentUser') || '')
const subStatus = ref(null) // 'trial' | 'active' | 'expired'
const subTier = ref(null)
const daysRemaining = ref(null)
const isFirstPayment = ref(true)
const pricingData = ref(null)

const selectedTier = ref('basic')
const selectedPlan = ref('monthly')

const paying = ref(false)
const creatingOrder = ref(false)
const qrDataUrl = ref('')
const qrStatusText = ref('等待扫码支付...')
const qrStatusClass = ref('')
const currentOrderNo = ref(null)
const showSuccess = ref(false)
const successDesc = ref('')

const originalAmountYuan = ref(0)
const discountAmount = ref(0)
const discountAmountYuan = ref(0)
const finalAmountYuan = ref(0)
const payAmountYuan = ref(0)

let pollTimer = null

// ========== 静态数据 ==========
const tiers = [
  { key: 'basic', name: '基础版' },
  { key: 'standard', name: '标准版' },
  { key: 'premium', name: '高级版', badge: '推荐' }
]

const periods = [
  { key: 'monthly', name: '月度' },
  { key: 'quarterly', name: '季度' },
  { key: 'yearly', name: '年度', badge: '最划算' }
]

const tierNames = { basic: '基础版', standard: '标准版', premium: '高级版' }
const planNames = { monthly: '月度', quarterly: '季度', yearly: '年度' }

const features = [
  { name: '销售订单管理', basic: true, standard: true, premium: true },
  { name: '商品库存管理', basic: true, standard: true, premium: true },
  { name: '采购订单管理', basic: false, standard: true, premium: true },
  { name: '售后退货处理', basic: false, standard: true, premium: true },
  { name: '供应链协同', basic: false, standard: false, premium: true },
  { name: '报表数据分析', basic: false, standard: false, premium: true }
]

// ========== 计算属性 ==========
const statusClass = computed(() => subStatus.value || '')
const statusText = computed(() => {
  if (!subStatus.value) return ''
  if (subStatus.value === 'expired') return '使用时长已到期，请续费'
  if (subStatus.value === 'trial') return '试用中'
  const label = tierNames[subTier.value] || ''
  return label ? `${label} 订阅有效` : '订阅有效'
})

// ========== 方法 ==========
function getPriceYuan(tier, plan) {
  if (!pricingData.value || !pricingData.value[tier]) return '--'
  return Math.floor(pricingData.value[tier][plan] / 100)
}

function getSaveAmount(tier, plan) {
  if (!pricingData.value || !pricingData.value[tier]) return 0
  const prices = pricingData.value[tier]
  if (plan === 'quarterly') {
    const monthlyTotal = prices.monthly * 3
    return Math.floor((monthlyTotal - prices.quarterly) / 100)
  }
  if (plan === 'yearly') {
    const monthlyTotal = prices.monthly * 12
    return Math.floor((monthlyTotal - prices.yearly) / 100)
  }
  return 0
}

function selectTier(tier) {
  selectedTier.value = tier
  // 清除旧的抵扣信息
  discountAmount.value = 0
}

function selectPlan(plan) {
  selectedPlan.value = plan
}

// 窗口控制
function handleMinimize() {
  window.electronAPI?.invoke('window-minimize')
}
// 退出确认弹窗
function showQuitConfirm() {
  ElMessageBox.confirm('确定要退出店小二网店管家吗？', '退出确认', {
    confirmButtonText: '退出',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(() => {
    window.electronAPI?.invoke('window-close')
  }).catch(() => {})
}

function handleClose() {
  showQuitConfirm()
}

async function loadStatus() {
  try {
    const res = await checkStatus()
    if (res.success) {
      subStatus.value = res.status
      subTier.value = res.tier
      daysRemaining.value = res.days_remaining
      isFirstPayment.value = res.is_first_payment
      pricingData.value = res.pricing

      // 付费用户默认选中当前版本
      if (res.tier && res.status !== 'trial') {
        selectedTier.value = res.tier
      }
    }
  } catch (e) {
    ElMessage.error('获取订阅信息失败: ' + (e.message || '网络错误'))
  }
}

async function handlePay() {
  creatingOrder.value = true
  try {
    const res = await createOrder(selectedTier.value, selectedPlan.value)
    if (!res.success) {
      ElMessage.error(res.message || '创建订单失败')
      return
    }

    currentOrderNo.value = res.order_no

    // 计算金额（分→元）
    const originalYuan = res.original_amount != null ? Math.floor(res.original_amount / 100) : getPriceYuan(selectedTier.value, selectedPlan.value)
    const discountYuan = res.discount_amount != null ? Math.floor(res.discount_amount / 100) : 0
    const finalYuan = originalYuan - discountYuan

    originalAmountYuan.value = originalYuan
    discountAmount.value = res.discount_amount || 0
    discountAmountYuan.value = discountYuan
    finalAmountYuan.value = finalYuan
    payAmountYuan.value = finalYuan

    // 生成二维码
    paying.value = true
    qrStatusText.value = '等待扫码支付...'
    qrStatusClass.value = ''

    const dataUrl = await generateQRCode(res.code_url)
    qrDataUrl.value = dataUrl

    // 开始轮询
    startPolling(res.order_no)
  } catch (e) {
    ElMessage.error('创建订单失败: ' + (e.message || '网络错误'))
  } finally {
    creatingOrder.value = false
  }
}

function startPolling(orderNo) {
  stopPolling()
  let count = 0
  pollTimer = setInterval(async () => {
    count++
    if (count > 180) {
      stopPolling()
      qrStatusText.value = '支付超时，请重试'
      qrStatusClass.value = 'error'
      return
    }
    try {
      const res = await queryOrder(orderNo)
      if (res.success && res.status === 'paid') {
        stopPolling()
        onPaymentSuccess()
      }
    } catch {
      // 忽略网络错误，继续轮询
    }
  }, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function onPaymentSuccess() {
  qrStatusText.value = '支付成功！'
  qrStatusClass.value = 'success'

  const tierName = tierNames[selectedTier.value] || selectedTier.value
  const planName = planNames[selectedPlan.value] || selectedPlan.value
  successDesc.value = `${tierName} ${planName}套餐已激活，感谢您的支持！`
  showSuccess.value = true
}

function cancelPay() {
  stopPolling()
  currentOrderNo.value = null
  paying.value = false
  qrDataUrl.value = ''
  qrStatusText.value = '等待扫码支付...'
  qrStatusClass.value = ''
  discountAmount.value = 0
}

function enterApp() {
  showSuccess.value = false
  router.replace('/')
}

// ========== 生命周期 ==========
let unsubCloseRequested = null
onMounted(() => {
  loadStatus()
  unsubCloseRequested = window.electronAPI?.onUpdate('app-close-requested', () => {
    showQuitConfirm()
  })
})

onUnmounted(() => {
  stopPolling()
  unsubCloseRequested?.()
})
</script>

<style scoped>
.sub-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f5f5f5;
  overflow-y: auto;
  position: relative;
}

/* 顶部拖拽区域 */
.drag-region-top {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 30px;
  -webkit-app-region: drag;
  z-index: 100;
}

.win-controls {
  position: absolute;
  top: 0;
  right: 0;
  display: flex;
  -webkit-app-region: no-drag;
}

.ctrl-btn {
  width: 36px;
  height: 28px;
  border: none;
  background: transparent;
  color: #909399;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.ctrl-btn:hover {
  background: #f0f0f0;
  color: #303133;
}
.close-btn:hover {
  background: #e81123;
  color: #fff;
}

/* 主体 */
.sub-container {
  max-width: 480px;
  margin: 0 auto;
  padding: 40px 20px 20px;
  width: 100%;
}

/* 顶部标题 */
.sub-header {
  text-align: center;
  margin-bottom: 20px;
}
.sub-header h1 {
  font-size: 20px;
  color: #333;
  margin-bottom: 4px;
}
.sub-user {
  font-size: 13px;
  color: #999;
}
.sub-status-badge {
  display: inline-block;
  margin-top: 8px;
  padding: 4px 14px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: bold;
}
.sub-status-badge.expired {
  background: #fdecea;
  color: #e74c3c;
}
.sub-status-badge.trial {
  background: #fff3e0;
  color: #e67e22;
}
.sub-status-badge.active {
  background: #e8f5e9;
  color: #27ae60;
}
.days-remaining {
  font-weight: normal;
  font-size: 11px;
}

/* 版本选择 */
.tier-selector {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.tier-card {
  flex: 1;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  padding: 14px 8px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: #fff;
  position: relative;
}
.tier-card:hover {
  border-color: #f39c12;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.tier-card.selected {
  border-color: #e67e22;
  background: #fff8f0;
  box-shadow: 0 4px 12px rgba(230, 126, 34, 0.2);
}
.tier-card .tier-name {
  font-size: 15px;
  font-weight: bold;
  color: #333;
}
.tier-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: #e74c3c;
  color: #fff;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 8px;
  font-weight: bold;
}

/* 版本介绍 */
.tier-intro {
  background: #fff;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 16px;
}
.tier-intro-title {
  font-size: 13px;
  font-weight: bold;
  color: #333;
  margin-bottom: 10px;
}
.tier-intro-table {
  display: table;
  width: 100%;
  font-size: 12px;
}
.tier-intro-row {
  display: table-row;
}
.tier-intro-row > span {
  display: table-cell;
  padding: 5px 4px;
  text-align: center;
  border-bottom: 1px solid #f0f0f0;
  color: #666;
}
.tier-intro-row > span:first-child {
  text-align: left;
  color: #333;
}
.tier-intro-header > span {
  font-weight: bold;
  color: #333;
  border-bottom: 1px solid #ddd;
}
.tier-intro-row .yes { color: #27ae60; font-weight: bold; }
.tier-intro-row .no { color: #bbb; }

/* 周期选择 */
.period-selector {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}
.period-card {
  flex: 1;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  padding: 14px 6px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
  background: #fff;
  position: relative;
}
.period-card:hover {
  border-color: #f39c12;
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}
.period-card.selected {
  border-color: #e67e22;
  background: #fff8f0;
  box-shadow: 0 4px 12px rgba(230, 126, 34, 0.2);
}
.period-card .period-name {
  font-size: 14px;
  font-weight: bold;
  color: #333;
  margin-bottom: 6px;
}
.period-card .period-price {
  font-size: 22px;
  font-weight: bold;
  color: #e67e22;
}
.period-card .period-price .unit {
  font-size: 12px;
  font-weight: normal;
}
.period-card .period-save {
  font-size: 11px;
  color: #27ae60;
  margin-top: 4px;
}
.period-badge {
  position: absolute;
  top: -8px;
  right: -8px;
  background: #e74c3c;
  color: #fff;
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 8px;
  font-weight: bold;
}

/* 抵扣信息 */
.discount-info {
  background: #fff;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 16px;
  font-size: 13px;
}
.discount-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
  color: #666;
}
.discount-row.discount {
  color: #27ae60;
}
.discount-row.final {
  font-weight: bold;
  color: #333;
  border-top: 1px solid #eee;
  padding-top: 6px;
  margin-top: 6px;
  margin-bottom: 0;
}

/* 支付按钮 */
.pay-btn {
  width: 100%;
  height: 44px;
  background: #27ae60;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 16px;
  font-weight: bold;
  cursor: pointer;
  margin-bottom: 16px;
  transition: opacity 0.15s;
}
.pay-btn:hover {
  opacity: 0.9;
}
.pay-btn:disabled {
  background: #ccc;
  cursor: not-allowed;
}

/* 二维码区域 */
.qr-section {
  background: #fff;
  border-radius: 8px;
  padding: 20px;
  text-align: center;
  margin-bottom: 16px;
}
.qr-title {
  font-size: 14px;
  color: #333;
  margin-bottom: 12px;
}
.qr-box {
  display: inline-block;
  padding: 12px;
  background: #fff;
  border: 1px solid #eee;
  border-radius: 8px;
  margin-bottom: 12px;
}
.qr-loading {
  width: 220px;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c0c4cc;
}
.qr-amount {
  font-size: 20px;
  font-weight: bold;
  color: #e67e22;
  margin-bottom: 4px;
}
.qr-amount .unit {
  font-size: 13px;
  font-weight: normal;
}
.qr-hint {
  font-size: 12px;
  color: #999;
}
.qr-status {
  margin-top: 10px;
  font-size: 13px;
  color: #3498db;
}
.qr-status.success {
  color: #27ae60;
  font-weight: bold;
}
.qr-status.error {
  color: #e74c3c;
}
.qr-cancel {
  margin-top: 10px;
  background: none;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 6px 20px;
  font-size: 12px;
  color: #666;
  cursor: pointer;
}
.qr-cancel:hover {
  background: #f5f5f5;
}

/* 支付成功弹窗 */
.success-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
}
.success-box {
  background: #fff;
  border-radius: 12px;
  padding: 30px 40px;
  text-align: center;
  box-shadow: 0 8px 30px rgba(0,0,0,0.2);
}
.success-icon {
  font-size: 48px;
  margin-bottom: 12px;
  color: #27ae60;
}
.success-title {
  font-size: 18px;
  font-weight: bold;
  color: #27ae60;
  margin-bottom: 8px;
}
.success-desc {
  font-size: 13px;
  color: #666;
  margin-bottom: 16px;
}
.success-btn {
  background: #e67e22;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 10px 40px;
  font-size: 15px;
  font-weight: bold;
  cursor: pointer;
}
.success-btn:hover {
  opacity: 0.9;
}

/* 底部说明 */
.sub-footer {
  text-align: center;
  font-size: 11px;
  color: #bbb;
  padding: 10px 0 20px;
}
</style>
