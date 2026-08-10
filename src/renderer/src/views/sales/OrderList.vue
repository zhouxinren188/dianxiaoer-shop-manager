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
              <el-option label="有货（仓库直发）" value="有货（仓库直发）" />
              <el-option label="已采购（三方代发）" value="已采购（三方代发）" />
              <el-option label="已采购（仓库转发）" value="已采购（仓库转发）" />
              <el-option label="已采购（仓库进货）" value="已采购（仓库进货）" />
              <el-option label="仓库有货" value="仓库有货" />
              <el-option label="已忽略" value="已忽略" />
              <el-option label="无效订单" value="无效订单" />
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

    <!-- 2. 状态统计栏 -->
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
          :class="{ 'has-issue-watermark': order.issueEvent === '职业打假' || order.issueEvent === '疑似打假' }"
          v-for="(order, orderIdx) in pagedOrders"
          :key="order.id"
        >
          <!-- 职业打假/疑似打假水印覆盖层 -->
          <div v-if="order.issueEvent === '职业打假' || order.issueEvent === '疑似打假'" class="issue-watermark" :style="{ backgroundImage: `url(${getWatermarkUrl(order.issueEvent)})` }"></div>
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
              <span v-if="order.warehouseName" class="order-header-warehouse" :style="{color: order.warehouseName === '商家全国仓' ? '#909399' : order.warehouseName === '供应商仓库' ? '#67c23a' : '#409eff'}">[{{ order.warehouseName }}]</span>
              <el-tag :type="orderStatusTagType(order.orderStatus)" size="small">{{ order.orderStatus }}</el-tag>
              <span class="order-header-divider">|</span>
              <span class="order-header-time-label">下单时间：</span>
              <span class="order-header-time">{{ order.orderTime }}</span>
            </div>
            <div class="order-header-right">
              <el-button :type="order.issueEvent ? 'danger' : 'info'" link size="small" @click="handleMarkIssue(order)">
                <el-icon><Warning /></el-icon>
                <span>{{ order.issueEvent ? order.issueEvent : '标记问题' }}</span>
              </el-button>
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
                      <p class="goods-name goods-name-link" @click.stop="handleOpenProduct(order, item)">{{ item.name }}</p>
                      <p class="goods-sku" v-if="item.sku">{{ item.sku }}</p>
                      <div class="goods-status-row" v-if="getDisplayPurchaseStatus(order) || order.stockStatus">
                        <el-tag v-if="getDisplayPurchaseStatus(order)" :type="purchaseStatusTagType(getDisplayPurchaseStatus(order))" size="small" effect="plain">{{ getDisplayPurchaseStatus(order) }}</el-tag>
                        <el-link v-if="order.purchaseStatus === '未采购'" type="info" :underline="false" style="margin-left:2px;font-size:12px" @click.stop="handleIgnorePurchase(order)">忽略</el-link>
                        <el-tag v-if="order.stockStatus === 2" type="success" size="small">仓库直发</el-tag>
                        <el-tag v-if="order.stockStatus === 1" type="warning" size="small">延迟发货</el-tag>
                      </div>
                      <div class="goods-sku-row">
                        <div class="goods-search-links">
                          <el-popover placement="bottom-start" trigger="hover" :width="180">
                            <template #reference>
                              <span class="goods-search-link">搜标题</span>
                            </template>
                            <div class="search-platform-list">
                              <span class="search-platform-item" @click="handleSearchTitle(item, 'taobao')">淘宝</span>
                              <span class="search-platform-divider">|</span>
                              <span class="search-platform-item" @click="handleSearchTitle(item, '1688')">阿里巴巴</span>
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
                              <span class="search-platform-item" @click="handleSearchImage(item, '1688')">阿里巴巴</span>
                              <span class="search-platform-divider">|</span>
                              <span class="search-platform-item" @click="handleSearchImage(item, 'pdd')">拼多多</span>
                            </div>
                          </el-popover>
                        </div>
                      </div>
                      <!-- 库存信息（仅已绑定仓库的商品显示） -->
                      <div class="goods-inventory-info" v-if="item.inventoryInfo" @click.stop="openEditInventory(order, item)">
                        <span class="inv-tag inv-tag-stock" :class="{ 'inv-low': item.inventoryInfo.quantity <= 0 }">
                          库存 {{ item.inventoryInfo.quantity }}<template v-if="item.inventoryInfo.package_num > 1"> (x{{ item.inventoryInfo.package_num }}包装)</template>
                        </span>
                        <span class="inv-tag inv-tag-transit" v-if="item.inventoryInfo.in_transit_qty > 0">
                          在途 {{ item.inventoryInfo.in_transit_qty }}
                        </span>
                        <span class="inv-tag inv-tag-unpurchased" v-if="item.inventoryInfo.unpurchased_qty > 0">
                          待采 {{ item.inventoryInfo.unpurchased_qty }}
                        </span>
                        <span class="inv-tag inv-tag-delayed" v-if="item.inventoryInfo.delayed_qty > 0">
                          延迟 {{ item.inventoryInfo.delayed_qty }}
                        </span>
                        <span class="inv-warehouse">{{ item.inventoryInfo.warehouse_name }}</span>
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
                    <template v-if="order.orderStatus === '待付款'">
                      <el-tooltip content="待付款订单无需采购" placement="top">
                        <el-button type="info" size="small" plain style="width:90px;margin-left:0" disabled>
                          <el-icon><ShoppingCart /></el-icon>
                          <span>采购下单</span>
                        </el-button>
                      </el-tooltip>
                      <el-tooltip content="待付款订单无需绑定" placement="top">
                        <el-button type="info" size="small" plain style="width:90px;margin-left:0" disabled>
                          <el-icon><OfficeBuilding /></el-icon>
                          <span>绑定库存</span>
                        </el-button>
                      </el-tooltip>
                    </template>
                    <template v-else-if="order.orderStatus === '已取消'">
                      <el-tooltip content="已取消订单无需采购" placement="top">
                        <el-button type="info" size="small" plain style="width:90px;margin-left:0" disabled>
                          <el-icon><ShoppingCart /></el-icon>
                          <span>采购下单</span>
                        </el-button>
                      </el-tooltip>
                      <el-button type="primary" size="small" plain style="width:90px;margin-left:0" @click.stop="handleBindWarehouse(order, item, itemIdx)">
                        <el-icon><OfficeBuilding /></el-icon>
                        <span>绑定库存</span>
                      </el-button>
                    </template>
                    <template v-else>
                      <el-tooltip v-if="order.purchaseLockedBy" :content="`该订单目前有${order.purchaseLockedName || '其他用户'}在采购`" placement="top">
                        <el-button type="info" size="small" plain style="width:90px;margin-left:0" disabled>
                          <el-icon><Lock /></el-icon>
                          <span>采购中</span>
                        </el-button>
                      </el-tooltip>
                      <el-button v-else :type="skuHasSourcesCache[item.skuId || item.sku_id || item.sku] ? 'danger' : 'warning'" size="small" plain style="width:90px;margin-left:0" @click.stop="handlePurchase(order, item, itemIdx)">
                        <el-icon><ShoppingCart /></el-icon>
                        <span>采购下单</span>
                      </el-button>
                      <el-button type="primary" size="small" plain style="width:90px;margin-left:0" @click.stop="handleBindWarehouse(order, item, itemIdx)">
                        <el-icon><OfficeBuilding /></el-icon>
                        <span>绑定库存</span>
                      </el-button>
                    </template>
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
                    <span class="remark-label">留言:</span>
                    <span class="remark-text remark-text-buyer">{{ order.buyerMessage || '' }}</span>
                  </div>
                  <div class="remark-item">
                    <span class="remark-label">备注:</span>
                    <span class="remark-text remark-text-order">{{ order.orderRemark || '' }}</span>
                    <el-icon class="remark-edit-icon" @click.stop="handleEditOrderRemark(order)"><Edit /></el-icon>
                  </div>
                  <div class="remark-divider"></div>
                  <div class="remark-item">
                    <span class="remark-label">系统:</span>
                    <span class="remark-text">{{ order.sysRemark || '' }}</span>
                  </div>
                  <div class="remark-item">
                    <span class="remark-label">本地:</span>
                    <span class="remark-text remark-text-merchant">{{ order.remark || '' }}</span>
                    <el-icon class="remark-edit-icon" @click.stop="handleEditRemark(order)"><Edit /></el-icon>
                  </div>
                </div>
              </div>
              <div class="ot-col ot-col-action">
                <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;width:100%;">
                  <el-button type="primary" link size="small" @click="handleView(order)">查看详情</el-button>
                  <el-button v-if="isConsignmentOrder(order)" type="warning" link size="small" @click="handleGongxiaoDetail(order)">采购单详情</el-button>
                  <el-button type="success" link size="small" @click.stop="handleSmsNotify(order)">
                    <el-icon><Message /></el-icon>
                    <span>{{ order.smsSendCount > 0 ? '再次短信' : '短信' }}</span>
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
            <span v-if="order.buyerAccount" class="order-buyer-account">账号: {{ order.buyerAccount }}</span>
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
            <div v-if="currentOrder.warehouseName" class="detail-row"><span class="detail-label">发货仓库</span><span class="detail-value" :style="{color: currentOrder.warehouseName === '商家全国仓' ? '#909399' : currentOrder.warehouseName === '供应商仓库' ? '#67c23a' : '#409eff'}">{{ currentOrder.warehouseName }}</span></div>
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
            <div class="detail-remark-label">买家留言：</div>
            <div class="detail-remark-content remark-text-buyer">{{ currentOrder.buyerMessage || '暂无买家留言' }}</div>
          </div>
          <div class="detail-remark-box">
            <div class="detail-remark-label">订单备注：<el-icon class="detail-remark-edit-icon" @click="handleEditOrderRemark(currentOrder)"><Edit /></el-icon></div>
            <div class="detail-remark-content remark-text-order">{{ currentOrder.orderRemark || '暂无订单备注' }}</div>
          </div>
          <div class="detail-remark-box">
            <div class="detail-remark-label">系统备注：</div>
            <div class="detail-remark-content">{{ currentOrder.sysRemark || '暂无系统备注' }}</div>
          </div>
          <div class="detail-remark-box">
            <div class="detail-remark-label">本地备注：<el-icon class="detail-remark-edit-icon" @click="handleEditRemark(currentOrder)"><Edit /></el-icon></div>
            <div class="detail-remark-content">{{ currentOrder.remark || '暂无本地备注' }}</div>
          </div>
        </div>

        <div class="detail-footer">
          <el-button size="small" @click="onDetailAction('viewOriginal')">查看原单</el-button>
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
                  <el-tag size="default" :type="purchaseInfo.purchaseType === 'dropship' ? 'success' : 'warning'" effect="light" class="address-type-badge">
                    {{ {dropship: '三方代发模式', warehouse: '仓库发货模式', warehouse_in: '仓库进货模式'}[purchaseInfo.purchaseType] || '仓库发货模式' }}
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
              <el-alert
                v-if="purchaseInfo.purchaseType === 'dropship' && (purchaseInfo.shippingName.includes('*') || purchaseInfo.shippingAddress.includes('***'))"
                type="warning"
                :closable="false"
                show-icon
                style="margin-top:8px;font-size:12px;"
              >
                客户信息未解密，请先点击"获取真实信息"后再下单
              </el-alert>
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
              <div class="section-header-actions selection-tools-bar">
                <img src="/logo.png" alt="店小二" class="selection-tools-logo" />
                <span class="selection-tools-divider"></span>
                <el-button v-if="purchaseInfo.image" size="small"
                  class="selection-tool-btn taobao-same-tool-btn"
                  :loading="taobaoSameSearchLoading" @click="handleSearchTaobaoSame">
                  淘宝同款
                </el-button>
                <el-button v-if="purchaseInfo.selectedAccountId" size="small"
                  class="selection-tool-btn pdd-selection-tool-btn" @click="handleOpenPddBrowsing">
                  拼多多选品
                </el-button>
              </div>
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
                          <span v-if="getSourceShipFrom(src.purchase_link)" class="source-option-origin">发货地：{{ getSourceShipFrom(src.purchase_link) }}</span>
                          <span
                            v-if="getSourceTimeliness(src, idx)?.estimate"
                            class="source-option-eta"
                            :title="sourceTimelinessTitle(getSourceTimeliness(src, idx))"
                          >预计 {{ formatTimelinessDays(getSourceTimeliness(src, idx).estimate) }}</span>
                          <span v-if="getSourceTimeliness(src, idx)?.estimate?.dispatchRisk === 'high'" class="source-option-risk">发货风险</span>
                        </div>
                        <div class="source-option-recommendation">
                          <span v-if="getSourceTimeliness(src, idx)?.priceLowest && !getSourceTimeliness(src, idx)?.purchasePreferred" class="source-option-badge source-option-price-lowest"><el-icon><PriceTag /></el-icon>价格最低</span>
                          <span v-if="getSourceTimeliness(src, idx)?.bestTimeliness && !getSourceTimeliness(src, idx)?.purchasePreferred" class="source-option-badge source-option-best-timeliness"><el-icon><Lightning /></el-icon>最优时效</span>
                          <span v-if="getSourceTimeliness(src, idx)?.purchasePreferred" class="source-option-badge source-option-purchase-preferred"><el-icon><StarFilled /></el-icon>采购优选</span>
                        </div>
                      </div>
                      <div class="source-option-link-row">
                        <span class="source-option-link">{{ displaySourceUrl(src.purchase_link) }}</span>
                        <div class="source-option-actions">
                          <el-button link type="primary" size="small" @click.stop="openEditSourceForm(src, idx)"><el-icon><Edit /></el-icon></el-button>
                          <el-button link type="danger" size="small" @click.stop="handleDeleteSource(src, idx)"><el-icon><Delete /></el-icon></el-button>
                        </div>
                        <el-button link type="primary" size="small" class="source-link-open-btn" @click.stop="openSourceLink(src)">查看商品</el-button>
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
                      阿里巴巴
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
                    <el-radio-button v-if="purchaseInfo.hasInventoryBinding" value="warehouse_in">
                      <el-icon><Box /></el-icon>
                      仓库进货
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
                <label class="form-label" :class="{ required: purchaseInfo.purchaseType === 'warehouse' || purchaseInfo.purchaseType === 'warehouse_in' }">选择仓库</label>
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

          <!-- 右侧：商品信息区 -->
          <div class="info-section">
            <div class="product-info-card">
              <el-image v-if="purchaseInfo.image" :src="purchaseInfo.image" class="product-main-image" fit="cover" />
              <div v-else class="product-main-image product-banner-placeholder" :style="{ background: getItemColor(purchaseInfo.goodsName) }">
                <span class="product-initial">{{ purchaseInfo.goodsName.charAt(0) }}</span>
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
                  <span class="meta-label">订单号</span>
                  <span class="meta-value">{{ purchaseInfo.salesOrderNo }}</span>
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

    <!-- 淘宝按图搜同款结果 -->
    <el-dialog
      v-model="taobaoSameDialogVisible"
      title="淘宝同款"
      width="980px"
      append-to-body
      align-center
      :close-on-click-modal="false"
      class="taobao-same-dialog"
    >
      <div class="taobao-same-source">
        <div class="taobao-same-source-media">
          <el-image
            v-if="purchaseInfo.image"
            :src="purchaseInfo.image"
            fit="cover"
            :preview-src-list="[purchaseInfo.image]"
            preview-teleported
            hide-on-click-modal
          />
          <div v-else class="taobao-same-source-image-empty"><el-icon><ShoppingBag /></el-icon></div>
          <span>销售商品</span>
        </div>
        <div class="taobao-same-source-info">
          <div class="taobao-same-source-heading">
            <span>当前销售商品</span>
            <template v-if="taobaoSameFromHistory">
              <el-tag size="small" type="info" effect="plain">历史结果</el-tag>
              <el-button link type="primary" :loading="taobaoSameSearchLoading" @click="handleSearchTaobaoSame(true)">重新搜索</el-button>
            </template>
          </div>
          <strong :title="purchaseInfo.goodsName">{{ purchaseInfo.goodsName }}</strong>
          <div v-if="purchaseInfo.skuSpec" class="taobao-same-source-sku">
            <span>销售规格</span>
            <b>{{ purchaseInfo.skuSpec }}</b>
          </div>
          <div class="taobao-same-source-note">
            <span>根据当前商品主图搜索，最多展示 20 条淘宝同款</span>
            <span v-if="purchaseInfo.price != null" class="taobao-same-source-order-meta">订单单价 <b>¥{{ Number(purchaseInfo.price || 0).toFixed(2) }}</b></span>
            <span v-if="purchaseInfo.quantity" class="taobao-same-source-order-meta">数量 <b>{{ purchaseInfo.quantity }}</b></span>
          </div>
        </div>
      </div>

      <div v-if="taobaoSameSearchLoading" class="taobao-same-loading" v-loading="true">
        正在调用淘宝图片搜索，请稍候…
      </div>
      <el-empty v-else-if="taobaoSameSearchError" :description="taobaoSameSearchError" :image-size="80">
        <el-button type="danger" plain @click="handleSearchTaobaoSame">重新搜索</el-button>
      </el-empty>
      <el-empty v-else-if="taobaoSameResults.length === 0" description="暂无同款商品" :image-size="80" />
      <div v-else class="taobao-same-grid">
        <div
          v-for="product in taobaoSameResults"
          :key="product.itemId || product.link"
          class="taobao-same-card"
          role="button"
          tabindex="0"
          @click="handleOpenTaobaoSameProduct(product)"
          @keydown.enter="handleOpenTaobaoSameProduct(product)"
        >
          <span v-if="isTaobaoSameSource(product)" class="taobao-same-source-badge">货源</span>
          <el-image
            :src="product.img"
            fit="cover"
            class="taobao-same-image"
          >
            <template #error>
              <div class="taobao-same-image-error"><el-icon><ShoppingBag /></el-icon></div>
            </template>
          </el-image>
          <div class="taobao-same-card-body">
            <div class="taobao-same-title" :title="product.title">{{ product.title || '淘宝商品' }}</div>
            <div class="taobao-same-price-row">
              <span class="taobao-same-price">{{ product.price != null ? '¥' + Number(product.price).toFixed(2) : '价格待查看' }}</span>
              <del v-if="product.originalPrice != null">¥{{ Number(product.originalPrice).toFixed(2) }}</del>
            </div>
            <div class="taobao-same-meta">
              <span :title="product.shop">{{ product.shop || '淘宝店铺' }}</span>
              <span>{{ product.sales || '' }}</span>
            </div>
          </div>
        </div>
      </div>
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
            <el-link :href="row.purchase_link" target="_blank" style="font-size:12px;">{{ displaySourceUrl(row.purchase_link) }}</el-link>
            <div v-if="getSourceShipFrom(row.purchase_link)" class="source-manage-origin">发货地：{{ getSourceShipFrom(row.purchase_link) }}</div>
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
          <el-table-column label="图片" width="60" align="center">
            <template #default="{ row }">
              <el-image v-if="row.image" :src="row.image" :preview-src-list="[row.image]" preview-teleported hide-on-click-modal fit="cover" style="width: 40px; height: 40px; border-radius: 4px" />
              <span v-else style="color: #c0c4cc">无</span>
            </template>
          </el-table-column>
          <el-table-column prop="productName" label="商品名称" min-width="150" show-overflow-tooltip />
          <el-table-column prop="warehouseName" label="仓库" width="120" />
          <el-table-column prop="location" label="货位号" width="90" align="center" />
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
              <el-option v-for="wh in warehouseList" :key="wh.id" :label="wh.name" :value="wh.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="包装规格">
            <el-input-number v-model="bindPackageNum" :min="1" :max="999" controls-position="right" style="width: 120px" />
            <span style="margin-left: 8px; color: #909399; font-size: 12px">每卖1个扣N个仓库库存</span>
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

    <!-- 编辑商品弹窗 -->
    <el-dialog v-model="editInvVisible" title="编辑商品" width="520px" align-center destroy-on-close :close-on-click-modal="false">
      <el-form :model="editInvForm" label-width="90px" v-loading="editInvLoading">
        <el-form-item label="商品SKU">
          <el-input :model-value="editInvForm.sku" disabled />
        </el-form-item>
        <el-form-item label="商品名称">
          <el-input :model-value="editInvForm.product_name" disabled />
        </el-form-item>
        <el-form-item label="商品售价">
          <el-input-number v-model="editInvForm.price" :min="0" :precision="2" :step="1" style="width: 180px" />
        </el-form-item>
        <el-form-item label="所属仓库">
          <el-input :model-value="editInvForm.warehouse_name" disabled />
        </el-form-item>
        <el-form-item label="货位号">
          <el-input v-model="editInvForm.location" placeholder="如：A-01-03" style="width: 180px" />
        </el-form-item>
        <el-form-item label="包装规格">
          <el-input-number v-model="editInvForm.package_num" :min="1" :max="999" controls-position="right" style="width: 180px" />
          <span style="margin-left: 8px; color: #909399; font-size: 12px">每卖1个扣N个仓库库存</span>
        </el-form-item>
        <el-form-item label="库存预警值">
          <el-input-number v-model="editInvForm.warn_quantity" :min="0" :step="1" style="width: 180px" />
        </el-form-item>
        <el-form-item label="当前库存">
          <el-input-number v-model="editInvForm.quantity" :min="0" :step="1" style="width: 180px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editInvVisible = false">取消</el-button>
        <el-button type="primary" :loading="editInvSubmitting" @click="handleEditInvSubmit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 订单短信通知弹窗 -->
    <el-dialog
      v-model="smsDialogVisible"
      title="发送短信"
      width="560px"
      align-center
      destroy-on-close
      :close-on-click-modal="false"
    >
      <div class="sms-order-summary">
        <div>
          <span class="sms-summary-label">订单号</span>
          <strong>{{ smsDialogOrder?.orderNo || '--' }}</strong>
        </div>
        <div>
          <span class="sms-summary-label">收件人</span>
          <strong>{{ smsDialogOrder?.customerName || '--' }}</strong>
        </div>
      </div>

      <el-alert
        v-if="!smsConfigured"
        type="warning"
        :closable="false"
        title="短信服务尚未配置，请联系管理员"
        style="margin-bottom: 16px"
      />

      <el-form v-loading="smsContextLoading" label-width="86px" class="sms-form">
        <el-form-item label="接收电话" required>
          <el-input v-model="smsForm.phone" placeholder="请输入11位手机号，支持手机号-分机号" maxlength="30" />
          <div class="sms-field-tip">隐私号可填写为“手机号-分机号”，分机号会自动加入短信正文。</div>
        </el-form-item>
        <el-form-item label="短信类型" required>
          <el-select v-model="smsForm.template" style="width: 100%" @change="applySmsTemplate">
            <el-option v-for="item in SMS_TEMPLATE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <template v-if="smsForm.template === 'pickup'">
          <el-form-item label="取件地址" required>
            <el-input v-model="smsForm.pickupAddress" placeholder="请输入包裹实际取件地址" @input="applySmsTemplate" />
          </el-form-item>
          <el-form-item label="取件码" required>
            <el-input v-model="smsForm.pickupCode" placeholder="请输入取件码" @input="applySmsTemplate" />
          </el-form-item>
        </template>
        <el-form-item label="短信签名">
          <el-input :model-value="smsSignName" readonly />
        </el-form-item>
        <el-form-item label="短信内容" required>
          <el-input
            v-model="smsForm.message"
            type="textarea"
            :rows="6"
            maxlength="500"
            show-word-limit
            resize="vertical"
            placeholder="请输入短信内容"
          />
          <div class="sms-count-tip">预计计费 <strong>{{ smsEstimatedCount }}</strong> 条（70字以内1条，长短信按67字/条）</div>
        </el-form-item>
      </el-form>

      <template v-if="smsHistory.length">
        <el-divider content-position="left">最近发送记录</el-divider>
        <div class="sms-history-list">
          <div v-for="item in smsHistory" :key="item.id" class="sms-history-item">
            <div class="sms-history-meta">
              <span>{{ formatSmsTime(item.sent_at || item.sentAt || item.created_at) }}</span>
              <span>{{ item.phone }}</span>
              <el-tag :type="item.status === 'success' ? 'success' : item.status === 'failed' ? 'danger' : 'warning'" size="small">
                {{ item.status === 'success' ? '发送成功' : item.status === 'failed' ? '发送失败' : '发送中' }}
              </el-tag>
            </div>
            <div class="sms-history-content">{{ item.sign_name || item.signName || smsSignName }}{{ item.content }}</div>
            <div v-if="item.error_message" class="sms-history-error">{{ item.error_message }}</div>
          </div>
        </div>
      </template>

      <template #footer>
        <el-button @click="smsDialogVisible = false">关闭</el-button>
        <el-button
          type="primary"
          :loading="smsSending"
          :disabled="smsContextLoading || !smsConfigured"
          @click="submitSms"
        >
          立即发送
        </el-button>
      </template>
    </el-dialog>

    <!-- 标记问题弹窗 -->
    <el-dialog v-model="issueDialogVisible" title="标记问题订单" width="420px" align-center :close-on-click-modal="false">
      <div style="margin-bottom: 12px; color: #909399; font-size: 13px;">
        订单号：{{ issueDialogOrder?.orderNo }}
      </div>
      <el-select v-model="issueDialogValue" placeholder="选择问题类型（清空则取消标记）" clearable style="width: 100%">
        <el-option v-for="e in issueEventOptions" :key="e" :label="e" :value="e" />
      </el-select>
      <template #footer>
        <el-button @click="issueDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="issueSubmitting" @click="submitIssueEvent">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Refresh, Van, ShoppingCart, OfficeBuilding, Loading, CircleCheck, Plus, Edit, Delete, Message, View, ArrowRight, Setting, ShoppingBag, Shop, Warning, InfoFilled, Connection, Document, Tickets, Box, PriceTag, StarFilled, Lightning, Lock } from '@element-plus/icons-vue'
