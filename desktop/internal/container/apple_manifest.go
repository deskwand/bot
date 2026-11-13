package container

import (
	"fmt"
	"regexp"
	"strings"
)

// The Apple container instance is a single container per directory: the run
// script is the only manifest, and launchd keeps it alive at login.
const (
	appleContainerName = "deskwand-bot"
	appleVolume        = "deskwand-data"
	agentLabel         = "com.deskwand.bot"
	agentPlistPath     = "~/Library/LaunchAgents/com.deskwand.bot.plist"
)

// appleDataOwner owns the data volume before the bot starts. container/
// Dockerfile creates the deskwand user and owns /data with it, but Apple's
// container tool hands a fresh volume to root, so the run script sets it.
const appleDataOwner = "10001:10001"

// appleXMLText escapes a string for use as XML text or as an attribute value.
var appleXMLText = strings.NewReplacer(
	"&", "&amp;",
	"<", "&lt;",
	">", "&gt;",
	`"`, "&quot;",
	"'", "&apos;",
)

// appleScriptMarker marks a run.sh that this client wrote. The files of the two
// engines can both live in a directory, so only a file that carries the marker
// is proof of which engine owns it.
const appleScriptMarker = "Managed by DeskWand"

// appleImagePattern matches the image on the run script's exec line, up to the
// end of that line. Anchoring on exec keeps the helper commands that run
// earlier mention the same image out of the match, and reading the tag whole
// keeps a hostile tail from being truncated into a value that looks valid.
var appleImagePattern = regexp.MustCompile(`(?m)^exec .*?` + regexp.QuoteMeta(ImageRepository) + `:([^\r\n]*)$`)

// appleRunScript returns run.sh: it starts the container service (launchd has
// nobody to answer the kernel install prompt), clears a stale container, hands
// the data volume to the bot user, and then execs the bot so launchd supervises
// the container process itself.
func appleRunScript(absDir, containerBin, image string) []byte {
	quotedDir := "'" + absDir + "'"
	quotedBin := "'" + containerBin + "'"
	return []byte(fmt.Sprintf(`#!/bin/sh
# %s. Rewritten on deploy.
cd %s || exit 1
mkdir -p logs
if [ -f logs/launchd.log ] && [ "$(wc -c < logs/launchd.log)" -gt 1048576 ]; then : > logs/launchd.log; fi
%s system start --enable-kernel-install
%s rm -f %s >/dev/null 2>&1
%s run --rm --user root --entrypoint chown -v %s:/data %s %s /data
exec %s run --rm --name %s --env-file .env -p 127.0.0.1:8787:8787 -v %s:/data %s
`, appleScriptMarker, quotedDir, quotedBin, quotedBin, appleContainerName, quotedBin, appleVolume, image, appleDataOwner, quotedBin, appleContainerName, appleVolume, image))
}

// appleAgentPlist returns the launchd agent that runs run.sh at login and
// restarts it if it dies.
func appleAgentPlist(absDir string) []byte {
	log := absDir + "/logs/launchd.log"
	return []byte(fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>%s</string>
	<key>StandardErrorPath</key>
	<string>%s</string>
</dict>
</plist>
`, appleXMLText.Replace(agentLabel), appleXMLText.Replace(absDir+"/run.sh"), appleXMLText.Replace(log), appleXMLText.Replace(log)))
}

// appleImageRef returns the image to run for a release version.
func appleImageRef(version string) string { return ImageRepository + ":" + version }

// appleReadVersion reads the release version back out of a run script.
func appleReadVersion(runScript []byte) string {
	match := appleImagePattern.FindSubmatch(runScript)
	if match == nil {
		return ""
	}
	return strings.TrimRight(string(match[1]), " \t")
}
