// BOSS Carton Receiving - main app
(function () {
  const cfg = window.APP_CONFIG || {};
  const { rpc, DEMO } = window.API;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtDT = (iso) => new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  const fmtD = (d) => (d ? new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" }) : "");
  const today = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const num = (n) => Number(n || 0).toLocaleString();
  const app = $("#app");

  // ================================================================ session
  let session = null;
  try { session = JSON.parse(localStorage.getItem("ccr_session")); } catch (e) {}
  const saveSession = () => localStorage.setItem("ccr_session", JSON.stringify(session));
  const tok = () => session && session.token;

  async function call(fn, params) {
    try { return await rpc(fn, Object.assign({ p_token: tok() }, params || {})); }
    catch (e) {
      if (e.code === "SESSION_EXPIRED" || e.code === "ACCOUNT_DISABLED") { logout(true); toast(e.message); }
      throw e;
    }
  }

  // ================================================================ feedback
  let actx = null;
  function tone(freq, start, dur, vol = 0.25, type = "square") {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, actx.currentTime + start);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + start + dur);
    o.connect(g); g.connect(actx.destination);
    o.start(actx.currentTime + start); o.stop(actx.currentTime + start + dur + 0.02);
  }
  function unlockAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === "suspended") actx.resume();
    } catch (e) {}
  }
  document.addEventListener("touchstart", unlockAudio, { passive: true });
  document.addEventListener("click", unlockAudio);

  function signal(kind) {
    // vibration
    try { if (navigator.vibrate) navigator.vibrate(kind === "ok" ? 80 : kind === "warn" ? [70, 60, 70] : [250, 80, 250]); } catch (e) {}
    // sound
    try {
      unlockAudio();
      if (actx) {
        if (kind === "ok") tone(1500, 0, 0.09, 0.22);
        else if (kind === "warn") { tone(700, 0, 0.1); tone(700, 0.15, 0.1); }
        else { tone(200, 0, 0.35, 0.3, "sawtooth"); }
      }
    } catch (e) {}
    // screen flash
    const f = $("#flash");
    f.className = kind; void f.offsetWidth;
    setTimeout(() => { f.className = ""; }, 140);
    const r = $("#reader");
    if (r && kind === "ok") { r.classList.add("hit"); setTimeout(() => r.classList.remove("hit"), 160); }
  }

  let toastTimer = null;
  function toast(msg, actionLabel, action, ms = 3200) {
    const t = $("#toast");
    t.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button>${esc(actionLabel)}</button>` : "");
    t.classList.remove("hidden");
    if (actionLabel) $("button", t).onclick = () => { t.classList.add("hidden"); action(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
  }

  // modal: returns a promise with the clicked button value
  function modal(html, buttons) {
    return new Promise((resolve) => {
      const m = $("#modal"), c = $("#modalCard");
      $("#toast").classList.add("hidden");
      c.innerHTML = html + (buttons && buttons.length ? `<div class="modal-actions">${buttons.map((b, i) => `<button class="btn ${b.cls || "btn-ghost"}" data-i="${i}">${esc(b.label)}</button>`).join("")}</div>` : "");
      m.classList.remove("hidden");
      c.querySelectorAll(".modal-actions button").forEach((btn) => {
        btn.onclick = () => { m.classList.add("hidden"); resolve(buttons[+btn.dataset.i].value); };
      });
      m.onclick = (e) => { if (e.target === m && buttons && buttons.length) { m.classList.add("hidden"); resolve(null); } };
    });
  }
  const closeModal = () => $("#modal").classList.add("hidden");
  const alertBox = (title, msg, cls = "err-box") => modal(`<h2>${esc(title)}</h2><div class="${cls}">${esc(msg)}</div>`, [{ label: "OK", cls: "btn-black", value: true }]);

  // ================================================================ camera scanner
  const Scanner = {
    inst: null, onCode: null, last: { code: "", t: 0 }, anyT: 0, torch: false,
    async open({ title, sub, onCode, showCount, countLabel }) {
      this.onCode = onCode; this.armed = false; this.got = false;
      $("#camTitle").textContent = title; $("#camSub").textContent = sub || "";
      $("#camLast").textContent = " "; $("#camLast").className = "cam-last";
      $(".cam-count").style.visibility = showCount ? "visible" : "hidden";
      $("#camCountLabel").textContent = countLabel || "pcs in carton";
      $("#camera").classList.remove("hidden");
      $("#camTorch").classList.add("hidden");
      try {
        if (!window.Html5Qrcode) throw new Error("Scanner library not loaded");
        const F = window.Html5QrcodeSupportedFormats;
        if (!this.inst) {
          this.inst = new Html5Qrcode("reader", {
            verbose: false,
            useBarCodeDetectorIfSupported: true,
            formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX]
          });
        }
        await this.inst.start(
          { facingMode: "environment" },
          {
            fps: 12,
            // narrow aiming box: only the barcode in the middle is read
            qrbox: (w, h) => ({ width: Math.max(120, Math.floor(w * 0.86)), height: Math.max(60, Math.floor(Math.min(h * 0.22, w * 0.3))) }),
            disableFlip: true
          },
          (text) => this.hit(text),
          () => {}
        );
        this.setupTorch();
      } catch (e) {
        this.close();
        const msg = String(e && (e.message || e)).toLowerCase();
        const denied = /permission|notallowed|denied/.test(msg);
        alertBox("Camera not available",
          denied ? "Camera permission was blocked. Allow camera for this app in your phone settings (or browser site settings), then try again. You can also type the barcode manually."
                 : "The camera could not start (" + (e.message || e) + "). You can type the barcode manually.");
      }
    },
    // HOLD TO SCAN: the camera only reads while the SCAN button is held down.
    // One barcode per hold.
    armed: false, got: false,
    hit(raw) {
      const code = String(raw || "").trim();
      if (!code || !this.armed) return;
      this.armed = false; this.got = true;
      $("#camHold").classList.remove("on"); $("#camHold").classList.add("done");
      $("#reader").classList.remove("reading");
      if (this.onCode) this.onCode(code);
    },
    pressStart(e) {
      if (e) e.preventDefault();
      unlockAudio();
      this.armed = true; this.got = false;
      $("#camHold").classList.add("on"); $("#camHold").classList.remove("done");
      $("#reader").classList.add("reading");
      this.showMsg("Reading… keep the barcode inside the box", "");
    },
    pressEnd(e) {
      if (e) e.preventDefault();
      const wasArmed = this.armed;
      this.armed = false;
      $("#camHold").classList.remove("on", "done");
      $("#reader").classList.remove("reading");
      if (wasArmed && !this.got) { signal("err"); this.showMsg("No barcode found - aim and hold again", "warn"); }
    },
    showMsg(text, kind) { const el = $("#camLast"); el.className = "cam-last " + (kind || ""); el.textContent = text; },
    showLast(code, kind = "ok", note = "") {
      const el = $("#camLast"); el.className = "cam-last " + kind;
      el.textContent = (kind === "ok" ? "✓ " : "⚠ ") + code + (note ? "  " + note : "");
    },
    setCount(n) { $("#camCount").textContent = n; },
    setupTorch() {
      try {
        const v = $("#reader video");
        const track = v && v.srcObject && v.srcObject.getVideoTracks()[0];
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) {
          const b = $("#camTorch"); b.classList.remove("hidden"); this.torch = false;
          b.onclick = () => { this.torch = !this.torch; track.applyConstraints({ advanced: [{ torch: this.torch }] }).catch(() => {}); b.style.background = this.torch ? "#e0a100" : "#222"; };
        }
      } catch (e) {}
    },
    async close() {
      $("#camera").classList.add("hidden");
      try { if (this.inst && this.inst.isScanning) await this.inst.stop(); } catch (e) {}
      if (this.onClose) { const f = this.onClose; this.onClose = null; f(); }
    }
  };
  $("#camDone").onclick = () => Scanner.close();
  (function bindHold() {
    const b = $("#camHold");
    b.addEventListener("pointerdown", (e) => { try { b.setPointerCapture(e.pointerId); } catch (x) {} Scanner.pressStart(e); });
    ["pointerup", "pointercancel"].forEach((ev) => b.addEventListener(ev, (e) => Scanner.pressEnd(e)));
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  })();

  // ================================================================ draft carton (saved on phone)
  const draftKey = () => "ccr_draft_" + (session && session.user.id);
  let draft = null, knownCartons = new Set();
  function loadDraft() {
    try { draft = JSON.parse(localStorage.getItem(draftKey())); } catch (e) {}
    if (!draft) draft = { carton: "", startedAt: null, replace: false, scans: [] };
    knownCartons = new Set(draft.known || []);
  }
  const saveDraft = () => { try { localStorage.setItem(draftKey(), JSON.stringify(draft)); } catch (e) {} };
  const resetDraft = () => { draft = { carton: "", startedAt: null, replace: false, scans: [] }; saveDraft(); };
  let seq = 0;
  const newId = () => Date.now().toString(36) + (seq++).toString(36);

  // ================================================================ login
  function renderLogin(err) {
    app.innerHTML = `
      <div class="login"><form class="login-card" id="loginForm" autocomplete="on">
        <div class="brand">B O S S<small>${esc(cfg.APP_NAME || "Carton Receiving")}</small></div>
        ${DEMO ? `<div class="warn-box" style="margin-top:16px;font-size:13px"><b>Demo mode</b> (no database connected). Try <b>staff / 1111</b> or <b>admin / 1234</b>.</div>` : ""}
        ${err ? `<div class="err-box">${esc(err)}</div>` : ""}
        <div class="field"><label>Username</label><input class="input" name="u" autocapitalize="none" autocorrect="off" autocomplete="username" required></div>
        <div class="field"><label>PIN / Password</label><input class="input" name="p" type="password" autocomplete="current-password" required></div>
        <button class="btn btn-black" style="width:100%;margin-top:18px;padding:15px" id="loginBtn">Log in</button>
        <p class="hint" style="text-align:center">You stay logged in on this phone.</p>
      </form></div>`;
    $("#loginForm").onsubmit = async (e) => {
      e.preventDefault();
      const b = $("#loginBtn"); b.disabled = true; b.innerHTML = `<span class="spinner"></span>`;
      try {
        const r = await rpc("app_login", { p_username: e.target.u.value, p_pin: e.target.p.value });
        session = r; saveSession(); start();
      } catch (er) { renderLogin(er.message); }
    };
  }

  async function logout(silent) {
    if (!silent && draft && draft.scans.length) {
      const ok = await modal(`<h2>Log out?</h2><p>Carton <b>${esc(draft.carton)}</b> has ${draft.scans.length} scanned items not submitted yet. They stay saved on this phone for your next login.</p>`,
        [{ label: "Cancel", value: false }, { label: "Log out", cls: "btn-black", value: true }]);
      if (!ok) return;
    }
    if (!silent && tok()) rpc("app_logout", { p_token: tok() }).catch(() => {});
    session = null; localStorage.removeItem("ccr_session"); renderLogin();
  }

  // ================================================================ shell
  let adminTab = "receive";
  function shell(inner, opts = {}) {
    const u = session.user;
    const tabs = u.role === "admin"
      ? `<nav class="tabs">${[["receive", "Receive"], ["deliveries", "Deliveries"], ["cartons", "Cartons"], ["boxes", "Boxes"], ["staff", "Staff"]]
          .map(([k, l]) => `<button class="tab ${adminTab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}</nav>` : "";
    app.innerHTML = `
      ${DEMO ? `<div class="demo-bar">DEMO MODE - data is saved only on this device</div>` : ""}
      <header class="top">
        <div class="brand">B O S S<small>${esc(cfg.APP_NAME || "Carton Receiving")}</small></div>
        <div class="who"><span>${esc(u.full_name)}</span><button class="icon-btn" id="logoutBtn">Log out</button></div>
      </header>
      ${tabs}
      <main class="wrap ${opts.wide ? "wide" : ""}" id="main">${inner}</main>`;
    $("#logoutBtn").onclick = () => logout();
    app.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
      if (adminTab === t.dataset.tab) return;
      adminTab = t.dataset.tab; routeAdmin();
    }));
  }

  // ================================================================ RECEIVE: home (2 options)
  let mode = localStorage.getItem("ccr_mode") || "home";
  const setMode = (m) => { mode = m; try { localStorage.setItem("ccr_mode", m); } catch (e) {} renderReceive(); };
  const backBar = (title) => `<div class="back-bar"><button class="link" id="goHome">&larr; Home</button><b>${esc(title)}</b></div>`;
  function bindBack() { const b = $("#goHome"); if (b) b.onclick = () => setMode("home"); }

  function renderReceive() {
    if (mode === "stock") return renderStock();
    if (mode === "boxes") return renderBoxes();
    renderHome();
  }

  function renderHome() {
    loadBoxDraft();
    const stockBusy = draft && draft.carton ? `<span class="pill a">In progress: carton ${esc(draft.carton)} (${draft.scans.length} pcs)</span>` : "";
    const boxBusy = boxDraft ? `<span class="pill a">In progress: ${esc(boxDraft.ref)} (${boxDraft.boxes.length} boxes)</span>` : "";
    shell(`
      <div class="home-grid">
        <button class="home-card" id="goBoxes">
          <div class="home-ico">&#128230;</div>
          <div class="home-title">Receive Boxes</div>
          <div class="home-sub">Count the boxes of a new shipment. Scan each box label once.</div>
          ${boxBusy}
        </button>
        <button class="home-card" id="goStock">
          <div class="home-ico">&#127991;</div>
          <div class="home-title">Receive Stock</div>
          <div class="home-sub">Open a box: scan the carton label, then every item inside.</div>
          ${stockBusy}
        </button>
      </div>`);
    $("#goBoxes").onclick = () => setMode("boxes");
    $("#goStock").onclick = () => setMode("stock");
  }

  // ================================================================ RECEIVE STOCK
  function renderStock() {
    shell(backBar("Receive Stock") + `
      <section class="cell carton" id="cartonCell">
        <div class="cell-label"><span>Carton No.</span><span id="cartonTools"></span></div>
        <div id="cartonBody"></div>
      </section>

      <section class="cell qty">
        <div><div class="cell-label">Scanned Qty</div><div class="qty-num" id="qtyNum">0</div></div>
        <div class="qty-side" id="qtySide"></div>
      </section>

      <section class="cell" id="itemCell">
        <div class="cell-label">Item Barcode</div>
        <form class="row" id="itemForm" autocomplete="off">
          <input class="input mono" id="itemInput" placeholder="Barcode" inputmode="numeric" enterkeyhint="done">
          <button type="button" class="btn btn-scan" id="itemScan">&#128247; Scan</button>
        </form>
        <div class="row" style="margin-top:8px"><button class="btn btn-ghost btn-sm" type="submit" form="itemForm" id="itemAdd" style="flex:1">+ Add typed barcode</button></div>
      </section>

      <div class="list-head"><h3>Scanned items</h3><span class="muted" id="listInfo"></span></div>
      <div class="items" id="itemList"></div>

      <div class="list-head" style="margin-top:26px"><h3>My recent cartons</h3><button class="link" id="refreshRecent">Refresh</button></div>
      <div class="items" id="recentList"><div class="empty">Loading…</div></div>

      <div class="submit-bar"><button class="btn btn-black" id="submitBtn">Submit carton</button></div>
    `);

    $("#itemScan").onclick = openItemCamera;
    $("#itemForm").onsubmit = (e) => {
      e.preventDefault();
      const v = $("#itemInput").value.trim();
      if (!v) return;
      if (addItem(v, true)) $("#itemInput").value = "";
      $("#itemInput").focus();
    };
    $("#submitBtn").onclick = submitCarton;
    $("#refreshRecent").onclick = loadRecent;
    bindBack();
    updateReceive(); loadRecent();
  }

  function updateReceive() {
    if (!$("#cartonBody")) return;
    const has = !!draft.carton;
    $("#cartonCell").classList.toggle("set", has);
    if (has) {
      $("#cartonBody").innerHTML = `<div class="cell-value mono" id="cartonValue">${esc(draft.carton)}</div>` +
        (draft.deliveryRef ? `<div class="hint" style="color:#0d5c30;font-weight:600">&#10003; In delivery file: ${esc(draft.deliveryRef)}</div>` : "") +
        (draft.notInFile ? `<div class="hint" style="color:#b42318;font-weight:600">&#9888; Not in any delivery file (you chose to continue)</div>` : "") +
        (draft.noFiles ? `<div class="hint">No delivery file uploaded yet - carton not checked.</div>` : "") +
        (draft.replace ? `<div class="hint" style="color:#8a6100">&#9888; Re-scan: this will replace the earlier scan of this carton.</div>` : "");
      $("#cartonTools").innerHTML = `<button class="link" id="cartonClear">${draft.scans.length ? "Clear carton" : "Change"}</button>`;
      $("#cartonClear").onclick = clearCarton;
    } else {
      $("#cartonBody").innerHTML = `
        <form class="row" id="cartonForm" autocomplete="off">
          <input class="input mono" id="cartonInput" placeholder="Carton no." autocapitalize="characters" enterkeyhint="done">
          <button type="button" class="btn btn-scan" id="cartonScan">&#128247; Scan</button>
        </form>
        <div class="hint">Start by scanning the carton (rake) label.</div>`;
      $("#cartonTools").innerHTML = "";
      $("#cartonScan").onclick = openCartonCamera;
      $("#cartonForm").onsubmit = (e) => { e.preventDefault(); setCarton($("#cartonInput").value); };
    }
    // item cell enabled only after carton
    ["#itemInput", "#itemScan", "#itemAdd"].forEach((s) => ($(s).disabled = !has));
    $("#itemCell").style.opacity = has ? 1 : 0.5;

    const n = draft.scans.length;
    $("#qtyNum").textContent = n;
    const distinct = new Set(draft.scans.map((s) => s.barcode)).size;
    $("#qtySide").innerHTML = n ? `${distinct} different<br>barcode${distinct === 1 ? "" : "s"}` : "";
    $("#submitBtn").disabled = !has || !n;
    $("#submitBtn").textContent = n ? `Submit carton (${n} pcs)` : "Submit carton";
    renderItems();
  }

  function renderItems(newId) {
    const list = $("#itemList"); if (!list) return;
    if (!draft.scans.length) {
      list.innerHTML = `<div class="empty">${draft.carton ? "No items yet. Press Scan to start." : "Scan a carton first."}</div>`;
      $("#listInfo").textContent = ""; return;
    }
    const counts = {};
    draft.scans.forEach((s) => (counts[s.barcode] = (counts[s.barcode] || 0) + 1));
    const seen = {};
    const rows = draft.scans.map((s, i) => { seen[s.barcode] = (seen[s.barcode] || 0) + 1; return { s, i, nth: seen[s.barcode] }; }).reverse();
    list.innerHTML = rows.map(({ s, i }) => `
      <div class="item ${s.id === newId ? "new" : ""}" data-id="${s.id}">
        <div class="item-no">${i + 1}</div>
        <div class="item-main">
          <div class="item-code">${esc(s.barcode)}${counts[s.barcode] > 1 ? `<span class="dup">x${counts[s.barcode]}</span>` : ""}</div>
          <div class="item-meta">${fmtTime(s.t)}${s.manual ? " &middot; typed" : ""}</div>
        </div>
        <button class="del" title="Delete" aria-label="Delete">&#128465;</button>
      </div>`).join("");
    $("#listInfo").textContent = "Newest on top";
    list.querySelectorAll(".del").forEach((b) => (b.onclick = () => deleteItem(b.closest(".item").dataset.id)));
  }

  async function setCarton(raw) {
    const code = String(raw || "").trim();
    if (!code) return;
    const input = $("#cartonInput"); if (input) input.disabled = true;
    const resetInput = () => { const i = $("#cartonInput"); if (i) { i.disabled = false; i.value = ""; } };
    let info = null;
    try { info = await call("staff_check_carton", { p_carton: code }); }
    catch (e) { if (e.code === "SESSION_EXPIRED") return; toast("Could not check this carton (offline?). Continuing without check."); }
    const prev = (info && info.previous) || [];
    let notInFile = false;
    if (info) {
      knownCartons = new Set(info.known_cartons || []);
      if (!info.delivery_ref && info.recent_files > 0) {
        signal("err");
        const ex = info.examples || [];
        const choice = await modal(`
          <h2>&#10007; Carton not in delivery file</h2>
          <div class="err-box">Barcode <b class="mono">${esc(code)}</b> is not in any delivery file.</div>
          <p>The carton label has more than one barcode, so you may have scanned the wrong one. Scan the <b>carton number</b> barcode.</p>
          ${ex.length ? `<p class="muted">Carton numbers in the latest file look like:<br><b class="mono">${ex.map(esc).join("<br>")}</b></p>` : ""}`,
          [{ label: "Continue anyway", value: "go" }, { label: "Scan again", cls: "btn-black", value: "again" }]);
        if (choice !== "go") { resetInput(); if (choice === "again") openCartonCamera(); return; }
        notInFile = true;
      }
    }
    let replace = false;
    if (prev.length) {
      signal("warn");
      const p = prev[0];
      const ok = await modal(`
        <h2>&#9888; Carton already scanned</h2>
        <div class="warn-box">Carton <b class="mono">${esc(code)}</b> was already scanned by <b>${esc(p.staff_name)}</b> on <b>${fmtDT(p.submitted_at)}</b> (${num(p.total_qty)} pcs).</div>
        <p>If you scan it again, your new scan will <b>replace</b> the earlier one when you submit.</p>`,
        [{ label: "Cancel", value: false }, { label: "Scan again", cls: "btn-black", value: true }]);
      if (!ok) { resetInput(); return; }
      replace = true;
    }
    draft = {
      carton: code, startedAt: new Date().toISOString(), replace, scans: [],
      deliveryRef: info ? info.delivery_ref : null, notInFile,
      noFiles: !!info && !info.recent_files, known: [...knownCartons]
    };
    saveDraft(); updateReceive();
    setTimeout(() => { const i = $("#itemInput"); if (i && !("ontouchstart" in window)) i.focus(); }, 50);
  }

  async function clearCarton() {
    if (draft.scans.length) {
      const ok = await modal(`<h2>Clear this carton?</h2><p>This deletes all <b>${draft.scans.length}</b> scanned items for carton <b class="mono">${esc(draft.carton)}</b>. Nothing has been submitted.</p>`,
        [{ label: "Cancel", value: false }, { label: "Clear", cls: "btn-red", value: true }]);
      if (!ok) return;
    }
    resetDraft(); updateReceive();
  }

  function addItem(code, manual) {
    code = String(code || "").trim();
    if (!code || !draft.carton) return false;
    if (code.toUpperCase() === draft.carton.toUpperCase() || knownCartons.has(code.toUpperCase())) {
      signal("warn");
      if (!$("#camera").classList.contains("hidden")) Scanner.showLast(code, "warn", "(carton number - not added)");
      else toast("That is a carton number, not an item. Not added.");
      return false;
    }
    const s = { id: newId(), barcode: code, t: new Date().toISOString() };
    if (manual) s.manual = true;
    draft.scans.push(s); saveDraft();
    signal("ok");
    updateReceive(); renderItems(s.id);
    if (!$("#camera").classList.contains("hidden")) {
      const c = draft.scans.filter((x) => x.barcode === code).length;
      Scanner.showLast(code, "ok", c > 1 ? `(x${c})` : ""); Scanner.setCount(draft.scans.length);
    }
    return true;
  }

  function openCartonCamera() {
    Scanner.open({
      title: "Scan carton label", sub: "Point at the CARTON NUMBER barcode only",
      onCode: (code) => { signal("ok"); Scanner.close(); setCarton(code); }
    });
  }

  function openItemCamera() {
    if (!draft.carton) return;
    Scanner.setCount(draft.scans.length);
    Scanner.onClose = () => updateReceive();
    Scanner.open({ title: "Scan items", sub: "Carton " + draft.carton + " - scan every piece", showCount: true, onCode: (c) => addItem(c, false) });
  }

  function deleteItem(id) {
    const i = draft.scans.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [removed] = draft.scans.splice(i, 1); saveDraft(); updateReceive();
    toast(`Deleted ${removed.barcode}`, "UNDO", () => { draft.scans.splice(i, 0, removed); saveDraft(); updateReceive(); }, 5000);
  }

  async function submitCarton() {
    const n = draft.scans.length;
    if (!draft.carton || !n) return;
    const distinct = new Set(draft.scans.map((s) => s.barcode)).size;
    const ok = await modal(`
      <h2>Confirm carton</h2>
      <p>Carton <b class="mono">${esc(draft.carton)}</b></p>
      <div class="big-total">${n}</div>
      <div class="big-total-sub">pieces scanned &middot; ${distinct} different barcode${distinct === 1 ? "" : "s"}</div>
      <div class="warn-box">Check the physical quantity in the carton. <b>Does it match ${n} pcs?</b><br>If not, go back and check for items scanned twice or missed.</div>
      ${draft.replace ? `<p class="muted">This will replace the earlier scan of this carton.</p>` : ""}`,
      [{ label: "No, go back", value: false }, { label: "Yes, submit", cls: "btn-green", value: true }]);
    if (!ok) return;
    const btn = $("#submitBtn"); btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Submitting…`;
    try {
      const r = await call("staff_submit_carton", {
        p_carton: draft.carton, p_started_at: draft.startedAt, p_replace: !!draft.replace,
        p_lines: draft.scans.map((s) => ({ barcode: s.barcode, scanned_at: s.t }))
      });
      const carton = draft.carton;
      resetDraft(); updateReceive(); loadRecent();
      signal("ok");
      modal(`<h2>&#10003; Submitted</h2><div class="ok-box">Carton <b class="mono">${esc(carton)}</b> saved with <b>${num(r.total_qty)} pcs</b>.</div>`,
        [{ label: "Scan next carton", cls: "btn-black", value: true }]);
    } catch (e) {
      updateReceive();
      if (e.code !== "SESSION_EXPIRED") { signal("err"); alertBox("Not submitted", e.message + " Your scans are still saved on this phone - try again."); }
    }
  }

  async function loadRecent() {
    const el = $("#recentList"); if (!el) return;
    try {
      const r = await call("staff_my_recent");
      el.innerHTML = r.length ? r.map((c) => `
        <div class="item"><div class="item-main"><div class="item-code">${esc(c.carton_no)}</div><div class="item-meta">${fmtDT(c.submitted_at)}</div></div>
        <span class="pill k">${num(c.total_qty)} pcs</span></div>`).join("") : `<div class="empty">No cartons submitted in the last 2 days.</div>`;
    } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // ================================================================ RECEIVE BOXES
  const boxKey = () => "ccr_box_" + (session && session.user.id);
  let boxDraft = null;
  function loadBoxDraft() { try { boxDraft = JSON.parse(localStorage.getItem(boxKey())); } catch (e) { boxDraft = null; } }
  const saveBoxDraft = () => { try { if (boxDraft) localStorage.setItem(boxKey(), JSON.stringify(boxDraft)); else localStorage.removeItem(boxKey()); } catch (e) {} };
  const upc = (x) => String(x || "").trim().toUpperCase();

  function renderBoxes() {
    loadBoxDraft();
    if (!boxDraft) return renderBoxStart();
    shell(backBar("Receive Boxes") + `
      <section class="cell carton set">
        <div class="cell-label"><span>Box count</span><button class="link" id="bxCancel">Cancel count</button></div>
        <div class="cell-value">${esc(boxDraft.ref)}</div>
        <div class="hint" style="${boxDraft.deliveryId ? "color:#0d5c30;font-weight:600" : ""}">${boxDraft.deliveryId
          ? `&#10003; Delivery file: ${esc(boxDraft.deliveryRef)} (${num(boxDraft.fileCartons.length)} boxes)` : "No delivery file - plain count"}</div>
      </section>
      <section class="cell qty">
        <div><div class="cell-label">Boxes scanned</div><div class="qty-num" id="bxNum">0</div></div>
        <div class="qty-side" id="bxSide"></div>
      </section>
      <div class="progress ${boxDraft.deliveryId ? "" : "hidden"}"><div id="bxBar"></div></div>
      <section class="cell">
        <div class="cell-label">Box No.</div>
        <form class="row" id="bxForm" autocomplete="off">
          <input class="input mono" id="bxInput" placeholder="Box no." autocapitalize="characters" enterkeyhint="done">
          <button type="button" class="btn btn-scan" id="bxScan">&#128247; Scan</button>
        </form>
        <div class="row" style="margin-top:8px"><button class="btn btn-ghost btn-sm" type="submit" form="bxForm" style="flex:1">+ Add typed box no.</button></div>
      </section>
      <div class="list-head"><h3>Boxes scanned</h3><span class="muted">Newest on top</span></div>
      <div class="items" id="bxList"></div>
      <div class="submit-bar"><button class="btn btn-black" id="bxSubmit">Submit box count</button></div>`);
    bindBack();
    $("#bxCancel").onclick = cancelBoxCount;
    $("#bxScan").onclick = openBoxCamera;
    $("#bxForm").onsubmit = async (e) => {
      e.preventDefault();
      const v = $("#bxInput").value.trim(); if (!v) return;
      if (await addBox(v, true)) $("#bxInput").value = "";
      const i = $("#bxInput"); if (i) i.focus();
    };
    $("#bxSubmit").onclick = submitBoxCount;
    updateBoxes();
  }

  function boxStats() {
    const file = new Set((boxDraft.fileCartons || []).map(upc));
    const got = new Set(boxDraft.boxes.map((b) => upc(b.box_no)));
    const inFile = [...got].filter((b) => file.has(b)).length;
    const missing = (boxDraft.fileCartons || []).filter((c) => !got.has(upc(c)));
    const extra = boxDraft.boxes.filter((b) => file.size && !file.has(upc(b.box_no)));
    return { file, inFile, missing, extra, total: boxDraft.boxes.length };
  }

  function updateBoxes(newId) {
    if (!$("#bxNum") || !boxDraft) return;
    const st = boxStats();
    $("#bxNum").textContent = st.total;
    if (boxDraft.deliveryId) {
      $("#bxSide").innerHTML = `<b>${st.inFile} / ${st.file.size}</b> in file<br>${st.missing.length ? `<span style="color:#b42318">${st.missing.length} missing</span>` : `<span style="color:#0d5c30">all received</span>`}` +
        (st.extra.length ? `<br><span style="color:#8a6100">${st.extra.length} not in file</span>` : "");
      $("#bxBar").style.width = (st.file.size ? Math.min(100, (st.inFile / st.file.size) * 100) : 0) + "%";
    } else $("#bxSide").innerHTML = "";
    $("#bxSubmit").disabled = !st.total;
    $("#bxSubmit").textContent = st.total ? `Submit box count (${st.total} boxes)` : "Submit box count";
    const list = $("#bxList");
    if (!st.total) { list.innerHTML = `<div class="empty">No boxes yet. Press Scan and hold the SCAN button on each box label.</div>`; return; }
    list.innerHTML = boxDraft.boxes.map((b, i) => ({ b, i })).reverse().map(({ b, i }) => `
      <div class="item ${b.id === newId ? "new" : ""}" data-id="${b.id}">
        <div class="item-no">${i + 1}</div>
        <div class="item-main">
          <div class="item-code">${esc(b.box_no)}${b.notInFile ? `<span class="dup">not in file</span>` : ""}</div>
          <div class="item-meta">${fmtTime(b.t)}${b.manual ? " &middot; typed" : ""}</div>
        </div>
        <button class="del" title="Delete" aria-label="Delete">&#128465;</button>
      </div>`).join("");
    list.querySelectorAll(".del").forEach((x) => (x.onclick = () => deleteBox(x.closest(".item").dataset.id)));
  }

  async function renderBoxStart() {
    shell(backBar("Receive Boxes") + `
      <section class="cell">
        <div class="cell-label">Start a box count</div>
        <div class="field" style="margin-top:4px"><label>Delivery file</label>
          <select class="input" id="bxFile"><option value="">Loading…</option></select>
          <div class="hint">If the file is uploaded, the app shows how many boxes are missing.</div></div>
        <div class="field"><label>Reference</label><input class="input" id="bxRef" placeholder="e.g. GTV 12345 / Shipment ${esc(fmtD(today()))}"></div>
        <button class="btn btn-black" id="bxStart" style="width:100%;margin-top:16px;padding:15px">Start box count</button>
      </section>
      <div class="list-head" style="margin-top:22px"><h3>My recent box counts</h3></div>
      <div class="items" id="bxRecent"><div class="empty">Loading…</div></div>`);
    bindBack();
    let files = [];
    try {
      files = await call("staff_list_deliveries");
      $("#bxFile").innerHTML = `<option value="">No delivery file - plain count</option>` +
        files.map((d) => `<option value="${d.id}">${esc(d.ref)}${d.delivery_date ? " - " + esc(fmtD(d.delivery_date)) : ""} (${num(d.cartons)} boxes)</option>`).join("");
    } catch (e) { if ($("#bxFile")) $("#bxFile").innerHTML = `<option value="">No delivery file - plain count</option>`; }
    if (!$("#bxFile")) return;
    $("#bxFile").onchange = () => { const d = files.find((x) => x.id === $("#bxFile").value); if (d) $("#bxRef").value = d.ref; };
    $("#bxStart").onclick = async () => {
      const id = $("#bxFile").value, d = files.find((x) => x.id === id);
      let ref = $("#bxRef").value.trim() || (d ? d.ref : "Shipment " + fmtD(today()));
      let cartons = [];
      if (d) {
        const b = $("#bxStart"); b.disabled = true; b.innerHTML = `<span class="spinner"></span>`;
        try { cartons = await call("staff_delivery_cartons", { p_delivery_id: d.id }); }
        catch (e) { b.disabled = false; b.textContent = "Start box count"; return alertBox("Could not load the delivery file", e.message); }
      }
      boxDraft = { ref, deliveryId: d ? d.id : null, deliveryRef: d ? d.ref : null, fileCartons: cartons, startedAt: new Date().toISOString(), boxes: [] };
      saveBoxDraft(); renderBoxes();
    };
    try {
      const r = await call("staff_my_box_counts");
      const el = $("#bxRecent"); if (!el) return;
      el.innerHTML = r.length ? r.map((c) => `<div class="item"><div class="item-main"><div class="item-code">${esc(c.ref)}</div><div class="item-meta">${fmtDT(c.submitted_at)}</div></div><span class="pill k">${num(c.total_boxes)} boxes</span></div>`).join("")
        : `<div class="empty">No box counts in the last 7 days.</div>`;
    } catch (e) { const el = $("#bxRecent"); if (el) el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  const camOpen = () => !$("#camera").classList.contains("hidden");
  let boxBusy = false;
  async function addBox(code, manual) {
    code = String(code || "").trim();
    if (!code || !boxDraft || boxBusy) return false;
    const prev = boxDraft.boxes.findIndex((b) => upc(b.box_no) === upc(code));
    if (prev >= 0) {
      signal("err");
      const msg = `Box ${code} already counted (#${prev + 1}) - not added`;
      if (camOpen()) Scanner.showMsg("✗ " + msg, "warn"); else toast(msg);
      return false;
    }
    let notInFile = false;
    if (boxDraft.deliveryId && !boxDraft.fileCartons.some((c) => upc(c) === upc(code))) {
      signal("warn"); boxBusy = true;
      const ok = await modal(`<h2>&#9888; Box not in delivery file</h2>
        <div class="warn-box">Box <b class="mono">${esc(code)}</b> is not in <b>${esc(boxDraft.deliveryRef)}</b>.</div>
        <p>The label may have more than one barcode - check you scanned the <b>box number</b>.</p>
        ${boxDraft.fileCartons.length ? `<p class="muted">Box numbers in the file look like:<br><b class="mono">${boxDraft.fileCartons.slice(0, 3).map(esc).join("<br>")}</b></p>` : ""}`,
        [{ label: "Don't add", value: false }, { label: "Add anyway", cls: "btn-black", value: true }]);
      boxBusy = false;
      if (!ok) { if (camOpen()) Scanner.showMsg("Not added: " + code, "warn"); return false; }
      notInFile = true;
    }
    const b = { id: newId(), box_no: code, t: new Date().toISOString() };
    if (manual) b.manual = true;
    if (notInFile) b.notInFile = true;
    boxDraft.boxes.push(b); saveBoxDraft();
    signal("ok"); updateBoxes(b.id);
    if (camOpen()) { Scanner.showMsg(`✓ ${code} added`, "ok"); Scanner.setCount(boxDraft.boxes.length); }
    return true;
  }

  function openBoxCamera() {
    if (!boxDraft) return;
    Scanner.setCount(boxDraft.boxes.length);
    Scanner.onClose = () => updateBoxes();
    Scanner.open({ title: "Scan boxes", sub: boxDraft.ref + " - scan each box label once", showCount: true, countLabel: "boxes", onCode: (c) => addBox(c, false) });
  }

  function deleteBox(id) {
    const i = boxDraft.boxes.findIndex((b) => b.id === id); if (i < 0) return;
    const [removed] = boxDraft.boxes.splice(i, 1); saveBoxDraft(); updateBoxes();
    toast(`Deleted box ${removed.box_no}`, "UNDO", () => { boxDraft.boxes.splice(i, 0, removed); saveBoxDraft(); updateBoxes(); }, 5000);
  }

  async function cancelBoxCount() {
    if (boxDraft.boxes.length) {
      const ok = await modal(`<h2>Cancel this box count?</h2><p>All <b>${boxDraft.boxes.length}</b> scanned boxes for <b>${esc(boxDraft.ref)}</b> will be deleted. Nothing has been submitted.</p>`,
        [{ label: "Keep counting", value: false }, { label: "Cancel count", cls: "btn-red", value: true }]);
      if (!ok) return;
    }
    boxDraft = null; saveBoxDraft(); renderBoxes();
  }

  async function submitBoxCount() {
    const st = boxStats(); if (!st.total) return;
    const missHtml = boxDraft.deliveryId ? (st.missing.length
      ? `<div class="err-box"><b>${st.missing.length} box${st.missing.length === 1 ? "" : "es"} missing</b> from the delivery file:<br><span class="mono">${st.missing.slice(0, 15).map(esc).join(", ")}${st.missing.length > 15 ? " …" : ""}</span></div>`
      : `<div class="ok-box">All ${st.file.size} boxes in the delivery file are received.</div>`) +
      (st.extra.length ? `<div class="warn-box">${st.extra.length} box${st.extra.length === 1 ? "" : "es"} not in the delivery file.</div>` : "") : "";
    const ok = await modal(`
      <h2>Confirm box count</h2><p>${esc(boxDraft.ref)}</p>
      <div class="big-total">${st.total}</div>
      <div class="big-total-sub">boxes scanned</div>
      ${missHtml}
      <div class="warn-box">Does <b>${st.total} boxes</b> match the boxes physically received?</div>`,
      [{ label: "No, go back", value: false }, { label: "Yes, submit", cls: "btn-green", value: true }]);
    if (!ok) return;
    const btn = $("#bxSubmit"); btn.disabled = true; btn.innerHTML = `<span class="spinner"></span> Submitting…`;
    try {
      const r = await call("staff_submit_box_count", { p_ref: boxDraft.ref, p_delivery_id: boxDraft.deliveryId, p_started_at: boxDraft.startedAt,
        p_boxes: boxDraft.boxes.map((b) => ({ box_no: b.box_no, scanned_at: b.t })) });
      const ref = boxDraft.ref;
      boxDraft = null; saveBoxDraft(); signal("ok");
      renderBoxes();
      modal(`<h2>&#10003; Submitted</h2><div class="ok-box">Box count <b>${esc(ref)}</b> saved with <b>${num(r.total_boxes)} boxes</b>.</div>`, [{ label: "OK", cls: "btn-black", value: true }]);
    } catch (e) {
      updateBoxes();
      if (e.code !== "SESSION_EXPIRED") { signal("err"); alertBox("Not submitted", e.message + " Your scans are still saved on this phone - try again."); }
    }
  }

  // ================================================================ ADMIN: box counts
  let bFrom = today(-7), bTo = today();
  function renderBoxCounts() {
    shell(`
      <div class="card">
        <div class="grid2">
          <div class="field" style="margin-top:0"><label>From</label><input class="input" type="date" id="bFrom" value="${bFrom}"></div>
          <div class="field" style="margin-top:0"><label>To</label><input class="input" type="date" id="bTo" value="${bTo}"></div>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn btn-black" id="bLoad">Show</button></div>
      </div>
      <div class="card"><h3>Box counts</h3><div id="bList"><span class="spinner"></span></div></div>`, { wide: true });
    $("#bLoad").onclick = () => { bFrom = $("#bFrom").value; bTo = $("#bTo").value; loadBoxCounts(); };
    loadBoxCounts();
  }

  async function loadBoxCounts() {
    const el = $("#bList"); el.innerHTML = `<span class="spinner"></span>`;
    try {
      const r = await call("admin_list_box_counts", { p_from: bFrom || null, p_to: bTo || null });
      if (!r.length) { el.innerHTML = `<div class="empty">No box counts in this period.</div>`; return; }
      el.innerHTML = `<div class="tbl-scroll"><table class="tbl"><thead><tr><th>Reference</th><th>Delivery file</th><th>Staff</th><th>Submitted</th><th>Boxes</th><th></th></tr></thead><tbody>
        ${r.map((b) => {
          const all = b.has_file && b.received_in_file >= b.file_cartons;
          return `<tr><td><b>${esc(b.ref)}</b></td>
          <td>${b.has_file ? `<span class="pill ${all ? "g" : "r"}">${esc(b.delivery_ref || "")}: ${num(b.received_in_file)} / ${num(b.file_cartons)}</span>` : `<span class="pill k">No file</span>`}</td>
          <td>${esc(b.staff_name)}</td><td>${fmtDT(b.submitted_at)}</td><td><b>${num(b.total_boxes)} boxes</b></td>
          <td><div class="actions"><button class="btn btn-black btn-sm" data-xl="${b.id}">&#8681; Excel</button><button class="btn btn-ghost btn-sm" data-del="${b.id}" data-r="${esc(b.ref)}">Delete</button></div></td></tr>`;
        }).join("")}</tbody></table></div>`;
      el.querySelectorAll("[data-xl]").forEach((x) => (x.onclick = async () => {
        const old = x.innerHTML; x.disabled = true; x.innerHTML = `<span class="spinner"></span>`;
        try { const s2 = await XL.downloadBoxReport(await call("admin_export_box_count", { p_id: x.dataset.xl }));
              toast(s2.hasFile ? `Report ready: ${s2.received} received, ${s2.missing} missing, ${s2.extra} extra` : `Report ready: ${s2.total} boxes`, null, null, 5000); }
        catch (e) { alertBox("Report failed", e.message); }
        x.disabled = false; x.innerHTML = old;
      }));
      el.querySelectorAll("[data-del]").forEach((x) => (x.onclick = async () => {
        const ok = await modal(`<h2>Delete box count?</h2><p><b>${esc(x.dataset.r)}</b> will be deleted.</p>`, [{ label: "Cancel", value: false }, { label: "Delete", cls: "btn-red", value: true }]);
        if (!ok) return;
        try { await call("admin_delete_box_count", { p_id: x.dataset.del }); loadBoxCounts(); } catch (e) { alertBox("Error", e.message); }
      }));
    } catch (e) { el.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
  }

  // ================================================================ ADMIN: delivery files
  let pendingUpload = null;
  async function renderDeliveries() {
    shell(`
      <div class="card">
        <h3>Upload delivery file</h3>
        <p class="muted" style="margin-top:-4px">Excel or CSV with 3 columns: <b>Carton No</b>, <b>Item code</b> (12 digits) and <b>On Hand</b> (qty in the carton). <button class="link" id="tplBtn">Download template</button></p>
        <div class="grid2">
          <div class="field"><label>Delivery / GTV reference</label><input class="input" id="dRef" placeholder="e.g. GTV 12345"></div>
          <div class="field"><label>Delivery date</label><input class="input" id="dDate" type="date" value="${today()}"></div>
        </div>
        <div class="field"><label>File</label><input class="input" id="dFile" type="file" accept=".xlsx,.csv"></div>
        <div id="dPreview"></div>
        <button class="btn btn-black" id="dUpload" style="margin-top:12px" disabled>Upload</button>
      </div>
      <div class="card"><h3>Delivery files</h3><div id="dList"><span class="spinner"></span></div></div>
    `, { wide: true });
    $("#tplBtn").onclick = () => XL.downloadTemplate().catch((e) => alertBox("Error", e.message));
    $("#dFile").onchange = async (e) => {
      const f = e.target.files[0]; pendingUpload = null; $("#dUpload").disabled = true;
      if (!f) { $("#dPreview").innerHTML = ""; return; }
      $("#dPreview").innerHTML = `<p class="muted"><span class="spinner"></span> Reading file…</p>`;
      try {
        const r = await XL.readDeliveryFile(f);
        if (!r.lines.length) throw new Error("No rows with a carton number and barcode were found.");
        pendingUpload = r;
        if (!$("#dRef").value) $("#dRef").value = f.name.replace(/\.(xlsx|csv)$/i, "");
        $("#dPreview").innerHTML = `<div class="ok-box">Found <b>${num(r.total)} pieces</b> (${num(r.rows)} lines) in <b>${num(r.cartons)} cartons</b>.</div>` +
          (!r.headerFound ? `<div class="warn-box">No header row found - using column A = Carton No, B = Item code${r.qtyFound ? ", C = On Hand" : ""}.</div>` : "") +
          (!r.qtyFound ? `<div class="warn-box">No On Hand / Qty column found - each row is counted as 1 piece.</div>` : "") +
          (r.badRows.length ? `<div class="warn-box">${r.badRows.length} row(s) skipped because carton, item code or qty is missing / wrong (rows ${r.badRows.slice(0, 10).join(", ")}${r.badRows.length > 10 ? "…" : ""}).</div>` : "");
        $("#dUpload").disabled = false;
      } catch (er) { $("#dPreview").innerHTML = `<div class="err-box">${esc(er.message)}</div>`; }
    };
    $("#dUpload").onclick = uploadDelivery;
    loadDeliveries();
  }

  async function uploadDelivery() {
    const ref = $("#dRef").value.trim();
    if (!ref) return alertBox("Missing reference", "Enter the delivery / GTV reference.");
    if (!pendingUpload) return;
    const b = $("#dUpload"); b.disabled = true;
    let id = null;
    try {
      id = (await call("admin_create_delivery", { p_ref: ref, p_date: $("#dDate").value || null, p_note: null })).id;
      const L = pendingUpload.lines, size = 1000;
      for (let i = 0; i < L.length; i += size) {
        b.innerHTML = `<span class="spinner"></span> Uploading ${Math.min(i + size, L.length)} / ${L.length}`;
        await call("admin_add_delivery_lines", { p_delivery_id: id, p_lines: L.slice(i, i + size) });
      }
      toast(`Uploaded ${ref}: ${num(pendingUpload.total)} pcs in ${num(pendingUpload.cartons)} cartons`);
      pendingUpload = null; renderDeliveries();
    } catch (e) {
      if (id) call("admin_delete_delivery", { p_id: id }).catch(() => {});
      b.disabled = false; b.textContent = "Upload";
      alertBox("Upload failed", e.message);
    }
  }

  async function loadDeliveries() {
    const el = $("#dList");
    try {
      const r = await call("admin_list_deliveries");
      if (!r.length) { el.innerHTML = `<div class="empty">No delivery files yet.</div>`; return; }
      el.innerHTML = `<div class="tbl-scroll"><table class="tbl"><thead><tr><th>Reference</th><th>Date</th><th>Cartons scanned</th><th>Pcs</th><th></th></tr></thead><tbody>
        ${r.map((d) => {
          const all = d.cartons_scanned >= d.cartons && d.cartons > 0;
          return `<tr><td><b>${esc(d.ref)}</b><div class="muted">by ${esc(d.uploaded_by || "")} &middot; ${fmtDT(d.uploaded_at)}</div></td>
          <td>${fmtD(d.delivery_date)}</td>
          <td><span class="pill ${all ? "g" : d.cartons_scanned ? "a" : "k"}">${num(d.cartons_scanned)} / ${num(d.cartons)}</span></td>
          <td>${num(d.total_qty)} pcs</td>
          <td><div class="actions"><button class="btn btn-black btn-sm" data-rep="${d.id}">&#8681; Excel report</button><button class="btn btn-ghost btn-sm" data-del="${d.id}" data-ref="${esc(d.ref)}">Delete</button></div></td></tr>`;
        }).join("")}</tbody></table></div>`;
      el.querySelectorAll("[data-rep]").forEach((b) => (b.onclick = () => downloadReport(b)));
      el.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
        const ok = await modal(`<h2>Delete delivery file?</h2><p><b>${esc(b.dataset.ref)}</b> will be removed. Scanned cartons are <b>not</b> deleted.</p>`,
          [{ label: "Cancel", value: false }, { label: "Delete", cls: "btn-red", value: true }]);
        if (!ok) return;
        try { await call("admin_delete_delivery", { p_id: b.dataset.del }); loadDeliveries(); } catch (e) { alertBox("Error", e.message); }
      }));
    } catch (e) { el.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
  }

  async function downloadReport(btn) {
    const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>`;
    try {
      const data = await call("admin_export_delivery", { p_delivery_id: btn.dataset.rep });
      const s = await XL.downloadDeliveryReport(data);
      toast(`Report ready: ${s.matched} matched, ${s.variance} with variance, ${s.notScanned} not scanned` + (s.extra ? `, ${s.extra} not in file` : ""), null, null, 6000);
    } catch (e) { alertBox("Report failed", e.message); }
    btn.disabled = false; btn.innerHTML = old;
  }

  // ================================================================ ADMIN: scanned cartons
  let cFrom = today(-7), cTo = today();
  async function renderCartons() {
    shell(`
      <div class="card">
        <div class="grid2">
          <div class="field" style="margin-top:0"><label>From</label><input class="input" type="date" id="cFrom" value="${cFrom}"></div>
          <div class="field" style="margin-top:0"><label>To</label><input class="input" type="date" id="cTo" value="${cTo}"></div>
        </div>
        <div class="row" style="margin-top:12px; flex-wrap:wrap">
          <button class="btn btn-black" id="cLoad">Show</button>
          <button class="btn btn-white" id="cExport">&#8681; Download scans (Excel)</button>
        </div>
        <p class="muted">The scans download has the scanned items only. For variances, use <b>Excel report</b> on the Deliveries tab.</p>
      </div>
      <div class="card"><h3>Scanned cartons</h3><div id="cList"><span class="spinner"></span></div></div>
    `, { wide: true });
    const read = () => { cFrom = $("#cFrom").value; cTo = $("#cTo").value; };
    $("#cLoad").onclick = () => { read(); loadCartons(); };
    $("#cExport").onclick = async () => {
      read(); const b = $("#cExport"); b.disabled = true;
      try {
        const r = await call("admin_export_scans", { p_from: cFrom || null, p_to: cTo || null });
        if (!r.scans.length) toast("No scans in this period.");
        else await XL.downloadScans(r.scans, (cFrom || "start") + "_to_" + (cTo || "now"));
      } catch (e) { alertBox("Error", e.message); }
      b.disabled = false;
    };
    loadCartons();
  }

  async function loadCartons() {
    const el = $("#cList"); el.innerHTML = `<span class="spinner"></span>`;
    try {
      const r = await call("admin_list_cartons", { p_from: cFrom || null, p_to: cTo || null });
      if (!r.length) { el.innerHTML = `<div class="empty">No cartons scanned in this period.</div>`; return; }
      const tot = r.reduce((s, c) => s + c.total_qty, 0);
      el.innerHTML = `<p class="muted">${num(r.length)} cartons &middot; ${num(tot)} pcs</p><div class="tbl-scroll"><table class="tbl"><thead><tr><th>Carton</th><th>Delivery file</th><th>Staff</th><th>Submitted</th><th>Pcs</th><th></th></tr></thead><tbody>
        ${r.map((c) => `<tr><td class="mono"><b>${esc(c.carton_no)}</b></td>
          <td>${c.delivery_ref ? `<span class="pill g">${esc(c.delivery_ref)}</span>` : `<span class="pill a">Not in any delivery file</span>`}</td>
          <td>${esc(c.staff_name)}</td><td>${fmtDT(c.submitted_at)}</td><td><b>${num(c.total_qty)} pcs</b></td>
          <td><div class="actions"><button class="btn btn-ghost btn-sm" data-del="${c.id}" data-c="${esc(c.carton_no)}">Delete</button></div></td></tr>`).join("")}
        </tbody></table></div>`;
      el.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
        const ok = await modal(`<h2>Delete scan?</h2><p>The scan of carton <b class="mono">${esc(b.dataset.c)}</b> will be deleted so it can be scanned again.</p>`,
          [{ label: "Cancel", value: false }, { label: "Delete", cls: "btn-red", value: true }]);
        if (!ok) return;
        try { await call("admin_delete_carton_scan", { p_id: b.dataset.del }); loadCartons(); } catch (e) { alertBox("Error", e.message); }
      }));
    } catch (e) { el.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
  }

  // ================================================================ ADMIN: staff accounts
  async function renderStaff() {
    shell(`
      <div class="card">
        <h3>Add staff account</h3>
        <form id="sForm" autocomplete="off">
          <div class="grid2">
            <div class="field"><label>Full name</label><input class="input" name="name" required></div>
            <div class="field"><label>Username</label><input class="input" name="user" autocapitalize="none" required></div>
            <div class="field"><label>PIN / Password (min 4)</label><input class="input" name="pin" required minlength="4" autocomplete="new-password"></div>
            <div class="field"><label>Role</label><select class="input" name="role"><option value="staff">Staff (scanning only)</option><option value="admin">Admin (everything)</option></select></div>
          </div>
          <button class="btn btn-black" style="margin-top:14px">Add account</button>
        </form>
        <p class="muted">Give the staff member their username and PIN. They open the app link on their phone, log in once and stay logged in.</p>
      </div>
      <div class="card"><h3>Accounts</h3><div id="sList"><span class="spinner"></span></div></div>
    `, { wide: true });
    $("#sForm").onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try {
        await call("admin_save_user", { p_id: null, p_username: f.user.value, p_full_name: f.name.value, p_pin: f.pin.value, p_role: f.role.value, p_active: true });
        toast("Account added for " + f.name.value); f.reset(); loadStaff();
      } catch (er) { alertBox("Not saved", er.message); }
    };
    loadStaff();
  }

  let staffCache = [];
  async function loadStaff() {
    const el = $("#sList");
    try {
      staffCache = await call("admin_list_users");
      el.innerHTML = `<div class="tbl-scroll"><table class="tbl"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${staffCache.map((u) => `<tr><td><b>${esc(u.full_name)}</b></td><td class="mono">${esc(u.username)}</td>
        <td>${u.role === "admin" ? `<span class="pill k">Admin</span>` : "Staff"}</td>
        <td>${u.active ? `<span class="pill g">Active</span>` : `<span class="pill r">Disabled</span>`}</td>
        <td><div class="actions"><button class="btn btn-ghost btn-sm" data-edit="${u.id}">Edit</button></div></td></tr>`).join("")}
        </tbody></table></div>`;
      el.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editStaff(staffCache.find((u) => u.id === b.dataset.edit))));
    } catch (e) { el.innerHTML = `<div class="err-box">${esc(e.message)}</div>`; }
  }

  function editStaff(u) {
    const m = $("#modal"), c = $("#modalCard");
    c.innerHTML = `<h2>Edit account</h2>
      <form id="eForm" autocomplete="off">
        <div class="field"><label>Full name</label><input class="input" name="name" value="${esc(u.full_name)}" required></div>
        <div class="field"><label>Username</label><input class="input" name="user" value="${esc(u.username)}" autocapitalize="none" required></div>
        <div class="field"><label>New PIN / Password (leave empty to keep)</label><input class="input" name="pin" minlength="4" autocomplete="new-password"></div>
        <div class="field"><label>Role</label><select class="input" name="role"><option value="staff" ${u.role === "staff" ? "selected" : ""}>Staff</option><option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option></select></div>
        <div class="field"><label>Status</label><select class="input" name="active"><option value="1" ${u.active ? "selected" : ""}>Active - can use the app</option><option value="0" ${!u.active ? "selected" : ""}>Disabled - logged out of all phones</option></select></div>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" id="eCancel">Cancel</button><button class="btn btn-black">Save</button></div>
      </form>`;
    m.classList.remove("hidden"); m.onclick = null;
    $("#eCancel").onclick = closeModal;
    $("#eForm").onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      try {
        await call("admin_save_user", { p_id: u.id, p_username: f.user.value, p_full_name: f.name.value, p_pin: f.pin.value || null, p_role: f.role.value, p_active: f.active.value === "1" });
        closeModal(); toast("Saved"); loadStaff();
        if (u.id === session.user.id) { session.user.full_name = f.name.value.trim(); session.user.username = f.user.value.trim().toLowerCase(); saveSession(); }
      } catch (er) { alertBox("Not saved", er.message); }
    };
  }

  // ================================================================ router
  function routeAdmin() {
    ({ receive: renderReceive, deliveries: renderDeliveries, cartons: renderCartons, boxes: renderBoxCounts, staff: renderStaff }[adminTab] || renderReceive)();
  }

  async function start() {
    if (!session) return renderLogin();
    loadDraft();
    if (session.user.role === "admin") routeAdmin(); else renderReceive();
    // refresh account in background (role/name changes, disabled accounts)
    try {
      const me = await rpc("app_me", { p_token: tok() });
      const changed = me.role !== session.user.role;
      session.user = me; saveSession();
      if (changed) start();
    } catch (e) {
      if (e.code === "SESSION_EXPIRED" || e.code === "ACCOUNT_DISABLED") { logout(true); renderLogin(e.message); }
    }
  }

  // service worker (offline + updates)
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // exposed for automated tests only
  window.__ccr = { addItem: (c) => addItem(c, false), setCarton, press: (c) => { Scanner.armed = true; Scanner.got = false; Scanner.hit(c); },
                   hit: (c) => Scanner.hit(c), addBox: (c) => addBox(c, false) };

  start();
})();
