/**
 * 本地图像处理引擎
 * ------------------------------------------------------------
 * 全部在手机端完成，不上传任何图片。包含三件事：
 *   1) detectHead    —— 基于肤色聚类估算头部位置，用于自动构图
 *   2) buildAlpha    —— 从边框采样背景色做连通泛洪，抠出人像 alpha
 *   3) applyBeauty   —— 可调美颜（美白 / 磨皮 / 红润），保边不糊五官
 *
 * 所有函数都直接操作 RGBA 的 Uint8ClampedArray，避免中间对象分配。
 */

/* ============================================================
   1. 肤色判定（YCbCr 椭圆 + RGB 约束，兼顾黄种人肤色）
   ============================================================ */
function isSkin(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  if (y < 55) return false
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  // Cr 下限取 136（教科书值是 133）：米白/米黄的墙面在 130~135，
  // 放宽会把墙当成人脸，宁严勿滥。
  if (cb < 74 || cb > 134 || cr < 136 || cr > 180) return false
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b)
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b)
  if (mx - mn < 11) return false          // 太灰，不是皮肤
  if (r < 62) return false
  if (r < g || g < b * 0.55) return false // 肤色 R 应明显高于 B
  if (r - b < 20) return false            // 米色墙面 R-B 只有十几
  return true
}

/* ============================================================
   2. 头部定位
   返回 { headTop, headH, headCenterX, faceW } （单位：像素，源图坐标系）
   ============================================================ */
function detectHead(data, w, h) {
  const step = Math.max(2, Math.round(Math.min(w, h) / 110))
  const cols = Math.floor(w / step)
  const rows = Math.floor(h / step)
  if (cols < 8 || rows < 8) return null

  const skin = new Uint8Array(cols * rows)
  let total = 0
  for (let ry = 0; ry < rows; ry++) {
    const y = ry * step
    for (let rx = 0; rx < cols; rx++) {
      const i = (y * w + rx * step) * 4
      if (isSkin(data[i], data[i + 1], data[i + 2])) {
        skin[ry * cols + rx] = 1
        total++
      }
    }
  }
  if (total < cols * rows * 0.015) return null

  // 每行肤色像素数
  const rowCount = new Int32Array(rows)
  for (let ry = 0; ry < rows; ry++) {
    let c = 0
    const base = ry * cols
    for (let rx = 0; rx < cols; rx++) c += skin[base + rx]
    rowCount[ry] = c
  }

  // 取第一条足够高的连续带（额头 → 颈部，颈部会在下面被截掉）
  const minRowH = Math.max(3, Math.round(rows * 0.06))
  const gate = Math.max(2, Math.round(cols * 0.05))
  let bands = []
  let s = -1
  for (let ry = 0; ry <= rows; ry++) {
    const on = ry < rows && rowCount[ry] >= gate
    if (on && s < 0) s = ry
    if (!on && s >= 0) {
      bands.push([s, ry - 1])
      s = -1
    }
  }
  const band = bands.find(b => b[1] - b[0] >= minRowH)
  if (!band) return null

  // 只用带子的上半部（脸部主体），避开脖子与衣领
  const top = band[0]
  const bottom = band[1]
  const bandH = bottom - top + 1

  /* 量脸宽：逐行量，取 85 分位。
     之前是所有行累计后再取列边界，等于只量到了「上半段最宽处」——
     而那一带通常是额头，被两侧头发一遮就特别窄，脸宽被算小，
     反推出来的头高也偏小，构图时就会把画面放得过大、头显得特别大。
     改成逐行取宽、再取分位数：既有脸颊最宽的地方，又不会被肩线拉偏。 */
  const measureEnd = top + Math.floor(bandH * 0.75)
  const widths = []
  for (let ry = top; ry <= measureEnd; ry++) {
    const rowBase = ry * cols
    let lo = -1
    let hi = -1
    for (let rx = 0; rx < cols; rx++) {
      if (skin[rowBase + rx]) {
        if (lo < 0) lo = rx
        hi = rx
      }
    }
    if (lo >= 0 && hi > lo) widths.push(hi - lo + 1)
  }
  if (!widths.length) return null
  widths.sort((a, b) => a - b)
  const pw = widths[Math.min(widths.length - 1, Math.floor(widths.length * 0.85))]

  const faceW = pw * step
  if (faceW < w * 0.06 || faceW > w * 0.94) return null

  // 水平中心仍用整段的稳定中值，比单取最宽那一行更稳
  let xMin = 1e9
  let xMax = -1
  for (let ry = top; ry <= measureEnd; ry++) {
    const rowBase = ry * cols
    for (let rx = 0; rx < cols; rx++) {
      if (skin[rowBase + rx]) {
        if (rx < xMin) xMin = rx
        if (rx > xMax) xMax = rx
      }
    }
  }
  if (xMax <= xMin) return null
  const headCenterX = ((xMin + xMax + 1) / 2) * step

  // 人体比例：脸宽 ≈ 头高的 0.72，即头高 ≈ 脸宽 × 1.39；
  // 皮肤上边界是发际线，头顶（含头发）还要再往上约 0.15 个头高。
  const faceTopY = top * step
  const headH = faceW * 1.39
  const headTop = Math.max(0, faceTopY - headH * 0.15)

  return { headTop, headH, headCenterX, faceW }
}

