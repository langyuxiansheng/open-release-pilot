const { PORT } = require("./config");
const { getLocalIPv4Addresses } = require("./utils");

/**
 * 生成发布面板的本机访问地址和局域网访问地址。
 *
 * @returns {{localUrl: string, lanUrls: string[], primaryUrl: string}} 访问地址集合，primaryUrl 优先使用局域网地址。
 */
function getAccessUrls() {
  const localUrl = `http://127.0.0.1:${PORT}`;
  const lanUrls = getLocalIPv4Addresses().map((address) => `http://${address}:${PORT}`);
  return {
    localUrl,
    lanUrls,
    primaryUrl: lanUrls[0] || localUrl,
  };
}

module.exports = {
  getAccessUrls,
};
