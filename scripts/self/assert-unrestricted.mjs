#!/usr/bin/env node
/**
 * [unrestricted] v1.2.0 —— 「无限制」不变量检查 CLI。
 *
 * 用法：
 *   node scripts/self/assert-unrestricted.mjs           # 全量（含解封注入体）
 *   node scripts/self/assert-unrestricted.mjs --no-slot # 不解封（更快）
 *
 * 退出码：0 = 全部通过；1 = 存在被重新引入的限制（详见输出）。
 * 建议：每次从上游同步后、每次发版前都跑一遍。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertUnrestricted } from "../../lib/unrestricted-guard.js";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const skipSlot = process.argv.includes("--no-slot");

let openSlot = null;
if (!skipSlot) {
  try {
    const mod = await import("../../lib/table-read.js");
    openSlot = mod.openSlot;
  } catch {
    openSlot = null;
  }
}

const report = assertUnrestricted({ root, openSlot });

const line = "─".repeat(66);
process.stdout.write(`\n${line}\n「无限制」不变量检查 — ${root}\n${line}\n`);
if (report.infos.length) {
  process.stdout.write("ℹ 信息：\n");
  for (const i of report.infos) process.stdout.write(`   · [${i.id}] ${i.detail}\n`);
}
if (report.failures.length) {
  process.stdout.write("\n✗ 发现被重新引入的限制：\n");
  for (const f of report.failures) process.stdout.write(`   · [${f.id}] ${f.detail}\n`);
  process.stdout.write(`\n结论：FAIL（${report.failures.length} 项）\n${line}\n`);
  process.exit(1);
}
process.stdout.write("\n✓ 全部通过：不存在拒绝/降级/截断机制。\n");
process.stdout.write(`${line}\n`);
