#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as reapply from "../lib/reapply.js";

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("dsh-purge 状态 / Status");
  out.push("  宿主 / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  桌面安装       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  插件根 / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  插件根 / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim 目录      ${state.shim_dir || "未定位 / not found"}`);
  out.push(`  备份 / backup  ${state.has_backup ? "有 / yes" : "无 / no"}`);
  out.push(`  注入文件       ${state.override_path}`);
  out.push(`  注入状态       ${state.override_status}`);
  out.push("");
  out.push(`  补丁 ${state.patches_applied}/${core.ALL_PATCHES.length} 已清洗, ${state.patches_pending} 待清洗`
    + (state.patches_drifted ? `, ${state.patches_drifted} 漂移（官方原文已改，需更新 pattern）` : ""));
  if (state.host_version) {
    const compat = state.host_supported === false ? `  ← 未适配：插件声明 ${state.host_target || "?"}` : "";
    out.push(`  宿主版本 / host  ${state.host_version}${compat}`);
  }
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : s === "drifted" ? "!" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--install-insert", "--status", "--edit", "--help"].includes(a));

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge 用法:
  dsh-purge --status         显示状态
  dsh-purge --apply          应用全部清洗（提示词+代码+shim+override）
  dsh-purge --revert         回滚还原
  dsh-purge --uninstall      卸载插件（已应用则先还原）
  dsh-purge --install-insert 补写 profile 的 bundles / 本体 insert / pnpm allowBuilds
  dsh-purge --edit           编辑注入文件 prompt-inject.md
  dsh-purge --help           帮助`);
    return;
  }

  const state = await core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: 把 DSH_BASE 指到含 dsh-agent-instructions/lib 的 @deepseek-ai 目录");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] 提示词和规则集都是空的，必须先添加提示词");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  宿主 / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ 已清洗" : r.status === "already" ? "- 已是最新" : r.status === "missing_file" ? "⚠ 文件缺失" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  多宿主 / multi-host: ${hosts.length} 份 @deepseek-ai 已清洗`);
    }
    console.log(inject.source === "rule"
      ? "  - 使用当前规则集，不改写提示词文件"
      : "  - 使用已有提示词文件");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} 注入 / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} 已注入 / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} 不存在 / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ 未定位 shim 目录，跳过注入");
    }
    const failed = core.summarizeApplyReport(report).failed || [];
    console.log("");
    if (failed.length > 0) {
      console.log(`✗ 完成但有 ${failed.length} 个补丁失败 / finished with ${failed.length} failed patch(es)`);
      process.exit(1);
    }
    // 面板点应用会打戳；CLI 也要打，否则下次启动 settle 以为没对齐又重打一遍（#202）。
    try {
      reapply.markPatchesApplied();
    } catch (e) {
      console.log(`  ⚠ 写入应用记录失败 / failed to write applied stamp: ${e && e.message ? e.message : e}`);
    }
    console.log("全部完成 / All done。重启 dsh 生效 / Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ 已还原 / Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ 还原失败 ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - 没有补丁备份可还原 / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("回滚完成 / Revert done。重启 dsh 后恢复 / restart to restore.");
    console.log("注: prompt-inject.md 保留（用户文件）/ prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  已检测到补丁，已还原回原版。");
    else console.log("  未检测到已应用补丁，仍会清除插件文件。");
    if (result.override?.removed) console.log(`  已删除 ${result.override.path}`);
    if (result.stripped?.length) console.log(`  已从 profile 移除: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  卸载中止：还原失败，插件文件未删除。");
      process.exit(1);
    }
    /* 命令行卸载没有「重启后助手」这一步：插件目录不会自己消失，得在这里删。
       （界面卸载是把这一步交给独立助手，等端口释放后再删。） */
    const fs = await import("node:fs");
    for (const dir of result.cleanup || []) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 }); }
      catch (e) { console.log(`  ⚠ 未能删除 ${dir}: ${e && e.message ? e.message : e}`); }
    }
    console.log("");
    console.log("卸载完成。请重启 dsh。");
  } else if (mode === "--install-insert") {
    /* [unrestricted] 本体 insert 的显式入口。
       当前版本的本体 `- insert: id: dsh-purge` 走 package.json 的
       postinstall → scripts/ensure-profile-bundle.mjs；`--ignore-scripts` 安装或
       postinstall 失败时那步不会跑，插件就静默不生效（面板没按钮、注入不进上下文）。
       这里复用 lib/profile-insert.js 已有的两个导出，把同一套补写逻辑变成可重跑的命令。 */
    const { ensureAllProfileBodyInserts, ensureAllProfileInstall } = await import("../lib/profile-insert.js");
    const home = state.dsh_home || core.findDshHome();
    // 第一次：真正补写（bundles + 本体 insert + pnpm allowBuilds），wrote 标记反映本次动作。
    const install = ensureAllProfileInstall(home);
    // 第二次：ensureAllProfileBodyInserts 是幂等的复检入口，跑完 wrote 应为 false，说明 insert 已在位。
    const inserts = ensureAllProfileBodyInserts(home);
    if (install.length === 0) {
      console.log(`  - ${home} 下没有带 dsh-purge 的 profile，无需补写 / no profile owns dsh-purge`);
    }
    const wrote = [];
    for (const row of install) {
      if (row.ok === false) {
        console.log(`  ✗ ${row.dir} — ${row.error || "install repair failed"}`);
        continue;
      }
      const bundles = row.bundles || {};
      const insert = row.insert || {};
      const pnpm = row.pnpm || {};
      console.log(`  profile ${row.dir}`);
      console.log(`    bundles     ${bundles.wrote ? "✓ 已补写 / appended" : "- 已在 / already"}  ${bundles.path || ""}`);
      console.log(`    body insert ${insert.wrote ? "✓ 已补写 / wrote" : insert.ok === false ? "⚠ 未识别 patch 体，跳过 / unrecognized patch body" : "- 已在 / already"}  ${insert.path || ""}`);
      console.log(`    allowBuilds ${pnpm.wrote ? "✓ 已补写 / wrote" : "- 已在 / already"}  ${pnpm.path || ""}`);
      if (bundles.wrote) wrote.push(bundles.path);
      if (insert.wrote) wrote.push(insert.path);
      if (pnpm.wrote) wrote.push(pnpm.path);
    }
    for (const row of inserts) {
      if (row.error) console.log(`  ⚠ 复检 ${row.path}: ${row.error}`);
      else if (row.wrote) console.log(`  ✓ 复检时又补写一次 / wrote on recheck: ${row.path}`);
    }
    if (!inserts.some((r) => r.wrote) && install.length > 0) {
      console.log("  复检通过 / recheck: 本体 insert 已在所有 profile 就位");
    }
    console.log(wrote.length ? `  本次写入 / wrote: ${wrote.join(", ")}` : "  本次没有写盘 / nothing to write");
    const failed = install.filter((r) => r.ok === false).length;
    console.log("");
    console.log("重启 dsh 生效 / Restart dsh to take effect.");
    if (failed > 0) process.exit(1);
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ 已创建默认注入文件：${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → 已打开 ${r.editor} 编辑注入文件：${r.path}`);
    }
    console.log("  编辑完成后重启 dsh 生效。");
  } else {
    console.log("默认不清洗，使用 --apply 应用清洗。");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
