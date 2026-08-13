const express = require('express')
const {
  assertExactKeys,
  authenticateAccessToken,
  enrollExecutor,
  issueExecutorToken
} = require('../services/cloud-warehouse-executor-auth-service')
const {
  claimTask,
  normalizeMappingPayload,
  recordHeartbeat,
  recordTaskResult,
  renewLease,
  reportExecuting
} = require('../services/cloud-warehouse-executor-service')
const { resolveTrustedOrderMapping } = require('../services/cloud-warehouse-order-service')

const RETRYABLE_ERRORS = new Set(['rate_limited'])
const REVIEW_ERRORS = new Set([
  'machine_binding_changed',
  'executor_instance_conflict',
  'task_expired',
  'lease_mismatch',
  'lease_expired',
  'fencing_token_stale',
  'order_mapping_forbidden',
  'order_locator_changed',
  'result_conflict',
  'business_state_unconfirmed',
  'unexpected_business_state'
])

function statusForError(error) {
  if (!error?.code) return 500
  if (['unauthorized_executor', 'credential_revoked'].includes(error?.code)) return 401
  if (['machine_code_mismatch', 'order_mapping_forbidden'].includes(error?.code)) return 403
  if (['task_not_found'].includes(error?.code)) return 404
  if (['executor_instance_conflict', 'result_conflict', 'lease_mismatch', 'fencing_token_stale', 'device_locked'].includes(error?.code)) return 409
  if (['task_expired', 'lease_expired'].includes(error?.code)) return 410
  if (error?.code === 'rate_limited') return 429
  return 400
}

function executorError(res, error) {
  const code = error?.code || 'invalid_request'
  if (!error?.code) console.error('[CloudWarehouseExecutor] 未处理异常:', error?.message || error)
  return res.status(statusForError(error)).json({
    error: {
      code,
      message: error?.code ? String(error.message || '请求无效').slice(0, 500) : '执行器服务异常',
      retryable: RETRYABLE_ERRORS.has(code),
      review_required: REVIEW_ERRORS.has(code)
    }
  })
}

function isLoopbackRequest(req) {
  const address = String(req.ip || req.socket?.remoteAddress || '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function requireHttps(req, res, next) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  const loopback = isLoopbackRequest(req)
  // 仅信任同机反向代理提供的 X-Forwarded-Proto，避免公网直连伪造该请求头绕过 HTTPS。
  if (req.secure || (forwardedProto === 'https' && loopback) || (process.env.NODE_ENV !== 'production' && loopback)) {
    return next()
  }
  return res.status(426).json({
    error: {
      code: 'https_required',
      message: '云仓助手执行器接口只允许通过 HTTPS 访问',
      retryable: false,
      review_required: false
    }
  })
}

function readBearerToken(req) {
  const authorization = String(req.headers.authorization || '')
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : ''
}

module.exports = function createCloudWarehouseExecutorRouter(pool) {
  const router = express.Router()
  router.use(requireHttps)

  router.post('/enroll', async (req, res) => {
    try {
      res.json(await enrollExecutor(pool, req.body || {}))
    } catch (error) {
      executorError(res, error)
    }
  })

  router.post('/token', async (req, res) => {
    try {
      res.json(await issueExecutorToken(pool, req.body || {}))
    } catch (error) {
      executorError(res, error)
    }
  })

  router.use(async (req, res, next) => {
    const token = readBearerToken(req)
    if (!token) {
      return executorError(res, Object.assign(new Error('缺少执行器 Bearer Token'), {
        code: 'unauthorized_executor'
      }))
    }
    try {
      req.executorAuth = await authenticateAccessToken(pool, token)
      next()
    } catch (error) {
      executorError(res, error)
    }
  })

  router.post('/heartbeat', async (req, res) => {
    try {
      res.json(await recordHeartbeat(pool, req.executorAuth, req.body || {}))
    } catch (error) {
      executorError(res, error)
    }
  })

  router.post('/tasks/claim', async (req, res) => {
    try {
      res.json(await claimTask(pool, req.executorAuth, req.body || {}))
    } catch (error) {
      executorError(res, error)
    }
  })

  router.post('/tasks/:taskId/status', async (req, res) => {
    try {
      res.json(await reportExecuting(pool, req.executorAuth, req.params.taskId, req.body || {}))
    } catch (error) {
      executorError(res, error)
    }
  })

  router.post('/tasks/:taskId/lease/renew', async (req, res) => {
    try {
      res.json(await renewLease(pool, req.executorAuth, req.params.taskId, req.body || {}))
    } catch (error) {
      executorError(res, error)
    }
  })

  router.post('/tasks/:taskId/order-mapping', async (req, res) => {
    try {
      const mapping = normalizeMappingPayload(req.body || {}, req.executorAuth)
      res.json(await resolveTrustedOrderMapping(pool, {
        taskId: req.params.taskId,
        orderRefId: mapping.orderRefId,
        machineCode: mapping.machineCode,
        executorInstanceId: mapping.executorInstanceId,
        leaseId: mapping.leaseId,
        fencingToken: mapping.fencingToken
      }))
    } catch (error) {
      executorError(res, error)
    }
  })

  router.post('/tasks/:taskId/result', async (req, res) => {
    try {
      res.json(await recordTaskResult(pool, req.executorAuth, req.params.taskId, req.body || {}))
    } catch (error) {
      executorError(res, error)
    }
  })

  return router
}

module.exports.executorError = executorError
module.exports.requireHttps = requireHttps
module.exports.statusForError = statusForError
