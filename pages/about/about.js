const CFG = require('../../utils/config')

Page({
  data: {
    version: CFG.version,
    beian: CFG.beian,
    appName: CFG.appName
  },

  onLoad() {
    this.setData({
      version: CFG.version,
      beian: CFG.beian,
      appName: CFG.appName
    })
  },

  onShareAppMessage() {
    return {
      title: CFG.shareTitle,
      path: '/pages/index/index'
    }
  }
})
