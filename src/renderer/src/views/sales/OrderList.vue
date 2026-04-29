<template>
  <div class="page-container">
    <!-- 1. 筛选栏 + 右侧功能区 -->
    <div class="filter-panel">
      <div class="filter-main">
        <div class="filter-grid">
          <div class="filter-item">
            <label class="filter-label">店铺标签</label>
            <el-select v-model="searchForm.shopTag" multiple collapse-tags collapse-tags-tooltip placeholder="选择标签" clearable>
              <el-option v-for="t in shopTagOptions" :key="t" :label="t" :value="t" />
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">选择店铺</label>
            <el-select v-model="searchForm.shopName" filterable placeholder="选择店铺" clearable>
              <el-option v-for="s in shopOptions" :key="s" :label="s" :value="s" />
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">订单编号</label>
            <el-input v-model="searchForm.orderNo" placeholder="请输入订单编号" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">商品名称</label>
            <el-input v-model="searchForm.goodsName" placeholder="请输入商品名称" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">出库单号</label>
            <el-input v-model="searchForm.outboundNo" placeholder="请输入出库单号" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">客户名称</label>
            <el-input v-model="searchForm.customerName" placeholder="请输入客户名称" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">客户电话</label>
            <el-input v-model="searchForm.customerPhone" placeholder="请输入客户电话" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">订单状态</label>
            <el-select v-model="searchForm.orderStatus" placeholder="请选择" clearable>
              <el-option v-for="s in orderStatusOptions" :key="s" :label="s" :value="s" />
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">采购状态</label>
            <el-select v-model="searchForm.purchaseStatus" placeholder="请选择" clearable>
              <el-option v-for="s in purchaseStatusOptions" :key="s" :label="s" :value="s" />
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">问题事件</label>
            <el-select v-model="searchForm.issueEvent" placeholder="请选择" clearable>
              <el-option v-for="e in issueEventOptions" :key="e" :label="e" :value="e" />
            </el-select>
          </div>
        </div>
        <div class="filter-actions">
          <el-button type="primary" :icon="Search" @click="handleSearch">搜索</el-button>
          <el-button :icon="Refresh" @click="handleReset">重置</el-button>
        </div>
      </div>

      <!-- 右侧功能区（可折叠） -->
      <div class="func-panel" :class="{ collapsed: funcCollapsed }">
        <div class="func-toggle" @click="funcCollapsed = !funcCollapsed">
          <el-icon :size="14">
            <ArrowRight v-if="funcCollapsed" />
            <ArrowLeft v-else />
          </el-icon>
          <span>{{ funcCollapsed ? '展开' : '收起' }}</span>
        </div>
        <div v-show="!funcCollapsed" class="func-content">
          <!-- 出库设置 -->
          <div class="func-group">
            <div class="func-group-title">出库设置</div>
            <div class="func-item">
              <div class="func-item-header">
                <span class="func-item-label">自动出库</span>
                <el-switch v-model="funcSettings.autoOutbound" @change="onFuncChange('autoOutbound', $event)" />
              </div>
              <p class="func-item-desc">同步到物流的订单自动轨迹单出库</p>
            </div>
            <div class="func-item">
              <div class="func-item-header">
                <span class="func-item-label">大件物流</span>
                <el-switch v-model="funcSettings.largeLogistics" @change="onFuncChange('largeLogistics', $event)" />
              </div>
              <p class="func-item-desc">不支持的物流将自动使用大件出库</p>
            </div>
          </div>
          <!-- 同步订单 -->
          <div class="func-group">
            <div class="func-group-title">同步订单</div>
            <div class="func-item">
              <div class="func-item-header">
                <span class="func-item-label">京东订单</span>
                <el-switch v-model="funcSettings.syncJdOrder" @change="onFuncChange('syncJdOrder', $event)" />
              </div>
              <p class="func-item-desc">每10分钟，同步1次店铺订单信息及状态</p>
            </div>
            <div class="func-item">
              <div class="func-item-header">
                <span class="func-item-label">采购订单</span>
                <el-switch v-model="funcSettings.syncPurchaseOrder" @change="onFuncChange('syncPurchaseOrder', $event)" />
              </div>
              <p class="func-item-desc">每60分钟，同步1次采购订单状态及物流</p>
            </div>
          </div>
          <!-- 拍单账号 -->
          <div class="func-group">
            <div class="func-group-title">拍单账号</div>
            <div class="func-btn-group">
              <el-button type="danger" size="small" @click="onFuncBtnClick('accountManage')">账号管理</el-button>
              <el-button size="small" @click="onFuncBtnClick('importAccount')">导入账号</el-button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. 操作栏 -->
    <div class="action-bar">
      <div class="action-left">
        <el-button class="action-btn action-btn-orange" @click="handleQueryOrders">
          <el-icon><Search /></el-icon>
          <span>查询订单</span>
        </el-button>
        <el-button class="action-btn action-btn-blue" @click="handleSyncOrders">
          <el-icon><Refresh /></el-icon>
          <span>同步订单</span>
        </el-button>
      </div>
      <div class="action-right">
        <span class="action-stat">出库即将超时订单数：<em class="stat-num">{{ nearTimeoutCount }}</em></span>
        <span class="action-stat">超时未出库订单数：<em class="stat-num">{{ timeoutCount }}</em></span>
      </div>
    </div>

    <!-- 3. 状态统计栏 -->
    <div class="stats-bar">
      <span
        v-for="item in statusTabs"
        :key="item.value"
        class="stat-item"
        :class="{ active: activeStatus === item.value }"
        @click="handleStatusClick(item.value)"
      >
        {{ item.label }}<span class="stat-count">({{ item.count }})</span>
      </span>
    </div>

    <!-- 4. 数据表格 -->
    <div class="table-card">
      <el-table
        :data="pagedOrders"
        stripe
        @selection-change="handleSelectionChange"
        style="width: 100%"
      >
        <el-table-column type="selection" width="50" />
        <el-table-column type="index" label="序号" width="60" />
        <el-table-column prop="orderNo" label="订单编号" width="180">
          <template #default="{ row }">
            <span class="order-link" @click="handleView(row)">{{ row.orderNo }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="outboundNo" label="出库单号" width="160" />
        <el-table-column prop="shopName" label="店铺名称" min-width="120" />
        <el-table-column prop="customerName" label="客户名称" min-width="100" />
        <el-table-column prop="customerPhone" label="客户电话" width="130" />
        <el-table-column prop="goodsName" label="商品名称" min-width="150" />
        <el-table-column prop="amount" label="订单金额" width="110" align="right">
          <template #default="{ row }">
            <span class="amount-text">¥ {{ row.amount.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="orderStatus" label="订单状态" width="100">
          <template #default="{ row }">
            <el-tag :type="orderStatusTagType(row.orderStatus)" size="small">{{ row.orderStatus }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="purchaseStatus" label="采购状态" width="100">
          <template #default="{ row }">
            <el-tag :type="purchaseStatusTagType(row.purchaseStatus)" size="small" effect="plain">{{ row.purchaseStatus }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="issueEvent" label="问题事件" width="120">
          <template #default="{ row }">
            <el-tag v-if="row.issueEvent" type="warning" size="small" effect="plain">{{ row.issueEvent }}</el-tag>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column prop="orderTime" label="下单时间" width="170" />
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleView(row)">查看详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无订单数据" />
        </template>
      </el-table>

      <!-- 分页 -->
      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          background
          layout="total, sizes, prev, pager, next, jumper"
          @size-change="handleSizeChange"
          @current-change="handleCurrentChange"
        />
      </div>
    </div>

    <!-- 5. 订单详情抽屉 -->
    <el-drawer v-model="drawerVisible" title="订单详情" size="640px" direction="rtl">
      <template v-if="currentOrder">
        <!-- 订单头部 -->
        <div class="detail-header">
          <div class="detail-header-left">
            <span class="detail-order-no">{{ currentOrder.orderNo }}</span>
            <el-tag :type="orderStatusTagType(currentOrder.orderStatus)" size="small">{{ currentOrder.orderStatus }}</el-tag>
            <el-tag v-if="currentOrder.purchaseStatus" :type="purchaseStatusTagType(currentOrder.purchaseStatus)" size="small" effect="plain">{{ currentOrder.purchaseStatus }}</el-tag>
          </div>
          <span class="detail-order-time">{{ currentOrder.orderTime }}</span>
        </div>

        <!-- 基本信息 -->
        <div class="detail-section">
          <h4 class="detail-section-title">订单信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">出库单号</span><span class="detail-value">{{ currentOrder.outboundNo || '—' }}</span></div>
            <div class="detail-row"><span class="detail-label">店铺名称</span><span class="detail-value">{{ currentOrder.shopName }}</span></div>
            <div class="detail-row"><span class="detail-label">支付方式</span><span class="detail-value">{{ currentOrder.paymentMethod }}</span></div>
            <div class="detail-row"><span class="detail-label">客户名称</span><span class="detail-value">{{ currentOrder.customerName }}</span></div>
          </div>
        </div>

        <!-- 商品信息表格 -->
        <div class="detail-section">
          <h4 class="detail-section-title">商品信息</h4>
          <table class="detail-goods-table">
            <thead>
              <tr>
                <th>商品名称</th>
                <th>单价</th>
                <th>数量</th>
                <th>金额</th>
                <th>运费</th>
                <th>实付金额</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, idx) in currentOrder.items" :key="idx">
                <td class="goods-name-cell">{{ item.name }}</td>
                <td class="num-cell">¥{{ item.price.toFixed(2) }}</td>
                <td class="num-cell">{{ item.quantity }}</td>
                <td class="num-cell">¥{{ (item.price * item.quantity).toFixed(2) }}</td>
                <td class="num-cell">¥{{ idx === 0 ? currentOrder.shippingFee.toFixed(2) : '0.00' }}</td>
                <td class="num-cell highlight-num">¥{{ idx === 0 ? currentOrder.actualAmount.toFixed(2) : '0.00' }}</td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="3" class="tfoot-label">合计</td>
                <td class="num-cell">¥{{ currentOrder.amount.toFixed(2) }}</td>
                <td class="num-cell">¥{{ currentOrder.shippingFee.toFixed(2) }}</td>
                <td class="num-cell highlight-num">¥{{ currentOrder.actualAmount.toFixed(2) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- 物流信息 -->
        <div class="detail-section">
          <h4 class="detail-section-title">物流信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">物流公司</span><span class="detail-value">{{ currentOrder.logisticsCompany || '—' }}</span></div>
            <div class="detail-row"><span class="detail-label">物流单号</span><span class="detail-value">{{ currentOrder.logisticsNo || '—' }}</span></div>
          </div>
        </div>

        <!-- 收货信息 -->
        <div class="detail-section">
          <h4 class="detail-section-title">收货信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">收货人</span><span class="detail-value">{{ currentOrder.receiver }}</span></div>
            <div class="detail-row"><span class="detail-label">联系电话</span><span class="detail-value">{{ currentOrder.customerPhone }}</span></div>
          </div>
          <div class="detail-row" style="margin-top: 8px;"><span class="detail-label">收货地址</span><span class="detail-value">{{ currentOrder.address }}</span></div>
        </div>

        <!-- 问题事件 -->
        <div v-if="currentOrder.issueEvent" class="detail-section">
          <h4 class="detail-section-title">问题事件</h4>
          <el-tag type="warning">{{ currentOrder.issueEvent }}</el-tag>
        </div>

        <!-- 底部操作按钮 -->
        <div class="detail-footer">
          <el-button size="small" @click="onDetailAction('viewOriginal')">查看原单</el-button>
          <el-button size="small" @click="onDetailAction('contactBuyer')">联系买家</el-button>
          <el-button size="small" @click="onDetailAction('printInvoice')">打印发票</el-button>
          <el-button type="primary" size="small" @click="onDetailAction('confirmShip')">确认发货</el-button>
        </div>
      </template>
    </el-drawer>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'
import { Search, Refresh, ArrowLeft, ArrowRight } from '@element-plus/icons-vue'

// ==================== 筛选项配置 ====================

const shopTagOptions = ['京东', '天猫', '拼多多', '抖音']
const shopOptions = ['京东自营店', '天猫旗舰店', '拼多多专营店', '抖音小店']
const orderStatusOptions = ['待付款', '待发货', '已发货', '已完成', '已取消']
const purchaseStatusOptions = ['待采购', '采购中', '已采购', '采购失败']
const issueEventOptions = ['超时未发货', '库存不足', '物流异常', '客户拒收']

// ==================== 搜索表单 ====================

const searchForm = reactive({
  shopTag: [],
  shopName: '',
  orderNo: '',
  goodsName: '',
  outboundNo: '',
  customerName: '',
  customerPhone: '',
  orderStatus: '',
  purchaseStatus: '',
  issueEvent: ''
})

const activeStatus = ref('')
const currentPage = ref(1)
const pageSize = ref(20)
const selectedRows = ref([])

// ==================== 右侧功能区 ====================

const funcCollapsed = ref(false)
const funcSettings = reactive({
  autoOutbound: true,
  largeLogistics: true,
  syncJdOrder: true,
  syncPurchaseOrder: true
})

function onFuncChange(key, value) {
  // 预留：后续对接真实逻辑
  console.log(`[功能区开关] ${key}: ${value}`)
}

function onFuncBtnClick(action) {
  // 预留：后续对接真实逻辑
  console.log(`[功能区按钮] ${action}`)
}

// ==================== 操作栏 ====================

function handleQueryOrders() {
  // 预留：后续对接查询逻辑
  console.log('[操作栏] 查询订单')
}

function handleSyncOrders() {
  // 预留：后续对接同步逻辑
  console.log('[操作栏] 同步订单')
}

// ==================== Mock 数据 ====================

const mockOrders = ref(generateMockOrders())

function generateMockOrders() {
  const shops = [
    { name: '京东自营店', tag: '京东' },
    { name: '天猫旗舰店', tag: '天猫' },
    { name: '拼多多专营店', tag: '拼多多' },
    { name: '抖音小店', tag: '抖音' }
  ]
  const statuses = ['待付款', '待发货', '已发货', '已完成', '已取消']
  const purchaseStatuses = ['待采购', '采购中', '已采购', '采购失败']
  const payments = ['微信支付', '支付宝', '银行卡', '货到付款']
  const issues = [null, null, null, null, null, null, null, '超时未发货', '库存不足', '物流异常']
  const surnames = ['张', '李', '王', '刘', '陈', '杨', '赵', '黄', '周', '吴']
  const names = ['伟', '芳', '娜', '秀英', '敏', '静', '丽', '强', '磊', '洋']
  const cities = ['北京市朝阳区', '上海市浦东新区', '广州市天河区', '深圳市南山区', '杭州市西湖区', '成都市武侯区', '武汉市洪山区', '南京市鼓楼区']
  const goodsList = [
    ['无线蓝牙耳机', '手机保护壳'],
    ['智能手表', '充电器'],
    ['笔记本电脑支架'],
    ['机械键盘', '鼠标垫'],
    ['空气净化器'],
    ['运动跑鞋'],
    ['保温杯', '茶包礼盒'],
    ['投影仪', 'HDMI线'],
    ['收纳箱'],
    ['电动牙刷']
  ]

  const logisticsCompanies = ['中通快递', '顺丰速运', '韵达快递', '圆通速递', '京东物流', '申通快递']

  const orders = []
  for (let i = 1; i <= 28; i++) {
    const shop = shops[Math.floor(Math.random() * shops.length)]
    const status = statuses[Math.floor(Math.random() * statuses.length)]
    const pStatus = purchaseStatuses[Math.floor(Math.random() * purchaseStatuses.length)]
    const issue = issues[Math.floor(Math.random() * issues.length)]
    const surname = surnames[Math.floor(Math.random() * surnames.length)]
    const name = names[Math.floor(Math.random() * names.length)]
    const city = cities[Math.floor(Math.random() * cities.length)]
    const goods = goodsList[Math.floor(Math.random() * goodsList.length)]
    const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, '0')
    const hour = String(Math.floor(Math.random() * 24)).padStart(2, '0')
    const min = String(Math.floor(Math.random() * 60)).padStart(2, '0')
    const hasOutbound = ['已发货', '已完成'].includes(status) || (status === '待发货' && Math.random() > 0.5)
    const hasLogistics = ['已发货', '已完成'].includes(status)
    const shippingFee = parseFloat((Math.random() > 0.7 ? 0 : (Math.random() * 15 + 5)).toFixed(2))
    const items = goods.map((g, idx) => ({
      name: g,
      quantity: idx === 0 ? Math.floor(Math.random() * 3) + 1 : 1,
      price: parseFloat((Math.random() * 500 + 29.9).toFixed(2))
    }))
    const goodsTotal = items.reduce((sum, it) => sum + it.price * it.quantity, 0)
    const amount = parseFloat(goodsTotal.toFixed(2))
    const actualAmount = parseFloat((amount + shippingFee).toFixed(2))

    orders.push({
      id: i,
      orderNo: `DD202604${day}${String(i).padStart(4, '0')}`,
      outboundNo: hasOutbound ? `CK202604${day}${String(i).padStart(4, '0')}` : '',
      shopName: shop.name,
      shopTag: shop.tag,
      customerName: surname + name,
      customerPhone: `1${3 + Math.floor(Math.random() * 6)}${String(Math.floor(Math.random() * 100000000)).padStart(8, '0').slice(0, 4)}****${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
      goodsName: goods[0],
      amount,
      shippingFee,
      actualAmount,
      paymentMethod: payments[Math.floor(Math.random() * payments.length)],
      orderStatus: status,
      purchaseStatus: pStatus,
      issueEvent: issue,
      orderTime: `2026-04-${day} ${hour}:${min}:${String(Math.floor(Math.random() * 60)).padStart(2, '0')}`,
      receiver: surname + name,
      address: city + 'xx街道xx号',
      items,
      logisticsCompany: hasLogistics ? logisticsCompanies[Math.floor(Math.random() * logisticsCompanies.length)] : '',
      logisticsNo: hasLogistics ? `SF${Date.now()}${String(i).padStart(4, '0')}` : '',
      timeoutStatus: issue === '超时未发货' ? 'timeout' : (Math.random() > 0.85 ? 'nearTimeout' : 'normal')
    })
  }
  return orders
}

// ==================== 计算属性 ====================

const filteredOrders = computed(() => {
  return mockOrders.value.filter((order) => {
    if (searchForm.shopTag.length && !searchForm.shopTag.includes(order.shopTag)) return false
    if (searchForm.shopName && order.shopName !== searchForm.shopName) return false
    if (searchForm.orderNo && !order.orderNo.includes(searchForm.orderNo)) return false
    if (searchForm.goodsName && !order.goodsName.includes(searchForm.goodsName)) return false
    if (searchForm.outboundNo && !order.outboundNo.includes(searchForm.outboundNo)) return false
    if (searchForm.customerName && !order.customerName.includes(searchForm.customerName)) return false
    if (searchForm.customerPhone && !order.customerPhone.includes(searchForm.customerPhone)) return false
    if (searchForm.orderStatus && order.orderStatus !== searchForm.orderStatus) return false
    if (searchForm.purchaseStatus && order.purchaseStatus !== searchForm.purchaseStatus) return false
    if (searchForm.issueEvent && order.issueEvent !== searchForm.issueEvent) return false
    if (activeStatus.value && order.orderStatus !== activeStatus.value) return false
    return true
  })
})

const total = computed(() => filteredOrders.value.length)

const pagedOrders = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredOrders.value.slice(start, start + pageSize.value)
})

// 状态统计
const statusTabs = computed(() => {
  const all = mockOrders.value.length
  const counts = {}
  for (const o of mockOrders.value) {
    counts[o.orderStatus] = (counts[o.orderStatus] || 0) + 1
  }
  return [
    { label: '全部', value: '', count: all },
    ...orderStatusOptions.map((s) => ({ label: s, value: s, count: counts[s] || 0 }))
  ]
})

// 超时统计
const nearTimeoutCount = computed(() => mockOrders.value.filter((o) => o.timeoutStatus === 'nearTimeout').length)
const timeoutCount = computed(() => mockOrders.value.filter((o) => o.timeoutStatus === 'timeout').length)

// ==================== 详情抽屉 ====================

const drawerVisible = ref(false)
const currentOrder = ref(null)

function handleView(row) {
  currentOrder.value = row
  drawerVisible.value = true
}

// ==================== 交互方法 ====================

function handleSearch() {
  currentPage.value = 1
}

function handleReset() {
  Object.assign(searchForm, {
    shopTag: [],
    shopName: '',
    orderNo: '',
    goodsName: '',
    outboundNo: '',
    customerName: '',
    customerPhone: '',
    orderStatus: '',
    purchaseStatus: '',
    issueEvent: ''
  })
  activeStatus.value = ''
  currentPage.value = 1
}

function handleStatusClick(status) {
  activeStatus.value = status
  searchForm.orderStatus = status
  currentPage.value = 1
}

function handleSelectionChange(rows) {
  selectedRows.value = rows
}

function handleSizeChange() {
  currentPage.value = 1
}

function handleCurrentChange() {}

function onDetailAction(action) {
  // 预留：后续对接真实逻辑
  console.log(`[详情操作] ${action}`, currentOrder.value?.orderNo)
}

// ==================== Tag 类型映射 ====================

function orderStatusTagType(status) {
  const map = { '待付款': 'warning', '待发货': 'danger', '已发货': '', '已完成': 'success', '已取消': 'info' }
  return map[status] || ''
}

function purchaseStatusTagType(status) {
  const map = { '待采购': 'warning', '采购中': '', '已采购': 'success', '采购失败': 'danger' }
  return map[status] || ''
}
</script>

<style scoped>
.page-container {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ==================== 筛选栏 + 右侧功能区 ==================== */

.filter-panel {
  background: #fff;
  border-radius: 12px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  display: flex;
  overflow: hidden;
}

.filter-main {
  flex: 1;
  padding: 20px 24px 16px;
  min-width: 0;
}

.filter-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px 20px;
}

.filter-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.filter-label {
  font-size: 13px;
  color: #6b7280;
  font-weight: 500;
}

:deep(.filter-item .el-input),
:deep(.filter-item .el-select) {
  width: 100%;
}

.filter-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid #f5f5f5;
}

/* 右侧功能区 */
.func-panel {
  width: 280px;
  border-left: 1px solid #f0f0f0;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width 0.3s;
  position: relative;
}

.func-panel.collapsed {
  width: 36px;
}

.func-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 0;
  font-size: 12px;
  color: #909399;
  cursor: pointer;
  border-bottom: 1px solid #f0f0f0;
  transition: color 0.2s;
}

.func-toggle:hover {
  color: #1890ff;
}

.func-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}

.func-group {
  margin-bottom: 16px;
}

.func-group:last-child {
  margin-bottom: 0;
}

.func-group-title {
  font-size: 13px;
  font-weight: 600;
  color: #1f2937;
  margin-bottom: 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid #f5f5f5;
}

.func-item {
  margin-bottom: 10px;
}

.func-item:last-child {
  margin-bottom: 0;
}

.func-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.func-item-label {
  font-size: 13px;
  color: #303133;
}

.func-item-desc {
  font-size: 11px;
  color: #9ca3af;
  margin: 4px 0 0;
  line-height: 1.4;
}

.func-btn-group {
  display: flex;
  gap: 8px;
}

/* ==================== 操作栏 ==================== */

.action-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

.action-left {
  display: flex;
  gap: 12px;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 8px 20px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s;
}

.action-btn:hover {
  opacity: 0.9;
}

.action-btn-orange {
  background: #e67e22;
}

.action-btn-blue {
  background: #2196F3;
}

.action-right {
  display: flex;
  gap: 24px;
}

.action-stat {
  font-size: 13px;
  color: #606266;
}

.stat-num {
  font-style: normal;
  color: #f5222d;
  font-weight: 700;
  font-size: 16px;
}

/* ==================== 状态统计栏 ==================== */

.stats-bar {
  display: flex;
  gap: 4px;
  padding: 0 4px;
}

.stat-item {
  padding: 8px 16px;
  font-size: 14px;
  color: #6b7280;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  white-space: nowrap;
}

.stat-item:hover {
  color: #1890ff;
}

.stat-item.active {
  color: #1890ff;
  font-weight: 500;
  border-bottom-color: #1890ff;
}

.stat-count {
  font-size: 12px;
  margin-left: 2px;
}

/* ==================== 数据表格 ==================== */

.table-card {
  background: #fff;
  border-radius: 12px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  padding: 16px;
}

.order-link {
  color: #1890ff;
  cursor: pointer;
  text-decoration: none;
}

.order-link:hover {
  text-decoration: underline;
}

.amount-text {
  font-weight: 600;
  font-family: 'Inter', monospace;
  color: #1f2937;
}

.text-muted {
  color: #d9d9d9;
}

:deep(.el-table th) {
  background: #fafafa !important;
  font-weight: 600;
  color: #303133;
}

:deep(.el-table) {
  font-size: 13px;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* ==================== 订单详情抽屉 ==================== */

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 16px;
  margin-bottom: 20px;
  border-bottom: 1px solid #f0f0f0;
}

.detail-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-order-no {
  font-size: 16px;
  font-weight: 700;
  color: #1f2937;
}

.detail-order-time {
  font-size: 13px;
  color: #9ca3af;
}

.detail-section {
  margin-bottom: 20px;
}

.detail-section:last-of-type {
  margin-bottom: 0;
}

.detail-section-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  margin: 0 0 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f0f0f0;
}

.detail-grid-2col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 24px;
}

.detail-row {
  display: flex;
  align-items: baseline;
}

.detail-label {
  width: 72px;
  flex-shrink: 0;
  font-size: 13px;
  color: #9ca3af;
}

.detail-value {
  font-size: 13px;
  color: #1f2937;
  word-break: break-all;
}

/* 商品信息表格 */
.detail-goods-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.detail-goods-table th {
  background: #fafafa;
  font-weight: 600;
  color: #303133;
  text-align: center;
  padding: 8px 10px;
  border: 1px solid #ebeef5;
}

.detail-goods-table td {
  padding: 8px 10px;
  border: 1px solid #ebeef5;
  color: #303133;
}

.goods-name-cell {
  text-align: left;
}

.num-cell {
  text-align: center;
  font-family: 'Inter', monospace;
}

.highlight-num {
  font-weight: 600;
  color: #f5222d;
}

.detail-goods-table tfoot td {
  background: #fafafa;
  font-weight: 600;
}

.tfoot-label {
  text-align: right;
  padding-right: 16px;
}

/* 底部操作按钮 */
.detail-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 20px;
  margin-top: 20px;
  border-top: 1px solid #f0f0f0;
}
</style>
