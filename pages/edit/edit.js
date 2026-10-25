const { findSize, BGS } = require('../../utils/sizes')
const IMG = require('../../utils/image')
const SEG = require('../../utils/segment')
const { winInfo, toast } = require('../../utils/util')
const { maybeInterstitial } = require('../../utils/ad')
const CFG = require('../../utils/config')

// 处理分辨率上限：300dpi 下最大的尺寸也就 626px 高，720 足够且流畅
const MAX_SIDE = 720

// 编辑器里的底色候选比 sizes.js 多一个「原图」：
// 抠图不理想时用户至少能拿到一张干净的原背景照片，不会卡死。
const BG_LIST = BGS.concat([{ id: 'origin', name: '原图', color: null }])

Page({
  data: {
    cw: 0,
    ch: 0,
    size: null,
    tab: 'bg',
    bgs: BG_LIST,
    bgIndex: 1,
    beauty: 45,
    presets: [
      { label: '自然', v: 20 },
      { label: '标准', v: 45 },
      { label: '稍强', v: 70 }
    ],
    loading: true,
    srcPreview: '',
    resultSrc: '',
    scanTip: '正在识别人像…',
    cutFail: false,
    dbg: '',
    bodyWarn: false
  },

  onLoad(query) {
    const app = getApp()
    const size =
      query.size === 'custom' && app.globalData.customSize
        ? app.globalData.customSize
        : findSize(query.size)
    this.sizeObj = size
    this.outW = size.pxW
    this.outH = size.pxH

    const ar = size.ratio
    const info = winInfo()
    const maxW = info.windowWidth - 64
    const maxH = Math.round(info.windowHeight * 0.4)
    let cw = maxW
    let ch = Math.round(cw / ar)
    if (ch > maxH) {
      ch = maxH
      cw = Math.round(ch * ar)
    }

    let bgIndex = BGS.findIndex(b => b.id === size.bg)
    if (bgIndex < 0) bgIndex = 0

    this.setData({
      cw,
      ch,
      size,
      bgIndex,
      beauty: 45
    })
    this.cwPx = cw

    // 构图变换：zoom 相对「铺满」的倍数，tx/ty 为像素偏移
    this.frame = { zoom: 1, tx: 0, ty: 0 }
    // 是否使用未抠图的完整照片（「原图」模式）
    this.opaqueMode = false
  },

  onReady() {
    this.init()
  },

  onUnload() {
    if (this.beautyTimer) clearTimeout(this.beautyTimer)
    this.ctx = null
    this.previewNode = null
    this.loaderNode = null
    this.baseData = null
    this.scratch = null
  },

  /* ============================================================
     初始化
     ============================================================ */
  async init() {
    const src = getApp().globalData.srcPath
    if (!src) {
      wx.navigateBack()
      return
    }

    // 看门狗必须先武装：后面任何一步抛错或卡住，都不会让界面永久停住
    if (this._watchdog) clearTimeout(this._watchdog)
    this._watchdog = setTimeout(() => {
      if (this.data.loading) {
        this.stopScanTips()
        this.setData({ loading: false })
        wx.showModal({ title: '处理超时', content: '网络或服务繁忙，请重试一次。', showCancel: false })
      }
    }, 30000)

    // 扫描动画：先把原图铺在框里，再走处理流程
    if (this.data.srcPreview !== src) this.setData({ srcPreview: src })
    this.startScanTips()


    try {
      const nodes = await this.queryNodes()
      this.previewNode = nodes.preview
      this.loaderNode = nodes.loader
      this.encoderNode = nodes.encoder

      // 原图真实尺寸（导出分辨率的基准；3 秒拿不到就退回工作图尺寸）
      if (!this.origH) {
        const info = await new Promise(res => {
          const t = setTimeout(() => res(null), 3000)
          wx.getImageInfo({
            src,
            success: r => { clearTimeout(t); res(r) },
            fail: () => { clearTimeout(t); res(null) }
          })
        })
        if (info && info.height) {
          this.origW = info.width
          this.origH = info.height
        }
      }

      this.previewNode.width = this.outW
      this.previewNode.height = this.outH
      this.ctx = this.previewNode.getContext('2d')

      // 先用原生接口压到工作尺寸再解码：直接让画布解 12MP 原图很慢（0.5~2 秒），
      // 原生解码快得多，压完再解小图几乎瞬时。
      let workSrc = src
      try {
        const c = await new Promise((res, rej) => {
          wx.compressImage({
            src,
            quality: 92,
            compressedWidth: MAX_SIDE,
            success: res,
            fail: rej
          })
        })
        if (c && c.tempFilePath) workSrc = c.tempFilePath
      } catch (err) {
        workSrc = src
      }

      // 解码并按比例降采样到工作分辨率
      // 按原图分辨率导出：长边取原图长边（封顶 1800 = 上传给腾讯云的实际像素），
      // 不放大、不缩小；宽高比仍用证件照规格。
      {
        const ar = this.sizeObj.ratio || (this.outW / this.outH)
        const specLong = Math.max(this.sizeObj.pxW, this.sizeObj.pxH)
        const origLong = Math.max(this.origW || 0, this.origH || 0)
        const availLong = Math.min(900, Math.max(specLong, origLong || 0))
        if (ar >= 1) {
          this.outW = availLong
          this.outH = Math.max(2, Math.round(availLong / ar))
        } else {
          this.outH = availLong
          this.outW = Math.max(2, Math.round(availLong * ar))
        }
      }
      // 画布必须跟着重设：之前按规格尺寸建的画布，尺寸变了不重建就会画到画布外
      this.previewNode.width = this.outW
      this.previewNode.height = this.outH
      this.ctx = this.previewNode.getContext('2d')
      const _td = Date.now()
      // 上传也用这个压缩后的文件：它和下面的工作画布同一个源，宽高比必然一致，
      // 避免两次独立压缩造成遮罩错位（抠图碎成色块）。
      this.workSrc = workSrc
      const dim = await this.decode(workSrc)
      this.tDecode = Date.now() - _td
      this.cutW = dim.w
      this.cutH = dim.h

      const lctx = this.loaderCtx
      const id = lctx.getImageData(0, 0, this.cutW, this.cutH)

      // 1) 先在原图上定位头部，用于自动构图 & 保护人脸
      const metrics = IMG.detectHead(id.data, this.cutW, this.cutH)

      // 2) 抠图（用头部区域做保护，避免肤色背景把脸一起吃掉）
      const protect = this.protectOf(metrics)
      let cut = await SEG.segment(id.data, this.cutW, this.cutH, protect, null, this.encoderNode, this.workSrc || src, this.currentBg(), this.outW, this.outH)

      // 腾讯云成品图：云端已切图+合成底色，客户端只负责显示
      if (cut.ok && cut.imagePath) {
        // 直接用图片显示，不经过画布 —— 少一层绘制就少一处可能卡住的地方
        this.composed = true
        this.cutW = this.outW
        this.cutH = this.outH
        this.stopScanTips()
        this.setData({
          resultSrc: cut.imagePath,
          engineAi: true,
          engineLabel: '腾讯云切图',
          engineTip: '腾讯云人像分割 · 云端合成 · 耗时 压缩' + cut.timing.enc + ' 上传' + cut.timing.net + ' ms',
          loading: false,
          dbg: 'composed ' + this.outW + 'x' + this.outH
        })
        return
      }
      if (false) {
        await this.drawComposed(cut.imagePath)
        this.composed = true
        this.metrics = null
        this.opaqueMode = false
        this.frame = { zoom: 1, tx: 0, ty: 0 }
        this.stopScanTips()
        this.applyBeautyTo(0)
        this.setData({
          engineAi: true,
          engineLabel: '腾讯云切图',
          engineTip: '腾讯云人像分割 · 云端合成 · 耗时 压缩' + cut.timing.enc + ' 上传' + cut.timing.net + ' ms',
          loading: false,
          dbg: 'composed ' + this.cutW + 'x' + this.cutH
        })
        return
      }

      // 2.1) 白衣服配白墙：第一遍会把躯干一起当成背景吃掉。
      //      这时才启用「身体护栏」重跑一遍——护栏是补救手段，不是默认行为，
      //      平时不用它，免得护栏边缘把肩侧的墙也挡住、留下白块。
      if (cut.ok && cut.bodyMissing) {
        const rescued = IMG.buildAlpha(id.data, this.cutW, this.cutH, protect, this.guardOf(metrics))
        if (rescued.ok && !rescued.bodyMissing) cut = rescued
      }

      if (cut.ok) {
        const alpha = cut.alpha
        const d = id.data
        for (let p = 0, i = 3; p < alpha.length; p++, i += 4) d[i] = alpha[p]
        let hit = 0
        for (let k = 3; k < d.length; k += 4 * 37) if (d[k] > 128) hit++
        this.alphaPct = (hit / (d.length / (4 * 37))) * 100
        this.cutKind = cut.source || 'local'

        // 身体被当成背景吃掉了（白衬衫 + 白墙最典型）：
        // 直接切到「原图」，先保证用户能存出一张完整的照片，并在界面上说清原因。
        // 兜底：不管什么原因，只要抠完人几乎全没了，就退回原图。
        // 宁可给一张没换底色的照片，也不能给用户一张空白画布。
        let opaqueCount = 0
        for (let k = 3; k < d.length; k += 4 * 37) if (d[k] > 128) opaqueCount++
        if (opaqueCount < (d.length / (4 * 37)) * 0.02) {
          this.opaqueMode = true
          this.setData({ bodyWarn: true, bgIndex: BG_LIST.length - 1 })
        } else if (cut.bodyMissing) {
          this.opaqueMode = true
          this.setData({
            bodyWarn: true,
            bgIndex: BG_LIST.length - 1
          })
        }
      } else {
        // 抠图失败：退到「原图」，alpha 保持全不透明，至少能存出一张完整照片
        this.opaqueMode = true
        this.setData({
          cutFail: true,
          tab: 'bg',
          bgs: [BG_LIST[BG_LIST.length - 1]],
          bgIndex: 0
        })
      }

      // 3) 头部没识别出来时，用主体外框兜底构图
      // 头部定位优先级：轮廓实测 > 肤色推算 > 主体外框兜底。
      // 轮廓实测最准——它连着头发一起量，不会被"头发遮住太阳穴"骗到。
      if (cut.ok && cut.silhouette) {
        this.metrics = {
          headTop: cut.silhouette.headTop,
          headH: cut.silhouette.headH,
          headCenterX: cut.silhouette.headCenterX,
          faceW: cut.silhouette.headH * 0.72
        }
      } else if (metrics) {
        this.metrics = metrics
      } else if (cut.ok && cut.bbox) {
        const b = cut.bbox
        const bh = b.y1 - b.y0
        this.metrics = {
          headTop: b.y0,
          headH: bh * 0.42,
          headCenterX: (b.x0 + b.x1) / 2,
          faceW: bh * 0.3
        }
      } else {
        this.metrics = null
      }

      this.baseData = id.data
      this.scratch = new Uint8ClampedArray(id.data.length)
      this.imgData = lctx.createImageData(this.cutW, this.cutH)

      // 头高合理性校验：轮廓法在「脖子细长」「背景异常」时会给出离谱值。
      // 头高一旦被算小，缩放会顶到上限，最后只能看到一小块背景 —— 表现就是白屏。
      {
        const H = this.cutH
        const bad = !this.metrics || this.metrics.headH < H * 0.1 || this.metrics.headH > H * 0.7
        if (bad) {
          const b = cut.bbox
          this.metrics = {
            headTop: b ? b.y0 : H * 0.06,
            headH: b ? Math.max(H * 0.12, (b.y1 - b.y0) * 0.42) : H * 0.42,
            headCenterX: (this.metrics && this.metrics.headCenterX) || this.cutW / 2,
            faceW: b ? (b.y1 - b.y0) * 0.3 : H * 0.3
          }
        }
      }

      // 4) 初始视图：直接按证件照规格自动构图（头占 2/3、顶部留白、居中）。
      // 抠图成功后背景是透明的，规格构图放大不会露出空隙；
      // 只有「原图模式」（没抠成功/选原图）才需要铺满，computeFrame 里的 floor 已处理。
      this.frame = IMG.computeFrame(
        this.metrics,
        this.cutW,
        this.cutH,
        this.outW,
        this.outH,
        this.minZoomFor()
      )
      this.stopScanTips()
      this.applyBeautyTo(this.data.beauty / 100)

      this.setData({
        engineAi: cut.source === 'remote',
        engineLabel: cut.source === 'remote' ? 'AI 识别' : '本地处理',
        engineTip: cut.source === 'remote' && cut.timing
          ? '耗时 解码' + (this.tDecode || 0) + ' 压缩' + cut.timing.enc + ' 上传' + cut.timing.net + ' 处理' + cut.timing.post + ' ms'
          : (cut.source === 'remote' ? 'AI 识别：照片仅用于本次处理，不保存' : ('本地兜底｜云端失败：' + (cut.failReason || '未知'))),
        loading: false,
        dbg: [this.cutW + 'x' + this.cutH, 'a' + Math.round(this.alphaPct || 0), 'z' + ((this.frame && this.frame.zoom) || 0).toFixed(2), 'ctx' + (this.ctx ? 1 : 0) + 'ld' + (this.loaderNode ? 1 : 0) + 'pv' + (this.previewNode ? 1 : 0), 'r' + (this.renderErr || '-'), 'h' + (this.metrics ? Math.round(this.metrics.headH) : -1)].join(' ')
      })
    } catch (e) {
      this.stopScanTips()
      this.setData({ loading: false })
      console.error('[edit] init failed', e)
      if (e && e.blocked) {
        wx.showModal({
          title: '没识别到人像',
          content: (e.message || '') + '\n\n请上传本人正面免冠照片，光线均匀、脸部完整。',
          showCancel: false,
          success: () => wx.navigateBack()
        })
        return
      }
      if (CFG.debug) {
        wx.showModal({
          title: '图片处理失败',
          content: (e && (e.message || e.errMsg)) || String(e),
          showCancel: false
        })
      } else {
        toast('这张照片处理失败，换一张试试')
      }
    }
  },

  /** 扫描动画的分阶段文案：让等待有进度感 */
  startScanTips() {
    this.stopScanTips()
    const words = ['正在识别人像…', '正在分离背景…', '正在生成照片…']
    let i = 0
    this.setData({ scanTip: words[0] })
    this._tipTimer = setInterval(() => {
      i++
      if (i < words.length) this.setData({ scanTip: words[i] })
    }, 900)
  },

  stopScanTips() {
    if (this._tipTimer) {
      clearInterval(this._tipTimer)
      this._tipTimer = null
    }
  },

  __probe() {
    if (!this.loaderNode || !this.loaderCtx) return { err: 'no loader ctx' }
    if (!this.imgData) return { err: 'no imgData' }
    const d = this.loaderCtx.getImageData(0, 0, this.cutW, this.cutH).data
    const cx = Math.floor(this.cutW / 2)
    const cy = Math.floor(this.cutH / 2)
    const c = cy * this.cutW + cx
    let opaque = 0
    for (let k = 3; k < d.length; k += 4 * 17) if (d[k] > 128) opaque++
    return {
      lw: this.loaderNode.width,
      lh: this.loaderNode.height,
      cutW: this.cutW,
      cutH: this.cutH,
      centerAlpha: d[c * 4 + 3],
      centerRGB: [d[c * 4], d[c * 4 + 1], d[c * 4 + 2]],
      opaquePct: Math.round(opaque / (d.length / (4 * 17)) * 100),
      hasBase: !!this.baseData,
      hasImgData: !!this.imgData,
      frame: this.frame,
      opaqueMode: this.opaqueMode
    }
  },

  /** 把云端合成好的成品图铺进 loader 画布（尺寸即输出规格） */
  drawComposed(path) {
    const p = this
    return new Promise((resolve, reject) => {
      const img = p.loaderNode.createImage()
      // 兜底超时：图片加载事件没回来时不能一直挂着
      const timer = setTimeout(() => reject(new Error('成品图加载超时')), 8000)
      img.onload = () => {
        clearTimeout(timer)
        p.loaderNode.width = p.outW
        p.loaderNode.height = p.outH
        const ctx = p.loaderNode.getContext('2d')
        ctx.clearRect(0, 0, p.outW, p.outH)
        ctx.drawImage(img, 0, 0, p.outW, p.outH)
        p.loaderCtx = ctx
        p.cutW = p.outW
        p.cutH = p.outH
        p.imgData = ctx.createImageData(p.outW, p.outH)
        const d = ctx.getImageData(0, 0, p.outW, p.outH).data
        p.baseData = d
        p.scratch = new Uint8ClampedArray(d.length)
        p.alphaPct = 100
        resolve()
      }
      img.onerror = () => { clearTimeout(timer); reject(new Error('成品图加载失败')) }
      img.src = path
    })
  },

  queryNodes() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#preview')
        .fields({ node: true })
        .select('#loader')
        .fields({ node: true })
        .select('#encoder')
        .fields({ node: true })
        .exec(res => {
          if (!res || !res[0] || !res[0].node || !res[1] || !res[1].node) {
            reject(new Error('canvas not ready'))
            return
          }
          resolve({
            preview: res[0].node,
            loader: res[1].node,
            encoder: res[2] && res[2].node ? res[2].node : null
          })
        })
    })
  },

  /** 把图片画进离屏画布并取得 2d 上下文 */
  decode(src) {
    return new Promise((resolve, reject) => {
      const canvas = this.loaderNode
      const img = canvas.createImage()
      img.onload = () => {
        const ratio = Math.min(1, MAX_SIDE / Math.max(img.width, img.height))
        const w = Math.max(2, Math.round(img.width * ratio))
        const h = Math.max(2, Math.round(img.height * ratio))
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        this.loaderCtx = ctx
        resolve({ w, h })
      }
      img.onerror = e =>
        reject(new Error((e && (e.errMsg || e.message)) || '图片解码失败'))
      img.src = src
    })
  },

  /**
   * 身体护栏（梯形）：从下巴往下罩住躯干。
   * 只在下巴以下生效、并且脖子处很窄，所以颈侧和肩侧的墙仍然能被抠掉。
   * 目的只有一个：白衣服配白墙时，别把人掏空。
   */
  guardOf(m) {
    if (!m) return null
    const chin = m.headTop + m.headH
    return {
      cx: m.headCenterX,
      top: chin,
      w0: m.faceW * 0.46, // 脖子宽度
      slope: (m.faceW * 0.7) / Math.max(1, m.headH), // 到肩膀处展开
      cap: m.faceW * 1.15
    }
  },

  protectOf(m) {
    if (!m) return null
    // 只保护「脸」本身，别把脸旁边和头发外围的墙也一起锁死。
    // 之前这里取了 ±0.9 个脸宽、还从头顶包到下巴，等于在画面中间开了个
    // 一大块禁止抠除的矩形——结果只有这块矩形上下的墙被抠掉，
    // 脸周围一圈白墙原封不动，看起来就是"上下两条蓝边"的 bug。
    const faceTop = m.headTop + m.headH * 0.15
    return {
      x0: Math.max(0, Math.floor(m.headCenterX - m.faceW * 0.5)),
      x1: Math.min(this.cutW - 1, Math.ceil(m.headCenterX + m.faceW * 0.5)),
      y0: Math.max(0, Math.floor(faceTop)),
      y1: Math.min(this.cutH - 1, Math.ceil(faceTop + m.faceW * 1.3))
    }
  },

  /* ============================================================
     绘制
     ============================================================ */
  render() {
    const ctx = this.ctx
    if (!ctx || !this.loaderNode) return
    const outW = this.outW
    const outH = this.outH
    const cutW = this.cutW
    const cutH = this.cutH

    const bg = this.currentBg()
    ctx.save()
    ctx.fillStyle = bg || '#FFFFFF'
    ctx.fillRect(0, 0, outW, outH)

    const cover = Math.max(outW / cutW, outH / cutH)
    const s = cover * this.frame.zoom
    const dw = cutW * s
    const dh = cutH * s
    const dx = (outW - dw) / 2 + this.frame.tx
    const dy = (outH - dh) / 2 + this.frame.ty

    try {
      ctx.drawImage(this.loaderNode, 0, 0, cutW, cutH, dx, dy, dw, dh)
    } catch (e) {
      try {
        ctx.drawImage(this.loaderNode, dx, dy, dw, dh)
      } catch (e2) {
        // 最后兜底：整张铺满，至少别给用户一块白板
        try { ctx.drawImage(this.loaderNode, 0, 0, cutW, cutH, 0, 0, outW, outH) } catch (e3) {}
        this.renderErr = 'draw:' + ((e && e.message) || '') + '/' + ((e2 && e2.message) || '')
      }
    }
    ctx.restore()

  },

  currentBg() {
    const b = BG_LIST[this.data.bgIndex]
    if (!b || b.id === 'origin' || this.data.cutFail) return '#FFFFFF'
    return b.color || '#FFFFFF'
  },

  /* ============================================================
     美颜
     ============================================================ */
  applyBeautyTo(k) {
    if (!this.baseData || !this.loaderCtx) return
    const buf = this.scratch
    if (!buf) return
    buf.set(this.baseData)

    if (this.opaqueMode) {
      for (let i = 3; i < buf.length; i += 4) buf[i] = 255
    }

    // 复用上一次的模糊结果：切底色/同一档位重复处理时省掉最贵的 blurRGB
    const r = Math.round(1 + Math.min(1, Math.max(0, k)) * 2.2)
    if (this.beautyBlur && this.beautyBlurR === r) {
      IMG.applyBeauty(buf, this.cutW, this.cutH, k, this.beautyBlur)
    } else {
      const blur = IMG.applyBeauty(buf, this.cutW, this.cutH, k)
      if (blur) { this.beautyBlur = blur; this.beautyBlurR = r }
    }

    this.imgData.data.set(buf)
    this.loaderCtx.putImageData(this.imgData, 0, 0)
    this.render()
  },

  scheduleBeauty(v) {
    if (this.beautyTimer) clearTimeout(this.beautyTimer)
    // 拖动过程中合并处理：每 120ms 才真正算一次并回写界面，
    // 避免 setData 与像素运算把主线程占满，手感会顺很多
    this.beautyTimer = setTimeout(() => {
      this.beautyTimer = null
      if (v !== this.data.beauty) this.setData({ beauty: v })
      this.applyBeautyTo(v / 100)
    }, 120)
  },

  onBeautyChanging(e) {
    this.scheduleBeauty(e.detail.value)
  },

  onBeautyChange(e) {
    const v = e.detail.value
    if (this.beautyTimer) {
      clearTimeout(this.beautyTimer)
      this.beautyTimer = null
    }
    if (v !== this.data.beauty) this.setData({ beauty: v })
    this.applyBeautyTo(v / 100)
  },

  pickPreset(e) {
    const v = Number(e.currentTarget.dataset.v)
    this.setData({ beauty: v })
    this.applyBeautyTo(v / 100)
  },

  /* ============================================================
     交互
     ============================================================ */
  /**
   * 允许的最小缩放。
   * 抠图成功时背景是透明的，缩到"铺满"以下空出来的是纯底色，很自然，
   * 所以放宽到 0.45——自拍本来就拍得近，这样头才能缩回正常比例。
   * 原图模式必须保持 1，否则会露出照片的矩形边。
   */
  minZoomFor() {
    return this.opaqueMode ? 1 : 0.45
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  pickBg(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i === this.data.bgIndex) return
    // 成品图模式下底色已在云端合成，换色必须重新请求
    if (this.composed) {
      this.setData({ bgIndex: i, loading: true, resultSrc: '' })
      this.composed = false
      this.init()
      return
    }
    const b = BG_LIST[i]
    const opaque = !b || b.id === 'origin'
    this.setData({ bgIndex: i })
    if (opaque !== this.opaqueMode) {
      this.opaqueMode = opaque
      // 切到原图时必须把缩放下限收回 1，否则会露出照片的矩形边
      this.frame = IMG.clampFrame(
        this.frame,
        this.cutW, this.cutH, this.outW, this.outH, this.minZoomFor()
      )
      // alpha 变了，必须整张重算一次再画，不能只重画
      this.applyBeautyTo(this.data.beauty / 100)
    } else {
      this.render()
    }
  },

  resetFrame() {
    if (!this.cutW) return
    this.frame = IMG.computeFrame(
      this.metrics,
      this.cutW,
      this.cutH,
      this.outW,
      this.outH,
      this.minZoomFor()
    )
    this.render()
  },

  onTouchStart(e) {
    const t = e.touches
    if (!t || !t.length) return
    const scale = this.outW / (this.cwPx || this.data.cw || 1)
    this.touch = {
      mode: t.length > 1 ? 'pinch' : 'drag',
      x: t[0].x,
      y: t[0].y,
      tx: this.frame.tx,
      ty: this.frame.ty,
      zoom: this.frame.zoom,
      dist: t.length > 1 ? this.spread(t) : 0,
      mx: t.length > 1 ? (t[0].x + t[1].x) / 2 : 0,
      my: t.length > 1 ? (t[0].y + t[1].y) / 2 : 0,
      scale
    }
  },

  onTouchMove(e) {
    if (!this.touch || !this.cutW) return
    const t = e.touches
    if (!t || !t.length) return
    const k = this.touch.scale

    if (t.length > 1) {
      if (this.touch.mode !== 'pinch') {
        // 从单指切换到双指，重新取基准
        this.touch = Object.assign({}, this.touch, {
          mode: 'pinch',
          dist: this.spread(t),
          mx: (t[0].x + t[1].x) / 2,
          my: (t[0].y + t[1].y) / 2,
          tx: this.frame.tx,
          ty: this.frame.ty,
          zoom: this.frame.zoom
        })
        return
      }
      const d = this.spread(t)
      const base = this.touch.dist || d
      const zoom = this.touch.zoom * (d / base)
      const mx = (t[0].x + t[1].x) / 2
      const my = (t[0].y + t[1].y) / 2
      this.frame = IMG.clampFrame(
        {
          zoom,
          tx: this.touch.tx + (mx - this.touch.mx) * k,
          ty: this.touch.ty + (my - this.touch.my) * k
        },
        this.cutW, this.cutH, this.outW, this.outH, this.minZoomFor()
      )
    } else {
      if (this.touch.mode !== 'drag') return
      this.frame = IMG.clampFrame(
        {
          zoom: this.frame.zoom,
          tx: this.touch.tx + (t[0].x - this.touch.x) * k,
          ty: this.touch.ty + (t[0].y - this.touch.y) * k
        },
        this.cutW, this.cutH, this.outW, this.outH, this.minZoomFor()
      )
    }
    this.render()
  },

  onTouchEnd() {
    this.touch = null
  },

  spread(t) {
    const dx = t[0].x - t[1].x
    const dy = t[0].y - t[1].y
    return Math.sqrt(dx * dx + dy * dy) || 1
  },

  /* ============================================================
     生成 & 保存
     ============================================================ */
  async onSave() {
    if (this.saving) return
    // 成品图模式：云端返回的就是最终图，直接存，不再二次压缩
    if (this.data.resultSrc) {
      this.saving = true
      wx.showLoading({ title: '保存中', mask: true })
      wx.saveImageToPhotosAlbum({
        filePath: this.data.resultSrc,
        success: () => {
          wx.hideLoading(); this.saving = false
          toast('已保存到相册')
        },
        fail: () => {
          wx.hideLoading(); this.saving = false
          wx.showModal({ title: '保存失败', content: '请在系统设置里允许保存到相册', showCancel: false })
        }
      })
      return
    }
    if (!this.ctx) {
      toast('还没处理好，稍等一下')
      return
    }
    this.saving = true
    wx.showLoading({ title: '生成中', mask: true })

    let path = ''
    try {
      path = await this.exportFile()
    } catch (e) {
      wx.hideLoading()
      this.saving = false
      toast('生成失败，请重试')
      return
    }
    wx.hideLoading()

    getApp().globalData.result = {
      path,
      name: this.sizeObj.name,
      mmText: this.sizeObj.mmText,
      pxText: this.sizeObj.pxText,
      pxW: this.outW,
      pxH: this.outH,
      saved: false
    }

    const saved = await this.saveToAlbum(path)
    getApp().globalData.result.saved = saved
    if (saved) maybeInterstitial()

    this.saving = false
    wx.navigateTo({ url: '/pages/result/result' })
  },

  exportFile() {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath(
        {
          canvas: this.previewNode,
          x: 0,
          y: 0,
          width: this.outW,
          height: this.outH,
          destWidth: this.outW,
          destHeight: this.outH,
          fileType: 'jpg',
          quality: 0.98,
          success: res => resolve(res.tempFilePath),
          fail: reject
        },
        this
      )
    })
  },

  saveToAlbum(filePath) {
    return new Promise(resolve => {
      wx.saveImageToPhotosAlbum({
        filePath,
        success: () => {
          wx.showToast({ title: '已存入相册', icon: 'success' })
          resolve(true)
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
          resolve(false)
        }
      })
    })
  }
})
