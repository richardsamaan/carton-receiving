// Excel: read the delivery file, build the reports and the template.
(function () {
  const FILL = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const GREEN_FILL = FILL("FFC6EFCE"), GREEN_FONT = { color: { argb: "FF006100" }, bold: true };
  const RED_FILL = FILL("FFFFC7CE"), RED_FONT = { color: { argb: "FF9C0006" }, bold: true };
  const AMBER_FILL = FILL("FFFFEB9C"), AMBER_FONT = { color: { argb: "FF9C5700" }, bold: true };
  const HEAD_FILL = FILL("FF000000"), HEAD_FONT = { color: { argb: "FFFFFFFF" }, bold: true };
  const up = (s) => String(s == null ? "" : s).trim().toUpperCase();
  // 13-digit barcode -> 12-digit item code (first 12 digits). Anything else stays as it is.
  const itemCode = (s) => { s = String(s == null ? "" : s).trim(); return /^\d{13}$/.test(s) ? s.slice(0, 12) : s; };
  const itemKey = (s) => up(itemCode(s));
  // Excel version of itemCode() for a barcode in cell ref
  const itemFormula = (ref) => `IF(AND(LEN(${ref})=13,ISNUMBER(--${ref})),LEFT(${ref},12),${ref})`;

  function waitLib() {
    return new Promise((resolve, reject) => {
      let n = 0;
      (function check() {
        if (window.ExcelJS) return resolve(window.ExcelJS);
        if (++n > 100) return reject(new Error("Excel library did not load. Check connection and reload."));
        setTimeout(check, 100);
      })();
    });
  }

  // ---------- read a cell as clean text ----------
  function cellText(v) {
    if (v == null) return "";
    if (typeof v === "number") return Number.isInteger(v) ? v.toFixed(0) : String(v);
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "object") {
      if (v.richText) return v.richText.map((r) => r.text).join("");
      if ("result" in v) return cellText(v.result);
      if (v.text != null) return cellText(v.text);
    }
    return String(v).trim();
  }

  function parseCsv(text) {
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === "," || c === ";" || c === "\t") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c !== "\r") cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.map((r) => r.map((x) => x.trim()));
  }

  // Delivery file: Carton No | Item code | On Hand (qty of that item in that carton)
  // Returns { lines:[{carton_no, barcode(=item code), qty}], cartons, total, headerFound }
  async function readDeliveryFile(file) {
    let rows;
    if (/\.csv$/i.test(file.name)) {
      rows = parseCsv(await file.text());
    } else {
      const ExcelJS = await waitLib();
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const ws = wb.worksheets[0];
      if (!ws) throw new Error("The file has no sheets.");
      rows = [];
      ws.eachRow({ includeEmpty: false }, (r) => {
        const vals = [];
        for (let c = 1; c <= Math.max(r.cellCount, 3); c++) vals.push(cellText(r.getCell(c).value));
        rows.push(vals);
      });
    }
    // find header row (first 10 rows)
    let hdr = -1, cC = 0, cB = 1, cQ = -1;
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const r = rows[i].map((x) => x.toLowerCase());
      const ci = r.findIndex((x) => /carton|rake|box|case/.test(x));
      const bi = r.findIndex((x, j) => j !== ci && /item|barcode|ean|upc|gtin|article|sku/.test(x));
      if (ci >= 0 && bi >= 0) {
        hdr = i; cC = ci; cB = bi;
        cQ = r.findIndex((x, j) => j !== ci && j !== bi && /qty|quantity|pcs|units?|on\s*hand|onhand|soh|stock/.test(x));
        break;
      }
    }
    if (hdr < 0 && rows.some((r) => /^\d+$/.test(r[2] || ""))) cQ = 2; // no header: A carton, B item, C qty
    const start = hdr >= 0 ? hdr + 1 : (rows[0] && !/\d/.test(rows[0][cB] || "") ? 1 : 0);
    const lines = []; const bad = [];
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const carton = (r[cC] || "").trim();
      let code = itemCode(r[cB]);
      if (/^\d{1,11}$/.test(code)) code = code.padStart(12, "0"); // Excel drops leading zeros
      if (!carton && !code) continue;
      if (!carton || !code) { bad.push(i + 1); continue; }
      let qty = cQ >= 0 ? parseInt(String(r[cQ]).replace(/[, ]/g, ""), 10) : 1;
      if (cQ >= 0 && !(qty > 0)) { if (qty === 0) continue; bad.push(i + 1); continue; }
      if (!(qty > 0)) qty = 1;
      lines.push({ carton_no: carton, barcode: code, qty });
    }
    const cartons = new Set(lines.map((l) => up(l.carton_no))).size;
    const total = lines.reduce((a, l) => a + l.qty, 0);
    return { lines, cartons, total, rows: lines.length, qtyFound: cQ >= 0, headerFound: hdr >= 0, badRows: bad };
  }

  // ---------- helpers for writing ----------
  // Excel stores times without a zone: shift so it shows phone/PC local time.
  const localDate = (iso) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60000); };

  function header(ws, cols) {
    ws.columns = cols.map((c) => ({ header: c[0], key: c[0], width: c[1] }));
    const r = ws.getRow(1);
    r.eachCell((c) => { c.fill = HEAD_FILL; c.font = HEAD_FONT; c.alignment = { vertical: "middle" }; });
    r.height = 20;
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }
  const text = (ws, ref, v) => { const c = ws.getCell(ref); c.value = String(v); c.numFmt = "@"; return c; };

  function addScansSheet(wb, scans) {
    const ws = wb.addWorksheet("Scanned Items");
    header(ws, [["Carton No", 24], ["Barcode", 20], ["Item Code", 18], ["Staff Name", 22], ["Scan Time", 21]]);
    scans.forEach((s, i) => {
      const r = i + 2;
      text(ws, "A" + r, s.carton_no);
      text(ws, "B" + r, s.barcode);
      ws.getCell("C" + r).value = { formula: itemFormula("B" + r), result: itemCode(s.barcode) };
      ws.getCell("D" + r).value = s.staff_name;
      const t = ws.getCell("E" + r); t.value = localDate(s.scanned_at); t.numFmt = "dd-mmm-yyyy hh:mm:ss";
    });
    ws.autoFilter = { from: "A1", to: "E" + Math.max(1, scans.length + 1) };
    return ws;
  }

  async function download(wb, name) {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const safe = (s) => String(s || "").replace(/[^\w\-]+/g, "_").slice(0, 40);
  const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

  // ---------- full report for one delivery ----------
  // Returns workbook + summary numbers (also used by tests)
  async function buildDeliveryReport(data) {
    const ExcelJS = await waitLib();
    const wb = new ExcelJS.Workbook();
    wb.creator = "Carton Receiving"; wb.created = new Date();
    const { delivery, lines } = data;
    const extraScans = data.extra_scans || [];
    const scans = data.scans.concat(extraScans)
      .sort((a, b) => up(a.carton_no).localeCompare(up(b.carton_no)) || String(a.scanned_at).localeCompare(String(b.scanned_at)));

    // ----- Sheet 1: scanned items
    addScansSheet(wb, scans);
    const nS = Math.max(2, scans.length + 1);

    // ----- counts in JS (cached results for the formulas)
    const exp = new Map(), got = new Map(), cartonExp = new Map(), cartonGot = new Map(), cartonInfo = new Map();
    const order = []; // carton order as in delivery file
    lines.forEach((l) => {
      const q = Number(l.qty) || 1;
      const k = up(l.carton_no) + "\u0001" + itemKey(l.barcode);
      if (!exp.has(k)) exp.set(k, { carton: l.carton_no, barcode: itemCode(l.barcode), n: 0 });
      exp.get(k).n += q;
      const c = up(l.carton_no);
      if (!cartonExp.has(c)) { cartonExp.set(c, 0); order.push({ key: c, label: l.carton_no }); }
      cartonExp.set(c, cartonExp.get(c) + q);
    });
    const fileCartons = new Set(order.map((o) => o.key));
    extraScans.forEach((s) => {
      const c = up(s.carton_no);
      if (!fileCartons.has(c) && !order.some((o) => o.key === c)) { order.push({ key: c, label: s.carton_no, extra: true }); cartonExp.set(c, 0); }
    });
    scans.forEach((s) => {
      const k = up(s.carton_no) + "\u0001" + itemKey(s.barcode);
      if (!got.has(k)) got.set(k, { carton: s.carton_no, barcode: itemCode(s.barcode), n: 0 });
      got.get(k).n += 1;
      const c = up(s.carton_no);
      cartonGot.set(c, (cartonGot.get(c) || 0) + 1);
      const info = cartonInfo.get(c) || { staff: new Set(), last: s.submitted_at || s.scanned_at };
      info.staff.add(s.staff_name);
      if ((s.submitted_at || s.scanned_at) > info.last) info.last = s.submitted_at || s.scanned_at;
      cartonInfo.set(c, info);
    });

    // variance lines: only cartons that were scanned, only lines that differ
    const keys = new Set([...exp.keys(), ...got.keys()]);
    const vrows = [];
    keys.forEach((k) => {
      const carton = k.split("\u0001")[0];
      if (!cartonGot.has(carton)) return; // not scanned at all -> shown in Carton Summary
      const e = exp.get(k), g = got.get(k);
      const en = e ? e.n : 0, gn = g ? g.n : 0;
      if (en === gn) return;
      vrows.push({ carton: (e || g).carton, barcode: (e || g).barcode, en, gn });
    });
    const cartonIdx = new Map(order.map((o, i) => [o.key, i]));
    vrows.sort((a, b) => (cartonIdx.get(up(a.carton)) - cartonIdx.get(up(b.carton))) || (b.gn - b.en > 0) - (a.gn - a.en > 0) || a.barcode.localeCompare(b.barcode));

    const nD = Math.max(2, lines.length + 1);
    const SA = `'Scanned Items'!$A$2:$A$${nS}`, SC = `'Scanned Items'!$C$2:$C$${nS}`;
    const DA = `'Delivery File'!$A$2:$A$${nD}`, DB = `'Delivery File'!$B$2:$B$${nD}`, DC = `'Delivery File'!$C$2:$C$${nD}`;

    // ----- Sheet 2: variances
    const wv = wb.addWorksheet("Variances");
    header(wv, [["Carton No", 24], ["Item Code", 18], ["Expected Qty", 14], ["Scanned Qty", 14], ["Variance", 11], ["Status", 11]]);
    let excessPcs = 0, shortPcs = 0;
    vrows.forEach((v, i) => {
      const r = i + 2, diff = v.gn - v.en;
      text(wv, "A" + r, v.carton); text(wv, "B" + r, v.barcode);
      wv.getCell("C" + r).value = { formula: `SUMPRODUCT((${DA}=A${r})*(${DB}=B${r})*${DC})`, result: v.en };
      wv.getCell("D" + r).value = { formula: `SUMPRODUCT((${SA}=A${r})*(${SC}=B${r}))`, result: v.gn };
      wv.getCell("E" + r).value = { formula: `D${r}-C${r}`, result: diff };
      wv.getCell("F" + r).value = { formula: `IF(E${r}>0,"Excess",IF(E${r}<0,"Short","OK"))`, result: diff > 0 ? "Excess" : "Short" };
      const fill = diff > 0 ? GREEN_FILL : RED_FILL, font = diff > 0 ? GREEN_FONT : RED_FONT;
      ["A", "B", "C", "D", "E", "F"].forEach((c) => { wv.getCell(c + r).fill = fill; });
      wv.getCell("E" + r).font = font; wv.getCell("F" + r).font = font;
      if (diff > 0) excessPcs += diff; else shortPcs -= diff;
    });
    if (!vrows.length) { wv.getCell("A2").value = "No variances in the scanned cartons."; }
    else {
      const r = vrows.length + 3;
      wv.getCell("D" + r).value = "Excess pcs"; wv.getCell("D" + r).font = { bold: true };
      wv.getCell("E" + r).value = { formula: `SUMIF(E2:E${vrows.length + 1},">0")`, result: excessPcs };
      wv.getCell("E" + r).fill = GREEN_FILL; wv.getCell("E" + r).font = GREEN_FONT;
      wv.getCell("D" + (r + 1)).value = "Short pcs"; wv.getCell("D" + (r + 1)).font = { bold: true };
      wv.getCell("E" + (r + 1)).value = { formula: `-SUMIF(E2:E${vrows.length + 1},"<0")`, result: shortPcs };
      wv.getCell("E" + (r + 1)).fill = RED_FILL; wv.getCell("E" + (r + 1)).font = RED_FONT;
      wv.autoFilter = { from: "A1", to: "F" + (vrows.length + 1) };
    }

    // ----- Sheet 3: carton summary
    const wc = wb.addWorksheet("Carton Summary");
    header(wc, [["Carton No", 24], ["Expected Qty", 14], ["Scanned Qty", 14], ["Variance", 11], ["Status", 14], ["Scanned By", 24], ["Submitted", 21]]);
    const counts = { matched: 0, variance: 0, notScanned: 0, extra: 0 };
    const nV = Math.max(2, vrows.length + 1);
    order.forEach((o, i) => {
      const r = i + 2, en = cartonExp.get(o.key), gn = cartonGot.get(o.key) || 0;
      text(wc, "A" + r, o.label);
      wc.getCell("B" + r).value = { formula: `SUMPRODUCT((${DA}=A${r})*${DC})`, result: en };
      wc.getCell("C" + r).value = { formula: `SUMPRODUCT(--(${SA}=A${r}))`, result: gn };
      wc.getCell("D" + r).value = { formula: `C${r}-B${r}`, result: gn - en };
      // carton status needs line-level check: a carton can total 0 but still have swaps
      const lineVar = vrows.some((v) => up(v.carton) === o.key);
      const status = o.extra ? "Not in file" : gn === 0 ? "Not scanned" : (lineVar ? "Variance" : "Matched");
      wc.getCell("E" + r).value = { formula: `IF(B${r}=0,"Not in file",IF(C${r}=0,"Not scanned",IF(SUMPRODUCT(--(Variances!$A$2:$A$${nV}=A${r}))>0,"Variance","Matched")))`, result: status };
      const info = cartonInfo.get(o.key);
      wc.getCell("F" + r).value = info ? [...info.staff].join(", ") : "";
      if (info) { const t = wc.getCell("G" + r); t.value = localDate(info.last); t.numFmt = "dd-mmm-yyyy hh:mm"; }
      const st = wc.getCell("E" + r);
      if (status === "Not in file") { st.fill = GREEN_FILL; st.font = GREEN_FONT; counts.extra++; }
      else if (status === "Matched") { st.fill = GREEN_FILL; st.font = GREEN_FONT; counts.matched++; }
      else if (status === "Variance") { st.fill = RED_FILL; st.font = RED_FONT; counts.variance++; }
      else { st.fill = AMBER_FILL; st.font = AMBER_FONT; counts.notScanned++; }
      const d = wc.getCell("D" + r);
      if (gn - en > 0) d.font = GREEN_FONT; else if (gn - en < 0) d.font = RED_FONT;
    });
    const tr = order.length + 2;
    wc.getCell("A" + tr).value = "TOTAL"; wc.getRow(tr).font = { bold: true };
    const totE = lines.reduce((a, l) => a + (Number(l.qty) || 1), 0), totG = scans.length;
    wc.getCell("B" + tr).value = { formula: `SUM(B2:B${tr - 1})`, result: totE };
    wc.getCell("C" + tr).value = { formula: `SUM(C2:C${tr - 1})`, result: [...cartonGot.values()].reduce((a, b) => a + b, 0) };
    wc.getCell("D" + tr).value = { formula: `C${tr}-B${tr}`, result: totG - totE };
    wc.getRow(tr).eachCell((c) => { c.border = { top: { style: "thin" } }; });
    const ir = tr + 2;
    wc.getCell("A" + ir).value = "Delivery: " + delivery.ref + (delivery.delivery_date ? "  |  " + delivery.delivery_date : "");
    wc.getCell("A" + (ir + 1)).value = "Report created: " + new Date().toLocaleString();
    wc.getCell("A" + (ir + 2)).value = "Not scanned cartons are not listed in the Variances sheet. Items are matched by Item Code = first 12 digits of the 13-digit barcode.";
    wc.getCell("A" + (ir + 3)).value = "Not in file = carton scanned within 3 days before / 15 days after the delivery date but not found in any delivery file (all items counted as Excess). Check it is not a wrong label barcode.";
    [ir, ir + 1, ir + 2, ir + 3].forEach((r) => { wc.getCell("A" + r).font = { italic: true, color: { argb: "FF6B6B6B" } }; });

    // ----- Sheet 4: delivery file (same layout as the upload template)
    const wd = wb.addWorksheet("Delivery File");
    header(wd, [["Carton No", 24], ["Item Code", 18], ["On Hand", 11]]);
    lines.forEach((l, i) => { text(wd, "A" + (i + 2), l.carton_no); text(wd, "B" + (i + 2), itemCode(l.barcode)); wd.getCell("C" + (i + 2)).value = Number(l.qty) || 1; });
    const dt = lines.length + 2;
    wd.getCell("B" + dt).value = "TOTAL"; wd.getCell("B" + dt).font = { bold: true };
    wd.getCell("C" + dt).value = { formula: `SUM(C2:C${dt - 1})`, result: totE }; wd.getCell("C" + dt).font = { bold: true };

    return { wb, summary: { variances: vrows.length, excessPcs, shortPcs, ...counts, expected: totE, scanned: totG } };
  }

  async function downloadDeliveryReport(data) {
    const { wb, summary } = await buildDeliveryReport(data);
    await download(wb, `Receiving_${safe(data.delivery.ref)}_${stamp()}.xlsx`);
    return summary;
  }

  async function downloadScans(scans, label) {
    const ExcelJS = await waitLib();
    const wb = new ExcelJS.Workbook();
    addScansSheet(wb, scans);
    await download(wb, `Scans_${safe(label)}_${stamp()}.xlsx`);
  }

  async function downloadTemplate() {
    const ExcelJS = await waitLib();
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Delivery File");
    header(ws, [["Carton No", 24], ["Item code", 18], ["On Hand", 11]]);
    [["CTN0001", "406353500001", 3], ["CTN0001", "406353500002", 1], ["CTN0002", "406353500003", 4]]
      .forEach((r, i) => { text(ws, "A" + (i + 2), r[0]); text(ws, "B" + (i + 2), r[1]); ws.getCell("C" + (i + 2)).value = r[2]; });
    ws.getCell("E2").value = "One row per item code per carton. On Hand = quantity of that item in the carton.";
    ws.getCell("E3").value = "Item code = 12 digits (the first 12 digits of the 13-digit barcode). Delete the example rows before uploading.";
    ws.getCell("E2").font = ws.getCell("E3").font = { italic: true, color: { argb: "FF6B6B6B" } };
    await download(wb, "Delivery_File_Template.xlsx");
  }

  window.XL = { readDeliveryFile, buildDeliveryReport, downloadDeliveryReport, downloadScans, downloadTemplate };
})();
