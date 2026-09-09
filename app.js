/* Solar Sizing Tool — UI layer (needs Core + Chart.js + SheetJS loaded) */
(function () {
    'use strict';

    var DEFAULTS = Core.DEFAULT_SETTINGS;
    var $ = function (id) { return document.getElementById(id); };
    var charts = {};
    var files = [];

    var state = {
        data: null,
        settings: null,
        tariffMode: 'auto',
        sizingMode: 'ongrid',
        savMode: 'ongrid',
        sizingBattery: 10,
        savSize: 5,
        savBattery: 10,
        lastBattRec: null
    };

    // ------------------------------------------------------------------ utils
    function fmtNum(n, digits) {
        if (n === null || n === undefined || !isFinite(n)) return '—';
        return n.toLocaleString('en-US', { maximumFractionDigits: digits === undefined ? 0 : digits });
    }
    function fmtB(n) { return n.toLocaleString('en-US'); }
    function money(n) { return fmtB(n) + ' ฿'; }
    function pct(n) { return (isFinite(n) ? n : 0).toFixed(1) + '%'; }
    function years(m) { return isFinite(m) ? (m / 12).toFixed(1) + ' ปี' : '∞'; }
    function toast(msg, isErr) {
        var t = $('toast');
        t.textContent = msg;
        t.className = 'toast' + (isErr ? ' err' : '');
        t.hidden = false;
        clearTimeout(toast._t);
        toast._t = setTimeout(function () { t.hidden = true; }, isErr ? 8000 : 3200);
    }
    function thaiMonth(m) {
        return ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][(m - 1) % 12];
    }
    function tariffLabel(mode) {
        if (mode === 'progressive') return 'อัตราก้าวหน้า';
        if (mode === 'flat') return 'Flat';
        return 'TOU (On/Off-Peak)';
    }

    // -------------------------------------------------------------- settings
    function loadSettings() {
        try {
            var raw = localStorage.getItem('pso_settings_v2');
            if (raw) {
                var o = JSON.parse(raw);
                var s = JSON.parse(JSON.stringify(DEFAULTS));
                if (o.tariff) Object.assign(s.tariff, o.tariff);
                if (o.solar) Object.assign(s.solar, o.solar);
                if (o.battery) Object.assign(s.battery, o.battery);
                if (o.location) { s.location = s.location || {}; Object.assign(s.location, o.location); }
                s.monthOverride = o.monthOverride === undefined ? null : o.monthOverride;
                state.tariffMode = o.tariffMode || 'auto';
                return s;
            }
        } catch (e) { /* ignore */ }
        return JSON.parse(JSON.stringify(DEFAULTS));
    }
    function saveSettings() {
        localStorage.setItem('pso_settings_v2', JSON.stringify({
            tariff: state.settings.tariff,
            solar: state.settings.solar,
            battery: state.settings.battery,
            location: state.settings.location,
            monthOverride: state.settings.monthOverride,
            tariffMode: state.tariffMode
        }));
    }

    function effectiveSettings() {
        var s = JSON.parse(JSON.stringify(state.settings));
        s.tariff.mode = state.tariffMode === 'auto' ? 'tou' : state.tariffMode;
        return s;
    }
    function selectedMonth() {
        if (state.settings.monthOverride) return state.settings.monthOverride;
        if (state.data && state.data.metadata && state.data.metadata.month) return state.data.metadata.month;
        return 4;
    }
    function basisDesc(data) {
        var period = Core.referencePeriod(data.nDays);
        if (data.nDays <= 1) {
            return { period: 30, perDay: true,
                note: 'ข้อมูลมี 1 วัน → ตัวเลขเดือน = ประมาณ ×30 วัน' };
        }
        return { period: data.nDays, perDay: false,
            note: 'ข้อมูลมี ' + data.nDays + ' วัน → ตัวเลขอ้างอิงตามระยะไฟล์ (เดือนโดยประมาณ = ×30/' + data.nDays + ')' };
    }

    // ------------------------------------------------------------------ tabs
    function switchTab(name) {
        document.querySelectorAll('.tab').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tab === name);
        });
        document.querySelectorAll('.pane').forEach(function (p) {
            p.classList.toggle('active', p.id === 'tab-' + name);
        });
        if (name === 'analysis') renderAnalysis();
        if (name === 'sizing') renderSizing();
        if (name === 'savings') renderSavings();
    }

    // ------------------------------------------------------------------ files
    function readFiles(fileList) {
        var list = Array.prototype.slice.call(fileList).filter(function (f) {
            return /\.(xls|xlsx|csv|htm|html)$/i.test(f.name);
        });
        if (!list.length) { toast('กรุณาเลือกไฟล์ .xls / .xlsx / .csv / .htm', true); return; }
        var pending = list.length;
        files = [];
        list.forEach(function (f) {
            var fr = new FileReader();
            fr.onload = function () {
                files.push({ name: f.name, content: new Uint8Array(fr.result) });
                if (--pending === 0) parseFiles();
            };
            fr.onerror = function () {
                if (--pending === 0) parseFiles();
                toast('อ่านไฟล์ ' + f.name + ' ไม่สำเร็จ', true);
            };
            fr.readAsArrayBuffer(f);
        });
    }

    function parseFiles() {
        var res = Core.parseAmrFiles(files, XLSX);
        if (res.error) {
            state.data = null;
            $('file-info').hidden = true;
            var er = $('load-error');
            er.hidden = false;
            er.textContent = '⚠️ ' + res.error;
            toast('โหลดไฟล์ไม่สำเร็จ', true);
            return;
        }
        $('load-error').hidden = true;
        state.data = res;
        $('file-info').hidden = false;
        renderFileMeta();
        renderFileSummary();
        switchTab('analysis');
        toast('โหลดข้อมูลสำเร็จ: ' + res.nDays + ' วัน · ' + fmtNum(res.totalKwh, 1) + ' kWh');
    }

    function renderFileMeta() {
        var d = state.data, m = d.metadata || {};
        $('file-meta').innerHTML =
            metric('ชื่อไฟล์', d.label || '—', '') +
            metric('ลูกค้า', m.customer || '—', '') +
            metric('เลขมิเตอร์', m.meter_no || '—', '') +
            metric('ประจำเดือน', m.month_th ? m.month_th + ' ' + (m.year || '') : '—', '');
    }
    function renderFileSummary() {
        var d = state.data;
        $('file-summary').innerHTML =
            metric('วันข้อมูล', fmtB(d.nDays) + ' วัน', 'ระยะอ้างอิง ' + Core.referencePeriod(d.nDays) + ' วัน') +
            metric('พลังงานรวม', fmtNum(d.totalKwh, 1) + ' kWh', 'โหลด ' + d.nIntervals + ' ช่วง') +
            metric('ค่าเฉลี่ย', fmtNum(d.totalKwh / Math.max(1, d.nDays), 1) + ' kWh/วัน', '') +
            metric('พีค (Peak)', fmtNum(d.peakKw, 2) + ' kW', '');
    }
    function metric(k, v, s) {
        return '<div class="metric"><div class="k">' + k + '</div><div class="v">' + v +
            (s ? '</div><div class="s">' + s + '</div>' : '</div>') + '</div>';
    }

    // --------------------------------------------------------------- analysis
    function renderAnalysis() {
        if (!state.data) return;
        var d = state.data;
        var S = effectiveSettings();
        var basis = basisDesc(d);
        var ana = Core.analyzeData(d, S.tariff);
        var bill = ana.bill.grandTotal;
        var monthlyBill = d.nDays <= 1 ? bill * 30 : bill * 30 / d.nDays;

        var prop = Core.pshForMonth(selectedMonth(), S);
        $('bill-metrics').innerHTML =
            metric('ค่าไฟ (ระยะ ' + basis.period + ' วัน)', money(bill), tariffLabel(S.tariff.mode)) +
            metric('ค่าไฟ/เดือน (โดยประมาณ)', money(monthlyBill), basis.perDay ? '×30' : '×30/' + d.nDays) +
            metric('พลังงาน/เดือน', fmtNum(d.totalKwh * 30 / Math.max(1, d.nDays), 0) + ' kWh', 'PSH เดือนนี้ ≈ ' + prop);
        $('bill-caption').textContent = '⚖️ คำนวณด้วย: ' + tariffLabel(S.tariff.mode) + ' — ' + basis.note;

        var mode = S.tariff.mode;
        var head = '';
        if (mode === 'progressive' || mode === 'flat') {
            head = '<div>พลังงานรวม <b>' + fmtNum(ana.bill.totalKwh, 1) + ' kWh</b></div>' +
                (mode === 'progressive'
                    ? '<div>ค่าไฟพลังงาน (อัตราก้าวหน้า) <b>' + money(ana.bill.energyCharge) + '</b></div>'
                    : '<div>ค่าไฟพลังงาน (Flat) <b>' + money(ana.bill.energyCharge) + '</b></div>');
        } else {
            head = '<div>พลังงาน On-Peak <b>' + fmtNum(ana.onPeakKwh, 1) + ' kWh</b></div>' +
                '<div>พลังงาน Off-Peak <b>' + fmtNum(ana.offPeakKwh, 1) + ' kWh</b></div>' +
                '<div>ค่าไฟพลังงาน (On-Peak ' + S.tariff.onPeakRate + ' / Off-Peak ' + S.tariff.offPeakRate + ') <b>' + money(ana.bill.energyCharge) + '</b></div>';
        }
        $('bill-detail').innerHTML =
            head +
            '<div>ค่า Ft <b>' + money(ana.bill.ftCharge) + '</b></div>' +
            '<div>ค่าบริการ <b>' + money(ana.bill.serviceFee) + '</b></div>' +
            '<div>VAT <b>' + money(ana.bill.vat) + '</b></div>' +
            '<div>รวม <b style="color:#35d07f">' + money(bill) + '</b></div>';

        var rep = Core.buildRepDay(d);
        var labels = timeLabels();
        makeLine('analysis-chart', {
            labels: labels,
            datasets: [{
                label: 'โหลดเฉลี่ย (kW)', data: Array.from(rep), borderColor: '#4aa3ff',
                backgroundColor: 'rgba(74,163,255,.12)', fill: true, tension: .3,
                pointRadius: 0, borderWidth: 2
            }]
        }, {
            y: { title: { display: true, text: 'กำลังไฟฟ้า (kW)' } }
        });
    }

    function timeLabels() {
        // 96 ช่วง ๆ ละ 15 นาที → index i = เวลา i*15 นาที; ติดป้ายเฉพาะจุดที่เป็นชั่วโมงตรง ทุก 4 ชม. (00,04,08,12,16,20)
        var out = new Array(96);
        for (var i = 0; i < 96; i++) {
            var hh = Math.floor(i / 4);
            out[i] = (i % 4 === 0 && hh % 4 === 0) ? (hh < 10 ? '0' + hh : hh) + ':00' : '';
        }
        return out;
    }

    // ------------------------------------------------------------------ sizing
    function syncSizingControls() {
        document.querySelectorAll('#sizing-mode .opt').forEach(function (b) {
            b.classList.toggle('active', b.dataset.mode === state.sizingMode);
        });
        $('sizing-battery-wrap').style.display = state.sizingMode === 'hybrid' ? '' : 'none';
        var monthSel = $('sizing-month');
        monthSel.innerHTML = '';
        var pshMap = state.settings.location.pshMonthly;
        var opts = [{ v: '', l: 'อัตโนมัติ (จากไฟล์)' }];
        for (var mk = 1; mk <= 12; mk++) opts.push({ v: String(mk), l: thaiMonth(mk) + ' (' + pshMap[mk] + ') PSH' });
        var cur = String(selectedMonth());
        opts.forEach(function (o) {
            var el = document.createElement('option');
            el.value = o.v; el.textContent = o.l;
            if (o.v === cur) el.selected = true;
            monthSel.appendChild(el);
        });
        $('sizing-profile-note').textContent = 'ใช้ค่า Peak Sun Hours เดือนที่เลือกสำหรับโปรไฟล์การผลิตโซลาร์';
        $('sizing-battery').value = state.sizingBattery;
        $('sizing-battery-val').textContent = state.sizingBattery + ' kWh';
    }

    function renderSizing() {
        if (!state.data) return;
        syncSizingControls();
        var d = state.data;
        var S = effectiveSettings();
        var basis = basisDesc(d);
        var opts = {
            settings: S, mode: state.sizingMode,
            battery: state.sizingMode === 'hybrid' ? {
                capacityKwh: state.sizingBattery, dod: 0.8, efficiency: 0.9, initialSoc: 0.5
            } : undefined
        };
        var res = Core.computeSizing(d, opts);
        var period = res.periodDays;

        $('basis-caption').textContent = '⚖️ คำนวณด้วย: ' + tariffLabel(S.tariff.mode) + ' — ' + basis.note +
            ' | ผลิตต่อวันต่อ kWp = ' + (res.psh * (1 - res.systemLosses)).toFixed(2) + ' kWh';

        renderRec(res, S);
        renderSizingTable(res, period, basis);
        renderSizingChart(res);

        var extra = $('sizing-chart-extra');
        if (state.sizingMode === 'hybrid') {
            extra.style.display = '';
            if (state.lastBattRec && state.lastBattRec.solarSizeKwp === state.sizingBattery &&
                false) { /* stale guard ignored; recompute below */ }
        } else {
            extra.style.display = 'none';
        }
    }

    function renderRec(res, S) {
        var r = res.recommended;
        var p = res.periodDays;
        var saveMonthly = r ? r.savingsThb * 30 / p : 0;
        var base = document.getElementById('rec-metrics');
        if (!r) { base.innerHTML = '<div class="metric"><div class="k">ไม่พบขนาดที่เหมาะสม</div></div>'; return; }
        base.innerHTML =
            metric('🏆 ขนาดแนะนำ', fmtNum(r.sizeKwp, r.sizeKwp % 1 ? 1 : 0) + ' kWp', 'ขนาดที่คุ้มสุดตามเกณฑ์ ROI') +
            metric('ประหยัด', money(saveMonthly) + '/เดือน', 'ประหยัด ' + pct(r.savingsPct)) +
            metric('คืนทุน', years(r.paybackMonths), 'ลงทุน ' + money(r.investment)) +
            metric('ใช้ไฟจากโซลาร์เอง', pct(r.selfConsumptionRatio * 100), 'เหลือทิ้ง ' + fmtNum(r.wasteKwh, 0) + ' kWh');
        base.querySelector('.metric').classList.add('hl');
    }

    function renderSizingTable(res, period, basis) {
        var tbody = $('sizing-table').querySelector('tbody');
        tbody.innerHTML = '';
        res.rows.forEach(function (r) {
            var tr = document.createElement('tr');
            if (res.recommended && Math.abs(res.recommended.sizeKwp - r.sizeKwp) < 0.001) tr.className = 'rec';
            var mPerMo = r.savingsThb * 30 / period;
            tr.innerHTML =
                '<td>' + fmtNum(r.sizeKwp, r.sizeKwp % 1 ? 1 : 0) + ' kWp</td>' +
                '<td>' + fmtNum(r.genKwh, 0) + '</td>' +
                '<td>' + fmtNum(r.selfUsedKwh, 0) + '</td>' +
                '<td>' + fmtNum(r.wasteKwh, 0) + '</td>' +
                '<td>' + money(mPerMo) + '</td>' +
                '<td>' + pct(r.savingsPct) + '</td>' +
                '<td>' + years(r.paybackMonths) + '</td>' +
                '<td>' + pct(r.selfConsumptionRatio * 100) + '</td>' +
                '<td>' + money(r.investment) + '</td>' +
                '<td>' + (tr.className === 'rec' ? '⭐ แนะนำ' : '') + '</td>';
            tbody.appendChild(tr);
        });
    }

    function renderSizingChart(res) {
        var labels = res.rows.map(function (r) { return r.sizeKwp + (r.sizeKwp % 1 ? '' : '') + ''; });
        var monthly = res.rows.map(function (r) { return r.savingsThb * 30 / res.periodDays; });
        var payback = res.rows.map(function (r) { return isFinite(r.paybackMonths) ? +(r.paybackMonths / 12).toFixed(1) : null; });
        var bg = res.rows.map(function (r) {
            return (res.recommended && Math.abs(res.recommended.sizeKwp - r.sizeKwp) < 0.001) ? '#35d07f' : '#2c4d78';
        });
        makeChart('sizing-chart', 'bar', {
            labels: labels,
            datasets: [
                { label: 'ประหยัด/เดือน (บาท)', data: monthly, backgroundColor: bg, borderRadius: 5, yAxisID: 'y' },
                { label: 'คืนทุน (ปี)', data: payback, type: 'line', borderColor: '#ff5f6d',
                  backgroundColor: '#ff5f6d', tension: .3, pointRadius: 4, yAxisID: 'y1' }
            ]
        }, {
            y: { position: 'left', title: { display: true, text: 'บาท/เดือน' } },
            y1: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'ปี' }, beginAtZero: true }
        }, 'ประหยัดค่าไฟ และระยะคืนทุน (เดือนละ เทียบระยะ ' + res.periodDays + ' วัน แปลงเป็น 30 วัน)');
    }

    function runBattRecommend() {
        if (!state.data) { toast('กรุณาโหลดข้อมูลก่อน', true); return; }
        if (state.sizingMode !== 'hybrid') { switchTab('sizing'); }
        var d = state.data;
        var S = effectiveSettings();
        // sweep recommended solar size for best pairing
        var sizing = Core.computeSizing(d, { settings: S, mode: 'ongrid' });
        var size = sizing.recommended ? sizing.recommended.sizeKwp : 10;
        state.lastBattRec = Core.recommendBattery(d, size, { settings: S });
        renderBattRec(state.lastBattRec);
        toast('คำนวณแบตแนะนำแล้ว (ขนาดโซลาร์ ' + fmtNum(size, 0) + ' kWp)');
    }

    function renderBattRec(rec) {
        var box = $('batt-recommend-box');
        if (!rec || rec.bestCapacityKwh <= 0) {
            box.hidden = false;
            box.innerHTML = '<b>🔋 ' + rec.note + '</b>';
            return;
        }
        var dur = rec.candidates;
        var rows = dur.map(function (c) {
            return '<tr><td>' + fmtNum(c.capacityKwh, 0) + ' kWh</td><td>' + money(c.addonThb) + '</td><td>' +
                years(c.batteryPaybackMonths) + '</td><td>' + fmtNum(c.wasteKwh, 0) + ' kWh</td></tr>';
        }).join('');
        box.hidden = false;
        box.innerHTML =
            '<b>🔋 แบตเตอรี่ที่แนะนำ: ' + fmtNum(rec.bestCapacityKwh, 0) + ' kWh ' +
            '(+ ~' + money(rec.addonSavingsThb) + ' บาท/เดือน เทียบ On-Grid ขนาดเดียวกัน)</b>' +
            '<p>' + rec.note + '</p>' +
            '<table><thead><tr><th>ความจุ</th><th>เพิ่มประหยัด</th><th>คืนทุนเฉพาะแบต</th><th>เหลือทิ้ง</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>';
        $('sizing-chart-extra').innerHTML = '';
        var canv = document.createElement('canvas');
        canv.id = 'batt-chart';
        $('sizing-chart-extra').appendChild(canv);
        makeLine('batt-chart', {
            labels: dur.map(function (c) { return c.capacityKwh + 'k'; }),
            datasets: [{
                label: 'เพิ่มประหยัด (บาท/เดือน)', data: dur.map(function (c) { return c.addonThb; }),
                borderColor: '#b06bff', backgroundColor: 'rgba(176,107,255,.15)',
                fill: true, tension: .3, pointRadius: function (ctx) {
                    return ctx.dataIndex === rec.candidates.findIndex(function (c) { return c.capacityKwh === rec.bestCapacityKwh; }) ? 6 : 2;
                }
            }]
        }, 'เพิ่มประหยัดจากการติดแบตต่อความจุ (Hybrid)');
    }

    // ---------------------------------------------------------------- savings
    function syncSavingsControls() {
        document.querySelectorAll('#sav-mode .opt').forEach(function (b) {
            b.classList.toggle('active', b.dataset.mode === state.savMode);
        });
        $('sav-battery-wrap').style.display = state.savMode === 'hybrid' ? '' : 'none';
        $('sav-size').value = state.savSize;
        $('sav-size-val').textContent = state.savSize + ' kWp';
        $('sav-battery').value = state.savBattery;
        $('sav-battery-val').textContent = state.savBattery + ' kWh';
    }

    function renderSavings() {
        if (!state.data) return;
        syncSavingsControls();
        var d = state.data;
        var S = effectiveSettings();
        var basis = basisDesc(d);
        var scen = Core.simulateScenario(d, state.savSize, {
            settings: S, mode: state.savMode,
            battery: state.savMode === 'hybrid' ? {
                capacityKwh: state.savBattery, dod: 0.8, efficiency: 0.9, initialSoc: 0.5
            } : undefined
        });

        var bb = scen.billBefore.grandTotal, ba = scen.billAfter.grandTotal, sv = scen.savings;
        var perDay = sv / scen.periodDays;
        var perMonth = sv * 30 / scen.periodDays;
        var sMonthly = scen.billBefore.grandTotal * 30 / scen.periodDays;

        $('save-metrics').innerHTML =
            metric('💰 ค่าไฟเดิม', money(scen.periodDays === 30 && d.nDays <= 1 ? bb : bb), basis.perDay ? 'ระยะ 30 วัน' : 'ระยะ ' + scen.periodDays + ' วัน') +
            metric('🟢 ค่าไฟหลังติดตั้ง', money(ba), 'ประหยัด ' + pct(scen.savings / Math.max(bb, 1) * 100)) +
            metric('⚡ ประหยัด/วัน', money(perDay), basis.perDay ? 'ตัวเลขจริงจากข้อมูล 1 วัน' : 'เฉลี่ยต่อวัน') +
            metric('💹 ประหยัดได้/เดือน (×30)', money(perMonth), pct(sv / Math.max(bb, 1) * 100) + ' ของบิลเดิม');
        $('waste-caption').textContent = '☀️ โซลาร์ผลิต ' + fmtNum(scen.genKwh, 0) + ' kWh · ใช้เอง ' + fmtNum(scen.selfUsedKwh, 0) +
            ' kWh · เหลือทิ้ง/ส่งGrid ' + fmtNum(scen.wasteKwh, 0) + ' kWh (ย้ำ: โมเดลไม่คิดรายได้จากการขายไฟ) · คืนทุน ≈ ' + years(paybackOf(scen, S));

        $('save-basis-caption').textContent = '⚖️ คำนวณด้วย: ' + tariffLabel(S.tariff.mode) + ' — ' + basis.note;

        renderDailyChart(scen, basis);

        $('soc-card').style.display = state.savMode === 'hybrid' ? '' : 'none';
        if (state.savMode === 'hybrid') {
            makeLine('soc-chart', {
                labels: timeLabels(),
                datasets: [
                    { label: 'SoC (%)', data: Array.from(scen.daily.soc).map(function (v) { return v * 100; }),
                      borderColor: '#b06bff', backgroundColor: 'rgba(176,107,255,.12)',
                      fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
                    { label: 'เต็ม 100%', data: Array(96).fill(100), borderColor: 'rgba(53,208,127,.4)',
                      borderDash: [6, 6], pointRadius: 0 },
                    { label: 'หมด 0%', data: Array(96).fill(0), borderColor: 'rgba(255,95,109,.4)',
                      borderDash: [6, 6], pointRadius: 0 }
                ]
            }, {
                y: { min: 0, max: 100, title: { display: true, text: '%' } }
            }, 'สถานะการชาร์จแบตเตอรี่ (SoC) ราย 15 นาที', false);
        }
    }

    function paybackOf(scen, S) {
        if (scen.savings <= 0) return Infinity;
        var invest = scen.solarSizeKwp * S.solar.pricePerKwp +
            (state.savMode === 'hybrid' ? scen.batteryKwh * S.battery.pricePerKwh : 0);
        return invest / scen.savings;
    }

    function renderDailyChart(scen, basis) {
        var d = scen.daily;
        var sets = [
            { label: 'โหลด (kW)', data: Array.from(d.load), borderColor: '#4aa3ff', backgroundColor: 'rgba(74,163,255,.12)', fill: true },
            { label: 'Solar ผลิต (kW)', data: Array.from(d.solar), borderColor: '#ffb000', backgroundColor: 'rgba(255,176,0,.10)', fill: true },
            { label: 'Grid ดึง (kW)', data: Array.from(d.grid), borderColor: '#ff5f6d', backgroundColor: 'rgba(255,95,109,.18)', fill: true }
        ];
        if (d.export) {
            sets.push({ label: 'ส่งGrid/เหลือ (kW)', data: Array.from(d.export), borderColor: '#35d07f', borderDash: [5, 4], fill: false });
        }
        if (state.savMode === 'hybrid' && d.batteryDischarge) {
            sets.push({ label: 'แบตจ่ายไฟ (kW)', data: Array.from(d.batteryDischarge), borderColor: '#b06bff', backgroundColor: 'rgba(176,107,255,.18)', fill: true });
            sets.push({ label: 'แบตชาร์จ (kW)', data: Array.from(d.batteryCharge), borderColor: '#3ec5d0', borderDash: [5, 4], fill: false });
        }
        makeLine('daily-chart', {
            labels: timeLabels(), datasets: sets
        }, {
            y: { title: { display: true, text: 'kW' } }
        }, 'โหลด vs Solar vs Grid' + (state.savMode === 'hybrid' ? ' vs แบตเตอรี่' : '') + ' (วันแทน) — ระยะ ' + scen.periodDays + ' วัน');
    }

    // ------------------------------------------------------------- chart utils
    function mk(obj) {
        return JSON.parse(JSON.stringify(obj || {}));
    }
    function baseScales() {
        return {
            x: {
                grid: { display: false },
                border: { display: true, color: 'rgba(51,65,85,.4)' },
                ticks: { color: '#94a3b8', maxRotation: 0, minRotation: 0, autoSkip: false }
            },
            y: { beginAtZero: true, grid: { color: 'rgba(51,65,85,.35)' }, ticks: { color: '#94a3b8' } }
        };
    }
    function chartConfig(kind, data, scales, title, legend) {
        var c = {
            type: kind,
            data: data,
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                animation: { duration: 250 },
                plugins: {
                    legend: { display: legend !== false, labels: { color: '#94a3b8', font: { size: 11 }, boxWidth: 12, padding: 12, usePointStyle: true } },
                    tooltip: {
                        mode: 'index', intersect: false,
                        backgroundColor: '#0b1220', borderColor: 'rgba(56,189,248,0.4)', borderWidth: 1,
                        titleColor: '#94a3b8', bodyColor: '#e2e8f0', padding: 10
                    },
                    title: { display: !!title, text: title || '', color: '#93a4bd', font: { size: 12 } }
                },
                scales: Object.assign(baseScales(), scales || {})
            }
        };
        return c;
    }
    function withAlpha(color, a) {
        var rgb = null, m = /rgba?\(([^)]+)\)/.exec(color);
        if (m) {
            var p = m[1].split(',');
            rgb = [p[0].trim(), p[1].trim(), p[2].trim()];
        } else {
            var h = String(color).replace('#', '');
            if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
            if (h.length >= 6) {
                var n = parseInt(h.slice(0, 6), 16);
                if (!isNaN(n)) rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
            }
        }
        if (!rgb) return 'rgba(56,189,248,' + a + ')';
        return 'rgba(' + rgb.join(',') + ',' + a + ')';
    }
    function applyLoadProfileDefaults() {
        if (!Chart || Chart.__lpLoaded) return;
        Chart.__lpLoaded = true;
        Chart.defaults.font.family = '-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif';
        Chart.defaults.color = '#94a3b8';
        Chart.defaults.borderColor = 'rgba(51,65,85,.4)';
        Chart.defaults.animation = Chart.defaults.animation || {};
    }
    function applyLoadProfileStyle(data, kind) {
        (data.datasets || []).forEach(function (ds) {
            if (kind !== 'line' && ds.type !== 'line') return;
            var reference = !!ds.borderDash;
            if (ds.tension === undefined) ds.tension = 0.25;
            if (ds.pointRadius === undefined) ds.pointRadius = 0;
            if (ds.pointHitRadius === undefined) ds.pointHitRadius = 12;
            if (ds.borderWidth === undefined) ds.borderWidth = 2;
            if (reference) return;
            if (ds.fill === undefined) ds.fill = true;
            var col = typeof ds.borderColor === 'string' ? ds.borderColor : '#38bdf8';
            if (typeof ds.backgroundColor !== 'function') {
                ds.backgroundColor = (function (c) {
                    return function (ctx) {
                        var chart = ctx && ctx.chart, area = chart && chart.chartArea;
                        if (!area) return withAlpha(c, 0.08);
                        var g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                        g.addColorStop(0, withAlpha(c, 0.35));
                        g.addColorStop(1, withAlpha(c, 0.02));
                        return g;
                    };
                })(col);
            }
        });
    }
    function makeChart(id, kind, data, scales, title, legend) {
        if (charts[id]) { charts[id].destroy(); charts[id] = null; }
        var canvas = $(id);
        var fresh = canvas.cloneNode(false);
        canvas.parentNode.insertBefore(fresh, canvas);
        canvas.parentNode.removeChild(canvas);
        applyLoadProfileDefaults();
        applyLoadProfileStyle(data, kind);
        charts[id] = new Chart(fresh, chartConfig(kind, data, scales, title, legend));
        return charts[id];
    }
    function makeLine(id, data, scales, title, legend) {
        return makeChart(id, 'line', data, scales, title, legend);
    }

    // ------------------------------------------------------------------ export
    function exportXlsx() {
        if (!state.data) return;
        var S = effectiveSettings();
        var res = Core.computeSizing(state.data, { settings: S, mode: state.sizingMode });
        var aoa = [
            ['☀️ Solar Sizing Tool — ผลการคำนวณ'],
            ['อัตรา', tariffLabel(S.tariff.mode), 'โหมด', state.sizingMode === 'hybrid' ? 'Hybrid' : 'On-Grid'],
            ['ขนาด (kWp)', 'ผลิต (kWh)', 'ใช้เอง (kWh)', 'เหลือทิ้ง (kWh)', 'ประหยัด/เดือน (฿)', 'ลด (%)', 'คืนทุน (เดือน)', 'Self-CR (%)', 'ลงทุน (฿)']
        ];
        res.rows.forEach(function (r) {
            aoa.push([
                r.sizeKwp, Math.round(r.genKwh), Math.round(r.selfUsedKwh), Math.round(r.wasteKwh),
                Math.round(r.savingsThb * 30 / res.periodDays), +(r.savingsPct.toFixed(1)),
                isFinite(r.paybackMonths) ? Math.round(r.paybackMonths) : 0, +(r.selfConsumptionRatio * 100).toFixed(1),
                Math.round(r.investment)
            ]);
        });
        if (res.recommended) aoa.push(['⭐ ขนาดที่แนะนำ', res.recommended.sizeKwp]);
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = aoa[0].map(function () { return { wch: 16 }; });
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sizing');
        XLSX.writeFile(wb, 'solar-sizing.xlsx');
        toast('ส่งออก Excel สำเร็จ');
    }
    function exportCsv() {
        if (!state.data) return;
        var S = effectiveSettings();
        var res = Core.computeSizing(state.data, { settings: S, mode: state.sizingMode });
        var lines = ['ขนาด kWp,ผลิต kWh,ใช้เอง kWh,เหลือทิ้ง kWh,ประหยัด/เดือน ฿,ลด %,คืนทุน เดือน,Self-CR %,ลงทุน ฿'];
        res.rows.forEach(function (r) {
            lines.push([r.sizeKwp, r.genKwh.toFixed(1), r.selfUsedKwh.toFixed(1), r.wasteKwh.toFixed(1),
                (r.savingsThb * 30 / res.periodDays).toFixed(0), r.savingsPct.toFixed(1),
                isFinite(r.paybackMonths) ? r.paybackMonths.toFixed(0) : '', (r.selfConsumptionRatio * 100).toFixed(1),
                r.investment.toFixed(0)].join(','));
        });
        download('solar-sizing.csv', '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
        toast('ส่งออก CSV สำเร็จ');
    }
    function download(name, content, type) {
        var blob = new Blob([content], { type: type || 'application/octet-stream' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }

    // ---------------------------------------------------------------- settings modal
    function openSettings() {
        var s = state.settings, t = s.tariff;
        $('set-tariff-mode').value = state.tariffMode;
        $('set-on-rate').value = t.onPeakRate;
        $('set-off-rate').value = t.offPeakRate;
        $('set-flat-rate').value = t.flatRate;
        $('set-service').value = t.serviceFee;
        $('set-ft').value = t.ftRate;
        $('set-vat').value = t.vatRate * 100;
        $('set-solar-price').value = s.solar.pricePerKwp;
        $('set-loss').value = s.solar.systemLosses * 100;
        $('set-batt-price').value = s.battery.pricePerKwh;
        var tiers = t.progTiers || [];
        var ids = ['set-prog-1', 'set-prog-2', 'set-prog-3', 'set-prog-4', 'set-prog-5'];
        for (var i = 0; i < ids.length; i++) {
            $(ids[i]).value = tiers[i] ? tiers[i][1] : '';
        }
        $('set-prog-service').value = t.progServiceFee;
        showTariffFields(state.tariffMode);
        $('modal').hidden = false;
    }
    function showTariffFields(mode) {
        var isTou = mode === 'auto' || mode === 'tou';
        $('set-tou-rate').style.display = isTou ? '' : 'none';
        $('set-prog-rate').style.display = mode === 'progressive' ? '' : 'none';
        $('set-flat-rate').parentNode.querySelector('label').style.display = mode === 'flat' ? '' : 'none';
        var flatInput = $('set-flat-rate');
        flatInput.style.display = mode === 'flat' ? '' : 'none';
    }
    function saveSettingsUi() {
        var s = state.settings;
        state.tariffMode = $('set-tariff-mode').value;
        s.tariff.onPeakRate = parseFloat($('set-on-rate').value) || 0;
        s.tariff.offPeakRate = parseFloat($('set-off-rate').value) || 0;
        s.tariff.flatRate = parseFloat($('set-flat-rate').value) || 0;
        s.tariff.serviceFee = parseFloat($('set-service').value) || 0;
        s.tariff.ftRate = parseFloat($('set-ft').value) || 0;
        s.tariff.vatRate = (parseFloat($('set-vat').value) || 0) / 100;
        var tiers = [[15, parseFloat($('set-prog-1').value) || 0],
            [25, parseFloat($('set-prog-2').value) || 0],
            [200, parseFloat($('set-prog-3').value) || 0],
            [400, parseFloat($('set-prog-4').value) || 0],
            [null, parseFloat($('set-prog-5').value) || 0]];
        s.tariff.progTiers = tiers;
        s.tariff.progServiceFee = parseFloat($('set-prog-service').value) || 0;
        s.solar.pricePerKwp = parseFloat($('set-solar-price').value) || 40000;
        s.solar.systemLosses = (parseFloat($('set-loss').value) || 25) / 100;
        s.battery.pricePerKwh = parseFloat($('set-batt-price').value) || 9000;
        saveSettings();
        $('modal').hidden = true;
        if (state.data) { renderAnalysis(); renderSizing(); renderSavings(); }
        toast('บันทึกการตั้งค่าแล้ว');
    }
    function backup() {
        download('solar-settings-' + new Date().toISOString().slice(0, 10) + '.json',
            JSON.stringify(JSON.parse(localStorage.getItem('pso_settings_v2') || '{}'), null, 2),
            'application/json');
        toast('สำรองข้อมูลเสร็จ (ดาวน์โหลดแล้ว)');
    }
    function restore(input) {
        var f = input.files[0];
        if (!f) return;
        var fr = new FileReader();
        fr.onload = function () {
            try {
                var o = JSON.parse(fr.result);
                if (!o || typeof o !== 'object' || !o.tariff) throw new Error('bad');
                var s = loadSettings();
                Object.assign(s.tariff, o.tariff);
                if (o.solar) Object.assign(s.solar, o.solar);
                if (o.battery) Object.assign(s.battery, o.battery);
                s.monthOverride = o.monthOverride === undefined ? null : o.monthOverride;
                state.settings = s;
                state.tariffMode = o.tariffMode || state.tariffMode;
                saveSettings();
                toast('กู้คืนข้อมูลเรียบร้อย (ผสานกับค่าเดิม ไม่ทับ)');
                if (state.data) { renderAnalysis(); renderSizing(); renderSavings(); }
            } catch (e) {
                toast('ไฟล์กู้คืนไม่ถูกต้อง — ไม่มีการเปลี่ยนแปลง', true);
            }
        };
        fr.readAsText(f);
        input.value = '';
    }

    // ---------------------------------------------------------------- wiring
    function wire() {
        var tabs = document.querySelectorAll('.tab');
        tabs.forEach(function (b) { b.addEventListener('click', function () { switchTab(b.dataset.tab); }); });

        $('file-input').addEventListener('change', function (e) { readFiles(e.target.files); e.target.value = ''; });

        var dz = $('dropzone');
        ['dragover', 'dragenter'].forEach(function (ev) {
            dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
            dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
        });
        dz.addEventListener('drop', function (e) { readFiles(e.dataTransfer.files); });

        document.querySelectorAll('#sizing-mode .opt').forEach(function (b) {
            b.addEventListener('click', function () {
                state.sizingMode = b.dataset.mode;
                renderSizing();
            });
        });
        $('sizing-battery').addEventListener('input', function (e) {
            state.sizingBattery = parseInt(e.target.value, 10);
            $('sizing-battery-val').textContent = state.sizingBattery + ' kWh';
            renderSizing();
        });
        $('sizing-month').addEventListener('change', function (e) {
            state.settings.monthOverride = e.target.value ? parseInt(e.target.value, 10) : null;
            saveSettings();
            renderSizing();
            renderAnalysis();
        });
        $('btn-batt-recommend').addEventListener('click', runBattRecommend);

        document.querySelectorAll('#sav-mode .opt').forEach(function (b) {
            b.addEventListener('click', function () {
                state.savMode = b.dataset.mode;
                renderSavings();
            });
        });
        $('sav-size').addEventListener('input', function (e) {
            state.savSize = parseInt(e.target.value, 10);
            $('sav-size-val').textContent = state.savSize + ' kWp';
            renderSavings();
        });
        $('sav-battery').addEventListener('input', function (e) {
            state.savBattery = parseInt(e.target.value, 10);
            $('sav-battery-val').textContent = state.savBattery + ' kWh';
            renderSavings();
        });

        $('btn-export-xlsx').addEventListener('click', exportXlsx);
        $('btn-export-csv').addEventListener('click', exportCsv);

        $('btn-settings').addEventListener('click', openSettings);
        $('btn-close-settings').addEventListener('click', function () { $('modal').hidden = true; });
        $('set-tariff-mode').addEventListener('change', function () {
            state.tariffMode = this.value;
            showTariffFields(this.value);
            if (state.data) { renderAnalysis(); renderSizing(); renderSavings(); }
        });
        $('btn-save-settings').addEventListener('click', saveSettingsUi);
        $('btn-backup').addEventListener('click', backup);
        $('btn-restore').addEventListener('click', function () { $('restore-input').click(); });
        $('restore-input').addEventListener('change', function (e) { restore(e.target); });
        $('modal').addEventListener('click', function (e) { if (e.target === this) $('modal').hidden = true; });

        switchTab('data');
    }

    state.settings = loadSettings();
    document.addEventListener('DOMContentLoaded', wire);
})();