/* ============================================================
   3. 抠图：边框调色板 + 连通泛洪 + 收缩羽化
   protectRect: {x0,y0,x1,y1} 区域内的像素永不判为背景（保护人脸）
   ============================================================ */


/**
 * 背景色反解（标准 alpha un-premultiply，替代 suppressHalo/decontaminate）：
 * 半透明像素 = 前景*a + 背景*(1-a)。估计出背景色后按 a 反解出真实前景色，
 * 混进发丝的背景白被数学上减掉 —— 白圈彻底消失，且只扫一遍图。
 * 返回被压掉光晕的像素数。
 */
function unmixEdges(data, alpha, w, h) {
  const n = w * h
  let br = 0
  let bgc = 0
  let bb = 0
  let bc = 0
  const stepS = Math.max(1, Math.round(n / 4000))
  for (let p = 0; p < n; p += stepS) {
    if (alpha[p] < 20) {
      const i = p * 4
      br += data[i]; bgc += data[i + 1]; bb += data[i + 2]; bc++
    }
  }
  if (bc < 20) return 0
  br /= bc; bgc /= bc; bb /= bc

  for (let p = 0; p < n; p++) {
    const a = alpha[p]
    if (a === 0 || a >= 250) continue
    const af = Math.max(a / 255, 0.05)
    const i = p * 4
    const r = (data[i] - (1 - af) * br) / af
    const g = (data[i + 1] - (1 - af) * bgc) / af
    const b = (data[i + 2] - (1 - af) * bb) / af
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b
  }
  let hit = 0
  for (let p = 0; p < n; p++) {
    if (alpha[p] > 0 && alpha[p] < 30) { alpha[p] = 0; hit++ }
  }
  return hit
}

/**
 * 边缘微收紧：把「很淡的半透明」压掉。
 * 薄发丝会透出背景色，形成一圈很淡的光晕；这种像素对画面贡献很小，
 * 直接降低不透明度就能让它消失，而正常发丝（alpha 较高的）不受影响。
 */
function tightenEdge(alpha, w, h, offset, gamma) {
  const lo = offset === undefined ? 0.055 : offset
  const gm = gamma === undefined ? 1.35 : gamma
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i] / 255
    if (a <= 0) continue
    const t = (a - lo) / (1 - lo)
    alpha[i] = t <= 0 ? 0 : Math.round(255 * Math.pow(Math.min(1, t), gm))
  }
}


/**
 * 抑制背景透光：只削「明显比周围实心像素更亮」的半透明像素。
 * 薄发丝会透出浅色背景形成一圈光晕，这类像素亮度显著高于邻近的实心头发；
 * 正常的深色发丝不会被误伤 —— 所以不能一刀切按 alpha 压。
 * 返回被削的像素数，方便日志确认真的起作用了。
 */
function suppressHalo(data, alpha, w, h) {
  const n = w * h
  const mark = new Uint8Array(n)
  for (let y = 1; y < h - 1; y++) {
    const row = y * w
    for (let x = 1; x < w - 1; x++) {
      const p = row + x
      const a = alpha[p]
      if (a === 0 || a >= 245) continue
      const nbs = [p - 1, p + 1, p - w, p + w]
      let sum = 0
      let c = 0
      for (let k = 0; k < 4; k++) {
        const q = nbs[k]
        if (alpha[q] >= 245) {
          const j = q * 4
          sum += data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114
          c++
        }
      }
      if (!c) continue
      const i = p * 4
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      // 阈值从 30 放宽到 14：白边里很多像素只比头发亮十几级，
      // 之前 30 的阈值把它们放过了，白边就留了下来。
      if (lum > sum / c + 30) mark[p] = 1
    }
  }
  let hit = 0
  for (let p = 0; p < n; p++) {
    if (mark[p]) {
      alpha[p] = Math.round(alpha[p] * 0.3)
      if (alpha[p] < 26) alpha[p] = 0
      hit++
    }
  }
  return hit
}

/**
 * 边缘去色（对外复用）：半透明像素的 RGB 仍是背景那一侧的颜色（白），
 * 直接合成到彩色底上就是一圈白光晕 —— 头发边缘最明显。
 * 用邻近「完全不透明」像素的颜色替换它，形状不动，白边消失。
 */
