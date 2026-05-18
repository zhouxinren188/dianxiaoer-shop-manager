<template>
  <div class="purchase-page">
    <!-- 顶部标题区 -->
    <div class="page-header-card">
      <div class="header-left">
        <div class="header-icon">
          <el-icon :size="22" color="#fff"><Document /></el-icon>
        </div>
        <div class="header-info">
          <h2 class="header-title">采购订单管理</h2>
          <p class="header-desc">管理所有采购订单，跟踪物流状态，关联入库操作</p>
        </div>
      </div>
      <div class="header-right">
        <div class="header-account">
          <span class="account-label">采购账号</span>
          <el-select v-model="selectedAccount" placeholder="请选择" size="small" style="width: 160px">
            <el-option label="全部账号" value="">
              <span>全部账号</span>
            </el-option>
            <el-option v-for="acc in accountList" :key="acc.id" :label="acc.username || '未命名'" :value="acc.id">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span>{{ acc.username || '未命名' }}</span>
                <div style="display:flex;gap:6px;align-items:center">
                  <el-tag :type="platformTagType(acc.platform)" size="small">{{ platformLabel(acc.platform) }}</el-tag>
                  <el-tag :type="acc.cookie_valid ? 'success' : 'danger'" size="small">{{ acc.cookie_valid ? '有效' : '失效' }}</el-tag>
                </div>
              </div>
            </el-option>
          </el-select>
        </div>
        <el-button type="danger" size="small" @click="handleAccountManage">账号管理</el-button>
        <el-button type="primary" size="small" @click="handleAddAccount">新增账号</el-button>
        <el-button size="small" @click="handleImportAccount">导入账号</el-button>
        <el-button type="primary" @click="handleSync" :loading="syncing">
          <el-icon><Refresh /></el-icon>
          同步采购订单
        </el-button>
      </div>
    </div>
    <!-- 批量同步进度 -->
    <div v-if="batchSyncProgress.active" class="batch-sync-progress">
      <el-progress
        :percentage="batchSyncProgress.total > 0 ? Math.round(batchSyncProgress.current / batchSyncProgress.total * 100) : 0"
        :stroke-width="6"
        :show-text="false"
        style="flex: 1"
      />
      <span class="batch-sync-text">
        {{ batchSyncProgress.current }}/{{ batchSyncProgress.total }}
        {{ batchSyncProgress.status === 'syncing' ? `正在同步 ${batchSyncProgress.orderNo}` : `同步完成 ${batchSyncProgress.orderNo}` }}
      </span>
    </div>

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="采购编号">
          <el-input v-model="filterForm.purchaseNo" placeholder="请输入采购编号" clearable style="width: 160px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="物流单号">
          <el-input v-model="filterForm.logisticsNo" placeholder="请输入物流单号" clearable style="width: 180px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="采购订单号">
          <el-input v-model="filterForm.platformOrderNo" placeholder="请输入采购订单号" clearable style="width: 180px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="关联销售单号">
          <el-input v-model="filterForm.salesOrderNo" placeholder="请输入销售单号" clearable style="width: 160px" @keyup.enter="handleSearch" />
        </el-form-item>
        <el-form-item label="采购平台">
          <el-select v-model="filterForm.platform" placeholder="全部" clearable style="width: 130px">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="阿里巴巴" value="1688" />
          </el-select>
        </el-form-item>
        <el-form-item label="订单类型">
          <el-select v-model="filterForm.purchaseType" placeholder="全部" clearable style="width: 130px">
            <el-option label="三方代发" value="dropship" />
            <el-option label="仓库转发" value="warehouse" />
            <el-option label="仓库进货" value="warehouse_in" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="filterForm.accountId" placeholder="全部" clearable style="width: 180px">
            <el-option v-for="acc in accountList" :key="acc.id" :label="acc.username || '未命名'" :value="acc.id">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span>{{ acc.username || '未命名' }}</span>
                <div style="display:flex;gap:6px;align-items:center">
                  <el-tag :type="platformTagType(acc.platform)" size="small">{{ platformLabel(acc.platform) }}</el-tag>
                  <el-tag :type="acc.cookie_valid ? 'success' : 'danger'" size="small">{{ acc.cookie_valid ? '有效' : '失效' }}</el-tag>
                </div>
              </div>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">
            <el-icon><Search /></el-icon>
            查询
          </el-button>
          <el-button @click="handleReset">
            <el-icon><RefreshRight /></el-icon>
            重置
          </el-button>
          <el-button type="success" @click="handleAddPurchase">
            <el-icon><Plus /></el-icon>
            手动添加采购单
          </el-button>
          <el-button type="warning" @click="handleBatchImport">
            <el-icon><Upload /></el-icon>
            批量导入
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <!-- 状态Tab统计 -->
    <div class="status-tabs">
      <span
        v-for="tab in statusTabs"
        :key="tab.value"
        class="status-tab-item"
        :class="{ active: filterForm.status === tab.value }"
        @click="handleStatusTab(tab.value)"
      >
        {{ tab.label }}
        <span class="tab-count">({{ tab.count }})</span>
      </span>
    </div>

    <!-- 数据表格 -->
    <el-card class="table-card" shadow="never">
      <el-table
        ref="purchaseTableRef"
        :data="pagedData"
        stripe
        v-loading="loading"
        :header-cell-style="{ background: '#f7f8fa', fontWeight: 600, color: '#909399', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }"
        :cell-style="{ padding: '12px 0' }"
        row-key="id"
        @expand-change="handleExpandChange"
        @row-click="handleRowClick"
      >
        <!-- 展开行：关联销售商品信息（隐藏展开箭头） -->
        <el-table-column type="expand" class-name="hide-expand-icon">
          <template #default="{ row }">
            <div class="expand-panel">
              <div class="expand-header">
                <span class="expand-header-dot"></span>
                <span class="expand-header-title">关联销售订单</span>
              </div>
              <div v-if="relatedSalesLoadingMap[row.id]" class="expand-loading">
                <el-icon class="is-loading" :size="16" color="#409EFF"><Loading /></el-icon>
                <span>加载中...</span>
              </div>
              <div v-else-if="!relatedSalesDataMap[row.id]" class="expand-empty">暂无关联销售订单</div>
              <div v-else class="expand-row">
                <span class="expand-tag store-tag">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
                  {{ relatedSalesDataMap[row.id].storeName || '--' }}
                </span>
                <span v-if="relatedSalesDataMap[row.id].warehouseName" class="expand-tag warehouse-tag">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M5 21V7l8-4v18M19 21V11l-6-4"/></svg>
                  {{ relatedSalesDataMap[row.id].warehouseName }}
                </span>
                <span class="expand-tag order-tag copyable" @click.stop="copyText(relatedSalesDataMap[row.id].orderId)" title="点击复制订单号">{{ relatedSalesDataMap[row.id].orderId || '--' }}</span>
                <span class="expand-tag status-tag" :class="getSalesStatusClass(relatedSalesDataMap[row.id].statusText)">
                  <span class="expand-status-dot"></span>
                  {{ relatedSalesDataMap[row.id].statusText || '--' }}
                </span>
                <div class="expand-divider"></div>
                <div v-for="(item, idx) in relatedSalesDataMap[row.id].items" :key="idx" class="expand-product-item">
                  <div class="expand-product-img">
                    <el-image v-if="item.image" :src="item.image" fit="cover"
                      :preview-src-list="[item.image]" :preview-teleported="true" />
                    <div v-else class="expand-product-img-empty">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#c0c4cc" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                    </div>
                  </div>
                  <span class="expand-product-name">{{ item.name || '--' }}</span>
                  <span class="expand-product-price">¥{{ Number(item.price || 0).toFixed(2) }}</span>
                  <span class="expand-product-qty">x{{ item.quantity }}</span>
                </div>
              </div>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="purchase_no" label="采购编号" width="90" align="center">
          <template #default="{ row }">
            <span class="cell-purchase-no">{{ row.purchase_no }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="platform_order_no" label="采购订单号" width="180" align="center">
          <template #default="{ row }">
            <span v-if="row.platform_order_no" class="cell-order-no">{{ row.platform_order_no }}</span>
            <span v-else class="cell-empty">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="goods_name" label="商品信息" min-width="260">
          <template #default="{ row }">
            <div class="cell-product">
              <div class="cell-product-img">
                <el-image v-if="row.goods_image" :src="row.goods_image" fit="cover"
                  :preview-src-list="[row.goods_image]" preview-teleported />
                <div v-else class="cell-product-img-empty">--</div>
              </div>
              <div class="cell-product-name">{{ row.goods_name }}</div>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="quantity" label="数量" width="70" align="center" />

        <el-table-column prop="purchase_price" label="采购单价" width="100" align="center">
          <template #default="{ row }">
            <span v-if="row.purchase_price" class="cell-price">¥{{ Number(row.purchase_price).toFixed(2) }}</span>
            <span v-else class="cell-empty">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="platform" label="采购平台" width="100" align="center">
          <template #default="{ row }">
            <span class="cell-platform">{{ platformLabel(row.platform) }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="account_name" label="采购账号" width="140" align="center">
          <template #default="{ row }">
            <span>{{ row.account_name || '-' }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="purchase_type" label="采购类型" width="130" align="center">
          <template #default="{ row }">
            <div>
              <el-tag v-if="row.purchase_type === 'warehouse'" type="warning" size="small">仓库转发</el-tag>
              <el-tag v-else-if="row.purchase_type === 'warehouse_in'" type="danger" size="small">仓库进货</el-tag>
              <el-tag v-else type="success" size="small">三方代发</el-tag>
            </div>
            <div v-if="row.warehouse_name" class="cell-warehouse">{{ row.warehouse_name }}</div>
          </template>
        </el-table-column>

        <el-table-column prop="logistics_no" label="物流单号" width="200" align="center">
          <template #default="{ row }">
            <div v-if="row.logistics_no">
              <span class="cell-order-no cell-logistics-no" @click.stop="handleViewLogistics(row)">{{ row.logistics_no }}</span>
              <div v-if="row.logistics_company" class="cell-logistics-company">{{ row.logistics_company }}</div>
            </div>
            <span v-else class="cell-empty">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="status" label="订单状态" width="110" align="center">
          <template #default="{ row }">
            <span class="cell-status" :class="'status-' + row.status">
              <span class="status-dot"></span>
              {{ statusLabel(row.status) }}
            </span>
          </template>
        </el-table-column>

        <el-table-column prop="created_at" label="创建时间" width="160" align="center">
          <template #default="{ row }">
            <span class="cell-time">{{ formatTime(row.created_at) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="230" align="center" fixed="right">
          <template #default="{ row }">
            <el-button link type="success" size="small" @click="handleSyncSingle(row)">
              同步
            </el-button>
            <el-button link type="warning" size="small" @click="handleEditPurchase(row)">
              编辑
            </el-button>
            <el-button v-if="row.status === 'shipped'" link type="primary" size="small" @click="handleConfirmReceive(row)">
              确认签收
            </el-button>
            <el-button v-if="(row.status === 'in_transit' || row.status === 'received') && (row.purchase_type === 'warehouse' || row.purchase_type === 'warehouse_in')" link type="primary" size="small" @click="handleReceive(row)">
              收货
            </el-button>
            <el-button v-if="(row.status === 'in_transit' || row.status === 'received') && row.purchase_type === 'dropship'" link type="success" size="small" @click="handleComplete(row)">
              完成
            </el-button>
            <el-button v-if="row.status === 'stocked'" link type="warning" size="small" @click="handleOutbound(row)">
              出库
            </el-button>
            <el-button link type="primary" size="small" @click="handleViewDetail(row)">
              详情
            </el-button>
            <el-button link type="danger" size="small" @click="handleDeleteOrder(row)">
              删除
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
          :page-sizes="[20, 50, 100]"
          @size-change="handleSizeChange"
          @current-change="handlePageChange"
        />
      </div>
    </el-card>

    <!-- 详情抽屉 -->
    <el-drawer v-model="detailVisible" title="采购订单详情" size="540px" direction="rtl">
      <template v-if="currentRow">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="采购编号">
            <span style="font-weight: 600; color: #e6a23c">{{ currentRow.purchase_no }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="采购订单号">{{ currentRow.platform_order_no || '--' }}</el-descriptions-item>
          <el-descriptions-item label="采购平台">{{ platformLabel(currentRow.platform) }}</el-descriptions-item>
          <el-descriptions-item label="商品名称">{{ currentRow.goods_name }}</el-descriptions-item>
          <el-descriptions-item label="规格">{{ currentRow.sku || '--' }}</el-descriptions-item>
          <el-descriptions-item label="采购数量">{{ currentRow.quantity }}</el-descriptions-item>
          <el-descriptions-item label="采购单价">
            <span v-if="currentRow.purchase_price">¥{{ Number(currentRow.purchase_price).toFixed(2) }}</span>
            <span v-else>--</span>
          </el-descriptions-item>
          <el-descriptions-item label="采购总额">
            <span v-if="currentRow.purchase_price" style="color: #f56c6c; font-weight: 600">¥{{ (Number(currentRow.purchase_price) * currentRow.quantity).toFixed(2) }}</span>
            <span v-else>--</span>
          </el-descriptions-item>
          <el-descriptions-item label="订单状态">
            <el-tag :type="statusTagType(currentRow.status)" size="small">{{ statusLabel(currentRow.status) }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="物流公司">{{ currentRow.logistics_company || '--' }}</el-descriptions-item>
          <el-descriptions-item label="物流单号">{{ currentRow.logistics_no || '--' }}</el-descriptions-item>
          <el-descriptions-item label="货源链接">
            <el-link v-if="currentRow.source_url" type="primary" :href="currentRow.source_url" target="_blank">{{ currentRow.source_url }}</el-link>
            <span v-else>--</span>
          </el-descriptions-item>
          <el-descriptions-item label="备注">{{ currentRow.remark || '--' }}</el-descriptions-item>
          <el-descriptions-item label="创建时间">{{ formatTime(currentRow.created_at) }}</el-descriptions-item>
          <el-descriptions-item label="更新时间">{{ formatTime(currentRow.updated_at) }}</el-descriptions-item>
        </el-descriptions>
      </template>
    </el-drawer>

    <!-- 物流轨迹弹窗 -->
    <el-dialog
      v-model="logisticsVisible"
      title="物流轨迹"
      width="650px"
      align-center
    >
      <div v-if="logisticsData" class="logistics-container">
        <div class="logistics-header">
          <span>{{ logisticsData.company || '--' }}</span>
          <span class="logistics-header-sep">|</span>
          <span>{{ logisticsData.tracking_no || '--' }}</span>
          <el-tag size="small" :type="logisticsData.source === 'local' ? 'info' : 'primary'" style="margin-left: 8px">
            {{ logisticsData.source === 'taobao' ? '淘宝' : logisticsData.source === '1688' ? '阿里巴巴' : logisticsData.source === 'pinduoduo' ? '拼多多' : logisticsData.source === 'local' ? '本地' : '快递100' }}
          </el-tag>
        </div>

        <div v-if="logisticsData.tracks && logisticsData.tracks.length > 0" class="logistics-list">
          <div v-for="(track, index) in logisticsData.tracks" :key="index" class="logistics-item" :class="{ 'logistics-item-latest': index === 0 }">
            <div class="logistics-item-time">{{ formatTime(track.time || track.timestamp) }}</div>
            <div class="logistics-item-dot">
              <span class="logistics-dot" :class="index === 0 ? 'logistics-dot-active' : ''"></span>
              <span v-if="index < logisticsData.tracks.length - 1" class="logistics-line"></span>
            </div>
            <div class="logistics-item-text">{{ track.context || track.desc || track.message }}</div>
          </div>
        </div>
        <el-empty v-else :description="logisticsData.source === 'local' ? '暂无详细轨迹，可到平台查看物流详情' : '暂无物流轨迹信息'" />
      </div>
      <div v-else v-loading="logisticsLoading" style="min-height: 200px"></div>
    </el-dialog>

    <!-- 同步采购订单弹窗 -->
    <!-- 收货选择对话框 -->
    <el-dialog
      v-model="receiveDialogVisible"
      title="收货确认"
      width="460px"
      align-center
      :close-on-click-modal="false"
    >
      <!-- 仓库进货 -->
      <div v-if="currentReceiveRow?.purchase_type === 'warehouse_in'" class="receive-confirm-content">
        <p class="receive-confirm-text">
          该订单类型为<strong class="receive-confirm-type">仓库进货</strong>，是否立即入库？
        </p>
      </div>
      <template v-if="currentReceiveRow?.purchase_type === 'warehouse_in'" #footer>
        <el-button type="primary" @click="handleStockIn">入库</el-button>
      </template>

      <!-- 仓库转发 -->
      <div v-if="currentReceiveRow?.purchase_type === 'warehouse'" class="receive-confirm-content">
        <p class="receive-confirm-text">
          该订单类型为<strong class="receive-confirm-type">仓库转发</strong>，归属<strong class="receive-confirm-warehouse">{{ currentReceiveRow.sales_warehouse_name || '未知仓库' }}</strong><template v-if="currentReceiveRow.sales_order_status">，关联销售单目前处于<strong class="receive-confirm-sales">{{ currentReceiveRow.sales_order_status }}</strong></template>，是否立即转发？
        </p>
      </div>
      <template v-if="currentReceiveRow?.purchase_type === 'warehouse'" #footer>
        <div class="receive-confirm-footer">
          <el-button type="primary" @click="handleForward">云仓发货</el-button>
          <el-button type="primary" plain @click="handleStoreShip">店铺发货</el-button>
          <el-button type="danger" @click="handleMarkAfterSale">标记售后</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 完成确认对话框 -->
    <el-dialog
      v-model="completeDialogVisible"
      title="确认完成"
      width="460px"
      align-center
      :close-on-click-modal="false"
    >
      <div class="receive-confirm-content">
        <p class="receive-confirm-text">
          该订单类型为<strong class="receive-confirm-type">三方代发</strong>，确认将采购单 <strong>{{ currentCompleteRow?.purchase_no }}</strong> 标记为已完成？
        </p>
      </div>
      <template #footer>
        <div class="receive-confirm-footer">
          <el-button type="success" @click="handleConfirmComplete">确认完成</el-button>
          <el-button type="danger" @click="handleCompleteMarkAfterSale">标记售后</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 云仓打单发货对话框 -->
    <el-dialog
      v-model="forwardDialogVisible"
      title="云仓打单发货"
      width="540px"
      align-center
      :close-on-click-modal="false"
      class="forward-dialog"
    >
      <div v-loading="forwardLoading" class="forward-content">
        <template v-if="forwardSalesData">
          <!-- 订单概要信息 -->
          <div class="forward-summary">
            <div class="forward-summary-row">
              <span class="forward-label">销售订单号</span>
              <span class="forward-value forward-order-no">{{ forwardSalesData.orderId || '--' }}</span>
            </div>
            <div class="forward-summary-row">
              <span class="forward-label">订单状态</span>
              <span class="forward-value">
                <el-tag size="small" :type="getSalesStatusTagType(forwardSalesData.statusText)">{{ forwardSalesData.statusText || '--' }}</el-tag>
              </span>
            </div>
            <div class="forward-summary-row">
              <span class="forward-label">归属仓库</span>
              <span class="forward-value forward-warehouse">{{ forwardSalesData.warehouseName || '未知仓库' }}</span>
            </div>
            <div class="forward-summary-row">
              <span class="forward-label">店铺名称</span>
              <span class="forward-value">{{ forwardSalesData.storeName || '--' }}</span>
            </div>
          </div>
          <!-- 商品信息 -->
          <div class="forward-goods-title">商品信息</div>
          <div class="forward-goods-list">
            <div v-for="(item, idx) in forwardSalesData.items" :key="idx" class="forward-product-item">
              <img v-if="item.image" :src="item.image" class="forward-product-img" />
              <div v-else class="forward-product-img forward-product-img-placeholder">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="#dcdfe6" stroke-width="1.5"/><circle cx="8.5" cy="8.5" r="1.5" fill="#dcdfe6"/><path d="M21 15l-5-5L5 21" stroke="#dcdfe6" stroke-width="1.5" stroke-linecap="round"/></svg>
              </div>
              <div class="forward-product-info">
                <div class="forward-product-name">{{ item.name || '--' }}</div>
                <div class="forward-product-meta">
                  <span class="forward-product-price">¥{{ item.price || 0 }}</span>
                  <span class="forward-product-qty">×{{ item.quantity || 1 }}</span>
                </div>
              </div>
            </div>
          </div>
        </template>
        <div v-else-if="!forwardLoading" class="forward-empty">暂无关联销售订单信息</div>
      </div>
      <template #footer>
        <el-button type="primary" @click="handleConfirmForward">我已转发</el-button>
        <el-button @click="forwardDialogVisible = false">取消</el-button>
      </template>
    </el-dialog>

    <!-- 入库数量对话框 -->
    <el-dialog
      v-model="stockInDialogVisible"
      title="确认入库"
      width="500px"
      align-center
      :close-on-click-modal="false"
    >
      <div v-if="stockInForm.inventoryInfo" style="margin-bottom: 16px">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="商品名称">{{ stockInForm.inventoryInfo.productName }}</el-descriptions-item>
          <el-descriptions-item label="SKU">{{ stockInForm.inventoryInfo.sku }}</el-descriptions-item>
          <el-descriptions-item label="仓库">{{ stockInForm.inventoryInfo.warehouseName }}</el-descriptions-item>
          <el-descriptions-item label="当前库存">{{ stockInForm.inventoryInfo.quantity }}</el-descriptions-item>
        </el-descriptions>
      </div>
      <el-form label-width="120px">
        <el-form-item label="本次实际收货">
          <el-input-number v-model="stockInForm.actualQuantity" :min="1" :max="9999" style="width: 200px" />
          <span style="margin-left: 8px; color: #909399; font-size: 12px">采购数量: {{ currentReceiveRow?.quantity || 0 }}</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="stockInDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmStockIn" :loading="stockInLoading">确认入库</el-button>
      </template>
    </el-dialog>

    <!-- 售后标记对话框 -->
    <el-dialog
      v-model="aftersaleDialogVisible"
      title="标记售后"
      width="480px"
      :close-on-click-modal="false"
      destroy-on-close
    >
      <el-form label-width="80px">
        <el-form-item label="售后状态">
          <el-select v-model="aftersaleForm.aftersale_status" placeholder="选择售后状态" style="width: 100%">
            <el-option label="待申请退款" value="pending_refund" />
            <el-option label="待申请退货退款" value="pending_return_refund" />
            <el-option label="待退货上传单号" value="pending_return_tracking" />
            <el-option label="待商家处理" value="pending_merchant_handle" />
            <el-option label="售后关闭" value="closed" />
          </el-select>
        </el-form-item>
        <el-form-item label="售后备注">
          <el-input type="textarea" v-model="aftersaleForm.aftersale_remark" :rows="3" placeholder="记录售后现状，方便后续处理" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="aftersaleDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitAftersale">确认</el-button>
      </template>
    </el-dialog>

    <!-- 绑定仓库商品对话框 -->
    <el-dialog
      v-model="bindDialogVisible"
      title="绑定仓库商品"
      width="700px"
      :close-on-click-modal="false"
      destroy-on-close
    >
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
        </div>
      </div>

      <el-divider>搜索已有库存</el-divider>

      <div class="bind-search-section">
        <div v-if="bindKeywords.length > 0" class="bind-keywords-row">
          <span class="bind-keywords-label">关键词：</span>
          <el-tag v-for="kw in bindKeywords" :key="kw" size="small" type="info" effect="plain" class="bind-keyword-tag" @click="applyKeyword(kw)">{{ kw }}</el-tag>
        </div>
        <el-input v-model="bindSearchKeyword" placeholder="输入SKU或商品名称搜索" clearable @keyup.enter="searchInventoryForBind" style="width: 300px">
          <template #append>
            <el-button @click="searchInventoryForBind" :loading="bindSearchLoading">
              <el-icon><Search /></el-icon>
            </el-button>
          </template>
        </el-input>
        <el-table v-if="bindSearchResults.length > 0" :data="bindSearchResults" stripe size="small" style="margin-top: 12px; max-height: 200px; overflow-y: auto">
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

      <div class="bind-create-section">
        <el-form :model="bindNewForm" label-width="80px" size="default">
          <el-form-item label="仓库">
            <el-select v-model="bindNewForm.warehouseId" placeholder="选择仓库" style="width: 100%">
              <el-option v-for="wh in warehouseOptions" :key="wh.id" :label="wh.name" :value="wh.id" />
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
        <el-button type="primary" @click="confirmCreateAndBind" :loading="bindCreateLoading" style="margin-top: 4px">新建并绑定</el-button>
      </div>
    </el-dialog>

    <el-dialog
      v-model="syncDialogVisible"
      title="同步采购订单"
      width="500px"
      align-center
      :close-on-click-modal="false"
    >
      <el-alert
        type="info"
        :closable="false"
        style="margin-bottom: 16px"
        title="同步说明"
        description="系统将通过采购账号Cookie从对应平台获取购买记录，仅匹配已绑定采购编号的订单进行状态同步（物流信息等）。"
      />
      <el-form label-width="100px">
        <el-form-item label="采购平台">
          <el-radio-group v-model="syncForm.platform" @change="syncForm.accountId = ''">
            <el-radio value="taobao">淘宝/天猫</el-radio>
            <el-radio value="pinduoduo">拼多多</el-radio>
            <el-radio value="1688">阿里巴巴</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="syncForm.accountId" placeholder="请选择采购账号" style="width: 100%">
            <el-option v-for="acc in accountList.filter(a => a.platform === syncForm.platform)" :key="acc.id" :label="acc.username || '未命名'" :value="acc.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="syncDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="syncing" @click="handleSyncSubmit">开始同步</el-button>
      </template>
    </el-dialog>

    <!-- 新增账号弹窗 -->
    <el-dialog
      v-model="addAccountVisible"
      title="新增采购账号"
      width="420px"
      align-center
      destroy-on-close
    >
      <el-form label-width="80px">
        <el-form-item label="采购平台">
          <el-select v-model="addAccountForm.platform" placeholder="请选择平台" style="width: 100%">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="阿里巴巴" value="1688" />
            <el-option label="抖音" value="douyin" />
          </el-select>
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="addAccountForm.account" placeholder="请输入登录账号" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="addAccountForm.password" placeholder="请输入登录密码" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addAccountVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!addAccountForm.platform || !addAccountForm.account" @click="handleAddAccountSubmit">前往登录</el-button>
      </template>
    </el-dialog>

    <!-- 账号管理弹窗 -->
    <el-dialog
      v-model="accountManageVisible"
      title="采购账号管理"
      width="720px"
      align-center
      destroy-on-close
    >
      <el-table :data="accountList" stripe border size="small" :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }">
        <el-table-column prop="username" label="账号" width="160" />
        <el-table-column prop="password" label="密码" width="140">
          <template #default="{ row }">
            <span v-if="row.showPwd">{{ row.password }}</span>
            <span v-else>******</span>
            <el-button link size="small" @click="row.showPwd = !row.showPwd" style="margin-left: 4px">
              {{ row.showPwd ? '隐藏' : '查看' }}
            </el-button>
          </template>
        </el-table-column>
        <el-table-column prop="platform" label="平台" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="platformTagType(row.platform)" size="small">{{ platformLabel(row.platform) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.status === 'online' ? 'success' : 'info'" size="small" effect="light">
              {{ row.status === 'online' ? '在线' : '离线' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleLoginAccount(row)">登录</el-button>
            <el-button link type="success" size="small" @click="handleReloginAccount(row)">重登</el-button>
            <el-button link type="info" size="small" @click="handleExportCookies(row)">导出Cookie</el-button>
            <el-button link type="info" size="small" @click="handleImportCookies(row)">导入Cookie</el-button>
            <el-button link type="warning" size="small" @click="handleEditAccount(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDeleteAccount(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="accountManageVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 编辑账号弹窗 -->
    <el-dialog
      v-model="editAccountVisible"
      title="编辑账号"
      width="420px"
      align-center
      destroy-on-close
      :close-on-click-modal="false"
    >
      <el-form label-width="80px">
        <el-form-item label="平台">
          <el-select v-model="editAccountForm.platform" style="width: 100%">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="阿里巴巴" value="1688" />
            <el-option label="抖音" value="douyin" />
          </el-select>
        </el-form-item>
        <el-form-item label="账号">
          <el-input v-model="editAccountForm.username" placeholder="请输入账号" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="editAccountForm.password" placeholder="请输入密码" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editAccountVisible = false">取消</el-button>
        <el-button type="primary" @click="handleEditAccountSubmit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 编辑采购单弹窗 -->
    <el-dialog
      v-model="editPurchaseVisible"
      title="编辑采购单"
      width="600px"
      align-center
      destroy-on-close
    >
      <el-form :model="editPurchaseForm" label-width="100px">
        <el-form-item label="采购编号">
          <el-input v-model="editPurchaseForm.purchaseNo" disabled />
        </el-form-item>
        <el-form-item label="关联销售单号">
          <el-input v-model="editPurchaseForm.salesOrderNo" placeholder="请输入销售订单号" />
        </el-form-item>
        <el-form-item label="商品名称">
          <el-input v-model="editPurchaseForm.goodsName" placeholder="请输入商品名称" />
        </el-form-item>
        <el-form-item label="SKU规格">
          <el-input v-model="editPurchaseForm.sku" placeholder="请输入SKU规格（可选）" />
        </el-form-item>
        <el-form-item label="数量">
          <el-input-number v-model="editPurchaseForm.quantity" :min="1" :max="9999" style="width: 100%" />
        </el-form-item>
        <el-form-item label="采购单价">
          <el-input-number v-model="editPurchaseForm.purchasePrice" :min="0" :precision="2" :step="0.01" style="width: 100%" />
        </el-form-item>
        <el-form-item label="采购平台">
          <el-select v-model="editPurchaseForm.platform" placeholder="请选择采购平台" style="width: 100%">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="阿里巴巴" value="1688" />
            <el-option label="抖音" value="douyin" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="editPurchaseForm.accountId" placeholder="请选择采购账号（可选）" style="width: 100%" clearable>
            <el-option v-for="acc in accountList.filter(a => a.platform === editPurchaseForm.platform && a.cookie_valid)" :key="acc.id" :label="acc.username" :value="acc.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购订单号">
          <el-input v-model="editPurchaseForm.platformOrderNo" placeholder="已发货后填入采购订单号（可选）" />
        </el-form-item>
        <el-form-item label="物流单号">
          <el-input v-model="editPurchaseForm.logisticsNo" placeholder="已发货后填入物流单号（可选）" />
        </el-form-item>
        <el-form-item label="物流公司">
          <el-input v-model="editPurchaseForm.logisticsCompany" placeholder="已发货后填入物流公司（可选）" />
        </el-form-item>
        <el-form-item label="货源链接">
          <el-input v-model="editPurchaseForm.sourceUrl" placeholder="请输入商品采购链接（可选）" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="editPurchaseForm.remark" type="textarea" :rows="2" placeholder="请输入备注（可选）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editPurchaseVisible = false">取消</el-button>
        <el-button type="primary" @click="handleEditPurchaseSubmit">保存修改</el-button>
      </template>
    </el-dialog>

    <!-- 手动添加采购单弹窗 -->
    <el-dialog
      v-model="addPurchaseVisible"
      title="手动添加采购单"
      width="600px"
      align-center
      destroy-on-close
    >
      <el-form :model="addPurchaseForm" label-width="100px">
        <el-form-item label="关联销售单号" required>
          <el-input v-model="addPurchaseForm.salesOrderNo" placeholder="请输入销售订单号" />
        </el-form-item>
        <el-form-item label="商品名称" required>
          <el-input v-model="addPurchaseForm.goodsName" placeholder="请输入商品名称" />
        </el-form-item>
        <el-form-item label="SKU规格">
          <el-input v-model="addPurchaseForm.sku" placeholder="请输入SKU规格（可选）" />
        </el-form-item>
        <el-form-item label="数量" required>
          <el-input-number v-model="addPurchaseForm.quantity" :min="1" :max="9999" style="width: 100%" />
        </el-form-item>
        <el-form-item label="采购单价">
          <el-input-number v-model="addPurchaseForm.purchasePrice" :min="0" :precision="2" :step="0.01" style="width: 100%" />
        </el-form-item>
        <el-form-item label="采购平台" required>
          <el-select v-model="addPurchaseForm.platform" placeholder="请选择采购平台" style="width: 100%">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="阿里巴巴" value="1688" />
            <el-option label="抖音" value="douyin" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="addPurchaseForm.accountId" placeholder="请选择采购账号（可选）" style="width: 100%" clearable>
            <el-option v-for="acc in accountList.filter(a => a.platform === addPurchaseForm.platform && a.cookie_valid)" :key="acc.id" :label="acc.username" :value="acc.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购订单号">
          <el-input v-model="addPurchaseForm.platformOrderNo" placeholder="已发货后填入物流单号（可选）" />
        </el-form-item>
        <el-form-item label="货源链接">
          <el-input v-model="addPurchaseForm.sourceUrl" placeholder="请输入商品采购链接（可选）" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="addPurchaseForm.remark" type="textarea" :rows="2" placeholder="请输入备注（可选）" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addPurchaseVisible = false">取消</el-button>
        <el-button type="primary" @click="handleAddPurchaseSubmit">确认添加</el-button>
      </template>
    </el-dialog>

    <!-- 批量导入对话框 -->
    <el-dialog v-model="importDialogVisible" title="批量导入采购订单" width="800px" :close-on-click-modal="false" @close="handleImportDialogClose">
      <el-steps :active="importStep - 1" align-center style="margin-bottom: 24px">
        <el-step title="下载模版" />
        <el-step title="上传文件" />
        <el-step title="预览校验" />
        <el-step title="导入结果" />
      </el-steps>

      <!-- 步骤1：下载模版 -->
      <div v-if="importStep === 1">
        <el-alert type="info" :closable="false" style="margin-bottom: 16px">
          <p>1. 下载导入模版，按格式填写采购订单数据</p>
          <p>2. 标 <span style="color:#f56c6c">*</span> 的列为必填项，其他为选填</p>
          <p>3. 采购账号必须填写系统中已存在的账号名称</p>
          <p>4. 采购平台支持中文：淘宝/天猫、拼多多、阿里巴巴、抖音</p>
        </el-alert>
        <el-table :data="importTemplateFields" border size="small" style="margin-bottom: 16px">
          <el-table-column prop="header" label="列名" width="140" />
          <el-table-column prop="required" label="必填" width="60" align="center">
            <template #default="{ row }">
              <span v-if="row.required" style="color:#f56c6c">*</span>
              <span v-else>-</span>
            </template>
          </el-table-column>
          <el-table-column prop="desc" label="说明" />
        </el-table>
        <div style="text-align: center">
          <el-button type="primary" @click="handleDownloadTemplate">
            <el-icon><Download /></el-icon> 下载导入模版
          </el-button>
          <el-button @click="importStep = 2">我已有模版，下一步</el-button>
        </div>
      </div>

      <!-- 步骤2：上传文件 -->
      <div v-if="importStep === 2">
        <el-upload
          ref="importUploadRef"
          drag
          :auto-upload="false"
          :limit="1"
          accept=".xlsx,.xls"
          :on-change="handleImportFileChange"
          :on-exceed="() => ElMessage.warning('只能上传一个文件')"
        >
          <el-icon :size="48" style="color: #c0c4cc"><Upload /></el-icon>
          <div style="margin-top: 8px">将 Excel 文件拖到此处，或 <em>点击上传</em></div>
          <template #tip>
            <div style="color: #909399; font-size: 12px">仅支持 .xlsx / .xls 文件，最多 200 条数据</div>
          </template>
        </el-upload>
        <div v-if="importParsing" style="text-align: center; margin-top: 16px">
          <el-icon class="is-loading"><Refresh /></el-icon> 正在解析文件...
        </div>
        <div style="text-align: center; margin-top: 16px">
          <el-button @click="importStep = 1">上一步</el-button>
        </div>
      </div>

      <!-- 步骤3：预览校验 -->
      <div v-if="importStep === 3">
        <el-alert :closable="false" style="margin-bottom: 12px">
          <span>共 <b>{{ importData.length }}</b> 条，</span>
          <span style="color: #67c23a">有效 <b>{{ importValidCount }}</b> 条，</span>
          <span style="color: #f56c6c">无效 <b>{{ importInvalidCount }}</b> 条</span>
        </el-alert>
        <el-table :data="importDataWithValidation" border size="small" max-height="400" :row-class-name="importRowClassName">
          <el-table-column type="index" label="#" width="50" />
          <el-table-column prop="purchase_no" label="采购编号" width="100">
            <template #default="{ row }">
              {{ row.purchase_no || '自动生成' }}
            </template>
          </el-table-column>
          <el-table-column prop="sales_order_no" label="销售关联单号" min-width="120" />
          <el-table-column prop="platform_order_no" label="采购订单号" min-width="140" />
          <el-table-column prop="account_name" label="采购账号" width="120" />
          <el-table-column prop="goods_name" label="商品名称" min-width="120" show-overflow-tooltip />
          <el-table-column prop="quantity" label="数量" width="60" align="center" />
          <el-table-column prop="purchase_price" label="采购单价" width="80" align="center" />
          <el-table-column prop="platform" label="平台" width="80" align="center" />
          <el-table-column prop="purchase_type" label="采购类型" width="90" align="center">
            <template #default="{ row }">
              {{ row.purchase_type === 'warehouse_in' ? '仓库进货' : row.purchase_type === 'warehouse' ? '仓库转发' : '三方代发' }}
            </template>
          </el-table-column>
          <el-table-column label="校验" width="80" align="center">
            <template #default="{ row }">
              <el-tag v-if="row._valid" type="success" size="small">通过</el-tag>
              <el-tag v-else type="danger" size="small">无效</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="_errors" label="错误原因" min-width="160">
            <template #default="{ row }">
              <span v-if="row._errors.length" style="color: #f56c6c; font-size: 12px">{{ row._errors.join('；') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="60" align="center">
            <template #default="{ $index }">
              <el-button type="danger" size="small" link @click="removeImportRow($index)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <div style="text-align: center; margin-top: 16px">
          <el-button @click="importStep = 2">上一步</el-button>
          <el-button type="primary" :disabled="importValidCount === 0" @click="handleConfirmImport">确认导入（{{ importValidCount }} 条）</el-button>
        </div>
      </div>

      <!-- 步骤4：导入结果 -->
      <div v-if="importStep === 4">
        <el-result v-if="importResult" :icon="importResult.fail_count === 0 ? 'success' : 'warning'" :title="importResult.fail_count === 0 ? '导入完成' : '导入完成（部分失败）'">
          <template #sub-title>
            <p>成功导入 <b style="color: #67c23a">{{ importResult.success_count }}</b> 条</p>
            <p v-if="importResult.fail_count > 0">失败 <b style="color: #f56c6c">{{ importResult.fail_count }}</b> 条</p>
          </template>
          <template #extra>
            <div v-if="importResult.errors && importResult.errors.length" style="text-align: left; max-height: 200px; overflow-y: auto; margin-bottom: 12px">
              <p v-for="(e, idx) in importResult.errors" :key="idx" style="font-size: 12px; color: #f56c6c">第 {{ e.row }} 行：{{ e.message }}</p>
            </div>
            <el-button type="primary" @click="handleImportDialogClose">关闭</el-button>
          </template>
        </el-result>
        <div v-if="importLoading" style="text-align: center; padding: 40px">
          <el-icon class="is-loading" :size="32"><Refresh /></el-icon>
          <p style="margin-top: 12px; color: #909399">正在导入，请稍候...</p>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Document,
  Search,
  Refresh,
  RefreshRight,
  Plus,
  Upload,
  Download
} from '@element-plus/icons-vue'
import { fetchPurchaseOrders, updatePurchaseStatus, syncPlatformOrders, syncSinglePurchaseOrder, fetchLogisticsTracking, createPurchaseOrder, fetchNextPurchaseNo, bindPlatformOrderNo, updatePurchaseOrder, batchImportPurchaseOrders, fetchRelatedSales, deletePurchaseOrder, checkPurchaseBinding } from '@/api/purchaseOrder'
import { fetchPurchaseAccounts, createPurchaseAccount, updatePurchaseAccount, deletePurchaseAccount } from '@/api/purchaseAccount'
import { searchInventory, createSkuBinding, quickCreateInventory, fetchWarehouses } from '@/api/warehouse'

// ==================== 常量配置 ====================

const statusOptions = [
  { label: '已下单', value: 'ordered' },
  { label: '待发货', value: 'pending' },
  { label: '已发货', value: 'shipped' },
  { label: '运输中', value: 'in_transit' },
  { label: '已签收', value: 'received' },
  { label: '已转发', value: 'forwarded' },
  { label: '已入库', value: 'stocked' },
  { label: '已完成', value: 'completed' },
  { label: '已拒收', value: 'rejected' },
  { label: '已取消', value: 'cancelled' }
]

// 批量导入 — 模版列定义
const importTemplateFields = [
  { header: '采购编号', required: false, desc: '采购编号，不填则系统自动生成' },
  { header: '销售关联单号', required: true, desc: '关联的销售订单号' },
  { header: '采购订单号', required: true, desc: '平台采购订单号' },
  { header: '采购账号', required: true, desc: '系统中已存在的采购账号名称' },
  { header: '商品名称', required: false, desc: '商品名称' },
  { header: '数量', required: false, desc: '采购数量，默认1' },
  { header: '采购单价', required: false, desc: '采购单价，默认0' },
  { header: '采购平台', required: false, desc: 'taobao/pinduoduo/1688/douyin 或中文：淘宝/拼多多/阿里巴巴/抖音' },
  { header: '采购类型', required: false, desc: '三方代发/仓库转发，不填默认三方代发' },
  { header: 'SKU', required: false, desc: '商品SKU' },
  { header: '来源链接', required: false, desc: '商品采购链接' },
  { header: '备注', required: false, desc: '备注信息' },
  { header: '收货人', required: false, desc: '收货人姓名' },
  { header: '收货电话', required: false, desc: '收货人电话' },
  { header: '收货地址', required: false, desc: '收货地址' }
]

// 中文表头 → 字段 key 映射
const HEADER_KEY_MAP = {
  '采购编号': 'purchase_no',
  '销售关联单号': 'sales_order_no',
  '采购订单号': 'platform_order_no',
  '采购账号': 'account_name',
  '商品名称': 'goods_name',
  '数量': 'quantity',
  '采购单价': 'purchase_price',
  '采购平台': 'platform',
  '采购类型': 'purchase_type',
  'SKU': 'sku',
  '来源链接': 'source_url',
  '备注': 'remark',
  '收货人': 'shipping_name',
  '收货电话': 'shipping_phone',
  '收货地址': 'shipping_address'
}

// 平台中文名映射
const PLATFORM_ALIAS = {
  '淘宝': 'taobao', '天猫': 'taobao', '淘宝/天猫': 'taobao',
  '拼多多': 'pinduoduo', '阿里巴巴': '1688', '抖音': 'douyin'
}
const VALID_PLATFORMS = ['taobao', 'pinduoduo', '1688', 'douyin']

// ==================== 状态 ====================

const loading = ref(false)
const syncing = ref(false)
const tableData = ref([])
const selectedAccount = ref('')

// 批量同步进度
const batchSyncProgress = reactive({
  active: false,
  current: 0,
  total: 0,
  orderNo: '',
  purchaseNo: '',
  status: '' // 'syncing' | 'done' | 'error'
})

// ==================== 批量导入 ====================

const importDialogVisible = ref(false)
const importStep = ref(1)
const importData = ref([])
const importParsing = ref(false)
const importLoading = ref(false)
const importResult = ref(null)
const importUploadRef = ref(null)

// 校验后的数据（computed）
const importDataWithValidation = computed(() => {
  const validAccountNames = new Set(accountList.value.map(a => (a.username || '').trim().toLowerCase()))
  return importData.value.map(row => {
    const errors = []
    if (!String(row.sales_order_no || '').trim()) errors.push('销售关联单号不能为空')
    if (!String(row.platform_order_no || '').trim()) errors.push('采购订单号不能为空')
    const accName = String(row.account_name || '').trim()
    if (!accName) errors.push('采购账号不能为空')
    else if (!validAccountNames.has(accName.toLowerCase())) errors.push(`采购账号"${accName}"不存在`)
    if (row.platform) {
      const p = String(row.platform).trim()
      const mapped = PLATFORM_ALIAS[p] || p
      if (!VALID_PLATFORMS.includes(mapped)) errors.push(`采购平台"${p}"无效`)
    }
    if (row.purchase_type) {
      const pt = String(row.purchase_type).trim()
      if (pt !== 'dropship' && pt !== 'warehouse' && pt !== 'warehouse_in' && pt !== '三方代发' && pt !== '仓库转发' && pt !== '仓库进货') {
        errors.push(`采购类型"${pt}"无效，请填：三方代发/仓库转发/仓库进货`)
      }
    }
    return { ...row, _valid: errors.length === 0, _errors: errors }
  })
})
const importValidCount = computed(() => importDataWithValidation.value.filter(r => r._valid).length)
const importInvalidCount = computed(() => importDataWithValidation.value.filter(r => !r._valid).length)
function importRowClassName({ row }) { return row._valid ? '' : 'import-row-invalid' }

// ==================== 账号管理 ====================

const accountManageVisible = ref(false)
const addAccountVisible = ref(false)
const editAccountVisible = ref(false)
const addAccountForm = reactive({ platform: '', account: '', password: '' })
const editAccountForm = reactive({ id: '', platform: '', username: '', password: '' })

const accountList = ref([])

// 从服务器加载采购账号列表
async function loadAccounts() {
  try {
    const data = await fetchPurchaseAccounts()
    const rawList = data.list || data || []
    accountList.value = rawList.map(a => ({
      ...a,
      username: a.account || a.username || '',
      status: a.online ? 'online' : 'offline',
      showPwd: false
    }))
    // 默认选中"全部账号"
    if (!selectedAccount.value) {
      selectedAccount.value = ''
    }
    // 同步到筛选条件
    filterForm.accountId = selectedAccount.value
  } catch (err) {
    console.warn('加载采购账号失败:', err.message)
  }
}

function handleAccountManage() {
  accountManageVisible.value = true
}

function handleAddAccount() {
  addAccountForm.platform = ''
  addAccountForm.account = ''
  addAccountForm.password = ''
  addAccountVisible.value = true
}

async function handleAddAccountSubmit() {
  if (!addAccountForm.platform) {
    ElMessage.warning('请选择平台')
    return
  }
  if (!addAccountForm.account) {
    ElMessage.warning('请输入登录账号')
    return
  }

  try {
    // 先在服务器创建账号记录（包含账号密码），获取ID
    const result = await createPurchaseAccount({
      platform: addAccountForm.platform,
      account: addAccountForm.account,
      password: addAccountForm.password
    })
    const accountId = result.id || result.insertId || Date.now().toString()

    // 通过 Electron 打开平台登录窗口
    if (window.electronAPI) {
      await window.electronAPI.invoke('open-purchase-login-window', {
        accountId: String(accountId),
        platform: addAccountForm.platform,
        account: addAccountForm.account,
        password: addAccountForm.password
      })
      ElMessage.success('已打开登录窗口，登录完成后关闭窗口即可自动保存')
    } else {
      ElMessage.warning('请在 Electron 环境中使用此功能')
    }

    addAccountVisible.value = false
    // 立即刷新列表，显示刚创建的账号（离线状态）
    await loadAccounts()
  } catch (err) {
    ElMessage.error('创建账号失败: ' + err.message)
  }
}

function handleLoginAccount(row) {
  if (window.electronAPI) {
    window.electronAPI.invoke('open-purchase-login-window', {
      accountId: String(row.id),
      platform: row.platform,
      account: row.username,
      password: row.password
    })
    ElMessage.info('已打开登录窗口')
  } else {
    ElMessage.warning('请在 Electron 环境中使用此功能')
  }
}

function handleReloginAccount(row) {
  if (window.electronAPI) {
    ElMessageBox.confirm(
      `确定清除账号 ${row.username} 的登录态并重新登录？清除后需要重新输入密码登录。`,
      '重新登录确认',
      { type: 'warning', confirmButtonText: '确定清除', cancelButtonText: '取消' }
    ).then(async () => {
      // 先清除 partition cookies
      await window.electronAPI.invoke('clear-purchase-cookies', { accountId: String(row.id) })
      // 再打开登录窗口（不带 account 参数，让主进程也清除 partition）
      window.electronAPI.invoke('open-purchase-login-window', {
        accountId: String(row.id),
        platform: row.platform
      })
      ElMessage.info('已清除登录态，请重新登录')
    }).catch(() => {})
  } else {
    ElMessage.warning('请在 Electron 环境中使用此功能')
  }
}

async function handleExportCookies(row) {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  try {
    const result = await window.electronAPI.invoke('export-purchase-cookies', {
      accountId: String(row.id),
      accountName: row.username,
      platform: row.platform
    })
    if (result.success) {
      ElMessage.success(`已导出 ${result.count} 条Cookie到文件`)
    } else if (result.error !== '用户取消') {
      ElMessage.error('导出失败: ' + result.error)
    }
  } catch (err) {
    ElMessage.error('导出失败: ' + err.message)
  }
}

async function handleImportCookies(row) {
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  try {
    const result = await window.electronAPI.invoke('import-purchase-cookies', {
      accountId: String(row.id),
      platform: row.platform
    })
    if (result.success) {
      ElMessage.success(`已导入 ${result.count} 条Cookie${result.failed > 0 ? `，${result.failed}条失败` : ''}`)
      // 导入后刷新账号列表
      await loadAccounts()
    } else if (result.error !== '用户取消') {
      ElMessage.error('导入失败: ' + result.error)
    }
  } catch (err) {
    ElMessage.error('导入失败: ' + err.message)
  }
}

function handleEditAccount(row) {
  editAccountForm.id = row.id
  editAccountForm.platform = row.platform
  editAccountForm.username = row.username
  editAccountForm.password = row.password
  editAccountVisible.value = true
}

async function handleEditAccountSubmit() {
  try {
    const submitData = {
      platform: editAccountForm.platform,
      account: editAccountForm.username,
      password: editAccountForm.password
    }
    await updatePurchaseAccount(editAccountForm.id, submitData)
    editAccountVisible.value = false
    ElMessage.success('账号信息已更新')
    await loadAccounts()
  } catch (err) {
    ElMessage.error('更新失败: ' + err.message)
  }
}

async function handleDeleteAccount(row) {
  try {
    await ElMessageBox.confirm(`确定删除账号 ${row.username}？`, '删除确认', { type: 'warning' })
    await deletePurchaseAccount(row.id)
    ElMessage.success('已删除')
    await loadAccounts()
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('删除失败: ' + (err.message || ''))
    }
  }
}

function handleImportAccount() {
  ElMessage.info('导入账号功能开发中')
}

// 监听 Electron 主进程登录成功事件，自动刷新列表
let unsubLoginSuccess = null
let unsubOrderCaptured = null
let unsubBatchSyncProgress = null

const filterForm = reactive({
  purchaseNo: '',
  logisticsNo: '',
  platformOrderNo: '',
  salesOrderNo: '',
  platform: '',
  purchaseType: '',
  status: '',
  accountId: ''
})

const pageInfo = reactive({
  page: 1,
  pageSize: 20,
  total: 0
})

// ==================== 工具方法 ====================

function platformLabel(val) {
  const map = { taobao: '淘宝/天猫', pinduoduo: '拼多多', '1688': '阿里巴巴', douyin: '抖音' }
  return map[val] || val || '--'
}

function platformTagType(val) {
  const map = { taobao: 'danger', pinduoduo: 'warning', '1688': '', douyin: 'success' }
  return map[val] || 'info'
}

function statusLabel(val) {
  const found = statusOptions.find(s => s.value === val)
  return found ? found.label : val || '--'
}

function statusTagType(val) {
  const map = { ordered: '', pending: 'info', shipped: '', in_transit: 'warning', received: 'success', forwarded: 'primary', stocked: 'success', completed: 'success', rejected: 'danger', cancelled: 'danger' }
  return map[val] || 'info'
}

function getSalesStatusClass(statusText) {
  if (!statusText) return 'status-default'
  if (statusText.includes('取消') || statusText.includes('关闭')) return 'status-danger'
  if (statusText.includes('完成') || statusText.includes('已出库')) return 'status-success'
  if (statusText.includes('待出库') || statusText.includes('待付款')) return 'status-warning'
  return 'status-default'
}

function getSalesStatusTagType(statusText) {
  if (!statusText) return 'info'
  if (statusText.includes('取消') || statusText.includes('关闭')) return 'danger'
  if (statusText.includes('完成') || statusText.includes('已出库')) return 'success'
  if (statusText.includes('待出库') || statusText.includes('待付款')) return 'warning'
  return 'info'
}

function copyText(text) {
  if (!text) return
  navigator.clipboard.writeText(text).then(() => {
    ElMessage.success('已复制: ' + text)
  }).catch(() => {
    ElMessage.error('复制失败')
  })
}

function formatTime(val) {
  if (!val) return '--'
  const d = new Date(val)
  if (isNaN(d.getTime())) return val
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ==================== 状态Tab ====================

// 各状态数量（从后端获取，精确且不受分页影响）
const statusCounts = ref({})

const statusTabs = computed(() => {
  const counts = statusCounts.value
  const all = Object.values(counts).reduce((sum, c) => sum + c, 0)
  return [
    { label: '全部', value: '', count: all },
    ...statusOptions.map(s => ({ label: s.label, value: s.value, count: counts[s.value] || 0 }))
  ]
})

function handleStatusTab(val) {
  filterForm.status = val
  pageInfo.page = 1
  loadData()
}

// ==================== 筛选与分页 ====================

// 后端已分页，tableData 即为当前页数据，无需前端再筛选
// pagedData 直接等于 tableData（后端已分页）
const pagedData = computed(() => tableData.value)

// 顶部采购账号下拉框切换时，同步到筛选条件并重新加载
watch(selectedAccount, (val) => {
  filterForm.accountId = val
  pageInfo.page = 1
  loadData()
})

function handleSearch() {
  pageInfo.page = 1
  loadData()
}

function handleReset() {
  filterForm.purchaseNo = ''
  filterForm.logisticsNo = ''
  filterForm.platformOrderNo = ''
  filterForm.salesOrderNo = ''
  filterForm.platform = ''
  filterForm.purchaseType = ''
  filterForm.status = ''
  pageInfo.page = 1
  loadData()
}

function handleSizeChange(val) {
  pageInfo.pageSize = val
  pageInfo.page = 1
  loadData()
}

function handlePageChange(val) {
  pageInfo.page = val
  loadData()
}

// ==================== 数据加载 ====================

async function loadData() {
  loading.value = true
  try {
    // 服务端分页+筛选：传递所有筛选参数给后端
    const params = {
      page: pageInfo.page,
      pageSize: pageInfo.pageSize
    }
    if (filterForm.status) params.status = filterForm.status
    if (filterForm.platform) params.platform = filterForm.platform
    if (filterForm.purchaseNo) params.purchaseNo = filterForm.purchaseNo
    if (filterForm.logisticsNo) params.logisticsNo = filterForm.logisticsNo
    if (filterForm.platformOrderNo) params.platformOrderNo = filterForm.platformOrderNo
    if (filterForm.salesOrderNo) params.salesOrderNo = filterForm.salesOrderNo
    if (filterForm.purchaseType) params.purchaseType = filterForm.purchaseType
    if (filterForm.accountId) params.accountId = filterForm.accountId

    const orderData = await fetchPurchaseOrders(params)

    // 后端 LEFT JOIN 已提供 account_name，无需前端映射
    tableData.value = orderData.list || []
    pageInfo.total = orderData.total || 0

    // 后端已将 statusCounts 合并到列表响应中，直接提取
    if (orderData.statusCounts) {
      statusCounts.value = orderData.statusCounts
    }
  } catch (err) {
    console.warn('加载采购订单失败:', err.message)
    tableData.value = []
  } finally {
    loading.value = false
  }
}

// ==================== 操作 ====================

const detailVisible = ref(false)
const currentRow = ref(null)

function handleViewDetail(row) {
  currentRow.value = row
  detailVisible.value = true
}

async function handleDeleteOrder(row) {
  try {
    await ElMessageBox.confirm(`确定删除采购订单 ${row.purchase_no || row.id} 吗？`, '删除订单', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await deletePurchaseOrder(row.id)
    ElMessage.success('订单已删除')
    loadData()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('删除失败: ' + (e.message || ''))
  }
}

// ==================== 物流轨迹 ====================

const logisticsVisible = ref(false)
const logisticsData = ref(null)
const logisticsLoading = ref(false)

// 关联销售商品信息（展开行模式）
const relatedSalesDataMap = reactive({})
const relatedSalesLoadingMap = reactive({})
const purchaseTableRef = ref()
const expandedRows = ref([])

async function loadRelatedSales(rowId) {
  relatedSalesLoadingMap[rowId] = true
  try {
    const data = await fetchRelatedSales(rowId)
    relatedSalesDataMap[rowId] = data
  } catch (e) {
    relatedSalesDataMap[rowId] = null
  } finally {
    relatedSalesLoadingMap[rowId] = false
  }
}

function handleExpandChange(row, expandedRowList) {
  // 手风琴模式：只保留当前展开行
  if (expandedRowList.includes(row)) {
    expandedRows.value = [row]
    loadRelatedSales(row.id)
  } else {
    expandedRows.value = []
  }
}

function handleRowClick(row) {
  if (!purchaseTableRef.value) return
  const isExpanded = expandedRows.value.some(r => r.id === row.id)
  if (isExpanded) {
    purchaseTableRef.value.toggleRowExpansion(row, false)
  } else {
    // 先折叠其他行
    expandedRows.value.forEach(r => {
      purchaseTableRef.value.toggleRowExpansion(r, false)
    })
    purchaseTableRef.value.toggleRowExpansion(row, true)
  }
}

async function handleViewLogistics(row) {
  logisticsVisible.value = true
  logisticsLoading.value = true
  logisticsData.value = null

  try {
    const data = await fetchLogisticsTracking(row.id)
    logisticsData.value = data
  } catch (err) {
    ElMessage.error('查询物流轨迹失败: ' + err.message)
  } finally {
    logisticsLoading.value = false
  }
}

async function handleConfirmReceive(row) {
  try {
    await ElMessageBox.confirm(`确认签收采购单 ${row.purchase_no}？`, '确认签收', { type: 'info' })
    await updatePurchaseStatus(row.id, { status: 'received' })
    row.status = 'received'
    ElMessage.success('已确认签收')
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('操作失败: ' + (err.message || ''))
    }
  }
}

async function handleComplete(row) {
  currentCompleteRow.value = row
  completeDialogVisible.value = true
}

async function handleConfirmComplete() {
  if (!currentCompleteRow.value) return
  try {
    await updatePurchaseStatus(currentCompleteRow.value.id, { status: 'completed' })
    currentCompleteRow.value.status = 'completed'
    completeDialogVisible.value = false
    ElMessage.success('已标记为完成')
  } catch (err) {
    ElMessage.error('操作失败: ' + (err.message || ''))
  }
}

async function handleCompleteMarkAfterSale() {
  if (!currentCompleteRow.value) return
  // 关闭完成对话框，打开售后标记对话框
  currentAftersaleRow.value = currentCompleteRow.value
  aftersaleForm.value.aftersale_status = 'pending_refund'
  aftersaleForm.value.aftersale_remark = currentCompleteRow.value.aftersale_remark || ''
  completeDialogVisible.value = false
  aftersaleDialogVisible.value = true
}

async function handleConfirmStock(row) {
  try {
    await ElMessageBox.confirm(`确认将采购单 ${row.purchase_no} 的商品入库？入库后将增加对应仓库库存。`, '确认入库', { type: 'warning' })
    await updatePurchaseStatus(row.id, { status: 'stocked' })
    row.status = 'stocked'
    ElMessage.success('已确认入库，库存已更新')
  } catch (err) {
    if (err !== 'cancel') {
      ElMessage.error('操作失败: ' + (err.message || ''))
    }
  }
}

function handleOutbound(row) {
  ElMessage.info('出库功能开发中')
}

// ==================== 收货 & 入库 & 绑定功能 ====================

const receiveDialogVisible = ref(false)
const currentReceiveRow = ref(null)

// 完成确认对话框
const completeDialogVisible = ref(false)
const currentCompleteRow = ref(null)

// 售后标记对话框
const aftersaleDialogVisible = ref(false)
const currentAftersaleRow = ref(null)
const aftersaleForm = ref({ aftersale_status: 'pending_refund', aftersale_remark: '' })

async function submitAftersale() {
  const row = currentAftersaleRow.value
  if (!row) return
  try {
    await updatePurchaseStatus(row.id, {
      aftersale_status: aftersaleForm.value.aftersale_status,
      aftersale_remark: aftersaleForm.value.aftersale_remark
    })
    row.aftersale_status = aftersaleForm.value.aftersale_status
    row.aftersale_remark = aftersaleForm.value.aftersale_remark
    aftersaleDialogVisible.value = false
    ElMessage.success('已标记售后')
  } catch (err) {
    ElMessage.error('标记售后失败: ' + (err.message || ''))
  }
}

// 云仓打单发货弹窗
const forwardDialogVisible = ref(false)
const forwardSalesData = ref(null)
const forwardLoading = ref(false)

const stockInDialogVisible = ref(false)
const stockInForm = reactive({
  inventoryInfo: null,
  actualQuantity: 1
})
const stockInLoading = ref(false)

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
const warehouseOptions = ref([])

// 加载仓库列表
async function loadWarehouses() {
  try {
    const res = await fetchWarehouses()
    warehouseOptions.value = res?.list || res || []
  } catch (err) {
    console.error('[收货] 加载仓库列表失败:', err.message)
  }
}

// 点击"收货"按钮
function handleReceive(row) {
  currentReceiveRow.value = row
  receiveDialogVisible.value = true
}

// 点击"标记售后"按钮 — 打开售后标记对话框
function handleMarkAfterSale() {
  const row = currentReceiveRow.value
  if (!row) return
  currentAftersaleRow.value = row
  aftersaleForm.value.aftersale_status = 'pending_refund'
  aftersaleForm.value.aftersale_remark = row.aftersale_remark || ''
  receiveDialogVisible.value = false
  aftersaleDialogVisible.value = true
}

// 点击"店铺发货"按钮 — 用店铺cookie打开京东出库页面并自动点击出库按钮
async function handleStoreShip() {
  const row = currentReceiveRow.value
  if (!row) return

  try {
    const salesData = await fetchRelatedSales(row.id)
    if (!salesData || !salesData.storeId) {
      ElMessage.warning('未找到关联销售单的店铺信息')
      return
    }
    if (salesData.storePlatform !== 'jd') {
      ElMessage.warning('店铺发货目前仅支持京东店铺')
      return
    }
    if (salesData.storeType !== 'pop') {
      ElMessage.warning('店铺发货仅支持POP店铺，供应商店铺不可用')
      return
    }

    await window.electronAPI.invoke('open-jd-outbound', {
      storeId: salesData.storeId,
      orderId: salesData.orderId || '',
      title: `店铺发货 - ${salesData.storeName || '京东'}`
    })

    receiveDialogVisible.value = false
  } catch (err) {
    ElMessage.error('店铺发货失败: ' + (err.message || ''))
  }
}

// 点击"云仓打单发货"按钮 — 加载关联销售订单并打开弹窗
async function handleForward() {
  const row = currentReceiveRow.value
  if (!row || row.purchase_type === 'warehouse_in') return

  // 关闭收货确认弹窗
  receiveDialogVisible.value = false

  // 加载关联销售订单信息
  forwardLoading.value = true
  forwardSalesData.value = null
  forwardDialogVisible.value = true
  try {
    const data = await fetchRelatedSales(row.id)
    forwardSalesData.value = data
  } catch (err) {
    ElMessage.error('获取关联销售订单失败')
  } finally {
    forwardLoading.value = false
  }
}

// 点击"我已转发" — 更新采购类型为已转发
async function handleConfirmForward() {
  const row = currentReceiveRow.value
  if (!row) return
  try {
    await updatePurchaseStatus(row.id, { status: 'forwarded' })
    row.status = 'forwarded'
    forwardDialogVisible.value = false
    ElMessage.success('已标记为转发完成')
  } catch (err) {
    ElMessage.error('操作失败: ' + (err.message || ''))
  }
}

// 点击"入库"按钮 — 检查绑定状态
async function handleStockIn() {
  receiveDialogVisible.value = false
  const row = currentReceiveRow.value
  if (!row) return

  try {
    const res = await checkPurchaseBinding(row.id)
    if (res && res.bound && res.inventory) {
      // 已绑定 — 直接入库
      stockInForm.inventoryInfo = res.inventory
      stockInForm.actualQuantity = row.quantity || 1
      stockInDialogVisible.value = true
    } else {
      // 未绑定 — 弹出绑定对话框
      await loadWarehouses()
      currentBindRow.value = {
        skuId: row.sku || '',
        productName: row.product_name || row.goods_name || '',
        productImage: row.goods_image || '',
        storeId: res?.storeId || '',
        purchaseOrderId: row.id
      }
      bindSearchKeyword.value = row.sku || ''
      bindSearchResults.value = []
      bindKeywords.value = extractKeywords(currentBindRow.value.productName)
      bindNewForm.warehouseId = ''
      bindNewForm.location = ''
      bindNewForm.batchNo = ''
      bindNewForm.supplier = ''
      bindDialogVisible.value = true
      // 自动搜索
      searchInventoryForBind()
    }
  } catch (err) {
    console.error('[收货] 检查绑定状态失败:', err)
    ElMessage.error('检查绑定状态失败: ' + (err.message || ''))
  }
}

// 确认入库
async function confirmStockIn() {
  const row = currentReceiveRow.value
  if (!row) return
  stockInLoading.value = true
  try {
    await updatePurchaseStatus(row.id, {
      status: 'stocked',
      actual_quantity: stockInForm.actualQuantity
    })
    row.status = 'stocked'
    stockInDialogVisible.value = false
    ElMessage.success('已确认入库，库存已更新')
  } catch (err) {
    ElMessage.error('入库失败: ' + (err.message || ''))
  } finally {
    stockInLoading.value = false
  }
}

// ============ 绑定功能（与 ProductSalesReport 一致） ============

function extractKeywords(name) {
  if (!name) return []
  const categoryWords = [
    '去油污', '重油污', '油污净', '油烟机', '抽油烟机', '清洁剂', '洗洁精', '洗衣液', '洗衣粉',
    '洗衣凝珠', '洗洁液', '去污渍', '除菌液', '除螨', '除甲醛', '消毒液', '消毒剂',
    '玻璃水', '洁厕灵', '洁厕剂', '管道疏通', '疏通剂', '除味剂', '空气清新',
    '洗碗机', '净水器', '滤水壶', '垃圾袋', '保鲜膜', '保鲜盒', '密封罐', '收纳盒',
    '洗发水', '护发素', '沐浴露', '洗面奶', '面霜', '精华液', '防晒霜', '身体乳',
    '牙膏', '牙刷', '漱口水', '纸巾', '湿巾', '卫生纸', '卫生巾', '纸尿裤',
    '大米', '食用油', '酱油', '醋', '料酒', '调味料', '方便面', '坚果', '牛奶', '酸奶',
    '充电宝', '充电器', '数据线', '耳机', '蓝牙耳机', '手机壳', '屏幕保护', '钢化膜',
    '鼠标', '键盘', '显示器', '路由器', '摄像头', '音箱', 'U盘', '存储卡',
    '垃圾桶', '拖把', '扫把', '抹布', '海绵', '水杯', '保温杯', '水壶', '电水壶',
    '雨伞', '挂钩', '置物架', '晾衣架', '熨斗', '电风扇', '加湿器', '取暖器',
    'T恤', '衬衫', '外套', '卫衣', '牛仔裤', '运动鞋', '拖鞋', '袜子',
    '泡沫', '喷雾', '免洗', '便携', '大容量', '高浓度', '浓缩', '进口', '有机',
    '植物', '天然', '免搓洗', '一擦净', '一喷净', '免拆洗', '免刷洗'
  ].sort((a, b) => b.length - a.length)

  const results = []
  const specRegex = /\d+(\.\d+)?\s*(ml|ML|Ml|L|l|g|G|kg|KG|Kg|oz|cm|mm|m|个|只|瓶|包|盒|罐|袋|支|件|套|箱|张|片|卷|双|条|块|粒|颗|贴)/g
  let specMatch
  while ((specMatch = specRegex.exec(name)) !== null) {
    results.push(specMatch[0].replace(/\s+/g, ''))
  }
  const matched = new Set()
  for (const word of categoryWords) {
    if (name.includes(word) && !matched.has(word)) {
      matched.add(word)
      results.push(word)
    }
  }
  if (results.length < 3) {
    const segments = name.split(/[\s·•\-—,，、|\/\\()（）\[\]【】0-9a-zA-Z]+/).filter(s => s.length >= 4)
    for (const seg of segments) {
      if (results.length >= 5) break
      for (let len = 4; len >= 2; len--) {
        for (let i = 0; i <= seg.length - len; i++) {
          const sub = seg.substring(i, i + len)
          if (matched.has(sub)) continue
          if (/^(居家|厨房|家用|商用|强力|高效|超值|新款|同款|专供|正品|包邮|神器|万能)$/.test(sub)) continue
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
  return [...new Set(results)].slice(0, 5)
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
    // 绑定成功后自动打开入库对话框
    stockInForm.inventoryInfo = {
      productName: invRow.productName,
      sku: invRow.sku,
      warehouseName: invRow.warehouseName,
      quantity: invRow.quantity
    }
    stockInForm.actualQuantity = currentReceiveRow.value?.quantity || 1
    stockInDialogVisible.value = true
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
    const res = await quickCreateInventory({
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
    // 新建绑定成功后自动打开入库对话框
    stockInForm.inventoryInfo = {
      productName: currentBindRow.value.productName,
      sku: currentBindRow.value.skuId,
      warehouseName: warehouseOptions.value.find(w => w.id === bindNewForm.warehouseId)?.name || '',
      quantity: 0
    }
    stockInForm.actualQuantity = currentReceiveRow.value?.quantity || 1
    stockInDialogVisible.value = true
  } catch (err) {
    ElMessage.error('新建失败：' + (err.message || '未知错误'))
  } finally {
    bindCreateLoading.value = false
  }
}

// ==================== 同步功能 ====================

const syncDialogVisible = ref(false)
const syncForm = reactive({
  platform: 'taobao',
  accountId: 'default'
})

// ==================== 手动添加采购单 ====================

const addPurchaseVisible = ref(false)
const addPurchaseForm = reactive({
  salesOrderNo: '',
  goodsName: '',
  sku: '',
  quantity: 1,
  purchasePrice: 0,
  platform: 'taobao',
  accountId: null,
  platformOrderNo: '',
  sourceUrl: '',
  remark: ''
})

// ==================== 编辑采购单 ====================

const editPurchaseVisible = ref(false)
const editPurchaseForm = reactive({
  id: '',
  purchaseNo: '',
  salesOrderNo: '',
  goodsName: '',
  sku: '',
  quantity: 1,
  purchasePrice: 0,
  platform: 'taobao',
  accountId: null,
  platformOrderNo: '',
  logisticsNo: '',
  logisticsCompany: '',
  sourceUrl: '',
  remark: ''
})

function handleEditPurchase(row) {
  editPurchaseForm.id = row.id
  editPurchaseForm.purchaseNo = row.purchase_no || ''
  editPurchaseForm.salesOrderNo = row.sales_order_no || ''
  editPurchaseForm.goodsName = row.goods_name || ''
  editPurchaseForm.sku = row.sku || ''
  editPurchaseForm.quantity = row.quantity || 1
  editPurchaseForm.purchasePrice = row.purchase_price || 0
  editPurchaseForm.platform = row.platform || 'taobao'
  editPurchaseForm.accountId = row.account_id || null
  editPurchaseForm.platformOrderNo = row.platform_order_no || ''
  editPurchaseForm.logisticsNo = row.logistics_no || ''
  editPurchaseForm.logisticsCompany = row.logistics_company || ''
  editPurchaseForm.sourceUrl = row.source_url || ''
  editPurchaseForm.remark = row.remark || ''
  editPurchaseVisible.value = true
}

async function handleEditPurchaseSubmit() {
  if (!editPurchaseForm.goodsName) {
    ElMessage.warning('请输入商品名称')
    return
  }
  if (!editPurchaseForm.platform) {
    ElMessage.warning('请选择采购平台')
    return
  }

  try {
    // 更新采购单基本信息
    await updatePurchaseOrder(editPurchaseForm.id, {
      sales_order_no: editPurchaseForm.salesOrderNo,
      goods_name: editPurchaseForm.goodsName,
      sku: editPurchaseForm.sku,
      quantity: editPurchaseForm.quantity,
      purchase_price: editPurchaseForm.purchasePrice,
      platform: editPurchaseForm.platform,
      account_id: editPurchaseForm.accountId,
      source_url: editPurchaseForm.sourceUrl,
      remark: editPurchaseForm.remark,
      logistics_no: editPurchaseForm.logisticsNo,
      logistics_company: editPurchaseForm.logisticsCompany
    })

    // 如果填了采购订单号且之前没有，则绑定
    if (editPurchaseForm.platformOrderNo && editPurchaseForm.platformOrderNo !== editPurchaseForm.purchaseNo) {
      await bindPlatformOrderNo(editPurchaseForm.purchaseNo, { platform_order_no: editPurchaseForm.platformOrderNo })
    }

    ElMessage.success('采购单已更新')
    editPurchaseVisible.value = false
    await loadData()
  } catch (err) {
    ElMessage.error('更新失败: ' + err.message)
  }
}

function handleAddPurchase() {
  addPurchaseForm.salesOrderNo = ''
  addPurchaseForm.goodsName = ''
  addPurchaseForm.sku = ''
  addPurchaseForm.quantity = 1
  addPurchaseForm.purchasePrice = 0
  addPurchaseForm.platform = 'taobao'
  addPurchaseForm.accountId = null
  addPurchaseForm.platformOrderNo = ''
  addPurchaseForm.sourceUrl = ''
  addPurchaseForm.remark = ''
  addPurchaseVisible.value = true
}

async function handleAddPurchaseSubmit() {
  // 表单验证
  if (!addPurchaseForm.salesOrderNo) {
    ElMessage.warning('请输入关联销售单号')
    return
  }
  if (!addPurchaseForm.goodsName) {
    ElMessage.warning('请输入商品名称')
    return
  }
  if (!addPurchaseForm.platform) {
    ElMessage.warning('请选择采购平台')
    return
  }

  try {
    // 先获取采购编号
    const nextNoData = await fetchNextPurchaseNo()
    const purchaseNo = nextNoData.purchase_no || String(Date.now()).slice(-6)

    // 创建采购单
    await createPurchaseOrder({
      purchase_no: purchaseNo,
      sales_order_no: addPurchaseForm.salesOrderNo,
      goods_name: addPurchaseForm.goodsName,
      sku: addPurchaseForm.sku,
      quantity: addPurchaseForm.quantity,
      purchase_price: addPurchaseForm.purchasePrice,
      platform: addPurchaseForm.platform,
      account_id: addPurchaseForm.accountId,
      source_url: addPurchaseForm.sourceUrl,
      remark: addPurchaseForm.remark
    })

    // 如果填了采购订单号，则绑定
    if (addPurchaseForm.platformOrderNo) {
      await bindPlatformOrderNo(purchaseNo, { platform_order_no: addPurchaseForm.platformOrderNo })
    }

    ElMessage.success('采购单添加成功')
    addPurchaseVisible.value = false
    await loadData()
  } catch (err) {
    ElMessage.error('添加失败: ' + err.message)
  }
}

function handleSync() {
  syncDialogVisible.value = true
}

async function handleSyncSubmit() {
  syncing.value = true
  // 重置进度
  batchSyncProgress.active = false
  batchSyncProgress.current = 0
  batchSyncProgress.total = 0
  batchSyncProgress.orderNo = ''
  batchSyncProgress.status = ''

  try {
    // 使用浏览器窗口方案同步
    if (window.electronAPI) {
      const result = await window.electronAPI.invoke('sync-purchase-orders-browser', {
        accountId: String(syncForm.accountId),
        platform: syncForm.platform
      })
      if (result.success) {
        // 逐个同步模式（淘宝/1688）
        if (result.syncedCount !== undefined) {
          const { syncedCount, errorCount, totalOrders } = result
          if (syncedCount > 0) {
            ElMessage.success(`同步完成，成功 ${syncedCount} 条${errorCount > 0 ? `，失败 ${errorCount} 条` : ''}`)
          } else if (errorCount > 0) {
            ElMessage.error(`同步失败 ${errorCount} 条订单`)
          } else {
            ElMessage.info(result.message || '没有需要同步的订单')
          }
        } else {
          // PDD 批量模式
          const count = result.matchedCount || 0
          const total = result.orders?.length || 0
          if (count > 0) {
            ElMessage.success(`同步完成，平台获取 ${total} 条订单，匹配更新 ${count} 条`)
          } else {
            ElMessage.info(`同步完成，平台获取 ${total} 条订单，暂无新的匹配`)
          }
        }
      } else {
        if (result.needsRelogin) {
          ElMessage.warning({
            message: '采购账号登录已过期，请在账号管理中重新登录',
            duration: 5000
          })
          await loadAccounts()
          accountManageVisible.value = true
        } else {
          const msg = result.message || '未知错误'
          ElMessage.error('同步失败: ' + msg)
          if (msg.includes('未登录')) {
            await loadAccounts()
            accountManageVisible.value = true
          }
        }
      }
    } else {
      // 降级到服务端方案
      const result = await syncPlatformOrders({
        platform: syncForm.platform,
        account_id: syncForm.accountId
      })
      const count = result?.matched_count || 0
      if (count > 0) {
        ElMessage.success(`同步完成，匹配到 ${count} 条采购订单已更新`)
      } else {
        ElMessage.info('同步完成，暂无新的匹配订单')
      }
    }
    syncDialogVisible.value = false
    await loadData()
    // 延迟隐藏进度条，让用户看到完成状态
    setTimeout(() => { batchSyncProgress.active = false }, 2000)
  } catch (err) {
    ElMessage.error('同步失败: ' + err.message)
    batchSyncProgress.active = false
  } finally {
    syncing.value = false
  }
}

// 单个订单同步
async function handleSyncSingle(row) {
  if (!row.platform || !row.platform_order_no) {
    ElMessage.warning('该订单没有平台信息或采购订单号')
    return
  }

  try {
    console.log('[Sync-Single] 订单信息:', {
      platform: row.platform,
      platform_order_no: row.platform_order_no,
      account_id: row.account_id,
      purchase_no: row.purchase_no
    })

    // 优先使用订单已关联的account_id
    let account = null
    if (row.account_id) {
      account = accountList.value.find(acc => acc.id === row.account_id)
      if (account) {
        console.log('[Sync-Single] 使用订单已关联的账号:', account)
      }
    }

    // 如果订单没有关联账号，查找匹配的采购账号（platform匹配）
    if (!account) {
      console.log('[Sync-Single] 订单未关联账号，开始查找匹配的账号')
      account = accountList.value.find(acc => acc.platform === row.platform)
    }

    if (!account) {
      ElMessage.warning(`系统中没有${platformLabel(row.platform)}采购账号，请先添加账号`)
      return
    }

    console.log('[Sync-Single] 最终使用账号:', account)

    const loading = ElMessage({
      message: `正在同步订单 ${row.platform_order_no}...`,
      type: 'info',
      duration: 0
    })

    try {
      // 优先使用浏览器窗口方案（不再有 SESSION_EXPIRED 问题）
      if (window.electronAPI) {
        const result = await window.electronAPI.invoke('sync-purchase-order-browser', {
          accountId: String(account.id),
          platformOrderNo: row.platform_order_no,
          platform: row.platform
        })

        if (result.success && result.orderInfo) {
          const dbResult = result.dbResult || {}
          const parts = []
          if (dbResult.status) parts.push(`状态: ${statusLabel(dbResult.status)}`)
          if (dbResult.logistics_no) parts.push(`物流单号: ${dbResult.logistics_no}`)
          if (dbResult.logistics_company) parts.push(`${dbResult.logistics_company}`)
          if (dbResult.goods_name) parts.push(`商品: ${dbResult.goods_name.substring(0, 20)}`)
          const message = parts.join(', ')
          ElMessage.success(`同步成功！${message || '无更新'}`)
        } else if (result.needsRelogin) {
          ElMessage.warning({
            message: '采购账号登录已过期，请在账号管理中重新登录',
            duration: 5000
          })
          await loadAccounts()
          accountManageVisible.value = true
          return
        } else {
          const msg = result.message || '未知错误'
          ElMessage.error('同步失败: ' + msg)
          // 未登录时自动打开账号管理
          if (msg.includes('未登录')) {
            await loadAccounts()
            accountManageVisible.value = true
          }
          return
        }
      } else {
        // 降级到服务端方案
        const result = await syncSinglePurchaseOrder({
          platform: row.platform,
          account_id: account.id,
          platform_order_no: row.platform_order_no
        })
        const parts = []
        if (result.status) parts.push(`状态: ${result.status}`)
        if (result.logistics_no) parts.push(`物流单号: ${result.logistics_no}`)
        if (result.logistics_company) parts.push(`${result.logistics_company}`)
        const message = parts.join(', ')
        ElMessage.success(`同步成功！${message || '无更新'}`)
      }
      await loadData()
    } finally {
      loading.close()
    }
  } catch (err) {
    console.error('[Sync-Single] 错误:', err)
    if (err.needsRelogin || err.code === 2 || (err.message && err.message.includes('会话已过期'))) {
      ElMessage.warning({
        message: '采购账号登录已过期，请在账号管理中重新登录',
        duration: 5000
      })
      await loadAccounts()
      accountManageVisible.value = true
    } else {
      ElMessage.error('同步失败: ' + err.message)
    }
  }
}

// ==================== 生命周期 ====================

onMounted(async () => {
  // 并行加载账号列表和订单数据（不再串行等待）
  // 服务器端 purchase_orders 查询已 LEFT JOIN account_name，前端只需补充匹配
  await Promise.all([loadAccounts(), loadData()])

  // 监听采购账号登录成功事件
  if (window.electronAPI) {
    unsubLoginSuccess = window.electronAPI.onUpdate('purchase-account-login-success', () => {
      loadAccounts()
    })
    // 监听采购单自动创建并绑定成功事件，刷新列表
    unsubOrderCaptured = window.electronAPI.onUpdate('purchase-order-captured', (data) => {
      if (data.success) {
        loadData()
      }
    })
    // 监听批量同步进度
    unsubBatchSyncProgress = window.electronAPI.onUpdate('batch-sync-progress', (data) => {
      batchSyncProgress.active = true
      batchSyncProgress.current = data.current
      batchSyncProgress.total = data.total
      batchSyncProgress.orderNo = data.orderNo || ''
      batchSyncProgress.purchaseNo = data.purchaseNo || ''
      batchSyncProgress.status = data.status || ''
    })
  }
})

onUnmounted(() => {
  if (unsubLoginSuccess) {
    unsubLoginSuccess()
    unsubLoginSuccess = null
  }
  if (unsubOrderCaptured) {
    unsubOrderCaptured()
    unsubOrderCaptured = null
  }
  if (unsubBatchSyncProgress) {
    unsubBatchSyncProgress()
    unsubBatchSyncProgress = null
  }
})

// ==================== 批量导入功能 ====================

function handleBatchImport() {
  importDialogVisible.value = true
  importStep.value = 1
  importData.value = []
  importParsing.value = false
  importLoading.value = false
  importResult.value = null
}

async function handleDownloadTemplate() {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  // Sheet1: 数据模版 — 表头带必填/选填标注
  const headers = importTemplateFields.map(f => `${f.header}（${f.required ? '必填' : '选填'}）`)
  const ws1 = XLSX.utils.aoa_to_sheet([headers])
  // 设置列宽
  ws1['!cols'] = headers.map(() => ({ wch: 18 }))
  XLSX.utils.book_append_sheet(wb, ws1, '采购订单导入')

  // Sheet2: 填写说明
  const instructions = [
    ['字段', '必填', '说明'],
    ['采购编号', '否', '采购编号，不填则系统自动生成'],
    ['销售关联单号', '是', '关联的销售订单号'],
    ['采购订单号', '是', '平台上的采购订单号'],
    ['采购账号', '是', '必须与系统中已有采购账号名称完全一致'],
    ['商品名称', '否', '商品名称'],
    ['数量', '否', '整数，默认1'],
    ['采购单价', '否', '数字，默认0'],
    ['采购平台', '否', '支持：taobao / pinduoduo / 1688 / douyin 或中文：淘宝/拼多多/阿里巴巴/抖音'],
    ['SKU', '否', '商品SKU规格'],
    ['来源链接', '否', '商品采购链接'],
    ['备注', '否', '备注信息'],
    ['收货人', '否', '收货人姓名'],
    ['收货电话', '否', '收货人电话'],
    ['收货地址', '否', '收货地址']
  ]
  const ws2 = XLSX.utils.aoa_to_sheet(instructions)
  ws2['!cols'] = [{ wch: 16 }, { wch: 6 }, { wch: 50 }]
  XLSX.utils.book_append_sheet(wb, ws2, '填写说明')

  XLSX.writeFile(wb, '采购订单导入模版.xlsx')
  ElMessage.success('模版已下载')
}

async function handleImportFileChange(file) {
  if (!file || !file.raw) return
  importParsing.value = true
  try {
    const XLSX = await import('xlsx')

    // 读取文件：使用FileReader获取Uint8Array，兼容性更好
    const fileData = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = e => resolve(new Uint8Array(e.target.result))
      reader.onerror = reject
      reader.readAsArrayBuffer(file.raw)
    })

    // 尝试多种方式读取workbook
    let workbook = null
    try { workbook = XLSX.read(fileData, { type: 'array' }) } catch (e) { /* ignore */ }
    if (!workbook) {
      try { workbook = XLSX.read(fileData, { type: 'buffer' }) } catch (e) { /* ignore */ }
    }
    if (!workbook) {
      ElMessage.error('无法解析该文件，请确认是有效的Excel文件（.xlsx或.xls）')
      importParsing.value = false
      return
    }

    // 修正sheet范围：部分Excel文件的!ref(dimension)未正确更新，导致sheet_to_json遗漏数据行
    function fixSheetRange(ws) {
      if (!ws || !ws['!ref']) return
      let maxR = 0, maxC = 0
      Object.keys(ws).forEach(key => {
        if (key[0] !== '!') {
          const addr = XLSX.utils.decode_cell(key)
          if (addr.r > maxR) maxR = addr.r
          if (addr.c > maxC) maxC = addr.c
        }
      })
      const range = XLSX.utils.decode_range(ws['!ref'])
      if (maxR > range.e.r || maxC > range.e.c) {
        range.e.r = Math.max(range.e.r, maxR)
        range.e.c = Math.max(range.e.c, maxC)
        ws['!ref'] = XLSX.utils.encode_range(range)
      }
    }

    // 遍历所有sheet，找到表头匹配且有数据行的sheet
    let sheetName = null
    let rows = null
    for (let i = 0; i < workbook.SheetNames.length; i++) {
      const name = workbook.SheetNames[i]
      const ws = workbook.Sheets[name]
      fixSheetRange(ws)
      const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false })

      // 调试：输出每个sheet的信息
      let cellCount = 0, maxRow = 0
      Object.keys(ws).forEach(k => { if (k[0] !== '!') { cellCount++; const a = XLSX.utils.decode_cell(k); if (a.r > maxRow) maxRow = a.r } })
      console.log(`[导入] Sheet${i}: "${name}", !ref=${ws['!ref']}, 单元格=${cellCount}, 最大行=${maxRow}, 解析行数=${sheetRows.length}`)
      if (sheetRows.length > 0) console.log(`[导入] 表头:`, sheetRows[0])

      if (sheetRows.length < 2) continue
      // 检查表头是否包含采购订单的关键字段
      const header = sheetRows[0].map(h => String(h || '').trim().replace(/（必填）|（选填）|\(必填\)|\(选填\)/g, '').trim())
      const hasSalesCol = header.includes('销售关联单号')
      const hasOrderCol = header.includes('采购订单号')
      if (hasSalesCol || hasOrderCol) {
        sheetName = name
        rows = sheetRows
        break
      }
    }

    // 如果仍未找到数据，尝试强制扩展sheet范围重新读取
    if (!rows || rows.length < 2) {
      console.log('[导入] 常规方式未找到数据，尝试强制扩展范围...')
      for (let i = 0; i < workbook.SheetNames.length; i++) {
        const ws = workbook.Sheets[workbook.SheetNames[i]]
        if (!ws || !ws['!ref']) continue
        const range = XLSX.utils.decode_range(ws['!ref'])
        // 强制扩展到10000行
        range.e.r = Math.max(range.e.r, 9999)
        ws['!ref'] = XLSX.utils.encode_range(range)
        const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false })
        console.log(`[导入] 强制扩展 Sheet${i}: "${workbook.SheetNames[i]}", 解析行数=${sheetRows.length}`)
        if (sheetRows.length > 0) console.log(`[导入] 强制扩展表头:`, sheetRows[0])
        if (sheetRows.length >= 2) {
          const header = sheetRows[0].map(h => String(h || '').trim().replace(/（必填）|（选填）|\(必填\)|\(选填\)/g, '').trim())
          if (header.includes('销售关联单号') || header.includes('采购订单号')) {
            sheetName = workbook.SheetNames[i]
            rows = sheetRows
            break
          }
        }
      }
    }

    if (!rows || rows.length < 2) {
      ElMessage.warning('文件中没有数据行，请确认数据填写在正确的sheet中')
      importParsing.value = false
      return
    }

    // 首行作为表头，建立列索引映射
    // 兼容带标注的表头，如 "销售关联单号（必填）" → 去掉括号标注后再匹配
    const headerRow = rows[0].map(h => String(h || '').trim())
    const colMap = {}
    for (let i = 0; i < headerRow.length; i++) {
      // 去掉表头中的（必填）/（选填）标注
      const cleaned = headerRow[i].replace(/（必填）|（选填）|\(必填\)|\(选填\)/g, '').trim()
      const key = HEADER_KEY_MAP[cleaned] || HEADER_KEY_MAP[headerRow[i]]
      if (key) colMap[key] = i
    }

    // 检查必填列是否存在
    const missingCols = []
    if (colMap.sales_order_no === undefined) missingCols.push('销售关联单号')
    if (colMap.platform_order_no === undefined) missingCols.push('采购订单号')
    if (colMap.account_name === undefined) missingCols.push('采购账号')
    if (missingCols.length) {
      ElMessage.error(`模版缺少必填列：${missingCols.join('、')}`)
      importParsing.value = false
      return
    }

    // 解析数据行
    const parsed = []
    for (let i = 1; i < rows.length && parsed.length < 200; i++) {
      const row = rows[i]
      if (!row || row.every(c => c === undefined || c === null || String(c).trim() === '')) continue
      const obj = {}
      for (const [key, colIdx] of Object.entries(colMap)) {
        obj[key] = row[colIdx] !== undefined && row[colIdx] !== null ? row[colIdx] : ''
      }
      parsed.push(obj)
    }

    if (parsed.length === 0) {
      ElMessage.warning('文件中没有有效数据行')
      importParsing.value = false
      return
    }

    importData.value = parsed
    importParsing.value = false
    importStep.value = 3
  } catch (err) {
    console.error('解析文件失败:', err)
    ElMessage.error('解析文件失败: ' + err.message)
    importParsing.value = false
  }
}

function removeImportRow(index) {
  importData.value.splice(index, 1)
}

async function handleConfirmImport() {
  const validRows = importDataWithValidation.value.filter(r => r._valid).map(r => {
    // 清理内部字段，映射平台中文名
    const obj = {}
    for (const [key, val] of Object.entries(r)) {
      if (!key.startsWith('_')) obj[key] = val
    }
    // 平台映射
    if (obj.platform) {
      const p = String(obj.platform).trim()
      if (PLATFORM_ALIAS[p]) obj.platform = PLATFORM_ALIAS[p]
    }
    // 采购类型映射
    if (obj.purchase_type) {
      const pt = String(obj.purchase_type).trim()
      if (pt === '三方代发') obj.purchase_type = 'dropship'
      else if (pt === '仓库转发') obj.purchase_type = 'warehouse'
      else if (pt === '仓库进货') obj.purchase_type = 'warehouse_in'
    }
    return obj
  })

  if (validRows.length === 0) return

  importLoading.value = true
  importStep.value = 4
  importResult.value = null

  try {
    const data = await batchImportPurchaseOrders(validRows)
    importResult.value = data
  } catch (err) {
    importResult.value = { success_count: 0, fail_count: validRows.length, errors: [{ row: '-', message: err.message }] }
  } finally {
    importLoading.value = false
  }
}

function handleImportDialogClose() {
  importDialogVisible.value = false
  // 如果有成功导入的数据，刷新列表
  if (importResult.value && importResult.value.success_count > 0) {
    loadData()
  }
}
</script>

<style scoped>
.batch-sync-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: -12px;
  margin-bottom: 16px;
  padding: 8px 12px;
  background: #f5f7fa;
  border-radius: 6px;
}
.batch-sync-text {
  font-size: 12px;
  color: #909399;
  white-space: nowrap;
}
.import-row-invalid {
  --el-table-tr-bg-color: #fef0f0;
}
.import-row-invalid:hover > td {
  --el-table-tr-bg-color: #fde2e2 !important;
}
.purchase-page {
  min-height: 100%;
  padding: 0;
}

.page-header-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  border-radius: 12px;
  padding: 24px 28px;
  margin-bottom: 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.header-icon {
  width: 44px;
  height: 44px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-title {
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  margin: 0;
}

.header-desc {
  color: rgba(255, 255, 255, 0.8);
  font-size: 13px;
  margin: 4px 0 0;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-account {
  display: flex;
  align-items: center;
  gap: 6px;
}

.account-label {
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  white-space: nowrap;
}

.filter-card {
  margin-bottom: 16px;
}

.filter-form :deep(.el-form-item) {
  margin-bottom: 12px;
}

.status-tabs {
  display: flex;
  gap: 4px;
  padding: 10px 16px;
  background: #fff;
  border-radius: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.status-tab-item {
  padding: 6px 14px;
  border-radius: 16px;
  font-size: 13px;
  color: #606266;
  cursor: pointer;
  transition: all 0.2s;
}

.status-tab-item:hover {
  background: #f0f2f5;
}

.status-tab-item.active {
  background: #409eff;
  color: #fff;
}

.tab-count {
  font-size: 12px;
  opacity: 0.8;
}

.table-card {
  margin-bottom: 16px;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.06);
}

.filter-card {
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,.04), 0 1px 2px rgba(0,0,0,.06);
}

/* 表格行hover效果：蓝色背景 + 左侧指示条 */
.table-card :deep(.el-table__row) {
  position: relative;
  transition: background-color 0.15s;
}
.table-card :deep(.el-table__row:hover > td.el-table__cell) {
  background-color: #f5f9ff !important;
}
.table-card :deep(.el-table__row:hover > td:first-child::before) {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: linear-gradient(180deg, #409eff, #66b1ff);
  border-radius: 0 2px 2px 0;
  z-index: 1;
}

.purchase-no {
  color: #e6a23c;
  font-weight: 600;
  font-size: 12px;
}

.sales-order-link {
  color: #409eff;
  font-size: 12px;
}

.text-muted {
  color: #c0c4cc;
}

/* 分页器紧凑样式 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding-top: 16px;
  border-top: 1px solid #f0f2f5;
  margin-top: 4px;
}
.pagination-wrap :deep(.el-pagination) {
  gap: 4px;
}
.pagination-wrap :deep(.el-pager li) {
  min-width: 28px;
  height: 28px;
  border-radius: 4px;
}

.platform-select-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.platform-card {
  border: 2px solid #e4e7ed;
  border-radius: 8px;
  padding: 20px 12px;
  text-align: center;
  cursor: pointer;
  transition: all 0.2s;
}

.platform-card:hover {
  border-color: #409eff;
  background: #f0f7ff;
}

.platform-card.active {
  border-color: #409eff;
  background: #ecf5ff;
}

.platform-card-name {
  display: block;
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 4px;
}

.platform-card-desc {
  display: block;
  font-size: 12px;
  color: #909399;
}

/* ===== 表格单元格样式（参考截图风格） ===== */
.cell-purchase-no {
  color: #e6a23c;
  font-weight: 600;
  font-size: 13px;
}

.cell-order-no {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  color: #606266;
}

.cell-logistics-no {
  color: var(--el-color-primary);
  cursor: pointer;
  &:hover {
    text-decoration: underline;
  }
}

.cell-logistics-company {
  font-size: 11px;
  color: #909399;
  margin-top: 2px;
}

.logistics-header {
  display: flex;
  align-items: center;
  font-size: 13px;
  color: #303133;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #ebeef5;
}
.logistics-header-sep {
  color: #dcdfe6;
  margin: 0 8px;
}

.logistics-list {
  max-height: 400px;
  overflow-y: auto;
}

.logistics-item {
  display: flex;
  align-items: flex-start;
  padding: 6px 0;
  position: relative;
}

.logistics-item-latest .logistics-item-text {
  color: #303133;
  font-weight: 500;
}

.logistics-item-time {
  width: 90px;
  flex-shrink: 0;
  font-size: 12px;
  color: #909399;
  text-align: right;
  padding-right: 12px;
  line-height: 20px;
}

.logistics-item-latest .logistics-item-time {
  color: #0bbd87;
}

.logistics-item-dot {
  width: 14px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
}

.logistics-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e4e7ed;
  flex-shrink: 0;
  margin-top: 6px;
}

.logistics-dot-active {
  background: #0bbd87;
  width: 10px;
  height: 10px;
  margin-top: 5px;
}

.logistics-line {
  width: 1px;
  flex: 1;
  min-height: 14px;
  background: #e4e7ed;
  margin-top: 4px;
}

.logistics-item-text {
  flex: 1;
  font-size: 13px;
  color: #606266;
  line-height: 20px;
  padding-left: 8px;
}

.cell-empty {
  color: #c0c4cc;
  font-size: 12px;
}

.cell-price {
  color: #f56c6c;
  font-weight: 600;
  font-size: 13px;
}

.cell-platform {
  font-size: 12px;
  color: #606266;
}

.cell-warehouse {
  font-size: 11px;
  color: #909399;
  margin-top: 2px;
}

.cell-time {
  font-size: 12px;
  color: #909399;
}

.cell-product {
  display: flex;
  align-items: center;
  gap: 10px;
}

.cell-product-img {
  width: 40px;
  height: 40px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid #f0f0f0;
}

.cell-product-img .el-image {
  width: 100%;
  height: 100%;
}

.cell-product-img-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
  color: #c0c4cc;
  font-size: 11px;
}

.cell-product-name {
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  font-size: 13px;
  color: #303133;
  line-height: 1.4;
}

/* 订单状态标签：圆点+文字（参考截图2风格） */
.cell-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 10px;
  border-radius: 12px;
}

.cell-status .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.cell-status.status-ordered { color: #409eff; background: #ecf5ff; }
.cell-status.status-ordered .status-dot { background: #409eff; }

.cell-status.status-pending { color: #909399; background: #f4f4f5; }
.cell-status.status-pending .status-dot { background: #909399; }

.cell-status.status-shipped { color: #409eff; background: #ecf5ff; }
.cell-status.status-shipped .status-dot { background: #409eff; }

.cell-status.status-in_transit { color: #e6a23c; background: #fdf6ec; }
.cell-status.status-in_transit .status-dot { background: #e6a23c; }

.cell-status.status-received { color: #67c23a; background: #f0f9eb; }
.cell-status.status-received .status-dot { background: #67c23a; }

.cell-status.status-stocked { color: #67c23a; background: #f0f9eb; }
.cell-status.status-stocked .status-dot { background: #67c23a; }

.cell-status.status-cancelled { color: #f56c6c; background: #fef0f0; }
.cell-status.status-cancelled .status-dot { background: #f56c6c; }

.cell-status.status-forwarded { color: #409eff; background: #ecf5ff; }
.cell-status.status-forwarded .status-dot { background: #409eff; }

/* ===== 展开行：关联销售商品信息 ===== */

/* 隐藏展开箭头列 */
:deep(.el-table__expand-column .cell) {
  display: none;
}
:deep(.el-table__expand-column) {
  width: 0 !important;
  min-width: 0 !important;
  padding: 0 !important;
}
:deep(th.el-table__expand-column) {
  width: 0 !important;
  min-width: 0 !important;
  padding: 0 !important;
  border-right: none !important;
}

/* 展开行覆盖固定列空白 */
:deep(.el-table__expanded-cell) {
  padding: 0 !important;
}
:deep(.el-table__expanded-cell .cell) {
  padding: 0 !important;
}

/* 展开面板整体 */
.expand-panel {
  padding: 10px 20px 12px;
  background: #fafbfc;
  border-top: 1px solid #f0f2f5;
}

/* 标题行：关联销售订单 */
.expand-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

.expand-header-dot {
  width: 3px;
  height: 14px;
  background: #409eff;
  border-radius: 2px;
}

.expand-header-title {
  font-size: 12px;
  font-weight: 600;
  color: #606266;
  letter-spacing: 0.3px;
}

/* 加载状态 */
.expand-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px 0;
  color: #909399;
  font-size: 13px;
}

/* 空状态 */
.expand-empty {
  text-align: center;
  padding: 16px 0;
  color: #c0c4cc;
  font-size: 13px;
}

/* 单行布局：标签 + 分隔线 + 商品卡片 */
.expand-row {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-x: auto;
}

.expand-row::-webkit-scrollbar { height: 4px; }
.expand-row::-webkit-scrollbar-track { background: transparent; }
.expand-row::-webkit-scrollbar-thumb { background: #d0d3d8; border-radius: 2px; }

/* 信息标签 */
.expand-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
  border: 1px solid #e4e7ed;
  background: #fff;
  color: #606266;
}

.expand-tag svg { flex-shrink: 0; }

.expand-tag.store-tag {
  color: #303133;
  font-weight: 500;
}
.expand-tag.store-tag svg { color: #909399; }

.expand-tag.warehouse-tag {
  color: #e6a23c;
  font-size: 11px;
  font-weight: 500;
}
.expand-tag.warehouse-tag svg { color: #e6a23c; }

.expand-tag.order-tag {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  color: #409eff;
  background: #ecf5ff;
  border-color: #d9ecff;
}

.expand-tag.copyable {
  cursor: pointer;
  user-select: none;
  transition: all .15s;
}
.expand-tag.copyable:hover {
  background: #d9ecff;
  border-color: #b3d8ff;
}
.expand-tag.copyable:active {
  transform: scale(0.97);
}

.expand-tag.status-tag {
  font-weight: 500;
  gap: 6px;
}

/* 状态圆点 */
.expand-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.expand-tag.status-danger { color: #f56c6c; background: #fef0f0; border-color: #fbc4c4; }
.expand-tag.status-danger .expand-status-dot { background: #f56c6c; }
.expand-tag.status-success { color: #67c23a; background: #f0f9eb; border-color: #c2e7b0; }
.expand-tag.status-success .expand-status-dot { background: #67c23a; }
.expand-tag.status-warning { color: #e6a23c; background: #fdf6ec; border-color: #f5dab1; }
.expand-tag.status-warning .expand-status-dot { background: #e6a23c; }
.expand-tag.status-default { color: #909399; background: #f4f4f5; border-color: #d3d4d6; }
.expand-tag.status-default .expand-status-dot { background: #909399; }

/* 分隔线 */
.expand-divider {
  width: 1px;
  height: 24px;
  background: #dcdfe6;
  flex-shrink: 0;
  margin: 0 4px;
}

/* 商品项：图片 + 标题 + 价格 + 数量 单行排列 */
.expand-product-item {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  max-width: 420px;
  min-width: 0;
}

/* 商品图片 */
.expand-product-img {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid #f0f0f0;
}

.expand-product-img .el-image {
  width: 100%;
  height: 100%;
}

.expand-product-img-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
}

.expand-product-name {
  font-size: 12px;
  color: #303133;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 525px;
}

.expand-product-price {
  font-size: 12px;
  color: #f56c6c;
  font-weight: 600;
  white-space: nowrap;
}

/* 收货确认弹窗 */
.receive-confirm-content {
  text-align: left;
  padding: 16px;
  background: #f8f9fb;
  border-radius: 10px;
}
.receive-confirm-text {
  font-size: 14px;
  line-height: 1.8;
  color: #303133;
  margin: 0;
}
.receive-confirm-type {
  color: #409eff;
  font-weight: 600;
}
.receive-confirm-warehouse {
  color: #e6a23c;
  font-weight: 600;
}
.receive-confirm-sales {
  color: #f56c6c;
  font-weight: 600;
}
.receive-confirm-footer {
  display: flex;
  justify-content: flex-start;
  gap: 12px;
}

/* 云仓打单发货弹窗 */
.forward-content {
  min-height: 120px;
}
.forward-summary {
  background: #f8f9fb;
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 14px;
}
.forward-summary-row {
  display: flex;
  align-items: center;
  padding: 5px 0;
}
.forward-summary-row:last-child {
  padding-bottom: 0;
}
.forward-label {
  width: 80px;
  flex-shrink: 0;
  font-size: 13px;
  color: #909399;
}
.forward-value {
  font-size: 13px;
  color: #303133;
  min-width: 0;
}
.forward-order-no {
  font-family: 'SF Mono', 'Consolas', monospace;
  font-size: 13px;
  letter-spacing: 0.3px;
}
.forward-warehouse {
  color: #e6a23c;
  font-weight: 500;
}
.forward-goods-title {
  font-size: 13px;
  color: #606266;
  font-weight: 500;
  margin-bottom: 10px;
}
.forward-goods-list {
  background: #fafafa;
  border-radius: 8px;
  padding: 10px 12px;
}
.forward-product-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #f0f1f3;
}
.forward-product-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.forward-product-item:first-child {
  padding-top: 0;
}
.forward-product-img {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
  border: 1px solid #ebeef5;
  background: #fff;
}
.forward-product-img-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
}
.forward-product-info {
  flex: 1;
  min-width: 0;
}
.forward-product-name {
  font-size: 13px;
  color: #303133;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.forward-product-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
}
.forward-product-price {
  font-size: 14px;
  color: #f56c6c;
  font-weight: 600;
}
.forward-product-qty {
  font-size: 12px;
  color: #909399;
}
.forward-empty {
  text-align: center;
  color: #c0c4cc;
  padding: 40px 0;
  font-size: 14px;
}

.expand-product-qty {
  font-size: 11px;
  color: #909399;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ============ 绑定对话框样式 ============ */
.bind-sku-info {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  background: #f5f7fa;
  border-radius: 8px;
  margin-bottom: 12px;
}

.bind-sku-detail {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.8;
  color: #303133;
  overflow: hidden;
}

.bind-sku-detail div {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bind-keywords-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.bind-keywords-label {
  font-size: 12px;
  color: #909399;
  flex-shrink: 0;
}

.bind-keyword-tag {
  cursor: pointer;
  transition: all 0.2s;
}

.bind-keyword-tag:hover {
  color: #409eff;
  border-color: #409eff;
}

.bind-search-section {
  margin-bottom: 8px;
}

.bind-create-section {
  margin-top: 4px;
}
</style>
