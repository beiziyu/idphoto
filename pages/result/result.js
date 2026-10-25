const { toast } = require('../../utils/util')
const { AD } = require('../../utils/ad')
const CFG = require('../../utils/config')

Page({
  data: {
    path: '',
    name: '',
    mmText: '',
    pxText: '',
    saved: false,
    adEnabled: AD.enabled
  },

  onLoad() {
    const r = getApp().globalData.result
    if (!r || !r.path) {
      wx.reLaunch({ url: '/pages/index/index' })
      return
    }
    this.setData({
      path: r.path,
      name: r.name,
      mmText: r.mmText,
      pxText: r.pxText,
      saved: !!r.saved
    })
  },

  saveAgain() {
    const path = this.data.path
    if (!path) return
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => {
        this.setData({ saved: true })
        wx.showToast({ title: '已存入相册', icon: 'success' })
      },
      fail: err => {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('auth') > -1 || msg.indexOf('deny') > -1 || msg.indexOf('permission') > -1) {
          wx.showModal({
            title: '需要相册权限',
            content: '保存证件照需要「添加到相册」的权限，点「去设置」把它打开就好。',
            confirmText: '去设置',
            cancelText: '稍后',
            success: r => {
              if (r.confirm) wx.openSetting({})
            }
          })
        } else if (msg.indexOf('cancel') === -1) {
          toast('保存失败，可以再点一次')
        }
      }
    })
  },

  back() {
    wx.navigateBack()
  },

  /** 排版打印：把这张照片按 6 寸相纸排成多张，方便冲印 */
  openSheet() {
    const r = getApp().globalData.result
    if (!r || !r.path) {
      toast('还没有成品，先返回重新生成')
      return
    }
    getApp().globalData.sheet = {
      path: r.path,
      pxW: r.pxW,
      pxH: r.pxH,
      pxText: r.pxText,
      sizeName: r.name
    }
    wx.navigateTo({ url: '/pages/sheet/sheet' })
  },

  home() {
    getApp().globalData.srcPath = ''
    wx.reLaunch({ url: '/pages/index/index' })
  },

  onShareAppMessage() {
    return {
      title: CFG.shareTitle,
      path: '/pages/index/index'
    }
  }
})
