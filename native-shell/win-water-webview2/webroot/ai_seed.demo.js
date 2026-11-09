/* 公开/测试版 AI 种子：不含任何私有密钥。用户需在「设置 → 智能AI设置」自行填写 API Key。
   由 strip_internal.py 在构建「单数(公开)版」时覆盖 ai_seed.js。 */
window.AI_SEED = {
  apiKey: "",
  default: "minimax-m27-free",
  strategy: { mode: "failover" }
};
