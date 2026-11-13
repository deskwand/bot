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

// appleImagePattern matches the image the run script execs, up to the end of
// its line. The tag is read whole, so a hostile tail cannot be truncated into
// a value that looks like a valid tag.
var appleImagePattern = regexp.MustCompile(regexp.QuoteMeta(ImageRepository) + `:([^\r\n]*)`)

// appleRunScript returns run.sh: it starts the container service (launchd has
// nobody to answer the kernel install prompt), clears a stale container, and
// then execs the bot so launchd supervises the container process itself.
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
exec %s run --rm --name %s --env-file .env -p 127.0.0.1:8787:8787 -v %s:/data %s
`, appleScriptMarker, quotedDir, quotedBin, quotedBin, appleContainerName, quotedBin, appleContainerName, appleVolume, image))
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
