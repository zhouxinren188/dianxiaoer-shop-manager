<template>
  <div class="page-container">
    <!-- 1. 筛选栏 + 功能区 -->
    <div class="filter-panel">
      <div class="filter-main">
        <div class="filter-grid">
          <div class="filter-item">
            <label class="filter-label">选择店铺</label>
            <el-select v-model="searchForm.storeId" filterable clearable placeholder="全部店铺">
              <el-option v-for="s in storeOptions" :key="s.id" :label="s.name" :value="s.id">
                <div style="display:flex;align-items:center;justify-content:space-between">
                  <span>{{ s.name }}</span>
                  <el-tag v-if="s.online" type="success" size="small">在线</el-tag>
                </div>
              </el-option>
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">订单编号</label>
            <el-input v-model="searchForm.orderNo" placeholder="请输入站外订单编号" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">商品名称</label>
            <el-input v-model="searchForm.goodsName" placeholder="请输入关键词" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">发货单号</label>
            <el-input v-model="searchForm.outboundNo" placeholder="" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">客户姓名</label>
            <el-input v-model="searchForm.customerName" placeholder="请输入关键词" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">客户电话</label>
            <el-input v-model="searchForm.customerPhone" placeholder="请输入关键词" clearable />
          </div>
          <div class="filter-item">
            <label class="filter-label">订单状态</label>
            <el-select v-model="searchForm.orderStatus" placeholder="请选择" clearable>
              <el-option v-for="s in orderStatusOptions" :key="s" :label="s" :value="s" />
            </el-select>
          </div>
          <div class="filter-item">
            <label class="filter-label">问题事件</label>
            <el-select v-model="searchForm.issueEvent" placeholder="无筛选" clearable>
              <el-option v-for="e in issueEventOptions" :key="e" :label="e" :value="e" />
            </el-select>
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
            <p class="func-item-desc">(每10分钟，同步1次店铺订单信息及状态)</p>
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
        <el-button class="action-btn action-btn-orange" @click="handleQueryOrders">
          <el-icon><Search /></el-icon>
          <span>查询订单</span>
        </el-button>
        <el-button class="action-btn action-btn-blue" :disabled="loading || !!autoSyncStatus" @click="handleSyncOrders">
          <el-icon><Refresh /></el-icon>
          <span>同步订单</span>
        </el-button>
        <span v-if="autoSyncStatus" class="auto-sync-tip">
          <el-icon class="sync-spin"><Refresh /></el-icon>
          {{ autoSyncStatus }} 订单正在同步中...
        </span>
      </div>
      <div class="action-center">
        <span class="action-stat">出库即将超时订单数：<em class="stat-num">{{ nearTimeoutCount }}</em></span>
        <span class="action-stat">超时未出库订单数：<em class="stat-num">{{ timeoutCount }}</em></span>
      </div>
      <div class="action-right">
        <el-button class="action-btn action-btn-green" @click="handleTrackShip">
          <el-icon><Van /></el-icon>
          <span>轨迹发货</span>
        </el-button>
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

    <!-- 4. 卡片式订单列表 -->
    <div class="table-card" v-loading="loading" element-loading-text="正在从京麦后台获取订单数据...">
      <!-- 表头 -->
      <div class="order-table-header">
        <div class="ot-col ot-col-check">
          <el-checkbox v-model="selectAll" @change="handleSelectAll" />
        </div>
        <div class="ot-col ot-col-index">序号</div>
        <div class="ot-col ot-col-goods">商品信息</div>
        <div class="ot-col ot-col-price">单价/数量</div>
        <div class="ot-col ot-col-purchase">采购</div>
        <div class="ot-col ot-col-amount">订单金额</div>
        <div class="ot-col ot-col-time">下单时间</div>
        <div class="ot-col ot-col-logistics">物流信息</div>
        <div class="ot-col ot-col-aftersale">售后信息</div>
        <div class="ot-col ot-col-remark">商家备注</div>
        <div class="ot-col ot-col-sysremark">系统备注</div>
        <div class="ot-col ot-col-action">操作</div>
      </div>

      <!-- 订单卡片列表 -->
      <div class="order-list" v-if="pagedOrders.length">
        <div
          class="order-card"
          v-for="(order, orderIdx) in pagedOrders"
          :key="order.id"
        >
          <!-- 订单卡片头部条 -->
          <div class="order-card-header"
               :style="{
                 borderLeftColor: statusBorderColor(order.orderStatus),
                 background: statusBgColor(order.orderStatus)
               }">
            <div class="order-header-left">
              <el-checkbox v-model="order.selected" @change="handleOrderSelect" />
              <span class="order-header-label">订单编号:</span>
              <span class="order-header-no">{{ order.orderNo }}</span>
              <span class="order-header-divider">|</span>
              <span class="order-header-shop">{{ order.shopName }}</span>
              <el-tag size="small" :type="shopTagColorType(order.shopTag)" effect="plain" class="order-header-platform">{{ order.shopTag }}</el-tag>
              <span class="order-header-divider">|</span>
              <span v-if="order.buyerAccount" class="order-header-account">{{ order.buyerAccount }}</span>
              <el-icon v-if="order.buyerAccount" class="order-header-chat-icon" title="打开京麦咚咚聊天" @click.stop="handleOpenChat(order)"><ChatDotRound /></el-icon>
              <span class="order-header-buyer">{{ order.customerName }}</span>
              <span v-if="order.customerPhone" class="order-header-phone">{{ order.customerPhone }}</span>
              <span class="order-header-address">{{ order.address }}</span>
            </div>
            <div class="order-header-right">
              <el-tag :type="orderStatusTagType(order.orderStatus)" size="small">{{ order.orderStatus }}</el-tag>
              <el-tag v-if="order.purchaseStatus" :type="purchaseStatusTagType(order.purchaseStatus)" size="small" effect="plain">{{ order.purchaseStatus }}</el-tag>
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
                <div class="ot-col ot-col-index">
                  <span v-if="itemIdx === 0" class="index-num">{{ (currentPage - 1) * pageSize + orderIdx + 1 }}</span>
                </div>
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
                      <div class="goods-search-row">
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
                <div class="ot-col ot-col-price">
                  <div class="price-cell">
                    <span class="price-value">¥{{ item.price.toFixed(2) }}</span>
                    <span class="price-qty">x {{ item.quantity }}</span>
                  </div>
                </div>
                <div class="ot-col ot-col-purchase">
                  <el-button type="warning" size="small" plain @click.stop="handlePurchase(order, item, itemIdx)">
                    <el-icon><ShoppingCart /></el-icon>
                    <span>采购</span>
                  </el-button>
                </div>
                <div class="ot-col ot-col-warehouse">
                  <el-button size="small" plain @click.stop="handleBindWarehouse(order, item, itemIdx)">
                    <el-icon><OfficeBuilding /></el-icon>
                    <span>绑定仓库商品</span>
                  </el-button>
                </div>
              </div>
            </div>

            <!-- 右侧：订单级信息（纵向居中） -->
            <div class="order-body-right">
              <div class="ot-col ot-col-amount">
                <span class="amount-main">¥{{ order.actualAmount.toFixed(2) }}</span>
                <p class="amount-sub">含运费 ¥{{ order.shippingFee.toFixed(2) }}</p>
              </div>
              <div class="ot-col ot-col-time">
                <span class="time-text">{{ order.orderTime }}</span>
              </div>
              <div class="ot-col ot-col-logistics">
                <template v-if="order.logisticsCompany">
                  <p class="logistics-company">{{ order.logisticsCompany }}</p>
                  <p class="logistics-no">{{ order.logisticsNo }}</p>
                </template>
                <span v-else class="text-muted">--</span>
              </div>
              <div class="ot-col ot-col-aftersale">
                <el-tag v-if="order.issueEvent" type="warning" size="small">{{ order.issueEvent }}</el-tag>
                <span v-else class="text-muted">--</span>
              </div>
              <div class="ot-col ot-col-remark">
                <span v-if="order.remark" class="remark-text">{{ order.remark }}</span>
                <span v-else class="text-muted">--</span>
                <el-button type="primary" link size="small" class="remark-edit-btn" @click.stop="handleEditRemark(order)">
                  <el-icon><Edit /></el-icon>
                </el-button>
              </div>
              <div class="ot-col ot-col-sysremark">
                <span v-if="order.sysRemark" class="sysremark-text">{{ order.sysRemark }}</span>
                <span v-else class="text-muted">--</span>
              </div>
              <div class="ot-col ot-col-action">
                <el-button type="primary" link size="small" @click="handleView(order)">查看详情</el-button>
                <el-button type="success" link size="small" @click="handleSmsNotify(order)">
                  <el-icon><Message /></el-icon>
                  <span>短信</span>
                </el-button>
              </div>
            </div>
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
            <el-tag v-if="currentOrder.purchaseStatus" :type="purchaseStatusTagType(currentOrder.purchaseStatus)" size="small" effect="plain">{{ currentOrder.purchaseStatus }}</el-tag>
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
      title="采购下单"
      width="560px"
      align-center
      :close-on-click-modal="false"
      @closed="onPurchaseDialogClosed"
    >
      <!-- Step 1: idle 状态 - 信息+选账号 -->
      <div v-if="purchaseInfo.step === 1 && purchaseInfo.captureStatus === 'idle'">
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
          <el-descriptions-item label="销售订单号">{{ purchaseInfo.salesOrderNo }}</el-descriptions-item>
          <el-descriptions-item label="采购编号">
            <span style="color: #e6a23c; font-weight: 600">{{ purchaseInfo.purchaseNo }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <el-alert
          type="info"
          :closable="false"
          style="margin-top: 16px"
          title="操作提示"
          description="填写货源链接并选择采购账号后点击「去下单」，系统将自动获取订单号并绑定。"
        />
        <div style="margin-top: 16px">
          <el-form label-width="90px">
            <el-form-item label="货源链接">
              <div v-if="skuSources.length > 0" style="margin-bottom:8px;max-height:160px;overflow-y:auto;">
                <div v-for="(src, idx) in skuSources" :key="idx"
                  style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;margin-bottom:4px;cursor:pointer;transition:all 0.2s;"
                  :style="selectedSourceIndex === idx ? 'background:#ecf5ff;border:1px solid #409eff;' : 'background:#f5f7fa;border:1px solid transparent;'"
                  @click="applySourceToPurchase(idx)">
                  <el-tag size="small" :type="platformTagType(src.platform)">{{ platformLabel(src.platform) }}</el-tag>
                  <span style="flex:1;min-width:0;font-size:12px;color:#409eff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" :title="src.purchase_link">{{ src.purchase_link }}</span>
                  <span v-if="src.purchase_price" style="font-size:12px;color:#f56c6c;flex-shrink:0;">¥{{ Number(src.purchase_price).toFixed(2) }}</span>
                </div>
              </div>
              <div v-else style="color:#909399;font-size:13px;margin-bottom:8px;">暂无货源链接，请先添加</div>
              <el-button type="primary" size="small" plain @click="openAddSourceForm">
                <el-icon><Plus /></el-icon>
                <span style="margin-left:4px;">新增货源</span>
              </el-button>
            </el-form-item>
            <el-form-item label="采购平台">
              <el-radio-group v-model="purchaseInfo.platform">
                <el-radio value="taobao">淘宝/天猫</el-radio>
                <el-radio value="pinduoduo">拼多多</el-radio>
                <el-radio value="1688">1688</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="采购账号">
              <el-select v-model="purchaseInfo.selectedAccountId" placeholder="请选择采购账号" filterable style="width: 100%">
                <el-option v-for="acc in filteredPurchaseAccounts" :key="acc.id" :label="acc.account || '未命名'" :value="acc.id">
                  <div style="display:flex;align-items:center;justify-content:space-between">
                    <span>{{ acc.account || '未命名' }}</span>
                    <el-tag :type="acc.online ? 'success' : 'info'" size="small">{{ acc.online ? '在线' : '离线' }}</el-tag>
                  </div>
                </el-option>
              </el-select>
              <div v-if="filteredPurchaseAccounts.length === 0" style="color:#e6a23c;font-size:12px;margin-top:4px">
                该平台暂无采购账号，请先在「采购订单」页面添加并登录
              </div>
            </el-form-item>
            <el-form-item label="采购类型">
              <el-radio-group v-model="purchaseInfo.purchaseType">
                <el-radio value="dropship">三方代发</el-radio>
                <el-radio value="warehouse">仓库发货</el-radio>
              </el-radio-group>
            </el-form-item>
            <!-- 仓库发货时选择仓库 -->
            <el-form-item v-if="purchaseInfo.purchaseType === 'warehouse'" label="选择仓库">
              <el-select v-model="purchaseInfo.warehouseId" placeholder="请选择发货仓库" style="width: 100%" @change="onWarehouseChange">
                <el-option v-for="wh in warehouseList" :key="wh.id" :label="wh.name" :value="wh.id" />
              </el-select>
              <div v-if="warehouseList.length === 0" style="color:#e6a23c;font-size:12px;margin-top:4px">
                暂无仓库，请先在「仓库管理」页面添加
              </div>
            </el-form-item>
            <!-- 收货地址预览 -->
            <el-form-item label="收货地址">
              <div style="background:#f5f7fa;border-radius:6px;padding:10px 12px;font-size:13px;line-height:1.8;color:#303133;width:100%">
                <div v-if="purchaseInfo.shippingName || purchaseInfo.shippingPhone">
                  <span style="font-weight:600">{{ purchaseInfo.shippingName }}</span>
                  <span v-if="purchaseInfo.shippingPhone" style="margin-left:12px;color:#606266">{{ purchaseInfo.shippingPhone }}</span>
                </div>
                <div v-if="purchaseInfo.shippingAddress" style="color:#606266">{{ purchaseInfo.shippingAddress }}</div>
                <div v-if="!purchaseInfo.shippingName && !purchaseInfo.shippingAddress" style="color:#c0c4cc">
                  {{ purchaseInfo.purchaseType === 'dropship' ? '暂无买家地址信息' : '请选择发货仓库' }}
                </div>
                <div style="margin-top:4px">
                  <el-tag size="small" :type="purchaseInfo.purchaseType === 'dropship' ? 'success' : 'warning'" effect="plain">
                    {{ purchaseInfo.purchaseType === 'dropship' ? '买家地址（三方代发）' : '仓库地址（仓库发货）' }}
                  </el-tag>
                </div>
              </div>
            </el-form-item>
            <el-form-item label="采购价">
              <el-input-number v-model="purchaseInfo.purchasePrice" :min="0" :precision="2" :step="1" style="width: 180px" />
            </el-form-item>
            <el-form-item label="备注">
              <el-input v-model="purchaseInfo.remark" type="textarea" :rows="2" placeholder="选填，方便下次采购时快速识别" />
            </el-form-item>
          </el-form>
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
import { Search, Refresh, Goods, Van, ChatDotRound, ShoppingCart, OfficeBuilding, Loading, CircleCheck, Link, Plus, Edit, Delete, Message } from '@element-plus/icons-vue'
import { fetchStores } from '@/api/store'
import { fetchSalesOrders, saveSalesOrders } from '@/api/salesOrder'
import { createPurchaseOrder, bindPlatformOrderNo } from '@/api/purchaseOrder'
import { fetchSkuPurchaseConfigList, saveSkuPurchaseConfig, deleteSkuPurchaseConfig, detectPlatformFromUrl } from '@/api/skuPurchaseConfig'
import { fetchPurchaseAccounts } from '@/api/purchaseAccount'
import { fetchWarehouses } from '@/api/warehouse'

// ==================== 筛选项配置 ====================

const orderStatusOptions = ['待付款', '待发货', '已发货', '已完成', '已取消']
const issueEventOptions = ['超时未发货', '库存不足', '物流异常', '客户拒收']

const AVATAR_COLORS = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373', '#ba68c8', '#4db6ac', '#7986cb', '#f06292', '#aed581', '#ff8a65']

// ==================== 状态 ====================

const storeOptions = ref([])
const tableData = ref([])
const loading = ref(false)

const searchForm = reactive({
  storeId: '',
  orderNo: '',
  goodsName: '',
  outboundNo: '',
  customerName: '',
  customerPhone: '',
  orderStatus: '',
  issueEvent: ''
})

const activeStatus = ref('')
const currentPage = ref(1)
const pageSize = ref(20)
const selectAll = ref(false)

// 自动同步状态
const autoSyncStatus = ref('')  // 正在同步的店铺名称，为空表示未在同步

// ==================== 功能区 ====================

const funcSettings = reactive({
  autoOutbound: true,
  largeLogistics: true,
  syncJdOrder: true,
  syncPurchaseOrder: true
})

function onFuncChange(key, value) {
  console.log(`[功能区开关] ${key}: ${value}`)
}

function onFuncBtnClick(action) {
  console.log(`[功能区按钮] ${action}`)
}

// ==================== 数据加载 ====================

async function loadStores() {
  try {
    const data = await fetchStores({ platform: 'jd', status: 'enabled', pageSize: 100 })
    storeOptions.value = data.list || []
    const onlineStore = storeOptions.value.find(s => s.online === 1)
    if (onlineStore) {
      searchForm.storeId = onlineStore.id
    } else if (storeOptions.value.length > 0) {
      searchForm.storeId = storeOptions.value[0].id
    }
  } catch (err) {
    console.error('加载店铺列表失败:', err.message)
  }
}

function getSelectedStoreName() {
  const store = storeOptions.value.find(s => s.id === searchForm.storeId)
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
    orderStatus: row.status_text || '',
    purchaseStatus: '',
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
    shopName: getSelectedStoreName(),
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
    const params = { pageSize: 500 }
    if (searchForm.storeId) params.store_id = searchForm.storeId
    const data = await fetchSalesOrders(params)
    const list = (data.list || []).map(mapServerOrder)
    tableData.value = list
  } catch (err) {
    console.warn('从服务器加载订单失败:', err.message)
  }
}

