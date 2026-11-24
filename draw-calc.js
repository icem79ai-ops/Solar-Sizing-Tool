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

    return {
        DEMAND_TARIFFS: DEMAND_TARIFFS, demandBill: demandBill,
        SLOTS: SLOTS, dailyKwh: dailyKwh, monthlyBill: monthlyBill,
        compareAll: compareAll, cleanSlots: cleanSlots, hourlyToSlots: hourlyToSlots
    };
});