import { fetchStores, updateStoreSyncTime } from '@/api/store'
import { fetchSalesOrders, fetchSalesOrderStatusCounts, saveSalesOrders, updateBuyerInfo, updateRemark, updateSalesOrderPurchaseStatus, lockSalesOrderForPurchase, unlockSalesOrderPurchase, submitVendorRemark, updateOrderRemark, updateIssueEvent, fetchSalesOrderSmsContext, sendSalesOrderSms, checkFraudster, batchCheckFraudsters } from '@/api/salesOrder'
import { FRAUD_WATERMARK_URL, SUSPECT_WATERMARK_URL } from '@/assets/watermark'
function getWatermarkUrl(issueEvent) {
  if (issueEvent === '职业打假') return FRAUD_WATERMARK_URL
  if (issueEvent === '疑似打假') return SUSPECT_WATERMARK_URL
  return ''
}
import { createPurchaseOrder, bindPlatformOrderNo, fetchNextPurchaseNo, recommendShippingSources } from '@/api/purchaseOrder'
import { fetchSkuPurchaseConfigList, saveSkuPurchaseConfig, deleteSkuPurchaseConfig, detectPlatformFromUrl } from '@/api/skuPurchaseConfig'
import { fetchPurchaseAccounts } from '@/api/purchaseAccount'
import { fetchWarehouses, searchInventory, createSkuBinding, quickCreateInventory, batchQuerySkuBindings, fetchInventoryById, updateInventory, updatePackageNum } from '@/api/warehouse'
import { buildTaobaoSameHistoryKey, collectTaobaoSourceItemIds, extractTaobaoItemId, readTaobaoSameHistory, saveTaobaoSameHistory } from '@/utils/taobaoSameHistory'

