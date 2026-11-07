package platform

import "github.com/egoist/mygo"

// WebViewDownloadURL is the Microsoft page that installs the WebView2 Runtime.
const WebViewDownloadURL = "https://developer.microsoft.com/microsoft-edge/webview2/"

// webViewAvailable is a variable so tests can replace the probe. It looks for
// the runtime without starting it.
var webViewAvailable = mygo.WebViewAvailable

// Available reports whether a window showing a web page can work on this
// machine. On Windows it is false when the WebView2 Runtime is missing and no
// usable WebView2Loader.dll sits next to the executable.
func Available() bool { return webViewAvailable() }

// NeedsWebViewRuntimePrompt reports whether the app must explain the missing
// WebView2 Runtime instead of opening a window. Only Windows can miss it:
// other platforms do not use WebView2 and are outside this guard.
func NeedsWebViewRuntimePrompt(goos string, available bool) bool {
	return goos == "windows" && !available
}
