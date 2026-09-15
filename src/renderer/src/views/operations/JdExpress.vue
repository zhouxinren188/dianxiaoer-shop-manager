<template>
  <div class="jd-express-page">
    <div class="page-header">
      <div>
        <h2>京东快车</h2>
        <p>集中管理京准通快车投放工具</p>
      </div>
      <div class="header-actions">
        <el-select
          v-model="storeId"
          placeholder="请选择京东店铺"
          filterable
          :loading="storeLoading"
          class="store-select"
          @change="handleStoreChange"
        >
          <el-option
            v-for="store in stores"
            :key="store.id"
            :label="store.name"
            :value="store.id"
          />
        </el-select>
        <el-button
          type="danger"
          plain
          :loading="deleteCampaignLoading"
          :disabled="fullCreateLoading || keywordPrepareLoading || fullPrepareLoading"
          @click="confirmDeleteAllCampaigns"
        >
          一键删除计划
        </el-button>
        <el-button type="primary" plain @click="openJzt">打开京准通</el-button>
      </div>
    </div>

    <div class="tool-tabs">
      <button
        v-for="tool in tools"
        :key="tool.key"
        class="tool-tab"
        :class="{ active: activeTool === tool.key }"
        @click="selectTool(tool)"
      >
        <el-icon class="tool-icon">
          <component :is="tool.icon" />
        </el-icon>
        <span>
          <strong>{{ tool.title }}</strong>
          <small>{{ tool.description }}</small>
        </span>
        <el-tag v-if="!tool.available" size="small" type="info">即将开放</el-tag>
      </button>
    </div>

    <div v-show="activeTool === 'roi' || activeTool === 'custom'" class="roi-tool-content">
      <el-card class="status-card" shadow="never">
        <template #header>
          <div class="card-title">
            <span>店铺投放环境</span>
            <div class="status-tags">
              <el-tag v-if="preflight.pin" type="success">已登录：{{ preflight.pin }}</el-tag>
              <el-tag v-else type="info">待检测</el-tag>
            </div>
          </div>
        </template>
        <div class="limit-grid">
          <div v-for="item in limitItems" :key="item.key" class="limit-item">
            <span>{{ item.label }}</span>
            <strong>{{ item.surplus }}</strong>
            <small>已用 {{ item.current }} / 总量 {{ item.total }}</small>
          </div>
        </div>
      </el-card>

      <el-card class="work-card" shadow="never">
        <div class="workflow-nav">
          <div
            v-for="(step, index) in workflowSteps"
            :key="step.title"
            class="workflow-step"
            :class="{ active: activeStep === index, done: activeStep > index }"
          >
            <span class="workflow-index">{{ activeStep > index ? '✓' : index + 1 }}</span>
            <span class="workflow-copy">
              <strong>{{ step.title }}</strong>
              <small>{{ step.description }}</small>
            </span>
          </div>
        </div>

        <div v-show="activeStep === 0" class="step-panel">
          <el-form :inline="true" :model="filters" class="filter-form">
            <el-form-item label="商品">
              <el-input v-model="filters.keyword" placeholder="商品名称" clearable @keyup.enter="searchProducts" />
            </el-form-item>
            <el-form-item label="价格">
              <el-input-number v-model="filters.minPrice" :min="0" :precision="2" controls-position="right" placeholder="最低" />
              <span class="range-separator">—</span>
              <el-input-number v-model="filters.maxPrice" :min="0" :precision="2" controls-position="right" placeholder="最高" />
            </el-form-item>
            <el-form-item label="上架时间">
              <el-date-picker
                v-model="filters.onlineRange"
                type="datetimerange"
                value-format="YYYY-MM-DD HH:mm:ss"
                start-placeholder="开始时间"
                end-placeholder="结束时间"
              />
            </el-form-item>
            <el-form-item label="过滤已有推广">
              <div class="existing-promotion-filter">
                <el-switch v-model="filters.filterExistingPromotion" />
                <el-select
                  v-if="filters.filterExistingPromotion"
                  v-model="filters.existingPromotionFilterMode"
                  class="existing-promotion-mode"
                >
                  <el-option label="按 SKU 过滤" value="sku" />
                  <el-option label="按 SPU 过滤" value="spu" />
                </el-select>
              </div>
            </el-form-item>
            <el-form-item>
              <el-button type="primary" :loading="allProductLoading" @click="searchProducts">查询商品</el-button>
              <el-button @click="resetFilters">重置</el-button>
            </el-form-item>
          </el-form>

          <div class="selection-summary">
            <span>待推广 <strong>{{ selectedProducts.size }}</strong> 个商品</span>
            <span v-if="existingPromotionFilterResult.filteredCount">
              已按 {{ existingPromotionFilterResult.mode === 'spu' ? 'SPU' : 'SKU' }} 过滤
              <strong>{{ existingPromotionFilterResult.filteredCount }}</strong> 个已有推广商品
            </span>
            <span v-if="excludedProducts.size">已删除 {{ excludedProducts.size }} 个</span>
            <span v-if="allProductLoading" class="progress-text">
              {{ progressText }}
            </span>
            <el-button v-if="excludedProducts.size" link type="primary" @click="restoreDeletedProducts">恢复已删除商品</el-button>
          </div>

          <div v-if="readIssues.failedPages.length || readIssues.errorProducts.length" class="read-issues">
            <span>
              本次有 {{ readIssues.failedPages.length }} 个页面、{{ readIssues.errorProducts.length }} 组 SKU 未完整读取。
              已读取的数据不会丢失。
            </span>
            <el-button
              v-if="readIssues.failedPages.length"
              type="warning"
              link
              :loading="retryLoading"
              @click="retryFailedPages"
            >
              重新补查失败页
            </el-button>
          </div>

          <el-table
            ref="productTableRef"
            v-loading="allProductLoading && products.length === 0"
            :data="displayedProducts"
            row-key="skuId"
            border
            :height="productTableHeight"
          >
            <el-table-column label="主图" width="76">
              <template #default="{ row }">
                <el-image v-if="row.image" :src="row.image" fit="cover" class="product-image" />
                <div v-else class="image-placeholder">无图</div>
              </template>
            </el-table-column>
            <el-table-column prop="name" label="商品名称" min-width="300" show-overflow-tooltip>
              <template #default="{ row }">{{ row.name || '商品信息待京东补齐' }}</template>
            </el-table-column>
            <el-table-column prop="skuId" label="SKU" width="150" />
            <el-table-column label="价格" width="100" align="right">
              <template #default="{ row }">{{ formatMoney(row.price) }}</template>
            </el-table-column>
            <el-table-column label="三级类目" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">{{ row.categoryName || row.categoryId || '-' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" align="center" fixed="right">
              <template #default="{ row }">
                <el-button type="danger" link @click="removeProduct(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="pagination-row">
            <el-button
              class="pagination-next"
              type="primary"
              :disabled="!selectedProducts.size || allProductLoading || retryLoading"
              :loading="allProductLoading || retryLoading"
              @click="goNext"
            >
              下一步
            </el-button>
            <el-pagination
              v-model:current-page="filters.pageNo"
              v-model:page-size="filters.pageSize"
              :total="productTotal"
              :page-sizes="[100, 200, 300, 500]"
              layout="total, sizes, prev, pager, next, jumper"
              @size-change="handlePageSizeChange"
            />
          </div>
        </div>

        <div v-show="activeStep === 1" class="step-panel config-panel">
          <el-form ref="configFormRef" :model="config" :rules="configRules" label-position="top">
            <div class="config-workspace">
              <div class="config-main-column">
                <section class="config-section">
                  <div class="section-heading">
                    <span class="section-number">01</span>
                    <div>
                      <h3>计划基础</h3>
                      <p>设置计划名称、投放周期与预算</p>
                    </div>
                  </div>

                  <div class="fixed-setting-row">
                    <div><span>创建方式</span><strong>创建新计划</strong></div>
                    <div><span>单元拆分</span><strong>按三级类目</strong></div>
                    <el-tag type="info" effect="plain">固定规则</el-tag>
                  </div>

                  <div class="form-grid form-grid-4">
                    <el-form-item label="名称前缀" prop="namePrefix">
                      <el-input v-model="config.namePrefix" maxlength="20" show-word-limit />
                    </el-form-item>
                    <el-form-item label="起始时间" prop="startDate">
                      <el-date-picker v-model="config.startDate" type="date" value-format="YYYY-MM-DD" />
                    </el-form-item>
                    <el-form-item label="截止时间" prop="endDate">
                      <el-radio-group v-model="config.unlimitedEndDate">
                        <el-radio :value="true">不限</el-radio>
                        <el-radio :value="false">自定义</el-radio>
                      </el-radio-group>
                      <el-date-picker
                        v-if="!config.unlimitedEndDate"
                        v-model="config.endDate"
                        type="date"
                        value-format="YYYY-MM-DD"
                        class="block-control"
                      />
                    </el-form-item>
                    <el-form-item label="每日预算" prop="dailyBudget">
                      <el-radio-group v-model="config.unlimitedBudget">
                        <el-radio :value="true">不限</el-radio>
                        <el-radio :value="false">自定义</el-radio>
                      </el-radio-group>
                      <el-input-number
                        v-if="!config.unlimitedBudget"
                        v-model="config.dailyBudget"
                        :min="50"
                        :max="999999"
                        :precision="0"
                        class="block-control compact-number-control"
                      />
                    </el-form-item>
                  </div>
                  <div class="form-grid planning-rule-grid">
                    <el-form-item label="计划分配模式" prop="planGroupMode">
                      <el-radio-group v-model="config.planGroupMode">
                        <el-radio value="quantity">按数量</el-radio>
                        <el-radio value="category">按二级类目分配</el-radio>
                      </el-radio-group>
                    </el-form-item>
                    <el-form-item label="每计划单元数" prop="unitsPerCampaign" class="compact-number-item">
                      <el-input-number v-model="config.unitsPerCampaign" :min="1" :max="100" :precision="0" class="compact-number-control" />
                    </el-form-item>
                  </div>
                </section>

                <section class="config-section">
                  <div class="section-heading">
                    <span class="section-number">02</span>
                    <div>
                      <h3>推广单元</h3>
                      <p>控制单元数量与关键词用量</p>
                    </div>
                  </div>

                  <div class="form-grid compact-number-grid">
                  <el-form-item label="关键词总用量" prop="keywordTotalUsage" class="compact-number-item">
                    <el-input-number
                      v-model="config.keywordTotalUsage"
                      :min="1"
                      :max="keywordUsageMax"
                      :precision="0"
                      class="compact-number-control"
                    />
                    <div class="field-help">不可超过当前剩余关键词额度</div>
                  </el-form-item>
                  <el-form-item label="每单元创意数" prop="skuPerUnit" class="compact-number-item">
                    <el-input-number v-model="config.skuPerUnit" :min="1" :max="100" :precision="0" class="compact-number-control" />
                    <div class="field-help">同一三级类目内按该数量拆分单元</div>
                  </el-form-item>
                  </div>

                  <div class="allocation-result">
                    预计生成 <strong>{{ preview.unitCount }}</strong> 个推广单元，每单元最多
                    <strong>{{ preview.keywordPerUnit }}</strong> 个关键词，共使用
                    <strong>{{ preview.keywordCount }}</strong> 个关键词
                  </div>
                </section>

                <section class="config-section">
                  <div class="section-heading">
                    <span class="section-number">03</span>
                    <div>
                      <h3>关键词策略</h3>
                      <p>选择关键词来源并设置出价</p>
                    </div>
                  </div>

                  <div class="keyword-strategy-grid">
                    <div class="strategy-box">
                      <div class="strategy-box-title">关键词出价</div>
                      <div v-if="activeTool === 'custom'" class="keyword-bid-mode-row">
                        <el-radio-group v-model="config.useMinKeywordBid">
                          <el-radio :value="true">查询到的最低出价＋加价</el-radio>
                          <el-radio :value="false">自定义出价</el-radio>
                        </el-radio-group>
                      </div>
                      <template v-if="activeTool !== 'custom' || config.useMinKeywordBid">
                        <div class="bid-base-row">
                          <span>出价基准</span>
                          <strong>查询到的最低出价</strong>
                        </div>
                        <div class="bid-increment-row">
                          <span>额外增加</span>
                          <el-input-number
                            v-model="config.keywordBidIncrement"
                            :min="0"
                            :max="100"
                            :step="0.1"
                            :precision="1"
                          />
                          <span>元</span>
                        </div>
                      </template>
                      <el-form-item v-else label="固定出价" prop="customKeywordBid" class="fixed-keyword-bid-item">
                        <el-input-number
                          v-model="config.customKeywordBid"
                          :min="0.1"
                          :max="9999"
                          :step="0.1"
                          :precision="1"
                        />
                        <span>元</span>
                        <div class="field-help">每个关键词统一使用该出价，不查询京东最低出价</div>
                      </el-form-item>
                      <el-form-item label="关键词匹配方式" prop="keywordMatchType" class="keyword-match-type-item">
                        <el-radio-group v-model="config.keywordMatchType">
                          <el-radio :value="1">精确匹配</el-radio>
                          <el-radio :value="4">短语匹配</el-radio>
                          <el-radio :value="8">切词匹配</el-radio>
                        </el-radio-group>
                      </el-form-item>
                    </div>

                    <div class="strategy-box keyword-source-box">
                      <div class="strategy-box-title required-title">关键词来源</div>
                      <el-form-item prop="keywordSources" class="keyword-source-form-item">
                        <div class="keyword-source-row">
                          <el-checkbox
                            class="keyword-select-all"
                            :model-value="allKeywordSourcesSelected"
                            :indeterminate="someKeywordSourcesSelected"
                            @change="toggleAllKeywordSources"
                          >全选</el-checkbox>
                          <el-checkbox-group
                            v-model="config.keywordSources"
                            class="keyword-source-group"
                            @change="handleKeywordSourcesChange"
                          >
                            <el-checkbox
                              v-for="option in keywordSourceOptions"
                              :key="option.value"
                              :value="option.value"
                              :disabled="option.value === 4 && !config.keywordSources.includes(3)"
                            >{{ option.label }}</el-checkbox>
                          </el-checkbox-group>
                        </div>
                      </el-form-item>
                      <div class="field-help">下拉词依赖标题分词；商智词需要店铺已开通京东商智</div>
                    </div>
                  </div>

                  <el-form-item v-if="config.keywordSources.includes(1)" label="商智关键词排序" prop="keywordSortType" class="compact-control">
                    <el-select v-model="config.keywordSortType">
                      <el-option
                        v-for="option in keywordSortOptions"
                        :key="option.value"
                        :label="option.label"
                        :value="option.value"
                      />
                    </el-select>
                  </el-form-item>

                  <div class="subsection-heading">
                    <span>关键词比例</span>
                    <em :class="{ invalid: keywordPercentageTotal > 100 }">合计 {{ keywordPercentageTotal }}%</em>
                  </div>
                  <div class="ratio-grid">
                    <el-form-item
                      v-for="option in selectedKeywordOptions"
                      :key="option.value"
                      :label="`${option.label}（建议 ${option.recommended}%）`"
                      :prop="option.ratioKey"
                      class="compact-number-with-unit-item"
                    >
                      <el-input-number
                        v-model="config[option.ratioKey]"
                        :min="1"
                        :max="100"
                        :precision="0"
                        @change="validateKeywordRatios"
                      />
                      <span class="unit-suffix">%</span>
                    </el-form-item>
                  </div>
                  <el-form-item label="不足时自动补充关键词" class="compact-control">
                    <div class="switch-row">
                      <el-switch v-model="config.supplementKeywords" />
                      <span>{{ config.supplementKeywords ? '已开启' : '已关闭' }}</span>
                    </div>
                    <div class="field-help">按“商智 → 商品推词 → 标题分词 → 下拉词”依次补充至单元上限</div>
                  </el-form-item>
                </section>

                <section class="config-section">
                  <div class="section-heading">
                    <span class="section-number">04</span>
                    <div>
                      <h3>投放目标与出价</h3>
                      <p>{{ activeTool === 'custom' ? '设置关键词、智能匹配与人群出价策略' : '以成交和投产比为目标控制出价' }}</p>
                    </div>
                  </div>

                  <template v-if="activeTool === 'roi'">
                  <div class="fixed-setting-row fixed-setting-row-3">
                    <div><span>投放目标</span><strong>成交</strong></div>
                    <div><span>控制方式</span><strong>投产比控制</strong></div>
                    <div><span>生效范围</span><strong>关键词定向</strong></div>
                  </div>

                  <el-form-item prop="bidType">
                    <template #label>
                      <span class="field-label-with-help">
                        目标投产比
                        <el-tooltip
                          content="若选择自定义出价，所填数值低于系统最低出价，将默认使用系统最低出价"
                          placement="top-start"
                          popper-class="jd-express-help-popper"
                        >
                          <el-icon class="help-icon"><QuestionFilled /></el-icon>
                        </el-tooltip>
                      </span>
                    </template>
                    <el-radio-group v-model="config.bidType" class="roi-radio-grid">
                      <el-radio :value="1">建议出价 70% 竞争力</el-radio>
                      <el-radio :value="2">建议出价 50% 竞争力</el-radio>
                      <el-radio :value="3">建议出价 30% 竞争力</el-radio>
                      <el-radio :value="4">自定义 ROI</el-radio>
                    </el-radio-group>
                  </el-form-item>
                  <template v-if="config.bidType !== 4">
                    <div class="form-grid form-grid-3">
                      <el-form-item class="compact-number-with-unit-item">
                        <template #label>
                          <span class="field-label-with-help">
                            调价方向
                            <el-tooltip
                              content="在选择的《建议出价》的基础上调整出价，选择上调则增加出价，选择下调则减少出价"
                              placement="top-start"
                              popper-class="jd-express-help-popper"
                            >
                              <el-icon class="help-icon"><QuestionFilled /></el-icon>
                            </el-tooltip>
                          </span>
                        </template>
                        <el-radio-group v-model="config.adjustDirection">
                          <el-radio :value="0">不调整</el-radio>
                          <el-radio :value="1">上调</el-radio>
                          <el-radio :value="-1">下调</el-radio>
                        </el-radio-group>
                      </el-form-item>
                      <el-form-item>
                        <template #label>
                          <span class="field-label-with-help">
                            调价比例
                            <el-tooltip
                              content="在选择《建议出价》时，根据调价方向、调价比例(百分比)，调整对应的《建议出价》数值。如：建议出价为1，调价方向为上调，调价比例为10%，则最终出价为1.1；建议出价为1，调价方向为下调，调价比例为10%，则最终出价为0.9。不可超出有效范围，否则将采用有效范围边界值。"
                              placement="top-start"
                              popper-class="jd-express-help-popper"
                            >
                              <el-icon class="help-icon"><QuestionFilled /></el-icon>
                            </el-tooltip>
                          </span>
                        </template>
                        <el-input-number
                          v-model="config.adjustRatio"
                          :min="0"
                          :max="100"
                          :precision="0"
                          :disabled="config.adjustDirection === 0"
                        />
                        <span class="unit-suffix">%</span>
                      </el-form-item>
                      <el-form-item prop="bottomLimit" class="compact-number-item">
                        <template #label>
                          <span class="field-label-with-help">
                            保底 ROI
                            <el-tooltip
                              content="选择《建议出价》时，可设置保底出价，当《建议出价》的ROI数值或调价之后的数值低于保底出价数值时，将设置出价为保底出价,并且保底出价不得高于有效范围最大值,否则将设置出价为有效范围最大值"
                              placement="top-start"
                              popper-class="jd-express-help-popper"
                            >
                              <el-icon class="help-icon"><QuestionFilled /></el-icon>
                            </el-tooltip>
                          </span>
                        </template>
                        <el-input-number v-model="config.bottomLimit" :min="0.1" :max="1000" :step="0.1" :precision="1" class="compact-number-control" />
                      </el-form-item>
                    </div>
                  </template>
                  <template v-else>
                    <div class="form-grid form-grid-2 compact-fields">
                      <el-form-item label="自定义数值" prop="customRoi" class="compact-number-item">
                        <el-input-number v-model="config.customRoi" :min="0.1" :max="1000" :step="0.1" :precision="1" class="compact-number-control" />
                      </el-form-item>
                      <el-form-item>
                        <template #label>
                          <span class="field-label-with-help">
                            上限出价
                            <el-tooltip
                              content="自定义出价ROI数值“超过”《建议出价30%竞争力》的ROI数值时，将以《建议出价30%竞争力》的ROI数值作为出价"
                              placement="top-start"
                              popper-class="jd-express-help-popper"
                            >
                              <el-icon class="help-icon"><QuestionFilled /></el-icon>
                            </el-tooltip>
                          </span>
                        </template>
                        <el-checkbox v-model="config.capCustomRoi">以建议出价 30% 竞争力作为最大 ROI</el-checkbox>
                      </el-form-item>
                    </div>
                  </template>
                  </template>

                  <template v-else>
                    <div class="fixed-setting-row fixed-setting-row-3">
                      <div><span>投放目标</span><strong>自定义</strong></div>
                      <div><span>投放定向</span><strong>{{ customOrientationLabel }}</strong></div>
                      <div><span>已选人群</span><strong>{{ selectedCrowdSummary }}</strong></div>
                    </div>

                    <div class="form-grid custom-control-grid">
                      <el-form-item label="全能调价" prop="automatedBiddingType" class="custom-control-switch">
                        <div class="switch-row">
                          <el-switch
                            v-model="config.automatedBiddingType"
                            :active-value="32768"
                            :inactive-value="0"
                          />
                          <span>{{ config.automatedBiddingType === 32768 ? '已开启' : '已关闭' }}</span>
                        </div>
                        <div class="field-help">对应原工具“全能调价”，关闭时按关键词出价投放</div>
                      </el-form-item>

                      <el-form-item
                        v-if="config.automatedBiddingType === 32768"
                        label="生效范围"
                        prop="orientationRangeOption"
                        class="custom-control-range"
                      >
                        <el-checkbox-group v-model="config.orientationRangeOption">
                          <el-checkbox :value="1" disabled>关键词定向</el-checkbox>
                          <el-checkbox :value="2">商品定向</el-checkbox>
                        </el-checkbox-group>
                        <div class="field-help">关键词定向固定生效；勾选后同时启用商品定向</div>
                      </el-form-item>

                      <el-form-item label="智能匹配出价" prop="inSearchFee" class="custom-control-search-fee compact-number-with-unit-item">
                        <el-input-number
                          v-model="config.inSearchFee"
                          :min="0.1"
                          :max="9999"
                          :step="0.1"
                          :precision="1"
                        />
                        <span class="unit-suffix">元</span>
                      </el-form-item>

                      <el-form-item
                        v-if="config.automatedBiddingType === 32768"
                        label="溢价比例"
                        prop="premiumCoef"
                        class="custom-control-premium compact-number-with-unit-item"
                      >
                        <el-input-number
                          v-model="config.premiumCoef"
                          :min="30"
                          :max="300"
                          :precision="0"
                        />
                        <span class="unit-suffix">%</span>
                        <div class="field-help">原工具默认 30%，即最高按基础出价的 130% 调整</div>
                      </el-form-item>
                    </div>

                    <el-form-item label="人群定向" prop="dmpCrowdSettings" class="crowd-form-item">
                      <div class="crowd-setting-panel" v-loading="crowdLoading">
                        <div class="crowd-setting-header">
                          <div>
                            <strong>搜索人群</strong>
                            <small>与浩辰一致：默认不勾选，勾选后设置 10%～300% 溢价</small>
                          </div>
                          <div class="crowd-header-actions">
                            <el-button size="small" :loading="crowdLoading" @click="loadCrowds(false)">刷新人群</el-button>
                            <el-button
                              size="small"
                              plain
                              :disabled="!crowdDisplayOptions.length"
                              @click="openCrowdDialog"
                            >
                              选择人群（{{ config.dmpCrowdSettings.length }}/30）
                            </el-button>
                          </div>
                        </div>

                        <el-alert
                          v-if="crowdError"
                          :title="crowdError"
                          type="warning"
                          :closable="false"
                          show-icon
                        />

                        <div v-if="defaultCrowdOptions.length" class="default-crowd-list">
                          <div v-for="crowd in defaultCrowdOptions" :key="crowdKey(crowd)" class="crowd-option-row">
                            <el-checkbox
                              :model-value="isCrowdSelected(crowd)"
                              @change="toggleCrowd(crowd, $event)"
                            >
                              {{ crowd.crowdName }}
                            </el-checkbox>
                            <span class="crowd-reach">覆盖 {{ formatCrowdReach(crowd) }}</span>
                            <el-input-number
                              :model-value="getCrowdPremium(crowd)"
                              :disabled="!isCrowdSelected(crowd)"
                              :min="10"
                              :max="300"
                              :step="10"
                              :precision="0"
                              size="small"
                              @update:model-value="updateCrowdPremium(crowd, $event)"
                            />
                            <span class="crowd-percent">%</span>
                          </div>
                        </div>
                        <div v-else-if="!crowdLoading && !crowdError" class="crowd-empty-hint">
                          京东未返回默认购买/浏览人群，可使用右上角“选择人群”添加其他已加载人群
                        </div>

                        <div v-if="crowdPartial" class="crowd-setting-actions">
                          <span>部分人群加载失败，可刷新后重试</span>
                        </div>
                      </div>
                    </el-form-item>
                  </template>
                </section>

                <section class="config-section">
                  <div class="section-heading">
                    <span class="section-number">05</span>
                    <div>
                      <h3>投放地域</h3>
                      <p>默认不限，也可指定投放区域</p>
                    </div>
                  </div>
                  <el-form-item label="地域设置" prop="areaType" class="compact-control">
                    <el-radio-group v-model="config.areaType" @change="handleAreaTypeChange">
                      <el-radio :value="1">不限</el-radio>
                      <el-radio :value="2">特定区域</el-radio>
                    </el-radio-group>
                  </el-form-item>
                  <el-form-item v-if="config.areaType === 2" label="选择投放区域" prop="areaIds">
                    <div v-loading="areaLoading" class="area-selector">
                      <el-checkbox v-model="allAreasSelected" @change="toggleAllAreas">全选/全不选</el-checkbox>
                      <el-tree
                        ref="areaTreeRef"
                        :data="areaTree"
                        node-key="id"
                        :props="{ label: 'name', children: 'children' }"
                        show-checkbox
                        default-expand-all
                        @check="handleAreaCheck"
                      />
                    </div>
                  </el-form-item>
                </section>
              </div>

              <aside class="config-summary-card">
                <div class="summary-title">
                  <div>
                    <h3>本次投放摘要</h3>
                    <p>配置结果会随修改实时更新</p>
                  </div>
                  <el-tag type="success" effect="plain">实时</el-tag>
                </div>
                <div class="summary-metrics">
                  <div><span>商品</span><strong>{{ preview.productCount }}</strong></div>
                  <div><span>计划</span><strong>{{ preview.campaignCount }}</strong></div>
                  <div><span>单元</span><strong>{{ preview.unitCount }}</strong></div>
                  <div><span>关键词</span><strong>{{ preview.keywordCount }}</strong></div>
                </div>
                <div class="summary-list">
                  <div><span>计划前缀</span><strong>{{ config.namePrefix || '未设置' }}</strong></div>
                  <div><span>每日预算</span><strong>{{ config.unlimitedBudget ? '不限' : `¥${config.dailyBudget}` }}</strong></div>
                  <div><span>{{ activeTool === 'custom' ? '出价控制' : '投产模式' }}</span><strong>{{ deliveryModeLabel }}</strong></div>
                  <div><span>关键词来源</span><strong>{{ keywordSourceSummary }}</strong></div>
                  <div><span>匹配方式</span><strong>{{ keywordMatchTypeLabel }}</strong></div>
                  <div v-if="activeTool === 'custom'"><span>搜索人群</span><strong>{{ selectedCrowdSummary }}</strong></div>
                  <div><span>投放地域</span><strong>{{ areaSummary }}</strong></div>
                </div>
                <el-alert
                  title="创建规则"
                  description="系统会先按三级类目拆分推广单元，再按计划分配模式自动生成计划。"
                  type="info"
                  :closable="false"
                  show-icon
                />
              </aside>
            </div>
          </el-form>
        </div>

        <div v-show="activeStep === 2" class="step-panel">
          <div class="preview-metrics">
            <div><span>商品</span><strong>{{ preview.productCount }}</strong></div>
            <div><span>计划</span><strong>{{ preview.campaignCount }}</strong></div>
            <div><span>推广单元</span><strong>{{ preview.unitCount }}</strong></div>
            <div><span>创意</span><strong>{{ preview.creativeCount }}</strong></div>
            <div><span>每单元关键词</span><strong>{{ preview.keywordPerUnit }}</strong></div>
            <div><span>预计关键词</span><strong>{{ preview.keywordCount }}</strong></div>
          </div>

          <el-descriptions :column="3" border class="preview-config-summary">
            <el-descriptions-item label="关键词来源">{{ keywordSourceSummary }}</el-descriptions-item>
            <el-descriptions-item v-if="activeTool === 'custom'" label="搜索人群">{{ selectedCrowdSummary }}</el-descriptions-item>
            <el-descriptions-item label="匹配方式">{{ keywordMatchTypeLabel }}</el-descriptions-item>
            <el-descriptions-item label="地域">{{ areaSummary }}</el-descriptions-item>
            <el-descriptions-item label="计划分配">{{ config.planGroupMode === 'category' ? '按二级类目' : '按数量' }}</el-descriptions-item>
          </el-descriptions>

          <el-alert
            v-if="preview.limitWarnings.length"
            :title="preview.limitWarnings.join('；')"
            type="error"
            show-icon
            :closable="false"
            class="limit-warning"
          />

          <el-table :data="preview.campaigns" border :max-height="previewTableHeight">
            <el-table-column prop="name" label="计划预览" min-width="260" />
            <el-table-column prop="categoryName" label="分组" min-width="180" />
            <el-table-column prop="unitCount" label="单元数" width="100" align="right" />
            <el-table-column prop="productCount" label="商品数" width="100" align="right" />
            <el-table-column :label="activeTool === 'custom' ? '出价控制' : '目标投产比'" width="150" align="right">
              <template #default>{{ deliveryModeLabel }}</template>
            </el-table-column>
            <el-table-column label="每日预算" width="120" align="right">
              <template #default>{{ config.unlimitedBudget ? '不限' : `¥${config.dailyBudget}` }}</template>
            </el-table-column>
          </el-table>

          <div class="submit-placeholder">
            <el-button
              type="primary"
              :disabled="fullCreateLoading || preview.limitWarnings.length > 0"
              @click="createAllPlans"
            >确认创建全部计划</el-button>
            <el-tag v-if="createdFullResult" :type="createdFullResult.failureCount ? 'warning' : 'success'">
              已创建 {{ createdFullResult.successCampaignCount }}/{{ createdFullResult.campaignCount }} 个计划，
              {{ createdFullResult.successUnitCount }}/{{ createdFullResult.unitCount }} 个单元
            </el-tag>
            <el-tag v-if="creationVerification.status === 'checking'" type="info" effect="plain">
              正在后台核验
            </el-tag>
            <el-tag v-else-if="creationVerification.status === 'matched'" type="success" effect="plain">
              四层核验通过
            </el-tag>
            <el-tag v-else-if="creationVerification.status === 'mismatch'" type="warning" effect="plain">
              核验发现缺少
            </el-tag>
            <el-tag v-else-if="creationVerification.status === 'unavailable'" type="info" effect="plain">
              核验暂未完成
            </el-tag>
          </div>
        </div>

        <div v-if="activeStep > 0" class="step-actions">
          <el-button @click="activeStep--">上一步</el-button>
          <el-button v-if="activeStep < 2" type="primary" @click="goNext">
            {{ activeStep === 1 ? '生成预览' : '下一步' }}
          </el-button>
        </div>
      </el-card>
    </div>

    <el-empty v-show="activeTool !== 'roi' && activeTool !== 'custom'" description="该功能将在后续版本接入">
      <template #image>
        <div class="coming-icon">建设中</div>
      </template>
    </el-empty>

    <div v-if="fullCreateLoading" class="creation-progress-mask" role="dialog" aria-live="polite">
      <div class="creation-progress-card">
        <span class="creation-progress-spinner" />
        <strong>{{ creationProgressTitle }}</strong>
        <p>{{ creationProgressDetail }}</p>
        <el-progress
          :percentage="creationProgressPercent"
          :stroke-width="8"
          :show-text="false"
          class="creation-progress-bar"
        />
        <div class="creation-progress-meta">
          <span>{{ creationProgressPercent }}%</span>
          <span>{{ creationEtaText }}</span>
        </div>
        <small>正在后台处理；可使用左侧其他功能，请勿关闭应用或切换当前店铺</small>
      </div>
    </div>

    <el-dialog
      v-model="crowdDialogVisible"
      title="选择搜索人群"
      width="820px"
      align-center
      append-to-body
    >
      <div class="crowd-dialog-toolbar">
        <el-input v-model="crowdKeyword" clearable placeholder="搜索人群名称" />
        <el-select v-model="crowdCategory" clearable placeholder="全部分类">
          <el-option v-for="category in crowdCategoryOptions" :key="category" :label="category" :value="category" />
        </el-select>
        <el-button :loading="crowdLoading" @click="loadCrowds(false)">重新加载</el-button>
      </div>
      <el-table :data="filteredCrowdOptions" height="460" empty-text="没有符合条件的人群">
        <el-table-column label="选择" width="66" align="center">
          <template #default="{ row }">
            <el-checkbox :model-value="isCrowdSelected(row)" @change="toggleCrowd(row, $event)" />
          </template>
        </el-table-column>
        <el-table-column prop="crowdName" label="人群名称" min-width="210" show-overflow-tooltip />
        <el-table-column label="来源" width="100">
          <template #default="{ row }">
            <el-tag size="small" :type="row.source === 'recommended' ? 'success' : 'info'">
              {{ row.source === 'recommended' ? '推荐人群' : 'DMP人群' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="分类" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">{{ crowdCategoryLabel(row) }}</template>
        </el-table-column>
        <el-table-column label="覆盖人数" width="110" align="right">
          <template #default="{ row }">{{ formatCrowdReach(row) }}</template>
        </el-table-column>
        <el-table-column label="溢价" width="160" align="right">
          <template #default="{ row }">
            <el-input-number
              :model-value="getCrowdPremium(row)"
              :disabled="!isCrowdSelected(row)"
              :min="10"
              :max="300"
              :step="10"
              :precision="0"
              size="small"
              @update:model-value="updateCrowdPremium(row, $event)"
            />
          </template>
        </el-table-column>
      </el-table>
      <template #footer>
        <span class="crowd-dialog-count">已选 {{ config.dmpCrowdSettings.length }}/30 个人群</span>
        <el-button type="primary" @click="crowdDialogVisible = false">确定</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="rateLimit.visible"
      title="京东接口限流保护"
      width="420px"
      align-center
      append-to-body
      :show-close="false"
      :close-on-click-modal="false"
      :close-on-press-escape="false"
    >
      <div class="rate-limit-content">
        <strong>{{ rateLimit.reason || '读取速度受到京东限制' }}</strong>
        <span>还需等待 {{ rateLimit.secondsRemaining }} 秒</span>
        <small>等待结束后只自动重试一次，请勿关闭店小二。</small>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Aim, EditPen, MagicStick, QuestionFilled, TrendCharts } from '@element-plus/icons-vue'
import { fetchStores } from '@/api/store'

const JZT_URL = 'https://jzt.jd.com/msa/#/list/shopSmart?objective=item&scenario=normal&targetingType=shopSmart'
const CONFIG_SCHEMA_VERSION = 6
const keywordSourceOptions = [
  { value: 1, label: '商智关键词', ratioKey: 'businessWisdomPercent', recommended: 20 },
  { value: 2, label: '商品推词', ratioKey: 'productPercent', recommended: 50 },
  { value: 3, label: '标题分词', ratioKey: 'titlePercent', recommended: 20 },
  { value: 4, label: '下拉关键词', ratioKey: 'pullDownPercent', recommended: 10 }
]
const keywordSortOptions = [
  { value: 1, label: '搜索人气' },
  { value: 2, label: '点击人气' },
  { value: 3, label: '点击率' },
  { value: 4, label: '成交金额指数' },
  { value: 5, label: '成交单量指数' },
  { value: 6, label: '成交转化率' },
  { value: 7, label: '蓝海值' }
]
const keywordMatchTypeOptions = [
  { value: 1, label: '精确匹配' },
  { value: 4, label: '短语匹配' },
  { value: 8, label: '切词匹配' }
]

const tools = [
  { key: 'roi', icon: TrendCharts, title: '一键投产比', description: '批量创建目标投产计划', available: true },
  { key: 'custom', icon: EditPen, title: '一键自定义', description: '批量创建自定义计划', available: true },
  { key: 'precision', icon: Aim, title: '精细化快车', description: '细分商品与关键词', available: false },
  { key: 'optimize', icon: MagicStick, title: '快车优化', description: '诊断并优化现有计划', available: false }
]
const workflowSteps = computed(() => [
  { title: '选择商品', description: '读取在售商品' },
  { title: '投放配置', description: activeTool.value === 'custom' ? '设置计划与自定义出价' : '设置计划与投产比' },
  { title: '创建预览', description: '核对数量与额度' }
])

const activeTool = ref('roi')
const activeStep = ref(0)
const stores = ref([])
const storeId = ref(null)
const storeLoading = ref(false)
const preflightLoading = ref(false)
const deleteCampaignLoading = ref(false)
const signingLoading = ref(false)
const signingReady = ref(false)
const keywordPrepareLoading = ref(false)
const preparedKeywordResult = ref(null)
const singleCreateLoading = ref(false)
const createdSingleResult = ref(null)
const fullPrepareLoading = ref(false)
const preparedFullResult = ref(null)
const fullCreateLoading = ref(false)
const createdFullResult = ref(null)
const creationVerification = reactive({ status: 'idle', expected: null, actual: null, missing: null, message: '' })
const keywordPrepareProgress = reactive({ phase: '', unitIndex: 0, totalUnits: 0, secondsRemaining: 0 })
const resumePreparationToken = ref('')
const creationStartedAt = ref(0)
const creationSubmissionStarted = ref(false)
const allProductLoading = ref(false)
const retryLoading = ref(false)
const configFormRef = ref(null)
const productTableRef = ref(null)
const productTableHeight = ref(560)
const previewTableHeight = ref(460)
const areaTreeRef = ref(null)
const areaTree = ref([])
const areaLoading = ref(false)
const allAreasSelected = ref(false)
const crowdOptions = ref([])
const crowdLoading = ref(false)
const crowdError = ref('')
const crowdPartial = ref(false)
const crowdDialogVisible = ref(false)
const crowdKeyword = ref('')
const crowdCategory = ref('')
const crowdLoadedStoreId = ref('')
let crowdRequestSeq = 0
const products = ref([])
const productTotal = ref(0)
const selectedProducts = reactive(new Map())
const excludedProducts = reactive(new Map())
const allProgress = reactive({ phase: '', page: 0, totalPages: 0, loaded: 0, waitSeconds: 0 })
const rateLimit = reactive({ visible: false, reason: '', secondsRemaining: 0 })
const readIssues = reactive({ failedPages: [], errorProducts: [] })
const existingPromotionFilterResult = reactive({ enabled: false, mode: 'sku', filteredCount: 0, filteredSkuIds: [] })
let removeProgressListener = null
let removeCreationProgressListener = null
let removeVerificationListener = null

const preflight = reactive({
  pin: '',
  limitsAvailable: false,
  limits: {
    campaign: { total: 0, current: 0, surplus: 0 },
    adgroup: { total: 0, current: 0, surplus: 0 },
    ad: { total: 0, current: 0, surplus: 0 },
    keyword: { total: 0, current: 0, surplus: 0 }
  }
})

const filters = reactive({
  keyword: '',
  minPrice: null,
  maxPrice: null,
  onlineRange: [],
  filterExistingPromotion: true,
  existingPromotionFilterMode: 'sku',
  pageNo: 1,
  pageSize: 100
})

const config = reactive(createDefaultConfig('roi'))

const configRules = {
  namePrefix: [{ required: true, message: '请输入计划名称前缀', trigger: 'blur' }],
  bidType: [{ required: true, message: '请选择目标投产比', trigger: 'change' }],
  automatedBiddingType: [{ required: true, message: '请选择是否开启全能调价', trigger: 'change' }],
  keywordMatchType: [{ required: true, message: '请选择关键词匹配方式', trigger: 'change' }],
  premiumCoef: [{
    validator: (_rule, value, callback) => {
      if (activeTool.value === 'custom' && config.automatedBiddingType === 32768 &&
        (!Number.isFinite(value) || value < 30 || value > 300)) callback(new Error('最高溢价比例须为 30%～300%'))
      else callback()
    },
    trigger: 'change'
  }],
  inSearchFee: [{
    validator: (_rule, value, callback) => {
      if (activeTool.value === 'custom' && (!Number.isFinite(value) || value < 0.1 || value > 9999)) {
        callback(new Error('智能匹配出价须为 0.1～9999 元'))
      } else callback()
    },
    trigger: 'change'
  }],
  customKeywordBid: [{
    validator: (_rule, value, callback) => {
      if (activeTool.value === 'custom' && config.useMinKeywordBid === false &&
        (!Number.isFinite(value) || value < 0.1 || value > 9999)) {
        callback(new Error('关键词固定出价须为 0.1～9999 元'))
      } else callback()
    },
    trigger: 'change'
  }],
  orientationRangeOption: [{
    validator: (_rule, value, callback) => {
      if (activeTool.value === 'custom' && (!Array.isArray(value) || !value.map(Number).includes(1))) {
        callback(new Error('关键词定向为必选项'))
      } else callback()
    },
    trigger: 'change'
  }],
  dmpCrowdSettings: [{
    validator: (_rule, value, callback) => {
      const items = Array.isArray(value) ? value : []
      if (items.length > 30) {
        callback(new Error('一个推广单元最多选择 30 个人群'))
        return
      }
      if (items.some((item) => !Number.isFinite(Number(item?.adGroupPrice)) || Number(item.adGroupPrice) < 10 || Number(item.adGroupPrice) > 300)) {
        callback(new Error('人群溢价须为 10%～300%'))
        return
      }
      callback()
    },
    trigger: 'change'
  }],
  bottomLimit: [{ required: true, message: '请设置保底 ROI', trigger: 'change' }],
  customRoi: [{ required: true, message: '请设置自定义 ROI', trigger: 'change' }],
  dailyBudget: [{
    validator: (_rule, value, callback) => {
      if (!config.unlimitedBudget && (!Number.isFinite(value) || value <= 0)) callback(new Error('请设置每日预算'))
      else callback()
    },
    trigger: 'change'
  }],
  keywordTotalUsage: [{
    validator: (_rule, value, callback) => {
      if (!Number.isFinite(value) || value < 1) {
        callback(new Error('关键词总用量必须大于 0'))
        return
      }
      const surplus = Number(preflight.limits.keyword.surplus || 0)
      if (preflight.limitsAvailable && value > surplus) {
        callback(new Error(`不可超过剩余关键词额度 ${surplus}`))
        return
      }
      callback()
    },
    trigger: 'change'
  }],
  keywordSources: [{
    type: 'array',
    required: true,
    min: 1,
    message: '请至少选择一种关键词类型',
    trigger: 'change'
  }],
  businessWisdomPercent: createKeywordRatioRule(1, '商智关键词'),
  productPercent: createKeywordRatioRule(2, '商品推词'),
  titlePercent: createKeywordRatioRule(3, '标题分词'),
  pullDownPercent: createKeywordRatioRule(4, '下拉关键词'),
  areaIds: [{
    validator: (_rule, value, callback) => {
      if (config.areaType === 2 && (!Array.isArray(value) || value.length === 0)) callback(new Error('请选择投放区域'))
      else callback()
    },
    trigger: 'change'
  }],
  startDate: [{ required: true, message: '请选择开始日期', trigger: 'change' }],
  endDate: [{
    validator: (_rule, value, callback) => {
      if (!config.unlimitedEndDate && !value) callback(new Error('请选择结束日期'))
      else if (!config.unlimitedEndDate && value < config.startDate) callback(new Error('结束日期不能早于开始日期'))
      else callback()
    },
    trigger: 'change'
  }],
  skuPerUnit: [{ required: true, message: '请设置每单元商品数', trigger: 'change' }],
  unitsPerCampaign: [{ required: true, message: '请设置每计划单元数', trigger: 'change' }],
  planGroupMode: [{ required: true, message: '请选择计划分配模式', trigger: 'change' }]
}

const limitItems = computed(() => [
  { key: 'campaign', label: '计划额度', ...preflight.limits.campaign },
  { key: 'adgroup', label: '推广单元额度', ...preflight.limits.adgroup },
  { key: 'ad', label: '创意额度', ...preflight.limits.ad },
  { key: 'keyword', label: '关键词额度', ...preflight.limits.keyword }
])

const preview = computed(() => buildPreview())
const keywordUsageMax = computed(() => {
  if (!preflight.limitsAvailable) return 999999
  return Math.max(Number(preflight.limits.keyword.surplus || 0), 1)
})
const selectedKeywordOptions = computed(() => keywordSourceOptions.filter((option) => config.keywordSources.includes(option.value)))
const keywordPercentageTotal = computed(() => selectedKeywordOptions.value.reduce(
  (total, option) => total + Number(config[option.ratioKey] || 0),
  0
))
const allKeywordSourcesSelected = computed(() => config.keywordSources.length === keywordSourceOptions.length)
const someKeywordSourcesSelected = computed(() => config.keywordSources.length > 0 && !allKeywordSourcesSelected.value)
const keywordSourceSummary = computed(() => {
  if (!selectedKeywordOptions.value.length) return '未选择'
  return selectedKeywordOptions.value
    .map((option) => `${option.label} ${Number(config[option.ratioKey] || 0)}%`)
    .join('、')
})
const areaSummary = computed(() => config.areaType === 1 ? '不限' : `特定区域（${config.areaIds.length} 个）`)
const displayedProducts = computed(() => {
  const start = (filters.pageNo - 1) * filters.pageSize
  return products.value.slice(start, start + filters.pageSize)
})
const bidModeLabel = computed(() => {
  if (config.bidType === 1) return '建议70%'
  if (config.bidType === 2) return '建议50%'
  if (config.bidType === 3) return '建议30%'
  return `自定义 ${config.customRoi}`
})
const customOrientationLabel = computed(() => config.orientationRangeOption.map(Number).includes(2)
  ? '关键词定向 + 商品定向'
  : '关键词定向')
const selectedCrowdSummary = computed(() => {
  const items = Array.isArray(config.dmpCrowdSettings) ? config.dmpCrowdSettings : []
  if (!items.length) return '未选择'
  const names = items.slice(0, 2).map((item) => item.crowdName || `人群${item.crowdId}`)
  return `${names.join('、')}${items.length > 2 ? ` 等 ${items.length} 个` : ''}`
})
const crowdDisplayOptions = computed(() => {
  const result = [...crowdOptions.value]
  const known = new Set(result.map((item) => crowdKey(item)))
  for (const item of config.dmpCrowdSettings || []) {
    if (!known.has(crowdKey(item))) result.push({ ...item, source: item.source || 'saved' })
  }
  return result
})
const defaultCrowdOptions = computed(() => crowdDisplayOptions.value.filter((item) => ['100', '101'].includes(crowdKey(item))))
const crowdCategoryOptions = computed(() => [...new Set(crowdDisplayOptions.value
  .map((item) => crowdCategoryLabel(item))
  .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')))
const filteredCrowdOptions = computed(() => {
  const keyword = crowdKeyword.value.trim().toLowerCase()
  return crowdDisplayOptions.value.filter((item) => {
    const matchesKeyword = !keyword || String(item.crowdName || '').toLowerCase().includes(keyword)
    const matchesCategory = !crowdCategory.value || crowdCategoryLabel(item) === crowdCategory.value
    return matchesKeyword && matchesCategory
  })
})
const keywordMatchTypeLabel = computed(() => keywordMatchTypeOptions.find(
  (option) => option.value === Number(config.keywordMatchType)
)?.label || '切词匹配')
const deliveryModeLabel = computed(() => {
  if (activeTool.value !== 'custom') return bidModeLabel.value
  if (Number(config.automatedBiddingType) === 0) return `关闭全能调价 · 匹配出价 ¥${Number(config.inSearchFee || 0).toFixed(1)}`
  return `全能调价 · 最高溢价 ${config.premiumCoef}%`
})
const progressText = computed(() => {
  if (allProgress.phase === 'initial_wait') {
    return '正在准备读取全店商品…'
  }
  if (allProgress.phase === 'existing_promotion_start') {
    return '正在读取京准通已有推广商品…'
  }
  if (allProgress.phase === 'existing_promotion_page_complete') {
    return `正在读取已有推广商品：第 ${allProgress.page || 1}/${allProgress.totalPages || '?'} 页，已获取 ${allProgress.loaded || 0} 条`
  }
  if (allProgress.phase === 'batch_interval') {
    return `正在后台读取全店商品：已完成 ${allProgress.page}/${allProgress.totalPages || allProgress.page} 页，已获取 ${allProgress.loaded || 0} 个`
  }
  if (allProgress.phase === 'retry_page_complete') {
    return `正在补充商品数据：已完成 ${allProgress.completed}/${allProgress.totalPages} 页，已补回 ${allProgress.loaded} 个`
  }
  return `正在读取全店商品：第 ${allProgress.page || 1}/${allProgress.totalPages || 1} 页，已获取 ${allProgress.loaded || 0} 个`
})
const keywordPrepareProgressText = computed(() => {
  if (keywordPrepareProgress.phase === 'product_keyword_rate_limit_wait') {
    return `推词失败等待 ${keywordPrepareProgress.secondsRemaining || 0} 秒`
  }
  if (keywordPrepareProgress.phase === 'product_keyword_interval') {
    return `推词间隔 ${keywordPrepareProgress.secondsRemaining || 0} 秒`
  }
  if (keywordPrepareProgress.phase === 'keyword_bid_retry_wait') {
    return `出价限流等待 ${keywordPrepareProgress.secondsRemaining || 0} 秒`
  }
  if (keywordPrepareProgress.phase === 'keyword_bid_interval') return '正在整理最低出价'
  if (keywordPrepareProgress.phase === 'keyword_bid_start') return '正在查询最低出价'
  return '正在准备关键词'
})
const creationProgressPercent = computed(() => {
  const progress = keywordPrepareProgress
  const phase = progress.phase || ''
  const unitRatio = progress.totalUnits > 0
    ? Math.min(Math.max(Number(progress.unitIndex || 0) / Number(progress.totalUnits), 0), 1)
    : 0
  const completedRatio = progress.totalUnits > 0
    ? Math.min(Math.max(Number(progress.completedUnits || 0) / Number(progress.totalUnits), 0), 1)
    : 0

  if (phase === 'creation_complete') return 100
  if (phase.startsWith('create_')) return Math.round(82 + completedRatio * 18)
  if (phase === 'creation_submission_start') return 82
  if (phase === 'keyword_prepare_complete') return 80
  if (phase.startsWith('keyword_bid_')) return Math.round(62 + unitRatio * 18)
  if (phase === 'keyword_unit_complete') return Math.round(5 + unitRatio * 57)
  if (phase === 'keyword_unit_start' || phase.startsWith('product_keyword_')) {
    return Math.round(5 + Math.max(unitRatio - (1 / Math.max(Number(progress.totalUnits || 1), 1)), 0) * 57)
  }
  if (phase === 'unit_allocation_complete') return 5
  if (phase === 'submission_preflight_complete') return 3
  if (phase === 'submission_preflight_start' || phase === 'prepare_start') return 1
  return 1
})
const creationProgressTitle = computed(() => {
  const phase = keywordPrepareProgress.phase || ''
  if (phase === 'submission_preflight_start' || phase === 'prepare_start') return '正在校验真实创建环境'
  if (phase === 'submission_preflight_complete') return '创建环境校验通过'
  if (phase === 'unit_allocation_complete') return '推广单元分配完成'
  if (phase === 'product_keyword_rate_limit_wait' || phase === 'keyword_bid_retry_wait') return '京东接口繁忙，正在自动等待'
  if (phase === 'keyword_unit_start' || phase === 'keyword_unit_complete' || phase.startsWith('product_keyword_')) {
    return '正在获取单元关键词'
  }
  if (phase.startsWith('keyword_bid_')) return '正在整理关键词出价'
  if (phase === 'keyword_prepare_complete') return '关键词准备完成'
  if (phase === 'creation_submission_start') return '正在提交至京准通'
  if (phase.startsWith('create_campaign_')) return '正在创建推广计划'
  if (phase.startsWith('create_adgroup_')) return '正在创建推广单元'
  if (phase === 'creation_complete') return '批量创建完成'
  return '正在准备创建任务'
})
const creationProgressDetail = computed(() => {
  const progress = keywordPrepareProgress
  const phase = progress.phase || ''
  const currentUnit = Number(progress.unitIndex || 0)
  const totalUnits = Number(progress.totalUnits || 0)
  if (phase === 'submission_preflight_start' || phase === 'prepare_start') return '正在检查批量创建通道、店铺登录、京东 EID 和签名组件'
  if (phase === 'submission_preflight_complete') return '真实创建依赖已就绪，即将开始准备关键词'
  if (phase === 'unit_allocation_complete') {
    return `已为 ${progress.productCount || preview.value.productCount} 个商品分配 ${totalUnits || preview.value.unitCount} 个推广单元`
  }
  if (phase === 'product_keyword_rate_limit_wait') {
    return `第 ${currentUnit || 1}/${totalUnits || preview.value.unitCount} 个单元推词受限，${progress.secondsRemaining || 0} 秒后重试`
  }
  if (phase === 'keyword_bid_retry_wait') {
    return `第 ${currentUnit || 1}/${totalUnits || preview.value.unitCount} 个单元出价查询受限，${progress.secondsRemaining || 0} 秒后重试`
  }
  if (phase === 'keyword_unit_start' || phase === 'keyword_unit_complete' || phase.startsWith('product_keyword_')) {
    const skuProgress = progress.total ? `，商品推词 ${progress.completed || 0}/${progress.total}` : ''
    return `正在获取第 ${currentUnit || 1}/${totalUnits || preview.value.unitCount} 个单元的关键词${skuProgress}`
  }
  if (phase.startsWith('keyword_bid_')) {
    return `正在查询第 ${currentUnit || 1}/${totalUnits || preview.value.unitCount} 个单元的最低出价`
  }
  if (phase === 'keyword_prepare_complete') {
    return `已准备 ${progress.keywordCount || 0} 个关键词，即将开始创建计划`
  }
  if (phase === 'creation_submission_start') {
    return `即将创建 ${progress.totalCampaigns || preview.value.campaignCount} 个计划、${totalUnits || preview.value.unitCount} 个推广单元`
  }
  if (phase.startsWith('create_campaign_')) {
    return `正在处理第 ${progress.campaignIndex || 1}/${progress.totalCampaigns || preview.value.campaignCount} 个计划`
  }
  if (phase.startsWith('create_adgroup_')) {
    const current = Math.min(Number(progress.completedUnits || 0) + 1, totalUnits || preview.value.unitCount)
    return `正在创建第 ${current}/${totalUnits || preview.value.unitCount} 个推广单元`
  }
  if (phase === 'creation_complete') return '正在汇总京东返回的创建结果'
  return '正在启动创建流程'
})
const creationEtaText = computed(() => {
  if (['product_keyword_rate_limit_wait', 'keyword_bid_retry_wait'].includes(keywordPrepareProgress.phase)) {
    return `${keywordPrepareProgress.secondsRemaining || 0} 秒后自动重试`
  }
  const percent = creationProgressPercent.value
  const elapsedMs = Date.now() - Number(creationStartedAt.value || Date.now())
  if (percent < 3 || elapsedMs < 5000) return '正在估算剩余时间'
  const remainingMs = Math.max(Math.round(elapsedMs * (100 - percent) / percent), 1000)
  return `预计剩余约 ${formatDuration(remainingMs)}`
})
const preparedKeywordDescription = computed(() => {
  const unit = preparedKeywordResult.value?.units?.[0]
  if (!unit) return ''
  const parts = [
    `商智 ${unit.businessWisdomCount}`,
    `商品推词 ${unit.productKeywordCount}`,
    `标题分词 ${unit.titleKeywordCount}`,
    `下拉词 ${unit.dropdownKeywordCount}`
  ]
  if (unit.keywordErrors?.length) parts.push(`提示：${unit.keywordErrors.join('；')}`)
  return parts.join('，')
})

function updateProductTableHeight() {
  if (activeStep.value !== 0) return
  nextTick(() => {
    const tableElement = productTableRef.value?.$el
    if (!tableElement) return
    const contentElement = tableElement.closest('.app-main')
    const contentBottom = contentElement?.getBoundingClientRect().bottom || window.innerHeight
    const tableTop = tableElement.getBoundingClientRect().top
    const paginationAndBottomSpace = 58
    const availableHeight = Math.floor(contentBottom - tableTop - paginationAndBottomSpace)
    productTableHeight.value = Math.max(480, Math.min(720, availableHeight))
  })
}

function updatePreviewTableHeight() {
  nextTick(() => {
    const availableHeight = Math.floor(window.innerHeight - 410)
    previewTableHeight.value = Math.max(360, Math.min(640, availableHeight))
  })
}

function updateResponsiveTableHeights() {
  updateProductTableHeight()
  updatePreviewTableHeight()
}

onMounted(() => {
  loadStores()
  window.addEventListener('resize', updateResponsiveTableHeights)
  updateResponsiveTableHeights()
  removeProgressListener = window.electronAPI.onUpdate('jd-express-products-progress', (progress) => {
    if (progress?.storeId && String(progress.storeId) !== String(storeId.value)) return
    const { batchProducts, ...progressState } = progress || {}
    Object.assign(allProgress, progressState)
    if (progress?.phase === 'page_complete' && Array.isArray(batchProducts)) {
      const mergedProducts = new Map(products.value.map((product) => [product.skuId, product]))
      for (const product of batchProducts) {
        if (excludedProducts.has(product.skuId)) continue
        mergedProducts.set(product.skuId, product)
        selectedProducts.set(product.skuId, product)
      }
      products.value = Array.from(mergedProducts.values())
      productTotal.value = products.value.length
    }
    if (progress?.phase === 'rate_limit_wait') {
      rateLimit.visible = true
      rateLimit.reason = progress.reason || ''
      rateLimit.secondsRemaining = progress.secondsRemaining || 0
    } else if (progress?.phase === 'rate_limit_retry') {
      rateLimit.visible = false
    }
  })
  removeCreationProgressListener = window.electronAPI.onUpdate('jd-express-creation-progress', (progress) => {
    const progressMode = progress?.createMode === 'custom' ? 'custom' : 'roi'
    if (progress?.storeId && !storeId.value) {
      storeId.value = progress.storeId
      activeTool.value = progressMode
      restoreConfig(progress.storeId, progressMode)
    }
    if (progress?.storeId && String(progress.storeId) !== String(storeId.value)) return
    if (progress?.createMode && progressMode !== activeTool.value) {
      activeTool.value = progressMode
      restoreConfig(storeId.value, progressMode)
    }
    Object.assign(keywordPrepareProgress, progress || {})
    const phase = String(progress?.phase || '')
    if (phase && phase !== 'creation_complete') {
      // 页面热更新或从其他功能返回后，仅凭主进程后续进度恢复正在运行的界面；
      // 这里只恢复显示状态，不会再次调用任何创建接口。
      if (!creationStartedAt.value) creationStartedAt.value = Date.now()
      fullCreateLoading.value = true
      activeStep.value = 2
    } else if (phase === 'creation_complete') {
      fullCreateLoading.value = false
    }
    if (progress?.phase === 'keyword_prepare_complete' && progress.preparationToken) {
      rememberPreparationToken(progress.preparationToken, progress.expiresAt)
    } else if (progress?.phase === 'creation_submission_start') {
      creationSubmissionStarted.value = true
      clearPreparationToken()
    }
  })
  removeVerificationListener = window.electronAPI.onUpdate('jd-express-verification-result', (result) => {
    if (result?.storeId && String(result.storeId) !== String(storeId.value)) return
    Object.assign(creationVerification, result || {})
    if (result?.status === 'mismatch') {
      const labels = { campaign: '计划', adgroup: '单元', ad: '创意', keyword: '关键词' }
      const difference = Object.entries(result.missing || {})
        .filter(([, count]) => Number(count) > 0)
        .map(([layer, count]) => `${labels[layer] || layer}少 ${count} 个`)
        .join('、')
      if (difference) {
        showCenteredMessage('warning', `创建后核验发现：${difference}；仅作提示，不会自动补建或影响其他功能`)
      }
    }
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateResponsiveTableHeights)
  removeProgressListener?.()
  removeCreationProgressListener?.()
  removeVerificationListener?.()
})

watch(activeStep, (step) => {
  if (step === 0) updateProductTableHeight()
  if (step === 2) updatePreviewTableHeight()
  if (step === 1 && activeTool.value === 'custom' && storeId.value && crowdLoadedStoreId.value !== String(storeId.value)) {
    void loadCrowds(true)
  }
})

watch(config, () => {
  if (storeId.value) localStorage.setItem(configStorageKey(storeId.value), JSON.stringify(config))
  if (preparedKeywordResult.value) preparedKeywordResult.value = null
  if (preparedFullResult.value) preparedFullResult.value = null
  resumePreparationToken.value = ''
}, { deep: true })

function createDefaultConfig(mode = 'roi') {
  const createMode = mode === 'custom' ? 'custom' : 'roi'
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    createMode,
    unitGroupMode: 'category3',
    keywordTotalUsage: null,
    skuPerUnit: 50,
    useMinKeywordBid: true,
    keywordBidIncrement: 0,
    customKeywordBid: 0.1,
    keywordMatchType: 8,
    keywordSources: [],
    keywordSortType: 4,
    businessWisdomPercent: null,
    productPercent: null,
    titlePercent: null,
    pullDownPercent: null,
    supplementKeywords: true,
    biddingTarget: createMode === 'custom' ? 1 : 16,
    automatedBiddingType: createMode === 'custom' ? 32768 : 8192,
    orientationRangeOption: [1],
    premiumType: 2,
    premiumCoef: 30,
    inSearchFee: 0.1,
    dmpCrowdSettings: [],
    bidType: 3,
    bottomLimit: 3,
    customRoi: 3,
    capCustomRoi: false,
    adjustDirection: 0,
    adjustRatio: 0,
    areaType: 1,
    areaIds: [],
    planMode: 1,
    namePrefix: formatMonthDay(new Date()),
    startDate: formatLocalDate(new Date()),
    unlimitedEndDate: true,
    endDate: formatLocalDate(addDays(new Date(), 30)),
    unlimitedBudget: true,
    dailyBudget: 50,
    planGroupMode: 'category',
    unitsPerCampaign: 100
  }
}

function selectTool(tool) {
  if (!tool?.available || tool.key === activeTool.value) return
  if (storeId.value) localStorage.setItem(configStorageKey(storeId.value, activeTool.value), JSON.stringify(config))
  activeTool.value = tool.key
  restoreConfig(storeId.value, tool.key)
  activeStep.value = 0
  preparedKeywordResult.value = null
  preparedFullResult.value = null
  createdSingleResult.value = null
  createdFullResult.value = null
  Object.assign(creationVerification, { status: 'idle', expected: null, actual: null, missing: null, message: '' })
  resumePreparationToken.value = ''
  creationSubmissionStarted.value = false
  if (!Number.isFinite(config.keywordTotalUsage) && preflight.limitsAvailable && Number(preflight.limits.keyword.surplus) > 0) {
    config.keywordTotalUsage = Number(preflight.limits.keyword.surplus)
  }
  if (config.areaType === 2) void loadAreas()
  if (activeTool.value === 'custom' && storeId.value) void loadCrowds(true)
}

function createKeywordRatioRule(sourceType, sourceLabel) {
  return [{
    validator: (_rule, value, callback) => {
      if (!config.keywordSources.includes(sourceType)) {
        callback()
        return
      }
      if (!Number.isFinite(value) || value < 1 || value > 100) {
        callback(new Error(`请设置${sourceLabel}占比`))
        return
      }
      if (keywordPercentageTotal.value > 100) {
        callback(new Error('关键词占比合计不能超过 100%'))
        return
      }
      callback()
    },
    trigger: 'change'
  }]
}

function toggleAllKeywordSources(value) {
  config.keywordSources = value ? keywordSourceOptions.map((option) => option.value) : []
  handleKeywordSourcesChange(config.keywordSources)
}

function handleKeywordSourcesChange(value) {
  let sources = [...new Set((value || []).map(Number))]
  if (!sources.includes(3)) sources = sources.filter((type) => type !== 4)
  config.keywordSources = sources
  for (const option of keywordSourceOptions) {
    if (sources.includes(option.value) && !Number.isFinite(config[option.ratioKey])) {
      config[option.ratioKey] = option.recommended
    }
  }
  validateKeywordRatios()
}

function validateKeywordRatios() {
  nextTick(() => {
    configFormRef.value?.validateField(keywordSourceOptions.map((option) => option.ratioKey)).catch(() => {})
  })
}

function crowdKey(crowd) {
  return String(crowd?.crowdId ?? crowd?.id ?? '').trim()
}

function crowdCategoryLabel(crowd) {
  const first = String(crowd?.senceFirstCategory || '').trim()
  const second = String(crowd?.senceSecondCategory || '').trim()
  if (first && second && first !== second) return `${first} / ${second}`
  return second || first || (crowd?.source === 'recommended' ? '默认推荐人群' : '自定义人群')
}

function formatCrowdReach(crowd) {
  const value = Number(crowd?.estimateUv ?? crowd?.uv ?? crowd?.globalUv)
  if (!Number.isFinite(value) || value < 0) return '--'
  if (value >= 10000) return `${(value / 10000).toFixed(value >= 100000 ? 0 : 1)}万`
  return Math.round(value).toLocaleString('zh-CN')
}

function findSelectedCrowd(crowd) {
  const key = crowdKey(crowd)
  return (config.dmpCrowdSettings || []).find((item) => crowdKey(item) === key)
}

function isCrowdSelected(crowd) {
  return Boolean(findSelectedCrowd(crowd))
}

function getCrowdPremium(crowd) {
  return Number(findSelectedCrowd(crowd)?.adGroupPrice ?? crowd?.adGroupPrice ?? 10)
}

function toggleCrowd(crowd, checked) {
  const key = crowdKey(crowd)
  if (!key) return
  const selected = [...(config.dmpCrowdSettings || [])]
  const index = selected.findIndex((item) => crowdKey(item) === key)
  if (!checked) {
    if (index >= 0) selected.splice(index, 1)
    config.dmpCrowdSettings = selected
    configFormRef.value?.validateField('dmpCrowdSettings').catch(() => {})
    return
  }
  if (index >= 0) return
  if (selected.length >= 30) {
    showCenteredMessage('warning', '一个推广单元最多选择 30 个人群')
    return
  }
  selected.push({
    ...crowd,
    adGroupPrice: Math.min(Math.max(Math.round(Number(crowd?.adGroupPrice) || 10), 10), 300),
    isUsed: 1
  })
  config.dmpCrowdSettings = selected
  configFormRef.value?.validateField('dmpCrowdSettings').catch(() => {})
}

function updateCrowdPremium(crowd, value) {
  const key = crowdKey(crowd)
  config.dmpCrowdSettings = (config.dmpCrowdSettings || []).map((item) => crowdKey(item) === key
    ? { ...item, adGroupPrice: Math.min(Math.max(Math.round(Number(value) || 10), 10), 300), isUsed: 1 }
    : item)
  configFormRef.value?.validateField('dmpCrowdSettings').catch(() => {})
}

function openCrowdDialog() {
  if (!crowdDisplayOptions.value.length && !crowdLoading.value) void loadCrowds(false)
  crowdDialogVisible.value = true
}

async function loadCrowds(silent = false) {
  if (!ensureStoreSelected() || crowdLoading.value) return
  const requestSeq = ++crowdRequestSeq
  const requestedStoreId = String(storeId.value)
  crowdLoading.value = true
  crowdError.value = ''
  crowdPartial.value = false
  try {
    const result = await window.electronAPI.invoke('jd-express-crowds', { storeId: storeId.value })
    if (!result?.success) throw new Error(result?.message || '读取京东人群失败')
    if (requestSeq !== crowdRequestSeq || requestedStoreId !== String(storeId.value)) return
    crowdOptions.value = Array.isArray(result.crowds) ? result.crowds : []
    crowdLoadedStoreId.value = requestedStoreId
    crowdPartial.value = result.partial === true
    const currentSelections = new Map((config.dmpCrowdSettings || []).map((item) => [crowdKey(item), item]))
    config.dmpCrowdSettings = (config.dmpCrowdSettings || []).map((item) => {
      const fresh = crowdOptions.value.find((option) => crowdKey(option) === crowdKey(item))
      return fresh
        ? { ...fresh, adGroupPrice: getCrowdPremium(currentSelections.get(crowdKey(item))), isUsed: 1 }
        : item
    })
    if (result.partial) {
      crowdError.value = (result.errors || []).map((item) => item.message).filter(Boolean).join('；') || '部分人群加载失败'
    } else if (!crowdOptions.value.length) {
      crowdError.value = '当前店铺未返回可用人群'
    } else if (!silent) {
      showCenteredMessage('success', `已加载 ${crowdOptions.value.length} 个人群`)
    }
  } catch (error) {
    if (requestSeq !== crowdRequestSeq || requestedStoreId !== String(storeId.value)) return
    crowdError.value = error.message || '读取京东人群失败'
    if (!silent) showCenteredMessage('error', crowdError.value)
  } finally {
    if (requestSeq === crowdRequestSeq && requestedStoreId === String(storeId.value)) crowdLoading.value = false
  }
}

async function handleAreaTypeChange(value) {
  if (Number(value) !== 2) {
    allAreasSelected.value = false
    return
  }
  await loadAreas()
}

async function loadAreas() {
  if (!ensureStoreSelected() || areaLoading.value) return
  areaLoading.value = true
  try {
    const result = await window.electronAPI.invoke('jd-express-areas', { storeId: storeId.value })
    if (!result?.success) throw new Error(result?.message || '读取京东地域失败')
    areaTree.value = result.areas || []
    await nextTick()
    areaTreeRef.value?.setCheckedKeys(config.areaIds || [])
    updateAllAreasSelected()
  } catch (error) {
    ElMessage.error(error.message || '读取京东地域失败')
  } finally {
    areaLoading.value = false
  }
}

function handleAreaCheck(_node, state) {
  config.areaIds = (state?.checkedNodes || [])
    .filter((node) => !Array.isArray(node.children) || node.children.length === 0)
    .map((node) => String(node.id))
  updateAllAreasSelected()
  configFormRef.value?.validateField('areaIds').catch(() => {})
}

function toggleAllAreas(value) {
  const leafIds = collectLeafAreaIds(areaTree.value)
  areaTreeRef.value?.setCheckedKeys(value ? leafIds : [])
  config.areaIds = value ? leafIds : []
  configFormRef.value?.validateField('areaIds').catch(() => {})
}

function updateAllAreasSelected() {
  const leafIds = collectLeafAreaIds(areaTree.value)
  allAreasSelected.value = leafIds.length > 0 && config.areaIds.length === leafIds.length
}

function collectLeafAreaIds(nodes) {
  const result = []
  for (const node of nodes || []) {
    if (Array.isArray(node.children) && node.children.length) result.push(...collectLeafAreaIds(node.children))
    else if (node?.id != null) result.push(String(node.id))
  }
  return result
}

async function loadStores() {
  storeLoading.value = true
  try {
    const response = await fetchStores({
      platform: 'jd',
      status: 'enabled',
      page: 1,
      pageSize: 1000
    })
    const list = response?.list || response?.data?.list || []
    stores.value = list.filter((store) => store.platform === 'jd' && store.status === 'enabled')
    if (stores.value.length === 1) {
      storeId.value = stores.value[0].id
      handleStoreChange(storeId.value)
    }
  } catch (error) {
    ElMessage.error('加载京东店铺失败：' + (error.message || '未知错误'))
  } finally {
    storeLoading.value = false
  }
}

async function handleStoreChange(value) {
  deleteCampaignLoading.value = false
  preflight.pin = ''
  preflight.limitsAvailable = false
  resetLimits()
  products.value = []
  productTotal.value = 0
  selectedProducts.clear()
  excludedProducts.clear()
  Object.assign(readIssues, { failedPages: [], errorProducts: [] })
  Object.assign(existingPromotionFilterResult, { enabled: false, mode: filters.existingPromotionFilterMode, filteredCount: 0, filteredSkuIds: [] })
  rateLimit.visible = false
  areaTree.value = []
  allAreasSelected.value = false
  crowdOptions.value = []
  crowdRequestSeq += 1
  crowdLoading.value = false
  crowdError.value = ''
  crowdPartial.value = false
  crowdDialogVisible.value = false
  crowdKeyword.value = ''
  crowdCategory.value = ''
  crowdLoadedStoreId.value = ''
  activeStep.value = 0
  signingReady.value = false
  keywordPrepareLoading.value = false
  preparedKeywordResult.value = null
  singleCreateLoading.value = false
  createdSingleResult.value = null
  fullPrepareLoading.value = false
  preparedFullResult.value = null
  fullCreateLoading.value = false
  createdFullResult.value = null
  Object.assign(creationVerification, { status: 'idle', expected: null, actual: null, missing: null, message: '' })
  resumePreparationToken.value = ''
  creationStartedAt.value = 0
  creationSubmissionStarted.value = false
  Object.assign(keywordPrepareProgress, { phase: '', unitIndex: 0, totalUnits: 0, secondsRemaining: 0 })
  restoreConfig(value)
  await runPreflight({ silent: true })
  if (config.areaType === 2) await loadAreas()
  if (activeTool.value === 'custom') await loadCrowds(true)
}

async function checkSigningEnvironment() {
  if (!ensureStoreSelected()) return
  signingLoading.value = true
  signingReady.value = false
  try {
    const result = await window.electronAPI.invoke('jd-express-signing-probe', { storeId: storeId.value })
    if (!result?.success || !result?.ready) throw new Error(result?.message || '京准通签名环境不可用')
    signingReady.value = true
    ElMessage.success('提交环境校验通过，未创建任何广告计划')
  } catch (error) {
    ElMessage.error(error.message || '提交环境校验失败')
  } finally {
    signingLoading.value = false
  }
}

async function prepareSingleProductKeywords() {
  if (!ensureStoreSelected() || keywordPrepareLoading.value) return
  if (!selectedProducts.size) {
    ElMessage.warning('请先查询待推广商品')
    return
  }
  keywordPrepareLoading.value = true
  preparedKeywordResult.value = null
  Object.assign(keywordPrepareProgress, { phase: '', unitIndex: 0, totalUnits: 0, secondsRemaining: 0 })
  try {
    const result = await window.electronAPI.invoke('jd-express-prepare-creation', {
      storeId: storeId.value,
      scope: 'single_product_test',
      products: toIpcPlainData(Array.from(selectedProducts.values())),
      config: toIpcPlainData(config)
    })
    if (!result?.success) throw new Error(result?.message || '关键词准备失败')
    preparedKeywordResult.value = result
    if (result.keywordSummary?.errorUnitCount) {
      ElMessage.warning('关键词接口已打通，部分来源暂无数据，请查看测试结果')
    } else {
      ElMessage.success('首个商品关键词与最低出价已准备完成，未创建广告计划')
    }
  } catch (error) {
    ElMessage.error(error.message || '关键词准备失败')
  } finally {
    keywordPrepareLoading.value = false
  }
}

async function createSingleProductPlan() {
  if (!preparedKeywordResult.value || !signingReady.value || singleCreateLoading.value) return
  const firstProduct = Array.from(selectedProducts.values())[0]
  const budgetText = config.unlimitedBudget ? '每日预算不限' : `每日预算 ¥${config.dailyBudget}`
  try {
    await ElMessageBox.confirm(
      `将真实创建 1 个京东快车测试计划，只包含 SKU ${firstProduct?.skuId || '-'}；${budgetText}，目标投产比 ${bidModeLabel.value}。创建后需到京准通查看，是否继续？`,
      '确认创建单商品测试计划',
      {
        confirmButtonText: '确认创建 1 个计划',
        cancelButtonText: '取消',
        type: 'warning',
        dangerouslyUseHTMLString: false
      }
    )
  } catch {
    return
  }

  singleCreateLoading.value = true
  try {
    const result = await window.electronAPI.invoke('jd-express-create-single-test', {
      storeId: storeId.value,
      preparationToken: preparedKeywordResult.value.preparationToken,
      confirmation: 'CREATE_SINGLE_PRODUCT_TEST'
    })
    if (!result?.success) throw new Error(result?.message || '创建测试计划失败')
    createdSingleResult.value = result
    preparedKeywordResult.value = null
    preparedFullResult.value = null
    ElMessage.success(`测试计划创建成功，计划 ID：${result.campaignId || '京东未返回'}`)
    await runPreflight({ silent: true })
  } catch (error) {
    ElMessage.error(error.message || '创建测试计划失败')
  } finally {
    singleCreateLoading.value = false
  }
}

async function prepareFullKeywords() {
  if (!ensureStoreSelected() || keywordPrepareLoading.value || fullPrepareLoading.value) return
  if (!selectedProducts.size) {
    ElMessage.warning('请先查询待推广商品')
    return
  }
  keywordPrepareLoading.value = true
  fullPrepareLoading.value = true
  preparedFullResult.value = null
  Object.assign(keywordPrepareProgress, { phase: '', unitIndex: 0, totalUnits: 0, secondsRemaining: 0 })
  try {
    const result = await window.electronAPI.invoke('jd-express-prepare-creation', {
      storeId: storeId.value,
      scope: 'full',
      createMode: activeTool.value,
      products: toIpcPlainData(Array.from(selectedProducts.values())),
      config: toIpcPlainData(config)
    })
    if (!result?.success) throw new Error(result?.message || '全部关键词准备失败')
    preparedFullResult.value = result
    if (result.keywordSummary?.errorUnitCount) {
      ElMessage.warning('全部关键词已准备，部分来源暂无数据，请核对提示后再创建')
    } else {
      ElMessage.success('全部推广单元的关键词与最低出价已准备完成，尚未创建计划')
    }
  } catch (error) {
    ElMessage.error(error.message || '全部关键词准备失败')
  } finally {
    keywordPrepareLoading.value = false
    fullPrepareLoading.value = false
  }
}

async function createAllPlans() {
  if (!ensureStoreSelected() || fullCreateLoading.value) return
  if (!selectedProducts.size) {
    showCenteredMessage('warning', '请先查询待推广商品')
    return
  }
  if (preview.value.limitWarnings.length) {
    showCenteredMessage('warning', '请先处理创建预览中的额度或配置问题')
    return
  }
  const summary = preview.value
  const savedPreparationToken = readPreparationToken()
  const budgetText = config.unlimitedBudget ? '每日预算不限' : `每个计划每日预算 ¥${config.dailyBudget}`
  const keywordBidText = config.useMinKeywordBid
    ? `关键词按京东最低出价＋¥${Number(config.keywordBidIncrement || 0).toFixed(1)}`
    : `关键词固定出价 ¥${Number(config.customKeywordBid || 0.1).toFixed(1)}`
  const createModeText = activeTool.value === 'custom'
    ? `自定义投放（${keywordBidText}，${deliveryModeLabel.value}，智能匹配出价 ¥${Number(config.inSearchFee || 0).toFixed(1)}）`
    : `目标投产比 ${bidModeLabel.value}`
  try {
    await ElMessageBox.confirm(
      `将自动准备关键词并真实创建 ${summary.campaignCount} 个计划、${summary.unitCount} 个推广单元，包含 ${summary.productCount} 个商品；${budgetText}，${createModeText}。${savedPreparationToken ? '检测到可恢复的关键词结果，本次将直接继续创建。' : ''}是否继续？`,
      '确认批量创建京东快车计划',
      {
        confirmButtonText: '确认创建全部计划',
        cancelButtonText: '取消',
        type: 'warning',
        dangerouslyUseHTMLString: false
      }
    )
  } catch {
    return
  }

  fullCreateLoading.value = true
  creationStartedAt.value = Date.now()
  creationSubmissionStarted.value = false
  createdFullResult.value = null
  Object.assign(creationVerification, { status: 'idle', expected: null, actual: null, missing: null, message: '' })
  Object.assign(keywordPrepareProgress, { phase: 'prepare_start', unitIndex: 0, totalUnits: summary.unitCount, secondsRemaining: 0 })
  try {
    const result = await window.electronAPI.invoke('jd-express-create-full', {
      storeId: storeId.value,
      createMode: activeTool.value,
      products: toIpcPlainData(Array.from(selectedProducts.values())),
      config: toIpcPlainData(config),
      ...(savedPreparationToken ? { preparationToken: savedPreparationToken } : {}),
      confirmation: activeTool.value === 'custom' ? 'CREATE_ALL_CUSTOM_CAMPAIGNS' : 'CREATE_ALL_ROI_CAMPAIGNS'
    })
    if (!result?.success) {
      if (result?.preparationToken) {
        rememberPreparationToken(result.preparationToken, result.preparationExpiresAt)
      }
      if (result?.code === 'JD_EXPRESS_PREPARATION_EXPIRED') clearPreparationToken()
      const requestError = new Error(result?.message || '批量创建计划失败')
      requestError.code = result?.code
      requestError.retryWithoutPreparation = result?.retryWithoutPreparation === true
      throw requestError
    }
    createdFullResult.value = result
    clearPreparationToken()
    preparedFullResult.value = null
    preparedKeywordResult.value = null
    if (result.failureCount) {
      ElMessage.warning(`批量创建完成：成功 ${result.successCampaignCount}/${result.campaignCount} 个计划、${result.successUnitCount}/${result.unitCount} 个单元，失败 ${result.failureCount} 个单元`)
    } else {
      ElMessage.success(`批量创建成功：${result.successCampaignCount} 个计划、${result.successUnitCount} 个单元`)
    }
    await runPreflight({ silent: true })
  } catch (error) {
    const canResume = Boolean(readPreparationToken()) || error?.retryWithoutPreparation
    const message = error?.message || '批量创建计划失败'
    if (canResume && !creationSubmissionStarted.value) {
      showCenteredMessage('error', `${message}；关键词结果已保留，再次点击可直接重试`)
    } else if (creationSubmissionStarted.value) {
      showCenteredMessage('error', `${message}；提交状态可能不确定，请先前往京准通核对后再重试`)
    } else {
      showCenteredMessage('error', message)
    }
  } finally {
    fullCreateLoading.value = false
  }
}

async function runPreflight(options = {}) {
  if (!ensureStoreSelected()) return false
  preflightLoading.value = true
  try {
    const result = await window.electronAPI.invoke('jd-express-preflight', { storeId: storeId.value })
    if (!result?.success) throw new Error(result?.message || '检测失败')
    preflight.pin = result.pin || ''
    preflight.limitsAvailable = result.limitsAvailable !== false
    Object.assign(preflight.limits, result.limits || {})
    if (preflight.limitsAvailable && Number(preflight.limits.keyword.surplus) > 0) {
      config.keywordTotalUsage = Number(preflight.limits.keyword.surplus)
    }
    if (!options.silent && !preflight.limitsAvailable) {
      ElMessage.warning('京准通登录正常，但额度读取失败，请稍后重试')
    } else if (!options.silent) {
      ElMessage.success('京准通投放环境检测通过')
    }
    return true
  } catch (error) {
    ElMessage.error(error.message || '检测失败')
    return false
  } finally {
    preflightLoading.value = false
  }
}

async function confirmDeleteAllCampaigns() {
  if (!ensureStoreSelected() || deleteCampaignLoading.value || fullCreateLoading.value) return
  deleteCampaignLoading.value = true
  try {
    const preview = await window.electronAPI.invoke('jd-express-delete-preview', {
      storeId: storeId.value
    })
    if (!preview?.success) {
      const error = new Error(preview?.message || '读取可删除计划失败')
      error.code = preview?.code
      throw error
    }

    const campaigns = Array.isArray(preview.campaigns) ? preview.campaigns : []
    if (!campaigns.length) {
      showCenteredMessage('info', '当前店铺没有可删除的快车计划')
      return
    }

    const store = stores.value.find((item) => String(item.id) === String(storeId.value))
    const storeName = store?.name || `店铺 ${storeId.value}`

    await ElMessageBox.confirm(
      `检测到 ${campaigns.length} 个有效快车计划。将删除当前店铺的全部有效快车计划，包括非本工具创建的计划。`,
      '删除计划提示',
      {
        type: 'warning',
        confirmButtonText: '继续确认',
        cancelButtonText: '取消',
        distinguishCancelAndClose: true,
        customClass: 'jd-express-delete-message-box'
      }
    )
    await ElMessageBox.confirm(
      `最后确认：删除“${storeName}”的 ${campaigns.length} 个快车计划？删除后不可恢复。`,
      '一键删除店铺计划',
      {
        type: 'error',
        confirmButtonText: `确认删除 ${campaigns.length} 个计划`,
        cancelButtonText: '取消',
        distinguishCancelAndClose: true,
        customClass: 'jd-express-delete-message-box'
      }
    )

    const result = await window.electronAPI.invoke('jd-express-delete-all', {
      storeId: storeId.value,
      expectedPlanIds: campaigns.map((campaign) => campaign.id),
      confirmation: 'DELETE_ALL_STORE_CAMPAIGNS'
    })
    if (!result?.success) {
      const error = new Error(result?.message || '删除快车计划失败')
      error.code = result?.code
      throw error
    }
    showCenteredMessage('success', `已删除 ${result.deletedCount || 0} 个快车计划`)
    await runPreflight({ silent: true })
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    const message = error?.code === 'JD_EXPRESS_DELETE_SCOPE_CHANGED'
      ? '店铺计划列表已发生变化，为避免误删已停止操作，请重新点击后确认'
      : error?.message || '删除快车计划失败'
    showCenteredMessage('error', message)
  } finally {
    deleteCampaignLoading.value = false
  }
}

async function loadAllProducts() {
  if (!ensureStoreSelected()) return
  allProductLoading.value = true
  Object.assign(allProgress, { phase: '', page: 0, totalPages: 0, loaded: 0, waitSeconds: 0 })
  try {
    const result = await window.electronAPI.invoke('jd-express-all-products', {
      storeId: storeId.value,
      filters: {
        keyword: filters.keyword,
        minPrice: filters.minPrice,
        maxPrice: filters.maxPrice,
        startOnlineTime: filters.onlineRange?.[0] || '',
        endOnlineTime: filters.onlineRange?.[1] || '',
        filterExistingPromotion: filters.filterExistingPromotion,
        existingPromotionFilterMode: filters.existingPromotionFilterMode
      }
    })
    if (!result?.success) throw new Error(result?.message || '全店商品读取失败')
    const loadedProducts = (result.products || []).filter((product) => !excludedProducts.has(product.skuId))
    products.value = loadedProducts
    productTotal.value = loadedProducts.length
    selectedProducts.clear()
    for (const product of loadedProducts) selectedProducts.set(product.skuId, product)
    readIssues.failedPages = result.failedPages || []
    readIssues.errorProducts = result.errorProducts || []
    Object.assign(existingPromotionFilterResult, result.existingPromotionFilter || {
      enabled: false,
      mode: filters.existingPromotionFilterMode,
      filteredCount: 0,
      filteredSkuIds: []
    })
    const filteredTip = existingPromotionFilterResult.filteredCount
      ? `，已过滤 ${existingPromotionFilterResult.filteredCount} 个已有推广商品`
      : ''
    if (readIssues.failedPages.length || readIssues.errorProducts.length) {
      showCenteredMessage('warning', `已读取 ${selectedProducts.size} 个商品${filteredTip}，部分数据需要补查`)
    } else {
      showCenteredMessage('success', `查询完成，共 ${selectedProducts.size} 个待推广商品${filteredTip}`)
    }
  } catch (error) {
    showCenteredMessage('error', error.message || '全店商品读取失败')
  } finally {
    allProductLoading.value = false
    rateLimit.visible = false
  }
}

async function retryFailedPages() {
  if (!readIssues.failedPages.length || !ensureStoreSelected()) return
  retryLoading.value = true
  const pages = readIssues.failedPages.map((item) => item.page)
  try {
    const result = await window.electronAPI.invoke('jd-express-retry-pages', {
      storeId: storeId.value,
      pages,
      filters: {
        keyword: filters.keyword,
        minPrice: filters.minPrice,
        maxPrice: filters.maxPrice,
        startOnlineTime: filters.onlineRange?.[0] || '',
        endOnlineTime: filters.onlineRange?.[1] || '',
        filterExistingPromotion: filters.filterExistingPromotion,
        existingPromotionFilterMode: filters.existingPromotionFilterMode
      }
    })
    if (!result?.success) throw new Error(result?.message || '失败页补查失败')
    const mergedProducts = new Map(products.value.map((product) => [product.skuId, product]))
    for (const product of result.products || []) {
      if (!excludedProducts.has(product.skuId)) {
        selectedProducts.set(product.skuId, product)
        mergedProducts.set(product.skuId, product)
      }
    }
    products.value = Array.from(mergedProducts.values())
    productTotal.value = products.value.length
    readIssues.failedPages = result.failedPages || []
    readIssues.errorProducts = result.errorProducts || []
    if (result.existingPromotionFilter) {
      const filteredSkuIds = [...new Set([
        ...(existingPromotionFilterResult.filteredSkuIds || []),
        ...(result.existingPromotionFilter.filteredSkuIds || [])
      ].map(String))]
      existingPromotionFilterResult.enabled = result.existingPromotionFilter.enabled
      existingPromotionFilterResult.mode = result.existingPromotionFilter.mode || filters.existingPromotionFilterMode
      existingPromotionFilterResult.filteredSkuIds = filteredSkuIds
      existingPromotionFilterResult.filteredCount = filteredSkuIds.length || Math.max(
        existingPromotionFilterResult.filteredCount,
        Number(result.existingPromotionFilter.filteredCount || 0)
      )
    }
    if (readIssues.failedPages.length) {
      ElMessage.warning(`补查完成，仍有 ${readIssues.failedPages.length} 页失败，可稍后再次补查`)
    } else {
      ElMessage.success(`补查完成，已补回 ${result.products?.length || 0} 个商品`)
    }
  } catch (error) {
    ElMessage.error(error.message || '失败页补查失败')
  } finally {
    retryLoading.value = false
    rateLimit.visible = false
  }
}

async function searchProducts() {
  if (!ensureStoreSelected('请先选择京东店铺后再查询商品')) {
    allProductLoading.value = false
    return
  }
  filters.pageNo = 1
  products.value = []
  productTotal.value = 0
  selectedProducts.clear()
  excludedProducts.clear()
  Object.assign(existingPromotionFilterResult, { enabled: false, mode: filters.existingPromotionFilterMode, filteredCount: 0, filteredSkuIds: [] })
  await loadAllProducts()
}

async function removeProduct(product) {
  try {
    await ElMessageBox.confirm(`确定从本次推广中删除 SKU ${product.skuId} 吗？`, '删除商品', {
      confirmButtonText: '确定删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    excludedProducts.set(product.skuId, product)
    selectedProducts.delete(product.skuId)
    products.value = products.value.filter((item) => item.skuId !== product.skuId)
    productTotal.value = products.value.length
    const maxPage = Math.max(Math.ceil(productTotal.value / filters.pageSize), 1)
    if (filters.pageNo > maxPage) filters.pageNo = maxPage
    ElMessage.success('删除成功')
  } catch {
    // 用户取消删除。
  }
}

function restoreDeletedProducts() {
  const mergedProducts = new Map(products.value.map((product) => [product.skuId, product]))
  for (const product of excludedProducts.values()) {
    selectedProducts.set(product.skuId, product)
    mergedProducts.set(product.skuId, product)
  }
  products.value = Array.from(mergedProducts.values())
  productTotal.value = products.value.length
  excludedProducts.clear()
  ElMessage.success('已恢复删除的商品')
}

function resetFilters() {
  Object.assign(filters, {
    keyword: '',
    minPrice: null,
    maxPrice: null,
    onlineRange: [],
    filterExistingPromotion: true,
    existingPromotionFilterMode: 'sku',
    pageNo: 1,
    pageSize: filters.pageSize
  })
  Object.assign(existingPromotionFilterResult, {
    enabled: false,
    mode: 'sku',
    filteredCount: 0,
    filteredSkuIds: []
  })
}

function handlePageSizeChange() {
  filters.pageNo = 1
}

async function goNext() {
  if (!ensureStoreSelected('请先选择京东店铺后再进入下一步')) {
    preflightLoading.value = false
    return
  }
  if (activeStep.value === 0) {
    if (!preflight.pin) {
      const passed = await runPreflight({ silent: true })
      if (!passed) return
    }
    if (!selectedProducts.size) {
      ElMessage.warning('请先查询待推广商品')
      return
    }
    activeStep.value = 1
    return
  }
  if (activeStep.value === 1) {
    try {
      await configFormRef.value?.validate()
      activeStep.value = 2
    } catch {
      ElMessage.warning('请完善投放配置')
    }
  }
}

function buildPreview() {
  const selected = Array.from(selectedProducts.values())
  const categoryGroups = new Map()
  for (const product of selected) {
    const key = product.categoryId || product.raw?.categoryId || 'uncategorized'
    const label = product.categoryName || product.raw?.categoryName || product.categoryId || '未分类'
    if (!categoryGroups.has(key)) categoryGroups.set(key, { key, label, products: [] })
    categoryGroups.get(key).products.push(product)
  }

  const units = []
  for (const group of categoryGroups.values()) {
    chunk(group.products, config.skuPerUnit).forEach((unitProducts, index) => {
      const first = unitProducts[0] || {}
      units.push({
        name: `${group.label}(${index + 1})_${units.length + 1}`,
        categoryName: group.label,
        cid2Id: first.cid2Id || first.raw?.cid2Id || first.raw?.cid2 || group.key,
        cid2Name: first.cid2Name || first.raw?.cid2Name || group.label,
        products: unitProducts
      })
    })
  }

  const campaigns = []
  if (config.planGroupMode === 'quantity') {
    chunk(units, config.unitsPerCampaign).forEach((campaignUnits, index) => {
      campaigns.push({
        name: `${config.namePrefix}_${index + 1}`,
        categoryName: '按数量',
        unitCount: campaignUnits.length,
        productCount: campaignUnits.reduce((sum, unit) => sum + unit.products.length, 0)
      })
    })
  } else {
    const secondCategoryGroups = new Map()
    for (const unit of units) {
      if (!secondCategoryGroups.has(unit.cid2Id)) {
        secondCategoryGroups.set(unit.cid2Id, { label: unit.cid2Name, units: [] })
      }
      secondCategoryGroups.get(unit.cid2Id).units.push(unit)
    }
    for (const group of secondCategoryGroups.values()) {
      chunk(group.units, config.unitsPerCampaign).forEach((campaignUnits, index) => {
        campaigns.push({
          name: `${config.namePrefix}_${group.label}_(${index + 1})_${campaigns.length + 1}`,
          categoryName: group.label,
          unitCount: campaignUnits.length,
          productCount: campaignUnits.reduce((sum, unit) => sum + unit.products.length, 0)
        })
      })
    }
  }

  const creativeCount = selected.length
  const unitCount = units.length
  const keywordPerUnit = unitCount
    ? Math.min(Math.floor(Number(config.keywordTotalUsage || 0) / unitCount), 200)
    : 0
  const keywordCount = unitCount * keywordPerUnit
  const warnings = []
  appendLimitWarning(warnings, '计划', campaigns.length, preflight.limits.campaign.surplus)
  appendLimitWarning(warnings, '推广单元', unitCount, preflight.limits.adgroup.surplus)
  appendLimitWarning(warnings, '创意', creativeCount, preflight.limits.ad.surplus)
  appendLimitWarning(warnings, '关键词', Number(config.keywordTotalUsage || 0), preflight.limits.keyword.surplus)
  if (unitCount && keywordPerUnit < 1) warnings.push('关键词总用量不足，无法为每个推广单元分配至少 1 个关键词')
  if (!config.keywordSources.length) warnings.push('尚未选择关键词类型')
  if (keywordPercentageTotal.value > 100) warnings.push('关键词来源占比合计不能超过 100%')
  if (config.areaType === 2 && !config.areaIds.length) warnings.push('尚未选择投放区域')

  return {
    campaigns,
    productCount: selected.length,
    campaignCount: campaigns.length,
    unitCount,
    creativeCount,
    keywordPerUnit,
    keywordCount,
    limitWarnings: warnings
  }
}

function appendLimitWarning(warnings, label, required, surplus) {
  if (preflight.pin && preflight.limitsAvailable && required > Number(surplus || 0)) {
    warnings.push(`${label}需要 ${required} 个，当前仅剩 ${surplus || 0} 个额度`)
  }
}

function restoreConfig(value, mode = activeTool.value) {
  const defaults = createDefaultConfig(mode)
  Object.assign(config, defaults)
  if (!value) return false
  try {
    const saved = JSON.parse(localStorage.getItem(configStorageKey(value, mode)) || 'null')
    if (!saved || typeof saved !== 'object') return false
    const knownValues = {}
    for (const key of Object.keys(defaults)) {
      if (Object.prototype.hasOwnProperty.call(saved, key)) knownValues[key] = saved[key]
    }
    Object.assign(config, knownValues)
    config.schemaVersion = CONFIG_SCHEMA_VERSION
    config.createMode = mode === 'custom' ? 'custom' : 'roi'
    config.biddingTarget = config.createMode === 'custom' ? 1 : 16
    config.automatedBiddingType = config.createMode === 'custom'
      ? (Number(config.automatedBiddingType) === 0 ? 0 : 32768)
      : 8192
    config.keywordSources = [...new Set((Array.isArray(config.keywordSources) ? config.keywordSources : [])
      .map(Number)
      .filter((source) => keywordSourceOptions.some((option) => option.value === source)))]
    config.keywordMatchType = keywordMatchTypeOptions.some((option) => option.value === Number(config.keywordMatchType))
      ? Number(config.keywordMatchType)
      : 8
    if (!config.keywordSources.includes(3)) config.keywordSources = config.keywordSources.filter((source) => source !== 4)
    config.orientationRangeOption = config.createMode === 'custom' && Array.isArray(config.orientationRangeOption) && config.orientationRangeOption.map(Number).includes(2)
      ? [1, 2]
      : [1]
    config.dmpCrowdSettings = config.createMode === 'custom' && Array.isArray(config.dmpCrowdSettings)
      ? config.dmpCrowdSettings
        .filter((item) => crowdKey(item))
        .slice(0, 30)
        .map((item) => ({
          ...item,
          adGroupPrice: Math.min(Math.max(Math.round(Number(item.adGroupPrice) || 10), 10), 300),
          isUsed: 1
        }))
      : []
    config.areaIds = Array.isArray(config.areaIds) ? [...new Set(config.areaIds.map(String).filter(Boolean))] : []
    return Number(saved.schemaVersion) >= CONFIG_SCHEMA_VERSION
  } catch {
    localStorage.removeItem(configStorageKey(value, mode))
    return false
  }
}

function configStorageKey(value, mode = activeTool.value) {
  return `dxe_jd_express_${mode === 'custom' ? 'custom' : 'roi'}_config_${value}`
}

function preparationStorageKey(value = storeId.value, mode = activeTool.value) {
  return mode === 'custom'
    ? `dxe_jd_express_custom_preparation_${value || 'none'}`
    : `dxe_jd_express_preparation_${value || 'none'}`
}

function creationInputSignature() {
  const skuIds = Array.from(selectedProducts.keys()).map(String).sort()
  const text = JSON.stringify({
    storeId: String(storeId.value || ''),
    createMode: activeTool.value,
    skuIds,
    config: toIpcPlainData(config)
  })
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${skuIds.length}-${(hash >>> 0).toString(16)}`
}

function rememberPreparationToken(token, expiresAt) {
  if (!storeId.value || !token) return
  const payload = {
    token: String(token),
    expiresAt: Number(expiresAt || 0),
    signature: creationInputSignature()
  }
  resumePreparationToken.value = payload.token
  localStorage.setItem(preparationStorageKey(), JSON.stringify(payload))
}

function readPreparationToken() {
  if (!storeId.value) return ''
  try {
    const payload = JSON.parse(localStorage.getItem(preparationStorageKey()) || 'null')
    if (!payload?.token || !payload?.expiresAt || payload.expiresAt <= Date.now()) {
      clearPreparationToken()
      return ''
    }
    if (payload.signature !== creationInputSignature()) {
      resumePreparationToken.value = ''
      return ''
    }
    resumePreparationToken.value = String(payload.token)
    return resumePreparationToken.value
  } catch {
    clearPreparationToken()
    return ''
  }
}

function clearPreparationToken() {
  resumePreparationToken.value = ''
  if (storeId.value) localStorage.removeItem(preparationStorageKey())
}

function ensureStoreSelected(message = '请先选择京东店铺') {
  if (storeId.value) return true
  showCenteredMessage('warning', message)
  return false
}

function showCenteredMessage(type, message) {
  ElMessage({
    type,
    message,
    duration: 2500,
    grouping: true,
    customClass: 'jd-express-center-message'
  })
}

async function openJzt() {
  if (!ensureStoreSelected()) return
  try {
    const result = await window.electronAPI.invoke('open-store-backend-url', {
      storeId: storeId.value,
      url: JZT_URL,
      title: '京东快车'
    })
    if (result?.success === false) throw new Error(result.message || '打开失败')
  } catch (error) {
    ElMessage.error(error.message || '打开京准通失败')
  }
}

function resetLimits() {
  for (const key of Object.keys(preflight.limits)) {
    Object.assign(preflight.limits[key], { total: 0, current: 0, surplus: 0 })
  }
}

function chunk(list, size) {
  const safeSize = Math.max(Number(size) || 1, 1)
  const result = []
  for (let index = 0; index < list.length; index += safeSize) {
    result.push(list.slice(index, index + safeSize))
  }
  return result
}

function toIpcPlainData(value) {
  return JSON.parse(JSON.stringify(value))
}

function addDays(date, days) {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

function formatLocalDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatMonthDay(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
}

function formatMoney(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? `¥${number.toFixed(2)}` : '—'
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(Math.round(Number(milliseconds || 0) / 1000), 1)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.ceil(totalSeconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`
}
</script>

<style scoped>
.jd-express-page {
  position: relative;
  isolation: isolate;
  min-height: 100%;
  padding: 0;
}

.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 24px;
  margin-bottom: 16px;
  background: #fff;
  border: 1px solid #e5e9f2;
  border-radius: 10px;
}

.page-header h2 {
  margin: 0 0 6px;
  font-size: 22px;
  color: #1d2433;
}

.page-header p {
  margin: 0;
  color: #9098a8;
  font-size: 13px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.store-select {
  width: 230px;
}

.tool-tabs {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.tool-tab {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 76px;
  padding: 14px 16px;
  text-align: left;
  color: #5a6272;
  background: #fff;
  border: 1px solid #e2e7ef;
  border-radius: 10px;
  cursor: pointer;
  transition: 0.2s ease;
}

.tool-tab:hover:not(.active) {
  color: #2b5aed;
  border-color: #86a2ff;
  box-shadow: 0 4px 14px rgba(43, 90, 237, 0.1);
}

.tool-tab.active {
  color: #fff;
  background: #2b5aed;
  border-color: #2b5aed;
  box-shadow: 0 6px 16px rgba(43, 90, 237, 0.22);
}

.tool-icon {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  font-size: 25px;
  color: #c2c9d5;
}

.tool-tab.active .tool-icon {
  color: #fff;
}

.tool-tab strong,
.tool-tab small {
  display: block;
}

.tool-tab strong {
  margin-bottom: 5px;
  font-size: 15px;
}

.tool-tab small {
  color: #9aa2b1;
  white-space: nowrap;
}

.tool-tab.active small {
  color: rgba(255, 255, 255, 0.76);
}

.tool-tab .el-tag {
  margin-left: auto;
}

.tool-tab.active .el-tag {
  color: #fff;
  background: rgba(255, 255, 255, 0.14);
  border-color: rgba(255, 255, 255, 0.35);
}

.status-card,
.work-card {
  margin-top: 16px;
  border-radius: 10px;
}

.work-card :deep(.el-card__body) {
  padding: 14px 16px 12px;
}

.workflow-nav {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  padding: 7px;
  background: #f5f7fb;
  border: 1px solid #e7ebf2;
  border-radius: 9px;
}

.workflow-step {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-width: 0;
  min-height: 42px;
  color: #9aa3b2;
  border: 1px solid transparent;
  border-radius: 7px;
}

.workflow-step.active {
  color: #fff;
  background: #2b5aed;
  border-color: #2b5aed;
  box-shadow: 0 4px 12px rgba(43, 90, 237, 0.2);
}

.workflow-step.done {
  color: #2b5aed;
  background: #edf2ff;
  border-color: #d8e2ff;
}

.workflow-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 23px;
  height: 23px;
  flex-shrink: 0;
  color: #98a2b3;
  background: #fff;
  border: 1px solid #cdd4df;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 700;
}

.workflow-step.active .workflow-index {
  color: #fff;
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.48);
}

.workflow-step.done .workflow-index {
  color: #2b5aed;
  background: #eaf0ff;
  border-color: #b9c8fb;
}

.workflow-copy {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 8px;
}

.workflow-copy strong {
  color: inherit;
  font-size: 13px;
  white-space: nowrap;
}

.workflow-copy small {
  color: #a1a9b6;
  font-size: 11px;
  white-space: nowrap;
}

.workflow-step.active .workflow-copy small {
  color: rgba(255, 255, 255, 0.76);
}

.workflow-step.done .workflow-copy small {
  color: #7c91cc;
}

.card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}

.status-tags {
  display: flex;
  gap: 8px;
}

.limit-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.limit-item {
  padding: 14px 18px;
  background: #f7f9fc;
  border-radius: 8px;
}

.limit-item span,
.limit-item small {
  display: block;
  color: #8a93a3;
}

.limit-item strong {
  display: block;
  margin: 5px 0 2px;
  font-size: 24px;
  color: #25324b;
}

.step-panel {
  padding-top: 14px;
}

.filter-form {
  padding: 16px 16px 0;
  background: #f7f9fc;
  border-radius: 8px;
}

.filter-form :deep(.el-input) {
  width: 180px;
}

.filter-form :deep(.el-input-number) {
  width: 135px;
}

.existing-promotion-filter {
  display: flex;
  align-items: center;
  gap: 10px;
}

.filter-form .existing-promotion-mode {
  width: 130px;
}

.range-separator {
  padding: 0 7px;
  color: #9aa2b1;
}

.selection-summary {
  display: flex;
  align-items: center;
  height: 42px;
  gap: 10px;
  color: #657087;
}

.selection-summary strong {
  color: #2b5aed;
}

.progress-text {
  color: #667085;
  font-size: 13px;
}

.read-issues {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  margin-bottom: 12px;
  color: #9a6700;
  background: #fff7e6;
  border: 1px solid #f5d59a;
  border-radius: 6px;
}

.rate-limit-content {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 12px;
  padding: 12px 0 18px;
}

.rate-limit-content strong {
  color: #e6a23c;
  font-size: 16px;
}

.rate-limit-content span {
  color: #2b5aed;
  font-size: 28px;
  font-weight: 700;
}

.rate-limit-content small {
  color: #8b94a4;
}

.product-image,
.image-placeholder {
  width: 48px;
  height: 48px;
  border-radius: 5px;
}

.image-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #a8b0bd;
  background: #f0f2f6;
  font-size: 12px;
}

.pagination-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  padding-top: 9px;
}

.pagination-next {
  grid-column: 2;
}

.pagination-row .el-pagination {
  grid-column: 3;
  justify-self: end;
}

.config-panel {
  width: 100%;
}

.config-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 330px;
  align-items: start;
  gap: 18px;
}

.config-main-column {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.config-section,
.config-summary-card {
  background: #fff;
  border: 1px solid #e5e9f2;
  border-radius: 10px;
  box-shadow: 0 1px 2px rgba(26, 39, 66, 0.03);
}

.config-section {
  padding: 18px 20px 2px;
}

.section-heading {
  display: flex;
  align-items: center;
  gap: 11px;
  padding-bottom: 14px;
  margin-bottom: 16px;
  border-bottom: 1px solid #edf0f5;
}

.section-number {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  color: #2b5aed;
  background: #eef3ff;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 700;
}

.section-heading h3,
.summary-title h3 {
  margin: 0;
  color: #25324b;
  font-size: 15px;
  line-height: 21px;
}

.section-heading p,
.summary-title p {
  margin: 2px 0 0;
  color: #98a1b0;
  font-size: 12px;
  line-height: 18px;
}

.field-label-with-help {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.help-icon {
  width: 16px;
  height: 16px;
  color: #a6afbe;
  cursor: help;
  font-size: 16px;
  transition: color 0.18s ease;
}

.help-icon:hover {
  color: #2b5aed;
}

:global(.el-popper.jd-express-help-popper) {
  width: 320px !important;
  max-width: calc(100vw - 48px) !important;
  box-sizing: border-box;
  line-height: 20px;
  text-align: left;
  white-space: normal !important;
  overflow-wrap: anywhere;
  word-break: break-word;
}

:global(.el-message.jd-express-center-message),
:global(.el-message.jd-express-center-message.el-message-fade-enter-from),
:global(.el-message.jd-express-center-message.el-message-fade-enter-to),
:global(.el-message.jd-express-center-message.el-message-fade-leave-from),
:global(.el-message.jd-express-center-message.el-message-fade-leave-to) {
  top: 50% !important;
  bottom: auto !important;
  transform: translate(-50%, -50%) !important;
}

.config-section :deep(.el-form-item) {
  margin-bottom: 16px;
}

.config-section :deep(.el-input),
.config-section :deep(.el-input-number),
.config-section :deep(.el-date-editor),
.config-section :deep(.el-select) {
  width: 100%;
}

.form-grid,
.ratio-grid,
.keyword-strategy-grid {
  display: grid;
  gap: 0 16px;
}

.form-grid-4 {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.form-grid-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.form-grid-2,
.keyword-strategy-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.keyword-strategy-grid {
  grid-template-columns: minmax(360px, 0.85fr) minmax(520px, 1.15fr);
  gap: 16px;
  margin-bottom: 16px;
}

.compact-fields {
  max-width: 760px;
}

.planning-rule-grid {
  grid-template-columns: minmax(300px, 420px) minmax(180px, 220px);
}

.compact-number-grid {
  grid-template-columns: repeat(2, minmax(220px, 360px));
}

.fixed-setting-row {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 10px 14px;
  margin-bottom: 16px;
  background: #f7f9fc;
  border-radius: 7px;
}

.fixed-setting-row > div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fixed-setting-row span {
  color: #8a94a5;
  font-size: 12px;
}

.fixed-setting-row strong {
  color: #3f4b60;
  font-size: 13px;
  font-weight: 600;
}

.fixed-setting-row .el-tag {
  margin-left: auto;
}

.fixed-setting-row-3 > div {
  flex: 1;
}

.crowd-form-item :deep(.el-form-item__content) {
  display: block;
}

.crowd-setting-panel {
  width: 100%;
  padding: 14px;
  box-sizing: border-box;
  background: #f8faff;
  border: 1px solid #e3e9f6;
  border-radius: 8px;
}

.crowd-setting-header,
.crowd-setting-actions,
.crowd-option-row {
  display: flex;
  align-items: center;
}

.crowd-setting-header {
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.crowd-setting-header > div {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.crowd-setting-header .crowd-header-actions {
  align-items: center;
  flex-direction: row;
  flex-shrink: 0;
  gap: 8px;
}

.crowd-header-actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.crowd-setting-header strong {
  color: #344054;
  font-size: 14px;
}

.crowd-setting-header small,
.crowd-setting-actions span {
  color: #8a94a5;
  font-size: 12px;
}

.default-crowd-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.crowd-option-row {
  min-height: 42px;
  gap: 10px;
  padding: 0 10px;
  background: #fff;
  border: 1px solid #e8ecf4;
  border-radius: 6px;
}

.crowd-option-row :deep(.el-checkbox) {
  min-width: 150px;
}

.crowd-option-row :deep(.el-input-number) {
  width: 120px;
}

.crowd-reach {
  flex: 1;
  color: #8a94a5;
  font-size: 12px;
}

.crowd-percent {
  color: #667085;
  font-size: 13px;
}

.crowd-setting-actions {
  justify-content: flex-start;
  gap: 12px;
  margin-top: 8px;
}

.crowd-empty-hint {
  padding: 9px 12px;
  color: #8a94a5;
  background: #fff;
  border: 1px dashed #dfe5ef;
  border-radius: 6px;
  font-size: 12px;
  line-height: 20px;
}

:global(.crowd-dialog-toolbar) {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 220px auto;
  gap: 10px;
  margin-bottom: 14px;
}

:global(.crowd-dialog-count) {
  float: left;
  color: #667085;
  font-size: 13px;
  line-height: 32px;
}

.strategy-box {
  min-width: 0;
  padding: 14px 16px;
  background: #f8fafc;
  border: 1px solid #e6eaf1;
  border-radius: 8px;
}

.strategy-box-title {
  margin-bottom: 12px;
  color: #4f5b6e;
  font-size: 13px;
  font-weight: 600;
}

.required-title::before {
  margin-right: 4px;
  color: #f56c6c;
  content: '*';
}

.bid-base-row,
.bid-increment-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  align-items: center;
  min-height: 34px;
  color: #687386;
  font-size: 12px;
}

.keyword-bid-mode-row {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  color: #687386;
  font-size: 12px;
}

.keyword-bid-mode-row :deep(.el-radio-group) {
  flex-wrap: nowrap;
  gap: 18px;
}

.keyword-bid-mode-row :deep(.el-radio) {
  height: 24px;
  margin-right: 0;
}

.keyword-bid-mode-row :deep(.el-radio__label) {
  padding-left: 6px;
  font-size: 12px;
}

.bid-base-row strong {
  color: #344157;
  font-size: 13px;
  font-weight: 500;
}

.bid-increment-row {
  grid-template-columns: 72px minmax(130px, 190px) auto;
  gap: 8px;
  margin-top: 8px;
}

.fixed-keyword-bid-item {
  margin-top: 10px;
  margin-bottom: 0 !important;
}

.fixed-keyword-bid-item :deep(.el-form-item__content) {
  display: grid;
  grid-template-columns: minmax(130px, 190px) auto;
  gap: 8px;
}

.fixed-keyword-bid-item .field-help {
  grid-column: 1 / -1;
}

.keyword-match-type-item {
  margin-top: 12px;
  margin-bottom: 0 !important;
}

.keyword-match-type-item :deep(.el-radio-group) {
  flex-wrap: nowrap;
  gap: 12px;
}

.keyword-match-type-item :deep(.el-radio) {
  margin-right: 0;
}

.field-help {
  margin-top: 5px;
  color: #929baa;
  font-size: 12px;
  line-height: 18px;
}

.allocation-result {
  padding: 11px 14px;
  margin: -2px 0 16px;
  color: #606b7d;
  background: #eef4ff;
  border-radius: 6px;
  font-size: 12px;
  line-height: 20px;
}

.allocation-result strong {
  color: #2b5aed;
}

.keyword-source-form-item {
  margin-bottom: 0 !important;
}

.keyword-source-form-item :deep(.el-form-item__content) {
  display: block;
}

.keyword-source-row {
  display: flex;
  align-items: flex-start;
  min-height: 34px;
}

.keyword-select-all {
  flex-shrink: 0;
  padding-right: 16px;
  margin-right: 16px;
  border-right: 1px solid #dfe4ec;
}

.keyword-source-group {
  display: grid;
  grid-template-columns: repeat(4, minmax(90px, 1fr));
  gap: 6px 14px;
  width: 100%;
}

.keyword-source-group .el-checkbox {
  margin-right: 0;
}

.keyword-source-box > .field-help {
  padding-top: 9px;
  margin-top: 9px;
  border-top: 1px dashed #dfe4ec;
}

.compact-control {
  max-width: 520px;
}

.compact-control :deep(.el-form-item__content) {
  display: block;
}

.custom-control-grid {
  align-items: start;
  grid-template-columns: minmax(190px, 1fr) minmax(240px, 1.2fr) minmax(170px, 0.8fr) minmax(170px, 0.8fr);
  gap: 0 18px;
}

.custom-control-grid :deep(.el-form-item__content) {
  align-content: flex-start;
}

.compact-number-control,
.config-section :deep(.compact-number-control.el-input-number) {
  width: min(100%, 200px);
}

.compact-number-item :deep(.el-form-item__content) {
  display: block;
}

.compact-number-with-unit-item :deep(.el-form-item__content) {
  display: grid;
  grid-template-columns: minmax(140px, 200px) auto;
  align-items: center;
  justify-content: start;
  column-gap: 6px;
}

.compact-number-with-unit-item .field-help {
  grid-column: 1 / -1;
}

.compact-number-with-unit-item .unit-suffix {
  margin-left: 0;
}

.switch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #596579;
  font-size: 13px;
}

.subsection-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 14px;
  margin: 2px 0 14px;
  border-top: 1px solid #edf0f5;
  color: #4f5b6e;
  font-size: 13px;
  font-weight: 600;
}

.subsection-heading em {
  color: #7d8797;
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
}

.subsection-heading em.invalid {
  color: #f56c6c;
}

.ratio-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.roi-radio-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  width: 100%;
}

.roi-radio-grid .el-radio {
  height: auto;
  min-height: 36px;
  padding: 8px 10px;
  margin-right: 0;
  background: #f8fafc;
  border: 1px solid #e5e9f2;
  border-radius: 7px;
}

.block-control {
  margin-top: 10px;
}

.area-selector {
  min-height: 150px;
  max-height: 320px;
  padding: 10px 12px;
  overflow: auto;
  background: #fff;
  border: 1px solid #dfe4ec;
  border-radius: 6px;
}

.unit-suffix {
  margin-left: 6px;
  color: #7d8797;
}

.config-summary-card {
  position: sticky;
  top: 0;
  padding: 18px;
}

.summary-title {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding-bottom: 15px;
  border-bottom: 1px solid #edf0f5;
}

.summary-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 16px 0;
}

.summary-metrics > div {
  padding: 12px;
  text-align: center;
  background: #f5f8ff;
  border-radius: 8px;
}

.summary-metrics span,
.summary-metrics strong {
  display: block;
}

.summary-metrics span {
  margin-bottom: 4px;
  color: #8a94a5;
  font-size: 12px;
}

.summary-metrics strong {
  color: #2b5aed;
  font-size: 22px;
}

.summary-list {
  margin-bottom: 16px;
  border-top: 1px solid #edf0f5;
}

.summary-list > div {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid #edf0f5;
  font-size: 12px;
}

.summary-list span {
  flex-shrink: 0;
  color: #8a94a5;
}

.summary-list strong {
  color: #4b5669;
  text-align: right;
  font-weight: 500;
  word-break: break-all;
}

.preview-metrics {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.preview-metrics div {
  padding: 16px;
  text-align: center;
  background: #f7f9fc;
  border-radius: 8px;
}

.preview-metrics span,
.preview-metrics strong {
  display: block;
}

.preview-metrics span {
  margin-bottom: 6px;
  color: #8790a1;
}

.preview-metrics strong {
  font-size: 25px;
  color: #2b5aed;
}

.limit-warning {
  margin-bottom: 14px;
}

.preview-config-summary {
  margin-bottom: 14px;
}

.submit-placeholder {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 16px;
}

.creation-progress-mask {
  position: absolute;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(16, 24, 40, 0.58);
}

.creation-progress-card {
  width: min(460px, calc(100vw - 48px));
  padding: 30px 34px 26px;
  color: #344054;
  text-align: center;
  background: #fff;
  border: 1px solid rgba(43, 90, 237, 0.18);
  border-radius: 14px;
  box-shadow: 0 18px 50px rgba(16, 24, 40, 0.24);
}

.creation-progress-spinner {
  display: block;
  width: 38px;
  height: 38px;
  margin: 0 auto 16px;
  border: 3px solid #dce5ff;
  border-top-color: #2b5aed;
  border-radius: 50%;
  animation: creation-progress-spin 0.8s linear infinite;
}

.creation-progress-card strong {
  display: block;
  color: #1d2939;
  font-size: 18px;
}

.creation-progress-card p {
  min-height: 22px;
  margin: 10px 0 18px;
  color: #667085;
  font-size: 14px;
  line-height: 22px;
}

.creation-progress-bar {
  margin-bottom: 8px;
}

.creation-progress-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  color: #2b5aed;
  font-size: 12px;
}

.creation-progress-card small {
  color: #98a2b3;
  font-size: 12px;
}

@keyframes creation-progress-spin {
  to { transform: rotate(360deg); }
}

.step-actions {
  display: flex;
  justify-content: center;
  gap: 12px;
  padding-top: 14px;
}

.coming-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100px;
  height: 100px;
  margin: 0 auto;
  color: #9da6b5;
  background: #edf0f5;
  border-radius: 50%;
}

