<template>
  <div class="page-container">
    <!-- 1. 筛选栏 + 功能区 -->
    <div class="filter-panel">
      <div class="filter-main">
        <div class="filter-grid">
          <div class="filter-item">
            <label class="filter-label">选择店铺</label>
            <el-select
              v-model="searchForm.storeId"
              filterable
              clearable
              placeholder="全部店铺"
              @clear="searchForm.storeId = ''"
            >
              <el-option label="全部店铺" :value="''" />
              <el-option v-for="s in filteredStoreOptions" :key="s.id" :label="s.name" :value="s.id">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <span>{{ s.name }}</span>
                  <el-tag v-if="s.online" type="success" size="small">在线</el-tag>
                </div>
              </el-option>
              <template #label="{ label, value }">
                <div class="store-select-prefix">
                  <el-tag v-if="getStoreOnlineStatus(value)" type="success" size="small" style="margin-right:6px;">在线</el-tag>
                  <span>{{ label }}</span>
                </div>
              </template>
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">订单编号</label>
            <el-input v-model="searchForm.orderNo" placeholder="请输入站外订单编号" clearable @keyup.enter="handleQueryOrders" />
          </div>
          <div class="filter-item">
            <label class="filter-label">商品名称</label>
            <el-input v-model="searchForm.goodsName" placeholder="请输入关键词" clearable @keyup.enter="handleQueryOrders" />
          </div>
          <div class="filter-item">
            <label class="filter-label">发货单号</label>
            <el-input v-model="searchForm.outboundNo" placeholder="" clearable @keyup.enter="handleQueryOrders" />
          </div>
          <div class="filter-item">
            <label class="filter-label">客户姓名</label>
            <el-input v-model="searchForm.customerName" placeholder="请输入关键词" clearable @keyup.enter="handleQueryOrders" />
          </div>
          <div class="filter-item">
            <label class="filter-label">采购状态</label>
            <el-select v-model="searchForm.purchaseStatus" placeholder="全部状态" clearable @clear="searchForm.purchaseStatus = ''">
              <el-option label="全部状态" value="" />
              <el-option label="未采购" value="未采购" />
              <el-option label="已采购（三方代发）" value="已采购（三方代发）" />
              <el-option label="已采购（仓库转发）" value="已采购（仓库转发）" />
              <el-option label="仓库有货" value="仓库有货" />
              <el-option label="已忽略" value="已忽略" />
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">店铺标签</label>
            <el-select v-model="searchForm.storeTag" placeholder="全部标签" clearable filterable @clear="searchForm.storeTag = ''">
              <el-option v-for="tag in storeTagOptions" :key="tag" :label="tag" :value="tag" />
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">问题事件</label>
            <el-select v-model="searchForm.issueEvent" placeholder="无筛选" clearable>
              <el-option v-for="e in issueEventOptions" :key="e" :label="e" :value="e" />
            </el-select>
          </div>
        </div>
        <!-- 查询和同步按钮 -->
        <div class="filter-actions">
          <el-button class="action-btn action-btn-orange" size="large" @click="handleQueryOrders">
            <el-icon><Search /></el-icon>
            <span>查询订单</span>
          </el-button>
          <el-button class="action-btn action-btn-blue" size="large" :disabled="loading || !!syncStatusText" @click="handleSyncOrders">
            <el-icon><Refresh /></el-icon>
            <span>同步订单</span>
          </el-button>
          <span v-if="syncStatusText" class="auto-sync-tip">
            <el-icon class="sync-spin"><Refresh /></el-icon>
            {{ syncStatusText }}
          </span>
          <span v-if="syncSkipStatus" class="sync-skip-tip">
            <el-icon><CircleClose /></el-icon>
            {{ syncSkipStatus }}
          </span>
          <!-- 超时统计信息 -->
          <div class="filter-stats">
            <span class="filter-stat">出库即将超时订单数1：<em class="stat-num">{{ nearTimeoutCount }}</em></span>
            <span class="filter-stat">超时未出库订单数：<em class="stat-num">{{ timeoutCount }}</em></span>
          </div>
        </div>
      </div>

      <!-- 功能区（横向3列） -->
      <div class="func-panel">
        <div class="func-group">
          <div class="func-group-title">出库设置</div>
          <div class="func-item">
            <div class="func-item-header">
              <span class="func-item-label">自动出库</span>
              <el-switch v-model="funcSettings.autoOutbound" @change="onFuncChange('autoOutbound', $event)" />
            </div>
            <p class="func-item-desc">(同步到物流的订单自动轨迹单出库)</p>
          </div>
          <div class="func-item">
            <div class="func-item-header">
              <span class="func-item-label">大件物流</span>
              <el-switch v-model="funcSettings.largeLogistics" @change="onFuncChange('largeLogistics', $event)" />
            </div>
            <p class="func-item-desc">(不支持的物流将自动使用大件出库)</p>
          </div>
        </div>
        <div class="func-group">
          <div class="func-group-title">同步订单</div>
          <div class="func-item">
            <div class="func-item-header">
              <span class="func-item-label">京东订单</span>
              <el-switch v-model="funcSettings.syncJdOrder" @change="onFuncChange('syncJdOrder', $event)" />
            </div>
            <p class="func-item-desc" :class="{ 'sync-status-active': syncStatusText }">{{ syncStatusText || '(每10分钟，同步1次店铺订单信息及状态)' }}</p>
          </div>
          <div class="func-item">
            <div class="func-item-header">
              <span class="func-item-label">采购订单</span>
              <el-switch v-model="funcSettings.syncPurchaseOrder" @change="onFuncChange('syncPurchaseOrder', $event)" />
            </div>
            <p class="func-item-desc">(每60分钟，同步1次采购订单状态及物流)</p>
          </div>
        </div>
      </div>
    </div>

    <!-- 2. 操作栏 -->
    <div class="action-bar">
      <div class="action-left">
      </div>
      <div class="action-center">
      </div>
      <div class="action-right">
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
        {{ item.label }}<span v-if="item.count !== null" class="stat-count">({{ item.count }})</span>
      </span>
    </div>

    <!-- 4. 卡片式订单列表 -->
    <div class="table-card" v-loading="loading" element-loading-text="正在从京麦后台获取订单数据...">
      <!-- 表头 -->
      <div class="order-table-header">
        <div class="order-table-header-left">
          <div class="ot-col ot-col-check">
            <el-checkbox v-model="selectAll" @change="handleSelectAll" />
          </div>
          <div class="ot-col ot-col-goods">商品信息</div>
          <div class="ot-col ot-col-price">单价/数量</div>
          <div class="ot-col ot-col-purchase">操作</div>
        </div>
        <div class="order-table-header-right">
          <div class="ot-col ot-col-amount">订单金额</div>
          <div class="ot-col ot-col-logistics">物流信息</div>
          <div class="ot-col ot-col-remark">备注</div>
          <div class="ot-col ot-col-action">操作</div>
        </div>
      </div>

      <!-- 订单卡片列表 -->
      <div class="order-list" v-if="pagedOrders.length">
        <div
          class="order-card"
          v-for="(order, orderIdx) in pagedOrders"
          :key="order.id"
        >
          <!-- 订单卡片头部条：核心信息区 -->
          <div class="order-card-header"
               :style="{
                 background: statusBgColor(order.orderStatus)
               }">
            <div class="order-header-left">
              <el-checkbox v-model="order.selected" @change="handleOrderSelect" />
              <span class="order-header-label">订单编号:</span>
              <span class="order-header-no">{{ order.orderNo }}</span>
              <span class="order-header-divider">|</span>
              <span class="order-header-shop">{{ order.shopName }}</span>
              <el-tag :type="orderStatusTagType(order.orderStatus)" size="small">{{ order.orderStatus }}</el-tag>
              <el-tag v-if="getDisplayPurchaseStatus(order)" :type="purchaseStatusTagType(getDisplayPurchaseStatus(order))" size="small" effect="plain">{{ getDisplayPurchaseStatus(order) }}</el-tag>
              <el-link v-if="order.purchaseStatus === '未采购'" type="info" :underline="false" style="margin-left:2px;font-size:12px" @click.stop="handleIgnorePurchase(order)">忽略</el-link>
              <span class="order-header-divider">|</span>
              <span class="order-header-time-label">下单时间：</span>
              <span class="order-header-time">{{ order.orderTime }}</span>
            </div>
            <div class="order-header-right">
            </div>
          </div>

          <!-- 订单卡片内容（商品行 + 订单信息） -->
          <div class="order-card-body">
            <!-- 左侧：商品行 -->
            <div class="order-body-left">
              <div
                class="product-row"
                v-for="(item, itemIdx) in order.items"
                :key="itemIdx"
                :class="{ 'product-row-border': itemIdx < order.items.length - 1 }"
              >
                <div class="ot-col ot-col-check"></div>
                <div class="ot-col ot-col-goods">
                  <div class="goods-cell">
                    <el-image
                      v-if="item.image"
                      class="goods-img"
                      :src="item.image"
                      :preview-src-list="[getOriginalImg(item.image)]"
                      fit="cover"
                      preview-teleported
                      hide-on-click-modal
                    />
                    <div v-else class="goods-img goods-img-placeholder" :style="{ background: item.imageColor }">
                      <span class="goods-img-text">{{ item.name.charAt(0) }}</span>
                    </div>
                    <div class="goods-info">
                      <p class="goods-name">{{ item.name }}</p>
                      <p class="goods-sku" v-if="item.sku">{{ item.sku }}</p>
                      <div class="goods-sku-row">
                        <el-tag v-if="item.purchaseStatus" :type="purchaseStatusTagType(item.purchaseStatus)" size="small" effect="plain">{{ item.purchaseStatus }}</el-tag>
                        <div class="goods-search-links">
                          <el-popover placement="bottom-start" trigger="hover" :width="180">
                            <template #reference>
                              <span class="goods-search-link">搜标题</span>
                            </template>
                            <div class="search-platform-list">
                              <span class="search-platform-item" @click="handleSearchTitle(item, 'taobao')">淘宝</span>
                              <span class="search-platform-divider">|</span>
                              <span class="search-platform-item" @click="handleSearchTitle(item, '1688')">1688</span>
                              <span class="search-platform-divider">|</span>
                              <span class="search-platform-item" @click="handleSearchTitle(item, 'pdd')">拼多多</span>
                            </div>
                          </el-popover>
                          <el-popover placement="bottom-start" trigger="hover" :width="180">
                            <template #reference>
                              <span class="goods-search-link">搜图片</span>
                            </template>
                            <div class="search-platform-list">
                              <span class="search-platform-item" @click="handleSearchImage(item, 'taobao')">淘宝</span>
                              <span class="search-platform-divider">|</span>
                              <span class="search-platform-item" @click="handleSearchImage(item, '1688')">1688</span>
                              <span class="search-platform-divider">|</span>
                              <span class="search-platform-item" @click="handleSearchImage(item, 'pdd')">拼多多</span>
                            </div>
                          </el-popover>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="ot-col ot-col-price">
                  <div class="price-cell">
                    <span class="price-value">¥{{ item.price.toFixed(2) }}</span>
                    <span class="price-qty">x {{ item.quantity }}</span>
                  </div>
                </div>
                <div class="ot-col ot-col-purchase">
                  <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;width:100%;">
                    <el-button type="warning" size="small" plain style="width:90px;margin-left:0" @click.stop="handlePurchase(order, item, itemIdx)">
                      <el-icon><ShoppingCart /></el-icon>
                      <span>采购下单</span>
                    </el-button>
                    <el-button type="primary" size="small" plain style="width:90px;margin-left:0" @click.stop="handleBindWarehouse(order, item, itemIdx)">
                      <el-icon><OfficeBuilding /></el-icon>
                      <span>绑定库存</span>
                    </el-button>
                  </div>
                </div>
              </div>
            </div>

            <!-- 右侧：订单级信息（纵向居中） -->
            <div class="order-body-right">
              <div class="ot-col ot-col-amount">
                <span class="amount-main">¥{{ order.actualAmount.toFixed(2) }}</span>
                <p class="amount-sub">含运费 ¥{{ order.shippingFee.toFixed(2) }}</p>
              </div>

              <div class="ot-col ot-col-logistics">
                <template v-if="order.logisticsCompany">
                  <p class="logistics-company">{{ order.logisticsCompany }}</p>
                  <p class="logistics-no">{{ order.logisticsNo }}</p>
                </template>
                <span v-else class="text-muted">--</span>
              </div>
              <div class="ot-col ot-col-remark">
                <div class="remark-cell">
                  <div class="remark-item">
                    <span class="remark-label">商:</span>
                    <span class="remark-text remark-text-merchant">{{ order.remark || '点击编辑' }}</span>
                    <el-button type="primary" link size="small" class="remark-edit-btn" @click.stop="handleEditRemark(order)">
                      <el-icon><Edit /></el-icon>
                    </el-button>
                  </div>
                  <div v-if="order.sysRemark" class="remark-item">
                    <span class="remark-label">系:</span>
                    <span class="remark-text">{{ order.sysRemark }}</span>
                  </div>
                  <span v-if="!order.remark && !order.sysRemark" class="text-muted" style="display:none;">--</span>
                </div>
              </div>
              <div class="ot-col ot-col-action">
                <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;width:100%;">
                  <el-button type="primary" link size="small" @click="handleView(order)">查看详情</el-button>
                  <el-button type="success" link size="small" @click="handleSmsNotify(order)">
                    <el-icon><Message /></el-icon>
                    <span>短信</span>
                  </el-button>
                </div>
              </div>
            </div>
          </div>

          <!-- 订单卡片底部：买家信息区 -->
          <div class="order-card-footer-buyer">
            <span class="order-buyer-label">买家:</span>
            <span class="order-buyer-name">{{ order.customerName }}</span>
            <span v-if="order.customerPhone" class="order-buyer-phone">[{{ order.customerPhone }}]</span>
            <span class="order-header-divider">|</span>
            <div class="order-contact-btn" @click.stop="handleOpenChat(order)">
              <el-icon><ChatDotRound /></el-icon>
              <span>联系买家</span>
            </div>
            <span class="order-header-divider">|</span>
            <span class="order-address-label">收货地址:</span>
            <span class="order-address-text" :title="order.address">{{ order.address }}</span>
            <el-button
              type="primary"
              text
              size="small"
              :loading="order._sensitiveLoading"
              class="order-reveal-btn"
              @click.stop="handleRevealBuyerInfo(order)"
            >
              <el-icon><View /></el-icon>
            </el-button>
          </div>
        </div>
      </div>

      <el-empty v-else description="暂无订单数据" style="padding: 60px 0;" />

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
        <div class="detail-header">
          <div class="detail-header-left">
            <span class="detail-order-no">{{ currentOrder.orderNo }}</span>
            <el-tag :type="orderStatusTagType(currentOrder.orderStatus)" size="small">{{ currentOrder.orderStatus }}</el-tag>
            <el-tag v-if="getDisplayPurchaseStatus(currentOrder)" :type="purchaseStatusTagType(getDisplayPurchaseStatus(currentOrder))" size="small" effect="plain">{{ getDisplayPurchaseStatus(currentOrder) }}</el-tag>
            <el-link v-if="currentOrder.purchaseStatus === '未采购'" type="info" :underline="false" style="margin-left:2px;font-size:12px" @click.stop="handleIgnorePurchase(currentOrder)">忽略</el-link>
          </div>
          <span class="detail-order-time">{{ currentOrder.orderTime }}</span>
        </div>

        <div class="detail-section">
          <h4 class="detail-section-title">订单信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">出库单号</span><span class="detail-value">{{ currentOrder.outboundNo || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">店铺名称</span><span class="detail-value">{{ currentOrder.shopName }}</span></div>
            <div class="detail-row"><span class="detail-label">支付方式</span><span class="detail-value">{{ currentOrder.paymentMethod }}</span></div>
            <div class="detail-row"><span class="detail-label">客户名称</span><span class="detail-value">{{ currentOrder.customerName }}</span></div>
            <div class="detail-row"><span class="detail-label">买家账号</span><span class="detail-value">{{ currentOrder.buyerAccount || '--' }}</span></div>
          </div>
        </div>

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

        <div class="detail-section">
          <h4 class="detail-section-title">物流信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">物流公司</span><span class="detail-value">{{ currentOrder.logisticsCompany || '--' }}</span></div>
            <div class="detail-row"><span class="detail-label">物流单号</span><span class="detail-value">{{ currentOrder.logisticsNo || '--' }}</span></div>
          </div>
        </div>

        <div class="detail-section">
          <h4 class="detail-section-title">收货信息</h4>
          <div class="detail-grid-2col">
            <div class="detail-row"><span class="detail-label">收货人</span><span class="detail-value">{{ currentOrder.receiver }}</span></div>
            <div class="detail-row"><span class="detail-label">联系电话</span><span class="detail-value">{{ currentOrder.customerPhone }}</span></div>
          </div>
          <div class="detail-row" style="margin-top: 8px;"><span class="detail-label">收货地址</span><span class="detail-value">{{ currentOrder.address }}</span></div>
        </div>

        <div v-if="currentOrder.issueEvent" class="detail-section">
          <h4 class="detail-section-title">问题事件</h4>
          <el-tag type="warning">{{ currentOrder.issueEvent }}</el-tag>
        </div>

        <div class="detail-section">
          <h4 class="detail-section-title">备注信息</h4>
          <div class="detail-remark-box">
            <div class="detail-remark-label">商家备注：</div>
            <div class="detail-remark-content">{{ currentOrder.remark || '暂无商家备注' }}</div>
          </div>
          <div class="detail-remark-box">
            <div class="detail-remark-label">系统备注：</div>
            <div class="detail-remark-content">{{ currentOrder.sysRemark || '暂无系统备注' }}</div>
          </div>
        </div>

        <div class="detail-footer">
          <el-button size="small" @click="onDetailAction('viewOriginal')">查看原单</el-button>
          <el-button size="small" @click="onDetailAction('contactBuyer')">联系买家</el-button>
          <el-button size="small" @click="onDetailAction('printInvoice')">打印发票</el-button>
          <el-button type="primary" size="small" @click="onDetailAction('confirmShip')">确认发货</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 6. 采购弹窗 -->
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
          <div class="header-left">
            <div class="header-icon-wrapper">
              <el-icon class="header-icon"><ShoppingCart /></el-icon>
            </div>
            <div class="header-text">
              <h3 class="header-title">采购下单</h3>
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
      
      <!-- Step 1: idle 状态 - 信息+选账号 -->
      <div v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'idle'" class="purchase-content">
        <!-- 顶部：商品信息横幅 -->
        <div class="product-banner">
          <el-image v-if="purchaseInfo.image" :src="purchaseInfo.image" class="product-banner-image" fit="cover" />
          <div v-else class="product-banner-image product-banner-placeholder" :style="{ background: getItemColor(purchaseInfo.goodsName) }">
            <span class="product-initial">{{ purchaseInfo.goodsName.charAt(0) }}</span>
          </div>
          <div class="product-banner-info">
            <h4 class="product-name">{{ purchaseInfo.goodsName }}</h4>
            <p v-if="purchaseInfo.sku" class="product-sku">SKU: {{ purchaseInfo.sku }}</p>
            <div class="product-meta-row">
              <el-tag type="info" effect="plain" size="default">
                <el-icon><Tickets /></el-icon>
                数量: {{ purchaseInfo.quantity }}
              </el-tag>
              <el-tag type="warning" effect="plain" size="default">
                <el-icon><Document /></el-icon>
                采购编号: {{ purchaseInfo.purchaseNo }}
              </el-tag>
              <el-tag type="success" effect="plain" size="default">
                <el-icon><Connection /></el-icon>
                订单号: {{ purchaseInfo.salesOrderNo }}
              </el-tag>
            </div>
          </div>
        </div>

        <!-- 主体内容区 -->
        <div class="purchase-main-content">
          <!-- 左侧：配置区 -->
          <div class="config-section">
            <div class="section-header">
              <el-icon><Setting /></el-icon>
              <span>采购配置</span>
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
                <div class="detail-area">
                  <div class="inline-detail-card">
                    <div class="detail-row">
                      <span class="detail-label">采购单价</span>
                      <el-input-number v-model="purchaseInfo.purchasePrice" :min="0" :precision="2" :step="1" class="price-input" />
                    </div>
                    <div class="detail-row full-width">
                      <span class="detail-label">备注信息</span>
                      <el-input v-model="purchaseInfo.remark" type="textarea" :rows="3" placeholder="选填" class="remark-input" />
                    </div>
                  </div>
                </div>
              </div>

              <div class="form-row">
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
                      1688
                    </el-radio-button>
                  </el-radio-group>
                </div>

                <div class="form-group">
                  <label class="form-label required">采购类型</label>
                  <el-radio-group v-model="purchaseInfo.purchaseType" class="type-selector">
                    <el-radio-button value="dropship">
                      <el-icon><Van /></el-icon>
                      三方代发
                    </el-radio-button>
                    <el-radio-button value="warehouse">
                      <el-icon><OfficeBuilding /></el-icon>
                      仓库发货
                    </el-radio-button>
                  </el-radio-group>
                </div>
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
                <label class="form-label" :class="{ required: purchaseInfo.purchaseType === 'warehouse' }">选择仓库</label>
                <el-select v-model="purchaseInfo.warehouseId" :placeholder="purchaseInfo.purchaseType === 'dropship' ? '选填（用于获取收货手机号）' : '请选择发货仓库'" class="full-width-select" clearable @change="onWarehouseChange">
                  <el-option v-for="wh in warehouseList" :key="wh.id" :label="wh.name" :value="wh.id" />
                </el-select>
                <div v-if="warehouseList.length === 0" class="form-warning">
                  <el-icon><Warning /></el-icon>
                  <span>暂无仓库，请先在「仓库管理」页面添加</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 右侧：信息区 -->
          <div class="info-section">
            <div class="info-card address-info-card">
              <div class="card-header">
                <el-icon><Location /></el-icon>
                <span>收货地址</span>
              </div>
              <div class="card-body">
                <div v-if="purchaseInfo.shippingName || purchaseInfo.shippingPhone" class="address-contact-row">
                  <span class="contact-name">{{ purchaseInfo.shippingName }}</span>
                  <span v-if="purchaseInfo.shippingPhone" class="contact-phone">{{ purchaseInfo.shippingPhone }}</span>
                </div>
                <div v-if="purchaseInfo.shippingAddress" class="address-detail">{{ purchaseInfo.shippingAddress }}</div>
                <div v-if="!purchaseInfo.shippingName && !purchaseInfo.shippingAddress" class="empty-address">
                  <el-icon><InfoFilled /></el-icon>
                  <span>选择仓库后自动填充地址</span>
                </div>
                <div class="address-footer">
                  <el-tag size="default" :type="purchaseInfo.purchaseType === 'dropship' ? 'success' : 'warning'" effect="light" class="address-type-badge">
                    {{ purchaseInfo.purchaseType === 'dropship' ? '三方代发模式' : '仓库发货模式' }}
                  </el-tag>
                  <el-button
                    v-if="purchaseInfo.purchaseType === 'dropship'"
                    type="primary"
                    text
                    size="default"
                    :loading="purchaseInfo._sensitiveLoading"
                    class="get-real-info-btn"
                    @click="handleRevealBuyerInfoInPurchase"
                  >
                    <el-icon><View /></el-icon>
                    <span>获取真实信息</span>
                  </el-button>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>

      <!-- Step 1: ordering 状态 - 等待下单 -->
      <div v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'ordering'" style="text-align:center;padding:40px 20px">
        <el-icon :size="48" style="color:#409eff;margin-bottom:16px" class="is-loading"><Loading /></el-icon>
        <h3 style="margin:0 0 12px">正在等待下单完成...</h3>
        <p style="color:#909399;font-size:13px">请在弹出的窗口中完成下单操作，系统将自动获取订单号</p>
      </div>

      <!-- Step 1: captured 状态 - 成功 -->
      <div v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'captured'" style="text-align:center;padding:40px 20px">
        <el-icon :size="48" style="color:#67c23a;margin-bottom:16px"><CircleCheck /></el-icon>
        <h3 style="margin:0 0 12px;color:#67c23a">采购订单已自动创建并绑定</h3>
        <p style="color:#606266;font-size:14px">平台订单号：<strong>{{ purchaseInfo.capturedOrderNo }}</strong></p>
      </div>

      <!-- Step 2: 手动输入回退 -->
      <div v-if="purchaseInfo.step === 2">
        <el-alert type="warning" :closable="false" style="margin-bottom:16px"
          title="未能自动获取订单号" description="请手动输入在采购平台购买后的订单号完成绑定。" />
        <div class="purchase-goods-preview" style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #ebeef5;">
          <el-image v-if="purchaseInfo.image" :src="purchaseInfo.image" style="width:64px;height:64px;border-radius:8px;flex-shrink:0;" fit="cover" />
          <div v-else style="width:64px;height:64px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;" :style="{ background: getItemColor(purchaseInfo.goodsName) }">
            <span style="color:#fff;font-size:20px;font-weight:700;">{{ purchaseInfo.goodsName.charAt(0) }}</span>
          </div>
          <div style="min-width:0;">
            <p style="margin:0 0 4px;font-size:14px;font-weight:600;color:#1f2937;line-height:1.4;">{{ purchaseInfo.goodsName }}</p>
            <p v-if="purchaseInfo.sku" style="margin:0;font-size:12px;color:#9ca3af;">{{ purchaseInfo.sku }}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#606266;">采购数量：{{ purchaseInfo.quantity }}</p>
          </div>
        </div>
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="采购编号">
            <span style="color: #e6a23c; font-weight: 600">{{ purchaseInfo.purchaseNo }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="采购平台">{{ platformLabel(purchaseInfo.platform) }}</el-descriptions-item>
        </el-descriptions>
        <el-form style="margin-top: 16px" label-width="110px">
          <el-form-item label="平台订单号" required>
            <el-input v-model="purchaseInfo.platformOrderNo" placeholder="请输入在淘宝/拼多多购买后的订单号" clearable />
          </el-form-item>
          <el-form-item label="实际采购单价">
            <el-input-number v-model="purchaseInfo.purchasePrice" :min="0" :precision="2" :step="1" style="width: 180px" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="purchaseInfo.remark" type="textarea" :rows="2" placeholder="选填" />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <!-- idle: 去下单 -->
        <template v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'idle'">
          <el-button @click="purchaseDialogVisible = false">取消</el-button>
          <el-button type="primary" :disabled="!purchaseInfo.sourceUrl.trim() || !purchaseInfo.selectedAccountId" @click="handleGoOrder">去下单</el-button>
        </template>
        <!-- ordering: 等待中 -->
        <template v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'ordering'">
          <el-button @click="handleCancelOrder">取消下单</el-button>
          <el-button type="warning" plain @click="purchaseInfo.step = 2">手动输入订单号</el-button>
        </template>
        <!-- captured: 完成 -->
        <template v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'captured'">
          <el-button type="primary" @click="purchaseDialogVisible = false">完成</el-button>
        </template>
        <!-- Step 2: 手动输入 -->
        <template v-if="purchaseInfo.step === 2">
          <el-button @click="purchaseInfo.step = 1; purchaseInfo.captureStatus = 'idle'">上一步</el-button>
          <el-button type="primary" :loading="purchaseInfo.submitting" :disabled="!purchaseInfo.platformOrderNo.trim()" @click="handlePurchaseSubmit">确认绑定</el-button>
        </template>
      </template>
    </el-dialog>

    <!-- 货源管理弹窗 -->
    <el-dialog
      v-model="sourceManageVisible"
      :title="`管理货源 - ${purchaseInfo.goodsName}`"
      width="580px"
      align-center
      destroy-on-close
    >
      <el-table :data="skuSources" stripe border size="small" style="margin-bottom:12px;" :header-cell-style="{ background: '#f5f7fa', fontWeight: 600 }">
        <el-table-column label="平台" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="platformTagType(row.platform)">{{ platformLabel(row.platform) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="链接" min-width="180">
          <template #default="{ row }">
            <el-link :href="row.purchase_link" target="_blank" style="font-size:12px;">{{ row.purchase_link }}</el-link>
          </template>
        </el-table-column>
        <el-table-column label="采购价" width="90" align="right">
          <template #default="{ row }">
            <span v-if="row.purchase_price" style="color:#f56c6c;">¥{{ Number(row.purchase_price).toFixed(2) }}</span>
            <span v-else style="color:#c0c4cc;">--</span>
          </template>
        </el-table-column>
        <el-table-column label="备注" prop="remark" min-width="100" show-overflow-tooltip />
        <el-table-column label="操作" width="160" align="center" fixed="right">
          <template #default="{ row, $index }">
            <el-button link type="primary" size="small" @click="applySourceToPurchase($index); sourceManageVisible = false;">选择</el-button>
            <el-button link type="warning" size="small" @click="openEditSourceForm(row, $index)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDeleteSource(row, $index)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-button type="primary" size="small" @click="openAddSourceForm">
        <el-icon><Plus /></el-icon>
        <span style="margin-left:4px;">新增货源</span>
      </el-button>
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
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Refresh, Van, ChatDotRound, ShoppingCart, OfficeBuilding, Loading, CircleCheck, Plus, Edit, Delete, Link, Message, View, ArrowRight, Setting, ShoppingBag, Shop, Warning, InfoFilled, Connection, Document, Tickets, Box } from '@element-plus/icons-vue'
import { fetchStores, updateStoreSyncTime } from '@/api/store'
import { fetchSalesOrders, fetchSalesOrderStatusCounts, saveSalesOrders, updateBuyerInfo, updateSalesOrderPurchaseStatus } from '@/api/salesOrder'
import { createPurchaseOrder, bindPlatformOrderNo, fetchNextPurchaseNo } from '@/api/purchaseOrder'
import { fetchSkuPurchaseConfigList, saveSkuPurchaseConfig, deleteSkuPurchaseConfig, detectPlatformFromUrl } from '@/api/skuPurchaseConfig'
import { fetchPurchaseAccounts } from '@/api/purchaseAccount'
import { fetchWarehouses } from '@/api/warehouse'

// ==================== 筛选项配置 ====================

const orderStatusOptions = ['待付款', '待出库', '已出库', '暂停订单', '已完成', '已取消']
const issueEventOptions = ['超时未发货', '库存不足', '物流异常', '客户拒收']

const AVATAR_COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#7986cb', '#f06292', '#aed581', '#ff8a65']

// ==================== 状态 ====================

const storeOptions = ref([])
const tableData = ref([])
const total = ref(0)
const statusCounts = ref({ total: 0, counts: {} })
const loading = ref(false)

const searchForm = reactive({
  storeId: '',
  orderNo: '',
  goodsName: '',
  outboundNo: '',
  customerName: '',
  purchaseStatus: '',
  storeTag: '',
  issueEvent: ''
})

const activeStatus = ref('待出库')
const currentPage = ref(1)
const pageSize = ref(10)
const selectAll = ref(false)

// 同步状态（拆分为独立变量，避免竞态条件）
const manualSyncStatus = ref('')       // 手动同步状态
const autoSyncStatus = ref('')         // 渲染进程自动同步状态
const mainProcessSyncStatus = ref('')  // 主进程自动同步状态
const syncSkipStatus = ref('')         // 跳过的店铺信息

// 同步状态文本（用于显示在小字区域）
const syncStatusText = computed(() => {
  if (syncSkipStatus.value) return syncSkipStatus.value
  if (manualSyncStatus.value) return manualSyncStatus.value
  if (autoSyncStatus.value) return autoSyncStatus.value
  if (mainProcessSyncStatus.value) return mainProcessSyncStatus.value
  return ''
})

// ==================== 功能区 ====================

const funcSettings = reactive({
  autoOutbound: true,
  largeLogistics: true,
  syncJdOrder: false,  // 默认关闭
  syncPurchaseOrder: true
})

let jdOrderSyncTimer = null

function onFuncChange(key, value) {
  console.log(`[功能区开关] ${key}: ${value}`)
  
  if (key === 'syncJdOrder') {
    if (value) {
      // 开启京东订单自动同步
      console.log('[自动同步] 开启京东订单自动同步')
      startJdOrderAutoSync()
      ElMessage.success('已开启京东订单自动同步（每10分钟）')
    } else {
      // 关闭京东订单自动同步
      console.log('[自动同步] 关闭京东订单自动同步')
      stopJdOrderAutoSync()
      ElMessage.info('已关闭京东订单自动同步')
    }
  }
}

function startJdOrderAutoSync() {
  // 立即执行一次
  syncAllUserStores()
  
  // 每10分钟执行一次
  jdOrderSyncTimer = setInterval(() => {
    syncAllUserStores()
  }, 10 * 60 * 1000)
}

function stopJdOrderAutoSync() {
  if (jdOrderSyncTimer) {
    clearInterval(jdOrderSyncTimer)
    jdOrderSyncTimer = null
  }
}

async function syncAllUserStores() {
  console.log('[自动同步] 开始同步当前用户的所有京东店铺')
  
  try {
    // 获取当前用户的所有京东店铺
    const data = await fetchStores({ platform: 'jd', store_type: 'pop', status: 'enabled', pageSize: 100 })
    const stores = data.list || []
    
    if (stores.length === 0) {
      console.log('[自动同步] 当前用户没有京东店铺')
      return
    }
    
    console.log(`[自动同步] 找到 ${stores.length} 个京东店铺，开始逐个同步`)
    
    // 逐个同步店铺
    for (let i = 0; i < stores.length; i++) {
      const store = stores[i]
      console.log(`[自动同步] [${i + 1}/${stores.length}] 检查店铺: ${store.name} (ID:${store.id})`)
      
      // 检查店铺最后同步时间
      const lastSyncAt = store.last_sync_at
      if (lastSyncAt) {
        const lastSyncTime = new Date(lastSyncAt).getTime()
        const now = Date.now()
        const minutesSinceLastSync = (now - lastSyncTime) / 1000 / 60
        
        console.log(`[自动同步] 店铺 ${store.name} 距上次同步: ${minutesSinceLastSync.toFixed(1)} 分钟`)
        
        // 如果10分钟内已同步，跳过
        if (minutesSinceLastSync < 10) {
          const remainingMinutes = Math.ceil(10 - minutesSinceLastSync)
          syncSkipStatus.value = `${store.name} ${remainingMinutes}分钟后同步`
          console.log(`[自动同步] 跳过店铺: ${store.name}，${remainingMinutes}分钟后再试`)
          // 3秒后清空跳过提示
          await new Promise(resolve => setTimeout(resolve, 3000))
          syncSkipStatus.value = ''
          continue
        }
      }
      
      console.log(`[自动同步] [${i + 1}/${stores.length}] 同步店铺: ${store.name} (ID:${store.id})`)
      
      try {
        // 同步开始前显示状态
        autoSyncStatus.value = `${store.name} 正在同步中...`
        
        // 确保状态显示至少500ms（让Vue有时间更新DOM）
        await new Promise(resolve => setTimeout(resolve, 500))
        
        const result = await window.electronAPI.invoke('fetch-sales-orders', {
          storeId: store.id
        })
        
        if (result.success) {
          const orders = result.data?.list || []
          console.log(`[自动同步] [${i + 1}/${stores.length}] 成功: ${orders.length} 条订单`)
          // 保存订单到服务器
          if (orders.length > 0) {
            try {
              await saveSalesOrders(store.id, orders)
              console.log(`[自动同步] [${i + 1}/${stores.length}] 已保存 ${orders.length} 条订单到服务器`)
            } catch (saveErr) {
              console.error(`[自动同步] [${i + 1}/${stores.length}] 保存订单失败:`, saveErr.message)
            }
          }
          // 更新服务器上的同步时间
          try {
            await updateStoreSyncTime(store.id)
          } catch (err) {
            console.error('[自动同步] 更新同步时间失败:', err.message)
          }
          // 静默更新状态计数（不影响用户当前浏览的表格）
          try {
            await loadStatusCounts()
          } catch (refreshErr) {
            console.error(`[自动同步] [${i + 1}/${stores.length}] 状态计数刷新失败:`, refreshErr.message)
          }
        } else {
          console.log(`[自动同步] [${i + 1}/${stores.length}] 失败: ${result.message}`)
        }
      } catch (err) {
        console.error(`[自动同步] [${i + 1}/${stores.length}] 异常:`, err.message)
      }
      // 注意：不在这里清空 autoSyncStatus，让它保持显示直到下一个店铺开始同步
      
      // 多店铺之间间隔 30 秒
      if (i < stores.length - 1) {
        console.log('[自动同步] 等待 30 秒后同步下一个店铺...')
        await new Promise(resolve => setTimeout(resolve, 30000))
      }
    }
    
    // 所有店铺同步完成后，清空状态
    autoSyncStatus.value = ''
    
    console.log('[自动同步] 所有店铺同步完成')
  } catch (err) {
    console.error('[自动同步] 同步异常:', err.message)
  }
}

// 组件卸载时清理定时器（在后面的 onUnmounted 中统一处理）

// ==================== 数据加载 ====================

async function loadStores() {
  try {
    const data = await fetchStores({ platform: 'jd', store_type: 'pop', status: 'enabled', pageSize: 100 })
    storeOptions.value = data.list || []
    // 默认不选中任何店铺，即"全部店铺"
  } catch (err) {
    console.error('加载店铺列表失败:', err.message)
  }
}

function getStoreNameById(storeId) {
  const store = storeOptions.value.find(s => s.id === storeId)
  return store ? store.name : ''
}

function getItemColor(name) {
  if (!name) return AVATAR_COLORS[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function getOriginalImg(url) {
  if (!url) return ''
  return url.replace(/\/n\d\//, '/n0/')
}

function mapServerOrder(row) {
  let items = []
  try {
    const parsed = typeof row.all_items === 'string' ? JSON.parse(row.all_items || 'null') : row.all_items
    if (Array.isArray(parsed)) {
      items = parsed.map(item => ({
        name: item.name || '',
        sku: item.skuId ? `SKU: ${item.skuId}` : '',
        price: parseFloat(item.price) || 0,
        quantity: item.quantity || 0,
        image: item.image || '',
        imageColor: getItemColor(item.name)
      }))
    }
  } catch {}

  if (items.length === 0 && row.product_name) {
    items = [{
      name: row.product_name,
      sku: row.sku_id ? `SKU: ${row.sku_id}` : '',
      price: parseFloat(row.unit_price) || 0,
      quantity: row.quantity || 0,
      image: row.product_image || '',
      imageColor: getItemColor(row.product_name)
    }]
  }

  let buyerAccount = ''
  try {
    const raw = typeof row.raw_data === 'string' ? JSON.parse(row.raw_data || 'null') : row.raw_data
    if (raw) buyerAccount = raw.buyerAccount || ''
  } catch {}

  return {
    id: row.id,
    selected: false,
    orderNo: row.order_id,
    orderStatus: STATUS_ALIAS_MAP[row.status_text] || row.status_text || '',
    purchaseStatus: row.purchase_status || '未采购',
    hasInventory: row.has_inventory || false,
    orderTime: row.order_time || '',
    amount: parseFloat(row.goods_amount) || 0,
    shippingFee: parseFloat(row.shipping_fee) || 0,
    actualAmount: parseFloat(row.total_amount) || 0,
    paymentMethod: row.payment_method || '',
    customerName: row.buyer_name || '',
    receiver: row.buyer_name || '',
    customerPhone: row.buyer_phone || '',
    buyerAccount,
    address: row.buyer_address || '',
    logisticsCompany: row.logistics_company || '',
    logisticsNo: row.logistics_no || '',
    outboundNo: row.logistics_no || '',
    shopName: row.store_name || getStoreNameById(row.store_id),
    shopTag: '京东',
    items,
    issueEvent: null,
    remark: row.remark || '',
    sysRemark: row.sys_remark || '',
    timeoutStatus: 'normal'
  }
}

async function loadOrdersFromServer() {
  try {
    const params = {
      page: currentPage.value,
      pageSize: pageSize.value
    }
    if (searchForm.storeId) params.store_id = searchForm.storeId
    if (activeStatus.value) params.status = activeStatus.value
    if (searchForm.storeTag) params.store_tag = searchForm.storeTag
    if (searchForm.orderNo) params.order_id = searchForm.orderNo
    if (searchForm.goodsName) params.goods_name = searchForm.goodsName
    if (searchForm.customerName) params.customer_name = searchForm.customerName
    if (searchForm.purchaseStatus) params.purchase_status = searchForm.purchaseStatus
    if (searchForm.outboundNo) params.outbound_no = searchForm.outboundNo
    const data = await fetchSalesOrders(params)
    const list = (data.list || []).map(mapServerOrder)
    tableData.value = list
    total.value = data.total || 0
  } catch (err) {
    console.warn('从服务器加载订单失败:', err.message)
  }
}

// 状态名称标准化映射（与后端保持一致，防止数据库中存在旧名称）
const STATUS_ALIAS_MAP = {
  '等待付款': '待付款',
  '等待出库': '待出库',
  '锁定': '暂停订单',
  '暂停': '暂停订单',
  '已发货': '已出库',
}

async function loadStatusCounts() {
  try {
    const params = {}
    if (searchForm.storeId) params.store_id = searchForm.storeId
    if (searchForm.storeTag) params.store_tag = searchForm.storeTag
    if (searchForm.orderNo) params.order_id = searchForm.orderNo
    if (searchForm.goodsName) params.goods_name = searchForm.goodsName
    if (searchForm.customerName) params.customer_name = searchForm.customerName
    if (searchForm.purchaseStatus) params.purchase_status = searchForm.purchaseStatus
    if (searchForm.outboundNo) params.outbound_no = searchForm.outboundNo
    const data = await fetchSalesOrderStatusCounts(params)
    // request.js 在 token 失效时可能返回完整 JSON { code:1, message:'...' } 而非 json.data
    if (!data || typeof data !== 'object') return
    if (data.code !== undefined && data.total === undefined) return
    // 标准化状态名称（处理后端未更新的情况）
    const normalizedCounts = {}
    for (const [key, val] of Object.entries(data.counts || {})) {
      const normalizedKey = STATUS_ALIAS_MAP[key] || key
      normalizedCounts[normalizedKey] = (normalizedCounts[normalizedKey] || 0) + val
    }
    statusCounts.value = { total: data.total || 0, counts: normalizedCounts }
  } catch (err) {
    console.warn('加载状态计数失败:', err.message)
  }
}

// ==================== 操作栏 ====================

function handleQueryOrders() {
  currentPage.value = 1
  loadOrdersFromServer()
  loadStatusCounts()
}

async function handleSyncOrders() {
  if (!searchForm.storeId) {
    ElMessage.warning('请先选择一个京东店铺')
    return
  }

  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }

  // 显示正在同步的店铺名
  const currentStore = storeOptions.value.find(s => s.id === searchForm.storeId)
  const storeName = currentStore ? currentStore.name : '店铺'
  manualSyncStatus.value = storeName

  loading.value = true
  activeStatus.value = ''
  try {
    const result = await window.electronAPI.invoke('fetch-sales-orders', {
      storeId: searchForm.storeId
    })

    if (result.success) {
      const orders = result.data.list || []
      if (orders.length === 0) {
        ElMessage.info('未获取到订单数据')
      } else {
        ElMessage.success(`成功获取 ${orders.length} 条订单，正在保存...`)
        try {
          await saveSalesOrders(searchForm.storeId, orders)
        } catch (saveErr) {
          console.warn('保存订单到服务器失败:', saveErr.message)
        }
        await loadOrdersFromServer()
        loadStatusCounts()
      }
      // 无论是否有订单，都更新同步时间，防止自动同步重复触发
      try {
        await updateStoreSyncTime(searchForm.storeId)
      } catch (err) {
        console.error('[手动同步] 更新同步时间失败:', err.message)
      }
    } else {
      ElMessage({ message: result.message || '获取订单失败', type: 'error', center: true })
    }
  } catch (err) {
    ElMessage({ message: '获取订单失败: ' + err.message, type: 'error', center: true })
  } finally {
    loading.value = false
    manualSyncStatus.value = ''
  }
}

function handleOpenChat(order) {
  if (!order.buyerAccount) return
  const pin = encodeURIComponent(order.buyerAccount)
  const url = `https://im.jd.com/index?customerPin=${pin}`
  if (window.electronAPI) {
    window.electronAPI.invoke('open-external-url', { url })
  } else {
    window.open(url, '_blank')
  }
}

async function handleRevealBuyerInfo(order) {
  if (order._sensitiveLoading) return
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  if (!searchForm.storeId) {
    ElMessage.warning('请先选择店铺')
    return
  }

  order._sensitiveLoading = true
  try {
    const result = await window.electronAPI.invoke('fetch-buyer-sensitive-info', {
      storeId: searchForm.storeId,
      orderId: order.orderNo
    })

    if (result.success && result.data) {
      const info = result.data
      if (info.buyerName) {
        order.customerName = info.buyerName
        order.receiver = info.buyerName
      }
      if (info.buyerPhone) order.customerPhone = info.buyerPhone
      if (info.buyerAddress) order.address = info.buyerAddress
      ElMessage.success('买家真实信息已获取')

      try {
        await updateBuyerInfo(searchForm.storeId, order.orderNo, info)
      } catch (e) {
        console.warn('[BuyerInfo] 回写服务器失败:', e.message)
      }
    } else {
      ElMessage.error(result.message || '获取买家信息失败')
    }
  } catch (err) {
    ElMessage.error('获取买家信息失败: ' + err.message)
  } finally {
    order._sensitiveLoading = false
  }
}

async function handleRevealBuyerInfoInPurchase() {
  if (purchaseInfo._sensitiveLoading) return
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  if (!searchForm.storeId) {
    ElMessage.warning('请先选择店铺')
    return
  }

  purchaseInfo._sensitiveLoading = true
  try {
    const result = await window.electronAPI.invoke('fetch-buyer-sensitive-info', {
      storeId: searchForm.storeId,
      orderId: purchaseInfo.salesOrderNo
    })

    if (result.success && result.data) {
      const info = result.data
      // 更新 purchaseInfo
      if (info.buyerName) {
        purchaseInfo.buyerName = info.buyerName
      }
      if (info.buyerPhone) {
        purchaseInfo.buyerPhone = info.buyerPhone
      }
      if (info.buyerAddress) {
        purchaseInfo.buyerAddress = info.buyerAddress
      }
      // 三方代发时同步更新收货地址
      if (purchaseInfo.purchaseType === 'dropship') {
        purchaseInfo.shippingName = purchaseInfo.buyerName
        purchaseInfo.shippingPhone = purchaseInfo.buyerPhone
        purchaseInfo.shippingAddress = purchaseInfo.buyerAddress
      }
      // 同步更新订单列表中的原始 order 对象
      const order = tableData.value.find(o => o.orderNo === purchaseInfo.salesOrderNo)
      if (order) {
        if (info.buyerName) {
          order.customerName = info.buyerName
          order.receiver = info.buyerName
        }
        if (info.buyerPhone) order.customerPhone = info.buyerPhone
        if (info.buyerAddress) order.address = info.buyerAddress
      }
      ElMessage.success('买家真实信息已获取')

      // 回写到服务器
      try {
        await updateBuyerInfo(searchForm.storeId, purchaseInfo.salesOrderNo, info)
      } catch (e) {
        console.warn('[BuyerInfo] 回写服务器失败:', e.message)
      }
    } else {
      ElMessage.error(result.message || '获取买家信息失败')
    }
  } catch (err) {
    ElMessage.error('获取买家信息失败: ' + err.message)
  } finally {
    purchaseInfo._sensitiveLoading = false
  }
}

async function handlePurchase(order, item, itemIdx) {
  let purchaseNo
  try {
    const res = await fetchNextPurchaseNo()
    purchaseNo = res.purchase_no || res.data?.purchase_no
    if (!purchaseNo) throw new Error('empty')
  } catch (e) {
    ElMessage.error('获取采购编号失败')
    return
  }

  purchaseInfo.step = 1
  purchaseInfo.purchaseNo = purchaseNo
  purchaseInfo.salesOrderNo = order.orderNo
  purchaseInfo.salesOrderId = order.id
  purchaseInfo.goodsName = item.name
  purchaseInfo.sku = item.sku || ''
  purchaseInfo.skuId = item.skuId || item.sku_id || item.sku || ''
  purchaseInfo.quantity = item.quantity
  purchaseInfo.image = item.image || ''
  purchaseInfo.sourceUrl = ''
  purchaseInfo.platform = 'taobao'
  purchaseInfo.platformOrderNo = ''
  purchaseInfo.purchasePrice = 0
  purchaseInfo.remark = ''
  purchaseInfo.selectedAccountId = null
  purchaseInfo.captureStatus = 'idle'
  purchaseInfo.capturedOrderNo = ''
  purchaseInfo.submitting = false
  // 采购类型 & 地址
  purchaseInfo.purchaseType = 'dropship'
  purchaseInfo.buyerName = order.customerName || ''
  purchaseInfo.buyerPhone = order.customerPhone || ''
  purchaseInfo.buyerAddress = order.address || ''
  purchaseInfo.warehouseId = null
  purchaseInfo.warehouseName = ''
  purchaseInfo.warehouseContact = ''
  purchaseInfo.warehousePhone = ''
  purchaseInfo.warehouseAddress = ''
  // 三方代发收货信息将在仓库加载后由 updateDropshipShipping() 完善手机号
  // 姓名去掉[编号]，地址追加【派件联系{虚拟号}-{编号}】
  const initNameCodeMatch = (order.customerName || '').match(/\[(\d+)\]/)
  const initNameCode = initNameCodeMatch ? initNameCodeMatch[1] : ''
  purchaseInfo.shippingName = (order.customerName || '').replace(/\[\d+\]/, '').trim()
  purchaseInfo.shippingPhone = ''
  let initAddr = (order.address || '').replace(/\.?\[\d+\]/, '').trim()
  if (order.customerPhone && initNameCode) {
    initAddr = initAddr + '【派件联系' + order.customerPhone + '-' + initNameCode + '】'
  }
  purchaseInfo.shippingAddress = initAddr
  purchaseDialogVisible.value = true

  // 注册 IPC 事件监听（用 try-catch 保护，避免阻断后续 API 加载）
  try {
    setupPurchaseListeners()
  } catch (e) {
    console.warn('[采购下单] IPC监听注册失败:', e.message)
  }

  // 加载采购账号列表（每次打开都重新加载，确保数据最新）
  try {
    const res = await fetchPurchaseAccounts()
    console.log('[采购下单] 采购账号API返回:', JSON.stringify(res))
    const rawList = res && res.list ? res.list : (Array.isArray(res) ? res : [])
    purchaseAccounts.value = rawList.map(a => ({
      ...a,
      username: a.account || a.username || '',
      status: a.online ? 'online' : 'offline'
    }))
  } catch (e) {
    console.warn('[采购下单] 加载采购账号失败:', e.message)
    ElMessage.warning('加载采购账号失败: ' + e.message)
  }

  // 加载仓库列表（每次打开都重新加载）
  try {
    const wRes = await fetchWarehouses()
    console.log('[采购下单] 仓库API返回:', JSON.stringify(wRes))
    if (wRes && wRes.list) {
      warehouseList.value = wRes.list
    } else if (Array.isArray(wRes)) {
      warehouseList.value = wRes
    } else {
      warehouseList.value = []
      console.warn('[采购下单] 仓库API返回格式异常:', wRes)
    }
  } catch (e) {
    console.warn('[采购下单] 加载仓库失败:', e.message)
    ElMessage.warning('加载仓库失败: ' + e.message)
  }
  // 如果只有一个仓库，自动选中并更新收货地址
  if (warehouseList.value.length === 1) {
    applyWarehouseAddress(warehouseList.value[0])
    if (purchaseInfo.purchaseType === 'dropship') {
      updateDropshipShipping()
    } else if (purchaseInfo.purchaseType === 'warehouse') {
      updateWarehouseShipping()
    }
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
      // 兼容多种后端返回格式
      if (res.list && Array.isArray(res.list)) {
        list = res.list
      } else if (Array.isArray(res)) {
        list = res
      } else if (res.purchase_link !== undefined) {
        list = [res]
      }
      skuSources.value = list
      // 默认选中第一条
      if (list.length > 0) {
        selectedSourceIndex.value = 0
        applySourceToPurchase(0)
      }
    }
  } catch (e) {
    console.warn('加载SKU货源列表失败:', e.message)
  }
}

// 将选中的货源填充到采购信息
function applySourceToPurchase(index) {
  const source = skuSources.value[index]
  if (!source) return
  selectedSourceIndex.value = index
  purchaseInfo.sourceUrl = source.purchase_link || ''
  purchaseInfo.platform = source.platform || detectPlatformFromUrl(source.purchase_link) || 'taobao'
  purchaseInfo.purchasePrice = source.purchase_price || 0
  purchaseInfo.remark = source.remark || ''
}

// 打开货源管理弹窗
function openSourceManage() {
  sourceManageVisible.value = true
}

// 打开新增货源表单
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

// 打开编辑货源表单
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

// 货源链接变化时自动识别平台
function onSourceUrlChange(url) {
  const detected = detectPlatformFromUrl(url)
  if (detected && !sourceForm.platform) {
    sourceForm.platform = detected
  }
}

// 保存货源
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

// 删除货源
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

// 采购弹窗相关
const purchaseDialogVisible = ref(false)
const purchaseAccounts = ref([])
const purchaseInfo = reactive({
  step: 1,
  purchaseNo: '',
  salesOrderNo: '',
  salesOrderId: '',
  goodsName: '',
  sku: '',
  skuId: '',
  quantity: 0,
  image: '',
  sourceUrl: '',
  platform: 'taobao',
  platformOrderNo: '',
  purchasePrice: 0,
  remark: '',
  selectedAccountId: null,
  captureStatus: 'idle', // idle | ordering | captured
  capturedOrderNo: '',
  submitting: false,
  purchaseType: 'dropship', // dropship(三方代发) | warehouse(仓库发货)
  shippingName: '',
  shippingPhone: '',
  shippingAddress: '',
  buyerName: '',
  buyerPhone: '',
  buyerAddress: '',
  warehouseId: null,
  warehouseName: '',
  warehouseContact: '',
  warehousePhone: '',
  warehouseAddress: '',
  _sensitiveLoading: false
})

// 货源管理
const skuSources = ref([])
const selectedSourceIndex = ref(-1)
const sourceManageVisible = ref(false)
const sourceFormVisible = ref(false)
const sourceFormMode = ref('add')
const warehouseList = ref([])
const sourceForm = reactive({
  id: null,
  sku_id: '',
  purchase_link: '',
  platform: '',
  purchase_price: 0,
  remark: ''
})

// 按平台过滤采购账号
const filteredPurchaseAccounts = computed(() => {
  return purchaseAccounts.value.filter(acc => acc.platform === purchaseInfo.platform)
})

// 应用仓库地址到采购信息
function applyWarehouseAddress(wh) {
  if (!wh) return
  purchaseInfo.warehouseId = wh.id
  purchaseInfo.warehouseName = wh.name || ''
  purchaseInfo.warehouseContact = wh.contact || ''
  purchaseInfo.warehousePhone = wh.phone || ''
  purchaseInfo.warehouseAddress = wh.location || wh.address || ''
}

// 三方代发：手机号=仓库手机号，姓名去掉[编号]，地址+【派件联系{虚拟号}-{编号}】
function updateDropshipShipping() {
  // 从买家姓名中提取编号并去掉，如 "苏宝宝[3899]" -> 姓名"苏宝宝"，编号"3899"
  const nameCodeMatch = (purchaseInfo.buyerName || '').match(/\[(\d+)\]/)
  const nameCode = nameCodeMatch ? nameCodeMatch[1] : ''
  purchaseInfo.shippingName = (purchaseInfo.buyerName || '').replace(/\[\d+\]/, '').trim()
  purchaseInfo.shippingPhone = purchaseInfo.warehousePhone || purchaseInfo.buyerPhone || ''
  // 地址也去掉.[编号]或[编号]，再追加派件联系后缀
  let addr = (purchaseInfo.buyerAddress || '').replace(/\.?\[\d+\]/, '').trim()
  if (purchaseInfo.buyerPhone && nameCode) {
    addr = addr + '【派件联系' + purchaseInfo.buyerPhone + '-' + nameCode + '】'
  }
  purchaseInfo.shippingAddress = addr
}

// 仓库发货：地址=仓库地址+采购编号
function updateWarehouseShipping() {
  purchaseInfo.shippingName = purchaseInfo.warehouseContact || purchaseInfo.warehouseName
  purchaseInfo.shippingPhone = purchaseInfo.warehousePhone
  let addr = purchaseInfo.warehouseAddress || ''
  if (purchaseInfo.purchaseNo) {
    addr = addr + ' ' + purchaseInfo.purchaseNo
  }
  purchaseInfo.shippingAddress = addr
}

// 仓库下拉切换时更新地址
function onWarehouseChange(whId) {
  const wh = warehouseList.value.find(w => w.id === whId)
  if (wh) {
    applyWarehouseAddress(wh)
  } else {
    // 清空仓库信息
    purchaseInfo.warehouseId = null
    purchaseInfo.warehouseName = ''
    purchaseInfo.warehouseContact = ''
    purchaseInfo.warehousePhone = ''
    purchaseInfo.warehouseAddress = ''
  }
  if (purchaseInfo.purchaseType === 'dropship') {
    updateDropshipShipping()
  } else if (purchaseInfo.purchaseType === 'warehouse') {
    updateWarehouseShipping()
  }
}

// 采购类型切换时自动更新收货地址
watch(() => purchaseInfo.purchaseType, (type) => {
  if (type === 'dropship') {
    updateDropshipShipping()
  } else if (type === 'warehouse') {
    updateWarehouseShipping()
  }
})

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
  // 如果没有记住的，选第一个
  if (filteredPurchaseAccounts.value.length > 0) {
    purchaseInfo.selectedAccountId = filteredPurchaseAccounts.value[0].id
  } else {
    purchaseInfo.selectedAccountId = null
  }
})

function platformLabel(val) {
  const map = { taobao: '淘宝/天猫', pinduoduo: '拼多多', '1688': '1688' }
  return map[val] || val
}

function platformTagType(val) {
  const map = { taobao: 'danger', pinduoduo: 'warning', '1688': '', douyin: 'success' }
  return map[val] || 'info'
}

// 精简URL显示：提取核心链接，去除追踪参数
function shortenUrl(url) {
  if (!url) return ''
  try {
    const u = new URL(url)
    // 淘宝/天猫：只保留 id 参数
    if (u.hostname.includes('taobao.com') || u.hostname.includes('tmall.com')) {
      const id = u.searchParams.get('id')
      return id ? `${u.origin}${u.pathname}?id=${id}` : url
    }
    // 1688：只保留 offerId
    if (u.hostname.includes('1688.com')) {
      const offerId = u.searchParams.get('offerId')
      if (offerId) return `${u.origin}${u.pathname}?offerId=${offerId}`
      const match = u.pathname.match(/\/offer\/(\d+)/)
      if (match) return `${u.origin}/offer/${match[1]}.html`
      return url
    }
    // 拼多多：只保留 goods_id
    if (u.hostname.includes('yangkeduo') || u.hostname.includes('pinduoduo')) {
      const gid = u.searchParams.get('goods_id') || u.searchParams.get('goodsId')
      return gid ? `${u.origin}${u.pathname}?goods_id=${gid}` : url
    }
    // 其他：去除常见追踪参数
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

// 打开货源链接
function openSourceLink(url) {
  if (window.electronAPI) {
    window.electronAPI.invoke('open-external-url', { url })
  } else {
    window.open(url, '_blank')
  }
}

// 去下单：打开内嵌BrowserWindow
function handleGoOrder() {
  const url = purchaseInfo.sourceUrl.trim()
  if (!url) {
    ElMessage.warning('请输入货源链接')
    return
  }
  if (!purchaseInfo.selectedAccountId) {
    ElMessage.warning('请选择采购账号')
    return
  }
  if (purchaseInfo.purchaseType === 'warehouse' && !purchaseInfo.warehouseId) {
    ElMessage.warning('请选择发货仓库')
    return
  }

  let finalUrl = url
  if (!/^https?:\/\//i.test(finalUrl)) {
    finalUrl = 'https://' + finalUrl
  }

  // 记住使用的账号
  localStorage.setItem('lastPurchaseAccount_' + purchaseInfo.platform, String(purchaseInfo.selectedAccountId))

  // 获取选中的采购账号名称和密码
  const selectedAccount = purchaseAccounts.value.find(acc => acc.id === purchaseInfo.selectedAccountId)
  const accountName = selectedAccount ? (selectedAccount.username || selectedAccount.name || '') : ''
  const accountPassword = selectedAccount ? (selectedAccount.password || '') : ''

  // 调用主进程打开采购窗口
  if (window.electronAPI) {
    window.electronAPI.invoke('open-purchase-order-window', {
      accountId: purchaseInfo.selectedAccountId,
      accountName: accountName,
      password: accountPassword,
      purchaseUrl: finalUrl,
      platform: purchaseInfo.platform,
      purchaseInfo: {
        purchaseNo: purchaseInfo.purchaseNo,
        salesOrderId: purchaseInfo.salesOrderId,
        salesOrderNo: purchaseInfo.salesOrderNo,
        goodsName: purchaseInfo.goodsName,
        image: purchaseInfo.image,
        sku: purchaseInfo.sku,
        skuId: purchaseInfo.skuId,
        quantity: purchaseInfo.quantity,
        purchasePrice: purchaseInfo.purchasePrice,
        remark: purchaseInfo.remark,
        sourceUrl: finalUrl,
        purchaseType: purchaseInfo.purchaseType,
        shippingName: purchaseInfo.shippingName,
        shippingPhone: purchaseInfo.shippingPhone,
        shippingAddress: purchaseInfo.shippingAddress
      }
    })
  }

  purchaseInfo.captureStatus = 'ordering'
}

// 取消下单：关闭采购窗口
function handleCancelOrder() {
  if (window.electronAPI) {
    window.electronAPI.invoke('close-purchase-order-window', { purchaseNo: purchaseInfo.purchaseNo })
  }
  purchaseInfo.captureStatus = 'idle'
}

// IPC 事件监听
let unsubOrderCaptured = null
let unsubWindowClosed = null
let unsubAddressFilled = null
let unsubAddressSetupDone = null
let unsubAddressSetupStart = null
let unsubAutoSyncStart = null
let unsubAutoSyncResult = null
let unsubStoreStatusChanged = null

function setupPurchaseListeners() {
  if (!window.electronAPI) return
  // 先清理旧监听器，防止重复注册导致泄漏
  cleanupPurchaseListeners()
  unsubOrderCaptured = window.electronAPI.onUpdate('purchase-order-captured', (data) => {
    if (data.purchaseNo === purchaseInfo.purchaseNo) {
      purchaseInfo.capturedOrderNo = data.platformOrderNo
      if (data.success === false) {
        purchaseInfo.captureStatus = 'captured'
        ElMessage.warning(`订单号已捕获(${data.platformOrderNo})，但自动绑定失败: ${data.error || '未知错误'}，请手动绑定`)
      } else {
        purchaseInfo.captureStatus = 'captured'
        ElMessage.success('采购订单已自动创建并绑定')
        // 立即更新tableData中对应订单的sysRemark和采购状态，无需刷新
        if (data.salesOrderId) {
          const order = tableData.value.find(o => o.id === data.salesOrderId)
          if (order) {
            if (data.sysRemark) {
              order.sysRemark = data.sysRemark
              order.sys_remark = data.sysRemark
            }
            // 根据采购类型更新采购状态
            order.purchaseStatus = purchaseInfo.purchaseType === 'warehouse' ? '已采购（仓库转发）' : '已采购（三方代发）'
            order.hasInventory = false
          }
        }
        // 成功后自动关闭对话框（释放遮罩层，恢复侧边栏可点击）
        setTimeout(() => { purchaseDialogVisible.value = false }, 1500)
        // 刷新采购账号列表（更新在线状态）
        fetchPurchaseAccounts().then(res => {
          const rawList = res && res.list ? res.list : (Array.isArray(res) ? res : [])
          purchaseAccounts.value = rawList.map(a => ({
            ...a,
            username: a.account || a.username || '',
            status: a.online ? 'online' : 'offline'
          }))
        }).catch(() => {})
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
      // 窗口关闭时刷新采购账号在线状态（用户可能手动登录了）
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
      const typeLabel = purchaseInfo.purchaseType === 'dropship' ? '买家收货地址' : '仓库发货地址'
      ElMessage({
        message: `${typeLabel}已自动填充（共${data.filledCount}个字段），请核对后提交订单`,
        type: 'success',
        duration: 5000
      })
    }
  })
  unsubAddressSetupDone = window.electronAPI.onUpdate('purchase-address-setup-done', (data) => {
    if (data.purchaseNo === purchaseInfo.purchaseNo) {
      ElMessage({
        message: '地址已修改成功',
        type: 'success',
        duration: 3000
      })
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
}

function cleanupPurchaseListeners() {
  if (unsubOrderCaptured) { unsubOrderCaptured(); unsubOrderCaptured = null }
  if (unsubWindowClosed) { unsubWindowClosed(); unsubWindowClosed = null }
  if (unsubAddressFilled) { unsubAddressFilled(); unsubAddressFilled = null }
  if (unsubAddressSetupDone) { unsubAddressSetupDone(); unsubAddressSetupDone = null }
  if (unsubAddressSetupStart) { unsubAddressSetupStart(); unsubAddressSetupStart = null }
}

function onPurchaseDialogClosed() {
  // 对话框关闭回调，清理状态由 Element Plus 自身处理
  // 侧边栏已通过 z-index: 2100 保证始终在 el-overlay 之上
}

async function handlePurchaseSubmit() {
  if (!purchaseInfo.platformOrderNo.trim()) {
    ElMessage.warning('请输入平台订单号')
    return
  }

  purchaseInfo.submitting = true
  try {
    // 1. 创建采购单
    await createPurchaseOrder({
      purchase_no: purchaseInfo.purchaseNo,
      sales_order_id: purchaseInfo.salesOrderId,
      sales_order_no: purchaseInfo.salesOrderNo,
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

    // 2. 绑定平台订单号
    await bindPlatformOrderNo(purchaseInfo.purchaseNo, {
      platform_order_no: purchaseInfo.platformOrderNo.trim()
    })

    ElMessage.success('采购单创建并绑定成功')
    // 更新本地订单的采购状态
    const order = tableData.value.find(o => o.id === purchaseInfo.salesOrderId)
    if (order) {
      order.purchaseStatus = purchaseInfo.purchaseType === 'warehouse' ? '已采购（仓库转发）' : '已采购（三方代发）'
      order.hasInventory = false
    }
    purchaseDialogVisible.value = false
  } catch (err) {
    ElMessage.error('采购操作失败: ' + err.message)
  } finally {
    purchaseInfo.submitting = false
  }
}

function handleBindWarehouse(order, item, itemIdx) {
  console.log('[绑定仓库商品] 订单:', order.orderNo, '商品:', item.name, '索引:', itemIdx)
  ElMessage.info(`绑定仓库商品功能开发中：${item.name}`)
}

function handleSearchTitle(item, platform) {
  console.log('[搜标题] 平台:', platform, '商品:', item.name)
  ElMessage.info(`搜标题功能开发中（${platform}）：${item.name}`)
}

function handleSearchImage(item, platform) {
  console.log('[搜图片] 平台:', platform, '商品:', item.name)
  ElMessage.info(`搜图片功能开发中（${platform}）：${item.name}`)
}

// ==================== 计算属性 ====================

// 获取店铺名称
function getStoreName(storeId) {
  const store = storeOptions.value.find(s => s.id === storeId)
  return store ? store.name : ''
}

// 获取店铺在线状态
function getStoreOnlineStatus(storeId) {
  const store = storeOptions.value.find(s => s.id === storeId)
  return store ? store.online : false
}

// 店铺标签选项（从所有店铺的 tags 字段汇总去重）
const storeTagOptions = computed(() => {
  const tagSet = new Set()
  for (const s of storeOptions.value) {
    let tags = s.tags
    // 兼容 tags 为 JSON 字符串的情况
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags) } catch { tags = null }
    }
    if (Array.isArray(tags)) {
      tags.forEach(t => {
        if (t && typeof t === 'string') tagSet.add(t.trim())
      })
    }
  }
  return [...tagSet].sort()
})

// 按标签过滤的店铺列表（用于"选择店铺"下拉联动）
const filteredStoreOptions = computed(() => {
  if (!searchForm.storeTag) return storeOptions.value
  return storeOptions.value.filter(s => {
    let tags = s.tags
    if (typeof tags === 'string') {
      try { tags = JSON.parse(tags) } catch { tags = null }
    }
    return Array.isArray(tags) && tags.some(t => t && t.trim() === searchForm.storeTag)
  })
})

// 服务端分页，tableData 已经是当前页的数据
const pagedOrders = computed(() => tableData.value)

const statusTabs = computed(() => {
  const sc = statusCounts.value
  // 不显示数量的状态：全部、已完成、已取消
  const noCountSet = new Set(['', '已完成', '已取消'])
  return [
    { label: '全部', value: '', count: noCountSet.has('') ? null : sc.total },
    ...orderStatusOptions.map((s) => ({ label: s, value: s, count: noCountSet.has(s) ? null : (sc.counts[s] || 0) }))
  ]
})

const nearTimeoutCount = computed(() => tableData.value.filter((o) => o.timeoutStatus === 'nearTimeout').length)
const timeoutCount = computed(() => tableData.value.filter((o) => o.timeoutStatus === 'timeout').length)

// ==================== 选择功能 ====================

function handleSelectAll(val) {
  pagedOrders.value.forEach((order) => {
    order.selected = val
  })
}

function handleOrderSelect() {
  selectAll.value = pagedOrders.value.length > 0 && pagedOrders.value.every((o) => o.selected)
}

// ==================== 详情抽屉 ====================

const drawerVisible = ref(false)
const currentOrder = ref(null)

function handleView(row) {
  currentOrder.value = row
  drawerVisible.value = true
}

function handleSmsNotify(order) {
  console.log('[短信通知] 订单:', order.orderNo, '客户电话:', order.customerPhone)
  ElMessage.info(`短信通知功能开发中：${order.customerPhone || '无手机号'}`)
}

function handleEditRemark(order) {
  ElMessageBox.prompt('请输入备注内容', '编辑商家备注', {
    confirmButtonText: '保存',
    cancelButtonText: '取消',
    inputValue: order.remark || '',
    inputType: 'textarea'
  }).then(({ value }) => {
    order.remark = (value || '').trim()
    console.log('[备注] 订单:', order.orderNo, '备注:', order.remark)
    ElMessage.success('备注已保存')
  }).catch(() => {})
}

// ==================== 交互方法 ====================

function handleReset() {
  Object.assign(searchForm, {
    orderNo: '',
    goodsName: '',
    outboundNo: '',
    customerName: '',
    purchaseStatus: '',
    storeTag: '',
    issueEvent: ''
  })
  activeStatus.value = ''
  currentPage.value = 1
}

function handleStatusClick(status) {
  activeStatus.value = status
  currentPage.value = 1
  loadOrdersFromServer()
}

function handleSizeChange() {
  currentPage.value = 1
  loadOrdersFromServer()
}

function handleCurrentChange() {
  loadOrdersFromServer()
}

function onDetailAction(action) {
  console.log(`[详情操作] ${action}`, currentOrder.value?.orderNo)
}

// ==================== Tag 类型映射 ====================

function orderStatusTagType(status) {
  const map = { '待付款': 'warning', '待出库': 'danger', '已出库': '', '暂停订单': 'warning', '已完成': 'success', '已取消': 'info' }
  return map[status] || ''
}

function purchaseStatusTagType(status) {
  const map = { '未采购': 'warning', '已采购（三方代发）': 'success', '已采购（仓库转发）': '', '仓库有货': '', '已忽略': 'info' }
  return map[status] || ''
}

function getDisplayPurchaseStatus(order) {
  if (order.purchaseStatus === '未采购' && order.hasInventory) return '仓库有货'
  return order.purchaseStatus
}

async function handleIgnorePurchase(order) {
  try {
    await updateSalesOrderPurchaseStatus(order.id, '已忽略')
    order.purchaseStatus = '已忽略'
    order.hasInventory = false
  } catch (err) {
    ElMessage.error('操作失败: ' + err.message)
  }
}

function statusBorderColor(status) {
  const map = {
    '待付款': '#e6a23c',
    '待出库': '#f56c6c',
    '已出库': '#409eff',
    '已完成': '#52c41a',
    '已取消': '#909399'
  }
  return map[status] || '#dcdfe6'
}

function statusBgColor(status) {
  const map = {
    '待付款': 'linear-gradient(135deg, #fffcf5 0%, #fff8eb 100%)',
    '待出库': 'linear-gradient(135deg, #fff5f5 0%, #fff0f0 100%)',
    '已出库': 'linear-gradient(135deg, #f0f7ff 0%, #e8f4ff 100%)',
    '已完成': 'linear-gradient(135deg, #f0faf0 0%, #e8f8e8 100%)',
    '已取消': 'linear-gradient(135deg, #fafafa 0%, #f5f5f5 100%)'
  }
  return map[status] || 'linear-gradient(135deg, #fafafa 0%, #f5f5f5 100%)'
}

// ==================== 生命周期 ====================

watch(() => searchForm.storeId, () => {
  activeStatus.value = ''
  currentPage.value = 1
  loadOrdersFromServer()
  loadStatusCounts()
})

watch(() => searchForm.storeTag, () => {
  // 如果当前选中的店铺不在标签过滤范围内，清空店铺选择
  if (searchForm.storeId && searchForm.storeTag) {
    const inFiltered = filteredStoreOptions.value.some(s => s.id === searchForm.storeId)
    if (!inFiltered) searchForm.storeId = ''
  }
  activeStatus.value = ''
  currentPage.value = 1
  loadOrdersFromServer()
  loadStatusCounts()
})

onMounted(async () => {
  await loadStores()
  loadOrdersFromServer()
  loadStatusCounts()

  // 监听自动同步事件
  if (window.electronAPI) {
    unsubAutoSyncStart = window.electronAPI.onUpdate('auto-sync-start', (data) => {
      mainProcessSyncStatus.value = data.storeName || '店铺'
    })
    unsubAutoSyncResult = window.electronAPI.onUpdate('auto-sync-result', async (data) => {
      mainProcessSyncStatus.value = ''
      // 订单已由主进程直接保存到服务器，此处只做刷新
      if (data.success) {
        loadOrdersFromServer()
        loadStatusCounts()
      }
    })
    // 监听店铺在线状态变化（心跳检测），重新加载店铺列表即可
    unsubStoreStatusChanged = window.electronAPI.onUpdate('store-status-changed', () => {
      loadStores()
    })
  }
})

onUnmounted(() => {
  // 确保对话框关闭（防止 el-overlay 遮罩层残留）
  purchaseDialogVisible.value = false
  // 清理采购相关 IPC 监听器
  cleanupPurchaseListeners()
  // 清理自动同步 IPC 监听器
  if (unsubAutoSyncStart) { unsubAutoSyncStart(); unsubAutoSyncStart = null }
  if (unsubAutoSyncResult) { unsubAutoSyncResult(); unsubAutoSyncResult = null }
  if (unsubStoreStatusChanged) { unsubStoreStatusChanged(); unsubStoreStatusChanged = null }
  manualSyncStatus.value = ''
  autoSyncStatus.value = ''
  mainProcessSyncStatus.value = ''
  // 清理京东订单自动同步定时器
  stopJdOrderAutoSync()
})
</script>

<style scoped>
.page-container {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ==================== 筛选栏 + 功能区 ==================== */

.filter-panel {
  background: #fff;
  border-radius: 8px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  display: flex;
  overflow: hidden;
}

.filter-main {
  flex: 1;
  padding: 16px 20px;
  min-width: 0;
  border-right: 1px solid #f0f0f0;
}

.filter-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px 16px;
}

/* 筛选栏按钮 */
.filter-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
  flex-wrap: wrap;
}

/* 筛选栏统计信息 */
.filter-stats {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-left: auto;
}

.filter-stat {
  font-size: 12px;
  color: #6b7280;
}

/* 功能区统计信息 */
.func-stats {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #f0f0f0;
  flex-wrap: wrap;
}

.func-stat {
  font-size: 12px;
  color: #6b7280;
}

/* 店铺选择器前缀样式 */
.store-select-prefix {
  display: flex;
  align-items: center;
  font-size: 14px;
}

.filter-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-label {
  font-size: 13px;
  color: #606266;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

:deep(.filter-item .el-input),
:deep(.filter-item .el-select) {
  flex: 1;
  min-width: 0;
}

/* 功能区（横向3列） */
.func-panel {
  display: flex;
  gap: 24px;
  padding: 14px 20px;
  flex-shrink: 0;
}

.func-group {
  min-width: 0;
}

.func-group-title {
  font-size: 13px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 8px;
}

.func-item {
  margin-bottom: 6px;
}

.func-item:last-child {
  margin-bottom: 0;
}

.func-item-header {
  display: flex;
  align-items: center;
  gap: 10px;
}

.func-item-label {
  font-size: 12px;
  color: #303133;
  white-space: nowrap;
}

.func-item-desc {
  font-size: 11px;
  color: #9ca3af;
  margin: 2px 0 0;
  line-height: 1.3;
  white-space: nowrap;
  transition: color 0.3s ease;
}

.func-item-desc.sync-status-active {
  color: #e6a23c;
  font-weight: 500;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
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
  padding: 8px 16px;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #f0f0f0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
  gap: 16px;
}

.action-left {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 10px 36px;
  font-size: 14px;
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

.auto-sync-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 10px;
  font-size: 13px;
  color: #e6a23c;
  font-weight: 500;
}

.sync-skip-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 10px;
  font-size: 13px;
  color: #909399;
  font-weight: 500;
}

.sync-spin {
  animation: spin 1.2s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.action-btn-green {
  background: #52c41a;
}

.action-center {
  display: flex;
  gap: 20px;
  flex: 1;
  justify-content: center;
}

.action-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.action-right-label {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.action-stat {
  font-size: 13px;
  color: #606266;
  white-space: nowrap;
}

.stat-num {
  font-style: normal;
  color: #f5222d;
  font-weight: 700;
  font-size: 15px;
}

/* ==================== 状态统计栏 ==================== */

.stats-bar {
  display: flex;
  gap: 4px;
  padding: 0 4px;
}

.stat-item {
  padding: 6px 16px;
  font-size: 14px;
  color: #6b7280;
  cursor: pointer;
  border-radius: 16px;
  transition: all 0.2s;
  white-space: nowrap;
  background: transparent;
}

.stat-item:hover {
  color: #2b5aed;
  background: rgba(43, 90, 237, 0.06);
}

.stat-item.active {
  color: #ffffff;
  font-weight: 500;
  background: #2b5aed;
}

.stat-count {
  font-size: 12px;
  margin-left: 2px;
}

/* ==================== 卡片式订单列表 ==================== */

.table-card {
  background: #fff;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02);
  padding: 0;
  overflow: hidden;
}

/* 表头 */
.order-table-header {
  display: flex;
  align-items: center;
  background: linear-gradient(180deg, #f8f9fb 0%, #f3f4f6 100%);
  border-bottom: 1px solid #e5e7eb;
  padding: 11px 0;
  font-size: 13px;
  font-weight: 600;
  color: #374151;
  letter-spacing: 0.2px;
}

.order-table-header-left {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  padding-left: 10px;
  padding-right: 0;
}

.order-table-header-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  border-left: 1px solid #f0f0f0;
  background: linear-gradient(180deg, #f8f9fb 0%, #f3f4f6 100%);
  padding-right: 14px;
}

.order-table-header .ot-col {
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 列宽定义 */
.ot-col-check {
  width: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ot-col-goods {
  width: 420px;
  flex-shrink: 0;
  padding: 0 8px 0 0;
}

/* 商品信息单元格 */

.ot-col-price {
  width: 110px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-purchase {
  width: 120px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
}

/* 内容区域采购列 - 居中对齐 */
.order-body-left .ot-col-purchase {
  align-items: center;
  justify-content: center;
  padding: 8px;
}

.ot-col-warehouse {
  display: none;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

.ot-col-amount {
  width: 130px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 4px;
}

.ot-col-time {
  width: 150px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-logistics {
  width: 140px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 4px;
}

.ot-col-remark {
  width: 340px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 4px;
}

.ot-col-action {
  width: 110px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 8px;
}

/* 订单列表 */
.order-list {
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* 订单卡片 */
.order-card {
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  overflow: hidden;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  background: #fff;
}

.order-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08), 0 2px 6px rgba(0, 0, 0, 0.04);
  transform: translateY(-1px);
  border-color: #d0d5dd;
}

/* 订单卡片头部（第一行：核心信息区） */
.order-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  padding: 8px 14px;
  font-size: 12px;
  transition: all 0.2s;
}

/* 订单卡片底部：买家信息区 */
.order-card-footer-buyer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 12px;
  background: #f8f9fb;
  border-top: 1px solid rgba(0, 0, 0, 0.05);
}

.order-buyer-label,
.order-address-label {
  color: #9ca3af;
  flex-shrink: 0;
}

.order-buyer-name {
  color: #111827;
  font-weight: 600;
}

.order-buyer-phone {
  color: #6b7280;
  font-family: monospace;
}

.order-address-text {
  color: #6b7280;
  font-size: 12px;
  max-width: 500px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}

.order-contact-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #2b5aed;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  padding: 2px 8px;
  border-radius: 4px;
  transition: background 0.2s;
}

.order-contact-btn:hover {
  background: #eef2ff;
}

.order-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.order-header-label {
  color: #6b7280;
  flex-shrink: 0;
  font-weight: 500;
}

.order-header-no {
  font-weight: 700;
  color: #111827;
  flex-shrink: 0;
  letter-spacing: 0.3px;
}

.order-header-divider {
  color: #e5e7eb;
  flex-shrink: 0;
}

.order-header-shop {
  color: #374151;
  font-weight: 600;
  flex-shrink: 0;
}

.order-header-chat-icon {
  font-size: 15px;
  color: #2b5aed;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.2s;
}

.order-header-chat-icon:hover {
  color: #1a3fc7;
  transform: scale(1.15);
}

.order-header-account {
  color: #2b5aed;
  font-weight: 600;
  flex-shrink: 0;
}

.order-header-buyer {
  color: #111827;
  font-weight: 600;
  flex-shrink: 0;
}

.order-header-phone {
  color: #6b7280;
  flex-shrink: 0;
}

.order-header-address {
  color: #9ca3af;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.order-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: 12px;
}

.order-header-time {
  font-size: 12px;
  color: #6b7280;
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
  white-space: nowrap;
}

/* 订单卡片内容 */
.order-card-body {
  display: flex;
  background: #fff;
  padding: 0;
}

.order-card-body .order-body-left {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding-left: 1px;
  padding-right: 0;
}

.order-card-body .order-body-right {
  display: flex;
  align-items: stretch;
  flex-shrink: 0;
  border-left: 1px solid #f0f0f0;
  background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%);
  padding-right: 14px;
}

.product-row {
  display: flex;
  align-items: center;
  padding: 8px 0;
  min-height: 86px;
  transition: background 0.15s;
}

.product-row:hover {
  background: #f9fafb;
}

.product-row-border {
  border-bottom: 1px dashed #e5e7eb;
}

/* 商品信息单元格 */
.goods-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.goods-img {
  width: 70px;
  height: 70px;
  border-radius: 6px;
  flex-shrink: 0;
  object-fit: cover;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08);
  transition: transform 0.2s;
}

.goods-img:hover {
  transform: scale(1.05);
}

:deep(.goods-img .el-image__inner) {
  border-radius: 6px;
}

.goods-img-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: none;
}

.goods-img-text {
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
}

.goods-info {
  min-width: 0;
}

.goods-name {
  font-size: 13px;
  font-weight: 600;
  color: #111827;
  margin: 0 0 3px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.goods-sku {
  font-size: 12px;
  color: #9ca3af;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goods-sku-row {
  display: flex !important;
  align-items: center !important;
  gap: 8px;
  margin-top: 4px;
}

.goods-search-links {
  display: flex;
  align-items: center;
  gap: 10px;
}

.goods-search-link {
  font-size: 12px;
  color: #2b5aed;
  cursor: pointer;
  white-space: nowrap;
  font-weight: 500;
}

.goods-search-link:hover {
  color: #1a3fc7;
  text-decoration: underline;
}

.search-platform-list {
  display: flex;
  align-items: center;
  gap: 6px;
}

.search-platform-item {
  font-size: 13px;
  color: #2b5aed;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: background 0.2s;
}

.search-platform-item:hover {
  background: #eef2ff;
  color: #1a3fc7;
}

.search-platform-divider {
  color: #d9d9d9;
  font-size: 12px;
}

/* 单价数量 */
.price-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.price-value {
  font-size: 13px;
  color: #1f2937;
  font-weight: 500;
}

.price-qty {
  font-size: 12px;
  color: #9ca3af;
}

/* 右侧订单级信息列样式 */
.order-body-right .ot-col-amount,
.order-body-right .ot-col-logistics,
.order-body-right .ot-col-remark {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px 8px;
  position: relative;
}

.order-body-right .ot-col-action {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  padding: 12px 8px;
  position: relative;
}

.order-body-right .ot-col-action .el-button {
  margin-left: 0 !important;
}

.order-body-right .ot-col-amount::after,
.order-body-right .ot-col-time::after,
.order-body-right .ot-col-logistics::after,
.order-body-right .ot-col-remark::after {
  content: '';
  position: absolute;
  right: 0;
  top: 20%;
  height: 60%;
  width: 1px;
  background: #f0f0f0;
}

.amount-main {
  font-size: 15px;
  font-weight: 700;
  color: #f5222d;
  font-family: 'DIN Alternate', 'Roboto Mono', monospace;
}

.amount-sub {
  font-size: 11px;
  color: #9ca3af;
  margin: 4px 0 0;
}

.time-text {
  font-size: 12px;
  color: #4b5563;
  text-align: center;
  line-height: 1.5;
  word-break: break-all;
}

.logistics-company {
  font-size: 12px;
  color: #374151;
  margin: 0;
  text-align: center;
  font-weight: 500;
}

.logistics-no {
  font-size: 11px;
  color: #2b5aed;
  margin: 3px 0 0;
  text-align: center;
  word-break: break-all;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.logistics-no:hover {
  text-decoration: underline;
}

.text-muted {
  color: #d1d5db;
  font-size: 13px;
}

.remark-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
}

.remark-item {
  display: flex;
  align-items: flex-start;
  gap: 4px;
  font-size: 12px;
}

.remark-label {
  color: #9ca3af;
  flex-shrink: 0;
  font-size: 11px;
}

.remark-text {
  font-size: 12px;
  color: #4b5563;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
  flex: 1;
  min-width: 0;
}

/* 商家备注蓝色字体 */
.remark-text-merchant {
  color: #2b5aed;
  font-weight: 500;
}

.remark-edit-btn {
  padding: 0;
  font-size: 12px;
  flex-shrink: 0;
  margin-left: 2px;
}

/* 分页 */
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  padding: 12px 16px;
  border-top: 1px solid #f0f0f0;
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

.detail-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 20px;
  margin-top: 20px;
  border-top: 1px solid #f0f0f0;
}

/* 采购下单对话框 - 现代卡片风格 */
.purchase-dialog-modern {
  border-radius: 12px;
  overflow: hidden;
}

.purchase-dialog-modern :deep(.el-dialog__header) {
  padding: 20px 24px;
  border-bottom: 1px solid #e5e7eb;
  margin: 0;
}

.purchase-dialog-modern :deep(.el-dialog__body) {
  padding: 20px 24px;
  background: #f5f7fa;
}

.purchase-dialog-modern :deep(.el-dialog__footer) {
  padding: 16px 24px;
  border-top: 1px solid #e5e7eb;
}

.dialog-header-modern {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-icon {
  font-size: 20px;
  color: #2b5aed;
}

.header-title {
  font-size: 18px;
  font-weight: 600;
  color: #1f2937;
}

/* 信息卡片 */
.info-card {
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  padding: 20px;
  margin-bottom: 16px;
}

.info-card:last-child {
  margin-bottom: 0;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.card-title .el-icon {
  font-size: 18px;
  color: #2b5aed;
}

.card-title span {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}

/* 商品预览 */
.goods-preview-modern {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.goods-thumb {
  width: 80px;
  height: 80px;
  border-radius: 8px;
  flex-shrink: 0;
}

.goods-thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
}

.goods-details {
  flex: 1;
  min-width: 0;
}

.goods-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
  line-height: 1.5;
}

.goods-sku-text {
  margin: 0 0 8px;
  font-size: 13px;
  color: #9ca3af;
}

.goods-meta {
  display: flex;
  gap: 8px;
}

.order-info-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 8px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-label {
  font-size: 12px;
  color: #6b7280;
}

.info-value {
  font-size: 14px;
  color: #1f2937;
  font-weight: 500;
}

.purchase-no-text {
  color: #e6a23c;
  font-weight: 600;
}

/* 现代表单 */
.modern-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.modern-form :deep(.el-form-item__label) {
  font-size: 13px;
  font-weight: 500;
  color: #374151;
  padding-bottom: 6px;
}

/* 货源卡片列表 */
.source-card-list {
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 12px;
}

.source-card {
  padding: 12px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.source-card:hover {
  background: #ecf5ff;
  border-color: #409eff;
}

.source-card-active {
  background: #ecf5ff;
  border-color: #409eff;
}

.source-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.source-price-tag {
  font-size: 14px;
  color: #f56c6c;
  font-weight: 600;
}

.source-link-text {
  font-size: 13px;
  color: #409eff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-tip {
  color: #909399;
  font-size: 13px;
  margin-bottom: 12px;
}

.add-source-btn-modern {
  width: 100%;
}

/* 按钮组 */
.platform-btn-group,
.type-btn-group {
  width: 100%;
}

.platform-btn-group :deep(.el-radio-button),
.type-btn-group :deep(.el-radio-button) {
  flex: 1;
}

.platform-btn-group :deep(.el-radio-button__inner),
.type-btn-group :deep(.el-radio-button__inner) {
  width: 100%;
}

.full-select {
  width: 100%;
}

.account-option-modern {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.warning-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #e6a23c;
  font-size: 12px;
  margin-top: 6px;
}

/* 地址卡片 */
.address-card-modern {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
}

.address-header {
  margin-bottom: 8px;
}

.address-name {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  margin-right: 12px;
}

.address-phone {
  font-size: 13px;
  color: #606266;
}

.address-content {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  margin-bottom: 12px;
}

.address-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #c0c4cc;
  font-size: 13px;
  padding: 20px 0;
}

.address-footer-modern {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid #e5e7eb;
}

.address-type-label {
  flex-shrink: 0;
}

.reveal-info-btn {
  flex-shrink: 0;
}

.price-input-modern {
  width: 100%;
}

/* 采购下单对话框 - 横屏布局 */
.purchase-dialog-landscape {
  border-radius: 12px;
  overflow: hidden;
}

.purchase-dialog-landscape :deep(.el-dialog__header) {
  padding: 20px 24px;
  border-bottom: 1px solid #e5e7eb;
  margin: 0;
}

.purchase-dialog-landscape :deep(.el-dialog__body) {
  padding: 20px 24px;
  background: #f5f7fa;
  max-height: 75vh;
  overflow-y: auto;
}

.purchase-dialog-landscape :deep(.el-dialog__footer) {
  padding: 16px 24px;
  border-top: 1px solid #e5e7eb;
}

.landscape-layout {
  display: grid;
  grid-template-columns: 420px 1fr;
  gap: 16px;
}

.landscape-left {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.landscape-right {
  display: flex;
  flex-direction: column;
}

.source-config-card {
  height: 100%;
}

.source-config-card .info-card {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.source-config-card .modern-form {
  flex: 1;
  overflow-y: auto;
}

.source-card-list {
  max-height: 220px;
}

/* 信息卡片 */
.info-card {
  background: #ffffff;
  border-radius: 10px;
  border: 1px solid #e5e7eb;
  padding: 20px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
}

.card-title .el-icon {
  font-size: 18px;
  color: #2b5aed;
}

.card-title span {
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
}

/* 商品预览 */
.goods-preview-modern {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.goods-thumb {
  width: 80px;
  height: 80px;
  border-radius: 8px;
  flex-shrink: 0;
}

.goods-thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
}

.goods-initial {
  color: #fff;
  font-size: 24px;
  font-weight: 700;
}

.goods-details {
  flex: 1;
  min-width: 0;
}

.goods-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: #1f2937;
  line-height: 1.5;
}

.goods-sku-text {
  margin: 0 0 8px;
  font-size: 13px;
  color: #9ca3af;
}

.goods-meta {
  display: flex;
  gap: 8px;
}

.order-info-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 12px;
  background: #f9fafb;
  border-radius: 8px;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-label {
  font-size: 12px;
  color: #6b7280;
}

.info-value {
  font-size: 14px;
  color: #1f2937;
  font-weight: 500;
}

.purchase-no-text {
  color: #e6a23c;
  font-weight: 600;
}

/* 现代表单 */
.modern-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.modern-form :deep(.el-form-item__label) {
  font-size: 13px;
  font-weight: 500;
  color: #374151;
  padding-bottom: 6px;
}

/* 货源卡片列表 */
.source-card-list {
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 12px;
}

.source-card {
  padding: 12px;
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.source-card:hover {
  background: #ecf5ff;
  border-color: #409eff;
}

.source-card-active {
  background: #ecf5ff;
  border-color: #409eff;
}

.source-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.source-price-tag {
  font-size: 14px;
  color: #f56c6c;
  font-weight: 600;
}

.source-link-text {
  font-size: 13px;
  color: #409eff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-tip {
  color: #909399;
  font-size: 13px;
  margin-bottom: 12px;
}

.add-source-btn-modern {
  width: 100%;
}

/* 按钮组 */
.platform-btn-group,
.type-btn-group {
  width: 100%;
}

.platform-btn-group :deep(.el-radio-button),
.type-btn-group :deep(.el-radio-button) {
  flex: 1;
}

.platform-btn-group :deep(.el-radio-button__inner),
.type-btn-group :deep(.el-radio-button__inner) {
  width: 100%;
}

.full-select {
  width: 100%;
}

.account-option-modern {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.warning-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #e6a23c;
  font-size: 12px;
  margin-top: 6px;
}

/* 地址卡片 */
.address-card-modern {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 16px;
}

.address-header {
  margin-bottom: 8px;
}

.address-name {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
  margin-right: 12px;
}

.address-phone {
  font-size: 13px;
  color: #606266;
}

.address-content {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  margin-bottom: 12px;
}

.address-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #c0c4cc;
  font-size: 13px;
  padding: 20px 0;
}

.address-footer-modern {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid #e5e7eb;
}

.address-type-label {
  flex-shrink: 0;
}

.reveal-info-btn {
  flex-shrink: 0;
}

.price-input-modern {
  width: 100%;
}

/* 采购下单对话框 - 全新设计 */
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

.header-left {
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

.header-title {
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

/* 商品横幅 */
.product-banner {
  display: flex;
  gap: 16px;
  padding: 16px;
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8eaed;
  margin-bottom: 16px;
}

.product-banner-image {
  width: 80px;
  height: 80px;
  border-radius: 6px;
  flex-shrink: 0;
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

.product-banner-info {
  flex: 1;
  min-width: 0;
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

.product-meta-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.product-meta-row .el-tag {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 主体内容 */
.purchase-main-content {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: 16px;
}

/* 配置区 */
.config-section {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8eaed;
  padding: 20px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #f0f0f0;
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

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

/* 货源选择器 */
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

.detail-area {
  width: 200px;
  flex-shrink: 0;
  padding-top: 28px;
}

.inline-detail-card {
  background: #f8f9fb;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.inline-detail-card .detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.inline-detail-card .detail-row.full-width {
  flex-direction: column;
  align-items: flex-start;
}

.inline-detail-card .detail-label {
  font-size: 12px;
  color: #909399;
  white-space: nowrap;
  flex-shrink: 0;
}

.inline-detail-card .price-input {
  width: 120px;
}

.inline-detail-card .remark-input {
  width: 100%;
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

/* 平台/类型选择器 */
.platform-selector,
.type-selector {
  width: 100%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.platform-selector :deep(.el-radio-button),
.type-selector :deep(.el-radio-button) {
  flex: 1;
}

.platform-selector :deep(.el-radio-button__inner),
.type-selector :deep(.el-radio-button__inner) {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 12px;
}

.type-selector {
  grid-template-columns: repeat(2, 1fr);
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

/* 信息卡片 */
.info-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-card {
  background: #ffffff;
  border-radius: 8px;
  border: 1px solid #e8eaed;
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: #fafbfc;
  border-bottom: 1px solid #e8eaed;
}

.card-header .el-icon {
  font-size: 16px;
  color: #2b5aed;
}

.card-header span {
  font-size: 14px;
  font-weight: 600;
  color: #1f2937;
}

.card-body {
  padding: 16px;
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

.address-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
}

.address-type-badge {
  flex-shrink: 0;
}

.get-real-info-btn {
  flex-shrink: 0;
}

.order-reveal-btn {
  padding: 0 4px;
  margin-left: 4px;
  flex-shrink: 0;
}

.purchase-detail-card .card-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.detail-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.detail-row.full-width {
  flex: 1;
}

.detail-label {
  font-size: 12px;
  font-weight: 500;
  color: #6b7280;
}

.price-input {
  width: 100%;
}

.remark-input {
  width: 100%;
}
</style>
