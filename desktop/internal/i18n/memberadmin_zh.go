package i18n

var zhMemberAdmin = map[string]string{
	"memberadmin.unreachable":     "无法连接部署地址，请检查网络后重试",
	"memberadmin.invalidResponse": "管理接口返回了无法识别的用户数据",
	"memberadmin.unsupported":     "这个部署还没有用户管理接口，请先升级部署",
	"memberadmin.notFound":        "找不到这个用户或邀请",
	"memberadmin.unauthorized":    "管理接口拒绝了这个令牌，请重启服务后重试",
	"memberadmin.requestFailed":   "管理接口返回了错误",
	"memberadmin.maintenance":     "正在备份或恢复，暂时不能修改用户，请稍后重试",
	"memberadmin.pinExhausted":    "PIN 输入次数已用尽，请重新发起邀请",
	"memberadmin.invitePending":   "这个名称已经有一条待绑定邀请，先取消它或等它过期",
	"memberadmin.invalidLabel":    "名称不能为空，也不能超过 64 个字符",
	"memberadmin.wrongStage":      "邀请的阶段已经变化，请刷新后重试",
}
