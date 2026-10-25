/**
 * 证件照尺寸规格表
 * ------------------------------------------------------------
 * 两种规格写法：
 *   mm: [宽, 高]  —— 按 300dpi 换算成像素（打印用）
 *   px: [宽, 高]  —— 报名系统直接给的像素要求（网络上传用）
 *
 * 说明：考试报名类各省各年度要求会有出入，px 规格都标了「以系统为准」，
 * 用户提交前最好自己核对一遍。mm 规格是国标/行业通行值，稳定。
 */

const DPI = 300

function mm2px(mm, dpi = DPI) {
  return Math.round((mm / 25.4) * dpi)
}

/** 底色可选（红/蓝/白为国内证件照三大标准底色） */
const BGS = [
  { id: 'white', name: '白底', color: '#FFFFFF' },
  { id: 'blue', name: '蓝底', color: '#438EDB' },
  { id: 'red', name: '红底', color: '#FF0000' },
  { id: 'gray', name: '浅灰', color: '#EFEFEF' },
  { id: 'deep', name: '深蓝', color: '#2A5CAB' }
]

/**
 * group: hot(首页常用) / doc(证件办理) / visa(签证) / exam(报名考试)
 * bg   : 默认底色
 */
const RAW = [
  // ---- 常用 ----
  { id: 'one', name: '一寸', group: 'hot', mm: [25, 35], bg: 'white', tag: '最常用', use: '简历 · 报名表 · 各类证件' },
  { id: 'two', name: '二寸', group: 'hot', mm: [35, 49], bg: 'white', tag: '常用', use: '毕业证 · 职称 · 档案' },
  { id: 'small1', name: '小一寸', group: 'hot', mm: [22, 32], bg: 'white', tag: '常用', use: '驾驶证 · 学生证' },
  { id: 'big1', name: '大一寸', group: 'hot', mm: [33, 48], bg: 'white', tag: '常用', use: '护照 · 港澳通行证' },
  { id: 'small2', name: '小二寸', group: 'hot', mm: [35, 45], bg: 'white', tag: '常用', use: '签证 · 部分考试' },
  { id: 'big2', name: '大二寸', group: 'hot', mm: [35, 53], bg: 'white', tag: '常用', use: '资格证 · 档案' },

  // ---- 证件办理 ----
  { id: 'idcard', name: '身份证', group: 'doc', mm: [26, 32], bg: 'white', use: '身份证 · 居住证' },
  { id: 'idcard_358', name: '身份证(358×441)', group: 'doc', px: [358, 441], bg: 'white', use: '多数办事系统要求的像素规格' },
  { id: 'social', name: '社保卡', group: 'doc', mm: [26, 32], bg: 'white', use: '社保卡 · 医保卡' },
  { id: 'social_358', name: '社保卡(358×441)', group: 'doc', px: [358, 441], bg: 'white', use: '多数系统要求的像素规格' },
  { id: 'driver', name: '驾驶证', group: 'doc', mm: [22, 32], bg: 'white', use: '机动车驾驶证' },
  { id: 'passport', name: '护照', group: 'doc', mm: [33, 48], bg: 'white', use: '中国普通护照' },
  { id: 'hkmacao', name: '港澳通行证', group: 'doc', mm: [33, 48], bg: 'white', use: '往来港澳通行证' },
  { id: 'taiwan', name: '台湾通行证', group: 'doc', mm: [33, 48], bg: 'white', use: '往来台湾通行证' },
  { id: 'teacher', name: '教师资格证', group: 'doc', mm: [25, 35], bg: 'white', use: '教资认定 · 注册' },
  { id: 'work', name: '工作证', group: 'doc', mm: [25, 35], bg: 'white', use: '员工工牌 · 门禁' },

  // ---- 签证 ----
  { id: 'visa_general', name: '通用签证', group: 'visa', mm: [35, 45], bg: 'white', use: '多数国家通用' },
  { id: 'visa_schengen', name: '申根签证', group: 'visa', mm: [35, 45], bg: 'white', use: '欧洲申根国' },
  { id: 'visa_us', name: '美国签证', group: 'visa', mm: [51, 51], bg: 'white', use: '2×2 英寸方图' },
  { id: 'visa_jp', name: '日本签证', group: 'visa', mm: [45, 45], bg: 'white', use: '45×45 方图' },
  { id: 'visa_kr', name: '韩国签证', group: 'visa', mm: [35, 45], bg: 'white', use: '35×45' },
  { id: 'visa_uk', name: '英国签证', group: 'visa', mm: [35, 45], bg: 'white', use: '35×45' },

  // ---- 报名考试（像素规格，以报名系统为准） ----
  { id: 'exam_ky', name: '考研报名', group: 'exam', px: [480, 640], bg: 'white', use: '3:4 · 以系统为准' },
  { id: 'exam_jz', name: '教资报名', group: 'exam', px: [295, 413], bg: 'white', use: '3:4 · 以系统为准' },
  { id: 'exam_cet', name: '四六级', group: 'exam', px: [240, 320], bg: 'white', use: '3:4 · 以系统为准' },
  { id: 'exam_pth', name: '普通话测试', group: 'exam', px: [390, 567], bg: 'white', use: '3:4 · 以系统为准' }
]