// ==================== 筛选项配置 ====================

const orderStatusOptions = ['待付款', '待出库', '已出库', '暂停订单', '已完成', '已取消']
const issueEventOptions = ['超时未发货', '库存不足', '物流异常', '客户拒收', '职业打假', '疑似打假']
const DEFAULT_SMS_SIGN_NAME = '【宿迁小灰狼电子商务】'
const SMS_TEMPLATE_OPTIONS = [
  { value: 'pickup', label: '取件通知' },
  { value: 'reship', label: '补发通知' },
  { value: 'refund', label: '退款通知' },
  { value: 'custom', label: '自定义内容' }
]

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

// 短信通知
const smsDialogVisible = ref(false)
const smsDialogOrder = ref(null)
const smsContextLoading = ref(false)
const smsSending = ref(false)
const smsConfigured = ref(true)
const smsSignName = ref(DEFAULT_SMS_SIGN_NAME)
const smsHistory = ref([])
const smsForm = reactive({
  phone: '',
  template: 'reship',
  pickupAddress: '',
  pickupCode: '',
  message: ''
})

const smsEstimatedCount = computed(() => {
  const extensionMatch = String(smsForm.phone || '').trim().match(/^1\d{10}-([0-9]{1,12})$/)
  const extensionLength = extensionMatch ? extensionMatch[1].length + 2 : 0
  const length = smsSignName.value.length + smsForm.message.trim().length + extensionLength
  if (length <= 0) return 0
  return length <= 70 ? 1 : Math.ceil(length / 67)
})

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
  autoOutbound: false,
  largeLogistics: false,
  syncJdOrder: localStorage.getItem('jdAutoSyncEnabled') === 'true',  // 记住上次状态
  syncPurchaseOrder: true
})

function onFuncChange(key, value) {
  console.log(`[功能区开关] ${key}: ${value}`)

  if (key === 'syncJdOrder') {
    // 记住开关状态到 localStorage，重启软件后恢复上次设置
    localStorage.setItem('jdAutoSyncEnabled', value ? 'true' : 'false')
    if (value) {
      autoSyncStatus.value = '正在启动自动同步...'
      const syncTimeout = setTimeout(() => {
        if (autoSyncStatus.value === '正在启动自动同步...') {
          autoSyncStatus.value = '自动同步无响应，请检查终端日志'
          setTimeout(() => { autoSyncStatus.value = '' }, 8000)
        }
      }, 15000)
      window.electronAPI.invoke('toggle-jd-auto-sync', { enabled: true })
        .then(res => {
          clearTimeout(syncTimeout)
          console.log('[自动同步] 开启结果:', JSON.stringify(res))
          if (!res?.running) {
            autoSyncStatus.value = '自动同步启动失败'
            setTimeout(() => { autoSyncStatus.value = '' }, 5000)
          }
        })
        .catch(e => {
          clearTimeout(syncTimeout)
          console.warn('[自动同步] 开启失败:', e.message)
          autoSyncStatus.value = '自动同步开启异常: ' + e.message
          setTimeout(() => { autoSyncStatus.value = '' }, 5000)
        })
      ElMessage.success('已开启京东订单自动同步（每10分钟）')
    } else {
      window.electronAPI.invoke('toggle-jd-auto-sync', { enabled: false })
        .catch(e => console.warn('[自动同步] 关闭失败:', e.message))
      autoSyncStatus.value = ''
      ElMessage.info('已关闭京东订单自动同步')
    }
  }
}

// ==================== 数据加载 ====================

