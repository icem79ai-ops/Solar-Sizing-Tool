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
        tariffPreset: 'auto',
        sizingMode: 'ongrid',
        savMode: 'ongrid',
        sizingSize: 5,
        sizingBattery: 10,
        savSize: 5,
        savBattery: 10,
        sizingReservePct: 0,
        savReservePct: 0,
        workDaysPerWeek: 7,
        lastBattRec: null,
        lastRecommended: null,
        lastPeriod: null
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
    // ชื่ออัตราที่ใช้จริงของ tariff หนึ่งชุด (preset ที่เลือก หรือ 'กำหนดเอง')
    function tariffText(t) {
        if (t.preset && DrawCalc.TARIFFS[t.preset]) return DrawCalc.TARIFFS[t.preset].label;
        var p = null;
        if (t.mode === 'progressive') return 'อัตราก้าวหน้า (กำหนดเอง)';
        if (t.mode === 'flat') return 'Flat (กำหนดเอง)';
        return 'TOU (กำหนดเอง)';
    }
    function tariffDetail(t) {
        if (t.mode === 'progressive') {
            var tiers = (t.progTiers || []).map(function (r) { return r[1].toFixed(4); }).join(' → ');
            return tiers + ' · ค่าบริการ ' + t.progServiceFee;
        }
        if (t.mode === 'flat') return t.flatRate.toFixed(4) + ' บาท/kWh · ค่าบริการ ' + t.serviceFee;
        return 'On ' + t.onPeakRate.toFixed(4) + ' / Off ' + t.offPeakRate.toFixed(4) + ' · ค่าบริการ ' + t.serviceFee;
    }
    // ชุดราคาโซลาร์ที่ใช้จริง (preset จากใบเสนอราคา หรือ ฿/kWp กำหนดเอง)
    function priceText(solar) {
        if (solar.pricePreset && Core.PRICE_PRESETS[solar.pricePreset]) return Core.PRICE_PRESETS[solar.pricePreset].label;
        return 'กำหนดเอง ' + fmtNum(solar.pricePerKwp, 0) + ' ฿/kWp';
    }
    // preset ที่จะใช้จริง: ที่ผู้ใช้เลือก หรือเดาจากช่อง Tariff ในไฟล์
    function resolvePreset() {
        if (state.tariffPreset && DrawCalc.TARIFFS[state.tariffPreset]) return state.tariffPreset;
        var code = state.data && state.data.metadata ? state.data.metadata.tariff : null;
        var g = Core.presetFromTariffCode(code);
        if (g === 'prog3') return 'r112';
        if (g === 'tou') return 'r122';
        return 'r111';
    }
    // แปลงค่าที่บันทึกไว้แบบเก่าให้เป็นรหัสในทะเบียนใหม่
    function migratePreset(k) {
        var map = { tou: 'r122', prog5: 'r111', prog3: 'r112', flat: 'r111', custom: 'r111', auto: 'auto' };
        if (map[k]) return map[k];
        if (k && DrawCalc.TARIFFS[k]) return k;
        return 'auto';
    }

    // -------------------------------------------------------------- settings
    function loadSettings() {
        state.tariffPreset = state.tariffPreset || 'auto';
        state.rateOverrides = {};
        try {
            var raw = localStorage.getItem('pso_settings_v2');
            if (raw) {
                var o = JSON.parse(raw);
                var s = JSON.parse(JSON.stringify(DEFAULTS));
                if (o.tariff) Object.assign(s.tariff, o.tariff);
                if (o.solar) Object.assign(s.solar, o.solar);
                if (o.battery) Object.assign(s.battery, o.battery);
                if (o.location) { s.location = s.location || {}; Object.assign(s.location, o.location); }
                // ถ้าไฟล์เก่ายังใช้ราคาแบตเริ่มต้นเดิม (ยังไม่เคยแก้เอง) ให้ไปใช้ค่าจริงจากใบเสนอราคา 2569
                if (o.battery && o.battery.pricePerKwh === 9000) s.battery.pricePerKwh = DEFAULTS.battery.pricePerKwh;
                s.monthOverride = o.monthOverride === undefined ? null : o.monthOverride;
                state.tariffPreset = migratePreset(o.tariffPreset || o.tariffMode || 'auto');
                state.rateOverrides = o.rateOverrides || {};
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
            tariffPreset: state.tariffPreset,
            rateOverrides: state.rateOverrides || {}
        }));
    }

    function effectiveSettings() {
        var s = JSON.parse(JSON.stringify(state.settings));
        var key = resolvePreset();
        s.tariff = DrawCalc.toCoreTariff(key, s.tariff, ovFor(key));
        s.tariff.preset = key;
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
        renderWorkDaysNote();
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
    function renderTariffSelect(S) {
        var sel = $('ana-tariff');
        if (!sel) return;
        sel.innerHTML = rateSelectHtml(true);
        sel.value = state.tariffPreset || 'auto';
        var code = state.data && state.data.metadata ? state.data.metadata.tariff : null;
        var txt = 'ใช้จริง: ' + tariffText(S.tariff) + ' · ' + tariffDetail(S.tariff);
        if (state.tariffPreset === 'auto') {
            txt += code ? ' — ตรวจจากไฟล์: Tariff ' + code : ' — ไฟล์ไม่มีช่อง Tariff จึงใช้ 1.1.1 เป็นค่าเริ่มต้น';
        }
        $('ana-tariff-detail').textContent = txt;
    }

    function renderAnalysis() {
        if (!state.data) return;
        var d = state.data;
        var S = effectiveSettings();
        var basis = basisDesc(d);
        var wd = state.workDaysPerWeek || 7;
        var nDaysEff = Core.referencePeriod(d.nDays) * 7 / wd;
        var ana = Core.analyzeData(d, S.tariff, nDaysEff);
        var bill = ana.bill.grandTotal;
        var monthlyBill = ana.bill.monthlyGrandTotal !== undefined ? ana.bill.monthlyGrandTotal
            : bill * 30 / nDaysEff;

        renderTariffSelect(S);

        var prop = Core.pshForMonth(selectedMonth(), S);
        $('bill-metrics').innerHTML =
            metric('ค่าไฟ (ระยะ ' + basis.period + ' วัน)', money(bill), tariffText(S.tariff)) +
            metric('ค่าไฟ/เดือน (โดยประมาณ)', money(monthlyBill), basis.perDay ? '×30' : '×30/' + d.nDays) +
            metric('พลังงาน/เดือน', fmtNum(d.totalKwh * 30 / nDaysEff, 0) + ' kWh', 'PSH เดือนนี้ ≈ ' + prop);
        $('bill-caption').textContent = '⚖️ คำนวณด้วย: ' + tariffText(S.tariff) + ' — ' + basis.note +
            (S.tariff.mode === 'progressive' ? ' | ขั้นอัตราคิดบนหน่วยต่อเดือน แล้วเทียบกลับเป็นระยะไฟล์' : '') +
            ' · 🗓️ เดือน = ×' + monthFactor().toFixed(2) + ' (เปิด ' + wd + ' วัน/สัปดาห์)';

        var mode = S.tariff.mode;
        var head = '';
        if (mode === 'progressive' || mode === 'flat') {
            head = '<div>พลังงานรวม <b>' + fmtNum(ana.bill.totalKwh, 1) + ' kWh</b>' +
                (ana.bill.monthlyTotalKwh ? ' — ต่อเดือน ≈ ' + fmtNum(ana.bill.monthlyTotalKwh, 0) + ' kWh' : '') + '</div>' +
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
    // ตั้งค่า UI ช่องสำรองไฟดับ: ค่าสำเร็จรูปโชว์ใน select, ค่าอื่นโชว์ช่องกรอกเอง
    function setReserveUi(selId, inpId, pct) {
        var sel = $(selId), inp = $(inpId);
        if (!sel || !inp) return;
        var isPreset = pct === 0 || (pct > 0 && pct <= 80 && pct % 10 === 0);
        if (isPreset) {
            sel.value = String(pct);
            inp.hidden = true;
        } else {
            sel.value = 'custom';
            inp.hidden = false;
            inp.value = pct;
        }
    }

    // ตัวคูณ "ระยะไฟล์ → เดือน": 30 × (วันเปิด/7) ÷ จำนวนวันข้อมูลในไฟล์
    function monthFactor() {
        var wd = state.workDaysPerWeek || 7;
        var n = state.data ? Core.referencePeriod(state.data.nDays) : 30;
        return 30 * (wd / 7) / n;
    }
    function renderWorkDaysNote() {
        var el = $('work-days-note');
        if (!el) return;
        if (!state.data) { el.textContent = 'โหลดไฟล์ก่อนเพื่อดูผลของการตั้งค่านี้'; return; }
        var wd = state.workDaysPerWeek || 7;
        var mf = monthFactor();
        el.textContent = 'ไฟล์นี้มีข้อมูล ' + state.data.nDays + ' วัน (วันที่มีการใช้ไฟจริง) · ตัวคูณเป็นเดือน = ×' + mf.toFixed(2) +
            (wd === 7 ? ' (เปิดทุกวัน — ขยายตามจำนวนวันข้อมูล)' : ' (เปิด ' + wd + ' วัน/สัปดาห์ — เดือนทั่วไปมี ~' + Math.round(30 * wd / 7 * 10) / 10 + ' วันเปิด)') +
            ' · ตัวเลข "ประหยัด/เดือน" ทุกแท็บใช้ตัวคูณนี้';
    }

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
        $('sizing-size').value = state.sizingSize;
        $('sizing-size-val').textContent = state.sizingSize + ' kWp';
        $('sizing-battery').value = state.sizingBattery;
        $('sizing-battery-val').textContent = state.sizingBattery + ' kWh';
        setReserveUi('sizing-reserve', 'sizing-reserve-custom', state.sizingReservePct || 0);
    }

    function renderSizing() {
        if (!state.data) return;
        syncSizingControls();
        var d = state.data;
        var S = effectiveSettings();
        var basis = basisDesc(d);
        var opts = {
            settings: S, mode: state.sizingMode, workDaysPerWeek: state.workDaysPerWeek || 7,
            battery: state.sizingMode === 'hybrid' ? {
                capacityKwh: state.sizingBattery, dod: 0.8, efficiency: 0.9, initialSoc: 0, reserveFrac: (state.sizingReservePct || 0) / 100
            } : undefined
        };
        var res = Core.computeSizing(d, opts);
        var period = res.periodDays;

        $('basis-caption').textContent = '⚖️ คำนวณด้วย: ' + tariffText(S.tariff) + ' — ' + basis.note +
            ' | ผลิตต่อวันต่อ kWp = ' + (res.psh * (1 - res.systemLosses)).toFixed(2) + ' kWh' +
            ' | 💰 ราคา: ' + priceText(S.solar) +
            ' | 🗓️ เดือน = ×' + monthFactor().toFixed(2) + ' (เปิด ' + (state.workDaysPerWeek || 7) + ' วัน/สัปดาห์)';

        renderRec(res, S);
        renderBattStatus(res, S);
        
        // ตั้ง max ของ sizing-size ตามข้อมูล
        var maxSize = Math.max(30, (res.recommended ? res.recommended.sizeKwp : 10) * 1.5);
        $('sizing-size').max = maxSize.toFixed(1);
        
        // เก็บค่า recommended ไว้สำหรับ updateSizingTable
        state.lastRecommended = res.recommended;
        state.lastPeriod = res.periodDays;
        
        updateSizingTable();
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
        var saveMonthly = r ? r.savingsThb * monthFactor() : 0;
        var base = document.getElementById('rec-metrics');
        if (!r) { base.innerHTML = '<div class="metric"><div class="k">ไม่พบขนาดที่เหมาะสม</div></div>'; return; }
        base.innerHTML =
            metric('🏆 ขนาดแนะนำ', fmtNum(r.sizeKwp, r.sizeKwp % 1 ? 1 : 0) + ' kWp', 'ขนาดที่คุ้มสุดตามเกณฑ์ ROI') +
            metric('ประหยัด', money(saveMonthly) + '/เดือน', 'ประหยัด ' + pct(r.savingsPct)) +
            metric('คืนทุน', years(r.paybackMonths), 'ลงทุน ' + money(r.investment)) +
            metric('ใช้ไฟจากโซลาร์เอง', pct(r.selfConsumptionRatio * 100), 'เหลือทิ้ง ~' + fmtNum(r.wasteKwh / p, 1) + ' kWh/วัน');
        base.querySelector('.metric').classList.add('hl');
    }

    // กล่องวินิจฉัยสถานะแบต (โหมด Hybrid) — ใช้แถวขนาดแนะนำของระยะอ้างอิง
    function renderBattStatus(res, S) {
        var box = $('batt-status-box');
        if (state.sizingMode !== 'hybrid' || !res.recommended) { box.hidden = true; return; }
        var r = res.recommended, p = res.periodDays;
        var cap = state.sizingBattery, usable = cap * 0.8;
        var ch = r.batteryChargeKwh / p;      // kWh/วัน
        var dis = r.batteryDischargeKwh / p;  // kWh/วัน
        var soc = Math.round((r.batterySocMax || 0) * 100);
        var resPct = state.sizingReservePct || 0;
        var reserveKwh = cap * resPct / 100;
        var cycleUsable = Math.max(0, usable - reserveKwh);
        var head = (resPct > 0)
            ? '<b>🔋 สถานะแบต ' + cap + ' kWh — 🛡️ สำรองไฟดับ ' + fmtNum(reserveKwh, 1) + ' kWh (' + resPct + '% ~จ่ายโหลดสำรอง 1kW ได้ ~' + fmtNum(reserveKwh * 0.9, 1) + ' ชม.) · วนใช้ ' + fmtNum(cycleUsable, 1) + ' kWh</b>'
            : '<b>🔋 สถานะแบต ' + cap + ' kWh (ชาร์จได้จริง ' + fmtNum(usable, 1) + ' kWh @ DoD 80%)</b>';
        var verdict;
        if (ch < 0.05 && dis < 0.05) {
            verdict = '⚠️ <b>ไม่มีพลังงานเหลือเข้าแบตเลย</b> — โซลาร์ ' + fmtNum(r.sizeKwp, 0) +
                ' kWp ผลิตไม่เกินโหลดกลางวันเลย แบตจึงชาร์จไม่ได้ และไม่สร้างประหยัดเพิ่ม (ลงทุนแบต ~' +
                money(cap * S.battery.pricePerKwh) + ' โดยเปล่าประโยชน์) → ถ้าต้องการติดแบต ต้องเพิ่มขนาดโซลาร์ให้ผลิตเกินโหลดก่อน';
        } else if (ch < 0.05 && dis >= 0.05) {
            verdict = '⚠️ แบต<b>ไม่เคยถูกชาร์จ</b> — ไฟที่แบตจ่าย ~' + fmtNum(dis, 1) +
                ' kWh/วัน มาจากไฟค้างชาร์จเริ่มต้น 50% เท่านั้น (ใช้หมดไม่มีเติมเพิ่ม) ระยะยาวแบตไม่ช่วยลดค่าไฟ';
        } else if (r.wasteKwh / p >= 0.5) {
            verdict = '🟡 แบต<b>เต็มก่อนเย็น</b> — ยังเหลือทิ้ง ~' + fmtNum(r.wasteKwh / p, 1) +
                ' kWh/วัน เพราะแบตรับไม่ไหว → ความจุมากขึ้นอาจคุ้ม (ลองกด ✨ แนะนำความจุแบต)';
        } else {
            verdict = '✅ แบตชาร์จ ~' + fmtNum(ch, 1) + ' kWh/วัน · จ่ายให้โหลด ~' + fmtNum(dis, 1) +
                ' kWh/วัน · SoC สูงสุด ' + soc + '%';
        }
        box.hidden = false;
        box.innerHTML = head + '<p>' + verdict + '</p>';
    }

    // ขนาดรอบค่าแนะนำ: 10%-100% โดย recommended ที่ 50% ขั้นละ 10%
    function pctSteps(base, minPct) {
        var out = [];
        for (var k = 0; k <= 9; k++) {
            var v = base * (0.1 + 0.1 * k);  // 0.1 + 0, 0.1 + 0.1, 0.1 + 0.2, ... = 10%, 20%, 30%, ..., 100%
            if (v > 0) out.push(Math.round(v * 100) / 100);
        }
        return out;
    }

    // แถวที่แสดงในตาราง: คำนวณที่ขนาดรอบค่าแนะนำ (แถว 100% = ขนาดแนะนำ)
    function sizingWindow(res) {
        return res.rows;
    }

    // หัวตารางขนาด: โหมด On-Grid 10 คอลัมน์ / Hybrid เพิ่มคอลัมน์แบต 3 คอลัมน์
    var SIZING_COLS_BASE = '<th>ขนาด (kWp)</th><th>ผลิต (kWh)</th><th>ใช้เอง (kWh)</th>' +
        '<th>เหลือทิ้ง/ส่งGrid (kWh รวมระยะ)</th><th>ประหยัด/เดือน</th><th>% ลด</th>' +
        '<th>คืนทุน (ปี)</th><th>ใช้เอง (%)</th><th>ลงทุน</th><th></th>';
    var SIZING_COLS_HYBRID = '<th>ขนาด (kWp)</th><th>ผลิต (kWh)</th><th>ใช้เอง (kWh)</th>' +
        '<th>เหลือทิ้ง (kWh รวมระยะ)</th><th>🔋 ชาร์จ (kWh)</th><th>🔋 จ่ายโหลด (kWh)</th><th>SoC สูงสุด</th>' +
        '<th>ประหยัด/เดือน</th><th>% ลด</th><th>คืนทุน (ปี)</th><th>ใช้เอง (%)</th><th>ลงทุน</th><th></th>';

    function renderSizingTable(res, period, basis) {
        var hybrid = state.sizingMode === 'hybrid';
        $('sizing-table').querySelector('thead tr').innerHTML = hybrid ? SIZING_COLS_HYBRID : SIZING_COLS_BASE;
        var tbody = $('sizing-table').querySelector('tbody');
        tbody.innerHTML = '';

        // Handle null/undefined res or res.rows
        if (!res || !res.rows || res.rows.length === 0) {
            tbody.innerHTML = '<tr><td colspan="' + (hybrid ? 13 : 10) + '">รอการคำนวณ...</td></tr>';
            return;
        }

        var recKwp = res.recommended ? res.recommended.sizeKwp : 0;
        sizingWindow(res).forEach(function (r) {
            var isRec = res.recommended && Math.abs(recKwp - r.sizeKwp) < 0.001;
            var isTrial = Math.abs(r.sizeKwp - state.sizingSize) < 0.001 && !isRec;
            var tr = document.createElement('tr');
            if (isRec) tr.className = 'rec';
            if (isTrial) tr.className = 'trial';
            tr.innerHTML = sizingRowCells(r, monthFactor(), recKwp, isRec, isTrial, hybrid);
            tbody.appendChild(tr);
        });

        // แจ้ง UI ภายนอก (หน้าทดลอง index-v2.html) ให้โชว์ตัวเลขสดของขนาดทดลองได้ทันที
        if (window.CustomEvent) {
            var per = period || 30;
            var tRow = null;
            for (var ri = 0; ri < res.rows.length; ri++) {
                if (Math.abs(res.rows[ri].sizeKwp - state.sizingSize) < 0.001) { tRow = res.rows[ri]; break; }
            }
            window.dispatchEvent(new CustomEvent('sizing:updated', {
                detail: {
                    mode: state.sizingMode, period: per,
                    trial: tRow ? {
                        sizeKwp: tRow.sizeKwp,
                        savingsPerMo: tRow.savingsThb * monthFactor(),
                        paybackMonths: tRow.paybackMonths,
                        investment: tRow.investment,
                        chargePerDay: tRow.batteryChargeKwh / per,
                        dischargePerDay: tRow.batteryDischargeKwh / per,
                        socMaxPct: (tRow.batterySocMax || 0) * 100
                    } : null,
                    rec: res.recommended ? {
                        sizeKwp: res.recommended.sizeKwp,
                        savingsPerMo: res.recommended.savingsThb * monthFactor(),
                        paybackMonths: res.recommended.paybackMonths
                    } : null
                }
            }));
        }
    }

    function updateSizingTable() {
        if (!state.data) return;
        var d = state.data;
        var S = effectiveSettings();
        var period = state.lastPeriod;
        var batOpts = state.sizingMode === 'hybrid' ? {
            capacityKwh: state.sizingBattery, dod: 0.8, efficiency: 0.9, initialSoc: 0, reserveFrac: (state.sizingReservePct || 0) / 100
        } : undefined;

        // คำนวณตาราง โดยเพิ่ม sizing-size เข้าไปในรายการ (โหมดละเอียดทีละ 5 kWp อยู่ในปุ่ม "ดูละเอียดรายขนาด" ที่เปิดหน้าใหม่)
        var sizes = pctSteps(state.lastRecommended ? state.lastRecommended.sizeKwp : 10, 0.5);
        if (state.sizingSize > 0 && !sizes.some(function(s) { return Math.abs(s - state.sizingSize) < 0.001; })) {
            sizes.push(state.sizingSize);
            sizes.sort(function(a, b) { return a - b; });
        }

        var res = Core.computeSizing(d, {
            settings: S, mode: state.sizingMode, sizes: sizes, workDaysPerWeek: state.workDaysPerWeek || 7,
            battery: batOpts
        });

        var tableRes = { rows: res.rows, recommended: state.lastRecommended };
        renderSizingTable(tableRes, period, basisDesc(d));
    }

    // เซลล์ของแถวตารางขนาด (ใช้ร่วมกันทั้งตารางหลักและหน้าละเอียด)
    function sizingRowCells(r, mf, recKwp, isRec, isTrial, hybrid) {
        var mPerMo = r.savingsThb * mf;
        var ofRec = recKwp > 0 ? ' (' + Math.round(r.sizeKwp / recKwp * 100) + '%)' : '';
        var cells =
            '<td>' + fmtNum(r.sizeKwp, r.sizeKwp % 1 ? 1 : 0) + ' kWp' + ofRec + '</td>' +
            '<td>' + fmtNum(r.genKwh, 0) + '</td>' +
            '<td>' + fmtNum(r.selfUsedKwh, 0) + '</td>' +
            '<td>' + fmtNum(r.wasteKwh, 0) + '</td>';
        if (hybrid) {
            cells +=
                '<td>' + fmtNum(r.batteryChargeKwh, 0) + '</td>' +
                '<td>' + fmtNum(r.batteryDischargeKwh, 0) + '</td>' +
                '<td>' + (r.batterySocMax > 0 ? Math.round(r.batterySocMax * 100) + '%' : '—') + '</td>';
        }
        cells +=
            '<td>' + money(mPerMo) + '</td>' +
            '<td>' + pct(r.savingsPct) + '</td>' +
            '<td>' + years(r.paybackMonths) + '</td>' +
            '<td>' + pct(r.selfConsumptionRatio * 100) + '</td>' +
            '<td>' + money(r.investment) + '</td>' +
            '<td>' + (isRec ? '⭐ แนะนำ' : (isTrial ? '🧪 ลอง' : '')) + '</td>';
        return cells;
    }

    // ปุ่ม "ดูละเอียดรายขนาด" → เปิดหน้าใหม่ (modal): ไล่คำนวณทีละ 5 kWp จาก 5 ถึง 2×ขนาดแนะนำ
    // ตารางหลักคงเดิมทุกอย่าง
    function openTableDetail() {
        if (!state.data) { toast('กรุณาโหลดข้อมูลก่อน', true); return; }
        var d = state.data;
        var S = effectiveSettings();
        var period = state.lastPeriod || 30;
        var recKwp = state.lastRecommended ? state.lastRecommended.sizeKwp : 10;
        var top = Math.ceil((recKwp * 2) / 5) * 5;
        var sizes = [];
        for (var v = 5; v <= top; v += 5) sizes.push(v);
        // แถวขนาดแนะนำ (⭐) และขนาดที่ slider ชี้ (🧪) ต้องมีเสมอ แม้ไม่ลงตัว 5
        if (!sizes.some(function (s) { return Math.abs(s - recKwp) < 0.001; })) {
            sizes.push(recKwp);
            sizes.sort(function (a, b) { return a - b; });
        }
        if (state.sizingSize > 0 && !sizes.some(function (s) { return Math.abs(s - state.sizingSize) < 0.001; })) {
            sizes.push(state.sizingSize);
            sizes.sort(function (a, b) { return a - b; });
        }
        var res = Core.computeSizing(d, {
            settings: S, mode: state.sizingMode, sizes: sizes, workDaysPerWeek: state.workDaysPerWeek || 7,
            battery: state.sizingMode === 'hybrid' ? {
                capacityKwh: state.sizingBattery, dod: 0.8, efficiency: 0.9, initialSoc: 0, reserveFrac: (state.sizingReservePct || 0) / 100
            } : undefined
        });
        var hybrid = state.sizingMode === 'hybrid';
        var rowsHtml = '';
        res.rows.forEach(function (r) {
            var isRec = state.lastRecommended && Math.abs(recKwp - r.sizeKwp) < 0.001;
            var isTrial = Math.abs(r.sizeKwp - state.sizingSize) < 0.001 && !isRec;
            rowsHtml += '<tr' + (isRec ? ' class="rec"' : (isTrial ? ' class="trial"' : '')) + '>' +
                sizingRowCells(r, monthFactor(), recKwp, isRec, isTrial, hybrid) + '</tr>';
        });
        $('detail-modal-title').textContent = '📋 ตารางละเอียด — ไล่ทีละ 5 kWp (5 → ' + top + ' kWp = 2×แนะนำ ' +
            fmtNum(recKwp, 0) + ')';
        $('detail-modal-caption').textContent = 'โหมด ' + (hybrid ? 'Hybrid (แบต ' + state.sizingBattery + ' kWh)' : 'On-Grid') +
            ' · ค่า kWh เป็นรวมทั้งระยะ ' + period + ' วัน · ⭐ = ขนาดแนะนำ · 🧪 = ขนาดที่ slider ชี้ · (xx%) = เทียบขนาดแนะนำ';
        $('detail-table-wrap').innerHTML = '<table><thead><tr>' +
            (hybrid ? SIZING_COLS_HYBRID : SIZING_COLS_BASE) + '</tr></thead><tbody>' + rowsHtml + '</tbody></table>';
        $('detail-modal').hidden = false;
    }

    function renderSizingChart(res) {
        var labels = res.rows.map(function (r) { return r.sizeKwp + (r.sizeKwp % 1 ? '' : '') + ''; });
        var monthly = res.rows.map(function (r) { return r.savingsThb * monthFactor(); });
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
        }, 'ประหยัดค่าไฟ และระยะคืนทุน (ประหยัด/เดือน ตามวันเปิดใช้ไฟที่ตั้งไว้)');
    }

    function runBattRecommend() {
        if (!state.data) { toast('กรุณาโหลดข้อมูลก่อน', true); return; }
        if (state.sizingMode !== 'hybrid') { switchTab('sizing'); }
        var d = state.data;
        var S = effectiveSettings();
        // sweep recommended solar size for best pairing
        var sizing = Core.computeSizing(d, { settings: S, mode: 'ongrid' });
        var size = sizing.recommended ? sizing.recommended.sizeKwp : 10;
        var first = Core.recommendBattery(d, size, { settings: S, workDaysPerWeek: state.workDaysPerWeek || 7 });
        // ตารางแบตเตอรี่: ความจุแนะนำอยู่กลาง ขั้น 10% (50%–150%)
        var caps = first.bestCapacityKwh > 0 ? pctSteps(first.bestCapacityKwh, 0.5) : null;
        state.lastBattRec = caps ? Core.recommendBattery(d, size, { settings: S, caps: caps, workDaysPerWeek: state.workDaysPerWeek || 7 }) : first;
        renderBattRec(state.lastBattRec);
        toast('คำนวณแบตแนะนำแล้ว (ขนาดโซลาร์ ' + fmtNum(size, 0) + ' kWp)');
    }

    function renderBattRec(rec) {
        var box = $('batt-recommend-box');
        box.hidden = false;
        // จุดโฟกัสในตาราง/กราฟ: ขนาดแนะนำตามเกณฑ์ หรือ ขนาด "ไม่สนเกณฑ์ 10 ปี" ถ้าไม่ผ่านเกณฑ์
        var bestMark = rec.bestCapacityKwh > 0 ? rec.bestCapacityKwh : (rec.bestAnywayCapacityKwh || 0);
        var dur = rec.candidates;

        var head;
        if (rec.bestCapacityKwh > 0) {
            head = '<b>🔋 แบตเตอรี่ที่แนะนำ: ' + fmtNum(rec.bestCapacityKwh, 0) + ' kWh ' +
                '(+ ~' + money(rec.addonSavingsThb) + ' บาท/เดือน เทียบ On-Grid ขนาดเดียวกัน)</b>' +
                '<p>' + rec.note + '</p>';
        } else {
            // ไม่ผ่านเกณฑ์ — ชี้เหตุผลให้ชัด (เคสไหน พร้อมตัวเลข) แล้วเสนอขนาดดีที่สุดแบบไม่สนเกณฑ์ 10 ปี
            head = '<b>🔋 ไม่แนะนำให้ติดแบตเตอรี่เพิ่ม</b>' +
                '<p>' + rec.note + '</p>';
            if (rec.bestAnywayCapacityKwh > 0) {
                head += '<p>✅ <b>ถ้าผู้ใช้ไฟยังต้องการติดแบตอยู่ดี (ไม่สนเกณฑ์คืนทุน 10 ปี): แนะนำความจุ ' +
                    fmtNum(rec.bestAnywayCapacityKwh, 0) + ' kWh</b> — เพิ่มประหยัด ~' + money(rec.bestAnywayAddonThb) +
                    ' บาท/เดือน · คืนทุนเฉพาะแบต ' + years(rec.bestAnywayPaybackMonths) + ' (ช้ากว่าเกณฑ์ 10 ปี — ติดเพื่อความต้องการ เช่น สำรองไฟดับ)</p>';
            } else {
                head += '<p>ไม่มีความจุใดให้ประโยชน์ถึง 50 ฿/เดือนเลย — ถ้ายังต้องการแบตเพื่อสำรองไฟดับ ให้พิจารณาจากโหลดสำรองที่ต้องการใช้โดยตรง ไม่ใช่เหตุผลความคุ้มทุน</p>';
            }
        }

        var rows = dur.map(function (c) {
            var of = bestMark > 0 ? Math.round(c.capacityKwh / bestMark * 100) : 0;
            var cls = Math.abs(c.capacityKwh - bestMark) < 0.001 ? ' class="rec"' : '';
            return '<tr' + cls + '><td>' + fmtNum(c.capacityKwh, 1) + ' kWh (' + of + '%)</td><td>' + money(c.addonThb) + '</td><td>' +
                years(c.batteryPaybackMonths) + '</td><td>' + fmtNum(c.wasteKwh, 0) + ' kWh</td></tr>';
        }).join('');
        box.innerHTML = head +
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
                    return ctx.dataIndex === rec.candidates.findIndex(function (c) { return c.capacityKwh === bestMark; }) ? 6 : 2;
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
        setReserveUi('sav-reserve', 'sav-reserve-custom', state.savReservePct || 0);
    }

    function renderSavings() {
        if (!state.data) return;
        syncSavingsControls();
        var d = state.data;
        var S = effectiveSettings();
        var basis = basisDesc(d);
        var scen = Core.simulateScenario(d, state.savSize, {
            settings: S, mode: state.savMode, workDaysPerWeek: state.workDaysPerWeek || 7,
            battery: state.savMode === 'hybrid' ? {
                capacityKwh: state.savBattery, dod: 0.8, efficiency: 0.9, initialSoc: 0, reserveFrac: (state.savReservePct || 0) / 100
            } : undefined
        });

        var bb = scen.billBefore.grandTotal, ba = scen.billAfter.grandTotal, sv = scen.savings;
        var perDay = sv / scen.periodDays;
        var perMonth = sv * monthFactor();
        var sMonthly = scen.billBefore.grandTotal * monthFactor();

        $('save-metrics').innerHTML =
            metric('💰 ค่าไฟเดิม', money(scen.periodDays === 30 && d.nDays <= 1 ? bb : bb), basis.perDay ? 'ระยะ 30 วัน' : 'ระยะ ' + scen.periodDays + ' วัน') +
            metric('🟢 ค่าไฟหลังติดตั้ง', money(ba), 'ประหยัด ' + pct(scen.savings / Math.max(bb, 1) * 100)) +
            metric('⚡ ประหยัด/วัน', money(perDay), basis.perDay ? 'ตัวเลขจริงจากข้อมูล 1 วัน' : 'เฉลี่ยต่อวัน') +
            metric('💹 ประหยัดได้/เดือน (×30)', money(perMonth), pct(sv / Math.max(bb, 1) * 100) + ' ของบิลเดิม');
        if (state.savMode === 'hybrid') {
            $('save-metrics').innerHTML +=
                metric('🔋 แบตชาร์จ', fmtNum(scen.batteryChargeKwh / scen.periodDays, 1) + ' kWh/วัน',
                    'รวมระยะ ' + scen.periodDays + ' วัน = ' + fmtNum(scen.batteryChargeKwh, 0) + ' kWh') +
                metric('🔋 แบตจ่ายโหลด', fmtNum(scen.batteryDischargeKwh / scen.periodDays, 1) + ' kWh/วัน',
                    'ดูรูปแบบชาร์จ-คายในกราฟด้านล่าง');
        }
        $('waste-caption').textContent = '☀️ โซลาร์ผลิต ' + fmtNum(scen.genKwh, 0) + ' kWh · ใช้เอง ' + fmtNum(scen.selfUsedKwh, 0) +
            ' kWh · เหลือทิ้ง/ส่งGrid ' + fmtNum(scen.wasteKwh, 0) + ' kWh — รวมทั้งระยะ ' + scen.periodDays + ' วัน (เฉลี่ย ~' +
            fmtNum(scen.wasteKwh / scen.periodDays, 1) + ' kWh/วัน ไม่ใช่ต่อวัน) (ย้ำ: โมเดลไม่คิดรายได้จากการขายไฟ) · คืนทุน ≈ ' + years(paybackOf(scen, S)) + (state.savMode === 'hybrid' && state.savReservePct > 0 ? ' · 🛡️ สำรองไฟดับ ' + fmtNum(state.savBattery * state.savReservePct / 100, 1) + ' kWh (เก็บนิ่ง ไม่เข้าการคำนวณ)' : '');

        $('save-basis-caption').textContent = '⚖️ คำนวณด้วย: ' + tariffText(S.tariff) + ' — ' + basis.note +
            ' | 💰 ราคา: ' + priceText(S.solar) +
            ' | 🗓️ เดือน = ×' + monthFactor().toFixed(2) + ' (เปิด ' + (state.workDaysPerWeek || 7) + ' วัน/สัปดาห์)';

        renderDailyChart(scen, basis);

        $('soc-card').style.display = state.savMode === 'hybrid' ? '' : 'none';
        if (state.savMode === 'hybrid') {
            makeLine('soc-chart', {
                labels: timeLabels(),
                datasets: [
                    { label: 'SoC (% ของช่วงใช้งาน DoD 80%)', data: Array.from(scen.daily.soc).map(function (v) { return v * 100; }),
                      borderColor: '#b06bff', backgroundColor: 'rgba(176,107,255,.12)',
                      fill: true, tension: .3, pointRadius: 0, borderWidth: 2 },
                    { label: 'ช่วงใช้งานเต็ม (100%)', data: Array(96).fill(100), borderColor: 'rgba(53,208,127,.4)',
                      borderDash: [6, 6], pointRadius: 0 },
                    { label: 'พื้นล่างตาม DoD (0%)', data: Array(96).fill(0), borderColor: 'rgba(255,95,109,.4)',
                      borderDash: [6, 6], pointRadius: 0 }
                ]
            }, {
                y: { min: 0, max: 100, title: { display: true, text: '%' } }
            }, 'สถานะการชาร์จแบตเตอรี่ (SoC) ราย 15 นาที', false);
        }
    }

    function paybackOf(scen, S) {
        if (scen.savings <= 0) return Infinity;
        var invest = Core.solarCost(scen.solarSizeKwp, S.solar) +
            (state.savMode === 'hybrid' ? scen.batteryKwh * S.battery.pricePerKwh : 0);
        return invest / (scen.savings * 30 / scen.periodDays);
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
            ['อัตรา', tariffText(S.tariff), 'โหมด', state.sizingMode === 'hybrid' ? 'Hybrid' : 'On-Grid'],
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
    function renderProgTiers(tiers) {
        var box = $('set-prog-tiers');
        var rows = tiers && tiers.length ? tiers : Core.TARIFF_PRESETS.prog5.progTiers;
        var html = '';
        var lo = 0;
        for (var i = 0; i < rows.length; i++) {
            var hi = rows[i][0];
            var label = lo === 0
                ? 'ขั้น ' + (i + 1) + ' (0–' + hi + ' kWh)'
                : (hi === null ? 'ขั้น ' + (i + 1) + ' (มากกว่า ' + lo + ' kWh)'
                    : 'ขั้น ' + (i + 1) + ' (' + lo + '–' + hi + ' kWh)');
            html += '<div><label class="lbl sm">' + label + '</label>' +
                '<input type="number" step="0.0001" data-tier="' + i + '" data-bound="' + (hi === null ? '' : hi) + '" value="' + rows[i][1] + '"></div>';
            lo = hi;
        }
        box.innerHTML = html;
    }
    function readProgTiers() {
        var out = [];
        var inputs = $('set-prog-tiers').querySelectorAll('input[data-tier]');
        for (var i = 0; i < inputs.length; i++) {
            var v = parseFloat(inputs[i].value);
            var b = inputs[i].getAttribute('data-bound');
            out.push([b === '' || b === null ? null : parseFloat(b), isNaN(v) ? 0 : v]);
        }
        return out;
    }
    // ---------------------------------------------------- อัตราค่าไฟ (ทะเบียนเดียว)
    function ovFor(key) { return (state.rateOverrides || {})[key]; }
    function billOpts(key) {
        return { ov: ovFor(key), ftRate: state.settings.tariff.ftRate, vatRate: state.settings.tariff.vatRate };
    }
    function rateOptionHtml(k) { return '<option value="' + k + '">' + DrawCalc.TARIFFS[k].label + '</option>'; }
    function rateSelectHtml(withAuto) {
        return (withAuto ? '<option value="auto">ตรวจจากไฟล์ (อัตโนมัติ)</option>' : '') +
            '<optgroup label="บ้านอยู่อาศัย">' + ['r111', 'r112', 'r121', 'r122'].map(rateOptionHtml).join('') + '</optgroup>' +
            '<optgroup label="กิจการขนาดกลาง ไม่เกิน 33 kV (มีค่าดีมานด์)">' + ['d31', 'd31s', 'd32', 'd32s'].map(rateOptionHtml).join('') + '</optgroup>';
    }
    function num(id) { var v = parseFloat($(id).value); return isNaN(v) ? 0 : v; }
    // รายละเอียดชุดราคาโซลาร์ (จุดราคาจากใบเสนอราคา)
    function solarPresetDetail(key) {
        var p = Core.PRICE_PRESETS[key];
        return p.curve.map(function (pt) { return pt[0] + ' kWp = ' + Core.fmtMoney(pt[1]) + ' ฿'; }).join(' · ') +
            ' (นอกช่วง: ต่อเนื่องเชิงเส้นตามความชันปลาย)';
    }
    function fillSolarPriceUi() {
        var key = $('set-solar-preset').value;
        var isCustom = key === 'custom';
        $('set-solar-price').disabled = !isCustom;
        if (isCustom) $('set-solar-price').value = state.settings.solar.pricePerKwp;
        $('set-solar-preset-detail').textContent = isCustom
            ? 'ใช้ราคา ฿/kWp เดียวตามช่องด้านล่าง'
            : solarPresetDetail(key);
    }
    function openSettings() {
        var s = state.settings;
        $('set-tariff-preset').innerHTML = rateSelectHtml(true);
        $('set-tariff-preset').value = state.tariffPreset || 'auto';
        var key = (!state.tariffPreset || state.tariffPreset === 'auto') ? resolvePreset() : state.tariffPreset;
        fillRateFields(key);
        $('set-ft').value = s.tariff.ftRate;
        $('set-vat').value = s.tariff.vatRate * 100;
        $('set-solar-preset').innerHTML = ['custom'].concat(Core.SOLAR_PRESET_ORDER).map(function (k) {
            return '<option value="' + k + '">' +
                (k === 'custom' ? 'กำหนดเอง (฿/kWp เดียว)' : Core.PRICE_PRESETS[k].label) + '</option>';
        }).join('');
        $('set-solar-preset').value = s.solar.pricePreset || 'custom';
        fillSolarPriceUi();
        $('set-loss').value = s.solar.systemLosses * 100;
        $('set-cap').value = s.solar.capMultiple || 1;
        $('set-batt-price').value = s.battery.pricePerKwh;
        $('modal').hidden = false;
    }
    // เติมช่องพารามิเตอร์ของอัตราที่เลือก (ค่าประกาศ + ค่าที่ผู้ใช้เคยแก้)
    function fillRateFields(key) {
        var reg = DrawCalc.TARIFFS[key];
        var r = DrawCalc.applyOverrides(reg, ovFor(key));
        $('set-preset-detail').textContent = reg.label +
            (reg.group === 'business' ? ' — มีค่าดีมานด์' : ' — บ้านอยู่อาศัย ไม่มีค่าดีมานด์');
        $('set-on-rate').value = r.peakRate !== undefined ? r.peakRate : '';
        $('set-off-rate').value = r.offRate !== undefined ? r.offRate : '';
        $('set-flat-rate').value = r.energyRate !== undefined ? r.energyRate : '';
        $('set-service').value = r.serviceFee;
        $('set-demand-rate').value = r.demandRate !== undefined ? r.demandRate : '';
        renderProgTiers(reg.kind === 'progressive' ? r.tiers : null);
        $('set-tou-rate').style.display = reg.kind === 'tou' ? '' : 'none';
        $('set-prog-rate').style.display = reg.kind === 'progressive' ? '' : 'none';
        $('set-flat-wrap').style.display = reg.kind === 'normal' ? '' : 'none';
        $('set-demand-wrap').style.display = reg.demandRate !== undefined ? '' : 'none';
    }
    function saveSettingsUi() {
        var s = state.settings;
        var key = $('set-tariff-preset').value;
        state.tariffPreset = key;
        if (key !== 'auto') {
            var reg = DrawCalc.TARIFFS[key];
            var ov = { serviceFee: num('set-service') };
            if (reg.kind === 'tou') { ov.peakRate = num('set-on-rate'); ov.offRate = num('set-off-rate'); }
            if (reg.kind === 'normal') ov.energyRate = num('set-flat-rate');
            if (reg.kind === 'progressive') ov.tierRates = readProgTiers().map(function (r) { return r[1]; });
            if (reg.demandRate !== undefined) ov.demandRate = num('set-demand-rate');
            state.rateOverrides = state.rateOverrides || {};
            state.rateOverrides[key] = ov;
        }
        s.tariff.ftRate = num('set-ft');
        s.tariff.vatRate = num('set-vat') / 100;
        s.solar.pricePreset = $('set-solar-preset').value;
        if (s.solar.pricePreset === 'custom') s.solar.pricePerKwp = num('set-solar-price') || 40000;
        s.solar.systemLosses = (num('set-loss') || 25) / 100;
        s.solar.capMultiple = num('set-cap') > 0 ? num('set-cap') : 1;
        s.battery.pricePerKwh = num('set-batt-price') || 9000;
        saveSettings();
        $('modal').hidden = true;
        syncHomeRate();
        if (drawMonths) renderBill();
        if (state.data) { renderAnalysis(); renderSizing(); renderSavings(); }
        toast('บันทึกการตั้งค่าแล้ว · ' + DrawCalc.TARIFFS[resolvePreset()].label);
    }
    function syncHomeRate() {
        var sel = $('draw-rate');
        if (sel && sel.options.length) sel.value = resolvePreset();
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
                state.tariffPreset = migratePreset(o.tariffPreset || o.tariffMode || state.tariffPreset || 'auto');
                if (o.rateOverrides) state.rateOverrides = Object.assign({}, state.rateOverrides || {}, o.rateOverrides);
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
    // ---------------------------------------------------- โหลดที่วาดเอง
    var DRAW_MONTH_DEFAULT = 11;
    var MONTH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    var BILL_COLORS = ['#ff9f43', '#54a0ff', '#1dd1a1', '#ee5253', '#a55eea', '#8395a7'];
    var drawPad = null;
    var drawMonths = null;                 // 12 โปรไฟล์ (ละ 96 ช่วง)
    var drawCur = DRAW_MONTH_DEFAULT - 1;  // เดือนที่กำลังแก้ (0–11)
    var drawSame = true;                   // true = ทุกเดือนเหมือนกัน

    function rateOption(k) {
        return '<option value="' + k + '">' + DrawCalc.TARIFFS[k].label + '</option>';
    }

    function openDrawPad() {
        var area = $('draw-area');
        var willOpen = area.hidden;
        area.hidden = !willOpen;
        if (!willOpen || drawPad) return;
        if (!drawMonths) {
            drawMonths = [];
            for (var m = 0; m < 12; m++) drawMonths.push(DrawCalc.hourlyToSlots(Array(24).fill(0.5)));
        }
        $('draw-rate').innerHTML =
            '<optgroup label="บ้านอยู่อาศัย (ไม่มีค่าดีมานด์)">' + ['r111', 'r112', 'r121', 'r122'].map(rateOption).join('') + '</optgroup>' +
            '<optgroup label="กิจการขนาดกลาง ไม่เกิน 33 kV (มีค่าดีมานด์)">' + ['d31', 'd31s', 'd32', 'd32s'].map(rateOption).join('') + '</optgroup>';
        $('draw-rate').value = resolvePreset();
        $('draw-view').value = drawSame ? 'same' : 'per';
        $('draw-month').innerHTML = DrawCalc.THAI_MONTHS.map(function (n, i) {
            return '<option value="' + (i + 1) + '"' + (i + 1 === DRAW_MONTH_DEFAULT ? ' selected' : '') + '>' + n + '</option>';
        }).join('');
        drawPad = DrawPad.mount($('draw-pad'), { initial: drawMonths[drawCur], onChange: onDrawChange });
        buildMonthTabs();
        renderBill();
    }

    // 🔒 โหมดล็อค kWh/เดือน ของหน้าวาดโหลด (มวลคงที่ — ลาก = ดึง/ดันมวล)
    function applyDrawLock() {
        if (!drawPad) return;
        var on = $('draw-lock').checked;
        var v = parseFloat($('draw-lock-kwh').value);
        var st = $('draw-lock-status');
        if (on && v > 0) {
            drawPad.setLock(v);
            if (st) st.textContent = '🔒 เป้า ' + fmtNum(v, 0) + ' kWh/เดือน · มวลคงที่ — ลาก = ดึง/ดันมวล';
        } else {
            drawPad.setLock(null);
            if (st) st.textContent = '';
        }
    }

    function onDrawChange(slots) {
        if (drawSame) {
            for (var m = 0; m < 12; m++) drawMonths[m] = slots.slice();
        } else {
            drawMonths[drawCur] = slots.slice();
        }
        renderBill();
    }

    function buildMonthTabs() {
        var box = $('draw-months');
        box.innerHTML = MONTH_SHORT.map(function (n, i) {
            return '<button type="button" class="opt' + (i === drawCur ? ' active' : '') + '" data-m="' + i + '">' + n + '</button>';
        }).join('');
        Array.prototype.forEach.call(box.querySelectorAll('button'), function (b) {
            b.addEventListener('click', function () { selectMonth(Number(b.dataset.m)); });
        });
    }

    function selectMonth(m) {
        drawCur = m;
        drawPad.load(drawMonths[m]);
        buildMonthTabs();
        renderBill();
    }

    function copyMonthToAll() {
        for (var m = 0; m < 12; m++) drawMonths[m] = drawMonths[drawCur].slice();
        renderBill();
        toast('คัดลอกโปรไฟล์เดือนนี้ไปทุกเดือนแล้ว');
    }

    function changeDrawView() {
        drawSame = $('draw-view').value === 'same';
        if (drawSame) copyMonthToAll();
        drawPad.load(drawMonths[drawCur]);
        renderBill();
    }

    function onHomeRateChange() {
        state.tariffPreset = $('draw-rate').value;
        saveSettings();
        renderBill();
        if (state.data) { renderAnalysis(); renderSizing(); renderSavings(); }
    }

    function renderBill() {
        var box = $('draw-bill');
        if (!box || !drawMonths) return;
        var key = $('draw-rate').value;
        var t = DrawCalc.TARIFFS[key];
        var yr = DrawCalc.annualBills(drawMonths, key, billOpts(key));
        var cur = yr.months[drawCur];
        var total = cur.total;
        var note = t.group === 'business'
            ? '<p class="note">⚠️ อัตรานี้มี <b>ค่าดีมานด์</b> — หน้าวิเคราะห์ ขนาดโซลาร์ และประหยัด ยังไม่รวมค่าดีมานด์</p>'
            : '<p class="note">บ้านอยู่อาศัยไม่มีค่าดีมานด์</p>';
        var bar = cur.items.map(function (x, i) {
            var pct = total > 0 ? x.amount / total * 100 : 0;
            return '<div class="bill-seg" style="width:' + pct.toFixed(2) + '%;background:' +
                BILL_COLORS[i % BILL_COLORS.length] + '" title="' + x.label + ' ' + fmtNum(x.amount, 2) + ' บาท"></div>';
        }).join('');
        var rows = cur.items.map(function (x, i) {
            var pct = total > 0 ? x.amount / total * 100 : 0;
            return '<tr><td><span class="dot" style="background:' + BILL_COLORS[i % BILL_COLORS.length] + '"></span>' +
                x.label + '</td><td class="num">' + fmtNum(x.amount, 2) + '</td><td class="num">' + pct.toFixed(1) + '%</td></tr>';
        }).join('');
        var annual = yr.months.map(function (x, i) {
            return '<tr' + (i === drawCur ? ' class="sel"' : '') + '><td>' + DrawCalc.THAI_MONTHS[i] +
                '</td><td class="num">' + fmtNum(x.monthlyKwh, 0) + '</td><td class="num">' + fmtNum(x.total, 0) + '</td></tr>';
        }).join('');
        box.innerHTML =
            '<h3>ค่าไฟเดือน' + DrawCalc.THAI_MONTHS[drawCur] + ' · ' + t.label + '</h3>' + note +
            '<div class="bill-bar">' + bar + '</div>' +
            '<table class="bill-table"><tr><th>รายการ</th><th>บาท</th><th>สัดส่วน</th></tr>' + rows +
            '<tr class="sum"><td><b>รวม (รวม VAT)</b></td><td class="num"><b>' + fmtNum(total, 2) + '</b></td><td></td></tr></table>' +
            '<h3>รวม 12 เดือน</h3>' +
            '<table class="bill-table"><tr><th>เดือน</th><th>kWh</th><th>ค่าไฟ (บาท)</th></tr>' + annual +
            '<tr class="sum"><td><b>รวมทั้งปี</b></td><td></td><td class="num"><b>' + fmtNum(yr.annualTotal, 0) + '</b></td></tr></table>';
    }

    function useDrawnProfile() {
        if (!drawPad || !drawMonths) return;
        var key = $('draw-rate').value;
        var month = Number($('draw-month').value) || DRAW_MONTH_DEFAULT;
        var avg = DrawCalc.averageSlots(drawMonths);
        var data = DrawCalc.slotsToData(avg, { month: month, year: 2026, nDays: 30 });
        if (!(data.totalKwh > 0)) { toast('ยังไม่มีโหลดในกราฟ — ลากวาดก่อน', true); return; }
        state.tariffPreset = key;
        saveSettings();
        state.data = data;
        $('load-error').hidden = true;
        $('file-info').hidden = false;
        renderFileMeta();
        renderFileSummary();
        renderWorkDaysNote();
        switchTab('analysis');
        toast('ใช้โปรไฟล์ที่วาดแล้ว · ' + DrawCalc.TARIFFS[key].label);
    }

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
        $('sizing-reserve').addEventListener('change', function (e) {
            if (e.target.value === 'custom') {
                $('sizing-reserve-custom').hidden = false;
                $('sizing-reserve-custom').focus();
                return;
            }
            $('sizing-reserve-custom').hidden = true;
            state.sizingReservePct = parseInt(e.target.value, 10) || 0;
            renderSizing();
        });
        $('sizing-reserve-custom').addEventListener('input', function (e) {
            var v = parseFloat(e.target.value);
            if (isNaN(v)) return;
            state.sizingReservePct = Math.min(100, Math.max(0, v));
            clearTimeout(setReserveUi._s);
            setReserveUi._s = setTimeout(renderSizing, 200);
        });
        $('sizing-month').addEventListener('change', function (e) {
            state.settings.monthOverride = e.target.value ? parseInt(e.target.value, 10) : null;
            saveSettings();
            renderSizing();
            renderAnalysis();
        });
        $('btn-batt-recommend').addEventListener('click', runBattRecommend);
        $('btn-table-expand').addEventListener('click', openTableDetail);
        $('btn-close-detail').addEventListener('click', function () { $('detail-modal').hidden = true; });
        $('btn-close-detail-2').addEventListener('click', function () { $('detail-modal').hidden = true; });
        $('detail-modal').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
        $('btn-open-draw').addEventListener('click', openDrawPad);
        $('btn-use-draw').addEventListener('click', useDrawnProfile);
        $('btn-copy-all').addEventListener('click', copyMonthToAll);
        $('draw-rate').addEventListener('change', onHomeRateChange);
        $('draw-view').addEventListener('change', changeDrawView);
        $('draw-lock').addEventListener('change', applyDrawLock);
        $('draw-lock-kwh').addEventListener('input', applyDrawLock);

        $('sizing-size').addEventListener('input', function (e) {
            state.sizingSize = parseFloat(e.target.value);
            $('sizing-size-val').textContent = state.sizingSize + ' kWp';
            // debounce กันคำนวณรกไปทุก ๆ ตำแหน่งที่ลากผ่าน
            clearTimeout(updateSizingTable._t);
            updateSizingTable._t = setTimeout(updateSizingTable, 150);
        });

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
        $('sav-reserve').addEventListener('change', function (e) {
            if (e.target.value === 'custom') {
                $('sav-reserve-custom').hidden = false;
                $('sav-reserve-custom').focus();
                return;
            }
            $('sav-reserve-custom').hidden = true;
            state.savReservePct = parseInt(e.target.value, 10) || 0;
            renderSavings();
        });
        $('sav-reserve-custom').addEventListener('input', function (e) {
            var v = parseFloat(e.target.value);
            if (isNaN(v)) return;
            state.savReservePct = Math.min(100, Math.max(0, v));
            clearTimeout(setReserveUi._v);
            setReserveUi._v = setTimeout(renderSavings, 200);
        });
        $('work-days').addEventListener('change', function (e) {
            state.workDaysPerWeek = parseInt(e.target.value, 10) || 7;
            renderWorkDaysNote();
            if (state.data) { renderAnalysis(); renderSizing(); renderSavings(); }
        });

        $('btn-export-xlsx').addEventListener('click', exportXlsx);
        $('btn-export-csv').addEventListener('click', exportCsv);

        $('btn-settings').addEventListener('click', openSettings);
        $('btn-close-settings').addEventListener('click', function () { $('modal').hidden = true; });
        $('ana-tariff').addEventListener('change', function () {
            state.tariffPreset = this.value;
            if (state.data) { renderAnalysis(); renderSizing(); renderSavings(); }
            saveSettings();
        });
        $('set-tariff-preset').addEventListener('change', function () {
            fillRateFields(this.value === 'auto' ? resolvePreset() : this.value);
        });
        $('set-solar-preset').addEventListener('change', fillSolarPriceUi);
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