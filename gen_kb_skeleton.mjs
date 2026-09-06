#!/usr/bin/env node
// gen_kb_skeleton.mjs —— 构建期预生成"本地知识库骨架"，嵌入发行版。
// 逻辑与 js/kb.js rebuildSkeleton() 严格对齐：每条建筑 → 1 个 building 条目；全量 → 1 个 index 总索引。
// 运行：node gen_kb_skeleton.mjs [data.json] [kb_skeleton.json]
// 产物：kb_skeleton.json = { entries:[{id,type,title,tags,md,meta}] }
// 首启时 app.js initKB() 检测 KB 空 → fetch('kb_skeleton.json') 批量导入 → 离线即时可用，无需运行期重建。
// ⚠️ 若 kb.js rebuildSkeleton 的 md 模板/字段有改动，必须同步改这里（两处必须一致）。
import fs from "fs";

function uid() { return "kb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

const src = process.argv[2] || "data.json";
const out = process.argv[3] || "kb_skeleton.json";
const raw = JSON.parse(fs.readFileSync(src, "utf8"));
// 与 app.js load() 保持一致：data.json 顶层用 .features（.records 为兼容别名）
const records = Array.isArray(raw) ? raw : (raw.features || raw.records || []);

const valid = records.filter((r) => r && r.lat != null && r.lon != null);
const entries = [];
for (const r of valid) {
  const ph = (r.photos || []).length;
  const rows = Object.entries(r.params || {}).map(([k, v]) => `| ${k} | ${v} |`).join("\n");
  const md = [
    `# ${r.name || "未命名"}`,
    "",
    `- 管理所：${r.office || "-"}`,
    `- 管理站/渠道段：${r.station || "-"}`,
    `- 类型：${r.btype || "-"}`,
    `- 坐标：${r.lat}, ${r.lon}`,
    `- 照片：${ph} 张（存储于本地 IndexedDB / 附件，离线可用）`,
    "",
    "## 工程参数",
    rows ? "| 字段 | 值 |\n|---|---|\n" + rows : "（无）",
  ].join("\n");
  entries.push({
    id: "bld_" + (r.id || uid()),
    type: "building",
    title: r.name || "未命名",
    tags: [r.office, r.btype, "建筑"].filter(Boolean),
    md,
    meta: { source: "skeleton", rid: r.id },
  });
}
const idxRows = valid.map((r) => `| ${r.name || ""} | ${r.office || ""} | ${r.btype || ""} | ${r.lat},${r.lon} | ${(r.photos || []).length} |`).join("\n");
const idxMd = ["# 建筑物总索引", "", "| 名称 | 管理所 | 类型 | 坐标 | 照片 |", "|---|---|---|---|---|", idxRows].join("\n");
entries.push({ id: "index", type: "index", title: "建筑物总索引", tags: ["索引"], md: idxMd, meta: { source: "skeleton" } });

fs.writeFileSync(out, JSON.stringify({ entries }, null, 0));
console.log(`kb_skeleton.json 生成完成：${entries.length} 条（建筑 ${entries.length - 1} + 索引 1）← ${src}`);