function decontaminate(data, alpha, w, h) {
  // 优化版：只遍历「半透明」像素，多轮从实心区向外扩散。
  // alpha 上限从 245 放宽到 252：白边像素往往 alpha 已经接近实心（250+），
  // 之前 245 的门槛把它们挡在去色范围外，白边就留了下来。
  const n = w * h
  let cand = []
  for (let p = 0; p < n; p++) {
    const a = alpha[p]
    if (a > 0 && a < 245) cand.push(p)
  }
  const done = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (alpha[i] >= 245) done[i] = 1

  for (let pass = 0; pass < 8 && cand.length; pass++) {
    let changed = 0
    const next = []
    for (let k = 0; k < cand.length; k++) {
      const p = cand[k]
      if (done[p]) continue
      let r = 0
      let g = 0
      let b = 0
      let c = 0
      const n1 = p - 1
      const n2 = p + 1
      const n3 = p - w
      const n4 = p + w
      if (done[n1]) { const j = n1 * 4; r += data[j]; g += data[j + 1]; b += data[j + 2]; c++ }
      if (done[n2]) { const j = n2 * 4; r += data[j]; g += data[j + 1]; b += data[j + 2]; c++ }
      if (done[n3]) { const j = n3 * 4; r += data[j]; g += data[j + 1]; b += data[j + 2]; c++ }
      if (done[n4]) { const j = n4 * 4; r += data[j]; g += data[j + 1]; b += data[j + 2]; c++ }
      if (!c) { next.push(p); continue }
      const i = p * 4
      data[i] = r / c
      data[i + 1] = g / c
      data[i + 2] = b / c
      done[p] = 1
      changed++
    }
    if (!changed) break
    cand = next
  }
}


/**
 * 从 alpha 遮罩的宽度剖面估头部尺寸。
 * 原理：脖子是人像最窄的地方 —— 头顶到「头部最宽处之后宽度骤降的那一行」就是头高。
 * 比「外框高度 × 0.42」准得多：胸像/半身照的外框里含肩，固定比例会把头算小，
 * 结果放大过头、脸撑满整个相框。
 */

/**
 * 用「肤色下巴 − 头发顶」直接测头高。
 * 为什么不用固定比例：紧头照头占画面 68%、半身照只占 41%，任何固定系数都会错一边。
 * 为什么不用脖子收窄：长发会盖住脖子，宽度剖面永远不收窄，检测必然失败。
 * 肤色区域在人像上部最靠下的一行就是下巴，这是跨发型最稳的锚点。
 */
function measureHeadFromMask(data, alpha, w, h) {
  let top = -1
  let bottom = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let c = 0
    for (let x = 0; x < w; x++) if (alpha[row + x] > 128) c++
    if (c > 3) {
      if (top < 0) top = y
      bottom = y
    }
  }
  if (top < 0 || bottom - top < h * 0.15) return null

  const upper = Math.min(bottom, top + Math.round((bottom - top) * 0.55))
  const cnt = new Int32Array(h)
  let peak = 0
  for (let y = top; y <= upper; y++) {
    const row = y * w
    let c = 0
    for (let x = 0; x < w; x++) {
      const p = row + x
      if (alpha[p] <= 128) continue
      const i = p * 4
      if (isSkin(data[i], data[i + 1], data[i + 2])) c++
    }
    cnt[y] = c
    if (c > peak) peak = c
  }
  if (peak < 6) return null

  const thr = Math.max(8, peak * 0.25)
  let chin = -1
  for (let y = upper; y >= top; y--) {
    if (cnt[y] >= thr) { chin = y; break }
  }
  if (chin < 0) return null

  let headH = chin - top
  headH = Math.max(h * 0.08, Math.min(h * 0.7, headH))

  // 人脸横向中心：下巴那一行往上 30% 处，肤色像素的左右中点
  const bandY = Math.max(top, Math.min(upper, Math.round(chin - headH * 0.3)))
  let sx = 0
  let sn = 0
  for (let x = 0; x < w; x++) {
    const p = bandY * w + x
    if (alpha[p] <= 128) continue
    const i = p * 4
    if (isSkin(data[i], data[i + 1], data[i + 2])) { sx += x; sn++ }
  }
  const headCenterX = sn > 0 ? sx / sn : w / 2
  return { headTop: top, headH, headCenterX, subjectH: bottom - top + 1, chin, skinPeak: peak }
}

