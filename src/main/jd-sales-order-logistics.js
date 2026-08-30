function firstNonEmptyText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text) return text
  }
  return ''
}

function extractJdSalesOrderLogistics(raw = {}) {
  const latestTrackInfo = raw.orderLatestTrackInfo || {}
  const logisticsInfo = raw.logistics || raw.orderLogisticsInfo || {}
  const logisticsList = Array.isArray(raw.logisticsInfoList) ? raw.logisticsInfoList : []
  const firstLogistics = logisticsList[0] || {}
  const extInfo = raw.extendInfo || {}

  return {
    logisticsCompany: firstNonEmptyText(
      raw.logisticsCompany,
      latestTrackInfo.logiCoprName,
      latestTrackInfo.logisticsCompany,
      latestTrackInfo.companyName,
      firstLogistics.carrier,
      firstLogistics.expressCompany,
      firstLogistics.logisticsCompany,
      firstLogistics.logiCoprName,
      logisticsInfo.expressCompany,
      logisticsInfo.logisticsCompany,
      logisticsInfo.companyName,
      extInfo.expressCompany,
      extInfo.logisticsCompany
    ),
    logisticsNo: firstNonEmptyText(
      raw.logisticsNo,
      raw.waybillCode,
      latestTrackInfo.waybillCode,
      latestTrackInfo.logisticsNo,
      latestTrackInfo.mailNo,
      firstLogistics.carriageId,
      firstLogistics.mailNo,
      firstLogistics.waybillCode,
      logisticsInfo.mailNo,
      logisticsInfo.logisticsNo,
      logisticsInfo.waybillCode,
      extInfo.mailNo,
      extInfo.logisticsNo
    )
  }
}

module.exports = { extractJdSalesOrderLogistics }
