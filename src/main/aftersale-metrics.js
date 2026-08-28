// 京东 findHomeDisplay API 中各指标的 ID 映射。
// 未映射的指标仍会随完整 raw_data 保存到业务服务器，供后续首页扩展使用。
const JD_METRIC_MAP = Object.freeze({
  // 订单类 (category id: 101)
  1006: 'overdue_orders',                 // 发货超时
  1003: 'pending_follow_ups',             // 待回复催单
  1011: 'pending_logistics_exceptions',   // 物流异常
  1012: 'pending_consumer_invoices',      // 消费者发票
  // 售后类 (category id: 102)
  3001: 'cancelled_orders',               // 取消订单
  3002: 'pending_review_aftersales',      // 待审核售后
  3003: 'pending_receive_aftersales',     // 待收货售后
  3004: 'pending_process_aftersales',     // 待处理售后
  3007: 'pending_task_orders',            // 任务工单
  // 纠纷类 (category id: 103)
  4001: 'pending_reply_disputes',         // 待回复纠纷
  4002: 'pending_evidence_disputes',      // 待举证纠纷
  4003: 'pending_execute_disputes',       // 待执行纠纷
  4005: 'pending_compensation',           // 待处理赔付
  // 合规类 (category id: 106)
  7010: 'pending_warnings',               // 待处理预警单
  7004: 'pending_violations',             // 待处理违约单
  7011: 'pending_industry_complaints'     // 待处理工商投诉
})

function extractMetrics(apiResponse) {
  const schedules = apiResponse?.data?.realSchedules || []
  const metrics = {}

  for (const category of schedules) {
    for (const item of category.data || []) {
      const field = JD_METRIC_MAP[item.id]
      if (!field) continue
      const value = Number.parseInt(item.value || '0', 10)
      metrics[field] = Number.isFinite(value) ? value : 0
    }
  }

  return metrics
}

module.exports = {
  JD_METRIC_MAP,
  extractMetrics
}