function silhouetteFromAlpha(alpha, w, h) {
  const width = new Int32Array(h)
  const left = new Int32Array(h)
  const right = new Int32Array(h)
  let top = -1
  let bottom = -1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let mn = w
    let mx = -1
    let c = 0
    for (let x = 0; x < w; x++) {
      if (alpha[row + x] > 128) {
        if (x < mn) mn = x
        if (x > mx) mx = x
        c++
      }
    }
    width[y] = c
    left[y] = mx < 0 ? 0 : mn
    right[y] = mx < 0 ? 0 : mx
    if (c > 3) {
      if (top < 0) top = y
      bottom = y
    }
  }
  if (top < 0 || bottom - top < h * 0.15) return null

  const subjectH = bottom - top + 1

  // 从上往下看：先变宽（头），再收窄（脖子），之后又被肩膀撑宽。
  // 所以「第一个收窄点」就是脖子 —— 不能用「最宽处」，肩膀永远比头宽。
  let runningMax = 0
  let neckY = -1
  let headMaxW = 0
  for (let y = top; y <= bottom; y++) {
    const wY = width[y]
    if (wY > runningMax) runningMax = wY
    // 比历史最宽窄 28% 以上、且正在收窄 → 认定进入脖子
    if (y > top + 6 && wY < runningMax * 0.72 && wY <= width[y - 1]) {
      neckY = y
      headMaxW = runningMax
      break
    }
  }

  let headH
  if (neckY > top + 6) {
    headH = (neckY - top) * 1.17
  } else {
    headH = subjectH * 0.34
  }
  headH = Math.max(h * 0.08, Math.min(h * 0.7, headH))

  // 头部横向中心：取头顶往下 1/4 处的左右中点
  const probeY = Math.min(bottom, top + Math.round(headH * 0.25))
  const headCenterX = (left[probeY] + right[probeY]) / 2
  return { headTop: top, headH, headCenterX, subjectH, neckY, maxW: headMaxW }
}

