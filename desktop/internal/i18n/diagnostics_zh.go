package i18n

var zhDiagnostics = map[string]string{
	"diagnostics.versionUnknown":   "未知",
	"diagnostics.logs":             "日志",
	"diagnostics.staleVersion":     "旧版本 %s 的 %s，不是当前版本；未据此判定当前状态",
	"diagnostics.userConfirmed":    "（用户确认，非云端日志）",
	"diagnostics.localProbe":       "（本机探测，不代表云端收发正常）",
	"diagnostics.unknownSource":    "（来源未知）",
	"diagnostics.configuredNoLogs": "已配置；尚无当前版本的云端日志",
	"diagnostics.noEvidence":       "未找到可用证据（日志可能未保存或被采样）",
	"diagnostics.noDetail":         "证据没有事件说明",
	"diagnostics.heartbeat":        "%s（心跳不代表轮询成功）",
}
