import { requestJson } from "./api.js";
import { appendLog } from "./log.js";
import { OPPO_CATEGORIES } from "./oppo-categories.js";
import { elements, state } from "./state.js";
import { runButtonAction, showToast } from "./ui.js";

let activeFilePicker = null;
let activeRefreshStatus = null;

/**
 * 渲染 Android 应用商店发布配置。
 *
 * 配置由服务端 schemas 驱动：新增平台或字段时优先改 server.js 的 schema，
 * 前端会根据 type 自动生成输入框，不需要为每个平台写一套表单。
 *
 * @param {object} storeConfig 后端返回的商店配置上下文。
 * @returns {void}
 */
export function renderStores(storeConfig, options = {}) {
  elements.storeConfig.innerHTML = "";
  const refreshStatus = options.refreshStatus;
  if (typeof refreshStatus === "function") activeRefreshStatus = refreshStatus;
  // 老版本接口没有 platforms 字段时，用 schemas 的 key 兜底，保证页面不白屏。
  const platforms = storeConfig.platforms || Object.keys(storeConfig.schemas).map((key) => ({ key, name: key }));
  state.activeStoreKey ||= platforms[0]?.key || "";

  const configLabel = document.createElement("div");
  configLabel.className = "config-path";
  configLabel.textContent = storeConfig.usingLocalConfig ? `正在使用本地配置：${storeConfig.path}` : `当前加载示例配置，保存后会写入：${storeConfig.localPath}`;
  elements.storeConfig.appendChild(configLabel);

  const tabs = document.createElement("div");
  tabs.className = "store-tabs";
  platforms.forEach((platform) => {
    const values = storeConfig.stores[platform.key] || {};
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = `store-tab ${platform.key === state.activeStoreKey ? "active" : ""} ${values.enabled ? "enabled" : ""}`;
    tab.textContent = platform.name;
    tab.title = `${platform.code || platform.key} / ${values.enabled ? "已启用" : "未启用"}`;
    tab.addEventListener("click", () => {
      // 切 tab 时只重绘上传配置区域，不重新请求接口，避免覆盖用户正在编辑的其它区块。
      state.activeStoreKey = platform.key;
      renderStores(state.status.storeConfig);
    });
    tabs.appendChild(tab);
  });
  elements.storeConfig.appendChild(tabs);

  const activePlatform = platforms.find((platform) => platform.key === state.activeStoreKey) || platforms[0];
  if (!activePlatform) return;

  // 当前平台的字段和值分开读取：schema 定义字段展示和值类型，stores 保存用户本机配置。
  const fields = storeConfig.schemas[activePlatform.key] || [];
  const values = storeConfig.stores[activePlatform.key] || {};
  const card = document.createElement("section");
  card.className = "store-card";
  card.dataset.store = activePlatform.key;

  const header = document.createElement("div");
  header.className = "store-card-header";
  const title = document.createElement("strong");
  title.textContent = `${activePlatform.name} (${activePlatform.code || activePlatform.key})`;
  const stateLabel = document.createElement("span");
  stateLabel.textContent = `${values.enabled ? "已启用" : "未启用"} / ${getUploadSupportLabel(activePlatform.uploadSupport)}`;
  header.append(title, stateLabel);
  card.appendChild(header);

  const meta = document.createElement("div");
  meta.className = "field-note";
  meta.textContent = `渠道值：${activePlatform.code || "-"}；目录：${activePlatform.channelDir || "-"}。这里只配置发布平台，是否实际打包仍由 scripts/build_android_channels.sh 控制。`;
  card.appendChild(meta);

  fields.forEach((field) => {
    card.appendChild(createStoreField(activePlatform, field, getStoreFieldValue(activePlatform.key, field, values)));
  });

  if (activePlatform.key === "huawei") {
    // 华为 Connect API 是分步骤流程，不适合只靠顶部“执行上传”按钮。
    // 这里把每一步单独展示，让用户明确知道当前点击会调用哪个外部接口。
    card.appendChild(createHuaweiStepPanel(activeRefreshStatus));
  }

  if (activePlatform.key === "xiaomi") {
    // 小米自动发布虽然只有一个 /dev/push 提交入口，但前置查询和分类接口
    // 对配置排查很有用，因此也按步骤展示，避免用户只看到“上传失败”。
    card.appendChild(createXiaomiStepPanel(activeRefreshStatus));
  }

  if (activePlatform.key === "honor") {
    // 荣耀 API 传包服务是多步骤链路：鉴权、查 APPID、上传 APK、绑定文件、可选提审。
    // 这里保留独立步骤面板，让用户知道“执行发布”会触发完整后台流程。
    card.appendChild(createHonorStepPanel(activeRefreshStatus));
  }

  if (activePlatform.key === "oppo") {
    // OPPO API 传包需要先拿 token 和一次性文件上传地址，再发布版本并查询任务状态。
    // 这里和华为/荣耀一样拆成步骤，方便定位是鉴权、上传还是发布字段问题。
    card.appendChild(createOppoStepPanel(activeRefreshStatus));
  }

  if (activePlatform.key === "vivo") {
    // vivo 文件上传方式是“查询详情 -> 上传 APK 得到流水号 -> 同步更新 -> 查询任务”。
    // 这里把流水号和任务状态交给后端保存，前端只展示用户能操作的步骤。
    card.appendChild(createVivoStepPanel(activeRefreshStatus));
  }

  card.appendChild(createStoreDangerPanel(activePlatform, activeRefreshStatus));

  elements.storeConfig.appendChild(card);
  updateAllStoreFieldVisibility(activePlatform.key);
}

/**
 * 读取字段展示值，并兼容早期字段别名。
 *
 * 小米文档当前使用 appInfo.brief 作为“一句话简介”，早期面板曾保存为
 * shortDesc。这里在渲染时兜底读取旧值，避免升级后用户看起来像配置丢失。
 *
 * @param {string} storeKey 平台 key。
 * @param {object} field 字段 schema。
 * @param {object} values 当前平台配置。
 * @returns {unknown} 展示值。
 */
function getStoreFieldValue(storeKey, field, values) {
  if (storeKey === "xiaomi" && field.key === "brief") return values.brief ?? values.shortDesc;
  if (storeKey === "oppo" && field.key === "secondCategoryId" && !values.secondCategoryId && values.thirdCategoryId) {
    return findOppoSecondCategoryByThirdId(values.thirdCategoryId)?.id ?? values.secondCategoryId;
  }
  return values[field.key];
}

/**
 * 把服务端的平台能力标识转换成用户能理解的发布能力文案。
 *
 * api-update 专门用于应用宝这类“只支持已上线应用更新”的接口；
 * 这样界面不会把它误描述成完整的新应用上传能力。
 *
 * @param {string} support 服务端 STORE_PLATFORMS 中的 uploadSupport。
 * @returns {string} 展示在渠道 tab 详情里的能力说明。
 */
function getUploadSupportLabel(support) {
  if (support === "api") return "接口上传";
  if (support === "api-update") return "接口更新";
  if (support === "api-pending") return "接口预留";
  return "人工或待接入";
}

/**
 * 根据 schema 创建单个商店配置字段。
 *
 * 支持类型：
 * section 只渲染分组说明，不参与保存；checkbox 布尔开关；
 * segmented 渲染成按钮组，适合安装方式这类少量互斥选项；
 * number 保存时转为 Number；xiaomi-category 渲染成官方分类下拉框；
 * oppo-category-second / oppo-category-third 渲染成本地 OPPO 分类联动下拉；
 * list 多行文本转数组；
 * release-notes 提供“引用全局更新日志”按钮；textarea/password/text 原样保存字符串。
 *
 * @param {object} platform 当前平台配置。
 * @param {object} field 字段 schema。
 * @param {unknown} value 字段当前值。
 * @returns {HTMLElement} 字段表单 DOM。
 */
