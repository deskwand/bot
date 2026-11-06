export const llm = {
  quotaExhausted:
    "今天的 Cloudflare 免费模型额度已用完（UTC 0 点重置，即北京时间 8 点）。想继续用，可以在桌面端模型页换成自己的模型 key。",
  paidPlanRequired:
    "当前模型需要 Cloudflare Workers 付费计划，请在桌面端模型页换成免费计划可用的模型（例如默认的 Gemma 4 26B）。",
  modelUnavailable: "模型 {provider}/{id} 不可用，请在桌面端模型页重新选择",
  modelUnavailableShort: "模型 {provider}/{id} 不可用",
  modelKeyMissing:
    "模型 {provider} 没有配置 key（{secret}），请在桌面端模型页填写",
  bindingUnavailable: "Workers AI binding 不可用，请在桌面端重新部署",
} as const;
