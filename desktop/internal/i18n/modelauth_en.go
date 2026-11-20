package i18n

var enModelAuth = map[string]string{
	"modelauth.unavailable":     "This deployment does not support subscription sign-in yet; update the deployment first",
	"modelauth.unknownProvider": "This deployment does not know that subscription provider; update the deployment",
	"modelauth.unreachable":     "Could not reach the deployment address; check the network and retry",
	"modelauth.invalidResponse": "The admin API returned an unexpected payload",
	"modelauth.unauthorized":    "The admin API rejected its token. Restart the service, then retry.",
}
