/**
 * 云函数：人像分割（MODNet 6.3MB 量化版）
 * ------------------------------------------------------------
 * 输入：{ image: '<base64 jpeg>' }
 * 输出：{ ok, size, mask }  mask = base64 PNG 灰度（白=人）
 *
 * 特意不用 sharp：它是原生模块，云端装依赖最容易失败（之前就死在启动时
 * "145 code exit unexpected"，Duration 0 / MemUsage 0，典型的模块加载崩溃）。
 * 这里改用纯 JS 的 jpeg-js 解码 + 自己写双线性缩放，只依赖 onnxruntime-node。
 *
 * 预处理必须与训练一致：像素 (px/127.5 - 1)，即 mean=0.5 std=0.5 的归一化。
 * 写成 [0,1] 会输出全黑。
 */

const cloud = require('wx-server-sdk')
let ort = null // 懒加载，见 getSession()
const jpeg = require('jpeg-js')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const INPUT_SIZE = 512
const MODEL_PATH = path.join(__dirname, 'model', 'portrait.onnx')

let sessionPromise = null
function getSession() {
  if (!sessionPromise) {
    if (!fs.existsSync(MODEL_PATH)) {
      sessionPromise = Promise.reject(new Error('模型缺失: ' + MODEL_PATH))
    } else {
      // 懒加载 onnxruntime：它是体积很大的原生包，云端安装可能失败。
      // 放在这里，装不上也只是本地兜底不可用，不会拖垮腾讯云主通道。
      try {
        if (!ort) ort = require('onnxruntime-node')
      } catch (e) {
        sessionPromise = Promise.reject(new Error('onnxruntime 不可用: ' + ((e && e.message) || e)))
        return sessionPromise
      }
      sessionPromise = ort.InferenceSession.create(MODEL_PATH)
    }
  }
  return sessionPromise
}

/** 双线性缩放到 n×n，返回 RGB float32（已归一化到 [-1,1]） */
function toNCHW(rgba, w, h, n) {
  const out = new Float32Array(3 * n * n)
  for (let y = 0; y < n; y++) {
    const sy = ((y + 0.5) * h) / n - 0.5
    const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)))
    const y1 = Math.max(0, Math.min(h - 1, y0 + 1))
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < n; x++) {
      const sx = ((x + 0.5) * w) / n - 0.5
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)))
      const x1 = Math.max(0, Math.min(w - 1, x0 + 1))
      const fx = Math.max(0, Math.min(1, sx - x0))

      const i00 = (y0 * w + x0) * 4
      const i01 = (y0 * w + x1) * 4
      const i10 = (y1 * w + x0) * 4
      const i11 = (y1 * w + x1) * 4
      const p = y * n + x

      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] * (1 - fx) + rgba[i01 + c] * fx
        const bot = rgba[i10 + c] * (1 - fx) + rgba[i11 + c] * fx
        const v = top * (1 - fy) + bot * fy
        out[c * n * n + p] = v / 127.5 - 1
      }
    }
  }
  return out
}

