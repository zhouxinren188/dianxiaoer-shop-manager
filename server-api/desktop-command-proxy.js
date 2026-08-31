const express = require('express')
const http = require('http')
const rateLimit = require('express-rate-limit')

const MAX_REQUEST_BYTES = 64 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const UPSTREAM_TIMEOUT_MS = 12_000

const ALLOWED_ROUTES = Object.freeze([
  ['GET', /^\/api\/desktop-channel\/devices$/],
  ['POST', /^\/api\/desktop-channel\/tasks$/],
  ['GET', /^\/api\/desktop-channel\/tasks\/[a-zA-Z0-9_-]{8,120}$/],
  ['POST', /^\/api\/desktop-channel\/heartbeat$/],
  ['POST', /^\/api\/desktop-channel\/tasks\/claim$/],
  ['POST', /^\/api\/desktop-channel\/tasks\/[a-zA-Z0-9_-]{8,120}\/status$/],
  ['POST', /^\/api\/desktop-channel\/tasks\/[a-zA-Z0-9_-]{8,120}\/lease\/renew$/],
  ['POST', /^\/api\/desktop-channel\/tasks\/[a-zA-Z0-9_-]{8,120}\/result$/]
])

function isAllowedRequest(method, pathname) {
  return ALLOWED_ROUTES.some(([allowedMethod, pattern]) => (
    method === allowedMethod && pattern.test(pathname)
  ))
}

function requireHttps(req, res, next) {
  if (req.secure || req.socket?.encrypted) return next()
  return res.status(426).json({
    code: 1,
    message: 'The desktop command channel requires HTTPS',
    error_code: 'https_required'
  })
}

function createProxyHandler({ upstreamHost = '127.0.0.1', upstreamPort = 3002 } = {}) {
  if (upstreamHost !== '127.0.0.1' || Number(upstreamPort) !== 3002) {
    throw new Error('Desktop command proxy upstream is fixed to loopback port 3002')
  }

  return function proxyDesktopCommand(req, res) {
    const pathname = req.originalUrl.split('?')[0]
    if (!isAllowedRequest(req.method, pathname)) {
      return res.status(404).json({
        code: 1,
        message: 'Desktop command channel route not found',
        error_code: 'route_not_allowed'
      })
    }

    const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method)
    const payload = hasBody ? Buffer.from(JSON.stringify(req.body || {}), 'utf8') : null
    if (payload && payload.length > MAX_REQUEST_BYTES) {
      return res.status(413).json({
        code: 1,
        message: 'Desktop command channel request is too large',
        error_code: 'request_too_large'
      })
    }

    const upstream = http.request({
      hostname: upstreamHost,
      port: upstreamPort,
      method: req.method,
      path: req.originalUrl,
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: {
        Authorization: req.headers.authorization,
        Accept: 'application/json',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': String(payload.length)
        } : {})
      }
    }, upstreamResponse => {
      const chunks = []
      let size = 0
      upstreamResponse.on('data', chunk => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          upstream.destroy(new Error('Desktop command upstream response is too large'))
          return
        }
        chunks.push(chunk)
      })
      upstreamResponse.on('end', () => {
        if (res.headersSent) return
        res.status(Number(upstreamResponse.statusCode || 502))
        res.type('application/json').send(Buffer.concat(chunks))
      })
    })

    upstream.on('timeout', () => upstream.destroy(new Error('Desktop command upstream timed out')))
    upstream.on('error', error => {
      console.warn('[DesktopCommandProxy] upstream unavailable:', error.message)
      if (!res.headersSent) {
        res.status(502).json({
          code: 1,
          message: 'Desktop command channel business service is unavailable',
          error_code: 'upstream_unavailable'
        })
      }
    })
    if (payload) upstream.write(payload)
    upstream.end()
  }
}

function createDesktopCommandProxy({ authMiddleware } = {}) {
  if (typeof authMiddleware !== 'function') {
    throw new TypeError('authMiddleware is required')
  }
  const router = express.Router()
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 240,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      code: 1,
      message: 'Desktop command channel rate limit exceeded',
      error_code: 'rate_limited'
    }
  })
  router.use(requireHttps, limiter, authMiddleware, createProxyHandler())
  return router
}

module.exports = createDesktopCommandProxy
module.exports.ALLOWED_ROUTES = ALLOWED_ROUTES
module.exports.createProxyHandler = createProxyHandler
module.exports.isAllowedRequest = isAllowedRequest
module.exports.requireHttps = requireHttps
