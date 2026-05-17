/**
 * 人工发布平台的占位上传服务。
 *
 * 这些渠道已经可以在面板里维护账号、包路径、截图和发布说明，但还没有接入
 * 官方自动上传 API。保留统一服务形态后，后续给 OPPO/vivo/360 等平台接接口时，
 * 只需要替换对应渠道的 uploader，不需要改路由层。
 *
 * @param {string} storeKey 平台 key。
 * @param {{action?: string}} options 上传动作。
 * @returns {Promise<object>} 统一上传响应。
 */
async function runManualStoreUpload(storeKey, options = {}) {
  const action = options.action || "precheck";
  return {
    ok: false,
    store: storeKey,
    action,
    message: `${storeKey} 暂未接入自动上传接口，请先使用该渠道配置中的本地包路径进行人工发布。`,
    missing: [],
    warnings: ["该渠道当前是人工发布或待接入状态。"],
    plannedFiles: [],
    updateFields: [],
  };
}

module.exports = {
  runManualStoreUpload,
};