function createStoreField(platform, field, value) {
  const storeKey = platform.key;
  const wrapper = document.createElement("div");
  wrapper.className = `store-field ${field.type === "checkbox" ? "checkbox" : ""} ${field.type === "section" ? "section-field" : ""}`;
  wrapper.dataset.fieldKey = field.key;
  if (field.visibleWhen) {
    wrapper.dataset.visibleWhenKey = field.visibleWhen.key;
    wrapper.dataset.visibleWhenEquals = String(field.visibleWhen.equals);
  }

  const inputId = `store-${storeKey}-${field.key}`;
  const label = document.createElement("label");
  label.htmlFor = inputId;
  label.textContent = field.label;

  if (field.type === "section") {
    // section 只承担表单分组说明，不写入当前项目的商店配置。
    // 复杂平台接口字段很多时，分组能让维护者按接口路由快速定位参数。
    const heading = document.createElement("strong");
    heading.textContent = field.label;
    const note = document.createElement("div");
    note.className = "field-note";
    note.textContent = field.note || "";
    wrapper.append(heading, note);
    return wrapper;
  }

  const input = isMultilineStoreField(field) ? document.createElement("textarea") : document.createElement("input");
  input.id = inputId;
  input.dataset.store = storeKey;
  input.dataset.key = field.key;
  input.dataset.type = field.type;

  if (field.type === "checkbox") {
    input.type = "checkbox";
    input.checked = Boolean(value);
    wrapper.append(input, label);
  } else {
    // textarea 的 type 是浏览器只读属性，只有真正的 input 才能设置 type。
    // 这里用 tagName 判断，避免 textarea/list/release-notes 字段在切换渠道 tab 时抛错。
    if (input.tagName === "INPUT") {
      input.type = field.type === "password" ? "password" : field.type === "number" ? "number" : "text";
    }
    input.value = isListValueField(field) ? normalizeListFieldValue(value) : (value ?? "");
    if (field.type === "xiaomi-category") {
      wrapper.append(label, createXiaomiCategoryField(field, input, value));
    } else if (field.type === "oppo-category-second") {
      wrapper.append(label, createOppoSecondCategoryField(storeKey, field, input, value));
    } else if (field.type === "oppo-category-third") {
      wrapper.append(label, createOppoThirdCategoryField(storeKey, field, input, value));
    } else if (field.type === "segmented") {
      wrapper.append(label, createSegmentedField(field, input, value));
    } else if (field.type === "release-notes") {
      // 渠道发布说明是独立字段。按钮只把全局更新日志复制到当前 textarea，
      // 不建立自动同步关系，避免用户后续单独调整渠道文案时被覆盖。
      const labelRow = document.createElement("div");
      labelRow.className = "field-label-row";
      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "field-inline-action";
      copyButton.textContent = "引用全局更新日志";
      copyButton.addEventListener("click", () => {
        input.value = elements.releaseNotes.value || "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      labelRow.append(label, copyButton);
      wrapper.append(labelRow, input);
    } else if (field.type === "password") {
      // 密钥类字段默认隐藏，但本地调试发布接口时经常需要核对复制结果。
      // 只切换 input.type，不改 value 和 data-*，保存逻辑仍然按原输入框读取。
      const secretRow = document.createElement("div");
      secretRow.className = "secret-input-row";
      const toggleButton = document.createElement("button");
      toggleButton.type = "button";
      toggleButton.className = "secret-toggle-button";
      toggleButton.textContent = "显示";
      toggleButton.setAttribute("aria-label", `显示${field.label}`);
      toggleButton.addEventListener("click", () => {
        const shouldShow = input.type === "password";
        input.type = shouldShow ? "text" : "password";
        toggleButton.textContent = shouldShow ? "隐藏" : "显示";
        toggleButton.setAttribute("aria-label", `${shouldShow ? "隐藏" : "显示"}${field.label}`);
      });
      secretRow.append(input, toggleButton);
      wrapper.append(label, secretRow);
    } else if (isPathField(field)) {
      // APK、截图、资质文件等路径字段仍然允许手动编辑；选择按钮只是把本机文件路径写入输入框。
      // 每个平台 tab 只保存自己的 stores[storeKey]，所以不同渠道可以选择不同安装包。
      const pathRow = document.createElement("div");
      pathRow.className = field.type === "list" ? "store-path-list-row" : "store-path-input-row";
      const pickButton = document.createElement("button");
      pickButton.type = "button";
      pickButton.className = "store-path-picker-button";
      pickButton.textContent = isListValueField(field) ? "添加文件" : getPathPickerButtonText(field);
      pickButton.addEventListener("click", () => openStoreFilePicker(platform, field, input));
      pathRow.append(input, pickButton);
      wrapper.append(label, pathRow);
      if (isImagePathField(field) || isListValueField(field)) wrapper.appendChild(createPathPreview(field, input));
    } else {
      wrapper.append(label, input);
    }
  }

  const note = document.createElement("div");
  note.className = "field-note";
  note.textContent = field.note || "";
  wrapper.appendChild(note);
  applyStoreFieldVisibility(wrapper);
  input.addEventListener("input", () => updateDependentStoreFields(storeKey, field.key, input.value));
  input.addEventListener("change", () => updateDependentStoreFields(storeKey, field.key, input.value));
  if (isApkPathField(field)) {
    // APK 路径可以手动输入，也可以通过文件选择器写入。
    // 统一监听 change 后触发后端解析，保证两种操作都会自动回填 versionCode。
    input.addEventListener("change", () => {
      autofillApkInfoForStore(platform, field, input).catch((error) => {
        appendLog({ time: new Date().toISOString(), line: error.message || "APK 信息解析失败" });
      });
    });
  }
  return wrapper;
}

/**
 * 创建分段按钮字段。
 *
 * 分段按钮本质上仍然通过一个隐藏 input 保存值，所以 collectStoreConfig
 * 不需要知道它的 DOM 细节，仍按 data-store/data-key/data-type 收集。
 *
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement} input 隐藏输入框。
 * @param {unknown} value 当前字段值。
 * @returns {HTMLElement} 分段按钮容器。
 */
function createSegmentedField(field, input, value) {
  const group = document.createElement("div");
  group.className = "store-segmented";
  input.type = "hidden";
  input.dataset.valueType = field.valueType || "string";

  const defaultValue = value === undefined || value === null || value === "" ? (field.options?.[0]?.value ?? "") : value;
  input.value = String(defaultValue);

  (field.options || []).forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "store-segmented-option";
    button.textContent = option.label;
    button.dataset.value = String(option.value);
    button.setAttribute("aria-pressed", String(String(option.value) === input.value));
    button.addEventListener("click", () => {
      input.value = String(option.value);
      updateSegmentedActiveState(group, input.value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    group.appendChild(button);
  });
  updateSegmentedActiveState(group, input.value);
  group.appendChild(input);
  return group;
}

/**
 * 创建小米官方分类下拉框。
 *
 * 分类列表来自用户主动点击“查询分类”后的 storeStates.xiaomi.categories；
 * 选择值仍然写入隐藏 input，因此保存配置和普通字段一致，下次打开会按已保存
 * 的 stores.xiaomi.category 自动选中。
 *
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement} input 隐藏输入框。
 * @param {unknown} value 当前分类 ID。
 * @returns {HTMLElement} 分类选择 DOM。
 */
function createXiaomiCategoryField(field, input, value) {
  const box = document.createElement("div");
  box.className = "store-select-field";
  input.type = "hidden";
  input.dataset.type = field.type;
  input.dataset.valueType = field.valueType || "number";
  input.value = value === undefined || value === null ? "" : String(value);

  const categories = getXiaomiCategories();
  const select = document.createElement("select");
  select.className = "store-category-select";
  select.disabled = categories.length === 0;

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = categories.length === 0 ? "请先点击下方“查询分类”" : "请选择分类";
  select.appendChild(empty);

  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = String(category.id);
    option.textContent = `${category.name}（${category.id}）`;
    option.selected = String(value || "") === String(category.id);
    select.appendChild(option);
  });

  select.addEventListener("change", () => {
    input.value = select.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  box.append(select, input);
  return box;
}

/**
 * 创建 OPPO 二级分类下拉框。
 *
 * OPPO 分类表来自官方“资源分类对照表”，数据已固化在 oppo-categories.js。
 * 选择二级分类时会同步刷新同一表单内的三级分类，避免二级/三级 ID 不匹配。
 *
 * @param {string} storeKey 平台 key。
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement} input 隐藏输入框。
 * @param {unknown} value 当前二级分类 ID。
 * @returns {HTMLElement} 分类选择 DOM。
 */
function createOppoSecondCategoryField(storeKey, field, input, value) {
  const box = document.createElement("div");
  box.className = "store-select-field";
  input.type = "hidden";
  input.dataset.type = field.type;
  input.dataset.valueType = field.valueType || "number";
  input.value = value === undefined || value === null ? "" : String(value);

  const select = document.createElement("select");
  select.className = "store-category-select";
  select.dataset.store = storeKey;
  select.dataset.categoryRole = "oppo-second";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "请选择二级分类";
  select.appendChild(empty);

  OPPO_CATEGORIES.forEach((category) => {
    const option = document.createElement("option");
    option.value = String(category.id);
    option.textContent = `${category.primaryName}/${category.name}（${category.id}）`;
    option.selected = String(input.value || "") === String(category.id);
    select.appendChild(option);
  });

  select.addEventListener("change", () => {
    input.value = select.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    syncOppoThirdCategoryOptions(storeKey, true);
  });

  box.append(select, input);
  return box;
}

/**
 * 创建 OPPO 三级分类下拉框。
 *
 * 三级分类依赖当前二级分类；如果老配置里只有三级 ID，会尝试从本地表反查
 * 所属二级分类，并在页面首次渲染时把二级隐藏值补齐，方便用户直接保存。
 *
 * @param {string} storeKey 平台 key。
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement} input 隐藏输入框。
 * @param {unknown} value 当前三级分类 ID。
 * @returns {HTMLElement} 分类选择 DOM。
 */
function createOppoThirdCategoryField(storeKey, field, input, value) {
  const box = document.createElement("div");
  box.className = "store-select-field";
  input.type = "hidden";
  input.dataset.type = field.type;
  input.dataset.valueType = field.valueType || "number";
  input.value = value === undefined || value === null ? "" : String(value);

  const select = document.createElement("select");
  select.className = "store-category-select";
  select.dataset.store = storeKey;
  select.dataset.categoryRole = "oppo-third";
  box.append(select, input);

  requestAnimationFrame(() => syncOppoThirdCategoryOptions(storeKey, false));
  select.addEventListener("change", () => {
    input.value = select.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  return box;
}

/**
 * 刷新 OPPO 三级分类选项，并在必要时清空已经不匹配的旧三级值。
 *
 * @param {string} storeKey 平台 key。
 * @param {boolean} resetInvalidThird 二级分类发生人工变化时是否清理不匹配的三级值。
 * @returns {void}
 */
function syncOppoThirdCategoryOptions(storeKey, resetInvalidThird) {
  const scope = elements.storeConfig.querySelector(`.store-card[data-store="${storeKey}"]`);
  if (!scope) return;
  const secondInput = scope.querySelector(`[data-store="${storeKey}"][data-key="secondCategoryId"]`);
  const thirdInput = scope.querySelector(`[data-store="${storeKey}"][data-key="thirdCategoryId"]`);
  const thirdSelect = scope.querySelector(`select[data-store="${storeKey}"][data-category-role="oppo-third"]`);
  if (!secondInput || !thirdInput || !thirdSelect) return;

  const matchedByThird = thirdInput.value ? findOppoSecondCategoryByThirdId(thirdInput.value) : null;
  if (!secondInput.value && matchedByThird) {
    // 兼容旧配置：只保存了 thirdCategoryId 时，自动补齐二级分类的隐藏值和下拉显示。
    secondInput.value = String(matchedByThird.id);
    const secondSelect = scope.querySelector(`select[data-store="${storeKey}"][data-category-role="oppo-second"]`);
    if (secondSelect) secondSelect.value = secondInput.value;
  }

  const selectedSecond = OPPO_CATEGORIES.find((category) => String(category.id) === String(secondInput.value || ""));
  const thirdOptions = selectedSecond?.children || [];
  const currentThirdStillValid = thirdOptions.some((category) => String(category.id) === String(thirdInput.value || ""));

  if (resetInvalidThird && thirdInput.value && !currentThirdStillValid) {
    thirdInput.value = "";
    thirdInput.dispatchEvent(new Event("input", { bubbles: true }));
    thirdInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  thirdSelect.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = selectedSecond ? "请选择三级分类" : "请先选择二级分类";
  thirdSelect.appendChild(empty);
  thirdSelect.disabled = thirdOptions.length === 0;

  thirdOptions.forEach((category) => {
    const option = document.createElement("option");
    option.value = String(category.id);
    option.textContent = `${category.name}（${category.id}）`;
    option.selected = String(thirdInput.value || "") === String(category.id);
    thirdSelect.appendChild(option);
  });
}

/**
 * 根据 OPPO 三级分类 ID 反查二级分类。
 *
 * @param {string|number} thirdId 三级分类 ID。
 * @returns {object|null} 匹配到的二级分类。
 */
function findOppoSecondCategoryByThirdId(thirdId) {
  return OPPO_CATEGORIES.find((category) => category.children.some((child) => String(child.id) === String(thirdId))) || null;
}

/**
 * 更新分段按钮激活态。
 *
 * @param {HTMLElement} group 分段按钮容器。
 * @param {string} value 当前值。
 * @returns {void}
 */
function updateSegmentedActiveState(group, value) {
  group.querySelectorAll(".store-segmented-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.value === String(value));
    button.setAttribute("aria-pressed", String(button.dataset.value === String(value)));
  });
}

/**
 * 读取当前项目已缓存的小米分类列表。
 *
 * @returns {{id: string|number, name: string}[]} 分类列表。
 */
function getXiaomiCategories() {
  return state.status?.storeConfig?.states?.xiaomi?.categories || [];
}

/**
 * 根据 visibleWhen 控制字段显示状态。
 *
 * 字段隐藏时保留 DOM 和值，避免用户在切换安装方式时丢失已经输入的密码。
 *
 * @param {HTMLElement} wrapper 字段容器。
 * @returns {void}
 */
function applyStoreFieldVisibility(wrapper) {
  const dependencyKey = wrapper.dataset.visibleWhenKey;
  if (!dependencyKey) return;
  const expectedValue = wrapper.dataset.visibleWhenEquals;
  const storeKey = wrapper.querySelector("[data-store]")?.dataset.store;
  const scope = wrapper.closest(".store-card") || elements.storeConfig;
  const dependencyInput = scope.querySelector(`[data-store="${storeKey}"][data-key="${dependencyKey}"]`);
  const visible = dependencyInput && dependencyInput.value === expectedValue;
  wrapper.hidden = !visible;
}

/**
 * 当前平台表单渲染完成后统一刷新一次字段显隐。
 *
 * createStoreField 执行时表单卡片还没有挂到页面上，依赖字段可能暂时查不到；
 * 渲染完成后补一次全量计算，保证密码字段这类条件字段初始状态正确。
 *
 * @param {string} storeKey 平台 key。
 * @returns {void}
 */
function updateAllStoreFieldVisibility(storeKey) {
  elements.storeConfig.querySelectorAll("[data-visible-when-key]").forEach((wrapper) => {
    const input = wrapper.querySelector("[data-store]");
    if (input?.dataset.store === storeKey) applyStoreFieldVisibility(wrapper);
  });
}

/**
 * 依赖字段变化后刷新同平台其它字段的显隐。
 *
 * @param {string} storeKey 平台 key。
 * @param {string} changedKey 发生变化的字段 key。
 * @param {string} value 当前值，仅用于说明事件语义。
 * @returns {void}
 */
function updateDependentStoreFields(storeKey, changedKey, value) {
  void value;
  elements.storeConfig.querySelectorAll(`[data-visible-when-key="${changedKey}"]`).forEach((wrapper) => {
    const input = wrapper.querySelector("[data-store]");
    if (input?.dataset.store === storeKey) applyStoreFieldVisibility(wrapper);
  });
}

/**
 * 判断字段是否用 textarea 承载。
 *
 * image-list / file-list 本质上仍保存多行路径数组，使用 textarea 作为隐藏的
 * 可编辑源数据，预览区负责提供更友好的删除和查看交互。
 *
 * @param {object} field 字段 schema。
 * @returns {boolean} true 表示创建 textarea。
 */
function isMultilineStoreField(field) {
  return ["textarea", "list", "image-list", "file-list", "release-notes"].includes(field.type);
}

/**
 * 判断字段是否保存为数组。
 *
 * @param {object} field 字段 schema。
 * @returns {boolean} true 表示保存为字符串数组。
 */
function isListValueField(field) {
  return ["list", "image-list", "file-list"].includes(field.type);
}

/**
 * 把数组或旧字符串统一渲染成 textarea 的多行内容。
 *
 * 兼容早期逗号分隔 URL 或手动粘贴路径；保存时仍转回数组，减少后端二义性。
 *
 * @param {unknown} value 原始字段值。
 * @returns {string} textarea 展示值。
 */
function normalizeListFieldValue(value) {
  if (Array.isArray(value)) return value.join("\n");
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 判断字段是否是本地文件路径配置。
 *
 * 这里只处理应用市场发布配置里的本地文件路径：APK/AAB、截图、图标、PDF 资质等。
 * URL 字段和账号字段不会被当成文件路径，避免误显示选择按钮。
 *
 * @param {object} field 字段 schema。
 * @returns {boolean} true 表示需要显示文件选择按钮。
 */
function isPathField(field) {
  if (["file", "image-file", "file-list", "image-list"].includes(field.type)) return true;
  if (!["text", "list"].includes(field.type)) return false;
  return /path|paths/i.test(field.key) || /路径/.test(field.label || "");
}

/**
 * 判断字段是否代表 APK 文件路径。
 *
 * 只有 APK 路径才触发 versionCode 自动解析；AAB、截图、图标和资质文件不会触发，
 * 避免用户选择资源文件时出现无关提示。
 *
 * @param {object} field 字段 schema。
 * @returns {boolean} true 表示 APK 路径字段。
 */
function isApkPathField(field) {
  const descriptor = `${field.key || ""} ${field.label || ""}`.toLowerCase();
  return /apk/.test(descriptor) && /path|路径/.test(descriptor);
}

/**
 * 按字段含义返回选择按钮文案。
 *
 * @param {object} field 字段 schema。
 * @returns {string} 按钮文案。
 */
function getPathPickerButtonText(field) {
  if (field.type === "image-file") return "选择图片";
  if (field.type === "file") return /apk|aab/i.test(field.key) || /APK|AAB/.test(field.label || "") ? "选择包" : "选择文件";
  return /apk|aab/i.test(field.key) || /APK|AAB/.test(field.label || "") ? "选择包" : "选择文件";
}

/**
 * 打开应用市场配置的本地文件选择器。
 *
 * @param {object} platform 当前平台配置。
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement|HTMLTextAreaElement} input 目标输入框。
 * @returns {void}
 */
function openStoreFilePicker(platform, field, input) {
  activeFilePicker = { platform, field, input, selectedPath: "", selectedPaths: [], allowMultiple: isListValueField(field) };
  const modal = getStoreFilePickerModal();
  modal.querySelector("[data-picker-selected]").textContent = "未选择";
  modal.classList.add("open");
  modal.removeAttribute("hidden");
  loadStorePickerDirectory(getInitialPickerPath(platform, field, input), field).catch((error) => {
    appendLog({ time: new Date().toISOString(), line: error.message });
    showToast(error.message || "读取文件列表失败", "error");
  });
}

/**
 * 获取文件选择器的初始目录。
 *
 * @param {object} platform 当前平台配置。
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement|HTMLTextAreaElement} input 目标输入框。
 * @returns {string} 初始目录或文件路径。
 */
function getInitialPickerPath(platform, field, input) {
  const currentValue =
    field.type === "list"
      ? String(input.value || "")
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean)
          .at(-1)
      : String(input.value || "").trim();
  if (currentValue) return currentValue;

  if (/apk|aab/i.test(field.key)) {
    const packageInfo = state.status?.packageInfo;
    const matchedPackage = packageInfo?.packages?.find((item) => item.code === platform.code);
    return matchedPackage?.apk?.path || matchedPackage?.expectedApkPath || (matchedPackage ? `${packageInfo.versionDir}/${matchedPackage.dir}` : packageInfo?.versionDir) || "/";
  }

  return state.status?.activeProject?.rootPath || state.status?.projectRoot || "/";
}

/**
 * 创建或复用应用市场文件选择弹窗。
 *
 * @returns {HTMLElement} 弹窗 DOM。
 */
function getStoreFilePickerModal() {
  let modal = document.querySelector("#storeFilePickerModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "storeFilePickerModal";
  modal.className = "path-picker-modal";
  modal.hidden = true;
  modal.innerHTML = `
    <div class="path-picker-dialog" role="dialog" aria-modal="true" aria-label="选择上传文件">
      <div class="path-picker-header">
        <strong>选择上传文件</strong>
        <button type="button" data-picker-close>关闭</button>
      </div>
      <div class="path-picker-current">
        <span>当前目录</span>
        <code data-picker-current></code>
      </div>
      <div class="path-picker-actions">
        <button type="button" data-picker-parent>上一级</button>
        <button type="button" data-picker-use>使用所选文件</button>
      </div>
      <div class="path-picker-list" data-picker-list></div>
      <div class="path-picker-selected">将写入：<code data-picker-selected>未选择</code></div>
    </div>
  `;
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target.matches("[data-picker-close]")) closeStoreFilePicker();
  });
  modal.querySelector("[data-picker-parent]").addEventListener("click", () => {
    loadStorePickerDirectory(modal.dataset.parentPath, activeFilePicker?.field).catch((error) => showToast(error.message || "读取文件列表失败", "error"));
  });
  modal.querySelector("[data-picker-use]").addEventListener("click", () => {
    applySelectedStoreFile().catch((error) => {
      appendLog({ time: new Date().toISOString(), line: error.message });
      showToast(error.message || "使用所选文件失败", "error");
    });
  });
  document.body.appendChild(modal);
  return modal;
}

/**
 * 加载文件选择器当前目录。
 *
 * @param {string} directoryPath 目标目录或文件路径。
 * @param {object} field 字段 schema。
 * @returns {Promise<void>} 加载完成。
 */
async function loadStorePickerDirectory(directoryPath, field) {
  const modal = getStoreFilePickerModal();
  const extensions = getAllowedExtensions(field);
  const result = await requestJson(`/api/files/list?path=${encodeURIComponent(directoryPath || "/")}&includeFiles=1&extensions=${encodeURIComponent(extensions.join(","))}`);
  modal.dataset.currentPath = result.path;
  modal.dataset.parentPath = result.parentPath;
  modal.querySelector("[data-picker-current]").textContent = result.path;

  const list = modal.querySelector("[data-picker-list]");
  list.innerHTML = "";
  if (!result.entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = extensions.length ? `当前目录下没有匹配文件：${extensions.join(", ")}` : "当前目录下没有可选文件。";
    list.appendChild(empty);
    return;
  }

  result.entries.forEach((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `picker-entry ${entry.isDirectory ? "directory" : "file"}`;
    button.textContent = `${entry.isDirectory ? "目录" : "文件"}：${entry.name}`;
    button.addEventListener("click", () => {
      if (entry.isDirectory) {
        loadStorePickerDirectory(entry.path, field).catch((error) => showToast(error.message || "读取文件列表失败", "error"));
        return;
      }
      if (activeFilePicker?.allowMultiple) {
        activeFilePicker.selectedPaths ||= [];
        const index = activeFilePicker.selectedPaths.indexOf(entry.path);
        if (index >= 0) activeFilePicker.selectedPaths.splice(index, 1);
        else activeFilePicker.selectedPaths.push(entry.path);
        button.classList.toggle("selected", activeFilePicker.selectedPaths.includes(entry.path));
        modal.querySelector("[data-picker-selected]").textContent = activeFilePicker.selectedPaths.length ? activeFilePicker.selectedPaths.join("\n") : "未选择";
        return;
      }
      activeFilePicker.selectedPath = entry.path;
      activeFilePicker.selectedPaths = [entry.path];
      modal.querySelector("[data-picker-selected]").textContent = entry.path;
      list.querySelectorAll(".picker-entry.selected").forEach((item) => item.classList.remove("selected"));
      button.classList.add("selected");
    });
    list.appendChild(button);
  });
}

/**
 * 根据字段类型限制可选文件后缀。
 *
 * @param {object} field 字段 schema。
 * @returns {string[]} 小写文件后缀列表。
 */
function getAllowedExtensions(field) {
  const key = `${field.key || ""} ${field.label || ""}`.toLowerCase();
  if (/json|client/.test(key)) return [".json"];
  if (/apk|aab/.test(key)) return [".apk", ".aab"];
  if (/ipa/.test(key)) return [".ipa"];
  if (/zip|rar|压缩包/.test(key)) return [".zip", ".rar"];
  if (field.type === "image-file" || field.type === "image-list" || /icon|screenshot|snapshot|image|img|截图|图标/.test(key)) return [".png", ".jpg", ".jpeg", ".webp"];
  if (/pdf|cert|licence|license|资质|证书|版权/.test(key)) return [".pdf", ".png", ".jpg", ".jpeg"];
  if (/video|视频/.test(key)) return [".mp4", ".m4a", ".mov"];
  return [];
}

/**
 * 判断路径字段是否适合渲染图片预览。
 *
 * 只对图标、截图、图片类字段开启；APK、证书、视频等路径不会创建预览，
 * 避免浏览器误请求大文件或不支持的文件类型。
 *
 * @param {object} field 字段 schema。
 * @returns {boolean} true 表示图片路径字段。
 */
function isImagePathField(field) {
  const key = `${field.key || ""} ${field.label || ""}`.toLowerCase();
  return field.type === "image-file" || field.type === "image-list" || /icon|screenshot|snapshot|image|img|截图|图标/.test(key);
}

/**
 * 创建路径预览区域。
 *
 * 图片类字段显示缩略图；普通文件列表显示文件名和路径。删除按钮只删除表单里的
 * 路径记录，不会删除本机文件，也不会删除已上传到应用市场的远端资源。
 *
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement|HTMLTextAreaElement} input 目标输入框。
 * @returns {HTMLElement} 预览 DOM。
 */
function createPathPreview(field, input) {
  const preview = document.createElement("div");
  preview.className = isImagePathField(field) ? "store-image-preview" : "store-file-preview";
  updatePathPreview(preview, field, input);
  input.addEventListener("input", () => updatePathPreview(preview, field, input));
  input.addEventListener("change", () => updatePathPreview(preview, field, input));
  return preview;
}

/**
 * 根据当前输入值刷新路径预览。
 *
 * list 字段会把每一行都作为一个资源展示；单路径字段只展示一个资源。
 * 后端 /api/files/preview 会再次校验后缀和文件存在性，前端这里只做轻量过滤。
 *
 * @param {HTMLElement} preview 预览容器。
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement|HTMLTextAreaElement} input 目标输入框。
 * @returns {void}
 */
function updatePathPreview(preview, field, input) {
  const paths = getPathFieldValues(field, input.value);

  preview.innerHTML = "";
  preview.hidden = paths.length === 0;
  paths.slice(0, 12).forEach((filePath) => {
    const item = document.createElement("div");
    item.className = "store-image-preview-item";
    item.title = filePath;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "store-preview-open";
    openButton.addEventListener("click", () => window.open(getImagePreviewUrl(filePath), "_blank", "noopener,noreferrer"));

    if (isImagePathField(field)) {
      const image = document.createElement("img");
      image.alt = "图片预览";
      image.loading = "lazy";
      image.src = getImagePreviewUrl(filePath);
      image.addEventListener(
        "error",
        () => {
          openButton.classList.add("error");
          openButton.textContent = "无法预览";
        },
        { once: true },
      );
      openButton.appendChild(image);
    } else {
      openButton.textContent = filePath.split(/[\\/]/).pop() || filePath;
    }

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "store-preview-remove";
    removeButton.textContent = "删除";
    removeButton.addEventListener("click", () => removePathFromField(field, input, filePath));

    item.append(openButton, removeButton);
    preview.appendChild(item);
  });
}

/**
 * 读取路径字段当前值。
 *
 * @param {object} field 字段 schema。
 * @param {string} value 输入框值。
 * @returns {string[]} 路径列表。
 */
function getPathFieldValues(field, value) {
  const source = String(value || "");
  const values = isListValueField(field) ? source.split(/\r?\n|,/) : [source];
  return values.map((item) => item.trim()).filter(Boolean);
}

/**
 * 从路径字段中移除指定文件路径。
 *
 * @param {object} field 字段 schema。
 * @param {HTMLInputElement|HTMLTextAreaElement} input 目标输入框。
 * @param {string} filePath 要移除的路径。
 * @returns {void}
 */
function removePathFromField(field, input, filePath) {
  const nextValues = getPathFieldValues(field, input.value).filter((item) => item !== filePath);
  input.value = isListValueField(field) ? nextValues.join("\n") : "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * 生成本机图片预览接口地址。
 *
 * @param {string} filePath 本机图片路径。
 * @returns {string} 预览 URL。
 */
function getImagePreviewUrl(filePath) {
  return `/api/files/preview?path=${encodeURIComponent(filePath)}`;
}

/**
 * 从 APK 中读取包名和版本号，并回填当前渠道表单。
 *
 * 后端负责调用 aapt 解析 APK，前端只根据返回结果写入已有字段：
 * - versionCode/version_code/buildNumber 等构建号字段会直接覆盖，确保和包体一致；
 * - packageName/pkgName/pkg_name 只在为空时回填，避免误覆盖用户配置的正式包名。
 *
 * @param {object} platform 当前平台配置。
 * @param {object} field 触发解析的 APK 路径字段。
 * @param {HTMLInputElement|HTMLTextAreaElement} input APK 路径输入框。
 * @returns {Promise<boolean>} true 表示读取成功并尝试回填。
 */
async function autofillApkInfoForStore(platform, field, input) {
  const apkPath = getPathFieldValues(field, input.value)[0] || "";
  if (!apkPath || !apkPath.toLowerCase().endsWith(".apk")) return false;

  const result = await requestJson("/api/files/apk-info", {
    method: "POST",
    body: JSON.stringify({ path: apkPath }),
  });
  if (!result.ok) {
    const message = result.message || "APK 信息解析失败";
    appendLog({ time: new Date().toISOString(), line: message });
    showToast(message, "error");
    return false;
  }

  const scope = document.querySelector(`.store-card[data-store="${platform.key}"]`);
  if (scope) {
    fillStoreInputValue(scope, ["versionCode", "version_code", "buildNumber", "build_number"], result.versionCode, { overwrite: true });
    fillStoreInputValue(scope, ["versionName", "version_name"], result.versionName, { overwrite: false });
    fillStoreInputValue(scope, ["packageName", "pkgName", "pkg_name", "package"], result.packageName, { overwrite: false });
  }

  appendLog({
    time: new Date().toISOString(),
    line: `已从 APK 读取：${result.packageName || "-"} / ${result.versionName || "-"}(${result.versionCode || "-"})`,
  });
  showToast(`已读取 APK versionCode：${result.versionCode || "-"}`, "success");
  return true;
}

/**
 * 按候选 key 回填当前平台表单字段。
 *
 * 不同应用市场对同一概念命名不同，例如 OPPO 使用 versionCode，
 * 其它接口可能写成 version_code。这里做轻量兼容，schema 中不存在字段时自然跳过。
 *
 * @param {HTMLElement} scope 当前平台表单卡片。
 * @param {string[]} keys 候选字段 key。
 * @param {string|number|undefined} value 要写入的值。
 * @param {{overwrite?: boolean}} options overwrite=true 时覆盖已有值。
 * @returns {boolean} true 表示有字段被写入。
 */
function fillStoreInputValue(scope, keys, value, options = {}) {
  if (value === undefined || value === null || value === "") return false;
  const input = keys.map((key) => scope.querySelector(`[data-key="${key}"]`)).find(Boolean);
  if (!input) return false;
  if (!options.overwrite && String(input.value || "").trim()) return false;

  input.value = String(value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/**
 * 把选择的文件路径写回当前字段。
 *
 * @returns {Promise<void>} 文件路径写入和可选联动完成。
 */
async function applySelectedStoreFile() {
  const selectedPaths = activeFilePicker?.allowMultiple ? activeFilePicker.selectedPaths || [] : [activeFilePicker?.selectedPath].filter(Boolean);
  if (selectedPaths.length === 0) {
    showToast("请先选择一个文件", "error");
    return;
  }

  const { platform, input, field } = activeFilePicker;
  if (isListValueField(field)) {
    const lines = getPathFieldValues(field, input.value);
    selectedPaths.forEach((selectedPath) => {
      if (!lines.includes(selectedPath)) lines.push(selectedPath);
    });
    input.value = lines.join("\n");
  } else {
    input.value = selectedPaths[0];
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  closeStoreFilePicker();

  // 华为 API Client JSON 是“选择文件后读取并回填”的特殊流程：
  // 用户选中 JSON 后立即解析并写入 Client ID / Secret / Developer ID，
  // 但仍然不自动保存，便于用户确认表单内容。
  if (platform?.key === "huawei" && field.key === "apiClientJsonPath") {
    await importHuaweiClientJson();
    return;
  }

  showToast("文件路径已写入表单", "success");
}

/**
 * 关闭应用市场文件选择弹窗。
 *
 * @returns {void}
 */
function closeStoreFilePicker() {
  const modal = document.querySelector("#storeFilePickerModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.hidden = true;
  activeFilePicker = null;
}

const HUAWEI_STEPS = [
  {
    action: "precheck",
    label: "预检配置",
    note: "只检查本地配置和包路径，不访问华为接口。",
  },
  {
    action: "token-check",
    label: "获取/校验 Token",
    note: "校验 Client ID / Secret 是否能换取 Connect API token。",
  },
  {
    action: "upload-package",
    label: "上传包体",
    note: "获取上传授权并上传 APK/AAB，成功后保存下一步所需的文件信息。",
  },
  {
    action: "update-package-info",
    label: "更新应用包信息",
    note: "调用华为“应用包信息更新”接口，把已上传包体关联到当前 App。",
  },
  {
    action: "query-package-info",
    label: "查询包信息",
    note: "查询华为侧应用信息，用于确认前面步骤是否生效。",
  },
  {
    action: "submit-review",
    label: "提交审核",
    danger: true,
    note: "只有开启“允许提交审核”后才会真实调用提交接口。",
  },
];

const HUAWEI_FLOW_STEPS = [
  {
    label: "Token 校验",
    stateKey: "tokenCheckedAt",
    note: "确认 Client ID / Secret 可以换取华为 Connect API token。",
  },
  {
    label: "包体上传",
    stateKey: "uploadedPackage.uploadedAt",
    note: "上传 APK/AAB 并保存华为返回的 fileDestUrl。",
  },
  {
    label: "包信息更新",
    stateKey: "packageInfoUpdatedAt",
    note: "把已上传包体关联到华为 App 的应用包信息。",
  },
  {
    label: "包信息查询",
    stateKey: "packageInfoQueriedAt",
    note: "查询华为侧包信息，确认前面步骤是否生效。",
  },
  {
    label: "提交审核",
    stateKey: "reviewSubmittedAt",
    note: "可选步骤，只有开启提交审核开关后才会调用。",
  },
];

const XIAOMI_STEPS = [
  {
    action: "precheck",
    label: "预检配置",
    note: "只检查本地配置、SIG 所需字段和文件路径，不访问小米接口。",
  },
  {
    action: "query-package",
    label: "查询应用",
    note: "调用 /dev/query，确认包名和账号能查到当前应用。",
  },
  {
    action: "query-categories",
    label: "查询分类",
    note: "调用 /dev/category，主要用于后台核对分类映射；更新包通常不需要手动填写。",
  },
  {
    action: "upload",
    label: "推送更新",
    danger: true,
    note: "调用 /dev/query 读取已有应用信息后，再调用 /dev/push 提交 APK 和版本更新说明。",
  },
];

const HONOR_STEPS = [
  {
    action: "precheck",
    label: "预检配置",
    note: "检查荣耀 client_id、client_secret、包名、APK 路径和更新说明，不访问外部接口。",
  },
  {
    action: "token-check",
    label: "获取/校验 Token",
    note: "调用荣耀 IAM token 接口，确认 client_id / client_secret 可用。",
  },
  {
    action: "query-app-id",
    label: "查询 APPID",
    note: "按包名调用 get-app-id，成功后保存后续步骤需要的 APPID。",
  },
  {
    action: "query-app-detail",
    label: "查询应用详情",
    note: "查询荣耀侧应用信息，用于确认账号权限，也可继承 appName / intro。",
  },
  {
    action: "upload-package",
    label: "上传 APK",
    note: "获取上传路径并调用荣耀 file-upload 上传 APK，上传进度会显示在上方监控。",
  },
  {
    action: "update-file-info",
    label: "绑定应用文件",
    note: "把已上传 APK 的 objectId 绑定到荣耀应用文件信息。",
  },
  {
    action: "update-language-info",
    label: "更新版本说明",
    note: "把渠道更新日志写入荣耀 newFeature；缺少 appName / intro 时会跳过并给出原因。",
  },
  {
    action: "submit-review",
    label: "提交审核",
    danger: true,
    note: "只有开启“上传后提交审核”后才允许调用 submit-audit。",
  },
  {
    action: "query-audit-status",
    label: "查询审核状态",
    note: "使用提交审核返回的 releaseId 查询荣耀审核结果。",
  },
  {
    action: "query-current-release",
    label: "查询当前版本",
    note: "不依赖 releaseId，按 APPID 查询荣耀当前最新版本和审核状态。",
  },
];

const HONOR_FLOW_STEPS = [
  {
    label: "Token 校验",
    stateKey: "tokenCheckedAt",
    note: "确认荣耀 Publish API 鉴权可用。",
  },
  {
    label: "APPID 查询",
    stateKey: "appIdQueriedAt",
    note: "按包名查询并保存 APPID。",
  },
  {
    label: "APK 上传",
    stateKey: "uploadedPackage.uploadedAt",
    note: "上传 APK 并保存 objectId。",
  },
  {
    label: "文件绑定",
    stateKey: "fileInfoUpdatedAt",
    note: "把 objectId 绑定到应用文件信息。",
  },
  {
    label: "版本说明",
    stateKey: "languageInfoUpdatedAt",
    note: "更新荣耀多语言 newFeature。",
  },
  {
    label: "提交审核",
    stateKey: "reviewSubmittedAt",
    note: "可选步骤，取决于提交审核开关。",
  },
  {
    label: "审核状态",
    stateKey: "auditStatusQueriedAt",
    note: "查询 releaseId 对应的审核结果。",
  },
  {
    label: "当前版本",
    stateKey: "currentReleaseQueriedAt",
    note: "按 APPID 查询当前最新版本和审核状态。",
  },
];

const OPPO_STEPS = [
  {
    action: "precheck",
    label: "预检配置",
    note: "检查 OPPO client_id、client_secret、发布版本必填字段和 APK 路径，不访问外部接口。",
  },
  {
    action: "token-check",
    label: "获取/校验 Token",
    note: "调用 /developer/v1/token，确认 OPPO API 凭证可用。",
  },
  {
    action: "query-app-info",
    label: "查询应用详情",
    note: "调用 /resource/v1/app/info，确认包名归属和当前应用基础信息。",
  },
  {
    action: "upload-apk",
    label: "上传 APK",
    note: "先获取一次性 upload_url/sign，再 multipart 上传本地 APK。",
  },
  {
    action: "upload-assets",
    label: "上传资源文件",
    note: "逐个上传图标、截图和资质文件，并保存发布版本接口需要的远端 URL。",
  },
  {
    action: "publish-version",
    label: "发布版本",
    danger: true,
    note: "调用 /resource/v1/app/upd 提交新版本资料，会新增版本并进入 OPPO 异步处理任务。",
  },
  {
    action: "query-task",
    label: "查询任务状态",
    note: "调用 /resource/v1/app/task-state，查询发布版本异步处理结果。",
  },
];

const OPPO_FLOW_STEPS = [
  {
    label: "Token 校验",
    stateKey: "tokenCheckedAt",
    note: "确认 OPPO API 鉴权可用。",
  },
  {
    label: "应用详情",
    stateKey: "appInfoQueriedAt",
    note: "按包名查询应用详情。",
  },
  {
    label: "APK 上传",
    stateKey: "uploadedApk.uploadedAt",
    note: "上传 APK 并保存 url/md5。",
  },
  {
    label: "资源上传",
    stateKey: "uploadedAssets",
    note: "上传图标、截图、版权证明等资源。",
  },
  {
    label: "发布版本",
    stateKey: "versionPublishedAt",
    note: "调用 app/upd 新增版本。",
  },
  {
    label: "任务状态",
    stateKey: "taskStateQueriedAt",
    note: "查询 OPPO 异步任务处理状态。",
  },
];

const VIVO_STEPS = [
  {
    action: "precheck",
    label: "预检配置",
    note: "检查 vivo access_key、access_secret、包名、versionCode 和 APK 路径，不访问外部接口。",
  },
  {
    action: "query-app-info",
    label: "查询应用详情",
    note: "调用 app.query.details，确认包名归属、当前版本和审核状态。",
  },
  {
    action: "upload-apk",
    label: "上传 APK",
    note: "调用 app.upload.apk.app，后端会自动计算 APK MD5 并保存 serialnumber。",
  },
  {
    action: "upload-assets",
    label: "上传资源文件",
    note: "按需调用 app.upload.icon、app.upload.screenshot，保存 icon/截图流水号。",
  },
  {
    action: "submit-update",
    label: "提交应用更新",
    danger: true,
    note: "调用 app.sync.update.app，把 APK 流水号、版本号和更新说明提交给 vivo。",
  },
  {
    action: "query-task",
    label: "查询任务状态",
    note: "调用 app.query.task.status，查看 vivo 侧异步任务处理结果。",
  },
];

const VIVO_FLOW_STEPS = [
  {
    label: "应用详情",
    stateKey: "appInfoQueriedAt",
    note: "按包名查询 vivo 当前应用信息。",
  },
  {
    label: "APK 上传",
    stateKey: "uploadedApk.uploadedAt",
    note: "上传 APK 并保存 serialnumber。",
  },
  {
    label: "资源上传",
    stateKey: "uploadedAssets",
    note: "上传 icon、截图等资源并保存 serialnumber。",
  },
  {
    label: "同步更新",
    stateKey: "updateSubmittedAt",
    note: "调用 app.sync.update.app 提交版本更新。",
  },
  {
    label: "任务状态",
    stateKey: "taskStateQueriedAt",
    note: "查询 vivo 任务状态和错误原因。",
  },
];

/**
 * 创建华为分步骤发布操作面板。
 *
 * @returns {HTMLElement} 华为步骤操作区 DOM。
 */
function createHuaweiStepPanel(refreshStatus) {
  const panel = document.createElement("section");
  panel.className = "store-flow-panel";

  const stateInfo = state.status?.storeConfig?.states?.huawei || {};
  const header = document.createElement("div");
  header.className = "store-flow-header";
  const title = document.createElement("strong");
  title.textContent = "华为发布步骤";
  const hint = document.createElement("span");
  hint.textContent = "步骤状态只记录本次流程中间结果，重新一键执行会自动清空旧状态。";
  header.append(title, hint);
  panel.appendChild(header);

  const importRow = document.createElement("div");
  importRow.className = "store-flow-import";
  const importText = document.createElement("span");
  importText.textContent = "已下载 agc-apiclient-*.json 时，可以先读取文件并自动回填 Client ID / Secret。";
  const importButton = document.createElement("button");
  importButton.type = "button";
  importButton.textContent = "读取 API Client JSON";
  importButton.addEventListener("click", () => {
    runButtonAction(importButton, importHuaweiClientJson, {
      pending: "读取中",
      success: "已回填华为 API Client",
    });
  });
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "secondary-action";
  resetButton.textContent = "重置流程状态";
  resetButton.addEventListener("click", () => {
    runButtonAction(resetButton, () => runHuaweiStep("reset-state", refreshStatus), {
      pending: "重置中",
      success: "状态已重置",
    });
  });
  const importActions = document.createElement("div");
  importActions.className = "store-flow-actions";
  importActions.append(importButton, resetButton);
  importRow.append(importText, importActions);
  panel.appendChild(importRow);

  panel.appendChild(createHuaweiFlowTimeline(stateInfo));

  const steps = document.createElement("div");
  steps.className = "store-flow-steps";
  HUAWEI_STEPS.forEach((step) => {
    const item = document.createElement("div");
    item.className = "store-flow-step";

    const text = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = step.label;
    const note = document.createElement("p");
    note.textContent = step.note;
    text.append(label, note);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = step.label;
    if (step.danger) button.className = "danger-action";
    button.addEventListener("click", () => {
      runButtonAction(button, () => runHuaweiStep(step.action, refreshStatus), {
        pending: "执行中",
        success: `${step.label}完成`,
      });
    });

    item.append(text, button);
    steps.appendChild(item);
  });
  panel.appendChild(steps);
  return panel;
}

/**
 * 创建小米自动发布步骤面板。
 *
 * 小米接口的 RequestData、SIG 和文件 MD5 都由后端生成；
 * 前端只把用户能理解的查询、分类、推送动作拆出来，方便排查接口配置。
 *
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {HTMLElement} 小米步骤面板 DOM。
 */
function createXiaomiStepPanel(refreshStatus) {
  const panel = document.createElement("section");
  panel.className = "store-flow-panel";

  const header = document.createElement("div");
  header.className = "store-flow-header";
  const title = document.createElement("strong");
  title.textContent = "小米自动发布步骤";
  const hint = document.createElement("span");
  hint.textContent = "后端按小米文档生成 SIG、计算文件 MD5，并实时更新上传进度。";
  header.append(title, hint);
  panel.appendChild(header);

  const steps = document.createElement("div");
  steps.className = "store-flow-steps";
  XIAOMI_STEPS.forEach((step) => {
    const item = document.createElement("div");
    item.className = "store-flow-step";

    const text = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = step.label;
    const note = document.createElement("p");
    note.textContent = step.note;
    text.append(label, note);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = step.label;
    if (step.danger) button.className = "danger-action";
    button.addEventListener("click", () => {
      runButtonAction(button, () => runXiaomiStep(step.action, refreshStatus), {
        pending: "执行中",
        success: `${step.label}已返回`,
      });
    });

    item.append(text, button);
    steps.appendChild(item);
  });

  panel.appendChild(steps);
  return panel;
}

/**
 * 创建荣耀发布步骤面板。
 *
 * 荣耀文档的真实接口链路已经在 server/stores/honor/uploader.js 内完成；
 * 面板这里只负责展示关键动作、步骤状态和重置入口，避免用户误以为只是人工上传。
 *
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {HTMLElement} 荣耀步骤面板 DOM。
 */
function createHonorStepPanel(refreshStatus) {
  const panel = document.createElement("section");
  panel.className = "store-flow-panel";
  const stateInfo = state.status?.storeConfig?.states?.honor || {};

  const header = document.createElement("div");
  header.className = "store-flow-header";
  const title = document.createElement("strong");
  title.textContent = "荣耀发布步骤";
  const hint = document.createElement("span");
  hint.textContent = "后端会按 API传包服务执行完整更新链路，提交审核由安全开关控制。";
  header.append(title, hint);
  panel.appendChild(header);

  const flowText = document.createElement("p");
  flowText.className = "field-note";
  flowText.textContent = "荣耀流程：获取 Token、查询 APPID、上传 APK、绑定文件、更新版本说明、可选提交审核。顶部“执行上传”会串联这些步骤；下面按钮用于单步排查。";
  panel.appendChild(flowText);

  const actionsRow = document.createElement("div");
  actionsRow.className = "store-flow-import";
  const actionsText = document.createElement("span");
  actionsText.textContent = "重新一键执行时会自动清空旧状态；手动调试时也可以先重置步骤状态。";
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "secondary-action";
  resetButton.textContent = "重置流程状态";
  resetButton.addEventListener("click", () => {
    runButtonAction(resetButton, () => runHonorStep("reset-state", refreshStatus), {
      pending: "重置中",
      success: "状态已重置",
    });
  });
  actionsRow.append(actionsText, resetButton);
  panel.appendChild(actionsRow);
  panel.appendChild(createStoreFlowTimeline(HONOR_FLOW_STEPS, stateInfo));

  const steps = document.createElement("div");
  steps.className = "store-flow-steps";
  HONOR_STEPS.forEach((step) => {
    const item = document.createElement("div");
    item.className = "store-flow-step";

    const text = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = step.label;
    const note = document.createElement("p");
    note.textContent = step.note;
    text.append(label, note);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = step.label;
    if (step.danger) button.className = "danger-action";
    button.addEventListener("click", () => {
      runButtonAction(button, () => runHonorStep(step.action, refreshStatus), {
        pending: "执行中",
        success: `${step.label}已返回`,
      });
    });

    item.append(text, button);
    steps.appendChild(item);
  });

  panel.appendChild(steps);
  return panel;
}

/**
 * 创建 OPPO 发布步骤面板。
 *
 * OPPO 发布版本是异步任务：上传 APK 只得到文件 url/md5，真正新增版本要再调用
 * app/upd，最后通过 task-state 查询处理状态。因此页面必须把三个阶段拆开显示。
 *
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {HTMLElement} OPPO 步骤面板 DOM。
 */
function createOppoStepPanel(refreshStatus) {
  const panel = document.createElement("section");
  panel.className = "store-flow-panel";
  const stateInfo = state.status?.storeConfig?.states?.oppo || {};

  const header = document.createElement("div");
  header.className = "store-flow-header";
  const title = document.createElement("strong");
  title.textContent = "OPPO 发布步骤";
  const hint = document.createElement("span");
  hint.textContent = "按 API传包能力执行：Token、查询详情、上传 APK、上传资源、发布版本、查询任务。";
  header.append(title, hint);
  panel.appendChild(header);

  const flowText = document.createElement("p");
  flowText.className = "field-note";
  flowText.textContent = "顶部“执行上传”会串联完整 OPPO 发布版本流程；图标、截图、版权证明等本地文件会先通过 OPPO 文件上传接口换成 URL，再提交发布版本。";
  panel.appendChild(flowText);

  const actionsRow = document.createElement("div");
  actionsRow.className = "store-flow-import";
  const actionsText = document.createElement("span");
  actionsText.textContent = "重新一键执行时会自动清空旧状态；如果手动调试，请先重置流程状态避免复用旧 APK URL。";
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "secondary-action";
  resetButton.textContent = "重置流程状态";
  resetButton.addEventListener("click", () => {
    runButtonAction(resetButton, () => runOppoStep("reset-state", refreshStatus), {
      pending: "重置中",
      success: "状态已重置",
    });
  });
  actionsRow.append(actionsText, resetButton);
  panel.appendChild(actionsRow);
  panel.appendChild(createStoreFlowTimeline(OPPO_FLOW_STEPS, stateInfo));

  const steps = document.createElement("div");
  steps.className = "store-flow-steps";
  OPPO_STEPS.forEach((step) => {
    const item = document.createElement("div");
    item.className = "store-flow-step";

    const text = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = step.label;
    const note = document.createElement("p");
    note.textContent = step.note;
    text.append(label, note);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = step.label;
    if (step.danger) button.className = "danger-action";
    button.addEventListener("click", () => {
      runButtonAction(button, () => runOppoStep(step.action, refreshStatus), {
        pending: "执行中",
        success: `${step.label}已返回`,
      });
    });

    item.append(text, button);
    steps.appendChild(item);
  });

  panel.appendChild(steps);
  return panel;
}

/**
 * 创建 vivo 发布步骤面板。
 *
 * vivo 的文件上传方式会产生 APK serialnumber。这个中间状态不应该让用户手填，
 * 所以页面只展示步骤和状态，serialnumber、fileMd5 由后端写入本地流程状态。
 *
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {HTMLElement} vivo 步骤面板 DOM。
 */
function createVivoStepPanel(refreshStatus) {
  const panel = document.createElement("section");
  panel.className = "store-flow-panel";
  const stateInfo = state.status?.storeConfig?.states?.vivo || {};

  const header = document.createElement("div");
  header.className = "store-flow-header";
  const title = document.createElement("strong");
  title.textContent = "vivo 发布步骤";
  const hint = document.createElement("span");
  hint.textContent = "按 API 传包文件上传方式执行：查询详情、上传 APK、同步更新、查询任务。";
  header.append(title, hint);
  panel.appendChild(header);

  const flowText = document.createElement("p");
  flowText.className = "field-note";
  flowText.textContent = "顶部“执行上传”会串联完整 vivo 更新流程；如果选择了 icon 或截图文件，会先上传资源拿流水号，再提交应用更新。下面按钮用于单步排查签名、流水号或更新字段问题。";
  panel.appendChild(flowText);

  const actionsRow = document.createElement("div");
  actionsRow.className = "store-flow-import";
  const actionsText = document.createElement("span");
  actionsText.textContent = "重新一键执行时会自动清空旧状态；如果手动调试，请先重置流程状态避免复用旧 serialnumber。";
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "secondary-action";
  resetButton.textContent = "重置流程状态";
  resetButton.addEventListener("click", () => {
    runButtonAction(resetButton, () => runVivoStep("reset-state", refreshStatus), {
      pending: "重置中",
      success: "状态已重置",
    });
  });
  actionsRow.append(actionsText, resetButton);
  panel.appendChild(actionsRow);
  panel.appendChild(createStoreFlowTimeline(VIVO_FLOW_STEPS, stateInfo));

  const steps = document.createElement("div");
  steps.className = "store-flow-steps";
  VIVO_STEPS.forEach((step) => {
    const item = document.createElement("div");
    item.className = "store-flow-step";

    const text = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = step.label;
    const note = document.createElement("p");
    note.textContent = step.note;
    text.append(label, note);

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = step.label;
    if (step.danger) button.className = "danger-action";
    button.addEventListener("click", () => {
      runButtonAction(button, () => runVivoStep(step.action, refreshStatus), {
        pending: "执行中",
        success: `${step.label}已返回`,
      });
    });

    item.append(text, button);
    steps.appendChild(item);
  });

  panel.appendChild(steps);
  return panel;
}

/**
 * 执行小米自动发布步骤。
 *
 * 每次执行前先保存当前小米 tab 表单，保证后端使用的是用户刚刚编辑的配置。
 * 真正的 SIG、文件 MD5 和 multipart 上传都在 server/stores/xiaomi/uploader.js 内完成。
 *
 * @param {string} action 小米动作名。
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {Promise<boolean|void>} false 表示用户取消；否则步骤完成。
 */
async function runXiaomiStep(action, refreshStatus) {
  if (action === "upload" && !window.confirm("确认要调用小米 /dev/push 推送当前版本吗？")) return false;

  const stores = collectStoreConfig();
  await requestJson("/api/store-config", {
    method: "POST",
    body: JSON.stringify({ stores }),
  });
  if (state.status?.storeConfig) state.status.storeConfig.stores = stores;

  if (action === "upload") {
    setLocalStoreTaskProgress("xiaomi", "upload", "准备推送小米更新", "正在初始化小米 /dev/push 上传任务");
  }

  const result = await requestJson("/api/upload", {
    method: "POST",
    body: JSON.stringify({ storeKey: "xiaomi", action }),
  });
  appendStoreActionResult(result);
  if (typeof refreshStatus === "function") await refreshStatus();
  if (!result.ok) throw new Error(formatStoreActionFailure(result, "小米自动发布步骤失败"));
  return true;
}

/**
 * 执行荣耀发布步骤。
 *
 * 每次执行前先保存当前荣耀表单，保证服务端预检和上传记录使用的是用户刚编辑的值。
 * action=upload 会触发真实荣耀 API 链路；submitForReview 关闭时只上传并绑定 APK。
 *
 * @param {string} action 荣耀动作名。
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {Promise<boolean|void>} false 表示用户取消；否则步骤完成。
 */
async function runHonorStep(action, refreshStatus) {
  if (action === "upload" && !window.confirm("确认要执行荣耀发布流程吗？将调用荣耀 API 上传 APK 并绑定文件；只有开启“上传后提交审核”才会提交审核。")) return false;
  if (action === "reset-state" && !window.confirm("确认要重置荣耀流程状态吗？这不会删除本地安装包，也不会修改上传配置。")) return false;
  if (action === "submit-review" && !window.confirm("确认要调用荣耀提交审核接口吗？")) return false;

  if (action !== "reset-state") {
    const stores = collectStoreConfig();
    await requestJson("/api/store-config", {
      method: "POST",
      body: JSON.stringify({ stores }),
    });
    if (state.status?.storeConfig) state.status.storeConfig.stores = stores;
  }

  if (action === "upload" || action === "upload-package") {
    const title = action === "upload" ? "准备执行荣耀发布" : "准备上传荣耀 APK";
    const detail = action === "upload" ? "正在初始化荣耀 API 传包流程" : "正在初始化荣耀 APK 上传步骤";
    setLocalStoreTaskProgress("honor", action, title, detail);
  }

  const result = await requestJson("/api/upload", {
    method: "POST",
    body: JSON.stringify({ storeKey: "honor", action }),
  });
  appendStoreActionResult(result);
  if (result.state && state.status?.storeConfig) {
    state.status.storeConfig.states ||= {};
    state.status.storeConfig.states.honor = result.state;
    renderStores(state.status.storeConfig);
  }
  if (typeof refreshStatus === "function") await refreshStatus();
  if (!result.ok) throw new Error(formatStoreActionFailure(result, "荣耀发布步骤失败"));
  return true;
}

/**
 * 执行 OPPO 发布步骤。
 *
 * 每次执行前先保存当前 OPPO 表单，保证后端预检、签名和发布字段使用的是
 * 用户刚刚编辑的配置。action=upload 会触发完整一键流程。
 *
 * @param {string} action OPPO 动作名。
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {Promise<boolean|void>} false 表示用户取消；否则步骤完成。
 */
async function runOppoStep(action, refreshStatus) {
  if (action === "upload" && !window.confirm("确认要执行 OPPO 发布版本流程吗？将调用 OPPO API 上传 APK 并提交新版本资料。")) return false;
  if (action === "reset-state" && !window.confirm("确认要重置 OPPO 流程状态吗？这不会删除本地安装包，也不会修改上传配置。")) return false;
  if (action === "publish-version" && !window.confirm("确认要调用 OPPO 发布版本接口吗？该接口会新增版本并进入异步处理任务。")) return false;

  if (action !== "reset-state") {
    const stores = collectStoreConfig();
    await requestJson("/api/store-config", {
      method: "POST",
      body: JSON.stringify({ stores }),
    });
    if (state.status?.storeConfig) state.status.storeConfig.stores = stores;
  }

  if (action === "upload" || action === "upload-apk") {
    const title = action === "upload" ? "准备执行 OPPO 发布" : "准备上传 OPPO APK";
    const detail = action === "upload" ? "正在初始化 OPPO API 传包流程" : "正在获取 OPPO 一次性上传配置";
    setLocalStoreTaskProgress("oppo", action, title, detail);
  } else if (action === "upload-assets") {
    setLocalStoreTaskProgress("oppo", action, "准备上传 OPPO 资源文件", "正在逐个上传图标、截图和资质文件");
  }

  const result = await requestJson("/api/upload", {
    method: "POST",
    body: JSON.stringify({ storeKey: "oppo", action }),
  });
  appendStoreActionResult(result);
  if (result.state && state.status?.storeConfig) {
    state.status.storeConfig.states ||= {};
    state.status.storeConfig.states.oppo = result.state;
    renderStores(state.status.storeConfig);
  }
  if (typeof refreshStatus === "function") await refreshStatus();
  if (!result.ok) throw new Error(formatStoreActionFailure(result, "OPPO 发布步骤失败"));
  return true;
}

/**
 * 执行 vivo 发布步骤。
 *
 * 每次执行前先保存当前 vivo 表单，保证后端签名、APK 路径和提交字段都来自
 * 用户刚刚编辑的配置。action=upload 会触发完整一键更新流程。
 *
 * @param {string} action vivo 动作名。
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {Promise<boolean|void>} false 表示用户取消；否则步骤完成。
 */
async function runVivoStep(action, refreshStatus) {
  if (action === "upload" && !window.confirm("确认要执行 vivo 应用更新流程吗？将调用 vivo API 上传 APK 并提交版本更新。")) return false;
  if (action === "reset-state" && !window.confirm("确认要重置 vivo 流程状态吗？这不会删除本地安装包，也不会修改上传配置。")) return false;
  if (action === "submit-update" && !window.confirm("确认要调用 vivo app.sync.update.app 提交应用更新吗？")) return false;

  if (action !== "reset-state") {
    const stores = collectStoreConfig();
    await requestJson("/api/store-config", {
      method: "POST",
      body: JSON.stringify({ stores }),
    });
    if (state.status?.storeConfig) state.status.storeConfig.stores = stores;
  }

  if (action === "upload" || action === "upload-apk") {
    const title = action === "upload" ? "准备执行 vivo 更新" : "准备上传 vivo APK";
    const detail = action === "upload" ? "正在初始化 vivo API 传包流程" : "正在计算 APK MD5 并准备上传";
    setLocalStoreTaskProgress("vivo", action, title, detail);
  }

  const result = await requestJson("/api/upload", {
    method: "POST",
    body: JSON.stringify({ storeKey: "vivo", action }),
  });
  appendStoreActionResult(result);
  if (result.state && state.status?.storeConfig) {
    state.status.storeConfig.states ||= {};
    state.status.storeConfig.states.vivo = result.state;
    renderStores(state.status.storeConfig);
  }
  if (typeof refreshStatus === "function") await refreshStatus();
  if (!result.ok) throw new Error(formatStoreActionFailure(result, "vivo 发布步骤失败"));
  return true;
}

/**
 * 创建当前平台危险操作区。
 *
 * 撤销审核会影响正在审核中的版本，不能和普通保存/预检按钮混在一起。
 * 所以每个平台配置下方单独展示警示面板，并在点击前再次弹窗确认。
 *
 * @param {object} platform 当前平台配置。
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {HTMLElement} 危险操作区 DOM。
 */
function createStoreDangerPanel(platform, refreshStatus) {
  const panel = document.createElement("section");
  panel.className = "store-danger-panel";

  const text = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "危险操作";
  const note = document.createElement("p");
  note.textContent = "撤销审核会影响当前平台正在审核的版本。执行前会保存当前平台配置，并把执行状态写入上方进度与上传记录。";
  text.append(title, note);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "danger-action";
  button.textContent = `撤销${platform.name}审核`;
  button.addEventListener("click", () => {
    runButtonAction(button, () => revokeCurrentStoreReview(platform, refreshStatus), {
      pending: "撤销中",
      success: `${platform.name}撤销请求已返回`,
    });
  });

  panel.append(text, button);
  return panel;
}

/**
 * 撤销当前平台审核。
 *
 * 当前 tab 的表单值会先写入当前项目的商店配置，再调用统一 /api/upload 入口。
 * 这样平台 uploader 能拿到用户刚刚修改的 appId、包名或 API Client 配置。
 *
 * @param {object} platform 当前平台配置。
 * @param {Function|undefined} refreshStatus 完整状态刷新函数。
 * @returns {Promise<boolean|void>} false 表示用户取消；否则撤销请求完成。
 */
async function revokeCurrentStoreReview(platform, refreshStatus) {
  if (!window.confirm(`确认要撤销 ${platform.name} 当前审核吗？如果该版本正在审核中，可能会直接影响线上发布节奏。`)) return false;

  const stores = collectStoreConfig();
  await requestJson("/api/store-config", {
    method: "POST",
    body: JSON.stringify({ stores }),
  });
  if (state.status?.storeConfig) state.status.storeConfig.stores = stores;

  setLocalStoreTaskProgress(platform.key, "revoke-review", "准备撤销审核", "正在初始化当前平台撤销任务");

  const result = await requestJson("/api/upload", {
    method: "POST",
    body: JSON.stringify({ storeKey: platform.key, action: "revoke-review" }),
  });
  appendStoreActionResult(result);
  if (result.state && state.status?.storeConfig) {
    state.status.storeConfig.states ||= {};
    state.status.storeConfig.states[platform.key] = result.state;
  }
  if (typeof refreshStatus === "function") await refreshStatus();
  if (!result.ok) throw new Error(formatStoreActionFailure(result, `${platform.name}撤销审核失败`));
  return true;
}

/**
 * 在请求发出前先更新本地任务进度。
 *
 * /api/upload 会在服务端启动真实进度，前端轮询会随后接管；
 * 这里先把按钮点击后的反馈显示出来，避免用户在网络请求阶段误以为没有反应。
 *
 * @param {string} storeKey 平台 key。
 * @param {string} action 任务动作。
 * @param {string} statusText 状态标题。
 * @param {string} detail 状态详情。
 * @returns {void}
 */
function setLocalStoreTaskProgress(storeKey, action, statusText, detail) {
  const progress = {
    running: true,
    store: storeKey,
    action,
    percent: 1,
    statusText,
    detail,
    elapsedText: "0秒",
  };
  state.status = {
    ...(state.status || {}),
    storeUploadProgress: progress,
  };
  if (elements.storeUploadProgressTitle) elements.storeUploadProgressTitle.textContent = `${storeKey} / ${statusText} / 1%`;
  if (elements.storeUploadProgressBar) elements.storeUploadProgressBar.style.width = "1%";
  if (elements.storeUploadElapsedText) elements.storeUploadElapsedText.textContent = "用时：0秒";
  if (elements.storeUploadProgressDetail) elements.storeUploadProgressDetail.textContent = detail;
  if (elements.stopUploadButton) elements.stopUploadButton.disabled = false;
}

/**
 * 读取华为 API Client JSON 并回填当前 tab 表单。
 *
 * @returns {Promise<void>} 导入完成。
 */
async function importHuaweiClientJson() {
  const stores = collectStoreConfig();
  if (state.status?.storeConfig) state.status.storeConfig.stores = stores;

  const result = await requestJson("/api/stores/huawei/import-client", {
    method: "POST",
    body: JSON.stringify({ config: stores.huawei || {} }),
  });
  appendStoreActionResult(result);
  if (!result.ok) throw new Error(formatStoreActionFailure(result, "华为 API Client JSON 读取失败"));

  state.status.storeConfig.stores.huawei = {
    ...(state.status.storeConfig.stores.huawei || {}),
    ...(result.config || {}),
  };
  applyHuaweiImportedConfigToForm(result.config || {});
  appendLog({ time: new Date().toISOString(), line: "华为 API Client 已回填到当前表单，请确认后手动保存上传配置。" });
  showToast("已回填表单，请手动保存", "success");
}

/**
 * 把华为 API Client JSON 解析结果直接写入当前表单。
 *
 * 这一步只更新浏览器里的输入框和 state，不自动调用保存接口；
 * 用户可以先看见字段已经回填，再决定是否点击“保存上传配置”。
 *
 * @param {object} config 华为 API Client 导入结果。
 * @returns {void}
 */
function applyHuaweiImportedConfigToForm(config) {
  Object.entries(config).forEach(([key, value]) => {
    const input = elements.storeConfig.querySelector(`[data-store="huawei"][data-key="${key}"]`);
    if (!input) return;
    input.value = value ?? "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/**
 * 创建华为步骤状态标签。
 *
 * @param {string} label 状态名称。
 * @param {string} value 最近执行时间。
 * @returns {HTMLElement} 状态 DOM。
 */
function createHuaweiFlowTimeline(stateInfo) {
  return createStoreFlowTimeline(HUAWEI_FLOW_STEPS, stateInfo);
}

/**
 * 创建应用商店分步骤状态条。
 *
 * 华为、荣耀、OPPO、vivo 都有“上传前置状态 -> 包体状态 -> 提交/查询状态”的内部流转；
 * 用同一个渲染函数可以保证步骤条样式和状态文案一致。
 *
 * @param {object[]} flowSteps 步骤定义。
 * @param {object} stateInfo 当前平台流程状态。
 * @returns {HTMLElement} 步骤条 DOM。
 */
function createStoreFlowTimeline(flowSteps, stateInfo) {
  const timeline = document.createElement("div");
  timeline.className = "store-flow-timeline";

  const firstPendingIndex = flowSteps.findIndex((step) => !getHuaweiStateValue(stateInfo, step.stateKey));
  flowSteps.forEach((step, index) => {
    const value = getHuaweiStateValue(stateInfo, step.stateKey);
    const done = Boolean(value);
    const current = !done && index === firstPendingIndex;

    const item = document.createElement("div");
    item.className = `store-flow-timeline-step ${done ? "done" : ""} ${current ? "current" : ""}`;
    item.title = value || "";

    const marker = document.createElement("span");
    marker.className = "store-flow-marker";
    marker.textContent = String(index + 1);

    const content = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = step.label;
    const note = document.createElement("p");
    note.textContent = step.note;
    const status = document.createElement("small");
    status.textContent = done ? `已完成：${formatHuaweiStepTime(value)}` : current ? "待执行" : "等待前置步骤";
    content.append(label, note, status);

    item.append(marker, content);
    timeline.appendChild(item);
  });
  return timeline;
}

/**
 * 按点路径读取华为流程状态字段。
 *
 * @param {object} stateInfo 华为流程状态。
 * @param {string} path 形如 uploadedPackage.uploadedAt 的字段路径。
 * @returns {unknown} 状态值。
 */
function getHuaweiStateValue(stateInfo, path) {
  return String(path || "")
    .split(".")
    .reduce((value, key) => value?.[key], stateInfo);
}

/**
 * 格式化华为步骤完成时间。
 *
 * @param {string} value ISO 时间字符串。
 * @returns {string} 适合步骤条内展示的时间。
 */
function formatHuaweiStepTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

/**
 * 执行华为某个分步骤动作。
 *
 * 按钮执行前先保存当前可见表单，避免用户修改了 Client ID、包路径后忘记点保存。
 *
 * @param {string} action 华为动作名。
 * @returns {Promise<void>} 动作完成。
 */
async function runHuaweiStep(action, refreshStatus) {
  if (action === "reset-state" && !window.confirm("确认要重置华为流程状态吗？这不会删除本地安装包，也不会修改上传配置。")) return;

  if (action !== "reset-state") {
    const stores = collectStoreConfig();
    await requestJson("/api/store-config", {
      method: "POST",
      body: JSON.stringify({ stores }),
    });
    if (state.status?.storeConfig) state.status.storeConfig.stores = stores;
  }

  if (action === "submit-review" && !window.confirm("确认要调用华为提交审核接口吗？")) return;

  const result = await requestJson(`/api/stores/huawei/${action}`, { method: "POST" });
  appendStoreActionResult(result);
  if (result.state && state.status?.storeConfig) {
    state.status.storeConfig.states ||= {};
    state.status.storeConfig.states.huawei = result.state;
  }
  renderStores(state.status.storeConfig);
  if (typeof refreshStatus === "function") await refreshStatus();
  if (!result.ok) throw new Error(formatStoreActionFailure(result, "华为发布步骤失败"));
}

/**
 * 把应用商店步骤执行结果写入构建日志。
 *
 * @param {object} result 步骤接口返回。
 * @returns {void}
 */
function appendStoreActionResult(result) {
  appendLog({ time: new Date().toISOString(), line: result.message || "应用商店步骤已返回。" });
  if (Array.isArray(result.missing) && result.missing.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `缺少配置或文件：${result.missing.join("、")}` });
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `提示：${result.warnings.join("、")}` });
  }
  if (Array.isArray(result.uploadedFiles) && result.uploadedFiles.length > 0) {
    appendLog({ time: new Date().toISOString(), line: `已上传文件：${result.uploadedFiles.map((file) => file.fileName || file.path).join("、")}` });
  }
  if (result.auditResult) {
    appendLog({ time: new Date().toISOString(), line: `审核结果：${formatStoreAuditResult(result.auditResult, result.auditResultLabel)}` });
  }
  if (result.taskState) {
    appendLog({ time: new Date().toISOString(), line: `任务状态：${formatStoreTaskState(result.taskState, result.taskStateLabel)}` });
  }
}

/**
 * 把各平台返回的审核结果对象整理成单行日志。
 *
 * 荣耀等平台会把审核状态放在 auditResult 数字里，如果只输出“查询完成”
 * 用户无法判断状态；这里优先使用后端传来的可读 label，再补充 releaseId、
 * 版本号和审核意见，方便在构建日志里直接确认结果。
 *
 * @param {object} auditResult 审核结果对象。
 * @param {string} auditResultLabel 后端转换后的审核状态文案。
 * @returns {string} 可读审核结果。
 */
function formatStoreAuditResult(auditResult = {}, auditResultLabel = "") {
  const result = typeof auditResult === "object" && auditResult !== null ? auditResult : { auditResult };
  const label = auditResultLabel || (result.auditResult === undefined ? "未返回审核状态" : `状态码 ${result.auditResult}`);
  const parts = [label];
  if (result.releaseId) parts.push(`releaseId: ${result.releaseId}`);
  if (result.versionName) parts.push(`版本: ${result.versionName}${result.versionCode ? `(${result.versionCode})` : ""}`);
  if (result.auditMessage) parts.push(`审核意见: ${result.auditMessage}`);
  if (result.auditAttachment) parts.push(`附件: ${result.auditAttachment}`);
  return parts.join("，");
}

/**
 * 把异步任务状态整理成单行日志。
 *
 * OPPO 发布版本是异步任务，接口返回 task_state 和 err_msg；这里把这些字段
 * 直接写进构建日志，避免用户只能看到“查询完成”。
 *
 * @param {object} taskState 任务状态对象。
 * @param {string} taskStateLabel 后端转换后的状态文案。
 * @returns {string} 可读任务状态。
 */
function formatStoreTaskState(taskState = {}, taskStateLabel = "") {
  const result = typeof taskState === "object" && taskState !== null ? taskState : { task_state: taskState };
  const label = taskStateLabel || (result.task_state === undefined ? "未返回任务状态" : `状态码 ${result.task_state}`);
  const parts = [label];
  if (result.version_code) parts.push(`version_code: ${result.version_code}`);
  if (result.err_msg) parts.push(`错误原因: ${result.err_msg}`);
  return parts.join("，");
}

/**
 * 整理应用商店步骤失败原因。
 *
 * @param {object} result 步骤接口返回。
 * @param {string} fallback 默认失败文案。
 * @returns {string} 带具体原因的错误文案。
 */
function formatStoreActionFailure(result, fallback) {
  const reasons = [...(Array.isArray(result.missing) ? result.missing : []), ...(Array.isArray(result.warnings) ? result.warnings : [])].filter(Boolean);
  return reasons.length > 0 ? `${result.message || fallback}：${reasons.join("；")}` : result.message || fallback;
}

/**
 * 收集当前可见商店 tab 的配置并合并回完整 stores。
 *
 * DOM 中只有当前 tab 的字段，所以必须从 state.status 复制完整 stores，
 * 再覆盖当前可见字段，避免保存一个平台时把其它平台配置清空。
 *
 * @returns {object} 可提交给 /api/store-config 的完整 stores 配置。
 */
function collectStoreConfig() {
  const stores = structuredClone(state.status.storeConfig.stores || {});
  elements.storeConfig.querySelectorAll("[data-store][data-key]").forEach((input) => {
    const store = input.dataset.store;
    const key = input.dataset.key;
    const type = input.dataset.type;
    stores[store] ||= {};

    if (type === "checkbox") {
      stores[store][key] = input.checked;
    } else if (type === "segmented") {
      stores[store][key] = input.dataset.valueType === "number" ? Number(input.value) : input.value;
    } else if (type === "xiaomi-category" || type === "oppo-category-second" || type === "oppo-category-third") {
      stores[store][key] = input.value === "" ? "" : input.dataset.valueType === "number" ? Number(input.value) : input.value;
    } else if (type === "number") {
      stores[store][key] = input.value === "" ? "" : Number(input.value);
    } else if (type === "list" || type === "image-list" || type === "file-list") {
      stores[store][key] = input.value
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter(Boolean);
    } else {
      stores[store][key] = input.value;
    }

    // 小米“一句话简介”字段已按当前文档改为 brief；保存新值后清理旧字段，
    // 防止后续排查 RequestData 时同时看到 brief/shortDesc 两套命名。
    if (store === "xiaomi" && key === "brief") delete stores[store].shortDesc;
  });
  return stores;
}

/**
 * 保存 Android 应用商店配置。
 *
 * @param {Function} refreshStatus 完整状态刷新函数。
 * @returns {Promise<void>} 保存和状态刷新完成。
 */
export async function saveStoreConfig(refreshStatus) {
  const stores = collectStoreConfig();
  await requestJson("/api/store-config", {
    method: "POST",
    body: JSON.stringify({ stores }),
  });
  appendLog({ time: new Date().toISOString(), line: "上传配置已保存到当前项目配置" });
  await refreshStatus();
}
