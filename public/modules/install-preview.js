import { requestJson } from './api.js';
import { elements } from './state.js';

/**
 * 渲染手机扫码安装预览区域。
 *
 * @param {object} preview 后端 /api/install-preview 返回的预览数据。
 * @returns {void}
 */
export function renderInstallPreview(preview) {
  elements.installPreviewPanel.innerHTML = '';

  const qr = document.createElement('img');
  qr.className = 'install-qr';
  qr.alt = '安装包目录二维码';
  // 不引入 npm 依赖，二维码图片使用轻量在线服务生成；URL 同时明文展示，离线时可手动输入。
  qr.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(preview.folderUrl || '')}`;

  const content = document.createElement('div');
  content.className = 'install-content';

  const info = document.createElement('div');
  info.className = 'install-info';
  info.textContent = preview.folderUrl
    ? `手机扫码访问：${preview.folderUrl}`
    : '未找到可用于手机访问的局域网地址。';

  const links = document.createElement('div');
  links.className = 'install-links';
  preview.packages.filter((item) => item.apk).forEach((item) => {
    const link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = `${item.name} (${item.code}) / ${item.apk.sizeText}`;
    links.appendChild(link);
  });

  content.append(info, links);
  elements.installPreviewPanel.append(qr, content);
}

/**
 * 刷新安装包扫码预览。
 *
 * @returns {Promise<object>} 后端返回的安装预览数据。
 */
export async function refreshInstallPreview() {
  const preview = await requestJson('/api/install-preview');
  renderInstallPreview(preview);
  return preview;
}
