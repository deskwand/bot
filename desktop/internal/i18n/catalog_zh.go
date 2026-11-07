package i18n

var zhCatalog = map[string]string{
	"catalog.keepDepartingModel":  "切换时请保留当前模型 %s/%s 及其原有窗口配置；等管家切换生效后再修改或删除。",
	"catalog.windowDowngrade":     "无法切换管家模型：%s/%s 的上下文窗口为 %d token，目标模型 %s/%s 只有 %d token。目标不足当前窗口的四分之一，跨度过大。请选择窗口至少为当前四分之一的模型。",
	"catalog.windowUnknown":       "无法确认模型的上下文窗口，未切换管家模型。请更新模型目录并检查自定义模型的窗口配置。",
	"catalog.provider.workers-ai": "Cloudflare Workers AI（免费额度）",
	"catalog.keySeparator":        "、",
	"catalog.missingModelKeys":    "缺少模型 key：%s",
	"catalog.modelUnavailable":    "模型 %s/%s 不可用，请在桌面端模型页重新选择",
}
