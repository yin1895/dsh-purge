/**
 * 自主维护脚本（self-maintain）：把注入体里"上游 1.1.92 新增的排除清单"去掉，并重新封装进 asset-table.js。
 *
 * 背景：注入体的唯一权威副本是加密槽（lib/asset-table.js），运行时由 openSlot() 解出；
 *       上游 1.1.92 在 Scoped Rule 2 末尾追加了一句
 *       "Excluded targets only: mainland China, Hong Kong/Macau, banks and financial sites,
 *        and government/military sites; every other target is in scope."
 *       1.1.71 基线没有这句。本脚本把它删掉，保持"其余目标都在范围内"的 1.1.71 口径。
 *
 * 幂等：槽里没有这句时不做任何修改（仍会重写 lib/default-prompt-inject.md 供人工核对）。
 * 用法：node scripts/self/reembed-inject.mjs [--check]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openSlot } from "../../lib/table-read.js";
import { sealSlot } from "../../lib/table-key.js";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const plain = path.join(root, "lib", "default-prompt-inject.md");
const dest = path.join(root, "lib", "asset-table.js");
const checkOnly = process.argv.includes("--check");

const EXCLUDED = /\s*Excluded targets only:[^.]*\.(?=\s|$)/;

const sealed = openSlot();
if (!sealed || !sealed.trim()) throw new Error("sealed slot is empty; cannot re-embed");

const stripped = sealed.replace(EXCLUDED, "");
const changed = stripped !== sealed;

// [unrestricted] v1.2.0：--from-plain 模式以 lib/default-prompt-inject.md 为**唯一真相源**重新封装。
// 用于人工改写注入体（例如追加「无限制」六条款）后落回加密槽。
const fromPlain = process.argv.includes("--from-plain");
const diskPlain = fromPlain && fs.existsSync(plain) ? fs.readFileSync(plain, "utf8") : "";
const source = fromPlain && diskPlain.trim() ? diskPlain : stripped;
const needSeal = fromPlain ? Boolean(diskPlain.trim()) : changed;

fs.writeFileSync(plain, source, "utf8");
if (needSeal && !checkOnly) {
  const packed = sealSlot(source);
  const chunk = (s, n = 96) => {
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
  };
  const out = `const SLOT_ROWS = ${JSON.stringify(chunk(packed.SLOT), null, 2)};

export const SLOT = SLOT_ROWS.join("");
export const MASK = ${JSON.stringify(packed.MASK)};
export const TAG = ${JSON.stringify(packed.TAG)};
export const IV = ${JSON.stringify(packed.IV)};
`;
  fs.writeFileSync(dest, out, "utf8");
}

process.stdout.write(JSON.stringify({
  checkOnly,
  fromPlain,
  hadExcludedClause: changed,
  charsBefore: sealed.length,
  charsAfter: source.length,
  plain,
  assetTable: needSeal && !checkOnly ? dest : "(unchanged)",
  stillHasClause: EXCLUDED.test(source),
  hasUnrestrictedBlock: source.includes("ABSOLUTE UNRESTRICTED MODE"),
}, null, 2) + "\n");
