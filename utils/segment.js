/**
 * 人像分割 provider
 * MODE: 'local'（颜色算法） | 'remote'（云函数，主通道 = 腾讯云人像分割，自动降级 local）
 *
 * 远程链路：
 *   压缩图(≤700) → POST 云函数 → 云函数调腾讯云 SegmentPortraitPic →
 *   合成底色按规格输出成品图 JPEG → 客户端落盘直接用 <image> 显示
 */

const IMG = require('./image')

const MODE = 'remote'
const ENDPOINT = 'https://workbuddy-d7gdllq7e3ca333ec-1255772325.ap-shanghai.app.tcloudbase.com/segment'
const UPLOAD_MAX = 700 // 上传长边上限：云函数网关对请求体大小有限制，太大直接 413
const MAX_B64 = 80000 // base64 超过这个长度就降档重压，宁可小一点也不能 413
const TIMEOUT = 20000 // 首次调用含云函数冷启动，20 秒兜底

let remoteFail = 0 // 连续失败次数，达到 2 次才熔断，避免一次超时就把整场会话锁死

function withTimeout(p, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + ' 超时')), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

/**
 * 本地兜底：多档容差各抠一遍，挑「背景抠得最干净、人还完整」的那一份。
 * 单一容差在墙上遇到明暗分界就会卡住，留下白条；多档能绕过这个死结。
 */
function localFallback(data, w, h, protectRect, guard) {
  const MULS = [1, 1.4, 1.9]
  const orig = data.slice() // 每档都从原始像素重来，避免上一档的边缘处理污染下一档
  let best = null
  for (let i = 0; i < MULS.length; i++) {
    data.set(orig)
    const r = IMG.buildAlpha(data, w, h, protectRect, guard, MULS[i])
    if (!r || !r.ok || r.bodyMissing) continue
    if (!best || r.cleanPct > best.cleanPct) best = r
  }
  if (!best) {
    data.set(orig)
    best = IMG.buildAlpha(data, w, h, protectRect, guard, 1)
  }
  if (best && best.ok) best.source = 'local'
  return best
}

/* 压缩原图成 base64：按「长边」封顶，保持精确比例（腾讯云要求 <2000×2000） */
function compressToBase64(src, maxSide) {
  const limit = maxSide || UPLOAD_MAX
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src,
      success: info => {
        const ow = info.width || 1
        const oh = info.height || 1
        const sc = Math.min(1, limit / Math.max(ow, oh))
        const tw = Math.max(2, Math.round(ow * sc))
        const th = Math.max(2, Math.round(oh * sc))
        const attempt = (w, h, q, left) => {
          wx.compressImage({
            src,
            quality: q,
            compressedWidth: w,
            compressedHeight: h,
            success: res => {
              wx.getFileSystemManager().readFile({
                filePath: res.tempFilePath,
                encoding: 'base64',
                success: r => {
                  // 超过网关限制就降一档再压，宁可小一点也不能 413
                  if (r.data.length > MAX_B64 && left > 0) {
                    attempt(Math.round(w * 0.75), Math.round(h * 0.75), Math.max(70, q - 6), left - 1)
                  } else {
                    resolve(r.data)
                  }
                },
                fail: reject
              })
            },
            fail: reject
          })
        }
        attempt(tw, th, 92, 2)
      },
      fail: reject
    })
  })
}

function callRemote(base64, extra) {
  return new Promise((resolve, reject) => {
    if (!ENDPOINT) return reject(new Error('ENDPOINT 未配置'))
    wx.request({
      url: ENDPOINT,
      method: 'POST',
      timeout: TIMEOUT,
      header: { 'Content-Type': 'application/json' },
      data: JSON.stringify(Object.assign({ image: base64 }, extra || {})),
      success: res => {
        const d = res.data || {}
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode))
        if (!d.ok) {
          const err = new Error(d.error || '返回失败')
          err.code = d.code || ''
          return reject(err)
        }
        // 成品图模式返回 image，遮罩模式返回 alpha，两者都算成功
        if (!d.image && !d.alpha) return reject(new Error(d.error || '返回内容为空'))
        resolve(d)
      },
      fail: err => reject(new Error((err && err.errMsg) || 'request failed'))
    })
  })
}

/* 原始 alpha 字节(base64) → 双线性放大到 w×h（遮罩可为非正方形） */
function rawToAlpha(alphaB64, mw, mh, w, h) {
  const raw = new Uint8Array(wx.base64ToArrayBuffer(alphaB64))
  // 硬校验：字节数必须严格等于 宽×高，否则索引必然错位、抠图碎成色块
  if (raw.length !== mw * mh || raw.length < 64) {
    throw new Error('遮罩尺寸非法：' + raw.length + ' ≠ ' + mw + '×' + mh)
  }

  const alpha = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) {
    const sy = ((y + 0.5) * mh) / h - 0.5
    const y0 = Math.max(0, Math.min(mh - 1, Math.floor(sy)))
    const y1 = Math.max(0, Math.min(mh - 1, y0 + 1))
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < w; x++) {
      const sx = ((x + 0.5) * mw) / w - 0.5
      const x0 = Math.max(0, Math.min(mw - 1, Math.floor(sx)))
      const x1 = Math.max(0, Math.min(mw - 1, x0 + 1))
      const fx = Math.max(0, Math.min(1, sx - x0))
      const top = raw[y0 * mw + x0] * (1 - fx) + raw[y0 * mw + x1] * fx
      const bot = raw[y1 * mw + x0] * (1 - fx) + raw[y1 * mw + x1] * fx
      alpha[y * w + x] = top * (1 - fy) + bot * fy
    }
  }
  return alpha
}

