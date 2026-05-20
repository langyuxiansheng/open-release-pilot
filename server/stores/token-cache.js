const crypto = require("crypto");

const DEFAULT_EXPIRY_SKEW_MS = 60_000;
const tokenCache = new Map();
const pendingRequests = new Map();

/**
 * 生成不会暴露密钥明文的缓存 key。
 *
 * token 不能只按平台缓存，因为同一面板可能管理多个项目或多套 API Client。
 * 这里用关键配置做 SHA256 指纹，既能隔离不同账号，又不会把密钥写到内存 key 文本里。
 *
 * @param {string} storeKey 平台 key。
 * @param {Array<string|number|boolean|undefined|null>} parts 参与隔离缓存的配置字段。
 * @returns {string} 缓存 key。
 */
function buildTokenCacheKey(storeKey, parts) {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(parts.map((item) => String(item ?? ""))))
    .digest("hex");
  return `${storeKey}:${digest}`;
}

/**
 * 读取未过期的内存 token。
 *
 * @param {string} cacheKey buildTokenCacheKey 返回的 key。
 * @returns {object|null} 缓存条目；过期或不存在时返回 null。
 */
function getCachedToken(cacheKey) {
  const entry = tokenCache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() >= entry.expiresAt) {
    tokenCache.delete(cacheKey);
    return null;
  }
  return entry;
}

/**
 * 把 expires_in 或绝对时间转换为本地过期时间。
 *
 * OPPO 返回的是秒级绝对时间戳，华为/荣耀通常返回剩余秒数；调用方用
 * mode 明确语义，避免把绝对时间误当成剩余时长。
 *
 * @param {number|string|undefined} value 平台返回的过期字段。
 * @param {"ttl"|"epochSeconds"} mode ttl 表示剩余秒数；epochSeconds 表示秒级时间戳。
 * @param {number} skewMs 提前失效的保护时间。
 * @returns {number} 毫秒级过期时间戳。
 */
function computeExpiresAt(value, mode = "ttl", skewMs = DEFAULT_EXPIRY_SKEW_MS) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now() + 10 * 60 * 1000;
  const rawExpiresAt = mode === "epochSeconds" ? numeric * 1000 : Date.now() + numeric * 1000;
  return Math.max(Date.now(), rawExpiresAt - skewMs);
}

/**
 * 获取 token，并在未过期时复用缓存。
 *
 * 同一个 cacheKey 如果同时触发多个业务请求，只允许第一个请求真实刷新 token，
 * 其它请求等待同一个 Promise。刷新失败时不会污染已有缓存，业务会拿到原始错误。
 *
 * @param {string} cacheKey 缓存 key。
 * @param {() => Promise<object>} fetcher 真实获取 token 的函数。
 * @returns {Promise<object>} token 结果。
 */
async function getOrRefreshToken(cacheKey, fetcher) {
  const cached = getCachedToken(cacheKey);
  if (cached) return { ...cached.value, fromCache: true };

  if (pendingRequests.has(cacheKey)) {
    const value = await pendingRequests.get(cacheKey);
    return { ...value, fromCache: true };
  }

  const request = (async () => {
    const fresh = await fetcher();
    tokenCache.set(cacheKey, {
      value: fresh,
      expiresAt: fresh.expiresAt || 0,
      cachedAt: Date.now(),
    });
    return fresh;
  })();

  pendingRequests.set(cacheKey, request);
  try {
    return { ...(await request), fromCache: false };
  } finally {
    pendingRequests.delete(cacheKey);
  }
}

/**
 * 清理某个 token 缓存。
 *
 * 目前主要给后续遇到 401/10003 这类 token 失效错误时使用。
 *
 * @param {string} cacheKey 缓存 key。
 * @returns {void}
 */
function clearCachedToken(cacheKey) {
  tokenCache.delete(cacheKey);
  pendingRequests.delete(cacheKey);
}

module.exports = {
  buildTokenCacheKey,
  clearCachedToken,
  computeExpiresAt,
  getOrRefreshToken,
};
