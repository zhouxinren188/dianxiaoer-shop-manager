function getBackendRecoveryDisposition(recovered, webContentsDestroyed) {
  if (recovered === false) {
    return {
      succeeded: false,
      reportOnline: false,
      reloadOriginalUrl: false,
      action: 'report_offline'
    }
  }

  return {
    succeeded: true,
    reportOnline: recovered === true,
    reloadOriginalUrl: !webContentsDestroyed,
    action: webContentsDestroyed ? 'skip_reload_window_closed' : 'reload_original_url'
  }
}

module.exports = {
  getBackendRecoveryDisposition
}
