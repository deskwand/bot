package i18n

var enMemberAdmin = map[string]string{
	"memberadmin.unreachable":     "Could not reach the deployment address; check the network and retry",
	"memberadmin.invalidResponse": "The admin API returned an unexpected member payload",
	"memberadmin.unsupported":     "This deployment has no member API yet; upgrade it first",
	"memberadmin.notFound":        "That user or invitation does not exist",
	"memberadmin.unauthorized":    "The admin API rejected its token. Restart the service, then retry.",
	"memberadmin.requestFailed":   "The admin API returned an error",
	"memberadmin.maintenance":     "A backup or restore is running; users cannot change until it finishes",
	"memberadmin.pinExhausted":    "The PIN budget is spent; start a new invitation",
	"memberadmin.invitePending":   "That name already has a pending invitation; cancel it or wait for it to expire",
	"memberadmin.invalidLabel":    "The name cannot be empty or longer than 64 characters",
	"memberadmin.wrongStage":      "The invitation moved to another stage; refresh and retry",
	"memberadmin.immutable": "The first channel cannot be removed",
	"memberadmin.rebindNeeded": "The session expired; rebind this channel",
}
