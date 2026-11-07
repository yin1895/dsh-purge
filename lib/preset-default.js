/**
 * [unrestricted] 停用/卸载不再改用户的预设选择，也不再删除插件预设目录。
 *
 * 上游 1.1.9x 的语义是「清掉插件痕迹」：把 profile 里的
 * `selectedDefault: …/redteam` 改回 standard，再 rm -rf
 * `$DSH_HOME/.agent-presets/redteam`。这两步对用户都是破坏性的 ——
 * 用户自己选过红队模式，插件停用/卸载不该替他改选，更不该删掉预设目录。
 *
 * 原来的动机是 #108：宿主 resolve() 对未知预设是硬抛，不回退 config.default。
 * 保留 `.agent-presets/redteam`（连同本包写进去的模板文件）本身就是这个问题的解：
 * 目录在，预设就能解析，selectedDefault 仍指向一个存在的预设，不存在悬空引用。
 * 目录里那份是用户环境里正在生效的副本，交由用户自己处置。
 *
 * 现在整个模块是「只读探测 + 兼容外壳」：
 *   - inspectOwnedSelectedDefault() 只读探测，报告哪些 profile 仍指向本插件预设；
 *   - clearOwnedSelectedDefault() 保留原名与返回形状（uninstall.js / index.js 仍在调），
 *     行为等同只读探测；
 *   - scheduleClearOwnedSelectedDefault() 保留 800ms 延迟与 apply 时取消的既有节流语义，
 *     回调里做同样的只读探测；
 *   - removeStaleAgentPresetDir() 默认把目录留着，只有显式传 opts.force === true 才删。
 */
import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";

const OWNED_PRESET_IDS = ["redteam"];

function isOwnedPresetId(value) {
  const id = String(value || "").trim().toLowerCase();
  if (!id) return false;
  return OWNED_PRESET_IDS.some((own) => id === own || id.endsWith(`/${own}`));
}

function readText(fp) {
  try {
    return fs.readFileSync(fp, "utf8");
  } catch {
    return "";
  }
}

function listProfilePatchFiles(dshHome) {
  const root = path.join(dshHome, "profiles");
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules") continue;
    for (const file of ["cordis.patch.yml", "cordis.yml"]) {
      const fp = path.join(root, name, file);
      if (fs.existsSync(fp)) out.push(fp);
    }
  }
  return out;
}

/**
 * [unrestricted] 判断用，不改写：YAML 里的 selectedDefault 是否指向本插件预设。
 * 匹配范围沿用旧版 repairSelectedDefaultInYaml 的正则，只是去掉 $1$2standard$2 那段替换。
 */
function yamlSelectedDefaultIsOwned(text) {
  const src = String(text || "");
  if (!/selectedDefault/.test(src)) return false;
  return /(?:selectedDefault\s*:\s*)(["']?)(?:[\w.-]+\/)?redteam\1/i.test(src);
}

function configValue(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  try {
    if (typeof node.get === "function") return String(node.get() ?? "");
  } catch {
    /* ignore */
  }
  try {
    if (typeof node.value !== "undefined") return String(node.value ?? "");
  } catch {
    /* ignore */
  }
  return "";
}

/** [unrestricted] 只读判断运行时 settings 里的 selectedDefault 是否指向本插件预设。 */
function liveSelectedDefaultIsOwned(ctx) {
  if (!ctx) return false;
  try {
    const settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
    const row = settings?.get?.("agent-preset-registry")
      || settings?.get?.("@deepseek-ai/dsh-agent-preset-registry");
    return isOwnedPresetId(configValue(row?.config?.selectedDefault || row?.selectedDefault));
  } catch {
    return false;
  }
}

/**
 * 停用/卸载时调用：只读探测，报告哪些 profile / 运行时设置仍指向本插件预设。
 * 返回形状沿用旧的 clearOwnedSelectedDefault：{ live, files }。
 * @returns {{ live: boolean, files: string[], kept: boolean, mode: string }}
 */
export function inspectOwnedSelectedDefault({ ctx = null, dshHome = "" } = {}) {
  const home = dshHome || findDshHome();
  const report = { live: false, files: [], kept: true, mode: "inspect-only" };
  try {
    report.live = liveSelectedDefaultIsOwned(ctx);
  } catch {
    report.live = false;
  }
  if (!home) return report;
  for (const fp of listProfilePatchFiles(home)) {
    try {
      if (yamlSelectedDefaultIsOwned(readText(fp))) report.files.push(fp);
    } catch {
      /* 单个 profile 读失败不挡停用 */
    }
  }
  return report;
}

/**
 * 兼容导出 [unrestricted]：名字与返回形状保留，行为改为只读探测。
 * 停用/卸载不把 selectedDefault 回退成 standard，也不重排整份 YAML。
 * @returns {{ live: boolean, files: string[], kept: boolean, mode: string }}
 */
export function clearOwnedSelectedDefault(opts = {}) {
  return inspectOwnedSelectedDefault(opts);
}

let pendingClear = null;

/**
 * 热重载会先 dispose 再 apply：延迟窗口保留，apply 进来就取消，既有节流时序不变。
 * [unrestricted] 回调里不再写盘、不再删目录，只做只读探测，避免把用户的红队默认冲掉。
 */
export function scheduleClearOwnedSelectedDefault(opts = {}) {
  if (pendingClear) {
    clearTimeout(pendingClear);
    pendingClear = null;
  }
  pendingClear = setTimeout(() => {
    pendingClear = null;
    try { inspectOwnedSelectedDefault(opts); } catch { /* 停用不被探测挡住 */ }
  }, 800);
  if (typeof pendingClear.unref === "function") pendingClear.unref();
}

export function cancelClearOwnedSelectedDefault() {
  if (!pendingClear) return;
  clearTimeout(pendingClear);
  pendingClear = null;
}

/**
 * [unrestricted] 默认把 `.agent-presets/<id>` 留着。
 * 目录里是用户当前选中的预设；删掉它等于把 selectedDefault 变成悬空引用（#108）。
 * 想真清理时显式传 opts.force === true：oldCallers 用 (dshHome, id) 两参调用，行为不变。
 */
export function removeStaleAgentPresetDir(dshHome, id = "redteam", opts = {}) {
  const home = dshHome || findDshHome();
  if (!home || !id) return false;
  const dir = path.join(home, ".agent-presets", id);
  try {
    if (!fs.existsSync(dir)) return false;
    if (!opts || opts.force !== true) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
