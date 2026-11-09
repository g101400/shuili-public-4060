/* 【2026-11-04 清凭据】真 key 已移出源树 → 备份在 .real 档（.gitignore 覆盖，不随树外传）。
   需要本机带 key 运行：把 ai_seed.private.bak 复制回 ai_seed.js（一行命令见 memory 2026-11-04）。*/
/* 公开/测试版 AI 种子：不含任何私有密钥。用户需在「设置 → 智能AI设置」自行填写 API Key。
   由 strip_internal.py 在构建「单数(公开)版」时覆盖 ai_seed.js。 */
window.AI_SEED = {
  apiKey: "",
  default: "minimax-m27-free",
  strategy: { mode: "failover" }
};
