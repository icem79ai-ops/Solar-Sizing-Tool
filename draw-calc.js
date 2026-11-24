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

    return {
        SLOTS: SLOTS, dailyKwh: dailyKwh, monthlyBill: monthlyBill,
        compareAll: compareAll, cleanSlots: cleanSlots, hourlyToSlots: hourlyToSlots
    };
});
