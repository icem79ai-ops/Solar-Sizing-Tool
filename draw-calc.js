/* draw-calc.js — คำนวณค่าไฟจากโหลดที่วาดเอง (ความละเอียด 15 นาที, 96 ช่วงต่อวัน)
 * ใช้ Core (core.js) เดิม: ช่วง On-Peak / อัตรา / ค่า FT / VAT ตรงกับหน้าหลัก
 * ยังไม่รวม: ค่าดีมานด์ (Demand charge) — เครื่องคำนวณเดิมไม่มี ต้องกำหนดอัตราก่อน
 * สมมติฐาน: ทุกวันเหมือนกัน 30 วัน/เดือน
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./core.js'));
    } else {
        root.DrawCalc = factory(root.Core);
    }
})(typeof self !== 'undefined' ? self : this, function (Core) {
    'use strict';

    var SLOTS = 96;              // 24 ชม. × 4 (ทุก 15 นาที)
    var SLOT_HOURS = 0.25;       // ช่วงละ 15 นาที
    var DAYS_PER_MONTH = 30;
    var ON_START_MIN = 9 * 60;   // ตรงกับ DEFAULT_TARIFF.onPeakStartMin
    var ON_END_MIN = 22 * 60;    // ตรงกับ DEFAULT_TARIFF.onPeakEndMin

    function cleanSlots(slots) {
        var out = [];
        for (var i = 0; i < SLOTS; i++) {
            var v = Number(slots && slots[i]);
            out.push(isFinite(v) && v > 0 ? v : 0);
        }
        return out;
    }

    // รวมพลังงานต่อวัน (kWh) แยก On-Peak / Off-Peak; kW × 0.25 ชม. = kWh ต่อช่วง
    function dailyKwh(slots) {
        var s = cleanSlots(slots);
        var on = 0, off = 0, peak = 0;
        for (var i = 0; i < SLOTS; i++) {
            var v = s[i];
            if (v > peak) peak = v;
            var minute = i * 15;
            if (minute >= ON_START_MIN && minute < ON_END_MIN) on += v * SLOT_HOURS;
            else off += v * SLOT_HOURS;
        }
        return { onKwh: on, offKwh: off, totalKwh: on + off, peakKw: peak };
    }

    // ค่าไฟต่อเดือน (รวม FT และ VAT ตามอัตราที่เลือก; ยังไม่รวมดีมานด์)
    function monthlyBill(slots, presetKey) {
        var tariff = Core.tariffFromPreset(presetKey, Core.DEFAULT_SETTINGS.tariff);
        if (!tariff) throw new Error('ไม่รู้จักอัตรา: ' + presetKey);
        var d = dailyKwh(slots);
        var bill = Core.billFromKwh(d.onKwh * DAYS_PER_MONTH, d.offKwh * DAYS_PER_MONTH, tariff);
        return {
            preset: presetKey,
            label: Core.TARIFF_PRESETS[presetKey].label,
            daily: d,
            monthlyKwh: d.totalKwh * DAYS_PER_MONTH,
            monthly: bill,
            ftRate: tariff.ftRate,
            demandIncluded: false
        };
    }

    function compareAll(slots) {
        return Core.PRESET_ORDER.map(function (k) { return monthlyBill(slots, k); });
    }

    // ขยายโปรไฟล์รายชั่วโมง (24 ค่า) เป็นรายช่วง 15 นาที (96 ค่า)
    function hourlyToSlots(hourly) {
        var out = [];
        for (var h = 0; h < 24; h++) {
            var v = Number(hourly && hourly[h]) || 0;
            for (var k = 0; k < 4; k++) out.push(v);
        }
        return out;
    }

    // ---- อัตราที่มีค่าดีมานด์ (ประเภท 3 กิจการขนาดกลาง, แรงดันไม่เกิน 33 kV)
    // ที่มา: ประกาศ กฟภ. กันยายน 2569 (ข้อ 3.1.2, 3.1.3, 3.2.2, 3.2.3) — ราคาไม่รวม VAT
    // normal: ดีมานด์ = kW สูงสุดทุกช่วงในเดือน · tou: ดีมานด์ Peak = kW สูงสุดช่วง 09:00–22:00
    var DEMAND_TARIFFS = {
        d31:  { label: 'ประเภท 3.1.2 อัตราปกติ (22–33 kV)', kind: 'normal', demandRate: 196.26, energyRate: 3.1471, serviceFee: 312.24 },
        d31s: { label: 'ประเภท 3.1.3 อัตราปกติ (ต่ำกว่า 22 kV)', kind: 'normal', demandRate: 221.50, energyRate: 3.1751, serviceFee: 312.24 },
        d32:  { label: 'ประเภท 3.2.2 TOU (22–33 kV)', kind: 'tou', peakDemandRate: 132.93, peakRate: 4.1839, offRate: 2.6037, serviceFee: 312.24 },
        d32s: { label: 'ประเภท 3.2.3 TOU (ต่ำกว่า 22 kV)', kind: 'tou', peakDemandRate: 210.00, peakRate: 4.3297, offRate: 2.6369, serviceFee: 312.24 }
    };

    // คิดค่าไฟต่อเดือนของอัตราที่มีดีมานด์ (รวม FT และ VAT)
    // ยังไม่รวม: อัตราขั้นต่ำ 70% ของดีมานด์สูงสุด 12 เดือน, ค่า Power Factor, วันหยุดพิเศษ
    function demandBill(slots, key) {
        var t = DEMAND_TARIFFS[key];
        if (!t) throw new Error('ไม่รู้จักอัตราดีมานด์: ' + key);
        var s = cleanSlots(slots);
        var maxAll = 0, maxOn = 0;
        for (var i = 0; i < SLOTS; i++) {
            var minute = i * 15;
            var onPeak = minute >= ON_START_MIN && minute < ON_END_MIN;
            if (s[i] > maxAll) maxAll = s[i];
            if (onPeak && s[i] > maxOn) maxOn = s[i];
        }
        var d = dailyKwh(s);
        var on = d.onKwh * DAYS_PER_MONTH, off = d.offKwh * DAYS_PER_MONTH, total = on + off;
        var demandCharge, energyCharge, demandKw;
        if (t.kind === 'normal') {
            demandKw = maxAll;
            demandCharge = demandKw * t.demandRate;
            energyCharge = total * t.energyRate;
        } else {
            demandKw = maxOn;
            demandCharge = demandKw * t.peakDemandRate;
            energyCharge = on * t.peakRate + off * t.offRate;
        }
        var ft = total * Core.DEFAULT_SETTINGS.tariff.ftRate;
        var subtotal = demandCharge + energyCharge + ft + t.serviceFee;
        var vat = subtotal * Core.DEFAULT_SETTINGS.tariff.vatRate;
        return {
            key: key, label: t.label, demandKw: demandKw, monthlyKwh: total,
            demandCharge: demandCharge, energyCharge: energyCharge, ftCharge: ft,
            serviceFee: t.serviceFee, vat: vat, grandTotal: subtotal + vat,
            demandIncluded: true
        };
    }

    var THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
        'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

    // แปลงโปรไฟล์ที่วาด (96 ช่วง/วัน) ให้เป็นรูปแบบเดียวกับข้อมูลจากไฟล์มิเตอร์
    // เพื่อส่งเข้าขั้นตอนคำนวณเดิมได้ทันที (rows: ts, minute, kw, onPeak)
    function slotsToData(slots, opts) {
        opts = opts || {};
        var s = cleanSlots(slots);
        var month = opts.month || 11, year = opts.year || 2026, nDays = opts.nDays || 30;
        var rows = [], total = 0, peak = 0;
        for (var d = 1; d <= nDays; d++) {
            for (var i = 0; i < SLOTS; i++) {
                var h = Math.floor(i / 4), mi = (i % 4) * 15;
                rows.push({ ts: new Date(year, month - 1, d, h, mi), minute: i * 15, kw: s[i], onPeak: null });
                total += s[i] * SLOT_HOURS;
                if (s[i] > peak) peak = s[i];
            }
        }
        return {
            rows: rows, nDays: nDays, nIntervals: rows.length,
            totalKwh: total, peakKw: peak, intervalMinutes: 15,
            metadata: { month: month, month_th: THAI_MONTHS[month - 1], year: year + 543, label: 'โหลดที่วาดเอง' },
            isPea: false, tariffHint: null, isDrawn: true,
            label: opts.label || 'โหลดที่วาดเอง', monthForPsh: month
        };
    }

    // ================================================================
    // ทะเบียนอัตราค่าไฟ กฟภ. ฉบับ กันยายน 2569 (ราคาไม่รวม VAT)
    // group: residential = บ้านอยู่อาศัย (ไม่มีค่าดีมานด์), business = ประเภท 3 (มีดีมานด์)
    // kind: progressive (ขั้นตามหน่วยรวมเดือน) · tou (On/Off ตามช่วง) · normal (อัตราเดียว+ดีมานด์)
    // ================================================================
    var TARIFFS = {
        r111: { group: 'residential', kind: 'progressive', label: 'บ้าน 1.1.1 อัตราก้าวหน้า (ไม่เกิน 150 หน่วย)',
            tiers: [[15, 2.3488], [25, 2.9882], [200, 3.0], [400, 4.1584], [null, 4.3583]], serviceFee: 8.19 },
        r112: { group: 'residential', kind: 'progressive', label: 'บ้าน 1.1.2 อัตราก้าวหน้า (เกิน 150 หน่วย)',
            tiers: [[200, 3.0], [400, 4.1584], [null, 4.3583]], serviceFee: 24.62 },
        r121: { group: 'residential', kind: 'tou', label: 'บ้าน 1.2.1 TOU (แรงดัน 22–33 kV)',
            peakRate: 5.1135, offRate: 2.6037, serviceFee: 312.24 },
        r122: { group: 'residential', kind: 'tou', label: 'บ้าน 1.2.2 TOU (แรงดันต่ำกว่า 22 kV)',
            peakRate: 5.7982, offRate: 2.6369, serviceFee: 24.62 },
        d31:  { group: 'business', kind: 'normal', label: 'ประเภท 3.1.2 อัตราปกติ (22–33 kV)',
            demandRate: 196.26, energyRate: 3.1471, serviceFee: 312.24 },
        d31s: { group: 'business', kind: 'normal', label: 'ประเภท 3.1.3 อัตราปกติ (ต่ำกว่า 22 kV)',
            demandRate: 221.50, energyRate: 3.1751, serviceFee: 312.24 },
        d32:  { group: 'business', kind: 'tou', label: 'ประเภท 3.2.2 TOU (22–33 kV)',
            demandRate: 132.93, peakRate: 4.1839, offRate: 2.6037, serviceFee: 312.24 },
        d32s: { group: 'business', kind: 'tou', label: 'ประเภท 3.2.3 TOU (ต่ำกว่า 22 kV)',
            demandRate: 210.00, peakRate: 4.3297, offRate: 2.6369, serviceFee: 312.24 }
    };
    var FT_RATE = 0.1623, VAT_RATE = 0.07;   // ค่า Ft และ VAT ของ กฟภ. (ปรับได้ที่ argument)

    // คิดค่าไฟ 1 เดือนของโปรไฟล์ 96 ช่วง/วัน (30 วัน) แยกรายการ
    // คืนค่า items = รายการที่ประกอบเป็นบิล (ไว้แสดงกราฟแท่งสัดส่วน)
    // ใช้ค่าที่ผู้ใช้แก้เอง (ทับค่าประกาศ) โดยไม่แก้ทะเบียนต้นฉบับ
    function applyOverrides(t, ov) {
        var out = JSON.parse(JSON.stringify(t));
        if (!ov) return out;
        ['peakRate', 'offRate', 'energyRate', 'demandRate', 'serviceFee'].forEach(function (k) {
            if (ov[k] !== undefined && ov[k] !== null && isFinite(Number(ov[k]))) out[k] = Number(ov[k]);
        });
        if (Array.isArray(ov.tierRates) && out.tiers) {
            out.tiers = out.tiers.map(function (r, i) {
                var v = Number(ov.tierRates[i]);
                return [r[0], isFinite(v) ? v : r[1]];
            });
        }
        return out;
    }

    function billBreakdown(slots, key, opts) {
        if (!TARIFFS[key]) throw new Error('ไม่รู้จักอัตรา: ' + key);
        opts = opts || {};
        var t = applyOverrides(TARIFFS[key], opts.ov);
        var ft = opts.ftRate === undefined ? FT_RATE : opts.ftRate;
        var vr = opts.vatRate === undefined ? VAT_RATE : opts.vatRate;
        var s = cleanSlots(slots);
        var d = dailyKwh(s);
        var on = d.onKwh * DAYS_PER_MONTH, off = d.offKwh * DAYS_PER_MONTH, total = on + off;
        var items = [], demandKw = 0;

        if (t.kind === 'progressive') {
            items.push({ key: 'energy', label: 'ค่าพลังงาน (ขั้นอัตราก้าวหน้า)', amount: Core.progressiveCharge(total, t.tiers) });
        } else if (t.kind === 'tou') {
            if (t.demandRate !== undefined) {
                demandKw = maxIn(s, true);
                items.push({ key: 'demand', label: 'ค่าดีมานด์ (Peak ' + demandKw.toFixed(1) + ' kW)', amount: demandKw * t.demandRate });
            }
            items.push({ key: 'energy', label: 'ค่าพลังงาน On-Peak ' + on.toFixed(0) + ' + Off-Peak ' + off.toFixed(0) + ' kWh',
                amount: on * t.peakRate + off * t.offRate });
        } else { // normal (ธุรกิจ)
            demandKw = maxIn(s, false);
            items.push({ key: 'demand', label: 'ค่าดีมานด์ (สูงสุด ' + demandKw.toFixed(1) + ' kW)', amount: demandKw * t.demandRate });
            items.push({ key: 'energy', label: 'ค่าพลังงาน ' + total.toFixed(0) + ' kWh', amount: total * t.energyRate });
        }
        items.push({ key: 'service', label: 'ค่าบริการรายเดือน', amount: t.serviceFee });
        items.push({ key: 'ft', label: 'ค่า Ft (' + ft + ' บาท/kWh)', amount: total * ft });
        var subtotal = items.reduce(function (a, x) { return a + x.amount; }, 0);
        var vat = subtotal * vr;
        items.push({ key: 'vat', label: 'ภาษีมูลค่าเพิ่ม ' + (vr * 100).toFixed(0) + '%', amount: vat });
        return {
            key: key, label: t.label, group: t.group, kind: t.kind,
            monthlyKwh: total, onKwh: on, offKwh: off, demandKw: demandKw,
            items: items, subtotal: subtotal, vat: vat, total: subtotal + vat,
            demandApplies: t.demandRate !== undefined
        };
    }

    // kW สูงสุด: onlyPeak=true ใช้เฉพาะช่วง 09:00–22:00
    function maxIn(s, onlyPeak) {
        var m = 0;
        for (var i = 0; i < SLOTS; i++) {
            var minute = i * 15;
            var inPeak = minute >= ON_START_MIN && minute < ON_END_MIN;
            if ((!onlyPeak || inPeak) && s[i] > m) m = s[i];
        }
        return m;
    }

    // รายเดือน 12 เดือน (แต่ละเดือนมีโปรไฟล์ของตัวเอง หรือใช้ชุดเดียวกันก็ได้)
    function annualBills(monthlySlots, key, opts) {
        var out = [];
        for (var m = 0; m < 12; m++) out.push(billBreakdown(monthlySlots[m], key, opts));
        var sum = 0; for (var k = 0; k < 12; k++) sum += out[k].total;
        return { months: out, annualTotal: sum };
    }

    // อัตราของ กฟภ. ในรูปแบบที่เครื่องคำนวณหลัก (core.js) ใช้ได้
    // หมายเหตุ: อัตราดีมานด์ยังไม่อยู่ในเครื่องหลัก ใช้แสดงผลเฉพาะหน้านี้
    function toCoreTariff(key, base, ov) {
        if (!TARIFFS[key]) throw new Error('ไม่รู้จักอัตรา: ' + key);
        var t = applyOverrides(TARIFFS[key], ov);
        var b = JSON.parse(JSON.stringify(base));
        if (t.kind === 'progressive') {
            b.mode = 'progressive';
            b.progTiers = t.tiers.map(function (r) { return [r[0], r[1]]; });
            b.progServiceFee = t.serviceFee;
        } else if (t.kind === 'tou') {
            b.mode = 'tou';
            b.onPeakRate = t.peakRate; b.offPeakRate = t.offRate; b.serviceFee = t.serviceFee;
        } else {
            b.mode = 'flat';
            b.flatRate = t.energyRate; b.serviceFee = t.serviceFee;
        }
        b.preset = key;
        return b;
    }

    // โปรไฟล์เฉลี่ย 12 เดือน (ใช้ป้อนเครื่องคำนวณขนาดโซลาร์แบบเดิม)
    function averageSlots(monthlySlots) {
        var avg = Array(SLOTS).fill(0);
        for (var m = 0; m < 12; m++) {
            var s = cleanSlots(monthlySlots[m]);
            for (var i = 0; i < SLOTS; i++) avg[i] += s[i] / 12;
        }
        return avg;
    }

    return {
        TARIFFS: TARIFFS, applyOverrides: applyOverrides, toCoreTariff: toCoreTariff, billBreakdown: billBreakdown, annualBills: annualBills, averageSlots: averageSlots,
        slotsToData: slotsToData, THAI_MONTHS: THAI_MONTHS,
        DEMAND_TARIFFS: DEMAND_TARIFFS, demandBill: demandBill,
        SLOTS: SLOTS, dailyKwh: dailyKwh, monthlyBill: monthlyBill,
        compareAll: compareAll, cleanSlots: cleanSlots, hourlyToSlots: hourlyToSlots
    };
});
