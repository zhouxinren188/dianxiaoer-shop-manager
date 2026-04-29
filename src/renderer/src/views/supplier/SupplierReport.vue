<template>
  <div class="supplier-report-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><DocumentChecked /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">供货商报表</h2>
          <p class="header-desc">汇总供货商发货、采购及库存相关数据报表</p>
        </div>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="stats-row">
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #1890ff">{{ stats.totalSuppliers }}</div>
        <div class="stat-label">合作供货商</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #67c23a">{{ stats.monthShipments }}</div>
        <div class="stat-label">本月发货单</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #e6a23c">¥{{ stats.monthAmount.toFixed(2) }}</div>
        <div class="stat-label">本月采购金额</div>
      </el-card>
      <el-card class="stat-card" shadow="never">
        <div class="stat-value" style="color: #f56c6c">{{ stats.inTransitQty }}</div>
        <div class="stat-label">运输中商品</div>
      </el-card>
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="供货商">
          <el-select v-model="filterForm.supplier" placeholder="全部供货商" clearable style="width: 160px">
            <el-option v-for="s in supplierOptions" :key="s" :label="s" :value="s" />
          </el-select>
        </el-form-item>
        <el-form-item label="报表类型">
          <el-select v-model="filterForm.reportType" placeholder="全部类型" clearable style="width: 140px">
            <el-option label="发货报表" value="shipment" />
            <el-option label="采购报表" value="purchase" />
            <el-option label="退货报表" value="return" />
          </el-select>
        </el-form-item>
        <el-form-item label="日期范围">
          <el-date-picker
            v-model="filterForm.dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            style="width: 260px"
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
          <span>报表明细</span>
          <el-button type="primary" plain @click="handleExport">
            <el-icon><Download /></el-icon>
            导出Excel
          </el-button>
        </div>
      </template>

      <el-table
        :data="tableData"
        stripe
        border
        v-loading="loading"
        :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }"
      >
        <el-table-column prop="date" label="日期" width="110" align="center" />
        <el-table-column prop="supplier" label="供货商" width="140" />
        <el-table-column prop="reportType" label="类型" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="typeTag(row.reportType)" size="small">{{ typeText(row.reportType) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="orderNo" label="单号" width="160" />
        <el-table-column prop="goodsName" label="商品名称" min-width="180" show-overflow-tooltip />
        <el-table-column prop="quantity" label="数量" width="80" align="center" />
        <el-table-column prop="amount" label="金额" width="110" align="right">
          <template #default="{ row }">
            <span style="color: #f56c6c; font-weight: 500">¥{{ row.amount.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="warehouse" label="收货仓库" width="120" align="center" />
        <el-table-column prop="status" label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTag(row.status)" size="small">{{ row.status }}</el-tag>
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
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'
import {
  DocumentChecked,
  Search,
  Refresh,
  Download
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const loading = ref(false)

const stats = reactive({
  totalSuppliers: 12,
  monthShipments: 86,
  monthAmount: 128560.50,
  inTransitQty: 234
})

const supplierOptions = ['优供货源', '鑫盛商贸', '达通物流', '百汇供应']

const filterForm = reactive({
  supplier: '',
  reportType: '',
  dateRange: null
})

const pageInfo = reactive({
  page: 1,
  pageSize: 10,
  total: 8
})

const tableData = ref([
  { date: '2026-04-28', supplier: '优供货源', reportType: 'shipment', orderNo: 'SH20260001', goodsName: '无线蓝牙耳机 Pro', quantity: 50, amount: 9950.00, warehouse: '杭州主仓库', status: '已完成' },
  { date: '2026-04-27', supplier: '鑫盛商贸', reportType: 'purchase', orderNo: 'CG20260045', goodsName: '智能手环 X3', quantity: 100, amount: 15000.00, warehouse: '广州分仓', status: '已入库' },
  { date: '2026-04-26', supplier: '达通物流', reportType: 'shipment', orderNo: 'SH20260002', goodsName: '便携式充电宝', quantity: 80, amount: 7200.00, warehouse: '成都分仓', status: '运输中' },
  { date: '2026-04-25', supplier: '优供货源', reportType: 'return', orderNo: 'TH20260012', goodsName: '机械键盘 RGB', quantity: 5, amount: 1795.00, warehouse: '杭州主仓库', status: '已退货' },
  { date: '2026-04-24', supplier: '百汇供应', reportType: 'purchase', orderNo: 'CG20260044', goodsName: '4K高清显示器', quantity: 20, amount: 18000.00, warehouse: '杭州主仓库', status: '待收货' },
  { date: '2026-04-23', supplier: '鑫盛商贸', reportType: 'shipment', orderNo: 'SH20260003', goodsName: 'Type-C扩展坞', quantity: 120, amount: 9600.00, warehouse: '广州分仓', status: '已完成' },
  { date: '2026-04-22', supplier: '达通物流', reportType: 'purchase', orderNo: 'CG20260043', goodsName: '无线鼠标', quantity: 200, amount: 8000.00, warehouse: '成都分仓', status: '已入库' },
  { date: '2026-04-21', supplier: '优供货源', reportType: 'shipment', orderNo: 'SH20260004', goodsName: '手机支架', quantity: 300, amount: 4500.00, warehouse: '杭州主仓库', status: '已完成' }
])

function typeTag(type) {
  const map = { shipment: 'primary', purchase: 'success', return: 'danger' }
  return map[type] || 'info'
}

function typeText(type) {
  const map = { shipment: '发货', purchase: '采购', return: '退货' }
  return map[type] || type
}

function statusTag(status) {
  const map = { '已完成': 'success', '已入库': 'success', '运输中': 'warning', '待收货': 'primary', '已退货': 'danger' }
  return map[status] || 'info'
}

function handleSearch() {
  loading.value = true
  setTimeout(() => { loading.value = false }, 300)
}

function handleReset() {
  filterForm.supplier = ''
  filterForm.reportType = ''
  filterForm.dateRange = null
  handleSearch()
}

function handleExport() {
  ElMessage.success('报表导出成功')
}

function handleSizeChange(val) {
  pageInfo.pageSize = val
}

function handlePageChange(val) {
  pageInfo.page = val
}
</script>

<style scoped>
.supplier-report-page {
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

/* 统计卡片 */
.stats-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}

.stat-card {
  border-radius: 12px;
  text-align: center;
  padding: 8px 0;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.4;
}

.stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}

/* 筛选 */
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

/* 表格 */
.table-card {
  border-radius: 12px;
}

.table-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
