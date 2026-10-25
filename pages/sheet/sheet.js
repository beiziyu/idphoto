const { winInfo, toast } = require('../../utils/util')

// 6 寸相纸：152 × 102 mm，按 300dpi 输出
const SW = Math.round((152 / 25.4) * 300)
const SH = Math.round((102 / 25.4) * 300)
const MARGIN = Math.round((6 / 25.4) * 300) // 四周留白 6mm，打印机不一定能印到边
const GAP = Math.round((4 / 25.4) * 300) // 张与张之间 4mm，方便下剪刀

Page({
  data: {
    cw: 0,
    ch: 0,
    count: 0,
    pxText: '',
    sizeName: '',
    loading: true
  },

  onLoad() {
    const job = getApp().globalData.sheet
    if (!job || !job.path) {
      wx.navigateBack()
      return
    }
    this.job = job

    const info = winInfo()
    const maxW = info.windowWidth - 64
    const cw = maxW
    const ch = Math.round(cw * (SH / SW))
    this.setData({ cw, ch })

    this.init()
  },

  init() {
    wx.createSelectorQuery()
      .in(this)
      .select('#cv')
      .fields({ node: true })
      .exec(res => {
        if (!res || !res[0] || !res[0].node) {
          this.setData({ loading: false })
          toast('画布初始化失败')
          return
        }
        const cv = res[0].node
        this.canvas = cv
        cv.width = SW
        cv.height = SH
        this.ctx = cv.getContext('2d')
        this.compose()
      })
  },

  compose() {
    const job = this.job
    const pw = job.pxW
    const ph = job.pxH
    const usableW = SW - MARGIN * 2
    const usableH = SH - MARGIN * 2
    const cols = Math.max(1, Math.floor((usableW + GAP) / (pw + GAP)))
    const rows = Math.max(1, Math.floor((usableH + GAP) / (ph + GAP)))

    const ctx = this.ctx
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, SW, SH)

    const img = this.canvas.createImage()
    img.onload = () => {
      const totalW = cols * pw + (cols - 1) * GAP
      const totalH = rows * ph + (rows - 1) * GAP
      const ox = Math.round((SW - totalW) / 2)
      const oy = Math.round((SH - totalH) / 2)

      // 裁切参考线：浅灰细线，冲印后能看见，方便下剪刀
      ctx.strokeStyle = '#D8DDE6'
      ctx.lineWidth = 1

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = ox + c * (pw + GAP)
          const y = oy + r * (ph + GAP)
          ctx.drawImage(img, x, y, pw, ph)
          ctx.strokeRect(x + 0.5, y + 0.5, pw - 1, ph - 1)
        }
      }

      this.setData({
        count: cols * rows,
        pxText: job.pxText,
        sizeName: job.sizeName,
        loading: false
      })
    }
    img.onerror = () => {
      this.setData({ loading: false })
      toast('排版失败，请返回重试')
    }
    img.src = job.path
  },

  save() {
    if (!this.ctx) {
      toast('还没排好，稍等一下')
      return
    }
    wx.showLoading({ title: '生成中', mask: true })
    wx.canvasToTempFilePath(
      {
        canvas: this.canvas,
        x: 0,
        y: 0,
        width: SW,
        height: SH,
        destWidth: SW,
        destHeight: SH,
        fileType: 'jpg',
        quality: 0.95,
        success: res => {
          wx.hideLoading()
          wx.saveImageToPhotosAlbum({
            filePath: res.tempFilePath,
            success: () => {
              wx.showToast({ title: '已存入相册', icon: 'success' })
            },
            fail: err => {
              const msg = (err && err.errMsg) || ''
              if (msg.indexOf('auth') > -1 || msg.indexOf('deny') > -1) {
                wx.showModal({
                  title: '需要相册权限',
                  content: '保存排版图需要「添加到相册」权限。',
                  confirmText: '去设置',
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
        fail: () => {
          wx.hideLoading()
          toast('生成失败，请重试')
        }
      },
      this
    )
  }
})