/** 8 位灰度 → PNG（手写，避免引入图像库） */
function grayToPng(gray, w, h) {
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0 // filter: none
    gray.copy(raw, y * (w + 1) + 1, y * w, y * w + w)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })

  const chunks = []
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  chunks.push(sig)

  function chunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.concat([t, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(crcBuf) >>> 0, 0)
    return Buffer.concat([len, t, data, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  chunks.push(chunk('IHDR', ihdr))
  chunks.push(chunk('IDAT', idat))
  chunks.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ -1
}


/* ============================================================
   腾讯云「人像分割」SegmentPortraitPic（bda 服务）
   ------------------------------------------------------------
   密钥只从环境变量读，绝不写进代码、更不下发到小程序端。
   未配置密钥时自动走本地 ONNX 模型，保证功能不中断。
   ============================================================ */
const crypto = require('crypto')
const https = require('https')

const BDA_HOST = 'bda.tencentcloudapi.com'
const BDA_ACTION = 'SegmentPortraitPic'
const BDA_VERSION = '2020-03-24'
const BDA_REGION = process.env.TENCENT_REGION || 'ap-shanghai'
const MASK_W = 320 // 回传遮罩宽度：太小伤边缘，太大拖慢下载

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}
function hmac256(key, s) {
  return crypto.createHmac('sha256', key).update(s, 'utf8').digest()
}

/** TC3-HMAC-SHA256 手写签名（不引 SDK，避免几百 MB 依赖把部署包撑爆） */
function tc3Call(payload) {
  const secretId = process.env.TENCENT_SECRET_ID
  const secretKey = process.env.TENCENT_SECRET_KEY
  if (!secretId || !secretKey) {
    return Promise.reject(new Error('未配置 TENCENT_SECRET_ID / TENCENT_SECRET_KEY'))
  }
  const body = JSON.stringify(payload)
  const ts = Math.floor(Date.now() / 1000)
  const date = new Date(ts * 1000).toISOString().slice(0, 10)
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalHeaders = 'content-type:application/json; charset=utf-8\n' + 'host:' + BDA_HOST + '\n' + 'x-tc-action:' + BDA_ACTION.toLowerCase() + '\n'
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256hex(body)].join('\n')
  const scope = date + '/bda/tc3_request'
  const stringToSign = ['TC3-HMAC-SHA256', String(ts), scope, sha256hex(canonicalRequest)].join('\n')
  const kSigning = hmac256(hmac256(hmac256('TC3' + secretKey, date), 'bda'), 'tc3_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  const authorization =
    'TC3-HMAC-SHA256 Credential=' + secretId + '/' + scope +
    ', SignedHeaders=' + signedHeaders + ', Signature=' + signature

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: BDA_HOST,
        path: '/',
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Host: BDA_HOST,
          'X-TC-Action': BDA_ACTION,
          'X-TC-Version': BDA_VERSION,
          'X-TC-Timestamp': String(ts),
          'X-TC-Region': BDA_REGION,
          Authorization: authorization
        }
      },
      res => {
        let data = ''
        res.on('data', d => { data += d })
        res.on('end', () => {
          try { resolve(JSON.parse(data)) } catch (err) { reject(new Error('返回非 JSON：' + data.slice(0, 160))) }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('腾讯云接口超时')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * 极简 PNG 解码（只覆盖腾讯云返回的格式：8 位、非隔行、灰度/灰度+α/RGB/RGBA）。
 * 不引第三方库：部署包已经因为 node_modules 吃过亏，这里自己解。
 */

/**
 * 把腾讯云切好的 RGBA 前景合成到指定底色，输出 JPEG。
 * 边缘完全用腾讯云的处理结果，不再自己做去色 —— 它比我们写得好。
 */

/**
 * 人像合理性校验（防恶意上传非人像照片）：
 * 1) 主体占比要在 3%~97% 之间，全空或几乎满屏都不像证件照
 * 2) 上半部分必须有足够的肤色像素 —— 证件照必然露脸，没有肤色基本就不是人像
 * 不额外调接口、不额外收费，用的是已经有的人体遮罩 + RGB。
 */

/**
 * 图片内容安全审核（ims.ImageModeration，v2020-12-29）。
 * 目的是拦住色情/暴恐/违禁等违规上传 —— 这是小程序过审和长期运营的硬要求。
 * 未开通时返回 { skipped: true }，不阻断抠图主流程。
 */
async function moderateImage(imageB64) {
  const secretId = process.env.TENCENT_SECRET_ID
  const secretKey = process.env.TENCENT_SECRET_KEY
  if (!secretId || !secretKey) return { skipped: true }

  const host = 'ims.tencentcloudapi.com'
  const action = 'ImageModeration'
  const version = '2020-12-29'
  const body = JSON.stringify({ FileContent: imageB64, Type: 'IMAGE' })
  const ts = Math.floor(Date.now() / 1000)
  const date = new Date(ts * 1000).toISOString().slice(0, 10)
  const sh = 'content-type;host;x-tc-action'
  const ch = 'content-type:application/json; charset=utf-8\nhost:' + host + '\nx-tc-action:' + action.toLowerCase() + '\n'
  const cr = ['POST', '/', '', ch, sh, sha256hex(body)].join('\n')
  const scope = date + '/ims/tc3_request'
  const sts = ['TC3-HMAC-SHA256', String(ts), scope, sha256hex(cr)].join('\n')
  const ks = hmac256(hmac256(hmac256('TC3' + secretKey, date), 'ims'), 'tc3_request')
  const sig = crypto.createHmac('sha256', ks).update(sts, 'utf8').digest('hex')
  const auth = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + scope + ', SignedHeaders=' + sh + ', Signature=' + sig

  const r = await new Promise((resolve, reject) => {
    const req = https.request({
      host, path: '/', method: 'POST', timeout: 8000,
      headers: {
        'Content-Type': 'application/json; charset=utf-8', Host: host,
        'X-TC-Action': action, 'X-TC-Version': version,
        'X-TC-Timestamp': String(ts), 'X-TC-Region': BDA_REGION, Authorization: auth
      }
    }, res => {
      let d = ''
      res.on('data', c => { d += c })
      res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(new Error('bad json')) } })
    })
    req.on('timeout', () => req.destroy(new Error('moderation timeout')))
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  const resp = r.Response || {}
  if (resp.Error) {
    // 未开通/欠费：不阻断主流程，只记录
    const code = resp.Error.Code || ''
    if (/Unauthorized|UnOpen|InArrears|ResourceUnavailable/i.test(code)) {
      return { skipped: true, reason: code }
    }
    throw new Error(code + ': ' + resp.Error.Message)
  }
  const sug = resp.Suggestion || 'Pass'
  return { ok: sug === 'Pass', suggestion: sug, label: resp.Label || '', sub: resp.SubLabel || '' }
}

function looksLikePortrait(png, maskPng) {
  const W = png.width
  const H = png.height
  const ch = png.channels
  if (ch !== 4) return { ok: true }

  const mw = maskPng.width
  const mh = maskPng.height
  const mch = maskPng.channels
  const mAt = p => (mch === 1 ? maskPng.data[p] : mch === 2 ? maskPng.data[p * 2] : mch === 3 ? maskPng.data[p * 3] : maskPng.data[p * 4 + 3])

  let fg = 0
  let total = 0
  const stepM = Math.max(1, Math.round(Math.sqrt((mw * mh) / 20000)))
  for (let y = 0; y < mh; y += stepM) {
    for (let x = 0; x < mw; x += stepM) {
      total++
      if (mAt(y * mw + x) > 128) fg++
    }
  }
  const ratio = total ? fg / total : 0
  if (ratio < 0.03 || ratio > 0.97) {
    return { ok: false, reason: '主体占比异常(' + (ratio * 100).toFixed(1) + '%)' }
  }

  // 肤色采样：只看上半部分（脸应该在这里）
  let skin = 0
  let sampled = 0
  const stepP = Math.max(1, Math.round(Math.sqrt((W * H) / 30000)))
  const limitY = Math.round(H * 0.55)
  for (let y = 0; y < limitY; y += stepP) {
    for (let x = 0; x < W; x += stepP) {
      const i = (y * W + x) * 4
      if (png.data[i + 3] < 200) continue
      sampled++
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2]
      const yy = 0.299 * r + 0.587 * g + 0.114 * b
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      if (yy > 55 && cb > 74 && cb < 134 && cr > 136 && cr < 180 && mx - mn > 11 && r > 62 && r >= g && g >= b * 0.55 && r - b > 20) skin++
    }
  }
  const skinRatio = sampled ? skin / sampled : 0
  if (skinRatio < 0.015) {
    return { ok: false, reason: '上半身几乎没有肤色(' + (skinRatio * 100).toFixed(1) + '%)' }
  }
  return { ok: true, ratio, skinRatio }
}

function composeOnBg(rgbaPng, srcW, srcH, bgHex, outW, outH) {
  const png = typeof rgbaPng.decodePng === 'function' ? rgbaPng : decodePng(rgbaPng)
  if (png.channels !== 4) throw new Error('前景不是 RGBA')
  const W = png.width
  const H = png.height
  const data = png.data

  const hex = (bgHex || '#FFFFFF').replace('#', '')
  const chan = (t) => { const v = parseInt(t, 16); return isNaN(v) ? 255 : v }
  const br = chan(hex.slice(0, 2))
  const bg = chan(hex.slice(2, 4))
  const bb = chan(hex.slice(4, 6))

  const ow = Math.max(16, Math.min(2000, outW | 0))
  const oh = Math.max(16, Math.min(2000, outH | 0))

  // 等比裁切（cover）
  const sc = Math.max(ow / W, oh / H)
  const cropW = ow / sc
  const cropH = oh / sc
  const offX = (W - cropW) / 2
  const offY = (H - cropH) / 2

  // 坐标与权重全部预计算，主循环只做 4 次采样 —— 比逐块区域平均快一个量级
  const xs = new Int32Array(ow)
  const xf = new Float32Array(ow)
  for (let x = 0; x < ow; x++) {
    const sx = offX + (x + 0.5) * (cropW / ow) - 0.5
    const i0 = Math.max(0, Math.min(W - 1, Math.floor(sx)))
    const i1 = Math.min(W - 1, i0 + 1)
    xs[x] = i0
    xf[x] = Math.max(0, Math.min(1, sx - i0)) * 0 + (i1 === i0 ? 0 : Math.max(0, Math.min(1, sx - i0)))
  }
  const ys = new Int32Array(oh)
  const yf = new Float32Array(oh)
  for (let y = 0; y < oh; y++) {
    const sy = offY + (y + 0.5) * (cropH / oh) - 0.5
    const j0 = Math.max(0, Math.min(H - 1, Math.floor(sy)))
    const j1 = Math.min(H - 1, j0 + 1)
    ys[y] = j0 * W
    yf[y] = j1 === j0 ? 0 : Math.max(0, Math.min(1, sy - j0))
  }
  const ysNext = new Int32Array(oh)
  for (let y = 0; y < oh; y++) {
    const sy = offY + (y + 0.5) * (cropH / oh) - 0.5
    const j0 = Math.max(0, Math.min(H - 1, Math.floor(sy)))
    ysNext[y] = Math.min(H - 1, j0 + 1) * W
  }

  const out = Buffer.alloc(ow * oh * 4)
  for (let y = 0; y < oh; y++) {
    const r0 = ys[y]
    const r1 = ysNext[y]
    const wy = yf[y]
    let o = y * ow * 4
    for (let x = 0; x < ow; x++) {
      const c0 = xs[x]
      const c1 = Math.min(W - 1, c0 + 1)
      const wx = xf[x]
      const p00 = (r0 + c0) * 4
      const p01 = (r0 + c1) * 4
      const p10 = (r1 + c0) * 4
      const p11 = (r1 + c1) * 4
      const w00 = (1 - wx) * (1 - wy)
      const w01 = wx * (1 - wy)
      const w10 = (1 - wx) * wy
      const w11 = wx * wy
      const a = data[p00 + 3] * w00 + data[p01 + 3] * w01 + data[p10 + 3] * w10 + data[p11 + 3] * w11
      const af = a / 255
      // 颜色按 alpha 加权，避免透明像素的杂色渗进来
      const aw = (x2) => data[x2 + 3]
      const rr = (data[p00] * w00 * aw(p00) + data[p01] * w01 * aw(p01) + data[p10] * w10 * aw(p10) + data[p11] * w11 * aw(p11))
      const gg = (data[p00 + 1] * w00 * aw(p00) + data[p01 + 1] * w01 * aw(p01) + data[p10 + 1] * w10 * aw(p10) + data[p11 + 1] * w11 * aw(p11))
      const bl = (data[p00 + 2] * w00 * aw(p00) + data[p01 + 2] * w01 * aw(p01) + data[p10 + 2] * w10 * aw(p10) + data[p11 + 2] * w11 * aw(p11))
      const asum = data[p00 + 3] * w00 + data[p01 + 3] * w01 + data[p10 + 3] * w10 + data[p11 + 3] * w11
      let cr = br, cg = bg, cb = bb
      if (asum > 0.5) {
        cr = rr / asum
        cg = gg / asum
        cb = bl / asum
      }
      out[o] = cr * af + br * (1 - af)
      out[o + 1] = cg * af + bg * (1 - af)
      out[o + 2] = cb * af + bb * (1 - af)
      out[o + 3] = 255
      o += 4
    }
  }
  return jpeg.encode({ data: out, width: ow, height: oh }, 96).data
}

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let pos = 8
  let w = 0
  let h = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.slice(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('只支持 8 位 PNG，当前 ' + bitDepth)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const chMap = { 0: 1, 2: 3, 4: 2, 6: 4 }
  const channels = chMap[colorType]
  if (!channels) throw new Error('不支持的色彩类型 ' + colorType)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(h * stride)
  let rp = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++]
    const rs = y * stride
    const ps = (y - 1) * stride
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x]
      const left = x >= channels ? out[rs + x - channels] : 0
      const up = y > 0 ? out[ps + x] : 0
      const ul = y > 0 && x >= channels ? out[ps + x - channels] : 0
      let v
      if (filter === 0) v = cur
      else if (filter === 1) v = cur + left
      else if (filter === 2) v = cur + up
      else if (filter === 3) v = cur + ((left + up) >> 1)
      else if (filter === 4) {
        const p = left + up - ul
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - ul)
        v = cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul)
      } else throw new Error('未知 filter ' + filter)
      out[rs + x] = v & 0xff
    }
    rp += stride
  }
  return { width: w, height: h, channels, data: out }
}

