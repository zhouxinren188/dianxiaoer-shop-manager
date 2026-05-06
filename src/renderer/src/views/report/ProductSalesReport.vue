<template>
  <div class="product-sales-report-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><Goods /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">商品销售报表</h2>
          <p class="header-desc">按商品维度统计销售数据，支持绑定仓库商品（已剔除待付款和已取消订单）</p>
        </div>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-row">
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #1890ff">{{ summary.totalSkus }}</div>
        <div class="stat-label">总SKU数</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #67c23a">{{ summary.totalSalesCount }}</div>
        <div class="stat-label">总销售次数</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #e6a23c">{{ summary.totalSalesQuantity }}</div>
        <div class="stat-label">总销售数量</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #f56c6c">¥{{ summary.totalAmount.toFixed(2) }}</div>
        <div class="stat-label">总销售金额</div>
      </el-card>
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="店铺">
          <el-select v-model="filterForm.storeId" placeholder="全部店铺" clearable style="width: 200px">
            <el-option
              v-for="store in storeOptions"
              :key="store.id"
              :label="store.name"
              :value="store.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="绑定状态">
          <el-select v-model="filterForm.bindStatus" placeholder="全部" style="width: 120px">
            <el-option label="未绑定" value="unbind" />
            <el-option label="已绑定" value="bound" />
            <el-option label="全部" value="" />
          </el-select>
        </el-form-item>
        <el-form-item label="统计周期">
          <el-select v-model="filterForm.period" placeholder="选择周期" style="width: 140px" @change="handlePeriodChange">
            <el-option label="今日" value="today" />
            <el-option label="近7天" value="week" />
            <el-option label="近30天" value="month" />
            <el-option label="本季度" value="quarter" />
            <el-option label="自定义" value="custom" />
          </el-select>
          <el-date-picker
            v-if="filterForm.period === 'custom'"
            v-model="filterForm.dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 260px; margin-left: 8px"
            value-format="YYYY-MM-DD"
            :clearable="false"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">
            <el-icon><Search /></el-icon>
            查询
          </el-button>
          <el-button @click="handleReset">
            <el-icon><Refresh /></el-icon>
            重置
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 数据表格 -->
    <el-card class="table-card" shadow="never">
      <template #header>
        <div class="table-header">
          <span>商品报表</span>
          <el-radio-group v-model="sortBy" size="small">
            <el-radio-button label="quantity">按销售数量</el-radio-button>
            <el-radio-button label="count">按销售次数</el-radio-button>
            <el-radio-button label="amount">按销售金额</el-radio-button>
          </el-radio-group>
        </div>
      </template>

      <el-table
        :data="pagedTableData"
        stripe
        border
        v-loading="loading"
        :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }"
        style="width: 100%"
      >
        <el-table-column type="index" label="排名" width="60" align="center" fixed="left" />
        <el-table-column prop="storeName" label="店铺名称" min-width="140" fixed="left" />
        <el-table-column prop="skuId" label="商品SKU" width="140" align="center">
          <template #default="{ row }">
            <span style="font-family: monospace; font-size: 13px">{{ row.skuId }}</span>
          </template>
        </el-table-column>
        <el-table-column label="商品主图" width="80" align="center">
          <template #default="{ row }">
            <el-image
              v-if="row.productImage"
              :src="row.productImage"
              :preview-src-list="[row.productImage]"
              fit="cover"
              style="width: 50px; height: 50px; border-radius: 4px"
              preview-teleported
            />
            <span v-else style="color: #c0c4cc">-</span>
          </template>
        </el-table-column>
        <el-table-column prop="productName" label="商品名称" min-width="200" show-overflow-tooltip />
        <el-table-column label="单价" width="100" align="right">
          <template #default="{ row }">
            <span style="color: #f56c6c">¥{{ row.avgUnitPrice.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="salesCount" label="销售次数" width="100" align="center" />
        <el-table-column label="销售数量" width="100" align="center">
          <template #default="{ row }">
            <span style="color: #67c23a; font-weight: 600">{{ row.salesQuantity }}</span>
          </template>
        </el-table-column>
        <el-table-column label="绑定状态" width="140" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.boundInventoryId" type="success" size="small">已绑定 {{ row.boundWarehouseName }}</el-tag>
            <el-tag v-else type="warning" size="small">未绑定</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" align="center" fixed="right">
          <template #default="{ row }">
            <el-tooltip content="商品链接功能开发中" placement="top">
              <el-button type="primary" link size="small" disabled>查看商品</el-button>
            </el-tooltip>
            <el-button type="success" link size="small" @click="handleBind(row)">
              {{ row.boundInventoryId ? '重新绑定' : '绑定仓库商品' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrapper">
        <el-pagination
          v-model:current-page="pagination.page"
          v-model:page-size="pagination.pageSize"
          :total="pagination.total"
          :page-sizes="[10, 20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @size-change="loadData"
          @current-change="loadData"
        />
      </div>
    </el-card>

    <!-- 绑定弹窗 -->
    <el-dialog
      v-model="bindDialogVisible"
      title="绑定仓库商品"
      width="700px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <!-- 当前SKU信息 -->
      <div class="bind-sku-info" v-if="currentBindRow">
        <el-image
          v-if="currentBindRow.productImage"
          :src="currentBindRow.productImage"
          fit="cover"
          style="width: 60px; height: 60px; border-radius: 6px; flex-shrink: 0"
        />
        <div class="bind-sku-detail">
          <div><strong>SKU:</strong> <span style="font-family: monospace">{{ currentBindRow.skuId }}</span></div>
          <div><strong>名称:</strong> {{ currentBindRow.productName }}</div>
          <div><strong>单价:</strong> <span style="color: #f56c6c">¥{{ currentBindRow.avgUnitPrice?.toFixed(2) }}</span></div>
        </div>
      </div>

      <el-divider>搜索已有库存</el-divider>

      <!-- 搜索库存 -->
      <div class="bind-search-section">
        <div v-if="bindKeywords.length > 0" class="bind-keywords-row">
          <span class="bind-keywords-label">关键词：</span>
          <el-tag
            v-for="kw in bindKeywords"
            :key="kw"
            size="small"
            type="info"
            effect="plain"
            class="bind-keyword-tag"
            @click="applyKeyword(kw)"
          >{{ kw }}</el-tag>
        </div>
        <el-input
          v-model="bindSearchKeyword"
          placeholder="输入SKU或商品名称搜索"
          clearable
          @keyup.enter="searchInventoryForBind"
          style="width: 300px"
        >
          <template #append>
            <el-button @click="searchInventoryForBind" :loading="bindSearchLoading">
              <el-icon><Search /></el-icon>
            </el-button>
          </template>
        </el-input>

        <el-table
          v-if="bindSearchResults.length > 0"
          :data="bindSearchResults"
          stripe
          size="small"
          highlight-current-row
          @current-change="handleSelectInventory"
          style="margin-top: 12px; max-height: 200px; overflow-y: auto"
        >
          <el-table-column prop="sku" label="SKU" width="120" />
          <el-table-column prop="productName" label="商品名称" min-width="150" show-overflow-tooltip />
          <el-table-column prop="warehouseName" label="仓库" width="120" />
          <el-table-column prop="quantity" label="库存" width="80" align="center" />
          <el-table-column label="操作" width="80" align="center">
            <template #default="{ row }">
              <el-button type="primary" link size="small" @click="confirmBindExisting(row)">选择</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-divider>或新建仓库商品</el-divider>

      <!-- 新建库存 -->
      <div class="bind-create-section">
        <el-form :model="bindNewForm" label-width="80px" size="default">
          <el-form-item label="仓库">
            <el-select v-model="bindNewForm.warehouseId" placeholder="选择仓库" style="width: 100%">
              <el-option
                v-for="wh in warehouseOptions"
                :key="wh.id"
                :label="wh.name"
                :value="wh.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="SKU">
            <el-input :model-value="currentBindRow?.skuId" disabled />
          </el-form-item>
          <el-form-item label="商品名称">
            <el-input :model-value="currentBindRow?.productName" disabled />
          </el-form-item>
          <el-form-item label="货位号">
            <el-input v-model="bindNewForm.location" placeholder="可选" />
          </el-form-item>
          <el-form-item label="批次号">
            <el-input v-model="bindNewForm.batchNo" placeholder="可选" />
          </el-form-item>
          <el-form-item label="供应商">
            <el-input v-model="bindNewForm.supplier" placeholder="可选" />
          </el-form-item>
        </el-form>
        <el-button type="primary" @click="confirmCreateAndBind" :loading="bindCreateLoading" style="margin-top: 4px">
          新建并绑定
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Goods,
  Search,
  Refresh
} from '@element-plus/icons-vue'
import { fetchProductSalesStats } from '@/api/salesOrder'
import { fetchStores } from '@/api/store'
import { searchInventory, createSkuBinding, quickCreateInventory } from '@/api/warehouse'
import { fetchWarehouses } from '@/api/warehouse'

const loading = ref(false)
const storeOptions = ref([])
const warehouseOptions = ref([])

const summary = reactive({
  totalSkus: 0,
  totalSalesCount: 0,
  totalSalesQuantity: 0,
  totalAmount: 0
})

const today = new Date().toISOString().slice(0, 10)
const filterForm = reactive({
  storeId: '',
  period: 'week',
  dateRange: [today, today],
  bindStatus: 'unbind'
})

const sortBy = ref('count')

const tableData = ref([])
const pagination = reactive({ page: 1, pageSize: 20, total: 0 })

const sortedTableData = computed(() => {
  const data = [...tableData.value]
  if (sortBy.value === 'quantity') {
    data.sort((a, b) => b.salesQuantity - a.salesQuantity)
  } else if (sortBy.value === 'count') {
    data.sort((a, b) => b.salesCount - a.salesCount)
  } else if (sortBy.value === 'amount') {
    data.sort((a, b) => b.totalAmount - a.totalAmount)
  }
  return data
})

const pagedTableData = computed(() => {
  const start = (pagination.page - 1) * pagination.pageSize
  return sortedTableData.value.slice(start, start + pagination.pageSize)
})

async function loadData() {
  loading.value = true
  try {
    const params = {}
    if (filterForm.storeId) params.store_id = filterForm.storeId
    if (filterForm.period === 'custom' && filterForm.dateRange) {
      params.start_date = filterForm.dateRange[0]
      params.end_date = filterForm.dateRange[1]
    } else if (filterForm.period) {
      params.period = filterForm.period
    }
    params.page = pagination.page
    params.pageSize = pagination.pageSize
    if (filterForm.bindStatus) params.bind_status = filterForm.bindStatus

    const res = await fetchProductSalesStats(params)
    if (res) {
      const { summary: s, list, total } = res
      summary.totalSkus = s?.totalSkus || 0
      summary.totalSalesCount = s?.totalSalesCount || 0
      summary.totalSalesQuantity = s?.totalSalesQuantity || 0
      summary.totalAmount = s?.totalAmount || 0
      tableData.value = list || []
      pagination.total = total || 0
    }
  } catch (err) {
    console.error('[商品报表] 加载失败:', err.message)
    ElMessage.error('加载数据失败：' + (err.message || '未知错误'))
  } finally {
    loading.value = false
  }
}

async function loadStoreOptions() {
  try {
    const res = await fetchStores({ pageSize: 1000 })
    if (res) {
      storeOptions.value = res.list || []
    }
  } catch (err) {
    console.error('[商品报表] 加载店铺列表失败:', err.message)
  }
}

async function loadWarehouseOptions() {
  try {
    const res = await fetchWarehouses()
    warehouseOptions.value = res?.list || res || []
  } catch (err) {
    console.error('[商品报表] 加载仓库列表失败:', err.message)
  }
}

function handlePeriodChange(val) {
  if (val === 'custom' && !filterForm.dateRange) {
    filterForm.dateRange = [today, today]
  }
}

function handleSearch() {
  pagination.page = 1
  loadData()
}

function handleReset() {
  filterForm.storeId = ''
  filterForm.period = 'week'
  filterForm.dateRange = [today, today]
  filterForm.bindStatus = 'unbind'
  pagination.page = 1
  loadData()
}

// ============ 绑定功能 ============

const bindDialogVisible = ref(false)
const currentBindRow = ref(null)
const bindSearchKeyword = ref('')
const bindSearchResults = ref([])
const bindSearchLoading = ref(false)
const bindCreateLoading = ref(false)
const bindKeywords = ref([])
const bindNewForm = reactive({
  warehouseId: '',
  location: '',
  batchNo: '',
  supplier: ''
})

/**
 * 从商品名称中智能提取3~5个关键词
 * 策略：关键词词典匹配 + 规格提取 + 短词段拆分
 */
function extractKeywords(name) {
  if (!name) return []

  // 常见商品品名词（按长度降序排列，优先匹配长词）
  const categoryWords = [
    // 清洁类
    '去油污', '重油污', '油污净', '油烟机', '抽油烟机', '清洁剂', '洗洁精', '洗衣液', '洗衣粉',
    '洗衣凝珠', '洗洁液', '去污渍', '除菌液', '除螨', '除甲醛', '消毒液', '消毒剂',
    '玻璃水', '洁厕灵', '洁厕剂', '管道疏通', '疏通剂', '除味剂', '空气清新',
    // 厨卫类
    '洗碗机', '净水器', '滤水壶', '垃圾袋', '保鲜膜', '保鲜盒', '密封罐', '收纳盒',
    // 个护类
    '洗发水', '护发素', '沐浴露', '洗面奶', '面霜', '精华液', '防晒霜', '身体乳',
    '牙膏', '牙刷', '漱口水', '纸巾', '湿巾', '卫生纸', '卫生巾', '纸尿裤',
    // 食品类
    '大米', '食用油', '酱油', '醋', '料酒', '调味料', '方便面', '坚果', '牛奶', '酸奶',
    // 数码类
    '充电宝', '充电器', '数据线', '耳机', '蓝牙耳机', '手机壳', '屏幕保护', '钢化膜',
    '鼠标', '键盘', '显示器', '路由器', '摄像头', '音箱', 'U盘', '存储卡',
    // 家居类
    '垃圾桶', '拖把', '扫把', '抹布', '海绵', '水杯', '保温杯', '水壶', '电水壶',
    '雨伞', '挂钩', '置物架', '晾衣架', '熨斗', '电风扇', '加湿器', '取暖器',
    // 服饰类
    'T恤', '衬衫', '外套', '卫衣', '牛仔裤', '运动鞋', '拖鞋', '袜子',
    // 通用修饰词
    '泡沫', '喷雾', '免洗', '便携', '大容量', '高浓度', '浓缩', '进口', '有机',
    '植物', '天然', '免搓洗', '一擦净', '一喷净', '免拆洗', '免刷洗'
  ].sort((a, b) => b.length - a.length) // 长词优先匹配

  const results = []

  // 1. 提取数字+单位规格（如 500ml、2L、100g）
  const specRegex = /\d+(\.\d+)?\s*(ml|ML|Ml|L|l|g|G|kg|KG|Kg|oz|cm|mm|m|个|只|瓶|包|盒|罐|袋|支|件|套|箱|张|片|卷|双|条|块|粒|颗|贴)/g
  let specMatch
  while ((specMatch = specRegex.exec(name)) !== null) {
    results.push(specMatch[0].replace(/\s+/g, ''))
  }

  // 2. 词典匹配品名词
  const matched = new Set()
  for (const word of categoryWords) {
    if (name.includes(word) && !matched.has(word)) {
      matched.add(word)
      results.push(word)
    }
  }

  // 3. 对未匹配的长中文段，按2~4字滑动窗口补充
  if (results.length < 3) {
    // 按空格/标点拆出片段
    const segments = name.split(/[\s·•\-—,，、|\/\\()（）\[\]【】0-9a-zA-Z]+/).filter(s => s.length >= 4)
    for (const seg of segments) {
      if (results.length >= 5) break
      // 从2字开始尝试，取中间位置的关键段
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i <= seg.length - len; i++) {
          const sub = seg.substring(i, i + len)
          // 跳过已匹配的
          if (matched.has(sub)) continue
          // 跳过纯停用词组合
          if (/^(居家|厨房|家用|商用|强力|强力|高效|超值|新款|同款|专供|正品|包邮|神器|万能)$/.test(sub)) continue
          // 只添加不重复的
          if (!results.includes(sub)) {
            results.push(sub)
            matched.add(sub)
            if (results.length >= 5) break
          }
        }
        if (results.length >= 5) break
      }
    }
  }

  // 去重，最多5个
  return [...new Set(results)].slice(0, 5)
}

function handleBind(row) {
  currentBindRow.value = row
  bindSearchKeyword.value = row.skuId
  bindSearchResults.value = []
  bindKeywords.value = extractKeywords(row.productName)
  bindNewForm.warehouseId = ''
  bindNewForm.location = ''
  bindNewForm.batchNo = ''
  bindNewForm.supplier = ''
  bindDialogVisible.value = true
  // 自动搜索
  searchInventoryForBind()
}

function applyKeyword(kw) {
  bindSearchKeyword.value = kw
  searchInventoryForBind()
}

async function searchInventoryForBind() {
  if (!bindSearchKeyword.value.trim()) return
  bindSearchLoading.value = true
  try {
    const res = await searchInventory({ keyword: bindSearchKeyword.value.trim() })
    bindSearchResults.value = res || []
  } catch (err) {
    console.error('[绑定] 搜索库存失败:', err.message)
  } finally {
    bindSearchLoading.value = false
  }
}

function handleSelectInventory(row) {
  // 选中行高亮，点击"选择"按钮时触发 confirmBindExisting
}

async function confirmBindExisting(invRow) {
  if (!currentBindRow.value) return
  try {
    await createSkuBinding({
      store_id: currentBindRow.value.storeId,
      sku_id: currentBindRow.value.skuId,
      inventory_id: invRow.id,
      warehouse_id: invRow.warehouseId
    })
    ElMessage.success('绑定成功')
    bindDialogVisible.value = false
    loadData()
  } catch (err) {
    ElMessage.error('绑定失败：' + (err.message || '未知错误'))
  }
}

async function confirmCreateAndBind() {
  if (!currentBindRow.value) return
  if (!bindNewForm.warehouseId) {
    ElMessage.warning('请选择仓库')
    return
  }
  bindCreateLoading.value = true
  try {
    await quickCreateInventory({
      warehouse_id: bindNewForm.warehouseId,
      sku: currentBindRow.value.skuId,
      product_name: currentBindRow.value.productName,
      image: currentBindRow.value.productImage,
      store_id: currentBindRow.value.storeId,
      location: bindNewForm.location,
      batch_no: bindNewForm.batchNo,
      supplier: bindNewForm.supplier
    })
    ElMessage.success('新建并绑定成功')
    bindDialogVisible.value = false
    loadData()
  } catch (err) {
    ElMessage.error('新建失败：' + (err.message || '未知错误'))
  } finally {
    bindCreateLoading.value = false
  }
}

onMounted(() => {
  loadStoreOptions()
  loadWarehouseOptions()
  loadData()
})
</script>

<style scoped>
.product-sales-report-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.page-header-card {
  background: #fff;
  border-radius: 12px;
  padding: 20px 24px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-icon {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, #36cfc9, #13c2c2);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
  margin: 0;
}

.header-desc {
  font-size: 13px;
  color: #9ca3af;
  margin: 4px 0 0;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}

.stat-card {
  border-radius: 10px !important;
  text-align: center;
}

.stat-card :deep(.el-card__body) {
  padding: 16px;
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.3;
}

.stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}

.filter-card {
  border-radius: 10px !important;
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.table-card {
  border-radius: 10px !important;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.pagination-wrapper {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* 绑定弹窗样式 */
.bind-sku-info {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px;
  background: #f5f7fa;
  border-radius: 8px;
}

.bind-sku-detail {
  flex: 1;
  font-size: 14px;
  line-height: 1.8;
}

.bind-keywords-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.bind-keywords-label {
  font-size: 13px;
  color: #909399;
  flex-shrink: 0;
}

.bind-keyword-tag {
  cursor: pointer;
  transition: all 0.15s;
}

.bind-keyword-tag:hover {
  color: #409eff;
  border-color: #409eff;
  background: #ecf5ff;
}

.bind-search-section {
  padding: 0 4px;
}

.bind-create-section {
  padding: 0 4px;
}
</style>
