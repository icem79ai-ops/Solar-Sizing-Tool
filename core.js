/* Solar Sizing Tool — core engine (pure JS, no DOM)
 * Port of solar-sizing-tool Python modules:
 *   solar_model, tariff, battery_model, calculator, amr_parser
 * Runs in browser (offline) and in Node for tests.
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
    else { root.Core = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {

    'use strict';

    // ---------------------------------------------------------------- config
    var DEFAULT_PSH_MONTHLY = {
        "1": 6.5, "2": 6.8, "3": 6.5, "4": 5.8, "5": 5.0, "6": 4.5,
        "7": 4.2, "8": 4.3, "9": 4.8, "10": 5.2, "11": 5.8, "12": 6.0
    };

    var DEFAULT_TARIFF = {
        mode: 'tou',                 // 'tou' | 'progressive' | 'flat'
        onPeakRate: 5.7982,
        offPeakRate: 2.6369,
        onPeakStartMin: 9 * 60,      // 09:00
        onPeakEndMin: 22 * 60,       // 22:00
        flatRate: 4.18,
        serviceFee: 87.44,
        ftRate: 0.1623,
        vatRate: 0.07,
        progTiers: [[15, 2.3488], [25, 2.9882], [200, 3.0000], [400, 4.1584], [null, 4.3583]],
        progServiceFee: 24.62
    };

    var DEFAULT_SETTINGS = {
        tariff: DEFAULT_TARIFF,
        solar: { systemLosses: 0.25, pricePerKwp: 40000, inverterEfficiency: 0.96, capMultiple: 1.0, pricePreset: 'hw3' },
        // 7,650 = ค่าเฉลี่ยราคาแพ็กแบต Deye 16 kWh หักลบราคาไม่มีแบต (7 จุดในใบเสนอราคา 2569: 6,311–9,955 ฿/kWh)
        battery: { pricePerKwh: 7650, defaultCapacity: 10, defaultDod: 0.8, defaultEfficiency: 0.9 },
        location: { name: 'ตรัง', pshMonthly: DEFAULT_PSH_MONTHLY },
        monthOverride: null
    };

    // ------------------------------------------------------------ price presets
    // ราคาติดตั้งจริงจากใบเสนอราคาของหน่วยงาน (2569) — ไม่เชิงเส้นตามขนาด
    // จึงเก็บเป็นจุดราคา [kWp, บาท] แล้วแทรกเชิงเส้นระหว่างจุด (นอกช่วงต่อเนื่องตามความชันปลาย)
    var PRICE_PRESETS = {
        hw1:   { label: 'Huawei + LONGi · 1 เฟส', curve: [[5, 171600], [10, 279365.63]] },
        hw3:   { label: 'Huawei + LONGi · 3 เฟส', curve: [[5, 189530], [10, 283470], [15, 375670], [20, 458700]] },
        hwo1:  { label: 'Huawei + LONGi + Optimizer · 1 เฟส', curve: [[5, 185790], [10, 304198.13]] },
        hwo3:  { label: 'Huawei + LONGi + Optimizer · 3 เฟส', curve: [[5, 203720], [10, 310090], [15, 418440], [20, 513700]] },
        deye1: { label: 'Deye + LONGi · 1 เฟส (ไม่มีแบต)', curve: [[5, 162140], [8, 254430], [10, 280500]] },
        deye3: { label: 'Deye + LONGi · 3 เฟส (ไม่มีแบต)', curve: [[5, 198660], [10, 253220], [15, 395860], [20, 501160]] }
    };
    var SOLAR_PRESET_ORDER = ['hw3', 'hw1', 'hwo3', 'hwo1', 'deye3', 'deye1'];

    function systemPriceFromCurve(kwp, curve) {
        var pts = curve.slice().sort(function (a, b) { return a[0] - b[0]; });
        var i, f;
        if (kwp <= pts[0][0]) {
            var slopeLo = pts.length > 1 ? (pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0]) : 0;
            return Math.max(0, pts[0][1] + (kwp - pts[0][0]) * slopeLo);
        }
        for (i = 1; i < pts.length; i++) {
            if (kwp <= pts[i][0]) {
                f = (kwp - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]);
                return pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1]);
            }
        }
        var n = pts.length;
        var slopeHi = n > 1 ? (pts[n - 1][1] - pts[n - 2][1]) / (pts[n - 1][0] - pts[n - 2][0]) : 0;
        return pts[n - 1][1] + (kwp - pts[n - 1][0]) * slopeHi;
    }

    // ต้นทุนระบบโซลาร์ขนาด kwp: ใช้ชุดราคา preset ถ้าตั้งไว้ ไม่งั้นใช้ ฿/kWp เดียว
    function solarCost(kwp, solar) {
        if (solar && solar.pricePreset && PRICE_PRESETS[solar.pricePreset]) {
            return systemPriceFromCurve(kwp, PRICE_PRESETS[solar.pricePreset].curve);
        }
        return kwp * (solar ? solar.pricePerKwp : DEFAULT_SETTINGS.solar.pricePerKwp);
    }

    // ------------------------------------------------------------ rate presets
    // อัตราอ้างอิงจาก modules/tariff.py (มติ กกพ. 5 ส.ค. 2569)
    // mode: ค่าที่ engine ใช้จริง ('tou' | 'progressive' | 'flat')
    var TARIFF_PRESETS = {
        tou: {
            kind: 'tou', mode: 'tou',
            label: 'TOU (On/Off-Peak)',
            detail: 'On 5.7982 / Off 2.6369 · ค่าบริการ 87.44',
            onPeakRate: 5.7982, offPeakRate: 2.6369, serviceFee: 87.44
        },
        prog5: {
            kind: 'progressive', mode: 'progressive',
            label: 'อัตราก้าวหน้า 5 ขั้น (1.1.1)',
            detail: '2.3488 → 2.9882 → 3.0000 → 4.1584 → 4.3583 · ค่าบริการ 8.19',
            progTiers: [[15, 2.3488], [25, 2.9882], [200, 3.0000], [400, 4.1584], [null, 4.3583]],
            progServiceFee: 8.19
        },
        prog3: {
            kind: 'progressive', mode: 'progressive',
            label: 'อัตราก้าวหน้า 3 ขั้น (1.1.2)',
            detail: '3.0000 → 4.1584 → 4.3583 · ค่าบริการ 24.62',
            progTiers: [[200, 3.0000], [400, 4.1584], [null, 4.3583]],
            progServiceFee: 24.62
        },
        flat: {
            kind: 'flat', mode: 'flat',
            label: 'อัตราคงที่ (Flat)',
            detail: '4.18 บาท/kWh · ค่าบริการ 87.44',
            flatRate: 4.18, serviceFee: 87.44
        }
    };

    var PRESET_ORDER = ['tou', 'prog5', 'prog3', 'flat'];

    // สร้าง tariff จาก preset โดยคงค่าอื่น (Ft, VAT, ช่วงเวลา On-Peak) ไว้
    function tariffFromPreset(preset, base) {
        var p = TARIFF_PRESETS[preset];
        if (!p) return null;
        var t = JSON.parse(JSON.stringify(base || DEFAULT_TARIFF));
        t.mode = p.mode;
        if (p.onPeakRate !== undefined) t.onPeakRate = p.onPeakRate;
        if (p.offPeakRate !== undefined) t.offPeakRate = p.offPeakRate;
        if (p.flatRate !== undefined) t.flatRate = p.flatRate;
        if (p.serviceFee !== undefined) t.serviceFee = p.serviceFee;
        if (p.progTiers) t.progTiers = p.progTiers.map(function (r) { return [r[0], r[1]]; });
        if (p.progServiceFee !== undefined) t.progServiceFee = p.progServiceFee;
        t.preset = preset;
        return t;
    }

    // เดาชนิดอัตราจากช่อง "Tariff: x.x.x" ในไฟล์ PEA
    function presetFromTariffCode(code) {
        if (!code) return null;
        var c = String(code).toUpperCase();
        if (/TOU/.test(c)) return 'tou';
        if (/1\.1\.2/.test(c)) return 'prog3';
        if (/1\.1\.1/.test(c)) return 'prog5';
        if (/^1\b|^1\./.test(c)) return 'prog5';
        if (/^[345]\b|^[345]\./.test(c)) return 'tou';
        return null;
    }


    var N_INTERVALS = 96;
    var DT_HOURS = 0.25;

    // ------------------------------------------------------------ solar model
    // identical to solar_model.build_daily_bell
    function buildDailyBell(psh, systemLosses) {
        systemLosses = (systemLosses === undefined) ? 0.25 : systemLosses;
        var raw = new Array(N_INTERVALS);
        var i, min, t, sum = 0;
        for (i = 0; i < N_INTERVALS; i++) {
            min = i * 15;
            t = min - 720;
            var r = Math.exp(-0.5 * Math.pow(t / 120.0, 2));
            if (t <= -300 || t >= 300) r = 0.0;
            raw[i] = r;
            sum += r;
        }
        var areaRaw = sum * DT_HOURS;
        if (areaRaw <= 0) return new Float64Array(N_INTERVALS);
        var dailyEnergy = psh * (1.0 - systemLosses);
        var scale = dailyEnergy / areaRaw;
        var gen = new Float64Array(N_INTERVALS);
        for (i = 0; i < N_INTERVALS; i++) gen[i] = raw[i] * scale;
        return gen;
    }

    // ---------------------------------------------------------------- tariff
    function progressiveCharge(kwh, tiers) {
        var charge = 0, lower = 0;
        for (var k = 0; k < tiers.length; k++) {
            var upperRaw = tiers[k][0];
            var rate = tiers[k][1];
            if (upperRaw === null || upperRaw === undefined || upperRaw === '') upperRaw = Infinity;
            if (kwh <= lower) break;
            var take = Math.min(kwh, upperRaw) - lower;
            if (take <= 0) break;
            charge += take * rate;
            lower = upperRaw;
        }
        return charge;
    }

    // bill from kWh totals (on/off peak split irrelevant except TOU)
    function billFromKwh(onPeakKwh, offPeakKwh, tariff) {
        var total = onPeakKwh + offPeakKwh;
        var energyCharge, service;
        if (tariff.mode === 'progressive') {
            energyCharge = progressiveCharge(total, tariff.progTiers);
            service = tariff.progServiceFee;
        } else if (tariff.mode === 'flat') {
            energyCharge = total * tariff.flatRate;
            service = tariff.serviceFee;
        } else {
            energyCharge = onPeakKwh * tariff.onPeakRate + offPeakKwh * tariff.offPeakRate;
            service = tariff.serviceFee;
        }
        var ft = total * tariff.ftRate;
        var subtotal = energyCharge + ft + service;
        var vat = subtotal * tariff.vatRate;
        return {
            onPeakKwh: onPeakKwh, offPeakKwh: offPeakKwh, totalKwh: total,
            energyCharge: energyCharge, ftCharge: ft, serviceFee: service,
            vat: vat, subtotal: subtotal, grandTotal: subtotal + vat
        };
    }

    // อัตราก้าวหน้าเป็นขั้นรายเดือน: ถ้าคิดบนหน่วยของช่วงข้อมูล (เช่น 10 วัน)
    // ต้องขยายเป็นหน่วย/เดือนก่อนคิดขั้น แล้วเทียบกลับมาเป็นช่วงเดิม
    function billFromKwhPeriod(totalKwh, nDays, tariff) {
        var bill = billFromKwh(totalKwh, 0, tariff);
        if (tariff.mode !== 'progressive' || !(nDays > 0) || nDays === 30) return bill;
        var up = 30 / nDays;
        var monthly = billFromKwh(totalKwh * up, 0, tariff);
        var out = scaleBill(monthly, 1 / up);
        out.totalKwh = totalKwh;
        out.monthlyTotalKwh = monthly.totalKwh;
        out.monthlyGrandTotal = monthly.grandTotal;
        out.tierScaled = true;
        return out;
    }
    function scaleBill(bill, f) {
        return {
            onPeakKwh: bill.onPeakKwh, offPeakKwh: bill.offPeakKwh, totalKwh: bill.totalKwh,
            energyCharge: bill.energyCharge * f, ftCharge: bill.ftCharge * f,
            serviceFee: bill.serviceFee * f, vat: bill.vat * f,
            subtotal: bill.subtotal * f, grandTotal: bill.grandTotal * f
        };
    }

    // bill from per-interval kW + minute-of-day arrays
    // nDays (ถ้าส่งมา) ใช้ปรับขั้นอัตราก้าวหน้าให้เป็นรายเดือน
    function billForSeries(powerKw, minutes, tariff, nDays) {
        if (tariff.mode === 'progressive' || tariff.mode === 'flat') {
            var total = 0;
            for (var i = 0; i < powerKw.length; i++) total += powerKw[i];
            return billFromKwhPeriod(total * DT_HOURS, nDays, tariff);
        }
        var on = 0, off = 0;
        for (var j = 0; j < powerKw.length; j++) {
            var m = minutes[j];
            if (m >= tariff.onPeakStartMin && m < tariff.onPeakEndMin) on += powerKw[j];
            else off += powerKw[j];
        }
        return billFromKwh(on * DT_HOURS, off * DT_HOURS, tariff);
    }

    // ------------------------------------------------------------- battery sim
    // identical to battery_model.simulate_battery
    function simulateBattery(solarKw, loadKw, params) {
        var n = loadKw.length;
        var usable = params.capacityKwh * params.dod;
        var reserveKwh = (params.reserveFrac > 0 && params.capacityKwh > 0)
            ? params.capacityKwh * params.reserveFrac : 0; // 🛡️ โซนสำรองไฟดับ (reserveFrac = สัดส่วน, 0.5 = 50%): เก็บนิ่งตลอด ไม่เข้าการวนใช้/คิดความคุ้มค่า
        usable = Math.max(0, usable - reserveKwh);
        var hasBatt = usable > 1e-9; // แบต 0 kWh = ไม่มีแบต → เทียบเท่า On-Grid (กัน NaN จากการหารศูนย์)
        var curSoc = Math.min(Math.max(params.initialSoc || 0, 0), 1); // กัน initialSoc ขาด/NaN → เริ่มว่าง
        var soc = new Float64Array(n);
        var chargeArr = new Float64Array(n);
        var dischargeArr = new Float64Array(n);
        var grid = new Float64Array(n);
        var exportArr = new Float64Array(n);
        var chargeKwh = 0, dischargeKwh = 0, batteryUsedKwh = 0;
        for (var i = 0; i < n; i++) {
            var pv = solarKw[i], load = loadKw[i];
            var net = pv - load;
            if (net > 1e-6) {
                var surplusKwh = net * DT_HOURS;
                var storeable = 0;
                if (hasBatt) {
                    var chargeCapacityKwh = usable - curSoc * usable;
                    storeable = Math.min(surplusKwh, chargeCapacityKwh);
                    curSoc += storeable / usable;
                    if (curSoc > 1) curSoc = 1;
                }
                chargeKwh += storeable;
                chargeArr[i] = storeable / DT_HOURS;
                var leftover = surplusKwh - storeable;
                exportArr[i] = Math.max(0, leftover / DT_HOURS);
                grid[i] = 0;
            } else {
                var deficitKwh = -net * DT_HOURS;
                var dis = 0;
                if (hasBatt) {
                    var availKwh = curSoc * usable * params.efficiency;
                    dis = Math.min(deficitKwh, availKwh);
                    curSoc -= (dis / params.efficiency) / usable;
                    if (curSoc < 0) curSoc = 0;
                }
                dischargeKwh += dis;
                batteryUsedKwh += dis;
                dischargeArr[i] = dis / DT_HOURS;
                var remaining = deficitKwh - dis;
                grid[i] = Math.max(0, remaining / DT_HOURS);
                exportArr[i] = 0;
            }
            soc[i] = hasBatt ? curSoc : 0;
        }
        return {
            socSeries: soc, chargeKwh: chargeKwh, dischargeKwh: dischargeKwh,
            gridImportKw: grid, exportKw: exportArr, batteryUsedKwh: batteryUsedKwh,
            batteryChargeKw: chargeArr, batteryDischargeKw: dischargeArr
        };
    }

    // ------------------------------------------------------- load aggregation
    // avg per-15-min across all data, by minute-of-day
    function buildRepDay(data) {
        var sums = new Float64Array(N_INTERVALS);
        var cnt = new Float64Array(N_INTERVALS);
        var seen = new Array(N_INTERVALS);
        for (var i = 0; i < N_INTERVALS; i++) seen[i] = 0;
        var rows = data.rows;
        for (var j = 0; j < rows.length; j++) {
            var mi = rows[j].minute;
            var idx = Math.round(mi / 15);
            if (idx >= N_INTERVALS) idx = N_INTERVALS - 1;
            sums[idx] += rows[j].kw;
            cnt[idx] += 1;
            seen[idx] = 1;
        }
        var out = new Float64Array(N_INTERVALS);
        for (var k = 0; k < N_INTERVALS; k++) {
            out[k] = cnt[k] > 0 ? sums[k] / cnt[k] : 0;
        }
        return out;
    }

    function referencePeriod(nDays) {
        return nDays <= 1 ? 30 : Math.max(1, nDays);
    }

    function scaleRepDay(repDay, nDays, actualKwh) {
        var est = 0;
        for (var i = 0; i < repDay.length; i++) est += repDay[i];
        est *= DT_HOURS * nDays;
        if (est <= 0 || !(actualKwh > 0)) return repDay;
        var f = actualKwh / est;
        var out = new Float64Array(repDay.length);
        for (var k = 0; k < repDay.length; k++) out[k] = repDay[k] * f;
        return out;
    }

    function tileProfile(profile, nDays) {
        var total = nDays * N_INTERVALS;
        var series = new Float64Array(total);
        var minutes = new Array(total);
        for (var d = 0; d < nDays; d++) {
            for (var i = 0; i < N_INTERVALS; i++) {
                series[d * N_INTERVALS + i] = profile[i];
                minutes[d * N_INTERVALS + i] = i * 15;
            }
        }
        return { series: series, minutes: minutes };
    }

    function maxVal(arr) { var m = -Infinity; for (var i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i]; return m; }
    function minMaxSoc(socArr) { var out = { min: 1, max: 0 }; for (var i = 0; i < socArr.length; i++) { if (socArr[i] > out.max) out.max = socArr[i]; if (socArr[i] < out.min) out.min = socArr[i]; } return out; }

    // ------------------------------------------------------------ sizing core
    function effectiveMonth(data, settings) {
        if (settings.monthOverride) return settings.monthOverride;
        if (data && data.metadata && data.metadata.month) return data.metadata.month;
        return 4;
    }

    function pshForMonth(month, settings) {
        var p = (settings.location.pshMonthly || {})[String(month)];
        return (p === undefined || p === null) ? 5.0 : p;
    }

    // ขนาดโซลาร์ที่พิจารณา (kWp) — ครอบคลุมโหลดถึง 300 kW
    var SIZE_GRID = [3, 5, 8, 10, 12, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100,
        110, 120, 140, 160, 180, 200, 225, 250, 275, 300];
    // ขนาดแบตเตอรี่ที่พิจารณา (kWh)
    var BATT_GRID = [5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 120, 140, 160, 200, 250, 300];

    function computeSizing(data, opts) {
        opts = opts || {};
        var settings = opts.settings || cloneSettings(DEFAULT_SETTINGS);
        var mode = opts.mode || 'ongrid';
        var sizes = opts.sizes || SIZE_GRID;
        var tariff = opts.tariff || settings.tariff;
        var month = effectiveMonth(data, settings);
        var psh = pshForMonth(month, settings);
        var losses = (opts.systemLosses !== undefined) ? opts.systemLosses : settings.solar.systemLosses;
        // opts.pricePerKwp = ทางลัดบังคับราคา ฿/kWp เดียว (ไม่สน preset) — ปกติใช้ settings.solar ทั้งก้อน
        var solarOpts = (opts.pricePerKwp !== undefined)
            ? { pricePerKwp: opts.pricePerKwp, pricePreset: null }
            : settings.solar;
        var batteryPrice = (opts.batteryPricePerKwh !== undefined)
            ? opts.batteryPricePerKwh : settings.battery.pricePerKwh;
        var wdEff = (opts.workDaysPerWeek > 0) ? opts.workDaysPerWeek : 7;

        var dailyProfile = buildDailyBell(psh, losses);
        var repRaw = buildRepDay(data);
        var monthDays = referencePeriod(data.nDays);
        var dailyEnergy = data.totalKwh / Math.max(1, data.nDays);
        var repDay = scaleRepDay(repRaw, monthDays, dailyEnergy * monthDays);

        var l = tileProfile(repDay, monthDays);
        var loadSeries = l.series, minutes = l.minutes;
        var billBefore = billForSeries(loadSeries, minutes, tariff, monthDays);

        var rows = [];
        var anyHybrid = mode === 'hybrid';
        for (var s = 0; s < sizes.length; s++) {
            var size = sizes[s];
            var g = tileProfile(multiplyArr(dailyProfile, size), monthDays);
            var genSeries = g.series;
            var batParams, sim, gridSeries, exportSeries, selfUsedSeries;
            var batteryDischarge = 0, batteryCharge = 0, batterySocMax = 0;

            if (anyHybrid) {
                batParams = opts.battery || {
                    capacityKwh: settings.battery.defaultCapacity,
                    dod: settings.battery.defaultDod,
                    efficiency: settings.battery.defaultEfficiency,
                    initialSoc: 0
                };
                sim = simulateBattery(genSeries, loadSeries, batParams);
                gridSeries = sim.gridImportKw;
                exportSeries = sim.exportKw;
                selfUsedSeries = minArr(genSeries, loadSeries);
                batteryDischarge = sim.dischargeKwh;
                batteryCharge = sim.chargeKwh;
                var mm = minMaxSoc(sim.socSeries);
                batterySocMax = mm.max;
            } else {
                selfUsedSeries = minArr(genSeries, loadSeries);
                gridSeries = subArr(loadSeries, selfUsedSeries);
                exportSeries = subArr(genSeries, selfUsedSeries);
            }
            gridSeries = maxZeroArr(gridSeries);

            var billAfter = billForSeries(gridSeries, minutes, tariff, monthDays);
            var genKwh = sumArr(genSeries) * DT_HOURS;
            var selfUsedKwh = sumArr(selfUsedSeries) * DT_HOURS;
            var exportKwh = sumArr(exportSeries) * DT_HOURS;
            var gridKwh = sumArr(gridSeries) * DT_HOURS;

            var wasteKwh;
            if (anyHybrid) {
                var genFull = genKwh;
                var selfFull = selfUsedKwh;
                wasteKwh = Math.max(0, genFull - selfFull - batteryCharge);
            } else {
                wasteKwh = exportKwh;
            }

            var savings = billBefore.grandTotal - billAfter.grandTotal;
            var savingsPct = billBefore.grandTotal > 0 ? (savings / billBefore.grandTotal * 100) : 0;
            var invest = solarCost(size, solarOpts) + (anyHybrid ? batParams.capacityKwh * batteryPrice : 0);
            // คืนทุนเป็น "เดือนจริง" (30 วัน): เงินลงทุน ÷ ประหยัดต่อเดือน — ไม่ผูกกับความยาวไฟล์
            var monthDaysEff = monthDays * 7 / wdEff;
            var monthlySavings = savings * 30 / monthDaysEff;
            var payback = monthlySavings > 0 ? invest / monthlySavings : Infinity;
            var selfRatio = genKwh > 0 ? selfUsedKwh / genKwh : 0;

            rows.push({
                sizeKwp: size, genKwh: genKwh, selfUsedKwh: selfUsedKwh,
                exportKwh: exportKwh, wasteKwh: wasteKwh,
                batteryDischargeKwh: batteryDischarge, batteryChargeKwh: batteryCharge,
                batterySocMax: batterySocMax,
                billBefore: billBefore.grandTotal, billAfter: billAfter.grandTotal,
                savingsThb: savings, savingsPct: savingsPct, investment: invest,
                monthlySavingsThb: monthlySavings,
                paybackMonths: payback, selfConsumptionRatio: selfRatio,
                gridImportKwh: gridKwh
            });
        }

        // recommendation — identical rule to Python
        var recommended = null;
        if (rows.length) {
            // เพดานขนาดแนะนำ = เท่าของ Peak โหลด (ค่าตั้งได้ในหน้าตั้งค่า, ค่าเริ่มต้น 1 เท่า)
            var capMult = (settings.solar && settings.solar.capMultiple > 0) ? settings.solar.capMultiple : 1.0;
            var maxKwp = Math.max(2.0, Math.ceil(data.peakKw * capMult));
            var pool = rows.filter(function (r) { return r.sizeKwp <= maxKwp; });
            if (!pool.length) pool = rows;
            var good = pool.filter(function (r) {
                return isFinite(r.paybackMonths) && r.paybackMonths <= 120 && r.selfConsumptionRatio >= 0.5;
            });
            if (good.length) {
                var bestRoi = -Infinity;
                for (var i = 0; i < good.length; i++) {
                    var roi = good[i].monthlySavingsThb * 12 / Math.max(good[i].investment, 1);
                    if (roi > bestRoi) bestRoi = roi;
                }
                var threshold = bestRoi * 0.70;
                var value = good.filter(function (r) {
                    return (r.monthlySavingsThb * 12 / Math.max(r.investment, 1)) >= threshold;
                });
                recommended = value.reduce(function (a, b) { return (b.savingsThb > a.savingsThb) ? b : a; });
            } else if (pool.length) {
                recommended = pool.reduce(function (a, b) {
                    var ra = a.monthlySavingsThb * 12 / Math.max(a.investment, 1);
                    var rb = b.monthlySavingsThb * 12 / Math.max(b.investment, 1);
                    return (rb > ra || (rb === ra && b.savingsThb > a.savingsThb)) ? b : a;
                });
            }
        }

        return {
            rows: rows, recommended: recommended,
            dailyProfile: dailyProfile, representativeDayLoad: repDay,
            month: month, psh: psh, tariff: tariff,
            systemLosses: losses, periodDays: monthDays
        };
    }

    // ------------------------------------------------- single-scenario (charts)
    function simulateScenario(data, sizeKwp, opts) {
        opts = opts || {};
        var settings = opts.settings || cloneSettings(DEFAULT_SETTINGS);
        var mode = opts.mode || 'ongrid';
        var tariff = opts.tariff || settings.tariff;
        var month = effectiveMonth(data, settings);
        var psh = pshForMonth(month, settings);
        var losses = (opts.systemLosses !== undefined) ? opts.systemLosses : settings.solar.systemLosses;

        var dailyProfile = buildDailyBell(psh, losses);
        var repRaw = buildRepDay(data);
        var monthDays = referencePeriod(data.nDays);
        var dailyEnergy = data.totalKwh / Math.max(1, data.nDays);
        var repDay = scaleRepDay(repRaw, monthDays, dailyEnergy * monthDays);

        var l = tileProfile(repDay, monthDays);
        var loadSeries = l.series, minutes = l.minutes;
        var genSeries = tileProfile(multiplyArr(dailyProfile, sizeKwp), monthDays).series;

        var sim, grid, exportArr, soc, selfUsed;
        var batParams = opts.battery || {
            capacityKwh: settings.battery.defaultCapacity,
            dod: settings.battery.defaultDod,
            efficiency: settings.battery.defaultEfficiency,
            initialSoc: 0
        };
        if (mode === 'hybrid') {
            sim = simulateBattery(genSeries, loadSeries, batParams);
            grid = sim.gridImportKw;
            exportArr = sim.exportKw;
            soc = sim.socSeries;
            selfUsed = minArr(genSeries, loadSeries);
        } else {
            selfUsed = minArr(genSeries, loadSeries);
            grid = maxZeroArr(subArr(loadSeries, selfUsed));
            exportArr = maxZeroArr(subArr(genSeries, selfUsed));
            soc = new Float64Array(loadSeries.length);
        }

        var billBefore = billForSeries(loadSeries, minutes, tariff, monthDays);
        var billAfter = billForSeries(grid, minutes, tariff, monthDays);
        var savings = billBefore.grandTotal - billAfter.grandTotal;

        var genKwh = sumArr(genSeries) * DT_HOURS;
        var selfUsedKwh = sumArr(selfUsed) * DT_HOURS;
        var exportKwh = sumArr(exportArr) * DT_HOURS;
        var wasteKwh;
        if (mode === 'hybrid') {
            wasteKwh = Math.max(0, genKwh - selfUsedKwh - sim.chargeKwh);
        } else {
            wasteKwh = exportKwh;
        }

        var daily;
        if (mode === 'hybrid') {
            var solarDay = multiplyArr(dailyProfile, sizeKwp);
            daily = {
                load: repDay, solar: solarDay,
                selfUsed: minArr(solarDay, repDay),
                grid: sim.gridImportKw.subarray(0, N_INTERVALS),
                export: sim.exportKw.subarray(0, N_INTERVALS),
                batteryDischarge: sim.batteryDischargeKw.subarray(0, N_INTERVALS),
                batteryCharge: sim.batteryChargeKw.subarray(0, N_INTERVALS),
                soc: sim.socSeries.subarray(0, N_INTERVALS)
            };
        } else {
            var solarDay2 = multiplyArr(dailyProfile, sizeKwp);
            daily = {
                load: repDay, solar: solarDay2,
                selfUsed: minArr(solarDay2, repDay),
                grid: maxZeroArr(subArr(repDay, minArr(solarDay2, repDay))),
                export: maxZeroArr(subArr(solarDay2, repDay)),
                soc: new Float64Array(N_INTERVALS)
            };
        }

        return {
            minutes: minutes, loadSeries: loadSeries, genSeries: genSeries,
            gridSeries: grid, exportSeries: exportArr, socSeries: soc,
            billBefore: billBefore, billAfter: billAfter, savings: savings,
            daily: daily, nDays: Math.max(1, data.nDays), periodDays: monthDays,
            genKwh: genKwh, selfUsedKwh: selfUsedKwh, wasteKwh: wasteKwh,
            batteryKwh: (mode === 'hybrid' ? batParams.capacityKwh : 0),
            batteryChargeKwh: (mode === 'hybrid' ? sim.chargeKwh : 0),
            batteryDischargeKwh: (mode === 'hybrid' ? sim.dischargeKwh : 0),
            solarSizeKwp: sizeKwp,
            tariff: tariff, month: month
        };
    }

    // ------------------------------------------------------- battery recommend
    function recommendBattery(data, sizeKwp, opts) {
        opts = opts || {};
        var settings = opts.settings || cloneSettings(DEFAULT_SETTINGS);
        var tariff = opts.tariff || settings.tariff;
        var dod = (opts.dod !== undefined) ? opts.dod : settings.battery.defaultDod;
        var eff = (opts.efficiency !== undefined) ? opts.efficiency : settings.battery.defaultEfficiency;
        var bprice = (opts.batteryPricePerKwh !== undefined) ? opts.batteryPricePerKwh : settings.battery.pricePerKwh;
        var solarOptsB = (opts.pricePerKwp !== undefined)
            ? { pricePerKwp: opts.pricePerKwp, pricePreset: null }
            : settings.solar;
        var caps = [];
        if (opts.caps && opts.caps.length) {
            for (var q = 0; q < opts.caps.length; q++) caps.push(opts.caps[q]);
        } else {
            for (var c = 0; c < BATT_GRID.length; c++) caps.push(BATT_GRID[c]);
        }

        var baseScen = simulateScenario(data, sizeKwp, mergeOpts(opts, { mode: 'ongrid', settings: settings }));
        var base = baseScen.savings;
        var surplus = baseScen.genKwh - baseScen.selfUsedKwh; // ไฟที่ผลิตเกินใช้เอง = เพดานของไฟที่แบตจะเก็บได้
        var periodDays = baseScen.periodDays || 30;

        var candidates = [];
        for (var i = 0; i < caps.length; i++) {
            var cap = caps[i];
            var bat = { capacityKwh: cap, dod: dod, efficiency: eff, initialSoc: 0 };
            var scen = simulateScenario(data, sizeKwp, { mode: 'hybrid', tariff: tariff, battery: bat, settings: settings });
            var wdM = (opts.workDaysPerWeek > 0) ? opts.workDaysPerWeek : 7;
            var addon = (scen.savings - base) * 30 / (periodDays * 7 / wdM); // เพิ่มประหยัด "ต่อเดือนจริง"
            var solarInvest = solarCost(sizeKwp, solarOptsB);
            var batteryInvest = cap * bprice;
            var monthlyScen = scen.savings * 30 / (periodDays * 7 / wdM);
            var fullPayback = monthlyScen > 0 ? (solarInvest + batteryInvest) / monthlyScen : Infinity;
            var batteryPayback = addon > 0 ? batteryInvest / addon : Infinity;
            candidates.push({
                capacityKwh: cap, savingsThb: scen.savings, addonThb: addon,
                batteryInvestThb: batteryInvest, wasteKwh: scen.wasteKwh,
                chargeKwh: scen.batteryChargeKwh,
                batteryPaybackMonths: batteryPayback, fullPaybackMonths: fullPayback
            });
        }

        var meaningful = candidates.filter(function (cnd) {
            return cnd.addonThb >= 50 && isFinite(cnd.batteryPaybackMonths) ? cnd.batteryPaybackMonths <= 120 : false;
        });
        var best = null, note = '';
        if (!meaningful.length) {
            // เหตุผลแบบละเอียด: ระบุว่าเป็นเคสไหน (ไม่ผลิตเกิน / ประโยชน์น้อย / คืนทุนช้าเกิน 10 ปี) พร้อมตัวเลข
            var maxCharge = 0, maxAddonC = -Infinity, bestPaybackC = Infinity;
            for (var q = 0; q < candidates.length; q++) {
                if (candidates[q].chargeKwh > maxCharge) maxCharge = candidates[q].chargeKwh;
                if (candidates[q].addonThb > maxAddonC) maxAddonC = candidates[q].addonThb;
                if (isFinite(candidates[q].batteryPaybackMonths) && candidates[q].batteryPaybackMonths < bestPaybackC) {
                    bestPaybackC = candidates[q].batteryPaybackMonths;
                }
            }
            var surplusPerDay = surplus / periodDays;
            if (surplusPerDay < 0.05) {
                note = '❌ โซลาร์ไม่ผลิตเกินโหลดพอจะเก็บ — ไฟเหลือหลังใช้เองเพียง ~' + surplusPerDay.toFixed(2) +
                    ' kWh/วัน แบตจึงเก็บได้แทบเป็นศูนย์ (ต้องเพิ่มขนาดโซลาร์ให้ผลิตเกินโหลดกลางวันก่อน)';
            } else if (maxAddonC < 50) {
                note = '❌ มีไฟเหลือให้เก็บ ~' + (maxCharge / periodDays).toFixed(1) +
                    ' kWh/วัน แต่ช่วยประหยัดได้ไม่ถึง 50 ฿/เดือน — ไม่คุ้มติดแบต';
            } else {
                note = '⚠️ มีไฟเหลือให้เก็บ ~' + (maxCharge / periodDays).toFixed(1) +
                    ' kWh/วัน แต่คืนทุนเฉพาะแบตดีที่สุด ~' + (bestPaybackC / 12).toFixed(1) +
                    ' ปี ช้ากว่าเกณฑ์ 10 ปี — จึงไม่แนะนำตามเกณฑ์คุ้มทุน';
            }
        } else {
            var maxAddon = -Infinity;
            for (var k = 0; k < meaningful.length; k++) if (meaningful[k].addonThb > maxAddon) maxAddon = meaningful[k].addonThb;
            var reach = meaningful.filter(function (cnd) { return cnd.addonThb >= 0.9 * maxAddon; });
            if (reach.length) {
                best = reach.reduce(function (a, b) {
                    if (b.batteryPaybackMonths !== a.batteryPaybackMonths)
                        return b.batteryPaybackMonths < a.batteryPaybackMonths ? b : a;
                    return b.capacityKwh > a.capacityKwh ? b : a;
                });
            } else {
                best = meaningful.reduce(function (a, b) { return b.batteryPaybackMonths < a.batteryPaybackMonths ? b : a; });
            }
            note = 'ความจุ ' + fmtInt(best.capacityKwh) + ' kWh เก็บไฟโซลาร์ส่วนเกินช่วยลดการดึง Grid ได้ เพิ่มอีก ~' +
                fmtMoney(best.addonThb) + ' บาท/เดือน (เทียบ On-Grid ขนาดเดียวกัน)';
        }

        // แนะนำแบบ "ไม่สนเกณฑ์คืนทุน 10 ปี" สำหรับผู้ใช้ไฟที่ยังต้องการติดแบตอยู่ดี (เช่น เพื่อสำรองไฟดับ)
        var wantAnyway = candidates.filter(function (cnd) {
            return cnd.addonThb >= 50 && isFinite(cnd.batteryPaybackMonths);
        });
        var bestAnyway = null;
        if (wantAnyway.length) {
            var maxAddonW = -Infinity;
            for (var w = 0; w < wantAnyway.length; w++) if (wantAnyway[w].addonThb > maxAddonW) maxAddonW = wantAnyway[w].addonThb;
            var reachW = wantAnyway.filter(function (cnd) { return cnd.addonThb >= 0.9 * maxAddonW; });
            bestAnyway = reachW.reduce(function (a, b) {
                if (b.batteryPaybackMonths !== a.batteryPaybackMonths)
                    return b.batteryPaybackMonths < a.batteryPaybackMonths ? b : a;
                return b.capacityKwh > a.capacityKwh ? b : a;
            });
        }

        return {
            bestCapacityKwh: best ? best.capacityKwh : 0,
            addonSavingsThb: best ? best.addonThb : 0,
            savingsThb: best ? best.savingsThb : base,
            batteryInvestThb: best ? best.batteryInvestThb : 0,
            batteryPaybackMonths: best ? best.batteryPaybackMonths : Infinity,
            fullPaybackMonths: best ? best.fullPaybackMonths : Infinity,
            wasteKwh: best ? best.wasteKwh : 0,
            bestAnywayCapacityKwh: bestAnyway ? bestAnyway.capacityKwh : 0,
            bestAnywayAddonThb: bestAnyway ? bestAnyway.addonThb : 0,
            bestAnywayPaybackMonths: bestAnyway ? bestAnyway.batteryPaybackMonths : Infinity,
            note: note, candidates: candidates,
            solarSizeKwp: sizeKwp, ongridSavingsThb: base
        };
    }

    // ---------------------------------------------------------------- parser
    // entry: array of { name, content(Buffer|Uint8Array|string) }
    // AMR export = HTML frameset (.xls) + files\sheet001.htm (table)
    // household files = .xlsx / .csv with Timestamp | Power Consumption (kW)
    function parseAmrFiles(files, XLSX) {
        var dec = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var name = String(f.name || '');
            var buf = f.content;
            var text = (typeof buf === 'string') ? buf : utf8(buf);
            var lower = name.toLowerCase();
            dec.push({ name: name, lower: lower, text: text, buf: buf });
        }

        // ---- HTML path: find frameset and/or a table file
        var tableFile = null;
        var framesetFile = null;
        for (var j = 0; j < dec.length; j++) {
            var tag = dec[j].text.slice(0, 4000);
            var isHtml = /<html|<!doctype html|<frameset|<table/i.test(tag) || /microsoft-excel/i.test(tag);
            if (/<frameset/i.test(tag)) framesetFile = dec[j];
            else if (isHtml && /<table/i.test(tag)) tableFile = tableFile || dec[j];
        }

        if (framesetFile) {
            if (!tableFile) {
                var m = /frameborder[\s\S]*?src="([^"]+)"|src="([^"]+\.htm[^"]*)"/i.exec(framesetFile.text);
                var hint = m ? (m[1] || m[2]) : 'sheet001.htm';
                return { error: 'ไฟล์ .xls เป็นไฟล์โครง (frameset) — ให้เลือกเพิ่มไฟล์ตาราง ' + hint + ' ในโฟลเดอร์ *_files ด้วย (เลือกได้หลายไฟล์พร้อมกัน)' };
            }
            return parsePeaHtml(tableFile, XLSX);
        }
        if (tableFile && /RATE/i.test(tableFile.text.slice(0, 300000))) {
            return parsePeaHtml(tableFile, XLSX);
        }

        // ---- generic workbook / csv
        if (dec.length === 0) return { error: 'ไม่พบไฟล์ที่เลือก' };
        var gen = parseGeneric(dec, XLSX);
        if (gen && gen.rows && gen.rows.length) return gen;
        return { error: 'อ่านข้อมูลจากไฟล์ไม่สำเร็จ — ตรวจว่าไฟล์เป็น ข้อมูลมิเตอร์ราย 15 นาที (คอลัมน์ วัน/เวลา และ กิโลวัตต์)' };
    }

    // ----------------------------------------------------------------- AMR HTML
    function parsePeaHtml(file, XLSX) {
        var aoa = null;
        try {
            var wb = XLSX.read(file.text, { type: 'string' });
            var s0 = wb.Sheets[wb.SheetNames[0]];
            aoa = XLSX.utils.sheet_to_json(s0, { header: 1, defval: '', raw: true });
        } catch (e) { return { error: 'ไม่สามารถอ่านตาราง HTML ได้: ' + e.message }; }
        if (!aoa || aoa.length < 3) return { error: 'ตาราง HTML ว่างหรือไม่ใช่ข้อมูลมิเตอร์ (sheet001) — หรือยังไม่ได้เลือกไฟล์ sidecar' };

        var meta = parsePeaMetadata(aoa);
        var dateRe = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})[\s]+(\d{1,2})[\.: ](\d{2})/;

        // RATE header row (for value columns)
        var rateHeaderIdx = -1;
        for (var i = 0; i < Math.min(6, aoa.length); i++) {
            var joined = String(aoa[i].join ? aoa[i].join(' ') : '');
            if (/RATE/i.test(joined)) { rateHeaderIdx = i; break; }
        }
        var aCol = null, bCol = null;
        if (rateHeaderIdx >= 0) {
            var hdr = aoa[rateHeaderIdx];
            for (var c = 0; c < hdr.length; c++) {
                var h = String(hdr[c]).toUpperCase();
                if (aCol === null && h.indexOf('RATE A') >= 0) aCol = c;
                else if (bCol === null && h.indexOf('RATE B') >= 0) bCol = c;
            }
        }
        if (aCol === null) aCol = 1;
        if (bCol === null) bCol = 3;

        var rows = [];
        var dates = {};
        var startI = Math.max(0, rateHeaderIdx + 1);
        for (var r = startI; r < aoa.length; r++) {
            var dtCell = aoa[r][0];
            if (typeof dtCell !== 'string') continue;
            var m = dateRe.exec(dtCell.trim());
            if (!m) continue;
            var dd = parseInt(m[1], 10), mm = parseInt(m[2], 10), yy = parseInt(m[3], 10);
            var hh = parseInt(m[4], 10), mi = parseInt(m[5], 10);
            if (yy < 100) yy += 2000;
            var valA = toFloat(aoa[r][aCol]);
            var valB = toFloat(aoa[r][bCol]);
            if (valA === null && valB === null) continue;

            var date = new Date(yy, mm - 1, dd);
            // แถว "24.00" = ช่วง 23:45–24:00 ของวันเดียวกัน — ห้ามข้ามไปวันถัดไป (เดิมสร้าง "วันผี" ทำ nDays บวม)
            var minute = hh * 60 + mi;
            var key = date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
            dates[key] = 1;
            var value, onPeak;
            if (valA !== null && valB !== null) { value = valA; onPeak = true; }
            else if (valA !== null) { value = valA; onPeak = true; }
            else { value = valB; onPeak = false; }
            rows.push({ ts: date, minute: minute, kw: value, onPeak: onPeak });
        }
        if (!rows.length) return { error: 'พบตารางแต่ไม่เจอแถวข้อมูลเวลา (รูปแบบวัน/เวลาไม่ตรง)' };
        rows.sort(function (a, b) { return a.ts - b.ts || a.minute - b.minute; });

        return summarize(rows, meta, true, file.name);
    }

    function parsePeaMetadata(aoa) {
        var meta = { customer: null, meter_no: null, month: null, month_th: null, year: null, tariff: null, ct_ratio: null, vt_ratio: null };
        for (var i = 0; i < Math.min(6, aoa.length); i++) {
            var joined = aoa[i].filter(function (v) { return typeof v === 'string'; }).join(' ');
            if (/ประจำเดือน/.test(joined)) {
                var m = /ประจำเดือน\s*[:\-]?\s*([\u0E00-\u0E7F]+)\s*(\d{4})/.exec(joined);
                if (m) {
                    var th = m[1].trim();
                    var num = thaiMonthToNum(th);
                    meta.year = parseInt(m[2], 10);
                    meta.month_th = th;
                    meta.month = num;
                }
            }
            var mm = /หมายเลขมิเตอร์\s*:\s*([^\s]+)/.exec(joined);
            if (mm) meta.meter_no = mm[1];
            var mt = /Tariff\s*:\s*(\S+)/i.exec(joined);
            if (mt) meta.tariff = mt[1].toUpperCase();
            var mct = /CT Ratio\s*:\s*([\d:\. ]+)/.exec(joined);
            if (mct) meta.ct_ratio = mct[1].trim();
            var mvt = /VT Ratio\s*:\s*([\d:\. ]+)/.exec(joined);
            if (mvt) meta.vt_ratio = mvt[1].trim();
        }
        return meta;
    }

    var THAI_MONTHS = { 'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4, 'พฤษภาคม': 5, 'มิถุนายน': 6, 'กรกฎาคม': 7, 'สิงหาคม': 8, 'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12 };
    function thaiMonthToNum(th) {
        for (var k in THAI_MONTHS) if (th.indexOf(k) >= 0) return THAI_MONTHS[k];
        return null;
    }

    // ------------------------------------------------------- generic workbook
    function parseGeneric(dec, XLSX) {
        var best = null;
        for (var i = 0; i < dec.length; i++) {
            var f = dec[i];
            if (f.lower.indexOf('.htm') >= 0) continue;
            var aoa = null;
            var isXlsx = f.lower.indexOf('.xlsx') >= 0;
            var isCsv = f.lower.indexOf('.csv') >= 0;
            var attempts = [];
            if (isXlsx) attempts.push({ data: f.buf, type: 'array' });
            else if (isCsv) attempts.push({ data: f.text, type: 'string' });
            else {
                attempts.push({ data: looksHtml(f.text) ? f.text : f.buf, type: looksHtml(f.text) ? 'string' : 'array' });
                attempts.push({ data: f.text, type: 'string' });
            }
            for (var a = 0; a < attempts.length; a++) {
                try {
                    var wb = XLSX.read(attempts[a].data, { type: attempts[a].type });
                    var sh = wb.Sheets[wb.SheetNames[0]];
                    if (sh) { aoa = XLSX.utils.sheet_to_json(sh, { header: 1, defval: '', raw: true }); break; }
                } catch (e) { continue; }
            }
            if (!aoa || aoa.length < 2) continue;

            // find header row + columns
            var guessed = guessColumns(aoa);
            if (!guessed) continue;
            var rows = [];
            var dates = {};
            for (var r = guessed.headerIdx + 1; r < aoa.length; r++) {
                var dtCell = aoa[r][guessed.dtCol];
                var parsed = parseDateCell(dtCell, true);
                if (!parsed) continue;
                var val = toFloat(aoa[r][guessed.loadCol]);
                if (val === null) continue;
                var date = parsed.date, minute = parsed.minute;
                var key = date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
                dates[key] = 1;
                var inWin = (minute >= 9 * 60) && (minute < 22 * 60);
                rows.push({ ts: date, minute: minute, kw: val, onPeak: inWin });
            }
            if (!rows.length) continue;
            var meta = {
                customer: null, meter_no: null,
                month: f.lower.indexOf('hb') >= 0 ? null : null,
                month_th: null, year: null,
                tariff: null, ct_ratio: null, vt_ratio: null
            };
            var sum = summarize(rows, meta, false, f.name);
            if (!best || sum.rows.length > best.rows.length) best = sum;
        }
        return best;
    }

    function isHtmlBuf(buf) {
        return true; // legacy — unused
    }

    function looksHtml(text) {
        var head = (text || '').slice(0, 2000);
        return /^\s*</.test(head) || /<!doctype html/i.test(head) || /microsoft-excel/i.test(head);
    }

    var ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::\d{2})?/;
    var DMY_1_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[\s]+(\d{1,2})\.(\d{2})/;
    var DMY_2_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[\s]+(\d{1,2})[:.](\d{2})/;

    function parseDateCell(cell, allowSerial) {
        if (typeof cell === 'number') {
            // Excel serial date (days since 1899-12-30)
            if (!allowSerial) return null;
            var ms = Math.round((cell - 25569) * 86400 * 1000);
            var d2 = new Date(ms);
            var frac = cell - Math.floor(cell);
            var hh = Math.floor(frac * 24), mi = Math.round((frac * 24 - hh) * 60);
            return { date: d2, minute: hh * 60 + mi };
        }
        var s = String(cell).trim();
        var m = ISO_RE.exec(s);
        if (m) {
            var hh1 = parseInt(m[4], 10), mi1 = parseInt(m[5], 10);
            var y1 = parseInt(m[1], 10), mo1 = parseInt(m[2], 10), d1 = parseInt(m[3], 10);
            var date1 = new Date(y1, mo1 - 1, d1);
            return { date: date1, minute: hh1 * 60 + mi1 };
        }
        m = DMY_2_RE.exec(s);
        if (!m) m = DMY_1_RE.exec(s);
        if (m) {
            var dd = parseInt(m[1], 10), mm = parseInt(m[2], 10), yy = parseInt(m[3], 10);
            if (yy < 100) yy += 2000;
            var hh = parseInt(m[4], 10), mi = parseInt(m[5], 10);
            var base = new Date(yy, mm - 1, dd);
            // แถว "24:00" = ช่วงท้ายวันเดียวกัน (minute=1440) — ไม่ข้ามวัน (กันวันผี)
            return { date: base, minute: hh * 60 + mi };
        }
        var iso2 = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/.exec(s);
        if (iso2) {
            var y2 = parseInt(iso2[1], 10), mo2 = parseInt(iso2[2], 10), d2i = parseInt(iso2[3], 10);
            var hh2 = parseInt(iso2[4], 10), mi2 = parseInt(iso2[5], 10);
            return { date: new Date(y2, mo2 - 1, d2i), minute: hh2 * 60 + mi2 };
        }
        return null;
    }

    function guessColumns(aoa) {
        // look over first ~6 rows for header-ish cells
        for (var hi = 0; hi < Math.min(6, aoa.length); hi++) {
            var row = aoa[hi];
            var dtCol = -1, loadCol = -1;
            for (var c = 0; c < row.length; c++) {
                var txt = String(row[c]).toLowerCase().trim();
                if (dtCol === -1 && /(timestamp|datetime|time|date|เวลา|วันที่|วัน\/เวลา)/.test(txt)) dtCol = c;
                if (loadCol === -1 && /(power|kw|load|โหลด|กิโลวัตต์|กำลัง)/.test(txt)) loadCol = c;
            }
            if (dtCol >= 0 && loadCol >= 0) return { headerIdx: hi, dtCol: dtCol, loadCol: loadCol };
        }
        // fallback: dtCol = first column that parses as date in data rows
        var dtF = -1;
        for (var c2 = 0; c2 < Math.min(10, aoa[0].length); c2++) {
            for (var r = 1; r < Math.min(10, aoa.length); r++) {
                if (parseDateCell(aoa[r][c2], false)) { dtF = c2; break; }
            }
            if (dtF >= 0) break;
        }
        if (dtF < 0) return null;
        var best = null;
        for (var c3 = 0; c3 < aoa[0].length; c3++) {
            if (c3 === dtF) continue;
            var cnt = 0, sum = 0, minV = Infinity;
            for (var r2 = 1; r2 < aoa.length; r2++) {
                var v = toFloat(aoa[r2][c3]);
                if (v === null) continue;
                cnt++; sum += v; if (v < minV) minV = v;
            }
            if (cnt === 0) continue;
            var mean = sum / cnt;
            if (mean < -1e-6) continue;
            var score = { cnt: cnt, mean: mean };
            if (!best || score.cnt > best.score.cnt || (score.cnt === best.score.cnt && score.mean > best.score.mean))
                best = { col: c3, score: score };
        }
        if (!best) return null;
        return { headerIdx: Math.max(0, hi >= 0 ? hi : 0), dtCol: dtF, loadCol: best.col };
    }

    // ---------------------------------------------------------------- summary
    // Analysis bill like the Python app: AMR rows use the file's on/off flags;
    // generic rows use the tariff window split.
    // nDays (ถ้าส่งมา) ใช้ปรับอัตราก้าวหน้า: ขั้นอัตราคิดบนหน่วยต่อเดือน
    // เพราะบิลจริงของการไฟฟ้าเป็นรายเดือน ไฟล์ 10 วันต้องขยายก่อนคิดขั้น
    function analyzeData(data, tariff, nDays) {
        var onKwh = 0, offKwh = 0;
        var rows = data.rows;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var isOn;
            if (data.isPea && r.onPeak === true) isOn = true;
            else if (data.isPea) isOn = false;
            else isOn = (r.minute >= tariff.onPeakStartMin && r.minute < tariff.onPeakEndMin);
            if (isOn) onKwh += r.kw; else offKwh += r.kw;
        }
        onKwh *= DT_HOURS; offKwh *= DT_HOURS;

        var bill;
        if (tariff.mode === 'progressive') {
            bill = billFromKwhPeriod(onKwh + offKwh, nDays, tariff);
        } else {
            bill = billFromKwh(onKwh, offKwh, tariff);
        }
        return { bill: bill, onPeakKwh: onKwh, offPeakKwh: offKwh };
    }

    function summarize(rows, meta, isPea, label) {
        var nDays = 0;
        var days = {};
        var total = 0, peak = -Infinity;
        var intervalCounts = {};
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var key = r.ts.getFullYear() + '-' + r.ts.getMonth() + '-' + r.ts.getDate();
            if (!days[key]) { days[key] = 1; nDays++; }
            total += r.kw;
            if (r.kw > peak) peak = r.kw;
            var ik = String(r.minute);
            intervalCounts[ik] = (intervalCounts[ik] || 0) + 1;
        }
        // battery/interval sanity: interval resolution (min per slot) from date gaps
        var resMin = 15;
        if (rows.length >= 2) {
            var gMin = -1;
            for (var k2 = 1; k2 < rows.length; k2++) {
                var diffMin = (rows[k2].ts - rows[k1(k2, rows)]) / 60000;
                var sameDay = rows[k2].ts.getDate() === rows[k1(k2, rows)].ts.getDate();
                if (sameDay && diffMin > 0 && (gMin === -1 || diffMin < gMin)) gMin = diffMin;
            }
            if (gMin > 0 && gMin < 1440) resMin = gMin;
        }
        var dHours = resMin / 60;
        var totalKwh = total * dHours;
        var tariffHint = null;
        if (meta.tariff && /TOU/i.test(meta.tariff)) tariffHint = 'TOU';

        var periodDays = referencePeriod(nDays);
        var monthlyKwh = periodDays === nDays ? totalKwh * 30 / nDays : totalKwh * 30 / nDays;

        return {
            rows: rows, nDays: nDays, nIntervals: rows.length,
            totalKwh: totalKwh, peakKw: peak, intervalMinutes: resMin,
            metadata: meta, isPea: isPea, tariffHint: tariffHint,
            label: label, monthForPsh: effectiveDefaultMonth(meta)
        };
    }
    function k1(i, rows) { return i - 1; }

    function effectiveDefaultMonth(meta) { return meta.month || 4; }

    // -------------------------------------------------------------- helpers
    function toFloat(v) {
        if (v === null || v === undefined || v === '') return null;
        if (typeof v === 'number') return v;
        var s = String(v).replace(/,/g, '').trim();
        if (s === '') return null;
        var n = Number(s);
        return isNaN(n) ? null : n;
    }
    function multiplyArr(arr, f) { var o = new Float64Array(arr.length); for (var i = 0; i < arr.length; i++) o[i] = arr[i] * f; return o; }
    function minArr(a, b) { var o = new Float64Array(a.length); for (var i = 0; i < a.length; i++) o[i] = Math.min(a[i], b[i]); return o; }
    function subArr(a, b) { var o = new Float64Array(a.length); for (var i = 0; i < a.length; i++) o[i] = a[i] - b[i]; return o; }
    function maxZeroArr(a) { var o = new Float64Array(a.length); for (var i = 0; i < a.length; i++) o[i] = Math.max(a[i], 0); return o; }
    function sumArr(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
    function cloneSettings(s) { return JSON.parse(JSON.stringify(s)); }
    function mergeOpts(a, b) { var o = {}; for (var k in a) o[k] = a[k]; for (var k2 in b) o[k2] = b[k2]; return o; }
    function fmtInt(n) { return n.toLocaleString('en-US'); }
    function fmtMoney(n) { return Math.round(n).toLocaleString('en-US'); }
    function utf8(buf) {
        // decode Uint8Array as UTF-8
        if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(buf);
        var bin = '';
        for (var i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
        return decodeURIComponent(escape(bin));
    }

    return {
        N_INTERVALS: N_INTERVALS, DT_HOURS: DT_HOURS,
        DEFAULT_SETTINGS: DEFAULT_SETTINGS,
        TARIFF_PRESETS: TARIFF_PRESETS, PRESET_ORDER: PRESET_ORDER,
        PRICE_PRESETS: PRICE_PRESETS, SOLAR_PRESET_ORDER: SOLAR_PRESET_ORDER,
        systemPriceFromCurve: systemPriceFromCurve, solarCost: solarCost,
        tariffFromPreset: tariffFromPreset, presetFromTariffCode: presetFromTariffCode,
        buildDailyBell: buildDailyBell,
        billFromKwh: billFromKwh, billFromKwhPeriod: billFromKwhPeriod, billForSeries: billForSeries,
        progressiveCharge: progressiveCharge,
        simulateBattery: simulateBattery,
        computeSizing: computeSizing, simulateScenario: simulateScenario,
        recommendBattery: recommendBattery,
        parseAmrFiles: parseAmrFiles,
        analyzeData: analyzeData,
        buildRepDay: buildRepDay, referencePeriod: referencePeriod,
        scaleRepDay: scaleRepDay, tileProfile: tileProfile,
        monthForPsh: function (data, settings) { return effectiveMonth(data, settings); },
        pshForMonth: pshForMonth,
        toFloat: toFloat, fmtInt: fmtInt, fmtMoney: fmtMoney,
        cloneSettings: cloneSettings
    };
});