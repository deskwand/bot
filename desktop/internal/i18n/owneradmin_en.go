package i18n

var enOwnerAdmin = map[string]string{
	"owneradmin.unreachable":     "Could not reach the deployment address; check the network and retry",
	"owneradmin.invalidResponse": "The admin API returned an unexpected payload",
	"owneradmin.unsupported":     "The cloud service is too old to manage the owner; upgrade it first",
	"owneradmin.unauthorized":    "The admin API rejected its token. Restart the service, then retry.",
}