function buildAlpha(data, w, h, protectRect, guard, tolMul) {
  const mul = tolMul || 1
  const n = w * h
  const step = Math.max(1, Math.round(Math.min(w, h) / 150))

  /* ---- 3.1 采样边框（左列 / 右列 / 顶行；底行跳过，避免吃掉浅色衣服） ---- */
  const sr = []
  const sg = []
  const sb = []
  const push = (x, y) => {
    const i = (y * w + x) * 4
    sr.push(data[i]); sg.push(data[i + 1]); sb.push(data[i + 2])
  }
  // 取色环往里缩几个像素：手机照片边缘普遍有暗角，直接取最外圈会把「暗角」当成背景色，
  // 结果往内一走亮度超差，泛洪卡在边上，裁切后就露成一条白边。
  const ins = Math.max(2, Math.round(Math.min(w, h) * 0.012))
  for (let y = ins; y < h - ins; y += step) { push(ins, y); push(w - 1 - ins, y) }
  for (let x = ins; x < w - ins; x += step) push(x, ins)
  const sc = sr.length
  if (sc < 12) return { ok: false, reason: 'empty' }

  /* ---- 3.2 量化聚类成最多 4 个背景色 ---- */
  const buckets = new Map()
  for (let i = 0; i < sc; i++) {
    const key = ((sr[i] >> 4) << 8) | ((sg[i] >> 4) << 4) | (sb[i] >> 4)
    let b = buckets.get(key)
    if (!b) { b = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(key, b) }
    b.n++; b.r += sr[i]; b.g += sg[i]; b.b += sb[i]
  }
  const minCount = Math.max(3, sc * 0.05)
  const palette = []
  buckets.forEach(b => {
    if (b.n >= minCount) palette.push([b.r / b.n, b.g / b.n, b.b / b.n, b.n])
  })
  palette.sort((a, b) => b[3] - a[3])
  if (!palette.length) return { ok: false, reason: 'empty' }
  const pal = palette.slice(0, 4)

  /* ---- 3.3 由边框离散度推容差（背景越花，容差越大，但设上限防误吃） ---- */
  const m0 = pal[0]
  let varSum = 0
  for (let i = 0; i < sc; i++) {
    const dr = sr[i] - m0[0]
    const dg = sg[i] - m0[1]
    const db = sb[i] - m0[2]
    varSum += dr * dr + dg * dg + db * db
  }
  const sd = Math.sqrt(varSum / sc)
  const tol = Math.min(110, Math.max(28, 24 + sd * 1.5) * mul)

  /* ---- 3.4 皮肤保护图：画面内部的皮肤一律不当背景 ---- */
  const pr = protectRect
  const skinMask = new Uint8Array(n)
  for (let y = 2; y < h - 2; y++) {
    const row = y * w
    for (let x = 2; x < w - 2; x++) {
      const i = (row + x) * 4
      if (isSkin(data[i], data[i + 1], data[i + 2])) skinMask[row + x] = 1
    }
  }

  /* ---- 3.5 局部漂移泛洪 ----
     关键点：容差不再比「与全局背景色的距离」，而是比「与相邻背景像素的差值」。
     人的身体会挡住光，墙上通常有人的阴影，取样到的墙色和阴影处的墙色能差几十级，
     用全局容差永远跨不过去——之前的表现就是只有画面最上、最下两条被抠掉，
     脸周围一圈白墙完好无损。
     改成逐像素漂移后，亮度可以缓慢变化一路吃过去；而头发、衣服是硬边缘，
     一步色差就超过阈值，会被挡住。
  */
  const bg = new Uint8Array(n)
  const stack = new Int32Array(n)
  let sp = 0

  const base = pal[0]
  const driftCap = Math.min(180, 115 * mul) // 相对主背景色的累计漂移上限
  const stepTol = Math.min(28, 12 * mul) // 相邻两像素允许的色差
  const globalTol = Math.min(135, 78 * mul) // 直接和主背景色比较的容差

  const trySeed = p => {
    if (bg[p]) return
    const i = p * 4
    const d1 = Math.abs(data[i] - base[0])
    const d2 = Math.abs(data[i + 1] - base[1])
    const d3 = Math.abs(data[i + 2] - base[2])
    const m = d1 > d2 ? (d1 > d3 ? d1 : d3) : (d2 > d3 ? d2 : d3)
    // 种子放宽到 tol 的 1.8 倍：最外圈有暗角，用取色环的标准会一颗种子都点不着
    if (m > Math.min(210, tol * 1.8)) return
    bg[p] = 1
    stack[sp++] = p
  }
  for (let y = 0; y < h; y++) {
    trySeed(y * w)
    trySeed(y * w + w - 1)
  }
  for (let x = 0; x < w; x++) trySeed(x)

  const expand = (p, fi) => {
    if (bg[p]) return
    if (skinMask[p]) return
    if (pr) {
      const x = p % w
      const y = (p - x) / w
      if (x >= pr.x0 && x <= pr.x1 && y >= pr.y0 && y <= pr.y1) return
    }
    // 身体护栏：从下巴往下画一个梯形，罩住脖到肩的躯干。
    // 白衬衫配白墙时，衣服和墙同色，泛洪会一路穿进躯干把人掏空；
    // 有了这道护栏，躯干核心动不了，最多边缘差一点，不会变成"浮空的头"。
    // 脖子处收窄，所以颈侧的墙照样能抠掉，不会留白条。
    if (guard) {
      const x = p % w
      const y = (p - x) / w
      if (y >= guard.top) {
        const half = Math.min(guard.cap, guard.w0 + (y - guard.top) * guard.slope)
        if (Math.abs(x - guard.cx) <= half) return
      }
    }
    const i = p * 4
    const d1 = Math.abs(data[i] - data[fi])
    const d2 = Math.abs(data[i + 1] - data[fi + 1])
    const d3 = Math.abs(data[i + 2] - data[fi + 2])
    const step = d1 > d2 ? (d1 > d3 ? d1 : d3) : (d2 > d3 ? d2 : d3)

    const g1 = Math.abs(data[i] - base[0])
    const g2 = Math.abs(data[i + 1] - base[1])
    const g3 = Math.abs(data[i + 2] - base[2])
    const far = g1 > g2 ? (g1 > g3 ? g1 : g3) : (g2 > g3 ? g2 : g3)

    // 双判据，缺一不可的写法会裂：
    //  1) 和相邻背景像素接近 —— 顺着缓慢的明暗渐变一路吃过去（人物投在墙上的阴影）
    //  2) 本身就接近主背景色 —— 跨过墙上突然出现的明暗分界线（墙角、窗帘边、灯影）
    // 只用 1)，遇到硬分界就卡住；只用 2)，遇到渐变就够不着。真实照片两种都有。
    if (step > stepTol && far > globalTol) return
    if (far > driftCap) return

    bg[p] = 1
    stack[sp++] = p
  }

  while (sp > 0) {
    const p = stack[--sp]
    const x = p % w
    const fi = p * 4
    if (x > 0) expand(p - 1, fi)
    if (x < w - 1) expand(p + 1, fi)
    if (p >= w) expand(p - w, fi)
    if (p < n - w) expand(p + w, fi)
  }

  /* ---- 3.5.2 边缘去白边 ----
     头发和墙之间有一圈抗锯齿过渡像素，颜色是"浅灰"，既不够黑也不算纯墙。
     抠图时它们被判成人物保留下来，换到红底/蓝底上就成了一圈白边——
     这是纯色抠图最典型的瑕疵。
     做法：贴着背景、颜色又和背景接近的主体像素，本质是过渡色，直接剔掉。
     皮肤单独用 skinMask 保护，所以下颌、脖子不会被削。
  */
  const rimTol = 78
  for (let pass = 0; pass < 2; pass++) {
    const add = []
    for (let y = 1; y < h - 1; y++) {
      const row = y * w
      for (let x = 1; x < w - 1; x++) {
        const p = row + x
        if (bg[p] || skinMask[p]) continue
        if (!(bg[p - 1] || bg[p + 1] || bg[p - w] || bg[p + w])) continue
        const i = p * 4
        const d1 = Math.abs(data[i] - base[0])
        const d2 = Math.abs(data[i + 1] - base[1])
        const d3 = Math.abs(data[i + 2] - base[2])
        const m = d1 > d2 ? (d1 > d3 ? d1 : d3) : (d2 > d3 ? d2 : d3)
        if (m <= rimTol) add.push(p)
      }
    }
    if (!add.length) break
    for (let k = 0; k < add.length; k++) bg[add[k]] = 1
  }

  /* ---- 3.5.3 抠得太少直接判失败 ----
     证件照里人像通常占 30%~70%，背景怎么也该被吃掉 12% 以上。
     如果只抠掉边上一条（背景不是纯色、或者墙上有一道硬分界把连通切断了），
     宁可退回「原图」并告诉用户，也不要交付一张半成品——
     半成品的观感比"没换底色"差得多。
  */
  let bgCount = 0
  for (let p = 0; p < n; p++) if (bg[p]) bgCount++
  if (bgCount < n * 0.12) return { ok: false, reason: 'few' }

  /* ---- 3.6 主体面积校验 ---- */
  let subject = 0
  let x0 = w, y0 = h, x1 = 0, y1 = 0
  for (let p = 0; p < n; p++) {
    if (!bg[p]) {
      subject++
      const x = p % w
      const y = (p - x) / w
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  const ratio = subject / n
  if (ratio < 0.05 || ratio > 0.93) return { ok: false, reason: 'ratio' }

  /* ---- 3.6.2 用轮廓量头 ----
     只按皮肤宽度反推头高是不准的：两侧头发一遮，可见皮肤只剩额头那么宽，
     头高被算小，构图时画面放得过大，头就顶满画框了。
     轮廓不受发色影响，所以直接量：头顶 = 轮廓上沿，头下沿 = 脖子最窄处。
     量不到脖子（拍得太近）时，才退回按宽度比例估算。
  */
  let headTopS = y0
  let headHS = 0
  let headCXS = (x0 + x1) / 2
  const subjectH = Math.max(1, y1 - y0)
  const scanEnd = Math.min(h - 1, y0 + Math.floor(subjectH * 0.55))

  // 逐行量主体宽度
  const rw = []
  for (let y = y0; y <= scanEnd; y++) {
    const row = y * w
    let lo = -1
    let hi = -1
    for (let x = 0; x < w; x++) {
      if (!bg[row + x]) {
        if (lo < 0) lo = x
        hi = x
      }
    }
    if (lo < 0) continue
    rw.push({ y, wd: hi - lo + 1, cx: (lo + hi) / 2 })
  }

  if (rw.length > 4) {
    // 1) 找"头最宽处"。不能用全图最宽行——半身照里肩膀比头宽得多，
    //    会被肩膀带偏，头高反而量大了、头显得很小。
    //    头是第一个先变宽、再明显收窄的凸起，所以取"第一次收窄之前的峰值"。
    let runMax = 0
    let runMaxIdx = 0
    let headMaxIdx = -1
    for (let i = 0; i < rw.length; i++) {
      if (rw[i].wd > runMax) {
        runMax = rw[i].wd
        runMaxIdx = i
      } else if (i > 4 && rw[i].wd < runMax * 0.9) {
        headMaxIdx = runMaxIdx
        break
      }
    }
    if (headMaxIdx < 0) headMaxIdx = runMaxIdx
    headCXS = rw[headMaxIdx].cx

    // 2) 从头最宽处往下找最窄点 —— 那才是下巴/脖子。
    //    不能一遇到"变窄"就停：椭圆脸往下本来就一直在收窄，会把下巴当成脖子。
    let nn = -1
    let nnW = 1e9
    let foundRise = false
    for (let i = headMaxIdx + 1; i < rw.length; i++) {
      if (rw[i].wd < nnW) {
        nnW = rw[i].wd
        nn = i
      } else if (nn >= 0 && rw[i].wd > nnW * 1.35) {
        foundRise = true // 又开始变宽 = 到肩膀了
        break
      }
    }
    if (foundRise && nn > headMaxIdx) {
      headHS = (rw[nn].y - y0) * 1.06
      headCXS = (headCXS + rw[nn].cx) / 2
    } else {
      headHS = rw[headMaxIdx].wd * 1.25 // 量不到脖子（拍得太近），退回按头宽估
    }
  }
  const silhouette = headHS > 6 ? { headTop: headTopS, headH: headHS, headCenterX: headCXS } : null

  /* ---- 3.6.3 身体缺失检测 ----
     证件照场景里，人一定是顶到画面底部的（哪怕只拍到大腿）。
     如果底边整行都没有主体像素、而主体很早就结束了，说明衣服被当成背景吃掉了——
     白衬衫配白墙就是典型：衣服和墙的色差只有十几级，泛洪一路穿过去。
     这时不能装作成功，要让它自动退回「原图」，否则用户看到的是一个浮空的头。
  */
  let bottomHit = 0
  const bottomRow = (h - 1) * w
  for (let x = 0; x < w; x++) if (!bg[bottomRow + x]) bottomHit++
  const bodyMissing = bottomHit < w * 0.02 && y1 < h * 0.85

  /* ---- 3.7 生成 alpha：先 1px 收缩去掉彩色光晕，再羽化 ---- */
  const mask = new Uint8Array(n)
  for (let p = 0; p < n; p++) mask[p] = bg[p] ? 0 : 255

  const mask2 = mask.slice()
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x
      if (!mask[p]) continue
      if (!mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) mask2[p] = 0
    }
  }

  const blurred = blurMask(mask2, w, h, 2)
  // 对比度拉伸：主体内部保持 255，边缘只留约 1px 过渡。
  // 曲线比之前更陡一点，半透明带更窄——过渡带越宽，贴在红底上越像一圈光晕。
  const alpha = new Uint8ClampedArray(n)
  for (let p = 0; p < n; p++) {
    const v = (blurred[p] / 255 - 0.4) / 0.28
    alpha[p] = v <= 0 ? 0 : v >= 1 ? 255 : v * 255
  }

  /* ---- 3.8 边缘去色（去白边最关键的一步）----
     半透明像素的 RGB 仍然是被抠掉那侧的颜色（白墙）。把它直接合到红底上，
     看到的就是一圈白光晕——这就是"头发边上留了一圈白"的真正来源。
     做法：把每个半透明像素的颜色，换成周围"完全不透明"邻居的颜色。
     形状（alpha）一点不动，只是把错误的颜色换掉，所以不会削掉发丝。
  */
  for (let y = 1; y < h - 1; y++) {
    const row = y * w
    for (let x = 1; x < w - 1; x++) {
      const p = row + x
      const a = alpha[p]
      if (a === 0 || a >= 245) continue
      let r = 0
      let gg = 0
      let bb = 0
      let c = 0
      const nbs = [p - 1, p + 1, p - w, p + w]
      for (let k = 0; k < 4; k++) {
        const q = nbs[k]
        if (alpha[q] >= 245) {
          const j = q * 4
          r += data[j]
          gg += data[j + 1]
          bb += data[j + 2]
          c++
        }
      }
      if (!c) continue
      const i = p * 4
      data[i] = r / c
      data[i + 1] = gg / c
      data[i + 2] = bb / c
    }
  }

  return {
    ok: true,
    alpha,
    cleanPct: bgCount / n,
    bbox: { x0, y0, x1, y1 },
    bodyMissing,
    silhouette
  }
}