/**
 * 调腾讯云人像分割，返回与原有协议兼容的 { ok, w, h, alpha }。
 * 返回的 ResultMask 是灰度 PNG（与原图同尺寸），解出来就是逐像素透明度。
 */
async function segmentByTencent(imageB64, srcW, srcH, opts) {
  // 内容审核与切图并行发起：总耗时 = 两者里较慢的那个，不是相加
  const modPromise = moderateImage(imageB64).catch(e => ({ skipped: true, reason: (e && e.message) || 'moderation error' }))
  const r = await tc3Call({ Image: imageB64, Scene: 'GEN' })
  const resp = r && r.Response
  if (!resp) throw new Error('腾讯云返回为空')
  if (resp.Error) throw new Error(resp.Error.Code + ': ' + resp.Error.Message)

  // 需要成品图：直接用腾讯云切好的前景图合成底色，边缘质量即腾讯云原厂
  if (opts && opts.bg && resp.ResultImage) {
    // 违规内容直接拒绝（审核未开通时 skipped，不阻断）
    const mod = await modPromise
    if (mod && mod.ok === false) {
      return { ok: false, code: 'BAD_CONTENT', error: '图片内容不合规，请更换照片' }
    }
    // 先做人像合理性校验：非人像照片直接拒绝，不让它进合成
    if (resp.ResultMask) {
      try {
        const chk = looksLikePortrait(
          decodePng(Buffer.from(resp.ResultImage, 'base64')),
          decodePng(Buffer.from(resp.ResultMask, 'base64'))
        )
        if (!chk.ok) {
          return { ok: false, code: 'NO_FACE', error: '请上传本人正面照片（' + chk.reason + '）' }
        }
      } catch (e) {
        console.warn('[segment] 人像校验跳过：', (e && e.message) || e)
      }
    }
    const outW = opts.outW || 295
    const outH = opts.outH || 413
    const jpg = composeOnBg(Buffer.from(resp.ResultImage, 'base64'), srcW, srcH, opts.bg, outW, outH)
    return { ok: true, ver: 'tencent-bda-composed', image: jpg.toString('base64'), w: outW, h: outH }
  }

  const rm = resp.ResultMask
  if (!rm) throw new Error('腾讯云未返回 ResultMask')

  const png = decodePng(Buffer.from(rm, 'base64'))
  const mw = png.width
  const mh = png.height
  if (!mw || !mh) throw new Error('遮罩尺寸为 0')

  // 取灰度（或 RGBA 的 α 通道）
  const ch = png.channels
  const at = p => (ch === 1 ? png.data[p] : ch === 2 ? png.data[p * 2] : ch === 3 ? png.data[p * 3] : png.data[p * 4 + 3])

  const tw = MASK_W
  const th = Math.max(2, Math.round((tw * mh) / mw))
  const out = Buffer.alloc(tw * th)
  let maxV = 0
  for (let y = 0; y < th; y++) {
    const sy = Math.min(mh - 1, Math.floor((y * mh) / th))
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(mw - 1, Math.floor((x * mw) / tw))
      const v = at(sy * mw + sx)
      if (v > maxV) maxV = v
      out[y * tw + x] = v
    }
  }
  if (maxV < 8) throw new Error('遮罩内容为空（maxV=' + maxV + '）')

  return { ok: true, ver: 'tencent-bda', w: tw, h: th, alpha: out.toString('base64') }
}

