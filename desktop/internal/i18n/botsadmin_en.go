package i18n

var enBotAdmin = map[string]string{
	"botsadmin.unreachable":     "Could not reach the deployment address; check the network and retry",
	"botsadmin.invalidResponse": "The admin API returned an unexpected bot payload",
	"botsadmin.unsupported":     "This deployment has no bots API yet; upgrade it to see the bots",
	"botsadmin.notFound":        "This bot has no record",
	"botsadmin.unauthorized":    "The admin API rejected its token. Restart the service, then retry.",
	"botsadmin.requestFailed":   "The admin API returned an error",
}
