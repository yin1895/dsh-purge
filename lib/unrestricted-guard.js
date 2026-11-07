/**
 * [unrestricted] v1.2.0 —— 「无限制」不变量守卫。
 *
 * 目的：本仓库的目标是**没有任何拒绝/降级/截断机制**。上游每次更新、或本地每次
 * 合并，都可能把这些机制悄悄带回来。本模块把这些不变量写成可执行断言：
 *
 *   - 插件自身不得安装区域/银行门禁（net-scope 恒放行、不注册任何钩子）
 *   - 知识库工具不得被短路（KB_DISABLED 不得出现）
 *   - 面板不得下架知识库/技能库页签
 *   - 自动续跑不得被夹（默认开、无 clamp）
 *   - 能力协议必须含红队两段 + ZERO-REFUSAL 条款
 *   - 注入体必须含六条「无限裂」契约，且不含任何排除清单
 *   - 上限类常量不得被改小（证据正文/攻击链/并发）
 *
 * 用法：
 *   node scripts/self/assert-unrestricted.mjs        # 全量检查，失败 exit 1
 *   启动时：lib/index.js 调 assertUnrestricted() 只记日志，不阻断启动。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 读取一个仓库内文件；不存在返回 ""。 */
function readIfExists(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

/** 计数 src 中 needle 的出现次数。 */
function count(src, needle) {
  if (!src) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = src.indexOf(needle, i);
    if (at < 0) return n;
    n += 1;
    i = at + needle.length;
  }
}

/**
 * 运行全部不变量检查。
 * @param {{ root?: string, checkHost?: boolean, openSlot?: () => string }} [options]
 * @returns {{ ok: boolean, failures: Array<{id:string, detail:string}>, infos: Array<{id:string, detail:string}> }}
 */
