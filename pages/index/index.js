const { HOT, GROUPS, findSize, buildCustomSize } = require('../../utils/sizes')
const SEG = require('../../utils/segment')
const { winInfo, toast } = require('../../utils/util')
const CFG = require('../../utils/config')

Page({
  data: {
    safeTop: 20,
    hot: [],
    docItems: [],
    visaItems: [],
    examItems: [],
    cur: 'one',
    curName: '一寸',
    customOpen: false,
    customW: '',
    customH: '',
    customUnit: 'mm',
    customHint: '填毫米按 300dpi 转成像素；填像素就按原样输出',
    customLabel: '宽高自己填，适合有特殊要求的场景',
    demoBgs: ['#FFFFFF', '#438EDB', '#FF0000']
  },

  onLoad() {
    // 预热请求会在部分环境触发渲染层 _getData 崩溃（打开就放大/画布异常），
    // 先关掉。云函数冷启动已被内存 1GB + keepwarm 定时触发器覆盖，不依赖这里。
    const info = winInfo()
    const hot = HOT.map(s => ({
      id: s.id,
      name: s.name,
      tag: s.tag || '',
      mmText: s.mmText,
      use: s.use
    }))
    const pick = g =>
      g.items.map(s => ({
        id: s.id,
        name: s.name,
        size: s.isPixel ? s.pxW + '×' + s.pxH : s.wmm + '×' + s.hmm
      }))

    this.setData({
      safeTop: info.statusBarHeight || 20,
      hot,
      docItems: pick(GROUPS[0]),
      visaItems: pick(GROUPS[1]),
      examItems: pick(GROUPS[2])
    })
  },

  pick(e) {
    const id = e.currentTarget.dataset.id
    const size = findSize(id)
    this.setData({ cur: id, curName: size.name })
  },

  /* ---------- 自定义尺寸 ---------- */
  openCustom() {
    this.setData({ customOpen: true })
  },

  closeCustom() {
    this.setData({ customOpen: false })
  },

  noop() {},

  pickUnit(e) {
    this.setData({ customUnit: e.currentTarget.dataset.u })
  },

  onCustomInput(e) {
    const k = e.currentTarget.dataset.k
    this.setData({ [k]: e.detail.value })
  },

  confirmCustom() {
    const w = Number(this.data.customW)
    const h = Number(this.data.customH)
    if (!w || !h || w <= 0 || h <= 0) {
      toast('宽和高都要填')
      return
    }
    const size = buildCustomSize(w, h, this.data.customUnit)
    if (size.pxW < 60 || size.pxH < 60) {
      toast('太小了，最少 60px')
      return
    }
    if (size.pxW > 4000 || size.pxH > 4000) {
      toast('太大了，最多 4000px')
      return
    }
    getApp().globalData.customSize = size
    this.setData({
      customOpen: false,
      cur: 'custom',
      curName: '自定义',
      customLabel: `${size.mmText} · ${size.pxText}`
    })
  },

  /**
   * 选一张照片。
   * 注意：这里不再用 wx.requirePrivacyAuthorize 做前置拦截——
   * 隐私接口自己会拉起授权弹窗，手动拦一层只会在协议未配置时静默失败，
   * 表现就是"点了没反应"。改为直接调用 + 失败后把真实原因抛给用户。
   */
  upload() {
    if (this.picking) return
    this.picking = true

    this.pickPhoto()
      .then(path => {
        this.picking = false
        if (!path) return
        getApp().globalData.srcPath = path
        if (this.data.cur === 'custom' && !getApp().globalData.customSize) {
          this.setData({ customOpen: true })
          toast('先填一下自定义尺寸')
          return
        }
        wx.navigateTo({
          url: '/pages/edit/edit?size=' + this.data.cur,
          fail: err => {
            if (CFG.debug) {
              wx.showModal({
                title: '打开编辑页失败',
                content: (err && err.errMsg) || '未知错误',
                showCancel: false
              })
            } else {
              toast('页面打开失败，请重试')
            }
          }
        })
      })
      .catch(() => {
        this.picking = false
      })
  },

  pickPhoto() {
    return new Promise(resolve => {
      const finish = p => resolve(p)

      // 老接口兜底：基础库过低、或 chooseMedia 在某些环境被限制时还能走通
      const viaChooseImage = () => {
        if (!wx.chooseImage) {
          finish(null)
          return
        }
        wx.chooseImage({
          count: 1,
          sizeType: ['original'],
          sourceType: ['album', 'camera'],
          success: res => finish((res.tempFilePaths || [])[0] || null),
          fail: err => {
            this.reportPickError(err)
            finish(null)
          }
        })
      }

      if (!wx.chooseMedia) {
        viaChooseImage()
        return
      }

      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['original'],
        success: res => {
          const f = res.tempFiles && res.tempFiles[0]
          finish(f && f.tempFilePath ? f.tempFilePath : null)
        },
        fail: err => {
          const msg = (err && err.errMsg) || ''
          if (/cancel/i.test(msg)) {
            finish(null)
            return
          }
          viaChooseImage()
        }
      })
    })
  },

  /** 把微信返回的原始错误翻译成人话，别再用一句"读取失败"糊过去 */
  reportPickError(err) {
    const msg = (err && err.errMsg) || ''
    if (/cancel/i.test(msg)) return
    const code = err && (err.errno !== undefined ? err.errno : err.errCode)
    console.error('[pickPhoto]', code, msg, err)

    const finish = extra => {
      const isPrivacy = code === 112 || /privacy|not declared|未声明/i.test(msg)
      if (!CFG.debug) {
        toast(isPrivacy ? '需要先在小程序后台配置隐私协议' : '没能读取照片，请重试')
        return
      }
      wx.showModal({
        title: isPrivacy ? '相册接口被微信拦截' : '读取照片失败',
        content:
          (isPrivacy
            ? '后台没有配置《用户隐私保护指引》，相册/相机接口被拦。配置后即可正常使用。\n\n'
            : '') +
          'errno: ' + code + '\n' + msg +
          (extra ? '\n\n' + extra : ''),
        showCancel: false,
        confirmText: '知道了'
      })
    }

    if (!CFG.debug) {
      finish('')
      return
    }
    this.buildDiagnosis(finish)
  },

  /** 收集环境信息，一次把话说清楚：是不是游客模式、隐私协议有没有配 */
  buildDiagnosis(cb) {
    const lines = []
    try {
      const s = wx.getSystemInfoSync()
      lines.push('基础库 ' + s.SDKVersion)
    } catch (e) {}
    try {
      const acc = wx.getAccountInfoSync()
      const id = acc && acc.miniProgram && acc.miniProgram.appId
      lines.push('AppID ' + (id || '?') + (id === 'touristappid' ? '（游客模式，相册/相机受限）' : ''))
    } catch (e) {}

    if (wx.getPrivacySetting) {
      wx.getPrivacySetting({
        success: r => {
          lines.push('隐私协议 ' + (r.privacyContractName || '未配置'))
          cb(lines.join('\n'))
        },
        fail: () => cb(lines.join('\n'))
      })
    } else {
      cb(lines.join('\n'))
    }
  },

  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' })
  },

  onShareAppMessage() {
    return {
      title: CFG.shareTitle,
      path: '/pages/index/index'
    }
  }
})
