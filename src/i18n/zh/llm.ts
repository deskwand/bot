export const llm = {
  windowDowngrade: "无法切换管家模型：{source} 的上下文窗口为 {from} token，目标模型 {target} 只有 {to} token。目标不足当前窗口的四分之一，跨度过大。当前会话模型和对话已保留，请选择窗口至少为当前四分之一的模型。",
  windowUnknown: "无法确认模型的上下文窗口，未切换管家模型。请更新模型目录并检查自定义模型的窗口配置。",
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