:global(.jd-express-delete-message-box) {
  width: 480px;
  padding: 0;
  border-radius: 10px;
}

:global(.jd-express-delete-message-box .el-message-box__header) {
  padding: 22px 26px 12px;
}

:global(.jd-express-delete-message-box .el-message-box__content) {
  padding: 14px 26px 24px;
}

:global(.jd-express-delete-message-box .el-message-box__container) {
  align-items: flex-start;
  gap: 14px;
}

:global(.jd-express-delete-message-box .el-message-box__message) {
  padding-left: 0;
  line-height: 1.8;
}

:global(.jd-express-delete-message-box .el-message-box__btns) {
  padding: 0 26px 22px;
}

@media (max-width: 1200px) {
  .page-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .tool-tabs {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .config-workspace {
    grid-template-columns: 1fr;
  }

  .config-summary-card {
    position: static;
  }

  .summary-metrics {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

@media (max-width: 1500px) {
  .form-grid-4,
  .ratio-grid,
  .roi-radio-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .keyword-source-group {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .custom-control-grid {
    grid-template-columns: repeat(2, minmax(240px, 1fr));
  }
}

@media (max-width: 820px) {
  .workflow-copy small {
    display: none;
  }

  .pagination-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .form-grid-4,
  .form-grid-3,
  .form-grid-2,
  .planning-rule-grid,
  .compact-number-grid,
  .custom-control-grid,
  .ratio-grid,
  .keyword-strategy-grid,
  .roi-radio-grid {
    grid-template-columns: 1fr;
  }

  .fixed-setting-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .fixed-setting-row .el-tag {
    margin-left: 0;
  }

  .crowd-setting-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .summary-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
