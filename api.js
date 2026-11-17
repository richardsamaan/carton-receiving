// Talks to the Supabase database functions (or a local demo store).
(function () {
  const cfg = window.APP_CONFIG || {};
  const DEMO = !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY;

  const FRIENDLY = {
    WRONG_LOGIN: "Wrong username or PIN.",
    LOCKED: "Too many wrong attempts. Try again in 15 minutes.",
    ACCOUNT_DISABLED: "This account is disabled. Ask your manager.",
    SESSION_EXPIRED: "Your login has expired. Please log in again.",
    ADMIN_ONLY: "Admin only.",
    NO_CARTON: "Scan the carton number first.",
    NO_ITEMS: "No items scanned in this carton.",
    NAME_REQUIRED: "Username and full name are required.",
    PIN_REQUIRED: "A PIN / password is required for a new account.",
    PIN_TOO_SHORT: "PIN / password must be at least 4 characters.",
    USERNAME_TAKEN: "This username is already used.",
    CANNOT_DEMOTE_SELF: "You cannot disable or remove admin from your own account.",
    NOT_FOUND: "Not found.",
    NO_BOXES: "No boxes scanned."
  };

  class ApiError extends Error {
    constructor(code) { super(FRIENDLY[code] || code); this.code = code; }
  }

  // ------------------------------------------------------------ Supabase
  async function rpcRemote(fn, params) {
    let res;
    try {
      const key = String(cfg.SUPABASE_ANON_KEY).trim();
      const headers = { "Content-Type": "application/json", apikey: key };
      // old-style "anon" keys (start with eyJ) also go in Authorization;
      // new "sb_publishable_" keys must only be sent as apikey
      if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
      res = await fetch(String(cfg.SUPABASE_URL).trim().replace(/\/$/, "") + "/rest/v1/rpc/" + fn, {
        method: "POST",
        headers,
        body: JSON.stringify(params || {})
      });
    } catch (e) {
      throw new ApiError("No internet connection. Check Wi-Fi / data and try again.");
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      const msg = (data && data.message) || ("Server error " + res.status);
      throw new ApiError(String(msg).replace(/^.*?([A-Z_]{4,}).*$/s, "$1"));
    }
    if (data && data.error) throw new ApiError(data.error);
    return data;
  }

  // ------------------------------------------------------------ Demo store
  const KEY = "ccr_demo_db_v1";
  function load() {
    let db = null;
    try { db = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (!db) {
      db = { users: [], sessions: {}, deliveries: [], lines: [], cartons: [], scans: [], boxCounts: [], boxScans: [] };
      db.users.push({ id: uid(), username: "admin", full_name: "Admin (demo)", pin: "1234", role: "admin", active: true });
      db.users.push({ id: uid(), username: "staff", full_name: "Staff (demo)", pin: "1111", role: "staff", active: true });
      save(db);
    }
    return fix(db);
  }
  function fix(db) { db.boxCounts = db.boxCounts || []; db.boxScans = db.boxScans || []; return db; }
  function save(db) { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {} }
  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); }
  const up = (s) => String(s || "").trim().toUpperCase();
  const pub = (u) => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, active: u.active });
  function auth(db, token, admin) {
    const u = db.users.find((x) => x.id === db.sessions[token]);
    if (!u) throw new ApiError("SESSION_EXPIRED");
    if (!u.active) throw new ApiError("ACCOUNT_DISABLED");
    if (admin && u.role !== "admin") throw new ApiError("ADMIN_ONLY");
    return u;
  }
  const DAY = 86400000;
  function baseDate(d) { return new Date(d.delivery_date ? d.delivery_date + "T00:00:00" : d.uploaded_at).getTime(); }
  function inWindow(c, d) {
    const t = new Date(c.submitted_at).getTime(), b = baseDate(d);
    return t >= b - 14 * DAY && t <= b + 60 * DAY;
  }
  function inRange(iso, from, to) {
    const t = new Date(iso).getTime();
    if (from && t < new Date(from + "T00:00:00").getTime()) return false;
    if (to && t >= new Date(to + "T00:00:00").getTime() + DAY) return false;
    return true;
  }

  const demo = {
    app_login({ p_username, p_pin }) {
      const db = load();
      const u = db.users.find((x) => x.username === String(p_username).trim().toLowerCase());
      if (!u || u.pin !== p_pin) throw new ApiError("WRONG_LOGIN");
      if (!u.active) throw new ApiError("ACCOUNT_DISABLED");
      const t = uid(); db.sessions[t] = u.id; save(db);
      return { token: t, user: pub(u) };
    },
    app_me({ p_token }) { return pub(auth(load(), p_token)); },
    app_logout({ p_token }) { const db = load(); delete db.sessions[p_token]; save(db); return { ok: true }; },
    staff_check_carton({ p_token, p_carton }) {
      const db = load(); auth(db, p_token);
      const prev = db.cartons.filter((c) => up(c.carton_no) === up(p_carton) && Date.now() - new Date(c.submitted_at) < 120 * DAY)
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))
        .map((c) => ({ id: c.id, staff_name: c.staff_name, submitted_at: c.submitted_at, total_qty: c.total_qty }));
      const byNew = db.deliveries.slice().sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
      const hit = byNew.find((d) => db.lines.some((l) => l.delivery_id === d.id && up(l.carton_no) === up(p_carton)));
      const recent = db.deliveries.filter((d) => Date.now() - baseDate(d) <= 21 * DAY || Date.now() - new Date(d.uploaded_at) <= 21 * DAY);
      const latest = byNew[0];
      const examples = latest ? [...new Set(db.lines.filter((l) => l.delivery_id === latest.id).map((l) => l.carton_no))].sort().slice(0, 3) : [];
      const ids = new Set(recent.map((d) => d.id));
      const known = [...new Set(db.lines.filter((l) => ids.has(l.delivery_id)).map((l) => up(l.carton_no)))];
      return { previous: prev, delivery_ref: hit ? hit.ref : null, recent_files: recent.length, examples, known_cartons: known };
    },
    staff_submit_carton({ p_token, p_carton, p_started_at, p_lines, p_replace }) {
      const db = load(); const u = auth(db, p_token);
      if (!String(p_carton || "").trim()) throw new ApiError("NO_CARTON");
      if (!p_lines.length) throw new ApiError("NO_ITEMS");
      if (p_replace) {
        const ids = db.cartons.filter((c) => up(c.carton_no) === up(p_carton)).map((c) => c.id);
        db.cartons = db.cartons.filter((c) => !ids.includes(c.id));
        db.scans = db.scans.filter((s) => !ids.includes(s.carton_scan_id));
      }
      const id = uid();
      db.cartons.push({ id, carton_no: String(p_carton).trim(), user_id: u.id, staff_name: u.full_name, started_at: p_started_at, submitted_at: new Date().toISOString(), total_qty: p_lines.length });
      p_lines.forEach((l) => db.scans.push({ carton_scan_id: id, barcode: String(l.barcode).trim(), scanned_at: l.scanned_at }));
      save(db);
      return { id, total_qty: p_lines.length };
    },
    staff_my_recent({ p_token }) {
      const db = load(); const u = auth(db, p_token);
      return db.cartons.filter((c) => c.user_id === u.id && Date.now() - new Date(c.submitted_at) < 2 * DAY)
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)).slice(0, 50)
        .map((c) => ({ carton_no: c.carton_no, total_qty: c.total_qty, submitted_at: c.submitted_at }));
    },
    staff_list_deliveries({ p_token }) {
      const db = load(); auth(db, p_token);
      return db.deliveries.slice().sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)).slice(0, 30)
        .map((d) => ({ id: d.id, ref: d.ref, delivery_date: d.delivery_date, cartons: new Set(db.lines.filter((l) => l.delivery_id === d.id).map((l) => up(l.carton_no))).size }));
    },
    staff_delivery_cartons({ p_token, p_delivery_id }) {
      const db = load(); auth(db, p_token);
      const seen = new Set(), out = [];
      db.lines.filter((l) => l.delivery_id === p_delivery_id).forEach((l) => { if (!seen.has(up(l.carton_no))) { seen.add(up(l.carton_no)); out.push(l.carton_no); } });
      return out;
    },
    staff_submit_box_count({ p_token, p_ref, p_delivery_id, p_started_at, p_boxes }) {
      const db = load(); const u = auth(db, p_token);
      if (!p_boxes.length) throw new ApiError("NO_BOXES");
      const d = p_delivery_id && db.deliveries.find((x) => x.id === p_delivery_id);
      const id = uid();
      db.boxCounts.push({ id, ref: (p_ref || "").trim() || (d && d.ref) || "Box count", delivery_id: d ? d.id : null, delivery_ref: d ? d.ref : null,
        user_id: u.id, staff_name: u.full_name, started_at: p_started_at, submitted_at: new Date().toISOString(), total_boxes: p_boxes.length });
      p_boxes.forEach((b) => db.boxScans.push({ box_count_id: id, box_no: String(b.box_no).trim(), scanned_at: b.scanned_at }));
      save(db); return { id, total_boxes: p_boxes.length };
    },
    staff_my_box_counts({ p_token }) {
      const db = load(); const u = auth(db, p_token);
      return db.boxCounts.filter((b) => b.user_id === u.id).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)).slice(0, 30)
        .map((b) => ({ ref: b.ref, total_boxes: b.total_boxes, submitted_at: b.submitted_at }));
    },
    admin_list_box_counts({ p_token, p_from, p_to }) {
      const db = load(); auth(db, p_token, true);
      return db.boxCounts.filter((b) => inRange(b.submitted_at, p_from, p_to)).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)).map((b) => {
        const fc = new Set(db.lines.filter((l) => l.delivery_id === b.delivery_id).map((l) => up(l.carton_no)));
        const got = new Set(db.boxScans.filter((s) => s.box_count_id === b.id && fc.has(up(s.box_no))).map((s) => up(s.box_no)));
        return { id: b.id, ref: b.ref, delivery_ref: b.delivery_ref, has_file: !!b.delivery_id, staff_name: b.staff_name, submitted_at: b.submitted_at, total_boxes: b.total_boxes, file_cartons: fc.size, received_in_file: got.size };
      });
    },
    admin_export_box_count({ p_token, p_id }) {
      const db = load(); auth(db, p_token, true);
      const b = db.boxCounts.find((x) => x.id === p_id); if (!b) throw new ApiError("NOT_FOUND");
      const seen = new Set(), cartons = [];
      db.lines.filter((l) => l.delivery_id === b.delivery_id).forEach((l) => { if (!seen.has(up(l.carton_no))) { seen.add(up(l.carton_no)); cartons.push(l.carton_no); } });
      return { count: Object.assign({ has_file: !!b.delivery_id }, b), boxes: db.boxScans.filter((s) => s.box_count_id === b.id).map((s) => ({ box_no: s.box_no, scanned_at: s.scanned_at })), file_cartons: cartons };
    },
    admin_delete_box_count({ p_token, p_id }) {
      const db = load(); auth(db, p_token, true);
      db.boxCounts = db.boxCounts.filter((b) => b.id !== p_id); db.boxScans = db.boxScans.filter((s) => s.box_count_id !== p_id);
      save(db); return { ok: true };
    },
    admin_list_users({ p_token }) { const db = load(); auth(db, p_token, true); return db.users.map(pub); },
    admin_save_user({ p_token, p_id, p_username, p_full_name, p_pin, p_role, p_active }) {
      const db = load(); const me = auth(db, p_token, true);
      const uname = String(p_username || "").trim().toLowerCase();
      if (!uname || !String(p_full_name || "").trim()) throw new ApiError("NAME_REQUIRED");
      if (p_pin && p_pin.length < 4) throw new ApiError("PIN_TOO_SHORT");
      if (db.users.some((x) => x.username === uname && x.id !== p_id)) throw new ApiError("USERNAME_TAKEN");
      let u;
      if (!p_id) {
        if (!p_pin) throw new ApiError("PIN_REQUIRED");
        u = { id: uid(), username: uname, full_name: p_full_name.trim(), pin: p_pin, role: p_role, active: p_active };
        db.users.push(u);
      } else {
        if (p_id === me.id && (p_role !== "admin" || !p_active)) throw new ApiError("CANNOT_DEMOTE_SELF");
        u = db.users.find((x) => x.id === p_id);
        Object.assign(u, { username: uname, full_name: p_full_name.trim(), role: p_role, active: p_active });
        if (p_pin) u.pin = p_pin;
      }
      save(db); return pub(u);
    },
    admin_create_delivery({ p_token, p_ref, p_date, p_note }) {
      const db = load(); const me = auth(db, p_token, true);
      const id = uid();
      db.deliveries.push({ id, ref: p_ref.trim(), delivery_date: p_date || null, note: p_note || null, uploaded_by: me.full_name, uploaded_at: new Date().toISOString() });
      save(db); return { id };
    },
    admin_add_delivery_lines({ p_token, p_delivery_id, p_lines }) {
      const db = load(); auth(db, p_token, true);
      p_lines.forEach((l) => db.lines.push({ delivery_id: p_delivery_id, carton_no: String(l.carton_no).trim(), barcode: String(l.barcode).trim(), qty: Number(l.qty) || 1 }));
      save(db); return { added: p_lines.length };
    },
    admin_list_deliveries({ p_token }) {
      const db = load(); auth(db, p_token, true);
      return db.deliveries.slice().sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)).map((d) => {
        const ls = db.lines.filter((l) => l.delivery_id === d.id);
        const cartons = [...new Set(ls.map((l) => up(l.carton_no)))];
        const scanned = cartons.filter((cn) => db.cartons.some((c) => up(c.carton_no) === cn && inWindow(c, d)));
        return Object.assign({}, d, { cartons: cartons.length, total_qty: ls.reduce((s, l) => s + l.qty, 0), cartons_scanned: scanned.length });
      });
    },
    admin_delete_delivery({ p_token, p_id }) {
      const db = load(); auth(db, p_token, true);
      db.deliveries = db.deliveries.filter((d) => d.id !== p_id);
      db.lines = db.lines.filter((l) => l.delivery_id !== p_id);
      save(db); return { ok: true };
    },
    admin_list_cartons({ p_token, p_from, p_to }) {
      const db = load(); auth(db, p_token, true);
      return db.cartons.filter((c) => inRange(c.submitted_at, p_from, p_to))
        .sort((a, b) => b.submitted_at.localeCompare(a.submitted_at)).map((c) => {
          const l = db.lines.find((x) => up(x.carton_no) === up(c.carton_no));
          const d = l && db.deliveries.find((x) => x.id === l.delivery_id);
          return { id: c.id, carton_no: c.carton_no, staff_name: c.staff_name, submitted_at: c.submitted_at, total_qty: c.total_qty, delivery_ref: d ? d.ref : null };
        });
    },
    admin_delete_carton_scan({ p_token, p_id }) {
      const db = load(); auth(db, p_token, true);
      db.cartons = db.cartons.filter((c) => c.id !== p_id);
      db.scans = db.scans.filter((s) => s.carton_scan_id !== p_id);
      save(db); return { ok: true };
    },
    admin_export_delivery({ p_token, p_delivery_id }) {
      const db = load(); auth(db, p_token, true);
      const d = db.deliveries.find((x) => x.id === p_delivery_id);
      if (!d) throw new ApiError("NOT_FOUND");
      const lines = db.lines.filter((l) => l.delivery_id === d.id).map((l) => ({ carton_no: l.carton_no, barcode: l.barcode, qty: l.qty }));
      const set = new Set(lines.map((l) => up(l.carton_no)));
      const cs = db.cartons.filter((c) => set.has(up(c.carton_no)) && inWindow(c, d));
      const all = new Set(db.lines.map((l) => up(l.carton_no))), b = baseDate(d);
      const extra = db.cartons.filter((c) => !all.has(up(c.carton_no)) && new Date(c.submitted_at) >= b - 3 * DAY && new Date(c.submitted_at) <= b + 15 * DAY);
      return { delivery: d, lines, scans: demoScans(db, cs), extra_scans: demoScans(db, extra) };
    },
    admin_export_scans({ p_token, p_from, p_to }) {
      const db = load(); auth(db, p_token, true);
      return { scans: demoScans(db, db.cartons.filter((c) => inRange(c.submitted_at, p_from, p_to))) };
    }
  };
  function demoScans(db, cartons) {
    const out = [];
    cartons.forEach((c) => db.scans.filter((s) => s.carton_scan_id === c.id)
      .forEach((s) => out.push({ carton_no: c.carton_no, barcode: s.barcode, staff_name: c.staff_name, scanned_at: s.scanned_at, submitted_at: c.submitted_at })));
    return out.sort((a, b) => a.carton_no.localeCompare(b.carton_no) || a.scanned_at.localeCompare(b.scanned_at));
  }

  async function rpc(fn, params) {
    if (!DEMO) return rpcRemote(fn, params);
    await new Promise((r) => setTimeout(r, 120));
    return JSON.parse(JSON.stringify(demo[fn](JSON.parse(JSON.stringify(params || {})))));
  }

  window.API = { rpc, DEMO, ApiError };
})();