/** 统一入参：HTTP 触发时参数被包在 event.body（JSON 字符串）里 */
function readArgs(event) {
  let e = event || {}
  if (typeof e.body === 'string') {
    try { e = JSON.parse(e.body) || {} } catch (err) { e = {} }
  } else if (e.body && typeof e.body === 'object') {
    e = e.body
  }
  return e
}

exports.main = async event => {
  const args = readArgs(event)
  const useTencent = !!(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY)

  // 预热：腾讯云模式不需要加载本地模型，直接返回；
  // 本地模型模式才需要把 ONNX 会话拉起来。
  if (args && args.warmup) {
    if (useTencent) return { ok: true, warm: true, engine: 'tencent-bda' }
    try {
      await getSession()
      return { ok: true, warm: true, engine: 'local-onnx' }
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) }
    }
  }

  try {
    if (!args || !args.image) return { ok: false, error: 'missing image' }

    const buf = Buffer.from(args.image, 'base64')
    const dec = jpeg.decode(buf, { useTArray: true })
    if (!dec || !dec.width) return { ok: false, error: 'jpeg decode failed' }

    // 首选腾讯云人像分割（精度通常优于本地小模型）；失败自动回退本地模型
    if (useTencent) {
      try {
        const r = await segmentByTencent(args.image, dec.width, dec.height, { bg: args.bg, outW: args.outW, outH: args.outH })
        return r
      } catch (e) {
        console.warn('[segment] 腾讯云失败，回退本地模型：', (e && e.message) || e)
        // 继续走下面的本地推理
      }
    }

    const n = INPUT_SIZE
    const input = toNCHW(dec.data, dec.width, dec.height, n)

    const sess = await getSession()
    const feeds = {}
    feeds[sess.inputNames[0]] = new ort.Tensor('float32', input, [1, 3, n, n])
    const out = await sess.run(feeds)
    const prob = out[sess.outputNames[0]].data

    const total = n * n
    const gray = Buffer.alloc(total)
    let minV = 1
    let maxV = 0
    for (let i = 0; i < total; i++) {
      const v = prob[i]
      if (v < minV) minV = v
      if (v > maxV) maxV = v
      const p = v * 255
      gray[i] = p < 0 ? 0 : p > 255 ? 255 : Math.round(p)
    }

    if (maxV < 0.05) {
      return { ok: false, error: 'mask 全黑，检查归一化', range: [minV, maxV] }
    }

    return {
      ok: true,
      ver: 'fp32-' + n,
      size: n,
      w: n,
      h: n,
      alpha: gray.toString('base64'),
      range: [Number(minV.toFixed(3)), Number(maxV.toFixed(3))]
    }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
  }
}
