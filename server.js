// 兼容旧启动命令：node tools/release-panel/server.js
// 实际服务已拆到 server/ 目录，后续新增模块时不要继续把逻辑堆回这个入口文件。
require("./server/app");
