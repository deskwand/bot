package i18n

var zhMcpAdmin = map[string]string{
	"mcpadmin.unavailable":        "无法连接云端管理接口，请检查 PUBLIC_BASE_URL 与部署状态",
	"mcpadmin.networkUnreachable": "无法访问云端管理接口（网络超时或连接失败），请检查网络或代理设置",
	"mcpadmin.invalidResponse":    "云端管理接口返回了无法解析的响应",
	"mcpadmin.unauthorized":       "管理接口拒绝了令牌，请重启服务后重试。",
}
