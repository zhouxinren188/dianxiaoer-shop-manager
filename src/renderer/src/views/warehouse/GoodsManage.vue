<template>
  <div class="goods-manage-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><Goods /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">仓库商品管理</h2>
          <p class="header-desc">管理所有仓库的商品库存、售价、货位及销售情况</p>
        </div>
      </div>
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="选择仓库">
          <el-select v-model="filterForm.warehouse_id" placeholder="全部仓库" clearable style="width: 160px">
            <el-option v-for="wh in warehouseOptions" :key="wh.id" :label="wh.name" :value="wh.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="商品名称">
          <el-input v-model="filterForm.product_name" placeholder="请输入商品名称" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item label="货位号">
          <el-input v-model="filterForm.location" placeholder="请输入货位号" clearable style="width: 140px" />
        </el-form-item>
        <el-form-item label="已触发预警">
          <el-switch v-model="filterForm.warning_only" active-text="是" inactive-text="全部" />
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
          <span>商品列表</span>
          <el-button type="primary" @click="handleAdd">
            <el-icon><Plus /></el-icon>
            新增商品
          </el-button>
        </div>
      </template>

      <el-table
        ref="tableRef"
        :data="tableData"
        stripe
        border
        v-loading="loading"
        :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }"
        row-key="id"
        @expand-change="handleExpandChange"
        @row-click="handleRowClick"
      >
        <!-- 展开行：绑定商品 -->
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="expand-panel">
              <div class="expand-panel-header">
                <div class="expand-panel-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 01-8 0"/></svg>
                  <span>已绑定销售商品</span>
                </div>
                <span class="expand-panel-count">{{ (boundProductsMap[row.id] && boundProductsMap[row.id].length) || 0 }} 个</span>
              </div>
              <div v-if="expandLoadingMap[row.id]" class="expand-loading">
                <el-icon class="is-loading" :size="20" color="#409EFF"><Loading /></el-icon>
                <span>加载中...</span>
              </div>
              <div v-else-if="!(boundProductsMap[row.id] && boundProductsMap[row.id].length)" class="expand-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d0d3d8" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                <p>暂无绑定的销售商品</p>
              </div>
              <div v-else class="expand-product-list">
                <div v-for="bp in boundProductsMap[row.id]" :key="bp.store_id + '-' + bp.sku_id" class="product-card">
                  <div class="product-card-img">
                    <el-image v-if="bp.product_image" :src="bp.product_image" fit="cover"
                      :preview-src-list="[bp.product_image]" :preview-teleported="true" />
                    <div v-else class="product-card-img-placeholder">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#c0c4cc" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                    </div>
                  </div>
                  <div class="product-card-info">
                    <div class="product-card-name">{{ bp.product_name || '--' }}</div>
                    <div class="product-card-meta">
                      <span class="meta-store">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
                        {{ bp.store_name || '--' }}
                      </span>
                      <span class="meta-sku">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M7 7h10M7 12h10M7 17h6"/></svg>
                        {{ bp.sku_id || '--' }}
                      </span>
                    </div>
                  </div>
                  <div class="product-card-stats">
                    <div class="stat-item">
                      <span class="stat-label">售价</span>
                      <span class="stat-value price">¥{{ Number(bp.avg_unit_price || 0).toFixed(2) }}</span>
                    </div>
                    <div class="stat-item">
                      <span class="stat-label">销售数量</span>
                      <span class="stat-value">{{ Number(bp.total_quantity || 0) }}</span>
                    </div>
                    <div class="stat-item">
                      <span class="stat-label">未采购</span>
                      <span class="stat-value" :class="Number(bp.unpurchased_qty) > 0 ? 'warning' : 'success'">
                        {{ Number(bp.unpurchased_qty || 0) }}
                      </span>
                    </div>
                  </div>
                  <div class="product-card-action">
                    <el-button link type="danger" size="small" @click.stop="handleUnbind(bp, row)">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      解绑
                    </el-button>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="id" label="商品ID" width="80" align="center" />

        <el-table-column label="主图" width="80" align="center">
          <template #default="{ row }">
            <el-image
              v-if="row.image"
              :src="row.image"
              :preview-src-list="[row.image]"
              fit="cover"
              style="width: 50px; height: 50px; border-radius: 4px"
              :preview-teleported="true"
            />
            <span v-else style="color: #c0c4cc">暂无</span>
          </template>
        </el-table-column>

        <el-table-column prop="product_name" label="商品名称" min-width="180" show-overflow-tooltip />

        <el-table-column prop="price" label="售价" width="100" align="right">
          <template #default="{ row }">
            <span style="color: #f56c6c; font-weight: 600">¥{{ Number(row.price || 0).toFixed(2) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="库存预警" width="110" align="center">
          <template #default="{ row }">
            <el-tag
              :type="isWarning(row) ? 'danger' : 'success'"
              size="small"
              effect="light"
            >
              {{ isWarning(row) ? '已预警' : '正常' }}
            </el-tag>
            <div class="warning-threshold">预警值: {{ Number(row.warn_quantity || 0) }}</div>
          </template>
        </el-table-column>

        <el-table-column prop="quantity" label="当前库存" width="100" align="center">
          <template #default="{ row }">
            <span :class="{ 'warning-text': isWarning(row) }">{{ row.quantity }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="unpurchased_qty" label="未采购数" width="100" align="center">
          <template #default="{ row }">
            <span :style="{ color: Number(row.unpurchased_qty) > 0 ? '#e6a23c' : '#909399', fontWeight: Number(row.unpurchased_qty) > 0 ? 600 : 400 }">
              {{ Number(row.unpurchased_qty || 0) }}
            </span>
          </template>
        </el-table-column>

        <el-table-column prop="in_transit_qty" label="运输中" width="90" align="center">
          <template #default="{ row }">
            <span style="color: #409eff">{{ Number(row.in_transit_qty || 0) }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="week_sales" label="近7日销售" width="110" align="center">
          <template #default="{ row }">
            <span style="color: #67c23a; font-weight: 500">{{ Number(row.week_sales || 0) }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="warehouse_name" label="所属仓库" width="120" align="center" />

        <el-table-column prop="location" label="货位号" width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.location" type="info" size="small">{{ row.location }}</el-tag>
            <span v-else style="color: #c0c4cc">--</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="260" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click.stop="handleBindProduct(row)">
              <el-icon><Link /></el-icon>
              绑定商品
            </el-button>
            <el-button link type="success" size="small" @click.stop="handlePurchase(row)">
              <el-icon><ShoppingCart /></el-icon>
              采购进货
            </el-button>
            <el-button link type="primary" size="small" @click.stop="handleEdit(row)">
              <el-icon><Edit /></el-icon>
              编辑
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="pageInfo.page"
          v-model:page-size="pageInfo.pageSize"
          :total="pageInfo.total"
          layout="total, sizes, prev, pager, next, jumper"
          :page-sizes="[10, 20, 50]"
          @size-change="handleSizeChange"
          @current-change="handlePageChange"
        />
      </div>
    </el-card>

    <!-- 编辑/新增商品弹窗 -->
    <el-dialog
      v-model="editVisible"
      :title="editTitle"
      width="580px"
      align-center
      destroy-on-close
      :close-on-click-modal="false"
    >
      <el-form
        ref="editFormRef"
        :model="editForm"
        :rules="editRules"
        label-width="100px"
      >
        <el-form-item label="商品SKU" prop="sku">
          <el-input v-model="editForm.sku" placeholder="请输入SKU编号" :disabled="isEditMode" />
        </el-form-item>
        <el-form-item label="商品名称" prop="product_name">
          <el-input v-model="editForm.product_name" placeholder="请输入商品名称" maxlength="100" show-word-limit />
        </el-form-item>
        <el-form-item label="商品售价" prop="price">
          <el-input-number v-model="editForm.price" :min="0" :precision="2" :step="1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="所属仓库" prop="warehouse_id">
          <el-select v-model="editForm.warehouse_id" placeholder="请选择仓库" style="width: 200px" :disabled="isEditMode">
            <el-option v-for="wh in warehouseOptions" :key="wh.id" :label="wh.name" :value="wh.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="货位号" prop="location">
          <el-input v-model="editForm.location" placeholder="如：A-01-03" style="width: 200px" />
        </el-form-item>
        <el-form-item label="库存预警值" prop="warn_quantity">
          <el-input-number v-model="editForm.warn_quantity" :min="0" :step="1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="当前库存" prop="quantity">
          <el-input-number v-model="editForm.quantity" :min="0" :step="1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="主图链接">
          <el-input v-model="editForm.image" placeholder="请输入图片URL" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="editSubmitting" @click="handleEditSubmit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 绑定商品弹窗 -->
    <el-dialog
      v-model="bindVisible"
      title="绑定商品"
      width="720px"
      align-center
      destroy-on-close
    >
      <div v-if="currentRow" style="margin-bottom: 16px">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="商品名称">{{ currentRow.product_name }}</el-descriptions-item>
          <el-descriptions-item label="SKU">{{ currentRow.sku }}</el-descriptions-item>
          <el-descriptions-item label="所属仓库">{{ currentRow.warehouse_name }}</el-descriptions-item>
          <el-descriptions-item label="已绑定数">{{ currentRow.bound_count || 0 }} 个销售商品</el-descriptions-item>
        </el-descriptions>
      </div>

      <!-- 已绑定商品列表 -->
      <div v-if="bindCurrentList.length" style="margin-bottom: 16px">
        <h4 style="margin: 0 0 8px; font-size: 14px; color: #303133">已绑定的销售商品</h4>
        <el-table :data="bindCurrentList" size="small" border max-height="200">
          <el-table-column prop="store_name" label="店铺" width="140" />
          <el-table-column prop="sku_id" label="SKU" width="120" />
          <el-table-column prop="product_name" label="商品名称" min-width="160" show-overflow-tooltip />
          <el-table-column prop="total_quantity" label="数量" width="70" align="center" />
          <el-table-column label="操作" width="70" align="center">
            <template #default="{ row }">
              <el-button link type="danger" size="small" @click="handleUnbindFromDialog(row)">解绑</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <!-- 搜索未绑定销售SKU -->
      <div>
        <h4 style="margin: 0 0 8px; font-size: 14px; color: #303133">搜索销售商品进行绑定</h4>
        <div style="display: flex; gap: 8px; margin-bottom: 10px">
          <el-input v-model="bindSearchKeyword" placeholder="输入商品名称或SKU搜索" clearable style="flex: 1" @keyup.enter="searchUnboundSkus" />
          <el-button type="primary" @click="searchUnboundSkus" :loading="bindSearching">搜索</el-button>
        </div>
        <el-table v-if="bindSearchResults.length" :data="bindSearchResults" size="small" border max-height="250">
          <el-table-column prop="store_name" label="店铺" width="140" />
          <el-table-column prop="sku_id" label="SKU" width="120" />
          <el-table-column prop="product_name" label="商品名称" min-width="160" show-overflow-tooltip />
          <el-table-column label="主图" width="60" align="center">
            <template #default="{ row }">
              <el-image v-if="row.product_image" :src="row.product_image" fit="cover" style="width: 36px; height: 36px; border-radius: 4px" :preview-src-list="[row.product_image]" :preview-teleported="true" />
              <span v-else>--</span>
            </template>
          </el-table-column>
          <el-table-column prop="total_quantity" label="数量" width="70" align="center" />
          <el-table-column label="操作" width="80" align="center">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="handleBindSku(row)" :loading="bindSubmitting">绑定</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="bindSearched && !bindSearchResults.length" style="text-align: center; color: #909399; padding: 16px">未找到未绑定的销售商品</div>
      </div>
    </el-dialog>

    <!-- 采购进货弹窗 -->
    <el-dialog
      v-model="purchaseVisible"
      title="采购进货（仓库进货）"
      width="600px"
      align-center
      destroy-on-close
      :close-on-click-modal="false"
    >
      <div v-if="currentRow" style="margin-bottom: 16px">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="商品名称">{{ currentRow.product_name }}</el-descriptions-item>
          <el-descriptions-item label="SKU">{{ currentRow.sku }}</el-descriptions-item>
          <el-descriptions-item label="当前库存">{{ currentRow.quantity }}</el-descriptions-item>
          <el-descriptions-item label="运输中">{{ currentRow.in_transit_qty || 0 }}</el-descriptions-item>
          <el-descriptions-item label="未采购数">
            <span :style="{ color: currentRow.unpurchased_qty > 0 ? '#e6a23c' : '#67c23a', fontWeight: 500 }">{{ currentRow.unpurchased_qty || 0 }}</span>
          </el-descriptions-item>
        </el-descriptions>
      </div>
      <el-form ref="purchaseFormRef" :model="purchaseForm" :rules="purchaseRules" label-width="100px">
        <el-form-item label="采购数量" prop="quantity">
          <el-input-number v-model="purchaseForm.quantity" :min="1" :step="1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="采购单价" prop="purchase_price">
          <el-input-number v-model="purchaseForm.purchase_price" :min="0" :precision="2" :step="0.1" style="width: 200px" />
        </el-form-item>
        <el-form-item label="采购平台" prop="platform">
          <el-select v-model="purchaseForm.platform" placeholder="请选择采购平台" style="width: 200px" @change="handlePlatformChange">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="1688" value="1688" />
            <el-option label="抖音" value="douyin" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="purchaseForm.account_id" placeholder="请选择采购账号" clearable style="width: 200px">
            <el-option v-for="acc in filteredAccounts" :key="acc.id" :label="acc.account" :value="acc.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="货源链接">
          <el-input v-model="purchaseForm.source_url" placeholder="选填" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="purchaseForm.remark" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="purchaseVisible = false">取消</el-button>
        <el-button type="primary" :loading="purchaseSubmitting" @click="handlePurchaseSubmit">确认采购</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import {
  Goods, Search, Refresh, Plus, Link, ShoppingCart, Edit, Loading
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  fetchInventoryList, createInventory, updateInventory,
  fetchBoundProducts, searchUnboundSalesSkus,
  fetchWarehouses, createSkuBinding, deleteSkuBinding
} from '@/api/warehouse'
import { fetchPurchaseAccounts } from '@/api/purchaseAccount'
import { fetchNextPurchaseNo, createPurchaseOrder } from '@/api/purchaseOrder'

const loading = ref(false)
const warehouseOptions = ref([])

// 筛选表单
const filterForm = reactive({
  warehouse_id: '',
  product_name: '',
  location: '',
  warning_only: false
})

// 分页
const pageInfo = reactive({
  page: 1,
  pageSize: 10,
  total: 0
})

// 数据
const tableData = ref([])

// 判断是否触发预警
function isWarning(row) {
  return Number(row.quantity || 0) <= Number(row.warn_quantity || 0)
}

// 加载数据
async function loadData() {
  loading.value = true
  try {
    const params = {
      page: pageInfo.page,
      pageSize: pageInfo.pageSize
    }
    if (filterForm.warehouse_id) params.warehouse_id = filterForm.warehouse_id
    if (filterForm.product_name) params.product_name = filterForm.product_name
    if (filterForm.location) params.location = filterForm.location
    if (filterForm.warning_only) params.warning_only = 'true'

    const data = await fetchInventoryList(params)
    tableData.value = data.list || []
    pageInfo.total = data.total || 0
  } catch (e) {
    ElMessage.error('加载商品列表失败: ' + e.message)
  } finally {
    loading.value = false
  }
}

// 加载仓库选项
async function loadWarehouses() {
  try {
    const data = await fetchWarehouses()
    warehouseOptions.value = Array.isArray(data) ? data : (data.list || [])
  } catch (e) {
    console.error('加载仓库列表失败:', e.message)
  }
}

// 展开行：绑定商品（按行 ID 存储）
const expandLoadingMap = reactive({})
const boundProductsMap = reactive({})

async function loadBoundProducts(inventoryId) {
  expandLoadingMap[inventoryId] = true
  try {
    const data = await fetchBoundProducts(inventoryId)
    boundProductsMap[inventoryId] = data || []
  } catch (e) {
    boundProductsMap[inventoryId] = []
  } finally {
    expandLoadingMap[inventoryId] = false
  }
}

// 展开行：点击行展开/收起
const tableRef = ref()
const expandedRows = ref([])

function handleExpandChange(row, expandedRowList) {
  expandedRows.value = expandedRowList
  if (expandedRowList.includes(row)) {
    loadBoundProducts(row.id)
  }
}

function handleRowClick(row) {
  if (!tableRef.value) return
  const isExpanded = expandedRows.value.includes(row)
  tableRef.value.toggleRowExpansion(row, !isExpanded)
}

// 解绑
async function handleUnbind(bp, row) {
  try {
    await ElMessageBox.confirm(`确认解绑「${bp.product_name || bp.sku_id}」？`, '解绑确认', { type: 'warning' })
    await deleteSkuBinding({ store_id: bp.store_id, sku_id: bp.sku_id })
    ElMessage.success('解绑成功')
    loadBoundProducts(row.id)
    loadData()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('解绑失败: ' + e.message)
  }
}

function handleSearch() {
  pageInfo.page = 1
  loadData()
}

function handleReset() {
  filterForm.warehouse_id = ''
  filterForm.product_name = ''
  filterForm.location = ''
  filterForm.warning_only = false
  pageInfo.page = 1
  loadData()
}

function handleSizeChange() {
  pageInfo.page = 1
  loadData()
}

function handlePageChange() {
  loadData()
}

// ============ 编辑/新增商品 ============
const editVisible = ref(false)
const editTitle = ref('编辑商品')
const editFormRef = ref()
const isEditMode = ref(false)
const editSubmitting = ref(false)
const editForm = reactive({
  id: '',
  sku: '',
  product_name: '',
  price: 0,
  warehouse_id: '',
  location: '',
  warn_quantity: 10,
  quantity: 0,
  image: ''
})

const editRules = {
  sku: [{ required: true, message: '请输入SKU编号', trigger: 'blur' }],
  product_name: [{ required: true, message: '请输入商品名称', trigger: 'blur' }],
  price: [{ required: true, message: '请输入售价', trigger: 'blur' }],
  warehouse_id: [{ required: true, message: '请选择仓库', trigger: 'change' }],
  warn_quantity: [{ required: true, message: '请输入预警值', trigger: 'blur' }],
  quantity: [{ required: true, message: '请输入当前库存', trigger: 'blur' }]
}

function handleAdd() {
  isEditMode.value = false
  editTitle.value = '新增商品'
  Object.assign(editForm, {
    id: '', sku: '', product_name: '', price: 0,
    warehouse_id: '', location: '', warn_quantity: 10, quantity: 0, image: ''
  })
  editVisible.value = true
}

function handleEdit(row) {
  isEditMode.value = true
  editTitle.value = '编辑商品'
  Object.assign(editForm, {
    id: row.id,
    sku: row.sku,
    product_name: row.product_name,
    price: Number(row.price || 0),
    warehouse_id: row.warehouse_id,
    location: row.location,
    warn_quantity: Number(row.warn_quantity || 0),
    quantity: Number(row.quantity || 0),
    image: row.image
  })
  editVisible.value = true
}

async function handleEditSubmit() {
  try {
    await editFormRef.value.validate()
  } catch { return }

  editSubmitting.value = true
  try {
    if (isEditMode.value) {
      await updateInventory(editForm.id, {
        product_name: editForm.product_name,
        price: editForm.price,
        warehouse_id: editForm.warehouse_id,
        location: editForm.location,
        warn_quantity: editForm.warn_quantity,
        quantity: editForm.quantity,
        image: editForm.image,
        sku: editForm.sku
      })
      ElMessage.success('修改成功')
    } else {
      await createInventory({
        sku: editForm.sku,
        product_name: editForm.product_name,
        price: editForm.price,
        warehouse_id: editForm.warehouse_id,
        location: editForm.location,
        warn_quantity: editForm.warn_quantity,
        quantity: editForm.quantity,
        image: editForm.image
      })
      ElMessage.success('新增成功')
    }
    editVisible.value = false
    loadData()
  } catch (e) {
    ElMessage.error((isEditMode.value ? '修改' : '新增') + '失败: ' + e.message)
  } finally {
    editSubmitting.value = false
  }
}

// ============ 绑定商品 ============
const bindVisible = ref(false)
const currentRow = ref(null)
const bindCurrentList = ref([])
const bindSearchKeyword = ref('')
const bindSearchResults = ref([])
const bindSearched = ref(false)
const bindSearching = ref(false)
const bindSubmitting = ref(false)

async function handleBindProduct(row) {
  currentRow.value = row
  bindSearchKeyword.value = ''
  bindSearchResults.value = []
  bindSearched.value = false
  bindSearching.value = false

  // 加载已绑定列表
  try {
    const data = await fetchBoundProducts(row.id)
    bindCurrentList.value = data || []
  } catch (e) {
    bindCurrentList.value = []
  }

  bindVisible.value = true
}

async function searchUnboundSkus() {
  if (!bindSearchKeyword.value.trim()) {
    ElMessage.warning('请输入搜索关键词')
    return
  }
  bindSearching.value = true
  try {
    const data = await searchUnboundSalesSkus({ keyword: bindSearchKeyword.value.trim() })
    bindSearchResults.value = data || []
    bindSearched.value = true
  } catch (e) {
    ElMessage.error('搜索失败: ' + e.message)
  } finally {
    bindSearching.value = false
  }
}

async function handleBindSku(skuRow) {
  if (!currentRow.value) return
  bindSubmitting.value = true
  try {
    await createSkuBinding({
      store_id: skuRow.store_id,
      sku_id: skuRow.sku_id,
      inventory_id: currentRow.value.id,
      warehouse_id: currentRow.value.warehouse_id
    })
    ElMessage.success('绑定成功')
    // 从搜索结果中移除
    bindSearchResults.value = bindSearchResults.value.filter(
      r => !(r.store_id === skuRow.store_id && r.sku_id === skuRow.sku_id)
    )
    // 刷新已绑定列表
    const data = await fetchBoundProducts(currentRow.value.id)
    bindCurrentList.value = data || []
    loadData()
  } catch (e) {
    ElMessage.error('绑定失败: ' + e.message)
  } finally {
    bindSubmitting.value = false
  }
}

async function handleUnbindFromDialog(bp) {
  try {
    await ElMessageBox.confirm(`确认解绑「${bp.product_name || bp.sku_id}」？`, '解绑确认', { type: 'warning' })
    await deleteSkuBinding({ store_id: bp.store_id, sku_id: bp.sku_id })
    ElMessage.success('解绑成功')
    // 刷新已绑定列表
    if (currentRow.value) {
      const data = await fetchBoundProducts(currentRow.value.id)
      bindCurrentList.value = data || []
    }
    loadData()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('解绑失败: ' + e.message)
  }
}

// ============ 采购进货 ============
const purchaseVisible = ref(false)
const purchaseFormRef = ref()
const purchaseSubmitting = ref(false)
const purchaseAccounts = ref([])
const purchaseForm = reactive({
  quantity: 1,
  purchase_price: 0,
  platform: '',
  account_id: '',
  source_url: '',
  remark: ''
})

const purchaseRules = {
  quantity: [{ required: true, message: '请输入采购数量', trigger: 'blur' }],
  platform: [{ required: true, message: '请选择采购平台', trigger: 'change' }]
}

const filteredAccounts = computed(() => {
  if (!purchaseForm.platform) return purchaseAccounts.value
  return purchaseAccounts.value.filter(a => a.platform === purchaseForm.platform)
})

function handlePlatformChange() {
  purchaseForm.account_id = ''
}

async function handlePurchase(row) {
  currentRow.value = row
  Object.assign(purchaseForm, {
    quantity: row.unpurchased_qty > 0 ? row.unpurchased_qty : 1,
    purchase_price: 0,
    platform: '',
    account_id: '',
    source_url: '',
    remark: ''
  })

  // 加载采购账号
  try {
    const data = await fetchPurchaseAccounts()
    purchaseAccounts.value = Array.isArray(data) ? data : (data.list || [])
  } catch (e) {
    purchaseAccounts.value = []
  }

  purchaseVisible.value = true
}

async function handlePurchaseSubmit() {
  try {
    await purchaseFormRef.value.validate()
  } catch { return }

  purchaseSubmitting.value = true
  try {
    // 获取下一个采购编号
    const noData = await fetchNextPurchaseNo()
    const purchaseNo = noData.purchase_no || String(Date.now())

    await createPurchaseOrder({
      purchase_no: purchaseNo,
      purchase_type: 'warehouse',
      inventory_id: currentRow.value.id,
      goods_name: currentRow.value.product_name,
      goods_image: currentRow.value.image || '',
      sku: currentRow.value.sku,
      quantity: purchaseForm.quantity,
      purchase_price: purchaseForm.purchase_price,
      platform: purchaseForm.platform,
      account_id: purchaseForm.account_id || null,
      source_url: purchaseForm.source_url,
      remark: purchaseForm.remark
    })

    ElMessage.success(`采购单 ${purchaseNo} 创建成功，采购 ${purchaseForm.quantity} 件`)
    purchaseVisible.value = false
    loadData()
  } catch (e) {
    ElMessage.error('创建采购单失败: ' + e.message)
  } finally {
    purchaseSubmitting.value = false
  }
}

// ============ 初始化 ============
onMounted(() => {
  loadWarehouses()
  loadData()
})
</script>

<style scoped>
.goods-manage-page {
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
  background: #1890ff;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: #1f2d3d;
  margin: 0 0 4px;
}

.header-desc {
  font-size: 13px;
  color: #909399;
  margin: 0;
}

.filter-card {
  border-radius: 12px;
}

.filter-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.filter-form :deep(.el-form-item) {
  margin-bottom: 0;
  margin-right: 0;
}

.table-card {
  border-radius: 12px;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.warning-text {
  color: #f56c6c;
  font-weight: 600;
}

.warning-threshold {
  font-size: 11px;
  color: #909399;
  margin-top: 2px;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

/* ========== 展开行卡片式样式 ========== */
.expand-panel {
  padding: 16px 24px 20px;
  background: linear-gradient(135deg, #f8fafc 0%, #f0f5ff 100%);
  border-top: 2px solid #409EFF;
}

.expand-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.expand-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.expand-panel-title svg {
  color: #409EFF;
}

.expand-panel-count {
  font-size: 12px;
  color: #909399;
  background: #fff;
  padding: 2px 10px;
  border-radius: 12px;
  border: 1px solid #e4e7ed;
}

.expand-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 0;
  color: #909399;
  font-size: 13px;
}

.expand-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px 0 20px;
  color: #c0c4cc;
}

.expand-empty p {
  margin-top: 10px;
  font-size: 13px;
  color: #c0c4cc;
}

.expand-product-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.product-card {
  display: flex;
  align-items: center;
  gap: 16px;
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 12px 16px;
  transition: all .2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .03);
}

.product-card:hover {
  border-color: #d0e3ff;
  box-shadow: 0 4px 12px rgba(64, 158, 255, .08);
  transform: translateY(-1px);
}

.product-card-img {
  width: 52px;
  height: 52px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid #f0f0f0;
}

.product-card-img .el-image {
  width: 100%;
  height: 100%;
}

.product-card-img-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
}

.product-card-info {
  flex: 1;
  min-width: 0;
}

.product-card-name {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}

.product-card-meta {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}

.product-card-meta svg {
  margin-right: 3px;
  vertical-align: -1px;
}

.meta-store {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.meta-sku {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  background: #f5f7fa;
  padding: 1px 6px;
  border-radius: 3px;
}

.product-card-stats {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-shrink: 0;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-label {
  font-size: 11px;
  color: #b0b3b8;
  text-transform: uppercase;
  letter-spacing: .5px;
}

.stat-value {
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.stat-value.price {
  color: #f56c6c;
}

.stat-value.warning {
  color: #e6a23c;
}

.stat-value.success {
  color: #67c23a;
}

.product-card-action {
  flex-shrink: 0;
  margin-left: 8px;
  padding-left: 16px;
  border-left: 1px solid #f0f2f5;
}
</style>
