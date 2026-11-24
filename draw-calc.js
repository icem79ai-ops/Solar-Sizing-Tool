/* draw-calc.js — คำนวณค่าไฟจากโหลดที่วาดเอง (ความละเอียด 1 ชั่วโมง, 24 ค่า)
 * ใช้ Core (core.js) เดิมทั้งหมด: ช่วง On-Peak / อัตรา / ขั้นก้าวหน้า ตรงกับหน้าหลัก
 * สมมติฐาน: วันทั่วไปเหมือนกันทุกวัน 30 วัน/เดือน
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory(require('./core.js'));
    } else {
        root.DrawCalc = factory(root.Core);
    }
})(typeof self !== 'undefined' ? self : this, function (Core) {
    'use strict';

    var DAYS_PER_MONTH = 30;
    var ON_START_H = 9;   // ตรงกับ DEFAULT_TARIFF.onPeakStartMin = 09:00
    var ON_END_H = 22;    // ตรงกับ DEFAULT_TARIFF.onPeakEndMin = 22:00

    function cleanHourly(hourly) {
        var out = [];
        for (var h = 0; h < 24; h++) {
            var v = Number(hourly && hourly[h]);
            out.push(isFinite(v) && v > 0 ? v : 0);
        }
        return out;
    }

    // รวมพลังงานต่อวัน (kWh) แยก On-Peak / Off-Peak; แต่ละชั่วโมง kW × 1 ชม. = kWh
    function dailyKwh(hourly) {
        var h24 = cleanHourly(hourly);
        var on = 0, off = 0, peak = 0;
        for (var h = 0; h < 24; h++) {
            var v = h24[h];
            if (v > peak) peak = v;
            if (h >= ON_START_H && h < ON_END_H) on += v; else off += v;
        }
        return { onKwh: on, offKwh: off, totalKwh: on + off, peakKw: peak };
    }

    // ค่าไฟต่อเดือนของโปรไฟล์นี้ ด้วยอัตราที่เลือก (preset key)
    function monthlyBill(hourly, presetKey) {
        var tariff = Core.tariffFromPreset(presetKey, Core.DEFAULT_SETTINGS.tariff);
        if (!tariff) throw new Error('ไม่รู้จักอัตรา: ' + presetKey);
        var d = dailyKwh(hourly);
        var bill = Core.billFromKwh(d.onKwh * DAYS_PER_MONTH, d.offKwh * DAYS_PER_MONTH, tariff);
        return {
            preset: presetKey,
            label: Core.TARIFF_PRESETS[presetKey].label,
            daily: d,
            monthlyKwh: d.totalKwh * DAYS_PER_MONTH,
            monthly: bill
        };
    }

    // เปรียบเทียบทุกอัตราพร้อมกัน
    function compareAll(hourly) {
        return Core.PRESET_ORDER.map(function (k) { return monthlyBill(hourly, k); });
    }

    return { dailyKwh: dailyKwh, monthlyBill: monthlyBill, compareAll: compareAll, cleanHourly: cleanHourly };
});
