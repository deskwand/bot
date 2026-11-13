package i18n

var enWalletAdmin = map[string]string{
	"walletadmin.unavailable":     "Cannot reach this deployment's admin API; check that it finished deploying",
	"walletadmin.unreachable":     "Could not reach the deployment address; check the network and retry",
	"walletadmin.invalidResponse": "The admin API returned an unexpected payload",
	"walletadmin.unauthorized":    "The admin API rejected its token. Restart the service, then retry.",
}
