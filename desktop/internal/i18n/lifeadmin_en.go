package i18n

var enLifeAdmin = map[string]string{
	"lifeadmin.unavailable":     "Cannot reach this deployment's admin API; check that it finished deploying",
	"lifeadmin.unreachable":     "Could not reach the deployment address; check the network and retry",
	"lifeadmin.invalidResponse": "The admin API returned an unexpected payload",
	"lifeadmin.unsupported":     "The cloud service is too old to report vitals; upgrade it first",
	"lifeadmin.unauthorized":    "The admin API rejected its token. Restart the service, then retry.",
}
