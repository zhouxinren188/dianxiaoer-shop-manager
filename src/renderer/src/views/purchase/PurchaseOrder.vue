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

    <!-- 筛选区 -->
    <el-card class="filter-card" shadow="never">
      <el-form :model="filterForm" inline class="filter-form">
        <el-form-item label="采购编号">
          <el-input v-model="filterForm.purchaseNo" placeholder="请输入采购编号" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="采购订单号">
          <el-input v-model="filterForm.platformOrderNo" placeholder="请输入采购订单号" clearable style="width: 180px" />
        </el-form-item>
        <el-form-item label="关联销售单号">
          <el-input v-model="filterForm.salesOrderNo" placeholder="请输入销售单号" clearable style="width: 160px" />
        </el-form-item>
        <el-form-item label="采购平台">
          <el-select v-model="filterForm.platform" placeholder="全部" clearable style="width: 130px">
            <el-option label="淘宝/天猫" value="taobao" />
            <el-option label="拼多多" value="pinduoduo" />
            <el-option label="1688" value="1688" />
          </el-select>
        </el-form-item>
        <el-form-item label="采购状态">
          <el-select v-model="filterForm.status" placeholder="全部" clearable style="width: 130px">
            <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
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
        :data="pagedData"
        stripe
        border
        v-loading="loading"
        :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }"
        row-key="id"
      >
        <el-table-column prop="purchase_no" label="采购编号" width="160" align="center">
          <template #default="{ row }">
            <span class="purchase-no">{{ row.purchase_no }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="account_name" label="采购账号" width="140" align="center">
          <template #default="{ row }">
            <span v-if="row.account_name">{{ row.account_name }}</span>
            <span v-else class="text-muted">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="platform_order_no" label="采购订单号" width="180" align="center">
          <template #default="{ row }">
            <span v-if="row.platform_order_no">{{ row.platform_order_no }}</span>
            <el-tag v-else type="info" size="small">未绑定</el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="goods_name" label="商品信息" min-width="260">
          <template #default="{ row }">
            <div style="display:flex;align-items:center;gap:10px;">
              <el-image v-if="row.goods_image" :src="row.goods_image"
                style="width:50px;height:50px;border-radius:6px;flex-shrink:0;"
                fit="cover" :preview-src-list="[row.goods_image]" preview-teleported />
              <div v-else style="width:50px;height:50px;border-radius:6px;flex-shrink:0;background:#f5f7fa;display:flex;align-items:center;justify-content:center;">
                <span style="color:#c0c4cc;font-size:11px;">无图</span>
              </div>
              <span style="overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">{{ row.goods_name }}</span>
            </div>
          </template>
        </el-table-column>

        <el-table-column prop="quantity" label="数量" width="70" align="center" />

        <el-table-column prop="purchase_price" label="采购单价" width="100" align="right">
          <template #default="{ row }">
            <span v-if="row.purchase_price" style="color: #f56c6c; font-weight: 600">¥{{ Number(row.purchase_price).toFixed(2) }}</span>
            <span v-else class="text-muted">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="platform" label="采购平台" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="platformTagType(row.platform)" size="small" effect="plain">{{ platformLabel(row.platform) }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="sales_order_no" label="关联销售单号" width="160" align="center">
          <template #default="{ row }">
            <span class="sales-order-link">{{ row.sales_order_no }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="status" label="采购状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">{{ statusLabel(row.status) }}</el-tag>
          </template>
        </el-table-column>

        <el-table-column prop="logistics_no" label="物流单号" width="200" align="center">
          <template #default="{ row }">
            <div v-if="row.logistics_no" style="display:flex;align-items:center;gap:6px;justify-content:center">
              <span>{{ row.logistics_no }}</span>
              <el-button link type="primary" size="small" @click="handleViewLogistics(row)">
                查看轨迹
              </el-button>
            </div>
            <span v-else class="text-muted">--</span>
          </template>
        </el-table-column>

        <el-table-column prop="created_at" label="创建时间" width="160" align="center">
          <template #default="{ row }">
            <span>{{ formatTime(row.created_at) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="300" align="center" fixed="right">
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
            <el-button v-if="row.status === 'received'" link type="success" size="small" @click="handleConfirmStock(row)">
              确认入库
            </el-button>
            <el-button v-if="row.status === 'stocked'" link type="warning" size="small" @click="handleOutbound(row)">
              出库
            </el-button>
            <el-button link type="primary" size="small" @click="handleViewDetail(row)">
              详情
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
          <el-descriptions-item label="关联销售单号">{{ currentRow.sales_order_no }}</el-descriptions-item>
          <el-descriptions-item label="采购状态">
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
      width="600px"
      align-center
    >
      <div v-if="logisticsData" class="logistics-container">
        <el-descriptions :column="2" border size="small" style="margin-bottom: 20px">
          <el-descriptions-item label="物流公司">{{ logisticsData.company || '--' }}</el-descriptions-item>
          <el-descriptions-item label="物流单号">{{ logisticsData.tracking_no || '--' }}</el-descriptions-item>
          <el-descriptions-item label="数据来源">
            <el-tag size="small" :type="logisticsData.source === 'express100' ? 'success' : 'primary'">
              {{ logisticsData.source === 'taobao' ? '淘宝' : logisticsData.source === '1688' ? '1688' : logisticsData.source === 'pinduoduo' ? '拼多多' : '快递100' }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>

        <el-timeline v-if="logisticsData.tracks && logisticsData.tracks.length > 0">
          <el-timeline-item
            v-for="(track, index) in logisticsData.tracks"
            :key="index"
            :timestamp="formatTime(track.time || track.timestamp)"
            placement="top"
            :color="index === 0 ? '#0bbd87' : '#e4e7ed'"
          >
            <el-card>
              <p style="margin: 0; font-size: 14px">{{ track.context || track.desc || track.message }}</p>
            </el-card>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无物流轨迹信息" />
      </div>
      <div v-else v-loading="logisticsLoading" style="min-height: 200px"></div>
    </el-dialog>

    <!-- 同步采购订单弹窗 -->
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
          <el-radio-group v-model="syncForm.platform">
            <el-radio value="taobao">淘宝/天猫</el-radio>
            <el-radio value="pinduoduo">拼多多</el-radio>
            <el-radio value="1688">1688</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="采购账号">
          <el-select v-model="syncForm.accountId" placeholder="请选择采购账号" style="width: 100%">
            <el-option v-for="acc in accountList" :key="acc.id" :label="acc.username || '未命名'" :value="acc.id" />
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
        <el-button type="primary" :disabled="!addAccountForm.platform" @click="handleAddAccountSubmit">前往登录</el-button>
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
        <el-table-column label="操作" width="180" align="center">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="handleLoginAccount(row)">登录</el-button>
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
            <el-option label="1688" value="1688" />
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
            <el-option label="1688" value="1688" />
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
  Plus
} from '@element-plus/icons-vue'
import { fetchPurchaseOrders, updatePurchaseStatus, syncPlatformOrders, syncSinglePurchaseOrder, fetchLogisticsTracking, createPurchaseOrder, fetchNextPurchaseNo, bindPlatformOrderNo, updatePurchaseOrder } from '@/api/purchaseOrder'
import { fetchPurchaseAccounts, createPurchaseAccount, updatePurchaseAccount, deletePurchaseAccount } from '@/api/purchaseAccount'

// ==================== 常量配置 ====================

const statusOptions = [
  { label: '待发货', value: 'pending' },
  { label: '已发货', value: 'shipped' },
  { label: '运输中', value: 'in_transit' },
  { label: '已签收', value: 'received' },
  { label: '已入库', value: 'stocked' }
]

// ==================== 状态 ====================

const loading = ref(false)
const syncing = ref(false)
const tableData = ref([])
const selectedAccount = ref('')

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
    accountList.value = (data.list || data || []).map(a => ({
      ...a,
      username: a.account || a.username || '',
      status: a.online ? 'online' : 'offline',
      showPwd: false
    }))
    // 自动选中第一个在线账号
    if (!selectedAccount.value && accountList.value.length > 0) {
      const onlineAcc = accountList.value.find(a => a.status === 'online')
      selectedAccount.value = (onlineAcc || accountList.value[0]).id
    }
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
        platform: addAccountForm.platform
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

function handleEditAccount(row) {
  editAccountForm.id = row.id
  editAccountForm.platform = row.platform
  editAccountForm.username = row.username
  editAccountForm.password = row.password
  editAccountVisible.value = true
}

async function handleEditAccountSubmit() {
  try {
    await updatePurchaseAccount(editAccountForm.id, {
      platform: editAccountForm.platform,
      account: editAccountForm.username,
      password: editAccountForm.password
    })
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

const filterForm = reactive({
  purchaseNo: '',
  platformOrderNo: '',
  salesOrderNo: '',
  platform: '',
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
  const map = { taobao: '淘宝/天猫', pinduoduo: '拼多多', '1688': '1688', douyin: '抖音' }
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
  const map = { pending: 'info', shipped: '', in_transit: 'warning', received: 'success', stocked: 'success' }
  return map[val] || 'info'
}

function formatTime(val) {
  if (!val) return '--'
  const d = new Date(val)
  if (isNaN(d.getTime())) return val
  return d.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ==================== 状态Tab ====================

const statusTabs = computed(() => {
  const all = tableData.value.length
  const counts = {}
  for (const row of tableData.value) {
    if (row.status) {
      counts[row.status] = (counts[row.status] || 0) + 1
    }
  }
  return [
    { label: '全部', value: '', count: all },
    ...statusOptions.map(s => ({ label: s.label, value: s.value, count: counts[s.value] || 0 }))
  ]
})

function handleStatusTab(val) {
  filterForm.status = val
  pageInfo.page = 1
}

// ==================== 筛选与分页 ====================

const filteredData = computed(() => {
  let data = tableData.value

  if (filterForm.purchaseNo) {
    data = data.filter(r => r.purchase_no && r.purchase_no.includes(filterForm.purchaseNo))
  }
  if (filterForm.platformOrderNo) {
    data = data.filter(r => r.platform_order_no && r.platform_order_no.includes(filterForm.platformOrderNo))
  }
  if (filterForm.salesOrderNo) {
    data = data.filter(r => r.sales_order_no && r.sales_order_no.includes(filterForm.salesOrderNo))
  }
  if (filterForm.platform) {
    data = data.filter(r => r.platform === filterForm.platform)
  }
  if (filterForm.status) {
    data = data.filter(r => r.status === filterForm.status)
  }
  if (filterForm.accountId) {
    data = data.filter(r => r.account_id === filterForm.accountId)
  }

  return data
})

// 通过 watch 更新分页总数，避免在 computed 内产生响应式副作用（会导致 Vue 调度器递归更新，UI冻结）
watch(filteredData, (data) => {
  pageInfo.total = data.length
}, { immediate: true })

const pagedData = computed(() => {
  const start = (pageInfo.page - 1) * pageInfo.pageSize
  return filteredData.value.slice(start, start + pageInfo.pageSize)
})

function handleSearch() {
  pageInfo.page = 1
}

function handleReset() {
  filterForm.purchaseNo = ''
  filterForm.platformOrderNo = ''
  filterForm.salesOrderNo = ''
  filterForm.platform = ''
  filterForm.status = ''
  pageInfo.page = 1
}

function handleSizeChange(val) {
  pageInfo.pageSize = val
}

function handlePageChange(val) {
  pageInfo.page = val
}

// ==================== 数据加载 ====================

async function loadData() {
  loading.value = true
  try {
    const data = await fetchPurchaseOrders({ pageSize: 500 })
    const orders = data.list || data || []
    
    // 为每个订单填充account_name
    tableData.value = orders.map(order => {
      const account = accountList.value.find(acc => acc.id === order.account_id)
      return {
        ...order,
        account_name: account ? account.username : null
      }
    })
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

// ==================== 物流轨迹 ====================

const logisticsVisible = ref(false)
const logisticsData = ref(null)
const logisticsLoading = ref(false)

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
  try {
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
    syncDialogVisible.value = false
    await loadData()
  } catch (err) {
    ElMessage.error('同步失败: ' + err.message)
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
    
    // 如果订单没有关联账号，查找匹配的采购账号（platform匹配且cookie有效）
    if (!account) {
      console.log('[Sync-Single] 订单未关联账号，开始查找匹配的账号')
      console.log('[Sync-Single] 账号列表:', accountList.value)
      
      account = accountList.value.find(acc => {
        console.log(`[Sync-Single] 检查账号: id=${acc.id}, platform=${acc.platform}, cookie_valid=${acc.cookie_valid}`)
        return acc.platform === row.platform && acc.cookie_valid
      })
    }
    
    if (!account) {
      // 尝试查找任意该平台的账号（不管cookie_valid）
      const anyAccount = accountList.value.find(acc => acc.platform === row.platform)
      if (!anyAccount) {
        ElMessage.warning(`系统中没有${platformLabel(row.platform)}采购账号，请先添加账号`)
      } else {
        ElMessage.warning(`${platformLabel(row.platform)}账号Cookie已失效，请重新登录`)
      }
      return
    }
    
    console.log('[Sync-Single] 最终使用账号:', account)
    
    const loading = ElMessage({
      message: `正在同步订单 ${row.platform_order_no}...`,
      type: 'info',
      duration: 0
    })
    
    const result = await syncSinglePurchaseOrder({
      platform: row.platform,
      account_id: account.id,
      platform_order_no: row.platform_order_no
    })
    
    loading.close()
    
    if (result.success) {
      const statusText = result.status ? `状态: ${result.status}` : ''
      const logisticsText = result.logistics_no ? `物流: ${result.logistics_no}` : ''
      const message = [statusText, logisticsText].filter(Boolean).join(', ')
      ElMessage.success(`同步成功！${message || '无更新'}`)
      await loadData()
    } else {
      ElMessage.warning(result.message || '同步失败')
    }
  } catch (err) {
    console.error('[Sync-Single] 错误:', err)
    ElMessage.error('同步失败: ' + err.message)
  }
}

// ==================== 生命周期 ====================

onMounted(async () => {
  await loadAccounts()  // 先加载账号列表
  await loadData()       // 再加载采购订单数据

  // 监听采购账号登录成功事件
  if (window.electronAPI) {
    unsubLoginSuccess = window.electronAPI.onUpdate('purchase-account-login-success', () => {
      loadAccounts()
    })
  }
})

onUnmounted(() => {
  if (unsubLoginSuccess) {
    unsubLoginSuccess()
    unsubLoginSuccess = null
  }
})
</script>

<style scoped>
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
  border-radius: 4px;
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

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
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
</style>
