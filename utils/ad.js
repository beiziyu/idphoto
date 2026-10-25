/**
 * 广告位封装
 * ------------------------------------------------------------
 * 现在：enabled = false，所有方法直接放行，用户零打扰。
 * 以后：在微信公众平台「流量主」创建广告位，把 unitId 填进来、
 *      enabled 改成 true，就会自动开始展示，无需改动业务代码。
 *
 * 流量主开通条件（2026）：小程序累计独立访客 UV ≥ 500，
 * 且无违规记录。开通后建议先只挂「激励视频」和「插屏」，
 * 别挂 Banner —— 证件照是"用完就走"的高意图场景，Banner 会拉低体验。
 */

const AD = {
  enabled: false,
  // 激励视频：用户主动看完可解锁「高清无损导出」等权益
  rewardedUnitId: '',
  // 插屏：保存成功后偶尔出现
  interstitialUnitId: '',
  // Banner：默认不用
  bannerUnitId: '',
  // 每保存 N 次弹一次插屏（避免骚扰）
  interstitialEvery: 4
}

let saveCount = 0

/** 保存成功后的插屏，节流展示 */
function maybeInterstitial() {
  if (!AD.enabled || !AD.interstitialUnitId || !wx.createInterstitialAd) return
  saveCount++
  if (saveCount % AD.interstitialEvery !== 0) return
  try {
    const ad = wx.createInterstitialAd({ adUnitId: AD.interstitialUnitId })
    ad.onError(() => {})
    ad.show().catch(() => {})
  } catch (e) {}
}

module.exports = { AD, maybeInterstitial }
