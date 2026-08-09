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
                    <div class="stat-item">
                      <span class="stat-label">包装规格</span>
                      <span class="stat-value" :class="Number(bp.package_num) > 1 ? 'info' : ''">
                        x{{ Number(bp.package_num || 1) }}
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
              采购下单
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

    <!-- 采购下单弹窗 -->
    <el-dialog
      v-model="purchaseDialogVisible"
      width="960px"
      align-center
      :close-on-click-modal="false"
      @closed="onPurchaseDialogClosed"
      class="purchase-dialog-redesign"
      top="5vh"
    >
      <template #header>
        <div class="purchase-dialog-header">
          <div class="pd-header-left">
            <div class="header-text">
              <h3 class="pd-header-title">采购下单（仓库进货）</h3>
              <p class="header-subtitle">填写采购信息并选择货源</p>
            </div>
          </div>
          <div class="header-steps">
            <span class="step-item step-active">
              <span class="step-num">1</span>
              <span>配置采购</span>
            </span>
            <el-icon class="step-arrow"><ArrowRight /></el-icon>
            <span class="step-item">
              <span class="step-num">2</span>
              <span>完成下单</span>
            </span>
          </div>
        </div>
      </template>
      
      <!-- Step 1: idle 状态 -->
      <div v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'idle'" class="purchase-content">
        <!-- 顶部：收货地址 -->
        <div class="shipping-banner">
          <div class="card-body">
            <div class="shipping-banner-content">
              <div class="shipping-banner-left">
                <div v-if="purchaseInfo.shippingName || purchaseInfo.shippingPhone" class="address-contact-row">
                  <span class="contact-name">{{ purchaseInfo.shippingName }}</span>
                  <span v-if="purchaseInfo.shippingPhone" class="contact-phone">{{ purchaseInfo.shippingPhone }}</span>
                </div>
                <div v-if="purchaseInfo.shippingAddress" class="address-detail">{{ purchaseInfo.shippingAddress }}</div>
                <div v-if="!purchaseInfo.shippingName && !purchaseInfo.shippingAddress" class="empty-address">
                  <el-icon><InfoFilled /></el-icon>
                  <span>选择仓库后自动填充地址</span>
                </div>
              </div>
              <div class="shipping-banner-right">
                <el-tag size="default" type="warning" effect="light" class="address-type-badge">仓库进货模式</el-tag>
              </div>
            </div>
          </div>
        </div>

        <!-- 主体内容区 -->
        <div class="purchase-main-content">
          <!-- 左侧：配置区 -->
          <div class="config-section">
            <div class="section-header">
              <div class="section-header-left">
                <el-icon><Setting /></el-icon>
                <span>采购配置</span>
              </div>
              <el-button v-if="purchaseInfo.selectedAccountId" type="primary" text size="small" @click="handleOpenPddBrowsing">拼多多选品</el-button>
            </div>

            <div class="config-form">
              <div class="form-group source-and-detail">
                <div class="source-area">
                  <label class="form-label required">货源链接</label>
                  <div v-if="skuSources.length > 0" class="source-selector">
                    <div v-for="(src, idx) in skuSources" :key="idx"
                      class="source-option"
                      :class="{ 'source-option-active': selectedSourceIndex === idx }"
                      @click="applySourceToPurchase(idx)">
                      <div class="source-option-header">
                        <div class="source-option-left">
                          <el-tag size="small" :type="platformTagType(src.platform)">{{ platformLabel(src.platform) }}</el-tag>
                          <span v-if="src.purchase_price" class="source-option-price">¥{{ Number(src.purchase_price).toFixed(2) }}</span>
                        </div>
                        <div class="source-option-actions">
                          <el-button link type="primary" size="small" @click.stop="openEditSourceForm(src, idx)"><el-icon><Edit /></el-icon></el-button>
                          <el-button link type="danger" size="small" @click.stop="handleDeleteSource(src, idx)"><el-icon><Delete /></el-icon></el-button>
                        </div>
                      </div>
                      <div class="source-option-link-row">
                        <span class="source-option-link">{{ shortenUrl(src.purchase_link) }}</span>
                        <el-button link type="primary" size="small" class="source-link-open-btn" @click.stop="openSourceLink(src.purchase_link)"><el-icon><Link /></el-icon></el-button>
                      </div>
                    </div>
                  </div>
                  <div v-else class="source-empty-state">
                    <el-icon><Box /></el-icon>
                    <span>暂无货源，请先添加</span>
                  </div>
                  <el-button type="primary" plain size="default" class="add-source-btn" @click="openAddSourceForm">
                    <el-icon><Plus /></el-icon>
                    <span>新增货源链接</span>
                  </el-button>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label required">采购平台</label>
                <el-radio-group v-model="purchaseInfo.platform" class="platform-selector">
                  <el-radio-button value="taobao">
                    <el-icon><ShoppingBag /></el-icon>
                    淘宝/天猫
                  </el-radio-button>
                  <el-radio-button value="pinduoduo">
                    <el-icon><ShoppingCart /></el-icon>
                    拼多多
                  </el-radio-button>
                  <el-radio-button value="1688">
                    <el-icon><Shop /></el-icon>
                    阿里巴巴
                  </el-radio-button>
                </el-radio-group>
              </div>

              <div class="form-group">
                <label class="form-label required">采购账号</label>
                <el-select v-model="purchaseInfo.selectedAccountId" placeholder="请选择采购账号" filterable class="full-width-select">
                  <el-option v-for="acc in filteredPurchaseAccounts" :key="acc.id" :label="acc.account || '未命名'" :value="acc.id">
                    <div class="account-option-new">
                      <span>{{ acc.account || '未命名' }}</span>
                      <el-tag :type="acc.online ? 'success' : 'info'" size="small" effect="plain">{{ acc.online ? '在线' : '离线' }}</el-tag>
                    </div>
                  </el-option>
                </el-select>
                <div v-if="filteredPurchaseAccounts.length === 0" class="form-warning">
                  <el-icon><Warning /></el-icon>
                  <span>该平台暂无采购账号，请先在「采购订单」页面添加并登录</span>
                </div>
              </div>

              <div class="form-group">
                <label class="form-label required">选择仓库</label>
                <el-select v-model="purchaseInfo.warehouseId" placeholder="请选择发货仓库" class="full-width-select" clearable @change="onWarehouseChange">
                  <el-option v-for="wh in warehouseOptions" :key="wh.id" :label="wh.name" :value="wh.id" />
                </el-select>
              </div>
            </div>
          </div>

          <!-- 右侧：商品信息区 -->
          <div class="info-section">
            <div class="product-info-card">
              <el-image v-if="purchaseInfo.image" :src="purchaseInfo.image" class="product-main-image" fit="cover" />
              <div v-else class="product-main-image product-banner-placeholder" :style="{ background: getItemColor(purchaseInfo.goodsName) }">
                <span class="product-initial">{{ (purchaseInfo.goodsName || '?').charAt(0) }}</span>
              </div>
              <h4 class="product-name" style="text-align:center;">{{ purchaseInfo.goodsName }}</h4>
              <p v-if="purchaseInfo.sku" class="product-sku" style="text-align:center;">SKU: {{ purchaseInfo.sku }}</p>
              <div class="product-meta-grid">
                <div class="meta-item meta-price">
                  <span class="meta-label">单价</span>
                  <span class="meta-value">¥{{ purchaseInfo.price.toFixed(2) }}</span>
                </div>
                <div class="meta-item meta-qty">
                  <span class="meta-label">数量</span>
                  <span class="meta-value">{{ purchaseInfo.quantity }}</span>
                </div>
                <div class="meta-item meta-no">
                  <span class="meta-label">采购编号</span>
                  <span class="meta-value">{{ purchaseInfo.purchaseNo || '下单时自动生成' }}</span>
                </div>
                <div class="meta-item meta-order">
                  <span class="meta-label">当前库存</span>
                  <span class="meta-value">{{ purchaseInfo.currentStock }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Step 1: ordering 状态 -->
      <div v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'ordering'" style="text-align:center;padding:40px 20px">
        <el-icon :size="48" style="color:#409eff;margin-bottom:16px" class="is-loading"><Loading /></el-icon>
        <h3 style="margin:0 0 12px">正在等待下单完成...</h3>
        <p style="color:#909399;font-size:13px">请在弹出的窗口中完成下单操作，系统将自动获取订单号</p>
      </div>

      <!-- Step 1: confirming 状态 - 确认采购数量 -->
      <div v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'confirming'" style="padding:24px 20px">
        <div style="text-align:center;margin-bottom:20px">
          <el-icon :size="40" style="color:#67c23a;margin-bottom:8px"><CircleCheck /></el-icon>
          <h3 style="margin:0 0 4px;color:#67c23a;font-size:16px">采购订单已创建并绑定</h3>
          <p style="color:#909399;font-size:12px;margin:0">请确认实际采购数量</p>
        </div>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #ebeef5;">
          <el-image v-if="purchaseInfo.image" :src="purchaseInfo.image" style="width:56px;height:56px;border-radius:8px;flex-shrink:0;" fit="cover" />
          <div v-else style="width:56px;height:56px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;" :style="{ background: getItemColor(purchaseInfo.goodsName) }">
            <span style="color:#fff;font-size:18px;font-weight:700;">{{ (purchaseInfo.goodsName || '?').charAt(0) }}</span>
          </div>
          <div style="min-width:0;flex:1">
            <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#1f2937;line-height:1.4;">{{ purchaseInfo.goodsName }}</p>
            <p style="margin:0;font-size:12px;color:#9ca3af;">采购编号：{{ purchaseInfo.purchaseNo }}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#606266;">平台订单号：<strong>{{ purchaseInfo.capturedOrderNo }}</strong></p>
          </div>
        </div>
        <el-form label-width="100px" style="margin-top:8px">
          <el-form-item label="实际采购数量" required>
            <div style="display:flex;align-items:center;gap:8px;width:100%">
              <el-input-number v-model="confirmingQty" :min="1" :step="1" style="flex:1" />
              <el-button type="primary" :loading="purchaseInfo.submitting" @click="handleConfirmQty">确认</el-button>
            </div>
            <div style="font-size:12px;color:#909399;margin-top:4px">原数量：{{ purchaseInfo.quantity }}，如规格商品请修改为实际数量</div>
          </el-form-item>
        </el-form>
      </div>

      <!-- Step 1: captured 状态 - 确认完成 -->
      <div v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'captured'" style="text-align:center;padding:40px 20px">
        <el-icon :size="48" style="color:#67c23a;margin-bottom:16px"><CircleCheck /></el-icon>
        <h3 style="margin:0 0 12px;color:#67c23a">采购完成</h3>
        <p style="color:#606266;font-size:14px">平台订单号：<strong>{{ purchaseInfo.capturedOrderNo }}</strong></p>
        <p style="color:#606266;font-size:14px;margin-top:4px">采购数量：<strong>{{ purchaseInfo.quantity }}</strong></p>
      </div>

      <!-- Step 2: 手动输入 -->
      <div v-if="purchaseInfo.step === 2">
        <el-alert type="warning" :closable="false" style="margin-bottom:16px"
          title="未能自动获取订单号" description="请手动输入在采购平台购买后的订单号完成绑定。" />
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #ebeef5;">
          <el-image v-if="purchaseInfo.image" :src="purchaseInfo.image" style="width:64px;height:64px;border-radius:8px;flex-shrink:0;" fit="cover" />
          <div v-else style="width:64px;height:64px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;" :style="{ background: getItemColor(purchaseInfo.goodsName) }">
            <span style="color:#fff;font-size:20px;font-weight:700;">{{ (purchaseInfo.goodsName || '?').charAt(0) }}</span>
          </div>
          <div style="min-width:0;">
            <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1f2937;line-height:1.4;">{{ purchaseInfo.goodsName }}</p>
            <p v-if="purchaseInfo.sku" style="margin:0;font-size:12px;color:#9ca3af;">{{ purchaseInfo.sku }}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#606266;">采购数量：{{ purchaseInfo.quantity }}</p>
          </div>
        </div>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="采购编号">
            <span style="color: #e6a23c; font-weight: 600">{{ purchaseInfo.purchaseNo || '下单时自动生成' }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="采购平台">{{ platformLabel(purchaseInfo.platform) }}</el-descriptions-item>
        </el-descriptions>
        <el-form style="margin-top: 16px" label-width="110px">
          <el-form-item label="平台订单号" required>
            <el-input v-model="purchaseInfo.platformOrderNo" placeholder="请输入在淘宝/拼多多购买后的订单号" clearable />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <template v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'idle'">
          <el-button @click="purchaseDialogVisible = false">取消</el-button>
          <el-button type="primary" :disabled="!purchaseInfo.sourceUrl.trim() || !purchaseInfo.selectedAccountId" @click="handleGoOrder">去下单</el-button>
        </template>
        <template v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'ordering'">
          <el-button @click="handleCancelOrder">取消下单</el-button>
          <el-button type="warning" plain @click="purchaseInfo.step = 2">手动输入订单号</el-button>
        </template>
        <template v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'confirming'">
          <el-button @click="skipConfirmQty">跳过确认</el-button>
        </template>
        <template v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'captured'">
          <el-button type="primary" @click="purchaseDialogVisible = false">完成</el-button>
        </template>
        <template v-if="purchaseInfo.step === 2">
          <el-button @click="purchaseInfo.step = 1; purchaseInfo.captureStatus = 'idle'">上一步</el-button>
          <el-button type="primary" :loading="purchaseInfo.submitting" :disabled="!purchaseInfo.platformOrderNo.trim()" @click="handlePurchaseSubmit">确认绑定</el-button>
        </template>
      </template>
    </el-dialog>

    <!-- 货源新增/编辑弹窗 -->
    <el-dialog
      v-model="sourceFormVisible"
      :title="sourceFormMode === 'add' ? '新增货源' : '编辑货源'"
      width="420px"
      align-center
      destroy-on-close
      :close-on-click-modal="false"
    >
      <el-form label-width="0">
        <el-form-item>
          <el-input v-model="sourceForm.purchase_link" placeholder="粘贴货源商品链接，系统自动识别平台" clearable size="large" @change="onSourceUrlChange" />
        </el-form-item>
        <el-form-item>
          <div style="display:flex;gap:8px;width:100%;">
            <el-input-number v-model="sourceForm.purchase_price" :min="0" :precision="2" :step="1" placeholder="采购价" style="flex:1;" />
            <el-input v-model="sourceForm.remark" placeholder="备注（选填）" style="flex:2;" clearable />
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="sourceFormVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!sourceForm.purchase_link.trim()" @click="handleSaveSource">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  Goods, Search, Refresh, Plus, Link, ShoppingCart, Edit, Loading,
  CircleCheck, Delete, ArrowRight, Setting, ShoppingBag, Shop, Warning, InfoFilled, Box
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  fetchInventoryList, createInventory, updateInventory,
  fetchBoundProducts, searchUnboundSalesSkus,
  fetchWarehouses, createSkuBinding, deleteSkuBinding
} from '@/api/warehouse'
import { fetchPurchaseAccounts } from '@/api/purchaseAccount'
import { fetchNextPurchaseNo, createPurchaseOrder, bindPlatformOrderNo, confirmPurchaseQuantity } from '@/api/purchaseOrder'
import { fetchSkuPurchaseConfigList, saveSkuPurchaseConfig, deleteSkuPurchaseConfig, detectPlatformFromUrl } from '@/api/skuPurchaseConfig'

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

// ============ 采购下单（仓库进货） ============
const AVATAR_COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#7986cb', '#f06292', '#aed581', '#ff8a65']

function getItemColor(name) {
  if (!name) return AVATAR_COLORS[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

const purchaseDialogVisible = ref(false)
const purchaseAccounts = ref([])
const purchaseInfo = reactive({
  step: 1,
  purchaseNo: '',
  inventoryId: null,
  goodsName: '',
  sku: '',
  skuId: '',
  quantity: 0,
  price: 0,
  currentStock: 0,
  image: '',
  sourceUrl: '',
  platform: 'taobao',
  platformOrderNo: '',
  purchasePrice: 0,
  remark: '',
  selectedAccountId: null,
  captureStatus: 'idle',
  capturedOrderNo: '',
  submitting: false,
  purchaseType: 'warehouse_in',
  shippingName: '',
  shippingPhone: '',
  shippingAddress: '',
  warehouseId: null,
  warehouseName: '',
  warehouseContact: '',
  warehousePhone: '',
  warehouseAddress: ''
})

// 确认采购数量（采购单绑定后可编辑）
const confirmingQty = ref(0)

// 货源管理
const skuSources = ref([])
const selectedSourceIndex = ref(-1)
const sourceFormVisible = ref(false)
const sourceFormMode = ref('add')
const sourceForm = reactive({
  id: null,
  sku_id: '',
  purchase_link: '',
  platform: '',
  purchase_price: 0,
  remark: ''
})

// IPC 监听器引用
let unsubOrderCaptured = null
let unsubWindowClosed = null
let unsubAddressFilled = null
let unsubAddressSetupDone = null
let unsubAddressSetupStart = null
let unsubPddProductLink = null

const filteredPurchaseAccounts = computed(() => {
  return purchaseAccounts.value.filter(acc => acc.platform === purchaseInfo.platform)
})

async function handlePurchase(row) {
  currentRow.value = row
  purchaseInfo.step = 1
  purchaseInfo.purchaseNo = ''
  purchaseInfo.inventoryId = row.id
  purchaseInfo.goodsName = row.product_name || ''
  purchaseInfo.sku = row.sku || ''
  purchaseInfo.skuId = row.sku || ''
  purchaseInfo.quantity = row.unpurchased_qty > 0 ? row.unpurchased_qty : 1
  purchaseInfo.price = Number(row.price || 0)
  purchaseInfo.currentStock = Number(row.quantity || 0)
  purchaseInfo.image = row.image || ''
  purchaseInfo.sourceUrl = ''
  purchaseInfo.platform = 'taobao'
  purchaseInfo.platformOrderNo = ''
  purchaseInfo.purchasePrice = 0
  purchaseInfo.remark = ''
  purchaseInfo.selectedAccountId = null
  purchaseInfo.captureStatus = 'idle'
  purchaseInfo.capturedOrderNo = ''
  purchaseInfo.submitting = false
  purchaseInfo.warehouseId = null
  purchaseInfo.warehouseName = ''
  purchaseInfo.warehouseContact = ''
  purchaseInfo.warehousePhone = ''
  purchaseInfo.warehouseAddress = ''
  purchaseInfo.shippingName = ''
  purchaseInfo.shippingPhone = ''
  purchaseInfo.shippingAddress = ''
  purchaseDialogVisible.value = true

  // 注册 IPC 事件监听
  try {
    setupPurchaseListeners()
  } catch (e) {
    console.warn('[采购下单] IPC监听注册失败:', e.message)
  }

  // 加载采购账号列表
  try {
    const res = await fetchPurchaseAccounts()
    const rawList = res && res.list ? res.list : (Array.isArray(res) ? res : [])
    purchaseAccounts.value = rawList.map(a => ({
      ...a,
      username: a.account || a.username || '',
      status: a.online ? 'online' : 'offline'
    }))
  } catch (e) {
    console.warn('[采购下单] 加载采购账号失败:', e.message)
    purchaseAccounts.value = []
  }

  // 恢复上次选择的仓库
  const lastWhId = localStorage.getItem('lastWarehouseId')
  if (lastWhId) {
    const whMatch = warehouseOptions.value.find(w => String(w.id) === lastWhId)
    if (whMatch) {
      applyWarehouseAddress(whMatch)
      updateWarehouseShipping()
    }
  } else if (warehouseOptions.value.length === 1) {
    applyWarehouseAddress(warehouseOptions.value[0])
    updateWarehouseShipping()
  }

  // 加载该SKU的货源列表
  await loadSkuSources(purchaseInfo.skuId)

  // 根据平台自动选择上次使用的账号
  const lastId = localStorage.getItem('lastPurchaseAccount_' + purchaseInfo.platform)
  if (lastId) {
    const match = filteredPurchaseAccounts.value.find(a => String(a.id) === lastId)
    if (match) purchaseInfo.selectedAccountId = match.id
  } else if (filteredPurchaseAccounts.value.length > 0) {
    purchaseInfo.selectedAccountId = filteredPurchaseAccounts.value[0].id
  }
}

// 加载SKU货源列表
async function loadSkuSources(skuId) {
  skuSources.value = []
  selectedSourceIndex.value = -1
  if (!skuId) return
  try {
    const res = await fetchSkuPurchaseConfigList(skuId)
    if (res) {
      let list = []
      if (res.list && Array.isArray(res.list)) {
        list = res.list
      } else if (Array.isArray(res)) {
        list = res
      } else if (res.purchase_link !== undefined) {
        list = [res]
      }
      skuSources.value = list
      if (list.length > 0) {
        selectedSourceIndex.value = 0
        applySourceToPurchase(0)
      }
    }
  } catch (e) {
    console.warn('加载SKU货源列表失败:', e.message)
  }
}

function applySourceToPurchase(index) {
  const source = skuSources.value[index]
  if (!source) return
  selectedSourceIndex.value = index
  purchaseInfo.sourceUrl = source.purchase_link || ''
  purchaseInfo.platform = source.platform || detectPlatformFromUrl(source.purchase_link) || 'taobao'
  purchaseInfo.purchasePrice = source.purchase_price || 0
  purchaseInfo.remark = source.remark || ''
}

function openAddSourceForm() {
  sourceFormMode.value = 'add'
  sourceForm.id = null
  sourceForm.sku_id = purchaseInfo.skuId
  sourceForm.purchase_link = ''
  sourceForm.platform = ''
  sourceForm.purchase_price = 0
  sourceForm.remark = ''
  sourceFormVisible.value = true
}

function openEditSourceForm(row, index) {
  sourceFormMode.value = 'edit'
  sourceForm.id = row.id || null
  sourceForm.sku_id = purchaseInfo.skuId
  sourceForm.purchase_link = row.purchase_link || ''
  sourceForm.platform = row.platform || ''
  sourceForm.purchase_price = row.purchase_price || 0
  sourceForm.remark = row.remark || ''
  sourceFormVisible.value = true
}

function onSourceUrlChange(url) {
  const detected = detectPlatformFromUrl(url)
  if (detected && !sourceForm.platform) {
    sourceForm.platform = detected
  }
}

async function handleSaveSource() {
  const url = sourceForm.purchase_link.trim()
  if (!url) {
    ElMessage.warning('请输入货源链接')
    return
  }
  const platform = detectPlatformFromUrl(url) || 'taobao'
  try {
    await saveSkuPurchaseConfig({
      id: sourceForm.id || undefined,
      sku_id: sourceForm.sku_id,
      platform,
      purchase_link: url,
      purchase_price: sourceForm.purchase_price || 0,
      remark: sourceForm.remark
    })
    ElMessage.success(sourceForm.id ? '货源已更新' : '货源已添加')
    sourceFormVisible.value = false
    await loadSkuSources(purchaseInfo.skuId)
  } catch (err) {
    ElMessage.error('保存失败: ' + (err.message || ''))
  }
}

async function handleDeleteSource(row, index) {
  try {
    if (row.id) {
      await deleteSkuPurchaseConfig(row.id)
    }
    ElMessage.success('已删除')
    await loadSkuSources(purchaseInfo.skuId)
  } catch (err) {
    ElMessage.error('删除失败: ' + (err.message || ''))
  }
}

// 应用仓库地址到采购信息
function applyWarehouseAddress(wh) {
  if (!wh) return
  purchaseInfo.warehouseId = wh.id
  purchaseInfo.warehouseName = wh.name || ''
  purchaseInfo.warehouseContact = wh.contact || ''
  purchaseInfo.warehousePhone = wh.phone || ''
  purchaseInfo.warehouseAddress = wh.location || wh.address || ''
}

// 仓库进货：地址=仓库地址+采购编号
function updateWarehouseShipping() {
  purchaseInfo.shippingName = purchaseInfo.warehouseContact || purchaseInfo.warehouseName
  purchaseInfo.shippingPhone = purchaseInfo.warehousePhone
  let addr = purchaseInfo.warehouseAddress || ''
  if (purchaseInfo.purchaseNo) {
    addr = addr + '【' + purchaseInfo.purchaseNo + '】'
  }
  purchaseInfo.shippingAddress = addr
}

function onWarehouseChange(whId) {
  const wh = warehouseOptions.value.find(w => w.id === whId)
  if (wh) {
    applyWarehouseAddress(wh)
  } else {
    purchaseInfo.warehouseId = null
    purchaseInfo.warehouseName = ''
    purchaseInfo.warehouseContact = ''
    purchaseInfo.warehousePhone = ''
    purchaseInfo.warehouseAddress = ''
    localStorage.removeItem('lastWarehouseId')
  }
  updateWarehouseShipping()
}

function platformLabel(val) {
  const map = { taobao: '淘宝/天猫', pinduoduo: '拼多多', '1688': '阿里巴巴' }
  return map[val] || val
}

function platformTagType(val) {
  const map = { taobao: 'danger', pinduoduo: 'warning', '1688': '' }
  return map[val] || 'info'
}

function shortenUrl(url) {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.hostname.includes('taobao.com') || u.hostname.includes('tmall.com')) {
      const id = u.searchParams.get('id')
      return id ? `${u.origin}${u.pathname}?id=${id}` : url
    }
    if (u.hostname.includes('1688.com')) {
      const offerId = u.searchParams.get('offerId')
      if (offerId) return `${u.origin}${u.pathname}?offerId=${offerId}`
      const match = u.pathname.match(/\/offer\/(\d+)/)
      if (match) return `${u.origin}/offer/${match[1]}.html`
      return url
    }
    if (u.hostname.includes('yangkeduo') || u.hostname.includes('pinduoduo')) {
      const gid = u.searchParams.get('goods_id') || u.searchParams.get('goodsId')
      return gid ? `${u.origin}${u.pathname}?goods_id=${gid}` : url
    }
    const trackParams = ['spm', 'from', 'utm_source', 'utm_medium', 'utm_campaign', 'ref', 'source', 'cm_key', 'alitrackid', 'abucket', 'acm', 'scm']
    const newParams = new URLSearchParams()
    for (const [k, v] of u.searchParams) {
      if (!trackParams.includes(k.toLowerCase())) newParams.set(k, v)
    }
    const qs = newParams.toString()
    return `${u.origin}${u.pathname}${qs ? '?' + qs : ''}`
  } catch {
    return url
  }
}

function openSourceLink(url) {
  if (window.electronAPI) {
    window.electronAPI.invoke('open-external-url', { url })
  } else {
    window.open(url, '_blank')
  }
}

async function handleOpenPddBrowsing() {
  if (!purchaseInfo.selectedAccountId) {
    ElMessage.warning('请先选择采购账号')
    return
  }
  try {
    await window.electronAPI.invoke('open-pdd-browsing-window', {
      accountId: purchaseInfo.selectedAccountId
    })
  } catch (e) {
    ElMessage.error('打开拼多多选品窗口失败: ' + e.message)
  }
}

// 去下单：获取采购编号 + 打开BrowserWindow
async function handleGoOrder() {
  const url = purchaseInfo.sourceUrl.trim()
  if (!url) {
    ElMessage.warning('请输入货源链接')
    return
  }
  if (!purchaseInfo.selectedAccountId) {
    ElMessage.warning('请选择采购账号')
    return
  }
  if (!purchaseInfo.warehouseId) {
    ElMessage.warning('请选择仓库')
    return
  }

  // 获取采购编号
  if (!purchaseInfo.purchaseNo) {
    try {
      const noResult = await fetchNextPurchaseNo()
      const purchaseNo = noResult.purchase_no || noResult.data?.purchase_no
      if (!purchaseNo) {
        ElMessage.error('获取采购编号失败')
        return
      }
      purchaseInfo.purchaseNo = purchaseNo
      // 将编号追加到收货地址
      if (!purchaseInfo.shippingAddress.includes('【' + purchaseNo + '】')) {
        purchaseInfo.shippingAddress = purchaseInfo.shippingAddress + '【' + purchaseNo + '】'
      }
    } catch (e) {
      ElMessage.error('获取采购编号失败: ' + e.message)
      return
    }
  }

  let finalUrl = url
  if (!/^https?:\/\//i.test(finalUrl)) {
    finalUrl = 'https://' + finalUrl
  }

  // 记住使用的账号和仓库
  localStorage.setItem('lastPurchaseAccount_' + purchaseInfo.platform, String(purchaseInfo.selectedAccountId))
  if (purchaseInfo.warehouseId) {
    localStorage.setItem('lastWarehouseId', String(purchaseInfo.warehouseId))
  }

  // 获取选中的采购账号名称和密码
  const selectedAccount = purchaseAccounts.value.find(acc => acc.id === purchaseInfo.selectedAccountId)
  const accountName = selectedAccount ? (selectedAccount.username || selectedAccount.name || '') : ''
  const accountPassword = selectedAccount ? (selectedAccount.password || '') : ''

  // 调用主进程打开采购窗口
  if (window.electronAPI) {
    try {
      await window.electronAPI.invoke('open-purchase-order-window', {
        accountId: purchaseInfo.selectedAccountId,
        accountName: accountName,
        password: accountPassword,
        purchaseUrl: finalUrl,
        platform: purchaseInfo.platform,
        purchaseInfo: {
          purchaseNo: purchaseInfo.purchaseNo,
          salesOrderId: null,
          salesOrderNo: '',
          inventoryId: purchaseInfo.inventoryId,
          goodsName: purchaseInfo.goodsName,
          image: purchaseInfo.image,
          sku: purchaseInfo.sku,
          skuId: purchaseInfo.skuId,
          quantity: purchaseInfo.quantity,
          price: purchaseInfo.price,
          purchasePrice: purchaseInfo.purchasePrice,
          remark: purchaseInfo.remark,
          sourceUrl: finalUrl,
          purchaseType: purchaseInfo.purchaseType,
          shippingName: purchaseInfo.shippingName,
          shippingPhone: purchaseInfo.shippingPhone,
          shippingAddress: purchaseInfo.shippingAddress
        }
      })
    } catch (error) {
      ElMessage.error('打开采购页面失败: ' + error.message)
      return
    }
  }

  purchaseInfo.captureStatus = 'ordering'
}

function handleCancelOrder() {
  if (window.electronAPI) {
    window.electronAPI.invoke('close-purchase-order-window', { purchaseNo: purchaseInfo.purchaseNo })
  }
  purchaseInfo.captureStatus = 'idle'
}

function setupPurchaseListeners() {
  if (!window.electronAPI) return
  cleanupPurchaseListeners()
  unsubOrderCaptured = window.electronAPI.onUpdate('purchase-order-captured', (data) => {
    if (data.purchaseNo === purchaseInfo.purchaseNo) {
      purchaseInfo.capturedOrderNo = data.platformOrderNo
      if (data.success === false) {
        confirmingQty.value = purchaseInfo.quantity
        purchaseInfo.captureStatus = 'confirming'
        ElMessage.warning(`订单号已捕获(${data.platformOrderNo})，但自动绑定失败: ${data.error || '未知错误'}，请手动绑定`)
      } else {
        confirmingQty.value = purchaseInfo.quantity
        purchaseInfo.captureStatus = 'confirming'
        ElMessage.success('采购订单已自动创建并绑定，请确认采购数量')
      }
    }
  })
  unsubWindowClosed = window.electronAPI.onUpdate('purchase-window-closed', (data) => {
    if (data.purchaseNo === purchaseInfo.purchaseNo && !data.captured) {
      if (purchaseInfo.captureStatus === 'ordering') {
        purchaseInfo.step = 2
        purchaseInfo.captureStatus = 'idle'
        ElMessage.info('未检测到订单号，请手动输入')
      }
      fetchPurchaseAccounts().then(res => {
        const rawList = res && res.list ? res.list : (Array.isArray(res) ? res : [])
        purchaseAccounts.value = rawList.map(a => ({
          ...a,
          username: a.account || a.username || '',
          status: a.online ? 'online' : 'offline'
        }))
      }).catch(() => {})
    }
  })
  unsubAddressFilled = window.electronAPI.onUpdate('purchase-address-filled', (data) => {
    if (data.purchaseNo === purchaseInfo.purchaseNo) {
      ElMessage({
        message: `仓库地址已自动填充（共${data.filledCount}个字段），请核对后提交订单`,
        type: 'success',
        duration: 5000
      })
    }
  })
  unsubAddressSetupDone = window.electronAPI.onUpdate('purchase-address-setup-done', (data) => {
    if (data.purchaseNo === purchaseInfo.purchaseNo) {
      if (data.failed) {
        const reasonText = {
          no_button: '未找到新增地址按钮',
          no_form: '未找到地址表单',
          no_region: '未能选择省市区',
          no_save_button: '未找到保存按钮',
          validation_failed: '淘宝未接受填写的地址信息',
          default_unconfirmed: '未能设置为默认收货地址',
          save_unconfirmed: '未检测到淘宝保存成功',
          need_login: '淘宝登录状态已失效',
          need_verify: '淘宝要求安全验证',
          script_error: '页面脚本执行异常',
          load_failed: '地址页面加载失败',
          timeout: '操作超时'
        }[data.reason] || '未知原因'
        ElMessage({
          message: '地址自动设置失败：' + reasonText,
          type: 'warning',
          duration: 5000
        })
      } else {
        ElMessage({
          message: '地址已修改成功',
          type: 'success',
          duration: 3000
        })
      }
    }
  })
  unsubAddressSetupStart = window.electronAPI.onUpdate('purchase-address-setup-start', (data) => {
    if (data.purchaseNo === purchaseInfo.purchaseNo) {
      ElMessage({
        message: '正在为您自动设置收货地址，请稍候...',
        type: 'info',
        duration: 4000,
        showClose: true
      })
    }
  })
  unsubPddProductLink = window.electronAPI.onUpdate('pdd-product-link-update', (data) => {
    if (data && data.url && purchaseInfo.step === 1) {
      purchaseInfo.sourceUrl = data.url
      ElMessage.success('已提取商品链接到货源链接')
    }
  })
}

function cleanupPurchaseListeners() {
  if (unsubOrderCaptured) { unsubOrderCaptured(); unsubOrderCaptured = null }
  if (unsubWindowClosed) { unsubWindowClosed(); unsubWindowClosed = null }
  if (unsubAddressFilled) { unsubAddressFilled(); unsubAddressFilled = null }
  if (unsubAddressSetupDone) { unsubAddressSetupDone(); unsubAddressSetupDone = null }
  if (unsubAddressSetupStart) { unsubAddressSetupStart(); unsubAddressSetupStart = null }
  if (unsubPddProductLink) { unsubPddProductLink(); unsubPddProductLink = null }
}

function onPurchaseDialogClosed() {
  cleanupPurchaseListeners()
  // 如果在 confirming/captured 状态关闭（未走正常确认流程），仍然刷新列表
  if (purchaseInfo.captureStatus === 'confirming' || purchaseInfo.captureStatus === 'captured') {
    loadData()
  }
}

async function handlePurchaseSubmit() {
  if (!purchaseInfo.platformOrderNo.trim()) {
    ElMessage.warning('请输入平台订单号')
    return
  }
  purchaseInfo.submitting = true
  try {
    await createPurchaseOrder({
      purchase_no: purchaseInfo.purchaseNo,
      inventory_id: purchaseInfo.inventoryId,
      goods_name: purchaseInfo.goodsName,
      goods_image: purchaseInfo.image,
      sku: purchaseInfo.sku,
      quantity: purchaseInfo.quantity,
      source_url: purchaseInfo.sourceUrl,
      platform: purchaseInfo.platform,
      purchase_price: purchaseInfo.purchasePrice,
      remark: purchaseInfo.remark,
      purchase_type: purchaseInfo.purchaseType,
      shipping_name: purchaseInfo.shippingName,
      shipping_phone: purchaseInfo.shippingPhone,
      shipping_address: purchaseInfo.shippingAddress
    })
    await bindPlatformOrderNo(purchaseInfo.purchaseNo, {
      platform_order_no: purchaseInfo.platformOrderNo.trim()
    })
    ElMessage.success('采购单创建并绑定成功，请确认采购数量')
    purchaseInfo.capturedOrderNo = purchaseInfo.platformOrderNo.trim()
    confirmingQty.value = purchaseInfo.quantity
    purchaseInfo.captureStatus = 'confirming'
    loadData()
  } catch (err) {
    ElMessage.error('采购操作失败: ' + err.message)
  } finally {
    purchaseInfo.submitting = false
  }
}

// 确认采购数量（更新采购单的实际数量）
async function handleConfirmQty() {
  if (confirmingQty.value < 1) {
    ElMessage.warning('采购数量不能小于1')
    return
  }
  purchaseInfo.submitting = true
  try {
    // 如果数量有变化，更新采购单
    if (confirmingQty.value !== purchaseInfo.quantity) {
      await confirmPurchaseQuantity(purchaseInfo.purchaseNo, confirmingQty.value)
      purchaseInfo.quantity = confirmingQty.value
      ElMessage.success(`采购数量已更新为 ${confirmingQty.value}`)
    } else {
      ElMessage.success('采购数量已确认')
    }
    purchaseInfo.captureStatus = 'captured'
    setTimeout(() => { purchaseDialogVisible.value = false }, 1500)
    loadData()
    // 刷新采购账号列表
    fetchPurchaseAccounts().then(res => {
      const rawList = res && res.list ? res.list : (Array.isArray(res) ? res : [])
      purchaseAccounts.value = rawList.map(a => ({
        ...a,
        username: a.account || a.username || '',
        status: a.online ? 'online' : 'offline'
      }))
    }).catch(() => {})
  } catch (err) {
    ElMessage.error('确认采购数量失败: ' + err.message)
  } finally {
    purchaseInfo.submitting = false
  }
}

// 跳过确认（直接用原数量）
function skipConfirmQty() {
  purchaseInfo.captureStatus = 'captured'
  setTimeout(() => { purchaseDialogVisible.value = false }, 1500)
  loadData()
  // 刷新采购账号列表
  fetchPurchaseAccounts().then(res => {
    const rawList = res && res.list ? res.list : (Array.isArray(res) ? res : [])
    purchaseAccounts.value = rawList.map(a => ({
      ...a,
      username: a.account || a.username || '',
      status: a.online ? 'online' : 'offline'
    }))
  }).catch(() => {})
}

// URL 自动检测平台
watch(() => purchaseInfo.sourceUrl, (url) => {
  if (!url) return
  const lower = url.toLowerCase()
  if (lower.includes('taobao.com') || lower.includes('tmall.com') || lower.includes('tb.cn')) {
    purchaseInfo.platform = 'taobao'
  } else if (lower.includes('pinduoduo.com') || lower.includes('yangkeduo.com') || lower.includes('pdd.com')) {
    purchaseInfo.platform = 'pinduoduo'
  } else if (lower.includes('1688.com')) {
    purchaseInfo.platform = '1688'
  }
})

// 平台切换时自动选择上次使用的账号
watch(() => purchaseInfo.platform, (platform) => {
  const lastId = localStorage.getItem('lastPurchaseAccount_' + platform)
  if (lastId) {
    const match = filteredPurchaseAccounts.value.find(a => String(a.id) === lastId)
    if (match) {
      purchaseInfo.selectedAccountId = match.id
      return
    }
  }
  if (filteredPurchaseAccounts.value.length > 0) {
    purchaseInfo.selectedAccountId = filteredPurchaseAccounts.value[0].id
  } else {
    purchaseInfo.selectedAccountId = null
  }
})

// ============ 初始化 ============
onMounted(() => {
  loadWarehouses()
  loadData()
})

onUnmounted(() => {
  cleanupPurchaseListeners()
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

/* ========== 采购下单弹窗样式 ========== */
.purchase-dialog-redesign {
  border-radius: 8px;
  overflow: hidden;
}
.purchase-dialog-redesign :deep(.el-dialog__header) {
  padding: 20px 24px;
  border-bottom: 1px solid #e8eaed;
  margin: 0;
  background: #ffffff;
}
.purchase-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pd-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.header-icon-wrapper {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  background: #f0f5ff;
  display: flex;
  align-items: center;
  justify-content: center;
}
.header-icon {
  font-size: 20px;
  color: #2b5aed;
}
.header-text {
  color: #1f2937;
}
.pd-header-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
}
.header-subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: #9ca3af;
}
.header-steps {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #f5f7fa;
  border-radius: 20px;
}
.step-item {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #9ca3af;
  font-size: 13px;
  white-space: nowrap;
}
.step-item.step-active {
  color: #2b5aed;
  font-weight: 600;
}
.step-num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #e5e7eb;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  color: #6b7280;
}
.step-item.step-active .step-num {
  background: #2b5aed;
  color: #ffffff;
}
.step-arrow {
  color: #d1d5db;
  font-size: 14px;
}
.purchase-dialog-redesign :deep(.el-dialog__body) {
  padding: 20px 24px;
  background: #fafbfc;
  max-height: 75vh;
  overflow-y: auto;
}
.purchase-dialog-redesign :deep(.el-dialog__footer) {
  padding: 16px 24px;
  border-top: 1px solid #e8eaed;
  background: #ffffff;
}
.shipping-banner {
  margin-bottom: 16px;
}
.shipping-banner .card-body {
  padding: 16px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e8eaed;
}
.shipping-banner-content {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.shipping-banner-left {
  flex: 1;
  min-width: 0;
}
.shipping-banner-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.address-contact-row {
  margin-bottom: 6px;
}
.contact-name {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  margin-right: 10px;
}
.contact-phone {
  font-size: 13px;
  color: #606266;
}
.address-detail {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  margin-bottom: 12px;
}
.empty-address {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #c0c4cc;
  font-size: 13px;
  padding: 20px 0;
}
.address-type-badge {
  flex-shrink: 0;
}
.product-info-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.product-main-image {
  width: 280px;
  height: 280px;
  border-radius: 8px;
  flex-shrink: 0;
  object-fit: cover;
}
.product-banner-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
}
.product-initial {
  color: #ffffff;
  font-size: 28px;
  font-weight: 700;
}
.product-name {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  line-height: 1.5;
}
.product-sku {
  margin: 0 0 10px;
  font-size: 12px;
  color: #9ca3af;
}
.product-meta-grid {
  width: 100%;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.meta-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 4px;
  border-radius: 6px;
  background: #f5f7fa;
}
.meta-item .meta-label {
  font-size: 11px;
  color: #909399;
  margin-bottom: 2px;
}
.meta-item .meta-value {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}
.meta-price .meta-value {
  color: #f56c6c;
}
.meta-no .meta-value {
  color: #e6a23c;
  font-size: 12px;
}
.meta-order .meta-value {
  color: #67c23a;
  font-size: 11px;
  word-break: break-all;
  text-align: center;
}
.purchase-main-content {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 16px;
}
.config-section {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8eaed;
  padding: 20px;
}
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}
.section-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.section-header .el-icon {
  font-size: 18px;
  color: #2b5aed;
}
.section-header span {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}
.config-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.form-label {
  font-size: 14px;
  font-weight: 500;
  color: #374151;
}
.form-label.required::before {
  content: '*';
  color: #f56c6c;
  margin-right: 4px;
}
.source-selector {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.source-option {
  padding: 12px;
  background: #f9fafb;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  overflow: hidden;
  min-width: 0;
}
.source-option:hover {
  background: #ecf5ff;
  border-color: #409eff;
}
.source-option-active {
  background: #ecf5ff;
  border-color: #409eff;
}
.source-option-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.source-option-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.source-option-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.2s;
}
.source-option:hover .source-option-actions {
  opacity: 1;
}
.source-option-price {
  font-size: 15px;
  color: #f56c6c;
  font-weight: 600;
}
.source-option-link-row {
  display: flex;
  align-items: flex-start;
  gap: 4px;
}
.source-option-link {
  font-size: 13px;
  color: #409eff;
  word-break: break-all;
  line-height: 1.4;
  flex: 1;
  min-width: 0;
}
.source-link-open-btn {
  flex-shrink: 0;
  margin-top: 1px;
}
.source-and-detail {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.source-area {
  flex: 1;
  min-width: 0;
}
.source-empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: #909399;
  font-size: 14px;
  background: #f9fafb;
  border-radius: 8px;
}
.add-source-btn {
  width: 100%;
}
.platform-selector {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.platform-selector :deep(.el-radio-button) {
  flex: 1;
}
.platform-selector :deep(.el-radio-button__inner) {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 12px;
}
.full-width-select {
  width: 100%;
}
.account-option-new {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.form-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #e6a23c;
  font-size: 12px;
  padding: 8px 12px;
  background: #fef3c7;
  border-radius: 6px;
}
.info-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