async function loadStores() {
  try {
    const data = await fetchStores({ platform: 'jd', store_type: 'pop,consignment', status: 'enabled', pageSize: 100 })
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
        skuId: item.skuId || '',
        skuSpec: item.skuSpec || item.sku_spec || item.specName || item.spec_name || '',
        storeId: row.store_id,
        price: parseFloat(item.price) || 0,
        quantity: item.quantity || 0,
        image: item.image || '',
        imageColor: getItemColor(item.name),
        inventoryInfo: null
      }))
    }
  } catch {}

  if (items.length === 0 && row.product_name) {
    items = [{
      name: row.product_name,
      sku: row.sku_id ? `SKU: ${row.sku_id}` : '',
      skuId: row.sku_id || '',
      skuSpec: row.sku_spec || '',
      storeId: row.store_id,
      price: parseFloat(row.unit_price) || 0,
      quantity: row.quantity || 0,
      image: row.product_image || '',
      imageColor: getItemColor(row.product_name),
      inventoryInfo: null
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
    storeId: row.store_id,
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
    warehouseName: row.warehouse_name || '',
    shopName: row.store_name || getStoreNameById(row.store_id),
    shopTag: '京东',
    items,
    issueEvent: row.issue_event || null,
    remark: row.remark || '',
    sysRemark: row.sys_remark || '',
    buyerMessage: row.buyer_message || '',
    orderRemark: row.order_remark || '',
    smsContent: row.sms_content || '',
    smsSentAt: row.sms_sent_at || null,
    smsSendCount: Number(row.sms_send_count) || 0,
    timeoutStatus: 'normal',
    purchaseLockedBy: row.purchase_locked_by || null,
    purchaseLockedName: row.purchase_locked_name || null,
    stockStatus: row.stock_status || 0
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
    if (searchForm.issueEvent) params.issue_event = searchForm.issueEvent
    const data = await fetchSalesOrders(params)
    const list = (data.list || []).map(mapServerOrder)
    tableData.value = list
    total.value = data.total || 0
    // 加载完成后，批量拉取货源配置，标记哪些 skuId 有货源链接
    loadSkuSourcesMap()
    loadSkuInventoryMap()

    // 批量比对打假人库（按买家账号）
    const checkOrders = list
      .filter(o => o.buyerAccount && o.issueEvent !== '职业打假')
      .map(o => ({ orderId: o.id, buyerAccount: o.buyerAccount }))
    if (checkOrders.length > 0) {
      try {
        const result = await batchCheckFraudsters(checkOrders)
        if (result.data && result.data.matched && result.data.matched.length > 0) {
          for (const m of result.data.matched) {
            const order = list.find(o => o.id === m.orderId)
            if (order) order.issueEvent = '疑似打假'
          }
        }
      } catch (e) {
        console.warn('[打假人批量比对] 失败:', e.message)
      }
    }
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
          // 脱敏买家信息不上传，保护已解密的真实信息
          const safeOrders = orders.map(o => {
            if (o.buyerName && o.buyerName.includes('*')) delete o.buyerName
            if (o.buyerPhone && o.buyerPhone.includes('*')) delete o.buyerPhone
            if (o.buyerAddress && o.buyerAddress.includes('***')) delete o.buyerAddress
            return o
          })
          await saveSalesOrders(searchForm.storeId, safeOrders)
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

function handleOpenProduct(order, item) {
  const skuId = item.sku ? item.sku.replace('SKU: ', '') : ''
  if (!skuId) {
    ElMessage.warning('该商品无SKU信息，无法访问商品链接')
    return
  }
  if (window.electronAPI) {
    window.electronAPI.invoke('open-product-url', { storeId: order.storeId, skuId })
  }
}

async function handleRevealBuyerInfo(order) {
  if (order._sensitiveLoading) return
  if (!window.electronAPI) {
    ElMessage.warning('请在 Electron 环境中使用此功能')
    return
  }
  const storeId = order.storeId ?? searchForm.storeId
  if (!storeId) {
    ElMessage.warning('无法获取订单所属店铺，请选择店铺筛选器')
    return
  }

  order._sensitiveLoading = true
  try {
    const result = await window.electronAPI.invoke('fetch-buyer-sensitive-info', {
      storeId,
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

      // 通过主进程IPC保存到服务器（比渲染进程直接HTTP更可靠）
      try {
        const saveResult = await window.electronAPI.invoke('save-buyer-info-to-server', {
          storeId: order.storeId,
          orderId: order.id,
          orderNo: order.orderNo,
          buyerName: info.buyerName,
          buyerPhone: info.buyerPhone,
          buyerAddress: info.buyerAddress
        })
        if (!saveResult.success) {
          console.warn('[BuyerInfo] 回写服务器失败:', saveResult.message)
          ElMessage.warning('买家信息保存到服务器失败: ' + saveResult.message)
        }
      } catch (e) {
        console.warn('[BuyerInfo] 回写服务器失败:', e.message)
      }

      // 二次比对打假人库（账号精确匹配 + 地址相似度匹配）
      if (order.issueEvent !== '职业打假') {
        try {
          const checkResult = await checkFraudster(order.buyerAccount, order.id, info.buyerAddress || order.address)
          if (checkResult.data && checkResult.data.matched) {
            order.issueEvent = '疑似打假'
            const f = checkResult.data.fraudster
            const matchType = checkResult.data.matchType === 'address' ? '地址相似' : '账号匹配'
            let msg = `⚠ 疑似打假预警（${matchType}）\n账号：${order.buyerAccount || '无'}`
            if (f.buyer_name) msg += `\n姓名：${f.buyer_name}`
            if (f.buyer_phone) msg += `\n电话：${f.buyer_phone}`
            if (f.source_order_no) msg += `\n来源订单：${f.source_order_no}`
            if (checkResult.data.similarity) msg += `\n地址相似度：${(checkResult.data.similarity * 100).toFixed(0)}%`
            ElMessageBox.alert(msg, '疑似打假预警', { type: 'warning', confirmButtonText: '知道了' })
          }
        } catch (e) {
          console.warn('[打假人比对] 检查失败:', e.message)
        }
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
  const storeId = purchaseInfo.storeId ?? searchForm.storeId
  if (!storeId) {
    ElMessage.warning('无法获取订单所属店铺，请选择店铺筛选器')
    return
  }

  purchaseInfo._sensitiveLoading = true
  try {
    const result = await window.electronAPI.invoke('fetch-buyer-sensitive-info', {
      storeId,
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
      // 三方代发时重新按格式生成收货地址预览
      if (purchaseInfo.purchaseType === 'dropship') {
        updateDropshipShipping()
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
      purchaseInfo._buyerRevealed = true

      // 回写到服务器（通过主进程IPC）
      try {
        const saveResult = await window.electronAPI.invoke('save-buyer-info-to-server', {
          storeId: purchaseInfo.storeId,
          orderId: purchaseInfo.salesOrderId,
          orderNo: purchaseInfo.salesOrderNo,
          buyerName: info.buyerName,
          buyerPhone: info.buyerPhone,
          buyerAddress: info.buyerAddress
        })
        if (!saveResult.success) {
          console.warn('[BuyerInfo] 回写服务器失败:', saveResult.message)
          ElMessage.warning('买家信息保存到服务器失败: ' + saveResult.message)
        }
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

function extractSalesSkuSpec(item = {}) {
  const explicitCandidates = [
    item.skuSpec, item.sku_spec, item.specName, item.spec_name,
    item.skuText, item.sku_text, item.specification, item.variantName, item.variant_name
  ]
  for (const candidate of explicitCandidates) {
    const value = String(candidate || '').replace(/\s+/g, ' ').trim()
    if (value && value !== item.name && !/^(?:SKU\s*[:：]?\s*)?\d+$/i.test(value)) return value.slice(0, 160)
  }

  const name = String(item.name || '').replace(/\s+/g, ' ').trim()
  if (!name) return ''
  const matches = []
  const addMatch = value => {
    const cleaned = String(value || '').replace(/\s+/g, '').replace(/^[,，、/|]+|[,，、/|]+$/g, '')
    if (cleaned && !matches.includes(cleaned)) matches.push(cleaned)
  }
  const patterns = [
    /\d+(?:\.\d+)?\s*(?:毫升|千克|公斤|厘米|毫米|ml|mL|ML|kg|KG|Kg|cm|CM|mm|MM|oz|OZ|升|克|斤|两|L|l|g|G|米)(?:\s*[×xX*]\s*\d+\s*(?:个|只|瓶|包|盒|罐|袋|支|件|套|箱|张|片|卷|双|条|块|粒|颗|贴)?)?/g,
    /\d+\s*(?:个|只|瓶|包|盒|罐|袋|支|件|套|箱|张|片|卷|双|条|块|粒|颗|贴)(?:装|套装)?/g,
    /(?:透明|黑|白|红|橙|黄|绿|青|蓝|紫|粉|灰|银|金|咖啡|棕)(?:色|款)/g,
    /(?:特大号|加大号|大号|中号|小号|均码|\d{2,4}码|[SMLX]{1,4}码?)/gi
  ]
  for (const pattern of patterns) {
    let matched
    while ((matched = pattern.exec(name)) !== null && matches.length < 8) addMatch(matched[0])
  }
  return matches.slice(0, 6).join(' / ')
}

async function handlePurchase(order, item, itemIdx) {
  // 只锁定订单，不获取采购编号（编号延迟到"去下单"时生成，避免浪费）
  let lockResult
  try {
    lockResult = await lockSalesOrderForPurchase(order.id).catch(e => ({ _lockError: e }))
  } catch (e) {
    ElMessage.error('操作失败: ' + e.message)
    return
  }

  // 锁定失败
  if (lockResult && lockResult._lockError) {
    const msg = lockResult._lockError.message || '该订单目前有其他用户在采购'
    ElMessage.warning({ message: msg, duration: 3000 })
    loadOrdersFromServer()
    return
  }
  // 锁定成功，更新本地状态
  order.purchaseLockedBy = true
  order.purchaseLockedName = '我'

  purchaseInfo.step = 1
  purchaseInfo.purchaseNo = ''
  purchaseInfo.salesOrderNo = order.orderNo
  purchaseInfo.salesOrderId = order.id
  purchaseInfo.storeId = order.storeId
  purchaseInfo.goodsName = item.name
  purchaseInfo.sku = String(item.sku || '').replace(/^SKU\s*[:：]?\s*/i, '')
  purchaseInfo.skuSpec = extractSalesSkuSpec(item)
  purchaseInfo.skuId = item.skuId || item.sku_id || item.sku || ''
  purchaseInfo.quantity = item.quantity
  purchaseInfo.price = item.price || 0
  purchaseInfo.image = item.image || ''
  skuSources.value = []
  selectedSourceIndex.value = -1
  purchaseInfo.sourceUrl = ''
  purchaseInfo.sourceShipFrom = ''
  sourceTimelinessMap.value = {}
  purchaseInfo.platform = 'taobao'
  purchaseInfo.platformOrderNo = ''
  purchaseInfo.purchasePrice = 0
  purchaseInfo.remark = ''
  purchaseInfo.selectedAccountId = null
  purchaseInfo.captureStatus = 'idle'
  purchaseInfo.capturedOrderNo = ''
  purchaseInfo.submitting = false
  purchaseInfo._buyerRevealed = false
  // 采购类型 & 地址
  purchaseInfo.purchaseType = 'dropship'
  purchaseInfo.hasInventoryBinding = !!(item.inventoryInfo?.inventory_id || item.inventory_id)
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
  if (order.customerPhone) {
    initAddr = initAddr + '【派件联系' + order.customerPhone + '】'
  }
  purchaseInfo.shippingAddress = initAddr
  purchaseDialogVisible.value = true

  // 注册 IPC 事件监听（用 try-catch 保护，避免阻断后续 API 加载）
  try {
    setupPurchaseListeners()
  } catch (e) {
    console.warn('[采购下单] IPC监听注册失败:', e.message)
  }

  // 加载采购账号列表和仓库列表（并行请求，减少卡顿）
  const [accountsRes, warehousesRes] = await Promise.all([
    fetchPurchaseAccounts().catch(e => {
      console.warn('[采购下单] 加载采购账号失败:', e.message)
      ElMessage.warning('加载采购账号失败: ' + e.message)
      return null
    }),
    fetchWarehouses().catch(e => {
      console.warn('[采购下单] 加载仓库失败:', e.message)
      ElMessage.warning('加载仓库失败: ' + e.message)
      return null
    })
  ])

  if (accountsRes) {
    const rawList = accountsRes && accountsRes.list ? accountsRes.list : (Array.isArray(accountsRes) ? accountsRes : [])
    purchaseAccounts.value = rawList.map(a => ({
      ...a,
      username: a.account || a.username || '',
      status: a.online ? 'online' : 'offline'
    }))
  }

  if (warehousesRes) {
    if (warehousesRes && warehousesRes.list) {
      warehouseList.value = warehousesRes.list
    } else if (Array.isArray(warehousesRes)) {
      warehouseList.value = warehousesRes
    } else {
      warehouseList.value = []
    }
  }
  // 恢复上次选择的仓库，或只有一个仓库时自动选中
  const lastWhId = localStorage.getItem('lastWarehouseId')
  if (lastWhId) {
    const whMatch = warehouseList.value.find(w => String(w.id) === lastWhId)
    if (whMatch) {
      applyWarehouseAddress(whMatch)
      if (purchaseInfo.purchaseType === 'dropship') {
        updateDropshipShipping()
      } else if (purchaseInfo.purchaseType === 'warehouse' || purchaseInfo.purchaseType === 'warehouse_in') {
        updateWarehouseShipping()
      }
    }
  } else if (warehouseList.value.length === 1) {
    applyWarehouseAddress(warehouseList.value[0])
    if (purchaseInfo.purchaseType === 'dropship') {
      updateDropshipShipping()
    } else if (purchaseInfo.purchaseType === 'warehouse' || purchaseInfo.purchaseType === 'warehouse_in') {
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

// 批量加载当前页订单的货源映射（只查当前页涉及的 skuId，不拉全量）
async function loadSkuSourcesMap() {
  // 收集当前页所有 skuId（去重、跳过已缓存的）
  const skuIds = new Set()
  for (const order of tableData.value) {
    for (const item of (order.items || [])) {
      const sid = item.skuId || item.sku_id || item.sku
      if (sid && skuHasSourcesCache[sid] === undefined) {
        skuIds.add(sid)
      }
    }
  }
  if (skuIds.size === 0) return  // 当前页没有未查询的 skuId
  try {
    // 逐个查询未缓存的 skuId（并行）
    const tasks = [...skuIds].map(async skuId => {
      try {
        const res = await fetchSkuPurchaseConfigList(skuId)
        let list = []
        if (res) {
          if (res.list && Array.isArray(res.list)) list = res.list
          else if (Array.isArray(res)) list = res
          else if (res.purchase_link !== undefined) list = [res]
        }
        skuHasSourcesCache[skuId] = list.length > 0
      } catch (e) {
        skuHasSourcesCache[skuId] = false  // 查询失败标记为无，避免重复查
      }
    })
    await Promise.all(tasks)
  } catch (e) {
    // 非关键功能，静默失败
  }
}

// 加载SKU货源列表
async function loadSkuSources(skuId) {
  skuSources.value = []
  selectedSourceIndex.value = -1
  sourceTimelinessMap.value = {}
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
      // 缓存该 skuId 是否有货源链接
      skuHasSourcesCache[skuId] = list.length > 0
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
  purchaseInfo.sourceShipFrom = getSourceShipFrom(source.purchase_link)
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
  storeId: null,
  goodsName: '',
  sku: '',
  skuSpec: '',
  skuId: '',
  quantity: 0,
  price: 0,
  image: '',
  sourceUrl: '',
  sourceShipFrom: '',
  platform: 'taobao',
  platformOrderNo: '',
  purchasePrice: 0,
  remark: '',
  selectedAccountId: null,
  captureStatus: 'idle', // idle | ordering | captured
  capturedOrderNo: '',
  submitting: false,
  purchaseType: 'dropship', // dropship(三方代发) | warehouse(仓库发货) | warehouse_in(仓库进货)
  hasInventoryBinding: false, // 当前SKU是否已绑定仓库商品
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
  _sensitiveLoading: false,
  _buyerRevealed: false
})

// 淘宝按图搜同款
const taobaoSameDialogVisible = ref(false)
const taobaoSameSearchLoading = ref(false)
const taobaoSameResults = ref([])
const taobaoSameSearchError = ref('')
const taobaoSameAccountId = ref(null)
const taobaoSameFromHistory = ref(false)
const taobaoSameHistoryKey = ref('')

// 货源管理
const skuSources = ref([])
const skuHasSourcesCache = reactive({})  // skuId → boolean，缓存是否有货源链接
const selectedSourceIndex = ref(-1)
const sourceTimelinessMap = ref({})
let sourceTimelinessTimer = null
let sourceTimelinessRequestId = 0
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

// ==================== 绑定仓库商品弹窗 ====================
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
const bindPackageNum = ref(1)

// SKU库存信息缓存：key = `${storeId}_${skuId}`
const skuInventoryCache = reactive({})

// 从商品名称中智能提取关键词
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
      warehouse_id: invRow.warehouseId,
      package_num: bindPackageNum.value
    })
    ElMessage.success('绑定成功')
    bindDialogVisible.value = false
    await refreshSkuInventory(currentBindRow.value.storeId, currentBindRow.value.skuId, currentBindRow.value.orderItem)
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
      supplier: bindNewForm.supplier,
      package_num: bindPackageNum.value
    })
    ElMessage.success('新建并绑定成功')
    bindDialogVisible.value = false
    await refreshSkuInventory(currentBindRow.value.storeId, currentBindRow.value.skuId, currentBindRow.value.orderItem)
  } catch (err) {
    ElMessage.error('新建失败：' + (err.message || '未知错误'))
  } finally {
    bindCreateLoading.value = false
  }
}

// 批量加载当前页所有订单商品的库存绑定信息
async function loadSkuInventoryMap() {
  const items = []
  const seen = new Set()
  for (const order of tableData.value) {
    for (const item of (order.items || [])) {
      const skuId = item.skuId
      const storeId = order.storeId || item.storeId
      if (skuId && storeId) {
        const key = `${storeId}_${skuId}`
        if (!seen.has(key)) {
          seen.add(key)
          items.push({ store_id: storeId, sku_id: skuId })
        }
      }
    }
  }
  if (items.length === 0) return

  try {
    const res = await batchQuerySkuBindings({ items })
    if (Array.isArray(res)) {
      for (const row of res) {
        const key = `${row.store_id}_${row.sku_id}`
        skuInventoryCache[key] = {
          inventory_id: row.inventory_id,
          warehouse_id: row.warehouse_id,
          warehouse_name: row.warehouse_name,
          quantity: row.quantity || 0,
          in_transit_qty: row.in_transit_qty || 0,
          unpurchased_qty: row.unpurchased_qty || 0,
          package_num: row.package_num || 1,
          delayed_qty: row.delayed_qty || 0
        }
      }
      // 回填到 order.items
      for (const order of tableData.value) {
        for (const item of (order.items || [])) {
          const key = `${order.storeId}_${item.skuId}`
          if (skuInventoryCache[key]) {
            item.inventoryInfo = skuInventoryCache[key]
          }
        }
      }
    }
  } catch (err) {
    console.warn('[库存信息] 批量加载失败:', err.message)
  }
}

// 刷新单个SKU的库存信息（绑定成功后调用）
async function refreshSkuInventory(storeId, skuId, orderItem) {
  if (!storeId || !skuId) return
  try {
    const res = await batchQuerySkuBindings({ items: [{ store_id: storeId, sku_id: skuId }] })
    if (Array.isArray(res) && res.length > 0) {
      const row = res[0]
      const key = `${storeId}_${skuId}`
      skuInventoryCache[key] = {
        inventory_id: row.inventory_id,
        warehouse_id: row.warehouse_id,
        warehouse_name: row.warehouse_name,
        quantity: row.quantity || 0,
        in_transit_qty: row.in_transit_qty || 0,
        unpurchased_qty: row.unpurchased_qty || 0,
        package_num: row.package_num || 1,
        delayed_qty: row.delayed_qty || 0
      }
      if (orderItem) {
        orderItem.inventoryInfo = skuInventoryCache[key]
      }
    } else {
      const key = `${storeId}_${skuId}`
      delete skuInventoryCache[key]
      if (orderItem) {
        orderItem.inventoryInfo = null
      }
    }
  } catch (err) {
    console.warn('[库存信息] 刷新失败:', err.message)
  }
}

// ============ 编辑商品弹窗 ============
const editInvVisible = ref(false)
const editInvLoading = ref(false)
const editInvSubmitting = ref(false)
const editInvForm = reactive({
  id: '',
  sku: '',
  product_name: '',
  price: 0,
  warehouse_name: '',
  location: '',
  package_num: 1,
  warn_quantity: 10,
  quantity: 0
})
let editInvContext = null // 保存当前编辑的 order/item 引用

async function openEditInventory(order, item) {
  if (!item.inventoryInfo?.inventory_id) return
  editInvContext = { order, item }
  editInvVisible.value = true
  editInvLoading.value = true
  try {
    const res = await fetchInventoryById(item.inventoryInfo.inventory_id)
    Object.assign(editInvForm, {
      id: res.id,
      sku: res.sku,
      product_name: res.product_name,
      price: Number(res.price || 0),
      warehouse_name: res.warehouse_name,
      location: res.location || '',
      package_num: item.inventoryInfo.package_num || 1,
      warn_quantity: Number(res.warn_quantity || 0),
      quantity: Number(res.quantity || 0)
    })
  } catch (err) {
    ElMessage.error('获取商品信息失败: ' + err.message)
    editInvVisible.value = false
  } finally {
    editInvLoading.value = false
  }
}

async function handleEditInvSubmit() {
  editInvSubmitting.value = true
  try {
    // 更新库存项
    await updateInventory(editInvForm.id, {
      price: editInvForm.price,
      location: editInvForm.location,
      warn_quantity: editInvForm.warn_quantity,
      quantity: editInvForm.quantity
    })
    // 更新包装规格（如果有上下文）
    if (editInvContext?.order && editInvContext?.item) {
      const { order, item } = editInvContext
      const oldPackageNum = item.inventoryInfo?.package_num || 1
      if (oldPackageNum !== editInvForm.package_num) {
        await updatePackageNum({
          store_id: order.storeId,
          sku_id: item.skuId,
          package_num: editInvForm.package_num
        })
        // 更新本地缓存
        if (item.inventoryInfo) {
          item.inventoryInfo.package_num = editInvForm.package_num
        }
      }
    }
    ElMessage.success('修改成功')
    editInvVisible.value = false
  } catch (err) {
    ElMessage.error('修改失败: ' + err.message)
  } finally {
    editInvSubmitting.value = false
  }
}

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

// 三方代发：手机号=仓库手机号，姓名去掉[编号]，地址+【派件联系{buyerPhone}】
function updateDropshipShipping() {
  // 从买家姓名中提取编号并去掉，如 "苏宝宝[3899]" -> 姓名"苏宝宝"，编号"3899"
  const nameCodeMatch = (purchaseInfo.buyerName || '').match(/\[(\d+)\]/)
  purchaseInfo.shippingName = (purchaseInfo.buyerName || '').replace(/\[\d+\]/, '').trim()
  purchaseInfo.shippingPhone = purchaseInfo.warehousePhone || purchaseInfo.buyerPhone || ''
  // 地址也去掉.[编号]或[编号]，再追加派件联系后缀
  let addr = (purchaseInfo.buyerAddress || '').replace(/\.?\[\d+\]/, '').trim()
  if (purchaseInfo.buyerPhone) {
    addr = addr + '【派件联系' + purchaseInfo.buyerPhone + '】'
  }
  purchaseInfo.shippingAddress = addr
}

// 仓库发货：地址=仓库地址+采购编号
function updateWarehouseShipping() {
  purchaseInfo.shippingName = purchaseInfo.warehouseContact || purchaseInfo.warehouseName
  purchaseInfo.shippingPhone = purchaseInfo.warehousePhone
  let addr = purchaseInfo.warehouseAddress || ''
  if (purchaseInfo.purchaseNo) {
    addr = addr + '【' + purchaseInfo.purchaseNo + '】'
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
    localStorage.removeItem('lastWarehouseId')
  }
  if (purchaseInfo.purchaseType === 'dropship') {
    updateDropshipShipping()
  } else if (purchaseInfo.purchaseType === 'warehouse' || purchaseInfo.purchaseType === 'warehouse_in') {
    updateWarehouseShipping()
  }
}

// 采购类型切换时自动更新收货地址
watch(() => purchaseInfo.purchaseType, (type) => {
  if (type === 'dropship') {
    updateDropshipShipping()
  } else if (type === 'warehouse' || type === 'warehouse_in') {
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
  const map = { taobao: '淘宝/天猫', pinduoduo: '拼多多', '1688': '阿里巴巴' }
  return map[val] || val
}

function platformTagType(val) {
  const map = { taobao: 'danger', pinduoduo: 'warning', '1688': '', douyin: 'success' }
  return map[val] || 'info'
}

function attachTaobaoSkuMetadata(url, selection) {
  if (!selection || typeof selection !== 'object') return url
  const options = (Array.isArray(selection.options) ? selection.options : [])
    .map(item => ({
      text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      valueId: String(item?.valueId || '').trim().slice(0, 120),
      group: String(item?.group || '').replace(/\s+/g, ' ').trim().slice(0, 80)
    }))
    .filter(item => item.text || item.valueId)
    .slice(0, 12)
  const metadata = {
    v: 2,
    skuId: String(selection.skuId || '').trim().slice(0, 120),
    options
  }
  const shipFrom = String(selection.shipFrom || '').replace(/\s+/g, '').trim().slice(0, 80)
  if (shipFrom) metadata.shipFrom = shipFrom
  const shopId = String(selection.shopId || '').trim().slice(0, 120)
  const sellerId = String(selection.sellerId || '').trim().slice(0, 120)
  const shopName = String(selection.shopName || '').replace(/\s+/g, ' ').trim().slice(0, 100)
  if (shopId) metadata.shopId = shopId
  if (sellerId) metadata.sellerId = sellerId
  if (shopName) metadata.shopName = shopName
  if (!metadata.skuId && options.length === 0 && !metadata.shipFrom && !metadata.shopId && !metadata.sellerId && !metadata.shopName) return url
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    return parsed.toString() + '#dxeSku=' + encodeURIComponent(JSON.stringify(metadata))
  } catch {
    return url
  }
}

function getTaobaoSourceMetadata(url) {
  try {
    const parsed = new URL(url)
    if (!parsed.hash.startsWith('#dxeSku=')) return null
    const raw = parsed.hash.slice('#dxeSku='.length)
    const metadata = JSON.parse(decodeURIComponent(raw))
    return metadata && typeof metadata === 'object' ? metadata : null
  } catch {
    return null
  }
}

function getSourceShipFrom(url) {
  return String(getTaobaoSourceMetadata(url)?.shipFrom || '')
}

function sourceTimelinessKey(source, index) {
  return String(source?.id ?? index)
}

function getSourceTimeliness(source, index) {
  return sourceTimelinessMap.value[sourceTimelinessKey(source, index)] || null
}

function formatTimelinessDays(estimate) {
  if (!estimate) return ''
  const min = Number(estimate.minDays || 0)
  const max = Number(estimate.maxDays || min)
  return min === max ? `${min}天` : `${min}-${max}天`
}

function sourceTimelinessTitle(result) {
  const estimate = result?.estimate
  if (!estimate) return ''
  const sourcePerformance = estimate.sourcePerformance
  const regionalDispatch = estimate.regionalDispatchPerformance
  const sourceText = sourcePerformance
    ? `；该货源发货样本 ${sourcePerformance.dispatchSampleCount || 0} 单` +
      (sourcePerformance.unshippedCount ? `，超时未发/未发取消 ${sourcePerformance.unshippedCount} 单` : '')
    : ''
  const regionalText = regionalDispatch && estimate.dispatchBasis !== 'source'
    ? `；按${regionalDispatch.regionGroup || (regionalDispatch.city ? `${regionalDispatch.province}${regionalDispatch.city}` : regionalDispatch.province)}` +
      ` ${String(regionalDispatch.startHour).padStart(2, '0')}:00-${String(regionalDispatch.endHour).padStart(2, '0')}:00` +
      ` 样本 ${regionalDispatch.sampleCount || 0} 单计算发货准备时间` +
      `，当天进入物流 ${(Number(regionalDispatch.sameDayRate || 0) * 100).toFixed(0)}%`
    : ''
  if (estimate.confidence === 'high' || estimate.confidence === 'medium') {
    return `根据近90天 ${estimate.sampleCount || 0} 个同路线已签收订单计算${regionalText}${sourceText}`
  }
  return `同路线样本不足，使用服务器默认时效配置估算${regionalText}${sourceText}`
}

async function refreshSourceTimeliness() {
  const requestId = ++sourceTimelinessRequestId
  if (!purchaseDialogVisible.value || !purchaseInfo.shippingAddress || skuSources.value.length === 0) {
    sourceTimelinessMap.value = {}
    return
  }
  const requestedDestination = purchaseInfo.shippingAddress
  const sources = skuSources.value
    .map((source, index) => ({
      id: sourceTimelinessKey(source, index),
      ship_from: getSourceShipFrom(source.purchase_link),
      purchase_link: source.purchase_link,
      purchase_price: Number(source.purchase_price || 0)
    }))
  if (sources.length === 0) {
    sourceTimelinessMap.value = {}
    return
  }

  try {
    const result = await recommendShippingSources({
      destination: requestedDestination,
      sources,
      requested_at: new Date().toISOString()
    })
    if (
      requestId !== sourceTimelinessRequestId ||
      !purchaseDialogVisible.value ||
      requestedDestination !== purchaseInfo.shippingAddress
    ) return
    const sourcePriceMap = new Map(sources.map(source => [String(source.id), Number(source.purchase_price || 0)]))
    const resultItems = (result?.results || []).map(item => ({
      ...item,
      purchase_price: sourcePriceMap.get(String(item.id)) || null,
      priceLowest: false,
      bestTimeliness: false,
      purchasePreferred: false,
      recommended: false
    }))

    const pricedItems = resultItems.filter(item => Number(item.purchase_price) > 0)
    if (pricedItems.length >= 2) {
      const bestPrice = Math.min(...pricedItems.map(item => Number(item.purchase_price)))
      for (const item of pricedItems) {
        item.priceLowest = Math.abs(Number(item.purchase_price) - bestPrice) < 0.001
      }
    }

    const comparable = resultItems.filter(item => item.estimate && Number.isFinite(Number(item.estimate.scoreHours)))
    if (comparable.length >= 2) {
      const eligible = comparable.filter(item => item.estimate.dispatchRisk !== 'high')
      if (eligible.length > 0) {
        const bestScore = Math.min(...eligible.map(item => Number(item.estimate.scoreHours)))
        for (const item of eligible) {
          item.bestTimeliness = Math.abs(Number(item.estimate.scoreHours) - bestScore) < 0.01
        }
      }
    }

    for (const item of resultItems) {
      item.purchasePreferred = item.priceLowest && item.bestTimeliness
      item.recommended = item.purchasePreferred
    }
    console.warn('[采购时效推荐][诊断]', JSON.stringify({
      destination: result?.destination ? {
        province: result.destination.province || '',
        city: result.destination.city || '',
        county: result.destination.county || ''
      } : null,
      sources: resultItems.map(item => ({
        id: item.id,
        shipFrom: item.ship_from || '',
        origin: item.origin ? {
          province: item.origin.province || '',
          city: item.origin.city || '',
          county: item.origin.county || ''
        } : null,
        purchasePrice: item.purchase_price,
        priceLowest: !!item.priceLowest,
        bestTimeliness: !!item.bestTimeliness,
        purchasePreferred: !!item.purchasePreferred,
        estimate: item.estimate ? {
          minDays: item.estimate.minDays,
          maxDays: item.estimate.maxDays,
          scoreHours: item.estimate.scoreHours,
          basis: item.estimate.basis,
          confidence: item.estimate.confidence,
          sampleCount: item.estimate.sampleCount,
          routeP50Hours: item.estimate.routeP50Hours,
          routeP80Hours: item.estimate.routeP80Hours,
          dispatchBasis: item.estimate.dispatchBasis || 'default',
          regionalDispatchPerformance: item.estimate.regionalDispatchPerformance || null,
          sourcePerformance: item.estimate.sourcePerformance || null,
          dispatchRisk: item.estimate.dispatchRisk || ''
        } : null
      }))
    }))
    const nextMap = {}
    for (const item of resultItems) nextMap[String(item.id)] = item
    sourceTimelinessMap.value = nextMap
  } catch (error) {
    if (requestId === sourceTimelinessRequestId) sourceTimelinessMap.value = {}
    console.warn('[采购时效推荐] 获取失败:', error.message)
  }
}

function scheduleSourceTimelinessRefresh() {
  if (sourceTimelinessTimer) clearTimeout(sourceTimelinessTimer)
  sourceTimelinessTimer = setTimeout(() => {
    sourceTimelinessTimer = null
    refreshSourceTimeliness()
  }, 350)
}

watch(
  [
    () => purchaseDialogVisible.value,
    () => purchaseInfo.shippingAddress,
    () => skuSources.value.map(source => `${source.id || ''}:${getSourceShipFrom(source.purchase_link)}:${source.purchase_price || 0}`).join('|')
  ],
  scheduleSourceTimelinessRefresh
)

// 精简URL显示：提取核心链接，去除追踪参数
function shortenUrl(url) {
  if (!url) return ''
  try {
    const u = new URL(url)
    // 淘宝/天猫：只保留 id 参数
    if (u.hostname.includes('taobao.com') || u.hostname.includes('tmall.com')) {
      const id = u.searchParams.get('id')
      const skuHash = u.hash.startsWith('#dxeSku=') ? u.hash : ''
      return id ? `${u.origin}${u.pathname}?id=${id}${skuHash}` : url
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

// SKU元数据保存在URL hash中供采购页自动回选，界面只展示淘宝商品短链接。
function displaySourceUrl(url) {
  return shortenUrl(url).split('#dxeSku=')[0]
}

function getSourcePurchaseAccount(platform) {
  const accounts = purchaseAccounts.value.filter(account => account.platform === platform)
  if (accounts.length === 0) return null

  const selected = accounts.find(account =>
    String(account.id) === String(purchaseInfo.selectedAccountId || '')
  )
  if (selected) return selected

  const lastId = localStorage.getItem('lastPurchaseAccount_' + platform)
  const remembered = lastId
    ? accounts.find(account => String(account.id) === String(lastId))
    : null
  return remembered || accounts.find(account => account.online || account.status === 'online') || accounts[0]
}

// 使用对应采购账号的持久化登录会话打开货源商品，避免进入未登录页面。
async function openSourceLink(source) {
  const url = typeof source === 'string' ? source : source?.purchase_link
  if (!url) {
    ElMessage.warning('货源链接为空')
    return
  }

  const platform = (typeof source === 'object' && source?.platform)
    || detectPlatformFromUrl(url)
    || purchaseInfo.platform
  const account = getSourcePurchaseAccount(platform)
  if (!account) {
    ElMessage.warning(`请先添加并登录${platformLabel(platform)}采购账号`)
    return
  }

  if (!window.electronAPI) {
    window.open(url, '_blank')
    return
  }

  try {
    const result = await window.electronAPI.invoke('open-purchase-url', {
      accountId: account.id,
      url,
      title: '查看货源商品',
      platform
    })
    if (!result?.success) {
      ElMessage.error(result?.message || '打开商品失败')
    }
  } catch (err) {
    ElMessage.error('打开商品失败: ' + (err?.message || '未知错误'))
  }
}

function getTaobaoSameSearchAccount() {
  const accounts = purchaseAccounts.value.filter(account =>
    account.platform === 'taobao' || account.platform === 'tmall'
  )
  if (accounts.length === 0) return null
  const lastId = localStorage.getItem('lastPurchaseAccount_taobao')
  const remembered = lastId ? accounts.find(account => String(account.id) === String(lastId)) : null
  return remembered || accounts.find(account => account.online || account.status === 'online') || accounts[0]
}

const taobaoSameSourceItemIds = computed(() => collectTaobaoSourceItemIds(skuSources.value))

function isTaobaoSameSource(product) {
  const itemId = extractTaobaoItemId(product)
  return !!itemId && taobaoSameSourceItemIds.value.has(itemId)
}

function currentTaobaoSameHistoryKey(accountId) {
  return buildTaobaoSameHistoryKey({
    userId: localStorage.getItem('currentUser') || '',
    accountId,
    skuId: purchaseInfo.skuId,
    imageUrl: purchaseInfo.image
  })
}

async function handleSearchTaobaoSame(forceRefresh = false) {
  if (taobaoSameSearchLoading.value) return
  if (!purchaseInfo.image) {
    ElMessage.warning('当前商品没有可用于搜索的主图')
    return
  }
  const account = getTaobaoSameSearchAccount()
  if (!account) {
    ElMessage.warning('请先在采购账号中添加并登录淘宝账号')
    return
  }
  if (!window.electronAPI) {
    ElMessage.error('当前环境不支持淘宝搜同款')
    return
  }

  taobaoSameAccountId.value = account.id
  taobaoSameDialogVisible.value = true
  taobaoSameSearchError.value = ''
  taobaoSameHistoryKey.value = currentTaobaoSameHistoryKey(account.id)

  if (forceRefresh !== true) {
    const history = readTaobaoSameHistory(localStorage, taobaoSameHistoryKey.value)
    if (history) {
      taobaoSameResults.value = history.products
      taobaoSameFromHistory.value = true
      taobaoSameSearchLoading.value = false
      console.info('[淘宝同款] 已加载历史搜索结果', {
        skuId: purchaseInfo.skuId,
        count: history.products.length,
        cachedAt: new Date(history.cachedAt).toISOString()
      })
      return
    }
  }

  taobaoSameSearchLoading.value = true
  taobaoSameFromHistory.value = false
  taobaoSameResults.value = []
  try {
    const result = await window.electronAPI.invoke('search-taobao-same-product', {
      imgUrl: purchaseInfo.image,
      accountId: account.id,
      automatic: false,
      limit: 20
    })
    if (result && result.success) {
      taobaoSameResults.value = result.products || result.items || []
      if (taobaoSameResults.value.length === 0) {
        taobaoSameSearchError.value = '淘宝接口调用成功，但未返回同款商品'
      } else {
        saveTaobaoSameHistory(localStorage, taobaoSameHistoryKey.value, taobaoSameResults.value)
      }
      return
    }
    const message = result?.message || result?.error || '淘宝同款搜索失败'
    taobaoSameSearchError.value = message
    if (result?.needLogin || result?.needVerification) {
      ElMessage.warning(message)
    } else {
      ElMessage.error(message)
    }
  } catch (error) {
    taobaoSameSearchError.value = error.message || '淘宝同款搜索失败'
    ElMessage.error('淘宝同款搜索失败: ' + taobaoSameSearchError.value)
  } finally {
    taobaoSameSearchLoading.value = false
  }
}

async function handleOpenTaobaoSameProduct(product) {
  if (!product?.link || !taobaoSameAccountId.value) return
  try {
    // Vue会把列表项包装成响应式Proxy，Electron IPC无法直接结构化克隆。
    // 只提取允许传入主进程的普通字段，避免 DataCloneError。
    const sameItem = {
      itemId: String(product.itemId || ''),
      link: String(product.link || ''),
      title: String(product.title || ''),
      img: String(product.img || ''),
      price: product.price == null ? null : Number(product.price),
      originalPrice: product.originalPrice == null ? null : Number(product.originalPrice),
      sales: String(product.sales || ''),
      shop: String(product.shop || ''),
      shopId: String(product.shopId || ''),
      sellerId: String(product.sellerId || '')
    }
    const result = await window.electronAPI.invoke('open-taobao-same-product', {
      accountId: taobaoSameAccountId.value,
      url: sameItem.link,
      sameItem,
      sourceProduct: {
        goodsName: purchaseInfo.goodsName,
        image: purchaseInfo.image,
        sku: purchaseInfo.sku,
        skuSpec: purchaseInfo.skuSpec,
        quantity: purchaseInfo.quantity,
        price: purchaseInfo.price,
        purchasePrice: purchaseInfo.purchasePrice,
        shippingName: purchaseInfo.shippingName,
        shippingPhone: purchaseInfo.shippingPhone,
        shippingAddress: purchaseInfo.shippingAddress
      }
    })
    if (!result?.success) throw new Error(result?.message || '打开淘宝商品失败')
  } catch (error) {
    ElMessage.error('打开淘宝商品失败: ' + error.message)
  }
}

async function applyTaobaoSameProduct(product, accountId) {
  if (!product?.link) {
    ElMessage.warning('该搜索结果没有可用商品链接')
    return
  }
  if (!purchaseInfo.skuId) {
    throw new Error('当前销售商品缺少SKU标识，无法添加货源')
  }
  if (product.skuCaptureAttempted && !product.skuPriceCaptured) {
    if (product.promotionPriceMasked || product.skuPriceSource === 'promotion-masked') {
      throw new Error('当前“平台加补后”等优惠价仍显示为圆点，请等待价格显示后重试；本次未保存优惠前价')
    }
    throw new Error('未读取到当前SKU价格，请确认规格已完整选择后重试')
  }

  const sourceLink = shortenUrl(attachTaobaoSkuMetadata(String(product.link).trim(), {
    ...(product.skuSelection || {}),
    shopId: product.shopId,
    sellerId: product.sellerId,
    shopName: product.shop
  }))
  const sourceBaseLink = sourceLink.split('#dxeSku=')[0]
  const existingSource = skuSources.value.find(source =>
    shortenUrl(source.purchase_link || '') === sourceLink
  ) || skuSources.value.find(source => {
    const existingLink = shortenUrl(source.purchase_link || '')
    return existingLink.split('#dxeSku=')[0] === sourceBaseLink
  })
  const purchasePriceValue = product.skuPriceCaptured ? product.currentSkuPrice : product.price
  const purchasePrice = purchasePriceValue != null && Number.isFinite(Number(purchasePriceValue))
    ? Number(purchasePriceValue)
    : Number(existingSource?.purchase_price || 0)

  // “选为货源”需要真正保存SKU货源配置，而不只是回填当前采购表单。
  await saveSkuPurchaseConfig({
    id: existingSource?.id || undefined,
    sku_id: purchaseInfo.skuId,
    platform: 'taobao',
    purchase_link: sourceLink,
    purchase_price: purchasePrice,
    remark: existingSource?.remark || '淘宝同款'
  })

  await loadSkuSources(purchaseInfo.skuId)
  const savedIndex = skuSources.value.findIndex(source =>
    shortenUrl(source.purchase_link || '') === sourceLink
  )
  if (savedIndex >= 0) applySourceToPurchase(savedIndex)
  else {
    purchaseInfo.sourceUrl = sourceLink
    purchaseInfo.sourceShipFrom = String(product.skuSelection?.shipFrom || product.shipFrom || '')
    purchaseInfo.platform = 'taobao'
    purchaseInfo.purchasePrice = purchasePrice
  }
  await nextTick()
  const selectedAccountId = accountId || taobaoSameAccountId.value
  if (selectedAccountId) {
    purchaseInfo.selectedAccountId = selectedAccountId
    localStorage.setItem('lastPurchaseAccount_taobao', String(selectedAccountId))
  }
  // 保留同款结果和滚动位置，方便为同一销售商品连续添加多个货源。
  taobaoSameDialogVisible.value = true
  ElMessage.success(existingSource ? '淘宝货源已更新，可继续选择其他货源' : '淘宝货源已添加，可继续选择其他货源')
}

// 拼多多选品：用采购账号 session 打开 PDD 首页
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

// 去下单：获取采购编号 + 打开内嵌BrowserWindow
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
  if ((purchaseInfo.purchaseType === 'warehouse' || purchaseInfo.purchaseType === 'warehouse_in') && !purchaseInfo.warehouseId) {
    ElMessage.warning('请选择仓库')
    return
  }
  // 三方代发必须先解密客户信息（卡片内有内联提示，此处仅阻止提交）
  if (purchaseInfo.purchaseType === 'dropship' &&
      (purchaseInfo.shippingName.includes('*') || purchaseInfo.shippingAddress.includes('***'))) {
    return
  }

  // 获取采购编号（仅在"去下单"时生成，避免弹开卡片就消耗编号）
  if (!purchaseInfo.purchaseNo) {
    try {
      const noResult = await fetchNextPurchaseNo()
      const purchaseNo = noResult.purchase_no || noResult.data?.purchase_no
      if (!purchaseNo) {
        ElMessage.error('获取采购编号失败')
        return
      }
      purchaseInfo.purchaseNo = purchaseNo
      // 仓库模式：将编号追加到收货地址
      if ((purchaseInfo.purchaseType === 'warehouse' || purchaseInfo.purchaseType === 'warehouse_in') && !purchaseInfo.shippingAddress.includes('【' + purchaseNo + '】')) {
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
          salesOrderId: purchaseInfo.salesOrderId,
          salesOrderNo: purchaseInfo.salesOrderNo,
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

// 取消下单：关闭采购窗口并解锁订单
function handleCancelOrder() {
  if (window.electronAPI) {
    window.electronAPI.invoke('close-purchase-order-window', { purchaseNo: purchaseInfo.purchaseNo })
  }
  purchaseInfo.captureStatus = 'idle'
  // 注意：此处不解锁订单，因为用户仍在采购流程中（弹窗还开着）
  // 解锁由 onPurchaseDialogClosed 统一处理
}

// IPC 事件监听
let unsubOrderCaptured = null
let unsubWindowClosed = null
let unsubAddressFilled = null
let unsubAddressSetupDone = null
let unsubAddressSetupStart = null
let unsubAutoSyncStart = null
let unsubPddProductLink = null
let unsubTaobaoSameSource = null
let unsubAutoSyncResult = null
let unsubSyncProgress = null
let unsubStoreStatusChanged = null
let jdSyncAutoStartTimer = null

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
            order.purchaseStatus = purchaseInfo.purchaseType === 'warehouse' ? '已采购（仓库转发）' : purchaseInfo.purchaseType === 'warehouse_in' ? '已采购（仓库进货）' : '已采购（三方代发）'
            order.hasInventory = false
            // 采购完成，清除锁定状态
            order.purchaseLockedBy = null
            order.purchaseLockedName = null
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
      const typeLabel = purchaseInfo.purchaseType === 'dropship' ? '买家收货地址' : '仓库地址'
      ElMessage({
        message: `${typeLabel}已自动填充（共${data.filledCount}个字段），请核对后提交订单`,
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
  // 监听 PDD 浏览窗口回传的商品链接
  unsubPddProductLink = window.electronAPI.onUpdate('pdd-product-link-update', (data) => {
    if (data && data.url && purchaseInfo.step === 0) {
      purchaseInfo.sourceUrl = data.url
      ElMessage.success('已提取商品链接到货源链接')
    }
  })
  // 淘宝同款商品页中的“选为货源”按钮回传
  unsubTaobaoSameSource = window.electronAPI.onUpdate('taobao-same-source-selected', (data) => {
    if (!data?.product) return
    applyTaobaoSameProduct(data.product, data.accountId).catch(error => {
      ElMessage.error('选择淘宝货源失败: ' + error.message)
    })
  })
}

function cleanupPurchaseListeners() {
  if (unsubOrderCaptured) { unsubOrderCaptured(); unsubOrderCaptured = null }
  if (unsubWindowClosed) { unsubWindowClosed(); unsubWindowClosed = null }
  if (unsubAddressFilled) { unsubAddressFilled(); unsubAddressFilled = null }
  if (unsubAddressSetupDone) { unsubAddressSetupDone(); unsubAddressSetupDone = null }
  if (unsubAddressSetupStart) { unsubAddressSetupStart(); unsubAddressSetupStart = null }
  if (unsubPddProductLink) { unsubPddProductLink(); unsubPddProductLink = null }
  if (unsubTaobaoSameSource) { unsubTaobaoSameSource(); unsubTaobaoSameSource = null }
}

function onPurchaseDialogClosed() {
  taobaoSameDialogVisible.value = false
  taobaoSameResults.value = []
  taobaoSameSearchError.value = ''
  taobaoSameAccountId.value = null
  taobaoSameFromHistory.value = false
  taobaoSameHistoryKey.value = ''
  // 对话框关闭时，如果采购未完成（非captured状态），需要解锁订单
  // captured状态时后端创建采购单已自动解锁
  if (purchaseInfo.captureStatus !== 'captured' && purchaseInfo.salesOrderId) {
    unlockSalesOrderPurchase(purchaseInfo.salesOrderId).catch(e => {
      console.warn('[采购解锁] 关闭弹窗时解锁失败:', e.message)
    })
    // 同时更新列表中的锁定状态
    const order = tableData.value.find(o => o.id === purchaseInfo.salesOrderId)
    if (order) {
      order.purchaseLockedBy = null
      order.purchaseLockedName = null
    }
  }
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
    // 标记为已捕获，防止 onPurchaseDialogClosed 重复解锁
    purchaseInfo.captureStatus = 'captured'
    // 更新本地订单的采购状态
    const order = tableData.value.find(o => o.id === purchaseInfo.salesOrderId)
    if (order) {
      order.purchaseStatus = purchaseInfo.purchaseType === 'warehouse' ? '已采购（仓库转发）' : purchaseInfo.purchaseType === 'warehouse_in' ? '已采购（仓库进货）' : '已采购（三方代发）'
      order.hasInventory = false
      order.purchaseLockedBy = null
      order.purchaseLockedName = null
    }
    purchaseDialogVisible.value = false
  } catch (err) {
    ElMessage.error('采购操作失败: ' + err.message)
  } finally {
    purchaseInfo.submitting = false
  }
}

function handleBindWarehouse(order, item, itemIdx) {
  // 确保仓库列表已加载
  if (warehouseList.value.length === 0) {
    fetchWarehouses().then(res => {
      warehouseList.value = res?.list || res || []
    }).catch(() => {})
  }
  currentBindRow.value = {
    skuId: item.skuId || '',
    productName: item.name || '',
    productImage: item.image || '',
    storeId: order.storeId || item.storeId || '',
    orderItem: item
  }
  bindSearchKeyword.value = item.skuId || item.name || ''
  bindSearchResults.value = []
  bindKeywords.value = extractKeywords(item.name)
  bindNewForm.warehouseId = ''
  bindNewForm.location = ''
  bindNewForm.batchNo = ''
  bindNewForm.supplier = ''
  bindPackageNum.value = 1
  bindDialogVisible.value = true
  searchInventoryForBind()
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
  if (!window.electronAPI) {
    // 非 Electron 环境，降级为打开抽屉
    currentOrder.value = row
    drawerVisible.value = true
    return
  }
  const storeId = row.storeId
  const orderId = row.orderNo
  if (!storeId || !orderId) {
    ElMessage.warning('无法获取订单信息，请重试')
    return
  }
  window.electronAPI.invoke('open-jd-order-detail', { storeId, orderId }).catch(err => {
    ElMessage.error('打开订单详情失败: ' + err.message)
  })
}

// 判断订单是否为代销订单（代销店铺中，warehouse_name 为"供应商仓库"或"官方货源"的是代销单，排除待付款状态）
function isConsignmentOrder(order) {
  const store = storeOptions.value.find(s => s.id === order.storeId)
  if (!store || store.store_type !== 'consignment') return false
  // 待付款订单不显示采购单详情
  if (order.orderStatus === '待付款') return false
  const wh = order.warehouseName || ''
  // 全国仓和具体仓库名（如"宿迁沭阳九问云仓1号库"）不是代销单
  // 供应商仓库、官方货源 是代销单
  return wh === '供应商仓库' || wh === '官方货源'
}

// 点击"采购单详情" — 用代销店铺cookie打开京东供销订单详情页
async function handleGongxiaoDetail(order) {
  const store = storeOptions.value.find(s => s.id === order.storeId)
  if (!store) {
    ElMessage.warning('未找到订单所属店铺')
    return
  }
  const jdOrderId = order.orderNo || ''
  if (!jdOrderId) {
    ElMessage.warning('订单编号为空，无法打开采购单详情')
    return
  }
  const gongxiaoUrl = `https://shop.jd.com/jdm/gongxiao/shopEmbed/seller/orderDetail?orderId=${jdOrderId}`
  try {
    await window.electronAPI.invoke('open-store-backend-url', {
      storeId: store.id,
      url: gongxiaoUrl,
      title: `采购单详情 - ${store.name || '京东代销'}`
    })
  } catch (err) {
    ElMessage.error('打开采购单详情失败: ' + (err.message || ''))
  }
}

function applySmsTemplate() {
  if (smsForm.template === 'custom') return
  if (smsForm.template === 'pickup') {
    const address = smsForm.pickupAddress.trim() || '{取件地址}'
    const code = smsForm.pickupCode.trim() || '{取件码}'
    smsForm.message = `您购买的“商品”已放置${address}，取件码：${code}，请及时取件。`
    return
  }
  if (smsForm.template === 'refund') {
    smsForm.message = '您在京东购买的“商品”，仓库检查出存在质量问题，无法为您发货，请您及时上线申请退款。'
    return
  }
  smsForm.message = '您在京东购买的“商品”，被仓库发错了，已重新补发，您会收到两个包裹，您都签收一下，有问题联系在线客服。'
}

function resetSmsForm(order) {
  smsForm.phone = order?.customerPhone || ''
  smsForm.template = 'reship'
  smsForm.pickupAddress = ''
  smsForm.pickupCode = ''
  smsForm.message = ''
  smsSignName.value = DEFAULT_SMS_SIGN_NAME
  smsHistory.value = []
  smsConfigured.value = true
  applySmsTemplate()
}

function formatSmsTime(value) {
  if (!value) return '--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

function createSmsRequestId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  return `sms_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`
}

function isUsableSmsPhone(value) {
  const phone = String(value || '').trim().replace(/[\s()]/g, '').replace(/^\+86-?/, '')
  return /^(?:86-?)?1\d{10}(?:-[0-9]{1,12})?$/.test(phone)
}

async function handleSmsNotify(order) {
  smsDialogOrder.value = order
  resetSmsForm(order)
  smsDialogVisible.value = true
  smsContextLoading.value = true
  try {
    const context = await fetchSalesOrderSmsContext(order.id)
    smsConfigured.value = context.configured !== false
    smsSignName.value = context.signName || DEFAULT_SMS_SIGN_NAME
    smsHistory.value = Array.isArray(context.history) ? context.history : []

    const contextOrder = context.order || {}
    if (contextOrder.buyer_phone) smsForm.phone = contextOrder.buyer_phone
    smsForm.pickupAddress = contextOrder.pickup_address || ''
    smsForm.pickupCode = contextOrder.pickup_code || ''
    if (smsForm.pickupAddress || smsForm.pickupCode) {
      smsForm.template = 'pickup'
      applySmsTemplate()
    }
    order.smsContent = contextOrder.sms_content || order.smsContent || ''
    order.smsSentAt = contextOrder.sms_sent_at || order.smsSentAt || null
    order.smsSendCount = Number(contextOrder.sms_send_count) || order.smsSendCount || 0

    // 同步列表里经常只有掩码手机号；点击短信时自动获取一次真实信息。
    if (!isUsableSmsPhone(smsForm.phone) && window.electronAPI) {
      await handleRevealBuyerInfo(order)
      if (isUsableSmsPhone(order.customerPhone)) smsForm.phone = order.customerPhone
    }
  } catch (err) {
    console.error('[短信通知] 获取发送信息失败:', err.message)
    ElMessage.error('获取短信信息失败：' + (err.message || '未知错误'))
  } finally {
    smsContextLoading.value = false
  }
}

async function submitSms() {
  if (!smsDialogOrder.value || smsSending.value) return
  if (!smsForm.phone.trim()) {
    ElMessage.warning('请输入接收手机号')
    return
  }
  if (!smsForm.message.trim()) {
    ElMessage.warning('请输入短信内容')
    return
  }
  if (smsForm.template === 'pickup' && (!smsForm.pickupAddress.trim() || !smsForm.pickupCode.trim())) {
    ElMessage.warning('请填写取件地址和取件码')
    return
  }

  smsSending.value = true
  try {
    const result = await sendSalesOrderSms(smsDialogOrder.value.id, {
      requestId: createSmsRequestId(),
      phone: smsForm.phone.trim(),
      message: smsForm.message.trim()
    })
    const order = smsDialogOrder.value
    order.smsContent = `${result.signName || smsSignName.value}${result.content || smsForm.message.trim()}`
    order.smsSentAt = result.sentAt || new Date().toISOString()
    order.smsSendCount = (Number(order.smsSendCount) || 0) + (result.duplicate ? 0 : 1)
    smsHistory.value.unshift({
      id: result.id || result.requestId,
      phone: result.phone || smsForm.phone.trim(),
      sign_name: result.signName || smsSignName.value,
      content: result.content || smsForm.message.trim(),
      sms_count: result.smsCount || smsEstimatedCount.value,
      status: 'success',
      sent_at: result.sentAt || new Date().toISOString()
    })
    ElMessage.success(`短信发送成功，计费 ${result.smsCount || smsEstimatedCount.value} 条`)
  } catch (err) {
    console.error('[短信通知] 发送失败:', err.message)
    ElMessage.error('短信发送失败：' + (err.message || '未知错误'))
  } finally {
    smsSending.value = false
  }
}

// ==================== 标记问题 ====================
const issueDialogVisible = ref(false)
const issueDialogOrder = ref(null)
const issueDialogValue = ref('')
const issueSubmitting = ref(false)

function handleMarkIssue(order) {
  issueDialogOrder.value = order
  issueDialogValue.value = order.issueEvent || ''
  issueDialogVisible.value = true
}

async function submitIssueEvent() {
  if (!issueDialogOrder.value) return
  issueSubmitting.value = true
  try {
    await updateIssueEvent(issueDialogOrder.value.id, issueDialogValue.value)
    issueDialogOrder.value.issueEvent = issueDialogValue.value || null
    ElMessage.success(issueDialogValue.value ? '已标记为：' + issueDialogValue.value : '已取消标记')
    issueDialogVisible.value = false
  } catch (err) {
    console.error('[标记问题] 失败:', err.message)
    ElMessage.error('标记失败：' + (err.message || '未知错误'))
  } finally {
    issueSubmitting.value = false
  }
}

function handleEditRemark(order) {
  ElMessageBox.prompt('请输入备注内容', '编辑本地备注', {
    confirmButtonText: '保存',
    cancelButtonText: '取消',
    inputValue: order.remark || '',
    inputType: 'textarea'
  }).then(async ({ value }) => {
    const remark = (value || '').trim()
    try {
      await updateRemark(order.id, remark)
      order.remark = remark
      ElMessage.success('备注已保存')
    } catch (err) {
      console.error('[备注] 保存失败:', err.message)
      ElMessage.error('备注保存失败：' + (err.message || '未知错误'))
    }
  }).catch(() => {})
}

function handleEditOrderRemark(order) {
  const storeId = order.storeId || searchForm.storeId
  if (!storeId) {
    ElMessage.warning('无法获取店铺信息，请先选择店铺')
    return
  }
  ElMessageBox.prompt('请输入商家备注内容', '编辑商家备注', {
    confirmButtonText: '提交到京东',
    cancelButtonText: '取消',
    inputValue: order.orderRemark || '',
    inputType: 'textarea'
  }).then(async ({ value }) => {
    const remark = (value || '').trim()
    if (!remark) {
      ElMessage.warning('备注内容不能为空')
      return
    }
    const loading = ElMessage({ message: '正在提交备注到京东...', type: 'info', duration: 0 })
    try {
      const result = await submitVendorRemark(storeId, order.orderNo, remark)
      loading.close()
      if (result.success) {
        // 提交成功后更新本地数据库
        order.orderRemark = remark
        try {
          await updateOrderRemark(order.id, remark)
        } catch (e) {
          console.error('[商家备注] 本地更新失败:', e.message)
        }
        ElMessage.success('商家备注已提交到京东')
      } else {
        ElMessage.error('提交失败：' + (result.message || '未知错误'))
      }
    } catch (err) {
      loading.close()
      console.error('[商家备注] 提交失败:', err.message)
      ElMessage.error('提交失败：' + (err.message || '未知错误'))
    }
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
  const map = { '未采购': 'warning', '有货（仓库直发）': 'success', '已采购（三方代发）': 'success', '已采购（仓库转发）': 'success', '已采购（仓库进货）': 'success', '仓库有货': '', '已忽略': 'info', '无效订单': 'info' }
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
    order.purchaseLockedBy = null
    order.purchaseLockedName = null
    // 忽略采购时同步解锁后端数据库中的锁
    unlockSalesOrderPurchase(order.id).catch(e => {
      console.warn('[采购解锁] 忽略采购时解锁失败:', e.message)
    })
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
    // 恢复自动同步开关状态：优先用主进程实际运行状态，再用localStorage记忆
    try {
      const { running, syncing } = await window.electronAPI.invoke('jd-auto-sync-status')
      if (running) {
        // 主进程定时器还在跑，只需恢复UI状态，不要重新启动（避免打断正在进行的同步）
        funcSettings.syncJdOrder = true
        if (syncing) {
          // 当前有同步轮次正在执行，显示状态提示
          mainProcessSyncStatus.value = '自动同步进行中...'
        }
      } else {
        // 主进程定时器已停止，按localStorage记忆恢复
        funcSettings.syncJdOrder = localStorage.getItem('jdAutoSyncEnabled') === 'true'
        // 只有主进程没在运行且上次状态是开启时，才需要重新启动同步
        if (funcSettings.syncJdOrder) {
          jdSyncAutoStartTimer = setTimeout(() => {
            jdSyncAutoStartTimer = null
            onFuncChange('syncJdOrder', true)
          }, 2000)
        }
      }
    } catch (e) {
      funcSettings.syncJdOrder = localStorage.getItem('jdAutoSyncEnabled') === 'true'
      if (funcSettings.syncJdOrder) {
        jdSyncAutoStartTimer = setTimeout(() => {
          jdSyncAutoStartTimer = null
          onFuncChange('syncJdOrder', true)
        }, 2000)
      }
    }

    unsubAutoSyncStart = window.electronAPI.onUpdate('auto-sync-start', (data) => {
      console.log('[自动同步] 收到 auto-sync-start:', JSON.stringify(data))
      mainProcessSyncStatus.value = `${data.storeName || '店铺'}正在同步中...`
    })
    unsubAutoSyncResult = window.electronAPI.onUpdate('auto-sync-result', async (data) => {
      console.log('[自动同步] 收到 auto-sync-result:', JSON.stringify(data))
      mainProcessSyncStatus.value = ''
      autoSyncStatus.value = ''
      if (data.skipped) {
        syncSkipStatus.value = data.message || `${data.storeName || '店铺'}已跳过`
        // 5秒后自动清除跳过提示
        setTimeout(() => {
          syncSkipStatus.value = ''
        }, 5000)
      } else if (data.success) {
        // 订单已由主进程直接保存到服务器，此处只做刷新
        loadOrdersFromServer()
        loadStatusCounts()
      } else if (data.cookieFailed) {
        const msg = `${data.storeName || '店铺'}cookie已失效，请到店铺管理界面重新登录！`
        ElMessage.warning({ message: msg, duration: 8000 })
        try {
          const utterance = new SpeechSynthesisUtterance(msg)
          utterance.lang = 'zh-CN'
          utterance.rate = 1
          speechSynthesis.speak(utterance)
        } catch (e) { /* 语音不可用时静默 */ }
      }
    })
    unsubSyncProgress = window.electronAPI.onUpdate('auto-sync-progress', (data) => {
      if (data.stage === 'secondary') {
        mainProcessSyncStatus.value = data.message || `${data.storeName || '店铺'}二次同步中...`
      }
    })
    // 监听店铺在线状态变化（心跳检测）
    unsubStoreStatusChanged = window.electronAPI.onUpdate('store-status-changed', (data) => {
      loadStores()
      if (data.online === false && data.wasOnline === true) {
        const msg = `${data.storeName || '店铺'}cookie已失效，请到店铺管理界面重新登录！`
        ElMessage.warning({ message: msg, duration: 8000 })
        try {
          const utterance = new SpeechSynthesisUtterance(msg)
          utterance.lang = 'zh-CN'
          utterance.rate = 1
          speechSynthesis.speak(utterance)
        } catch (e) { /* 语音不可用时静默 */ }
      }
    })
  }
})

onUnmounted(() => {
  // 确保对话框关闭（防止 el-overlay 遮罩层残留）
  purchaseDialogVisible.value = false
  // 清理京东同步自动开启定时器
  if (jdSyncAutoStartTimer) { clearTimeout(jdSyncAutoStartTimer); jdSyncAutoStartTimer = null }
  if (sourceTimelinessTimer) { clearTimeout(sourceTimelinessTimer); sourceTimelinessTimer = null }
  sourceTimelinessRequestId++
  // 清理采购相关 IPC 监听器
  cleanupPurchaseListeners()
  // 清理自动同步 IPC 监听器
  if (unsubAutoSyncStart) { unsubAutoSyncStart(); unsubAutoSyncStart = null }
  if (unsubAutoSyncResult) { unsubAutoSyncResult(); unsubAutoSyncResult = null }
  if (unsubSyncProgress) { unsubSyncProgress(); unsubSyncProgress = null }
  if (unsubStoreStatusChanged) { unsubStoreStatusChanged(); unsubStoreStatusChanged = null }
  manualSyncStatus.value = ''
  autoSyncStatus.value = ''
  mainProcessSyncStatus.value = ''
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

/* ==================== 操作按钮 ==================== */

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
  align-items: flex-start;
  justify-content: flex-start;
  text-align: left;
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
  position: relative;
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  overflow: hidden;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  background: #fff;
}

/* 职业打假水印覆盖层 */
.issue-watermark {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-size: 160px 160px;
  background-repeat: no-repeat;
  background-position: center;
  transform: rotate(-10deg);
  opacity: 0.35;
  pointer-events: none;
  z-index: 10;
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

.order-header-warehouse {
  font-size: 12px;
  margin-left: 4px;
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

/* 库存信息展示 */
.goods-inventory-info {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
  cursor: pointer;
}

.goods-inventory-info:hover {
  opacity: 0.8;
}

.inv-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 3px;
  white-space: nowrap;
  font-weight: 500;
}

.inv-tag-stock {
  background: #f0f9ff;
  color: #0958d9;
  border: 1px solid #bae0ff;
}

.inv-tag-stock.inv-low {
  background: #fff2f0;
  color: #cf1322;
  border-color: #ffccc7;
}

.inv-tag-transit {
  background: #f6ffed;
  color: #389e0d;
  border: 1px solid #b7eb8f;
}

.inv-tag-unpurchased {
  background: #fffbe6;
  color: #d48806;
  border: 1px solid #ffe58f;
}

.inv-tag-delayed {
  background: #fff2f0;
  color: #cf1322;
  border: 1px solid #ffccc7;
}

.inv-warehouse {
  font-size: 11px;
  color: #9ca3af;
  margin-left: 2px;
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

.goods-img {
  width: 90px;
  height: 90px;
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

.goods-name-link {
  cursor: pointer;
  transition: color 0.2s;
}
.goods-name-link:hover {
  color: #409eff;
}

.goods-sku {
  font-size: 12px;
  color: #9ca3af;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goods-status-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
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
.order-body-right .ot-col-logistics {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 12px 8px;
  position: relative;
}

.order-body-right .ot-col-remark {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
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

/* 可编辑备注的编辑图标 */
.remark-edit-icon {
  flex-shrink: 0;
  color: #9ca3af;
  cursor: pointer;
  font-size: 12px;
  margin-top: 2px;
  &:hover {
    color: #2b5aed;
  }
}

/* 本地备注蓝色字体 */
.remark-text-merchant {
  color: #2b5aed;
  font-weight: 500;
}

/* 买家留言橙色字体 */
.remark-text-buyer {
  color: #e6a23c;
  font-weight: 500;
}

/* 订单备注红色字体 */
.remark-text-order {
  color: #f56c6c;
  font-weight: 500;
}

/* 详情面板-备注编辑图标 */
.detail-remark-edit-icon {
  color: #9ca3af;
  cursor: pointer;
  font-size: 13px;
  vertical-align: middle;
  margin-left: 4px;
  &:hover {
    color: #2b5aed;
  }
}

/* 备注区域虚线分隔 */
.remark-divider {
  border-top: 1px dashed #dcdfe6;
  margin: 3px 0;
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

.shipping-banner {
  margin-bottom: 16px;
}
.shipping-banner .info-card {
  border-radius: 8px;
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

/* 右侧商品信息卡片 */
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

.section-header-actions {
  display: flex;
  align-items: center;
  gap: 5px;
}

.section-header-actions.selection-tools-bar {
  padding: 4px 6px;
  border: 1px solid #f2d8bd;
  border-radius: 8px;
  background: linear-gradient(180deg, #fffaf3 0%, #fff5e8 100%);
  box-shadow: 0 1px 3px rgba(168, 105, 45, 0.08);
}

.selection-tools-logo {
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 6px;
  object-fit: cover;
}

.selection-tools-divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: #efd6bd;
}

.section-header-actions .selection-tool-btn {
  height: 26px;
  margin-left: 0;
  padding: 0 9px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  line-height: 24px;
  box-shadow: none;
}

.section-header-actions .taobao-same-tool-btn {
  background: transparent;
  color: #ff5000;
}

.section-header-actions .pdd-selection-tool-btn {
  background: transparent;
  color: #e02e24;
}

.section-header-actions .taobao-same-tool-btn:hover,
.section-header-actions .taobao-same-tool-btn:focus {
  background: #fff0e6;
  color: #ff5000;
}

.section-header-actions .pdd-selection-tool-btn:hover,
.section-header-actions .pdd-selection-tool-btn:focus {
  background: #fdeceb;
  color: #e02e24;
}

.section-header-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.section-header-actions :deep(.el-button span) {
  color: inherit;
  font-size: 12px;
  font-weight: 400;
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
  flex-shrink: 0;
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
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.source-option-recommendation {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: flex-end;
  margin-left: 10px;
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

.source-option-origin {
  padding: 2px 6px;
  border-radius: 4px;
  background: #f0f9eb;
  color: #67c23a;
  font-size: 12px;
  white-space: nowrap;
}

.source-option-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
}

.source-option-badge .el-icon {
  font-size: 14px;
}

.source-option-price-lowest {
  color: #319447;
  background: #f3fff5;
  border: 1px solid #91d5a0;
}

.source-option-best-timeliness {
  color: #2f6ee5;
  background: #f4f8ff;
  border: 1px solid #9bbcff;
}

.source-option-purchase-preferred {
  color: #f08a00;
  background: #fffaf0;
  border: 1px solid #f4a11a;
  box-shadow: 0 2px 5px rgba(240, 138, 0, 0.12);
}

.source-option-eta {
  color: #4b5563;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.source-option-risk {
  color: #d9485f;
  background: #fff1f3;
  border: 1px solid #ffc9d2;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.source-manage-origin {
  margin-top: 3px;
  color: #67c23a;
  font-size: 11px;
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
  display: block;
  width: 100%;
}

.source-area {
  width: 100%;
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

.taobao-same-source {
  display: flex;
  align-items: stretch;
  gap: 16px;
  padding: 12px 14px;
  margin-bottom: 16px;
  background: linear-gradient(135deg, #fffaf6 0%, #fff5ed 100%);
  border: 1px solid #ffd9bd;
  border-radius: 10px;
}

.taobao-same-source-media {
  position: relative;
  width: 96px;
  height: 96px;
  flex-shrink: 0;
}

.taobao-same-source-media :deep(.el-image),
.taobao-same-source-image-empty {
  width: 96px;
  height: 96px;
  overflow: hidden;
  border: 1px solid rgba(255, 122, 0, 0.16);
  border-radius: 8px;
  background: #fff;
  cursor: zoom-in;
}

.taobao-same-source-image-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c0c4cc;
  cursor: default;
  font-size: 30px;
}

.taobao-same-source-media > span {
  position: absolute;
  bottom: 0;
  left: 0;
  padding: 3px 7px;
  border-radius: 0 7px 0 7px;
  background: rgba(255, 80, 0, 0.92);
  color: #fff;
  font-size: 11px;
  line-height: 16px;
}

.taobao-same-source-info {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
}

.taobao-same-source-heading {
  display: flex;
  min-height: 20px;
  align-items: center;
  gap: 7px;
}

.taobao-same-source-heading > span {
  color: #ff5000;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
}

.taobao-same-source-heading :deep(.el-tag) {
  height: 20px;
}

.taobao-same-source-heading :deep(.el-button) {
  height: 20px;
  padding: 0 2px;
  font-size: 12px;
}

.taobao-same-source-info strong {
  display: -webkit-box;
  overflow: hidden;
  color: #303133;
  font-size: 15px;
  line-height: 21px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.taobao-same-source-sku {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.taobao-same-source-sku span {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 4px;
  background: #ffede1;
  color: #ff5000;
  font-size: 11px;
  line-height: 17px;
}

.taobao-same-source-sku b {
  overflow: hidden;
  color: #d94800;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.taobao-same-source-note {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 14px;
  color: #909399;
  font-size: 12px;
}

.taobao-same-source-order-meta {
  padding-left: 14px;
  border-left: 1px solid #f0d8c6;
}

.taobao-same-source-order-meta b {
  color: #606266;
  font-weight: 600;
}

.taobao-same-loading {
  display: flex;
  min-height: 320px;
  align-items: center;
  justify-content: center;
  color: #909399;
}

.taobao-same-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  max-height: min(570px, calc(100vh - 300px));
  padding: 2px;
  overflow-y: auto;
}

.taobao-same-card {
  position: relative;
  overflow: hidden;
  background: #fff;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  cursor: pointer;
  transition: box-shadow 0.2s, transform 0.2s;
}

.taobao-same-source-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  padding: 3px 8px;
  border-radius: 10px;
  background: linear-gradient(135deg, #ff7a00, #ff4d00);
  box-shadow: 0 2px 8px rgba(255, 80, 0, 0.28);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
}

.taobao-same-card:hover {
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.1);
  transform: translateY(-2px);
}

.taobao-same-image {
  display: block;
  width: 100%;
  height: auto;
  aspect-ratio: 1 / 1;
  cursor: pointer;
}

.taobao-same-image-error {
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
  justify-content: center;
  background: #f5f7fa;
  color: #c0c4cc;
  font-size: 34px;
}

.taobao-same-card-body {
  padding: 10px;
}

.taobao-same-title {
  display: -webkit-box;
  min-height: 40px;
  overflow: hidden;
  color: #303133;
  font-size: 13px;
  line-height: 20px;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.taobao-same-price-row {
  display: flex;
  min-height: 28px;
  align-items: baseline;
  gap: 7px;
  margin-top: 6px;
}

.taobao-same-price {
  color: #ff5000;
  font-size: 17px;
  font-weight: 700;
}

.taobao-same-price-row del {
  color: #b1b3b8;
  font-size: 11px;
}

.taobao-same-meta {
  display: flex;
  min-width: 0;
  justify-content: space-between;
  gap: 8px;
  color: #909399;
  font-size: 11px;
}

.taobao-same-meta span:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sms-order-summary {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 16px;
  background: #f7f8fa;
  border: 1px solid #ebeef5;
  border-radius: 8px;
}

.sms-order-summary > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.sms-order-summary strong {
  overflow: hidden;
  color: #303133;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sms-summary-label {
  color: #909399;
  font-size: 12px;
}

.sms-form :deep(.el-form-item) {
  margin-bottom: 18px;
}

.sms-field-tip,
.sms-count-tip {
  width: 100%;
  margin-top: 5px;
  color: #909399;
  font-size: 12px;
  line-height: 1.5;
}

.sms-count-tip strong {
  color: #e6a23c;
  font-size: 14px;
}

.sms-history-list {
  max-height: 210px;
  overflow-y: auto;
}

.sms-history-item {
  padding: 10px 12px;
  margin-bottom: 8px;
  background: #fafafa;
  border: 1px solid #ebeef5;
  border-radius: 6px;
}

.sms-history-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  color: #909399;
  font-size: 12px;
}

.sms-history-content {
  color: #606266;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}

.sms-history-error {
  margin-top: 5px;
  color: #f56c6c;
  font-size: 12px;
}

</style>