/** 灰度图可分离盒式模糊（用于 alpha 羽化） */
function blurMask(src, w, h, r) {
  const n = w * h
  const tmp = new Float32Array(n)
  const out = new Uint8ClampedArray(n)
  const win = r * 2 + 1

  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let x = -r; x <= r; x++) sum += src[row + (x < 0 ? 0 : x > w - 1 ? w - 1 : x)]
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / win
      const xa = x + r + 1 > w - 1 ? w - 1 : x + r + 1
      const xr = x - r < 0 ? 0 : x - r
      sum += src[row + xa] - src[row + xr]
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = -r; y <= r; y++) sum += tmp[(y < 0 ? 0 : y > h - 1 ? h - 1 : y) * w + x]
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / win
      const ya = y + r + 1 > h - 1 ? h - 1 : y + r + 1
      const yr = y - r < 0 ? 0 : y - r
      sum += tmp[ya * w + x] - tmp[yr * w + x]
    }
  }
  return out
}

/** RGB 可分离盒式模糊，返回 n*3 的数组 */
function blurRGB(data, w, h, r) {
  const n = w * h
  const tmp = new Float32Array(n * 3)
  const out = new Uint8ClampedArray(n * 3)
  const win = r * 2 + 1

  for (let y = 0; y < h; y++) {
    const row = y * w
    let a = 0, b = 0, c = 0
    for (let x = -r; x <= r; x++) {
      const xx = x < 0 ? 0 : x > w - 1 ? w - 1 : x
      const i = (row + xx) * 4
      a += data[i]; b += data[i + 1]; c += data[i + 2]
    }
    for (let x = 0; x < w; x++) {
      const o = (row + x) * 3
      tmp[o] = a / win; tmp[o + 1] = b / win; tmp[o + 2] = c / win
      const xa = (x + r + 1 > w - 1 ? w - 1 : x + r + 1)
      const xr = (x - r < 0 ? 0 : x - r)
      const ia = (row + xa) * 4, ir = (row + xr) * 4
      a += data[ia] - data[ir]
      b += data[ia + 1] - data[ir + 1]
      c += data[ia + 2] - data[ir + 2]
    }
  }
  for (let x = 0; x < w; x++) {
    let a = 0, b = 0, c = 0
    for (let y = -r; y <= r; y++) {
      const yy = y < 0 ? 0 : y > h - 1 ? h - 1 : y
      const o = (yy * w + x) * 3
      a += tmp[o]; b += tmp[o + 1]; c += tmp[o + 2]
    }
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 3
      out[o] = a / win; out[o + 1] = b / win; out[o + 2] = c / win
      const ya = (y + r + 1 > h - 1 ? h - 1 : y + r + 1)
      const yr = (y - r < 0 ? 0 : y - r)
      const oa = (ya * w + x) * 3, or_ = (yr * w + x) * 3
      a += tmp[oa] - tmp[or_]
      b += tmp[oa + 1] - tmp[or_ + 1]
      c += tmp[oa + 2] - tmp[or_ + 2]
    }
  }
  return out
}