function decorate(item) {
  if (item.px) {
    const [w, h] = item.px
    return Object.assign({}, item, {
      wmm: null,
      hmm: null,
      pxW: w,
      pxH: h,
      dpi: null,
      pxText: `${w} × ${h} px`,
      mmText: `${w} × ${h} px`,
      ratio: w / h,
      isPixel: true
    })
  }
  const [wmm, hmm] = item.mm
  const dpi = item.dpi || DPI
  const w = mm2px(wmm, dpi)
  const h = mm2px(hmm, dpi)
  return Object.assign({}, item, {
    wmm,
    hmm,
    pxW: w,
    pxH: h,
    dpi,
    mmText: `${wmm} × ${hmm} mm`,
    pxText: `${w} × ${h} px`,
    ratio: wmm / hmm,
    isPixel: false
  })
}

const SIZES = RAW.map(decorate)

const HOT = SIZES.filter(s => s.group === 'hot')

const GROUPS = ['doc', 'visa', 'exam'].map(key => {
  const meta = {
    doc: { title: '证件办理', note: '国标尺寸' },
    visa: { title: '签证', note: '按国家' },
    exam: { title: '报名考试', note: '按系统要求' }
  }[key]
  return {
    key,
    title: meta.title,
    note: meta.note,
    items: SIZES.filter(s => s.group === key)
  }
})

function findSize(id) {
  return SIZES.find(s => s.id === id) || SIZES[0]
}

function findBg(id) {
  return BGS.find(b => b.id === id) || BGS[0]
}

/**
 * 自定义尺寸：用户在首页自己填宽高
 * unit: 'mm' | 'px'
 */
function buildCustomSize(w, h, unit) {
  const W = Math.max(1, Math.round(Number(w) || 0))
  const H = Math.max(1, Math.round(Number(h) || 0))
  const isMm = unit !== 'px'
  const pxW = isMm ? mm2px(W) : W
  const pxH = isMm ? mm2px(H) : H
  return {
    id: 'custom',
    name: '自定义',
    group: 'custom',
    bg: 'white',
    use: '自填尺寸',
    isPixel: !isMm,
    wmm: isMm ? W : null,
    hmm: isMm ? H : null,
    pxW,
    pxH,
    dpi: isMm ? DPI : null,
    mmText: isMm ? `${W} × ${H} mm` : `${W} × ${H} px`,
    pxText: `${pxW} × ${pxH} px`,
    ratio: pxW / pxH
  }
}

module.exports = { SIZES, HOT, GROUPS, BGS, findSize, findBg, buildCustomSize, mm2px, DPI }
