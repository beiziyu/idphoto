App({
  globalData: {
    // 首页选中的照片临时路径（不落盘、不上传，仅在本机内存/临时目录流转）
    srcPath: '',
    // 结果页要展示的信息
    result: null
  },

  onLaunch() {
    // 云开发：开通后才会走这里。没开通时 wx.cloud 是 undefined，跳过即可。
    // 服务端人像分割就绪后，把 utils/segment.js 的 MODE 改成 'remote'。
    try {
      if (wx.cloud) wx.cloud.init({ traceUser: false })
    } catch (e) {
      console.warn('[app] cloud init skipped', e)
    }

    // 基础库 2.20.1 以下没有 getWindowInfo，做一次兜底
    try {
      const info = wx.getWindowInfo
        ? wx.getWindowInfo()
        : wx.getSystemInfoSync()
      this.globalData.safeBottom = info.screenHeight - info.safeArea.bottom
    } catch (e) {
      this.globalData.safeBottom = 0
    }
  }
})