/* ============================================================
   4. 美颜
   strength: 0 ~ 1
   证件照场景刻意压低上限：美白最多 16%、磨皮最多 62%，
   并且用「原图与模糊图的差值」做保边，眼睛眉毛嘴唇不会被糊掉。
   ============================================================ */
function applyBeauty(data, w, h, strength, cachedBlur) {
  const k = strength < 0 ? 0 : strength > 1 ? 1 : strength
  if (k < 0.02) return null

  const n = w * h
  const r = Math.round(1 + k * 2.2)          // 模糊半径 1~3
  // blur 结果可复用：切底色/拖动滑块时半径不变就不用重算（这是最贵的步骤）
  const blur = cachedBlur || blurRGB(data, w, h, r)

  const whiteK = 0.16 * k
  const smoothA = 0.62 * k
  const rosyK = 4.5 * k
  const edgeT0 = 22
  const edgeT1 = 62

  for (let p = 0; p < n; p++) {
    const i = p * 4
    const a0 = data[i + 3]
    if (a0 === 0) continue

    const r0 = data[i], g0 = data[i + 1], b0 = data[i + 2]
    const j = p * 3
    const dr = r0 - blur[j]
    const dg = g0 - blur[j + 1]
    const db = b0 - blur[j + 2]

    const diff = (Math.abs(dr) + Math.abs(dg) + Math.abs(db)) * 0.3333
    let keep = 1
    if (diff > edgeT0) {
      keep = 1 - (diff - edgeT0) / (edgeT1 - edgeT0)
      if (keep < 0) keep = 0
    }

    const sk = isSkin(r0, g0, b0) ? 1 : 0.2

    const a = smoothA * sk * keep
    let nr = r0 - dr * a
    let ng = g0 - dg * a
    let nb = b0 - db * a

    const wk = whiteK * sk
    nr += (255 - nr) * wk
    ng += (255 - ng) * wk
    nb += (255 - nb) * wk

    const rk = rosyK * sk
    nr += rk
    ng += rk * 0.28
    nb -= rk * 0.42

    data[i] = nr < 0 ? 0 : nr > 255 ? 255 : nr
    data[i + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng
    data[i + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb
  }
  return blur
}

/* ============================================================
   5. 构图换算
   把「头高占照片 66%、头顶留白 7.5%、水平居中」换算成
   drawImage 需要的 scale / offset
   ============================================================ */
function computeFrame(metrics, cutW, cutH, outW, outH, minZoom) {
  const cover = Math.max(outW / cutW, outH / cutH)
  const lo = minZoom || 1
  const floor = cover * lo

  let headTop, headH, headCenterX
  if (metrics) {
    headTop = metrics.headTop
    headH = metrics.headH
    headCenterX = metrics.headCenterX
  } else {
    // 兜底：整图当作人像，头部取上方 42%
    headTop = cutH * 0.06
    headH = cutH * 0.42
    headCenterX = cutW / 2
  }

  let s = (outH * 0.66) / Math.max(1, headH)
  // 只有抠图成功时才能缩到铺满以下：那时背景是透明的，缩下去空出来的是纯底色。
  // 没抠图（原图模式）必须保持铺满，否则会露出照片的矩形边。
  if (s < floor) s = floor
  if (s > cover * 8) s = cover * 8

  const dx = outW / 2 - headCenterX * s
  const dy = outH * 0.075 - headTop * s

  const zoom = s / cover
  const tx = dx - (outW - cutW * s) / 2
  const ty = dy - (outH - cutH * s) / 2

  return clampFrame({ zoom, tx, ty }, cutW, cutH, outW, outH, lo)
}

/** 限制平移范围；minZoom 缺省为 1（必须铺满） */
function clampFrame(f, cutW, cutH, outW, outH, minZoom) {
  const cover = Math.max(outW / cutW, outH / cutH)
  const lo = minZoom || 1
  let zoom = f.zoom
  if (zoom < lo) zoom = lo
  if (zoom > 8) zoom = 8 // 规格构图需要更大缩放空间，3.2 会把小人物照片卡成大头照

  const s = cover * zoom
  const dw = cutW * s
  const dh = cutH * s
  const maxX = Math.max(0, (dw - outW) / 2)
  const maxY = Math.max(0, (dh - outH) / 2)

  let tx = f.tx
  let ty = f.ty
  if (tx > maxX) tx = maxX
  if (tx < -maxX) tx = -maxX
  if (ty > maxY) ty = maxY
  if (ty < -maxY) ty = -maxY

  return { zoom, tx, ty }
}

module.exports = {
  isSkin,
  detectHead,
  buildAlpha,
  decontaminate,
  silhouetteFromAlpha,
  measureHeadFromMask,
  tightenEdge,
  suppressHalo,
  unmixEdges,
  applyBeauty,
  computeFrame,
  clampFrame,
  blurMask,
  blurRGB
}
