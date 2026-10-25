/** 零碎工具 */

/** 屏幕信息，兼容老基础库 */
function winInfo() {
  try {
    return wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
  } catch (e) {
    return { windowWidth: 375, windowHeight: 667, pixelRatio: 2, statusBarHeight: 20 }
  }
}

/**
 * 隐私授权说明：
 * 不要用 wx.requirePrivacyAuthorize 做前置拦截。相册/相机这类隐私接口
 * 被调用时，微信自己会拉起同意弹窗；手动拦一层反而会在协议未配置时
 * 静默失败，用户看到的现象就是"点了没反应"。
 */

function toast(title, icon = 'none') {
  wx.showToast({ title, icon, duration: 1800 })
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v
}

module.exports = { winInfo, toast, clamp }
