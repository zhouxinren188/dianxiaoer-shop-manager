const express = require('express')
const {
  claimTask,
  createTask,
  getTask,
  listDevices,
  recordHeartbeat,
  recordTaskResult,
  renewLease,
  updateTaskStatus
} = require('../services/desktop-command-channel-service')

function statusForError(error) {
  if (!error?.code) return 500
  if (error.code === 'desktop_device_required') return 403
  if (error.code === 'task_not_found') return 404
  if (['idempotency_conflict', 'task_claim_conflict', 'result_conflict'].includes(error.code)) return 409
  if (error.code === 'lease_invalid') return 410
  if (error.code === 'command_not_allowed') return 403
  return 400
}

function channelError(res, error) {
  if (!error?.code) console.error('[DesktopChannel] Unhandled error:', error?.message || error)
  return res.status(statusForError(error)).json({
    code: 1,
    message: error?.code ? String(error.message || 'Invalid desktop channel request').slice(0, 500) : 'Desktop channel service error',
    error_code: error?.code || 'internal_error'
  })
}

function requireDesktopDevice(req, res, next) {
  if (req.authDevice !== 'desktop') {
    return channelError(res, Object.assign(new Error('Only a desktop login may execute desktop tasks'), {
      code: 'desktop_device_required'
    }))
  }
  next()
}

function authFromRequest(req) {
  return { userId: Number(req.user?.id || req.user?.user_id) }
}

module.exports = function createDesktopCommandChannelRouter(pool) {
  const router = express.Router()

  router.get('/devices', async (req, res) => {
    try {
      res.json({ code: 0, data: { devices: await listDevices(pool, authFromRequest(req)) } })
    } catch (error) {
      channelError(res, error)
    }
  })

  router.post('/tasks', async (req, res) => {
    try {
      const task = await createTask(pool, authFromRequest(req), req.body || {})
      res.status(202).json({ code: 0, data: { task } })
    } catch (error) {
      channelError(res, error)
    }
  })

  router.get('/tasks/:taskId', async (req, res) => {
    try {
      res.json({ code: 0, data: { task: await getTask(pool, authFromRequest(req), req.params.taskId) } })
    } catch (error) {
      channelError(res, error)
    }
  })

  router.post('/heartbeat', requireDesktopDevice, async (req, res) => {
    try {
      res.json({ code: 0, data: await recordHeartbeat(pool, authFromRequest(req), req.body || {}) })
    } catch (error) {
      channelError(res, error)
    }
  })

  router.post('/tasks/claim', requireDesktopDevice, async (req, res) => {
    try {
      res.json({ code: 0, data: await claimTask(pool, authFromRequest(req), req.body || {}) })
    } catch (error) {
      channelError(res, error)
    }
  })

  router.post('/tasks/:taskId/status', requireDesktopDevice, async (req, res) => {
    try {
      res.json({ code: 0, data: await updateTaskStatus(pool, authFromRequest(req), req.params.taskId, req.body || {}) })
    } catch (error) {
      channelError(res, error)
    }
  })

  router.post('/tasks/:taskId/lease/renew', requireDesktopDevice, async (req, res) => {
    try {
      res.json({ code: 0, data: await renewLease(pool, authFromRequest(req), req.params.taskId, req.body || {}) })
    } catch (error) {
      channelError(res, error)
    }
  })

  router.post('/tasks/:taskId/result', requireDesktopDevice, async (req, res) => {
    try {
      res.json({ code: 0, data: await recordTaskResult(pool, authFromRequest(req), req.params.taskId, req.body || {}) })
    } catch (error) {
      channelError(res, error)
    }
  })

  return router
}

module.exports.channelError = channelError
module.exports.requireDesktopDevice = requireDesktopDevice
module.exports.statusForError = statusForError
