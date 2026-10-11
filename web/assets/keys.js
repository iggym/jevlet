// "Get your API key" flow + Stripe Payment Links. Plain ES module.
// - Create free key: POST /v1/keys, show the token once with copy + warning; persist to
//   localStorage only if the user ticks "Remember in this browser".
// - Pay with Stripe: Payment Link URL from GET /v1/config + ?client_reference_id=<sha256(key)>,
//   so the webhook upgrades the right key without the raw key ever reaching Stripe.

export async function keyIdOf(token) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function paymentLinkFor(base, keyId) {
  if (!base || !/^[0-9a-f]{64}$/.test(keyId)) return null;
  const u = new URL(base);
  u.searchParams.set("client_reference_id", keyId);
  return u.toString();
}

if (typeof document !== "undefined") init();

function init() {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tokenEl = $("#token");
  const out = $("#gk-out");
  const btn = $("#gk-create");
  let cfg = { self_serve_keys: false, payment_links: {} };

  fetch("/v1/config").then((r) => (r.ok ? r.json() : null)).then((c) => {
    if (!c) return;
    cfg = c;
    document.querySelectorAll(".paylink").forEach((a) => (a.hidden = !c.payment_links?.[a.dataset.link]));
    if (!c.self_serve_keys) { btn.disabled = true; out.innerHTML = `<p class="muted">Self-serve keys are turned off on this instance. Ask the operator for a key.</p>`; }
  }).catch(() => {});

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    out.innerHTML = `<p class="muted">Creating…</p>`;
    let r, body = {};
    try { r = await fetch("/v1/keys", { method: "POST" }); body = await r.json().catch(() => ({})); } catch { r = { status: 0 }; }
    btn.disabled = false;
    if (r.status === 201 && body.token) {
      out.innerHTML = `<div class="keybox" role="alert">
        <p><b>Save it now. It won't be shown again.</b> Only a hash is stored, so this key can't be recovered.</p>
        <p><code id="gk-token">${esc(body.token)}</code></p>
        <button type="button" class="ghost" id="gk-copy">Copy key</button>
        <label><input type="checkbox" id="gk-remember"> Remember in this browser (localStorage on this device)</label>
        <button type="button" class="primary" id="gk-use">Use this key</button>
        <p class="muted">${esc(body.daily_cap)} units/day · tier ${esc(body.tier)}</p>
      </div>`;
      $("#gk-copy").onclick = async () => {
        try { await navigator.clipboard.writeText(body.token); } catch {
          const ta = Object.assign(document.createElement("textarea"), { value: body.token }); document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
        }
        $("#gk-copy").textContent = "Copied";
      };
      $("#gk-use").onclick = () => {
        tokenEl.value = body.token;
        if ($("#gk-remember").checked) { try { localStorage.setItem("jevlet_token", body.token); } catch {} }
        else { try { localStorage.removeItem("jevlet_token"); } catch {} }
        $("#gk-use").textContent = $("#gk-remember").checked ? "Key in use (saved in this browser)" : "Key in use (this tab only)";
        document.dispatchEvent(new CustomEvent("jevlet:key"));
      };
      $("#gk-copy").focus();
    } else if (r.status === 429) {
      out.innerHTML = `<p class="err">Limit reached: 3 free keys per network per day. Try again tomorrow, or use a key you already have.</p>`;
    } else if (r.status === 404) {
      out.innerHTML = `<p class="muted">Self-serve keys are turned off on this instance. Ask the operator for a key.</p>`;
    } else {
      out.innerHTML = `<p class="err">${esc(body.error?.code || "NETWORK_ERROR")}: could not create a key.</p>`;
    }
  });

  // Pay with Stripe (Payment Links)
  document.addEventListener("click", async (e) => {
    const a = e.target.closest(".paylink");
    if (!a) return;
    e.preventDefault();
    const token = tokenEl.value.trim();
    const msgTarget = a.closest(".plan") ? $("#p-out") : out;
    if (!token) {
      msgTarget.innerHTML = `<p class="err">First create or enter your API key (top of the page). The payment upgrades that key.</p>`;
      document.getElementById("get-key").scrollIntoView({ behavior: "smooth", block: "start" });
      btn.focus({ preventScroll: true });
      return;
    }
    const url = paymentLinkFor(cfg.payment_links?.[a.dataset.link], await keyIdOf(token));
    if (url) location.href = url;
  });

  // Reload adapters when a new key is put in use.
  document.addEventListener("jevlet:key", () => { tokenEl.dispatchEvent(new Event("input")); if (typeof window.jevletReloadAdapters === "function") window.jevletReloadAdapters(); });
}