// ==================== 操作栏 ====================

function handleQueryOrders() {
  currentPage.value = 1
  loadOrdersFromServer()
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
  autoSyncStatus.value = storeName

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
      }
    } else {
      ElMessage({ message: result.message || '获取订单失败', type: 'error', center: true })
    }
  } catch (err) {
    ElMessage({ message: '获取订单失败: ' + err.message, type: 'error', center: true })
  } finally {
    loading.value = false
    autoSyncStatus.value = ''
  }
}

function handleTrackShip() {
  console.log('[操作栏] 轨迹发货')
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

async function handlePurchase(order, item, itemIdx) {
  const timestamp = Date.now().toString(36).toUpperCase()
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  const purchaseNo = `CG${timestamp}${random}`

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
  // 默认使用买家地址（三方代发）
  purchaseInfo.shippingName = order.customerName || ''
  purchaseInfo.shippingPhone = order.customerPhone || ''
  purchaseInfo.shippingAddress = order.address || ''
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
    if (res && res.list) {
      purchaseAccounts.value = res.list
    } else if (Array.isArray(res)) {
      purchaseAccounts.value = res
    } else {
      purchaseAccounts.value = []
      console.warn('[采购下单] 采购账号API返回格式异常:', res)
    }
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
  // 如果只有一个仓库，自动选中
  if (warehouseList.value.length === 1) {
    applyWarehouseAddress(warehouseList.value[0])
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
  } catch (e) {}
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
  warehouseAddress: ''
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

// 仓库下拉切换时更新地址
function onWarehouseChange(whId) {
  const wh = warehouseList.value.find(w => w.id === whId)
  if (wh) {
    applyWarehouseAddress(wh)
    // 如果当前是仓库发货，同步更新收货地址
    if (purchaseInfo.purchaseType === 'warehouse') {
      purchaseInfo.shippingName = wh.contact || wh.name || ''
      purchaseInfo.shippingPhone = wh.phone || ''
      purchaseInfo.shippingAddress = wh.location || wh.address || ''
    }
  }
}

// 采购类型切换时自动更新收货地址
watch(() => purchaseInfo.purchaseType, (type) => {
  if (type === 'dropship') {
    purchaseInfo.shippingName = purchaseInfo.buyerName
    purchaseInfo.shippingPhone = purchaseInfo.buyerPhone
    purchaseInfo.shippingAddress = purchaseInfo.buyerAddress
  } else if (type === 'warehouse') {
    purchaseInfo.shippingName = purchaseInfo.warehouseContact || purchaseInfo.warehouseName
    purchaseInfo.shippingPhone = purchaseInfo.warehousePhone
    purchaseInfo.shippingAddress = purchaseInfo.warehouseAddress
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

  let finalUrl = url
  if (!/^https?:\/\//i.test(finalUrl)) {
    finalUrl = 'https://' + finalUrl
  }

  // 记住使用的账号
  localStorage.setItem('lastPurchaseAccount_' + purchaseInfo.platform, String(purchaseInfo.selectedAccountId))

  // 调用主进程打开采购窗口
  if (window.electronAPI) {
    window.electronAPI.invoke('open-purchase-order-window', {
      accountId: purchaseInfo.selectedAccountId,
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
let unsubAutoSyncStart = null
let unsubAutoSyncResult = null

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
        // 成功后自动关闭对话框（释放遮罩层，恢复侧边栏可点击）
        setTimeout(() => { purchaseDialogVisible.value = false }, 1500)
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
        message: '温馨提示：地址已修改成功，请您继续采购！',
        type: 'success',
        duration: 5000,
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

const filteredOrders = computed(() => {
  return tableData.value.filter((order) => {
    if (searchForm.orderNo && !order.orderNo.includes(searchForm.orderNo)) return false
    if (searchForm.goodsName) {
      const hasGoods = order.items.some(item => item.name.includes(searchForm.goodsName))
      if (!hasGoods) return false
    }
    if (searchForm.outboundNo && !order.outboundNo.includes(searchForm.outboundNo)) return false
    if (searchForm.customerName && !order.customerName.includes(searchForm.customerName)) return false
    if (searchForm.customerPhone && !order.customerPhone.includes(searchForm.customerPhone)) return false
    if (searchForm.orderStatus && order.orderStatus !== searchForm.orderStatus) return false
    if (activeStatus.value && order.orderStatus !== activeStatus.value) return false
    return true
  })
})

const total = computed(() => filteredOrders.value.length)

const pagedOrders = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredOrders.value.slice(start, start + pageSize.value)
})

const statusTabs = computed(() => {
  const all = tableData.value.length
  const counts = {}
  for (const o of tableData.value) {
    if (o.orderStatus) {
      counts[o.orderStatus] = (counts[o.orderStatus] || 0) + 1
    }
  }
  return [
    { label: '全部', value: '', count: all },
    ...orderStatusOptions.map((s) => ({ label: s, value: s, count: counts[s] || 0 }))
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
    customerPhone: '',
    orderStatus: '',
    issueEvent: ''
  })
  activeStatus.value = ''
  currentPage.value = 1
}

function handleStatusClick(status) {
  activeStatus.value = status
  currentPage.value = 1
}

function handleSizeChange() {
  currentPage.value = 1
}

function handleCurrentChange() {}

function onDetailAction(action) {
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

function shopTagColorType(tag) {
  const map = { '京东': 'danger', '天猫': '', '拼多多': 'warning', '抖音': 'success' }
  return map[tag] || ''
}

function statusBorderColor(status) {
  const map = {
    '待付款': '#e6a23c',
    '待发货': '#f56c6c',
    '已发货': '#409eff',
    '已完成': '#52c41a',
    '已取消': '#909399'
  }
  return map[status] || '#dcdfe6'
}

function statusBgColor(status) {
  const map = {
    '待付款': 'linear-gradient(135deg, #fffcf5 0%, #fff8eb 100%)',
    '待发货': 'linear-gradient(135deg, #fff5f5 0%, #fff0f0 100%)',
    '已发货': 'linear-gradient(135deg, #f0f7ff 0%, #e8f4ff 100%)',
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
})

onMounted(async () => {
  await loadStores()
  loadOrdersFromServer()

  // 监听自动同步事件
  if (window.electronAPI) {
    unsubAutoSyncStart = window.electronAPI.onUpdate('auto-sync-start', (data) => {
      autoSyncStatus.value = data.storeName || '店铺'
    })
    unsubAutoSyncResult = window.electronAPI.onUpdate('auto-sync-result', (data) => {
      autoSyncStatus.value = ''
      // 同步成功后自动刷新订单列表
      if (data.success && data.storeId === searchForm.storeId) {
        loadOrdersFromServer()
      }
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
  autoSyncStatus.value = ''
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

.auto-sync-tip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 10px;
  font-size: 13px;
  color: #e6a23c;
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
  padding: 8px 16px;
  font-size: 14px;
  color: #6b7280;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  white-space: nowrap;
}

.stat-item:hover {
  color: #2b5aed;
}

.stat-item.active {
  color: #2b5aed;
  font-weight: 500;
  border-bottom-color: #2b5aed;
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
  padding: 11px 14px;
  font-size: 13px;
  font-weight: 600;
  color: #374151;
  letter-spacing: 0.2px;
}

/* 列宽定义 */
.ot-col-check {
  width: 48px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.ot-col-index {
  width: 50px;
  flex-shrink: 0;
  text-align: center;
}

.ot-col-goods {
  flex: 1;
  min-width: 0;
  padding: 0 8px;
}

.ot-col-price {
  width: 110px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-purchase {
  width: 80px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

.ot-col-warehouse {
  width: 100px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

.ot-col-amount {
  width: 120px;
  flex-shrink: 0;
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
  width: 150px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-aftersale {
  width: 100px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-remark {
  width: 120px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-sysremark {
  width: 120px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
}

.ot-col-action {
  width: 120px;
  flex-shrink: 0;
  text-align: center;
  padding: 0 4px;
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

/* 订单卡片头部 */
.order-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  padding: 12px 16px;
  font-size: 12px;
  border-left: 4px solid #52c41a;
  transition: all 0.2s;
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

.order-header-platform {
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
  gap: 6px;
  flex-shrink: 0;
  margin-left: 12px;
}

/* 订单卡片内容 */
.order-card-body {
  display: flex;
  background: #fff;
}

.order-body-left {
  flex: 1;
  min-width: 0;
}

.product-row {
  display: flex;
  align-items: center;
  padding: 16px 0;
  min-height: 88px;
  transition: background 0.15s;
}

.product-row:hover {
  background: #f9fafb;
}

.product-row-border {
  border-bottom: 1px dashed #e5e7eb;
}

.index-num {
  font-size: 13px;
  color: #6b7280;
  font-weight: 500;
}

/* 商品信息单元格 */
.goods-cell {
  display: flex;
  align-items: center;
  gap: 12px;
}

.goods-img {
  width: 58px;
  height: 58px;
  border-radius: 8px;
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
  border-radius: 8px;
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

.goods-search-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
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

/* 右侧订单级信息 */
.order-body-right {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  border-left: 1px solid #f0f0f0;
  background: linear-gradient(180deg, #fafbfc 0%, #ffffff 100%);
}

.order-body-right .ot-col-amount,
.order-body-right .ot-col-time,
.order-body-right .ot-col-logistics,
.order-body-right .ot-col-aftersale,
.order-body-right .ot-col-remark,
.order-body-right .ot-col-sysremark,
.order-body-right .ot-col-action {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 16px 6px;
  position: relative;
}

.order-body-right .ot-col-amount::after,
.order-body-right .ot-col-time::after,
.order-body-right .ot-col-logistics::after,
.order-body-right .ot-col-aftersale::after,
.order-body-right .ot-col-remark::after,
.order-body-right .ot-col-sysremark::after {
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

.remark-text {
  font-size: 12px;
  color: #4b5563;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
  text-align: center;
}

.remark-edit-btn {
  padding: 2px 0;
  font-size: 13px;
}

.sysremark-text {
  font-size: 12px;
  color: #8c8c8c;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-all;
  text-align: center;
  font-style: italic;
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
</style>