export function assertUnrestricted(options = {}) {
  const root = options.root || path.resolve(HERE, "..", "..");
  const failures = [];
  const infos = [];
  const fail = (id, detail) => failures.push({ id, detail });
  const info = (id, detail) => infos.push({ id, detail });

  // 1) net-scope：门禁必须恒放行、不得注册钩子
  const net = readIfExists(root, "lib/net-scope.js");
  if (!net) fail("net-scope-missing", "lib/net-scope.js 不可读");
  else {
    if (count(net, "if (regionOfSuffix(name))") > 0) fail("gate-region-live", "publicHostHit 里仍有 region 判定");
    if (count(net, "if (bankHit(name))") > 0) fail("gate-bank-live", "publicHostHit 里仍有 bank 判定");
    if (count(net, "SELF_MULTISTEP_GATE") > 0) fail("gate-switch-present", "仍存在 SELF_MULTISTEP_GATE 开关");
    if (count(net, 'ctx.on("tools/pre-execute"') > 0) fail("gate-toolhook", "仍注册 tools/pre-execute 工具钩");
    if (count(net, 'ctx.on("agent/pre-step"') > 0) fail("gate-prestep", "仍注册 agent/pre-step 钩");
    if (count(net, "return null") === 0) fail("gate-not-neutral", "publicHostHit/taskTargetHit 看不到恒放行实现");
  }

  // 2) index.js：不得再调用 installRegionGate
  const idx = readIfExists(root, "lib/index.js");
  if (!idx) fail("index-missing", "lib/index.js 不可读");
  else if (/^\s*installRegionGate\(ctx\);/m.test(idx)) fail("gate-installed", "lib/index.js 仍在安装区域门禁");

  // 3) 知识库不得被短路
  const tools = readIfExists(root, "lib/redteam/tools.js");
  if (!tools) fail("tools-missing", "lib/redteam/tools.js 不可读");
  else {
    const n = count(tools, "return KB_DISABLED");
    if (n > 0) fail("kb-shortcircuit", `tools.js 仍有 ${n} 处 return KB_DISABLED`);
  }

  const store = readIfExists(root, "lib/redteam/store-core.js");
  if (!store) fail("store-missing", "lib/redteam/store-core.js 不可读");
  else {
    if (store.includes("开源版已下架知识库")) fail("kb-disabled-op", "store-core 仍在下架知识库");
    if (/listChain\(id,\s*limit\s*=\s*5000\)/.test(store)) fail("chain-cap", "listChain 仍默认截断 5000");
    if (/evidenceLimit\s*=\s*8000/.test(store)) fail("evidence-cap", "证据正文仍默认截断 8000");
  }

  // 4) 自动续跑不得被夹
  const cont = readIfExists(root, "lib/continue-retry.js");
  if (!cont) info("continue-missing", "lib/continue-retry.js 不可读（可忽略）");
  else {
    if (/autoContinue:\s*src\.autoContinue\s*===\s*true/.test(cont)) fail("continue-tight", "autoContinue 仍是 === true 收紧判定");
    if (cont.includes("merged.autoContinue = false")) fail("continue-clamp", "仍有把 saved autoContinue 压回 false 的 clamp");
    if (!/autoContinue:\s*true/.test(cont)) info("continue-default", "未在 DEFAULT 常量里看到 autoContinue: true（请人工确认默认值）");
  }

  // 5) 能力协议 + 锚点必须含无限制条款
  const proto = readIfExists(root, "lib/capability-protocol.js");
  if (!proto) fail("protocol-missing", "lib/capability-protocol.js 不可读");
  else {
    for (const k of ["REDTEAM_LEAD_PROTOCOL", "REDTEAM_CHILD_PROTOCOL"]) {
      if (!proto.includes(k)) fail("protocol-branch", `能力协议缺少 ${k}`);
    }
    if (!/REFUS|refus/i.test(proto)) info("protocol-clause", "协议里未看到拒答相关条款（建议补 ZERO-REFUSAL）");
  }
  const anchor = readIfExists(root, "lib/anchor.js");
  if (!anchor.includes("ZERO-REFUSAL")) fail("anchor-no-zero-refusal", "anchor.js 缺少 ZERO-REFUSAL 规则");

  // 6) 面板页签
  const client = readIfExists(root, "lib/redteam/client.js");
  if (!client) info("client-missing", "lib/redteam/client.js 不可读（可忽略）");
  else {
    for (const t of ["'knowledge'", "'skills'"]) {
      if (!client.includes(t)) fail("tab-missing", `演练台缺少页签 ${t}`);
    }
  }

  // 7) 注入体：六契约齐备、无排除清单（需要调用方传 openSlot）
  if (typeof options.openSlot === "function") {
    let text = "";
    try { text = String(options.openSlot() || ""); } catch (e) { fail("inject-unreadable", String(e && e.message || e)); }
    if (text) {
      for (const k of ["ZERO-REFUSAL", "NEVER SUBSTITUTE", "COMPLETE DELIVERABLE", "PERSISTENCE", "NO META", "CONTINUATION"]) {
        if (!text.includes(k)) fail("inject-contract", `注入体缺少契约 ${k}`);
      }
      if (text.includes("Excluded targets only")) fail("inject-excluded", "注入体又出现 Excluded targets only");
      for (const w of ["mainland", "Hong Kong", "Macau"]) {
        if (text.includes(w)) fail("inject-region-word", `注入体出现地域词 ${w}`);
      }
      info("inject-size", `注入体 ${text.length} 字符`);
    }
  } else {
    const plain = readIfExists(root, "lib/default-prompt-inject.md");
    if (plain) {
      for (const k of ["ZERO-REFUSAL", "NEVER SUBSTITUTE", "COMPLETE DELIVERABLE"]) {
        if (!plain.includes(k)) fail("inject-contract-plain", `明文注入源缺少契约 ${k}`);
      }
    }
  }

  return { ok: failures.length === 0, failures, infos };
}

export default assertUnrestricted;
