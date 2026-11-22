/**
 * The public half of a member invite: a minimal page that shows the bind QR
 * code and, when WeChat asks for it, takes the PIN. It carries no member list,
 * no conversation and no account data — only the invite's own state.
 *
 * The page is self-contained (inline CSS and JS, no CDN) and is served with
 * no-store, no-referrer and a CSP that forbids framing and external loads.
 */
import { create as createQr } from "qrcode";

export type BindPageState = {
  stage: string;
  expiresAt: number;
  qrText?: string;
  authUrl?: string;
  failure?: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A QR image as inline SVG; never an external image URL. */
export function renderQrSvg(text: string, label: string): string {
  const qr = createQr(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const cells: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (qr.modules.get(x, y)) {
        cells.push(`M${x} ${y}h1v1h-1z`);
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"`,
    ` width="240" height="240" role="img" aria-label="${escapeHtml(label)}"`,
    ` shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/>`,
    `<path d="${cells.join("")}" fill="#000"/></svg>`,
  ].join("");
}


/**
 * The page shell. Everything is rendered after the bearer token is read from
 * the URL fragment, so the token never reaches a server log or referrer.
 */
export type BindPageCopy = {
  title: string;
  reading: string;
  incomplete: string;
  askPin: string;
  needOperator: string;
  scan: string;
  done: string;
  saving: string;
  dead: string;
  unreadable: string;
  badPin: string;
  pinFailed: string;
  pinLabel: string;
  submit: string;
  qrLabel: string;
};

export function bindPageHtml(copy: BindPageCopy, publicBaseUrl: string): string {
  const base = escapeHtml(publicBaseUrl.replace(/\/$/, ""));
  return `<!doctype html>
<html lang="zh"><!-- i18n-ignore --><!-- i18n-ignore -->
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(copy.title)}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f5f5f7;color:#1d1d1f}
main{max-width:22rem;padding:1.5rem;text-align:center}
svg{background:#fff;border-radius:12px;padding:12px}
p{margin:1rem 0 0;color:#515154}
form{margin-top:1rem;display:flex;gap:.5rem;justify-content:center}
input{font-size:1.25rem;letter-spacing:.3em;width:9rem;padding:.5rem;border:1px solid #c7c7cc;border-radius:8px;text-align:center}
button{padding:.5rem 1rem;border-radius:8px;border:0;background:#0071e3;color:#fff;font-size:1rem}
.hidden{display:none}
</style>
</head>
<body>
<main>
  <div id="qr"></div>
  <p id="status">${escapeHtml(copy.reading)}</p>
  <form id="pin" class="hidden">
    <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="${escapeHtml(copy.pinLabel)}">
    <button type="submit">${escapeHtml(copy.submit)}</button>
  </form>
</main>
<script>
(function () {
  var copy = ${JSON.stringify({
    incomplete: copy.incomplete, askPin: copy.askPin, needOperator: copy.needOperator,
    scan: copy.scan, done: copy.done, saving: copy.saving, dead: copy.dead,
    unreadable: copy.unreadable, badPin: copy.badPin, pinFailed: copy.pinFailed,
  })};
  var base = ${JSON.stringify(base)};
  var token = (location.hash || "").replace(/^#/, "");
  var qr = document.getElementById("qr");
  var status = document.getElementById("status");
  var form = document.getElementById("pin");
  var code = document.getElementById("code");
  if (!token) { status.textContent = copy.incomplete; return; }
  var timers = [];
  function clear() { timers.forEach(clearTimeout); timers = []; }
  function show(state) {
    qr.innerHTML = state.qrSvg || "";
    if (state.stage === "pin") {
      status.textContent = copy.askPin;
      form.classList.remove("hidden");
      return;
    }
    form.classList.add("hidden");
    if (state.stage === "realname") {
      status.textContent = copy.needOperator;
    } else if (state.stage === "scan") {
      status.textContent = copy.scan;
    } else if (state.stage === "confirmed") {
      status.textContent = copy.done;
      clear();
    } else if (state.stage === "saving") {
      status.textContent = copy.saving;
    } else if (state.failure || ["denied","expired","cancelled","failed"].indexOf(state.stage) >= 0) {
      status.textContent = copy.dead;
      clear();
    }
  }
  function poll() {
    fetch(base + "/members/bind/state", { headers: { authorization: "Bearer " + token }, cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (state) { show(state); timers.push(setTimeout(poll, 2500)); })
      .catch(function () { status.textContent = copy.unreadable; });
  }
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var pin = (code.value || "").trim();
    if (!/^\\d{6}$/.test(pin)) { status.textContent = copy.badPin; return; }
    code.value = "";
    fetch(base + "/members/bind/pin", {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ pin: pin })
    })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(show)
      .catch(function () { status.textContent = copy.pinFailed; });
  });
  poll();
})();
</script>
</body>
</html>`;
}
