// Excel: read the delivery file, build the reports and the template.
(function () {
  const FILL = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const GREEN_FILL = FILL("FFC6EFCE"), GREEN_FONT = { color: { argb: "FF006100" }, bold: true };
  const RED_FILL = FILL("FFFFC7CE"), RED_FONT = { color: { argb: "FF9C0006" }, bold: true };
  const AMBER_FILL = FILL("FFFFEB9C"), AMBER_FONT = { color: { argb: "FF9C5700" }, bold: true };
  const HEAD_FILL = FILL("FF000000"), HEAD_FONT = { color: { argb: "FFFFFFFF" }, bold: true };
  const up = (s) => String(s == null ? "" : s).trim().toUpperCase();

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

  // Returns { lines:[{carton_no, barcode, qty:1}], cartons, total, headerFound }
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
      const bi = r.findIndex((x) => /barcode|ean|upc|gtin|item/.test(x));
      if (ci >= 0 && bi >= 0) {
        hdr = i; cC = ci; cB = bi;
        cQ = r.findIndex((x) => /^(qty|quantity|pcs|units?)\b/.test(x));
        break;
      }
    }
    const start = hdr >= 0 ? hdr + 1 : (rows[0] && !/\d/.test(rows[0][cB] || "") ? 1 : 0);
    const lines = []; const bad = [];
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      const carton = (r[cC] || "").trim(), barcode = (r[cB] || "").trim();
      if (!carton && !barcode) continue;
      if (!carton || !barcode) { bad.push(i + 1); continue; }
      let qty = cQ >= 0 ? parseInt(r[cQ], 10) : 1;
      if (!(qty > 0)) qty = 1;
      for (let k = 0; k < qty; k++) lines.push({ carton_no: carton, barcode, qty: 1 });
    }
    const cartons = new Set(lines.map((l) => up(l.carton_no))).size;
    return { lines, cartons, total: lines.length, headerFound: hdr >= 0, badRows: bad };
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
    header(ws, [["Carton No", 24], ["Barcode", 20], ["Staff Name", 22], ["Scan Time", 21]]);
    scans.forEach((s, i) => {
      const r = i + 2;
      text(ws, "A" + r, s.carton_no);
      text(ws, "B" + r, s.barcode);
      ws.getCell("C" + r).value = s.staff_name;
      const t = ws.getCell("D" + r); t.value = localDate(s.scanned_at); t.numFmt = "dd-mmm-yyyy hh:mm:ss";
    });
    ws.autoFilter = { from: "A1", to: "D" + Math.max(1, scans.length + 1) };
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
      const k = up(l.carton_no) + "\u0001" + up(l.barcode);
      if (!exp.has(k)) exp.set(k, { carton: l.carton_no, barcode: l.barcode, n: 0 });
      exp.get(k).n += 1;
      const c = up(l.carton_no);
      if (!cartonExp.has(c)) { cartonExp.set(c, 0); order.push({ key: c, label: l.carton_no }); }
      cartonExp.set(c, cartonExp.get(c) + 1);
    });
    const fileCartons = new Set(order.map((o) => o.key));
    extraScans.forEach((s) => {
      const c = up(s.carton_no);
      if (!fileCartons.has(c) && !order.some((o) => o.key === c)) { order.push({ key: c, label: s.carton_no, extra: true }); cartonExp.set(c, 0); }
    });
    scans.forEach((s) => {
      const k = up(s.carton_no) + "\u0001" + up(s.barcode);
      if (!got.has(k)) got.set(k, { carton: s.carton_no, barcode: s.barcode, n: 0 });
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
    const SA = `'Scanned Items'!$A$2:$A$${nS}`, SB = `'Scanned Items'!$B$2:$B$${nS}`;
    const DA = `'Delivery File'!$A$2:$A$${nD}`, DB = `'Delivery File'!$B$2:$B$${nD}`;

    // ----- Sheet 2: variances
    const wv = wb.addWorksheet("Variances");
    header(wv, [["Carton No", 24], ["Barcode", 20], ["Expected Qty", 14], ["Scanned Qty", 14], ["Variance", 11], ["Status", 11]]);
    let excessPcs = 0, shortPcs = 0;
    vrows.forEach((v, i) => {
      const r = i + 2, diff = v.gn - v.en;
      text(wv, "A" + r, v.carton); text(wv, "B" + r, v.barcode);
      wv.getCell("C" + r).value = { formula: `SUMPRODUCT((${DA}=A${r})*(${DB}=B${r}))`, result: v.en };
      wv.getCell("D" + r).value = { formula: `SUMPRODUCT((${SA}=A${r})*(${SB}=B${r}))`, result: v.gn };
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
      wc.getCell("B" + r).value = { formula: `SUMPRODUCT(--(${DA}=A${r}))`, result: en };
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
    const totE = lines.length, totG = scans.length;
    wc.getCell("B" + tr).value = { formula: `SUM(B2:B${tr - 1})`, result: totE };
    wc.getCell("C" + tr).value = { formula: `SUM(C2:C${tr - 1})`, result: [...cartonGot.values()].reduce((a, b) => a + b, 0) };
    wc.getCell("D" + tr).value = { formula: `C${tr}-B${tr}`, result: totG - totE };
    wc.getRow(tr).eachCell((c) => { c.border = { top: { style: "thin" } }; });
    const ir = tr + 2;
    wc.getCell("A" + ir).value = "Delivery: " + delivery.ref + (delivery.delivery_date ? "  |  " + delivery.delivery_date : "");
    wc.getCell("A" + (ir + 1)).value = "Report created: " + new Date().toLocaleString();
    wc.getCell("A" + (ir + 2)).value = "Not scanned cartons are not listed in the Variances sheet.";
    wc.getCell("A" + (ir + 3)).value = "Not in file = carton scanned within 3 days before / 15 days after the delivery date but not found in any delivery file (all items counted as Excess). Check it is not a wrong label barcode.";
    [ir, ir + 1, ir + 2, ir + 3].forEach((r) => { wc.getCell("A" + r).font = { italic: true, color: { argb: "FF6B6B6B" } }; });

    // ----- Sheet 4: delivery file (same layout as the upload template)
    const wd = wb.addWorksheet("Delivery File");
    header(wd, [["Carton No", 24], ["Barcode", 20]]);
    lines.forEach((l, i) => { text(wd, "A" + (i + 2), l.carton_no); text(wd, "B" + (i + 2), l.barcode); });

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
    header(ws, [["Carton No", 24], ["Barcode", 20]]);
    [["CTN0001", "4063535000011"], ["CTN0001", "4063535000011"], ["CTN0001", "4063535000028"], ["CTN0002", "4063535000035"]]
      .forEach((r, i) => { text(ws, "A" + (i + 2), r[0]); text(ws, "B" + (i + 2), r[1]); });
    ws.getCell("D2").value = "One row per piece: repeat the barcode once for every unit in the carton.";
    ws.getCell("D3").value = "Delete the example rows before uploading.";
    ws.getCell("D2").font = ws.getCell("D3").font = { italic: true, color: { argb: "FF6B6B6B" } };
    await download(wb, "Delivery_File_Template.xlsx");
  }

  window.XL = { readDeliveryFile, buildDeliveryReport, downloadDeliveryReport, downloadScans, downloadTemplate };
})();