async function segment(data, w, h, protectRect, guard, canvasNode, src, bg, outW, outH) {
  const useRemote = MODE === 'remote' && ENDPOINT && src && remoteFail < 2
  if (!useRemote) return localFallback(data, w, h, protectRect, guard)

  try {
    const t0 = Date.now()
    // 上传图宽高都必须显式指定并与工作画布同比例：
    // compressImage 只给宽度时，竖图的实际输出尺寸不确定，
    // 一旦和编辑页画布比例不一致，遮罩就会整体错位（表现为人物偏移+边缘白条）。
    // 只指定宽度：compressImage 会等比缩放，宽高比与工作画布天然一致。
    // 之前同时给宽高，若被按框裁切会让遮罩纵向错位，抠图碎成色块。
    const jpegB64 = await withTimeout(compressToBase64(src, UPLOAD_MAX), 6000, '图片压缩')
    const tEnc = Date.now() - t0
    const t1 = Date.now()
    console.log('[segment] 上传 base64 长度:', jpegB64.length)
    const res = await withTimeout(callRemote(jpegB64, { bg: bg || '#FFFFFF', outW: outW || 295, outH: outH || 413 }), TIMEOUT, '云函数请求')
    const tNet = Date.now() - t1

    // 腾讯云成品图：云端已切图并合成底色，客户端只负责落盘显示
    if (res.image) {
      const p = wx.env.USER_DATA_PATH + '/cut_' + Date.now() + '.jpg'
      wx.getFileSystemManager().writeFileSync(p, res.image, 'base64')
      return { ok: true, imagePath: p, source: 'remote', composed: true, timing: { enc: tEnc, net: tNet, post: 0 } }
    }
    const mw = res.w || res.size || UPLOAD_MAX
    const mh = res.h || res.size || UPLOAD_MAX
    const alpha = rawToAlpha(res.alpha, mw, mh, w, h)

    let hit = 0
    for (let i = 0; i < alpha.length; i += 7) if (alpha[i] > 128) hit++
    if (hit < (alpha.length / 7) * 0.02) throw new Error('遮罩内容过少')

    remoteFail = 0
    // 先用原始肤色测头部（放在去色之前，避免边缘处理影响肤色判定）
    const headMeas = IMG.measureHeadFromMask(data, alpha, w, h)
    // 边缘去色（AI 路径之前漏了这步，头发边缘留白圈）
    // 背景色反解：把混进发丝的背景白按透明度数学减掉（标准 un-premultiply）
    IMG.unmixEdges(data, alpha, w, h)

    // 不再跑本地抠图（buildAlpha 在手机上要 1~3 秒），
    // 头部位置直接从 AI 的遮罩里算：主体外框 + 顶部即头。
    let x0 = w
    let x1 = 0
    let y0 = h
    let y1 = 0
    let sx = 0
    let sy = 0
    let sum = 0
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        const p = row + x
        if (alpha[p] > 128) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
          sx += x
          sy += y
          sum++
        }
      }
    }
    if (!sum) throw new Error('遮罩内容过少')

    // 头高优先用遮罩宽度剖面测（脖子最窄），比「外框×0.42」准；
    // 测不出来才退回固定比例。
    const sil = IMG.silhouetteFromAlpha(alpha, w, h)
    const bh = y1 - y0
    const out = {
      ok: true,
      alpha,
      source: 'remote',
      bbox: { x0, x1, y0, y1 },
      bodyMissing: false,
      silhouette: headMeas || sil || {
        headTop: y0,
        headH: Math.max(h * 0.12, Math.min(h * 0.7, bh * 0.42)),
        headCenterX: (x0 + x1) / 2
      },
      timing: { enc: tEnc, net: tNet, post: Date.now() - t1 - tNet }
    }
    return out
  } catch (e) {
    remoteFail++
    const reason = (e && e.message) || String(e)
    // 非人像：不能退回本地算法（会生成一张垃圾图），必须让用户换照片
    if (e && (e.code === 'NO_FACE' || e.code === 'BAD_CONTENT')) {
      const err = new Error(reason)
      err.blocked = true
      throw err
    }
    console.warn('[segment] 远程失败(' + remoteFail + '/2)，本次改本地：', reason)
    const r = localFallback(data, w, h, protectRect, guard)
    if (r) r.failReason = reason
    return r
  }
}

/**
 * 预热：进首页就发一个空请求，把云函数实例和模型提前拉起来。
 * 云函数冷启动要 12 秒（加载 6.3MB 模型），而用户挑照片本身就要好几秒，
 * 提前打这一枪能把冷启动藏掉大半。
 */
function prewarm() {
  if (MODE !== 'remote' || !ENDPOINT) return
  wx.request({
    url: ENDPOINT,
    method: 'POST',
    timeout: 15000,
    header: { 'content-type': 'application/json' },
    data: { warmup: true }
  })
}

module.exports = { segment, prewarm, MODE, ENDPOINT, supported: () => MODE === 'remote' && !!ENDPOINT }
