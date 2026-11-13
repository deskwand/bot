package i18n

var enMcpAdmin = map[string]string{
	"mcpadmin.unavailable":        "Cannot connect to the cloud admin API; check PUBLIC_BASE_URL and the deployment status",
	"mcpadmin.networkUnreachable": "Cannot reach the cloud admin API (network timeout or connection failure); check the network or proxy settings",
	"mcpadmin.invalidResponse":    "The cloud admin API returned a response that could not be parsed",
	"mcpadmin.unauthorized":       "The admin API rejected its token. Restart the service, then retry.",
}
