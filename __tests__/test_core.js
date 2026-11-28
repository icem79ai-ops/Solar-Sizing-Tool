/* Node regression test for core.js against known Python results.
 * Run: node __tests__/test_core.js
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('../lib/xlsx.full.min.js');
const Core = require('../core.js');

const DOWN = 'C:/Users/icem79/Downloads';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('[OK] ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
    else { fail++; console.log('[FAIL] ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

const S = Core.cloneSettings(Core.DEFAULT_SETTINGS);
// ชุดทดสอบเดิม pin กับราคา 40,000 ฿/kWp (regression จาก Python) — ล็อกโหมดกำหนดเอง
// ชุดทดสอบราคาจริงจากใบเสนอราคา (price presets) อยู่ท้ายไฟล์
S.solar.pricePreset = 'custom';

// ---------- TOU file (frameset + sidecar) ----------
const pea = [
    { name: 'kW02001943440604092026003043.xls', content: fs.readFileSync(path.join(DOWN, 'kW02001943440604092026003043.xls')) },
    { name: 'sheet001.htm', content: fs.readFileSync(path.join(DOWN, 'kW02001943440604092026003043_files', 'sheet001.htm')) }
];
const tou = Core.parseAmrFiles(pea, XLSX);
ok('TOU: no parse error', !tou.error, tou.error);
if (!tou.error) {
    ok('TOU: nDays=18 (แก้แถว 24:00 ไม่ข้ามวัน — ไม่มีวันผี)', tou.nDays === 18, tou.nDays);
    ok('TOU: total ~8167 kWh', near(tou.totalKwh, 8167, 5), tou.totalKwh.toFixed(1));
    ok('TOU: peak ~48.5 kW', near(tou.peakKw, 48.5, 0.5), tou.peakKw.toFixed(2));
    ok('TOU: metadata month=4', tou.metadata.month === 4, tou.metadata.month_th);

    // raw-data analysis bill (flag-based): ~36,269
    const ana = Core.analyzeData(tou, S.tariff);
    ok('TOU: analysis bill ~36,269', near(ana.bill.grandTotal, 36269, 15), ana.bill.grandTotal.toFixed(2));

    // sizing (on-grid): bill_before ~36,064, rec 12 kWp
    const sizeTou = Core.computeSizing(tou, { settings: S, mode: 'ongrid' });
    ok('TOU: scheduling bill ~36,250 (ระยะ 18 วันทำการ)', near(sizeTou.rows[0].billBefore, 36250, 20), sizeTou.rows[0].billBefore.toFixed(2));
    ok('TOU: rec=15 kWp (หน่วยคืนทุนจริง — เกณฑ์ 10 ปีใช้ได้จริง)', sizeTou.recommended && Math.abs(sizeTou.recommended.sizeKwp - 15) < 0.01,
        sizeTou.recommended && sizeTou.recommended.sizeKwp);
    const r12 = sizeTou.rows.find(r => Math.abs(r.sizeKwp - 12) < 0.01);
    ok('TOU: ongrid 12kWp savings ~4,971 (ระยะ 18 วันทำการ)', near(r12.savingsThb, 4971, 12), r12.savingsThb.toFixed(1));
    const r10 = sizeTou.rows.find(r => Math.abs(r.sizeKwp - 10) < 0.01);
    ok('TOU: ongrid 10kWp savings ~4,503 (ระยะ 18 วันทำการ)', near(r10.savingsThb, 4503, 12), r10.savingsThb.toFixed(1));

    // hybrid scenario 10kWp + 15kWh -> 6,109
    const bat = { capacityKwh: 15, dod: 0.8, efficiency: 0.9, initialSoc: 0.5 };
    const scen = Core.simulateScenario(tou, 10, { settings: S, mode: 'hybrid', battery: bat });
    ok('TOU: hybrid 10kWp+15kWh savings ~4,836 (ระยะ 18 วันทำการ)', near(scen.savings, 4836, 12), scen.savings.toFixed(1));
    // daily grid at 00:00 low (battery covers), battery_discharge present
    ok('TOU: hybrid daily has battery traces', !!scen.daily.batteryDischarge && !!scen.daily.batteryCharge);

    // battery recommendation for 12 kWp -> 15 kWh
    const rec = Core.recommendBattery(tou, 12, { settings: S });
    ok('TOU: recommend battery 10 kWh (12kWp — หน่วยเดือนจริง)', rec.bestCapacityKwh === 10, rec.bestCapacityKwh + ' kWh');

    // ---- tariff modes (analysis bill) ----
    const tProg = Core.cloneSettings(S); tProg.tariff.mode = 'progressive';
    const tFlat = Core.cloneSettings(S); tFlat.tariff.mode = 'flat';
    const aProg = Core.analyzeData(tou, tProg.tariff);
    const aFlat = Core.analyzeData(tou, tFlat.tariff);
    ok('PROG: analysis bill ~39,187', near(aProg.bill.grandTotal, 39187, 15), aProg.bill.grandTotal.toFixed(2));
    ok('PROG: service fee = 24.62', near(aProg.bill.serviceFee, 24.62, 0.01), aProg.bill.serviceFee.toFixed(2));
    ok('PROG: energy ~35,273', near(aProg.bill.energyCharge, 35273, 15), aProg.bill.energyCharge.toFixed(2));
    ok('FLAT: analysis bill ~38,040', near(aFlat.bill.grandTotal, 38040, 15), aFlat.bill.grandTotal.toFixed(2));
    ok('PROG: custom tier changes bill (tier1=1.0)',
        near(Core.progressiveCharge(8167, [[15, 1], [25, 2.9882], [200, 3], [400, 4.1584], [null, 4.3583]]), 35252.48, 0.5),
        Core.progressiveCharge(8167, [[15, 1], [25, 2.9882], [200, 3], [400, 4.1584], [null, 4.3583]]).toFixed(2));
    ok('PROG: progressive > TOU > flat ordering', aProg.bill.grandTotal > 38040 && aFlat.bill.grandTotal > 36269,
        aProg.bill.grandTotal.toFixed(0) + ' / ' + aFlat.bill.grandTotal.toFixed(0));

    // ---- presets (อัตรามาตรฐานจาก modules/tariff.py) ----
    ok('PRESET: 4 presets exported', Core.PRESET_ORDER.length === 4, Core.PRESET_ORDER.join(','));
    const p3 = Core.tariffFromPreset('prog3', S.tariff);
    ok('PRESET prog3: mode=progressive', p3.mode === 'progressive', p3.mode);
    ok('PRESET prog3: 3 tiers, svc 24.62', p3.progTiers.length === 3 && near(p3.progServiceFee, 24.62, 1e-9),
        p3.progTiers.map(t => t[1]).join('/') + ' svc ' + p3.progServiceFee);
    const p5 = Core.tariffFromPreset('prog5', S.tariff);
    ok('PRESET prog5: 5 tiers, svc 8.19', p5.progTiers.length === 5 && near(p5.progServiceFee, 8.19, 1e-9),
        p5.progTiers.map(t => t[1]).join('/') + ' svc ' + p5.progServiceFee);
    ok('PRESET prog5: first tier 2.3488 / last 4.3583',
        near(p5.progTiers[0][1], 2.3488, 1e-9) && near(p5.progTiers[4][1], 4.3583, 1e-9));
    const pTou = Core.tariffFromPreset('tou', S.tariff);
    ok('PRESET tou: keeps Ft/VAT/window from base',
        pTou.ftRate === S.tariff.ftRate && pTou.vatRate === S.tariff.vatRate &&
        pTou.onPeakStartMin === S.tariff.onPeakStartMin && pTou.onPeakEndMin === S.tariff.onPeakEndMin,
        pTou.ftRate + '/' + pTou.vatRate);
    ok('PRESET tou: rates 5.7982 / 2.6369 / svc 87.44',
        near(pTou.onPeakRate, 5.7982, 1e-9) && near(pTou.offPeakRate, 2.6369, 1e-9) && near(pTou.serviceFee, 87.44, 1e-9));

    // ---- auto-detect จากช่อง Tariff ในไฟล์ ----
    ok('DETECT: TOU -> tou', Core.presetFromTariffCode('TOU') === 'tou');
    ok('DETECT: 1.1.1 -> prog5', Core.presetFromTariffCode('1.1.1') === 'prog5');
    ok('DETECT: 1.1.2 -> prog3', Core.presetFromTariffCode('1.1.2') === 'prog3');
    ok('DETECT: 3.2.2 -> tou', Core.presetFromTariffCode('3.2.2') === 'tou');
    ok('DETECT: null -> null', Core.presetFromTariffCode(null) === null);

    // ---- อัตราก้าวหน้า: ขั้นคิดบนหน่วยต่อเดือน (nDays) ----
    const ana3 = Core.analyzeData(tou, p3, tou.nDays);
    ok('PROG/MONTH: tierScaled flag', ana3.bill.tierScaled === true);
    ok('PROG/MONTH: monthly kWh = period*30/nDays',
        near(ana3.bill.monthlyTotalKwh, (ana3.bill.totalKwh * 30 / tou.nDays), 0.01),
        ana3.bill.monthlyTotalKwh.toFixed(1));
    ok('PROG/MONTH: monthly bill > period-only bill',
        ana3.bill.monthlyGrandTotal > aProg.bill.grandTotal,
        ana3.bill.monthlyGrandTotal.toFixed(0) + ' vs ' + aProg.bill.grandTotal.toFixed(0));
    // ไม่ส่ง nDays = พฤติกรรมเดิม (ขั้นคิดบนหน่วยของช่วงข้อมูล เท่ากับ Python)
    const ana3raw = Core.analyzeData(tou, p3);
    const legacy = Core.billFromKwh(ana3.onPeakKwh + ana3.offPeakKwh, 0, p3);
    ok('PROG/MONTH: no nDays keeps legacy bill', near(ana3raw.bill.grandTotal, legacy.grandTotal, 0.01),
        ana3raw.bill.grandTotal.toFixed(2) + ' vs ' + legacy.grandTotal.toFixed(2));
    ok('PROG/MONTH: legacy under-charges vs true monthly',
        ana3raw.bill.grandTotal < ana3.bill.monthlyGrandTotal * tou.nDays / 30,
        ana3raw.bill.grandTotal.toFixed(0) + ' < ' + (ana3.bill.monthlyGrandTotal * tou.nDays / 30).toFixed(0));
}

// ---------- household BIG file (ISO 1-day) ----------
const bigFile = fs.readFileSync(path.join(DOWN, '_ A_load_profile.xlsx'));
const big = Core.parseAmrFiles([{ name: '_ A_load_profile.xlsx', content: bigFile }], XLSX);
ok('BIG: no parse error', !big.error, big.error);
if (!big.error) {
    ok('BIG: nDays=1', big.nDays === 1, big.nDays);
    ok('BIG: peak ~7.39', near(big.peakKw, 7.39, 0.1), big.peakKw.toFixed(2));
    ok('BIG: total ~79.9 kWh', near(big.totalKwh, 79.9, 1), big.totalKwh.toFixed(1));
    const t = Core.cloneSettings(S); t.tariff.mode = 'tou';
    const sr = Core.computeSizing(big, { settings: t, mode: 'ongrid' });
    ok('BIG: periodDays=30', sr.periodDays === 30, sr.periodDays);
    ok('BIG: recommended exists', !!sr.recommended, sr.recommended && sr.recommended.sizeKwp + ' kWp');
    const idx = sr.rows.map(r => r.sizeKwp);
    ok('BIG: sizes present', idx.indexOf(3) >= 0 && idx.indexOf(5) >= 0);
}

// ---------- household HB file (many zeros) ----------
const hbFile = fs.readFileSync(path.join(DOWN, 'HB_load_profile.xlsx'));
const hb = Core.parseAmrFiles([{ name: 'HB_load_profile.xlsx', content: hbFile }], XLSX);
ok('HB: no parse error', !hb.error, hb.error);
if (!hb.error) {
    ok('HB: nDays=1', hb.nDays === 1, hb.nDays);
    ok('HB: peak ~1.94', near(hb.peakKw, 1.94, 0.1), hb.peakKw.toFixed(2));
    ok('HB: total ~11.5 kWh', near(hb.totalKwh, 11.5, 0.5), hb.totalKwh.toFixed(1));
}

// ---------- solar profile sanity ----------
const bell = Core.buildDailyBell(5.8, 0.25);
let sum = 0; for (let i = 0; i < bell.length; i++) sum += bell[i];
ok('bell: sum*0.25 = PSH*(1-loss) = 4.35', Math.abs(sum * 0.25 - 4.35) < 1e-9, (sum * 0.25).toFixed(5));
ok('bell: zero before 07:00 & after 17:00', bell[25] === 0 && bell[70] === 0);

// ---------- price presets (ใบเสนอราคาจริง 2569: Huawei/Deye + LONGi) ----------
ok('PRICE: 6 presets exported', Core.SOLAR_PRESET_ORDER.length === 6, Core.SOLAR_PRESET_ORDER.join(','));
// hw3 แทรกเชิงเส้น @12 kWp = 283,470 + (12-10)/(15-10) × (375,670-283,470) = 320,350
ok('PRICE: hw3 @12kWp = 320,350', near(Core.solarCost(12, { pricePreset: 'hw3' }), 320350, 1),
    Core.solarCost(12, { pricePreset: 'hw3' }).toFixed(0));
ok('PRICE: hw3 @10kWp ตรงจุด = 283,470', near(Core.solarCost(10, { pricePreset: 'hw3' }), 283470, 1e-9),
    Core.solarCost(10, { pricePreset: 'hw3' }).toFixed(0));
// นอกช่วงบน: 458,700 + 5 × (458,700-375,670)/5 = 541,730
ok('PRICE: hw3 @25kWp extrapolate = 541,730', near(Core.solarCost(25, { pricePreset: 'hw3' }), 541730, 1),
    Core.solarCost(25, { pricePreset: 'hw3' }).toFixed(0));
// ใต้ช่วงล่าง: 171,600 - 2 × (279,365.63-171,600)/5 = 128,493.75
ok('PRICE: hw1 @3kWp extrapolate = 128,493.75', near(Core.solarCost(3, { pricePreset: 'hw1' }), 128493.75, 1),
    Core.solarCost(3, { pricePreset: 'hw1' }).toFixed(2));
ok('PRICE: custom = ฿/kWp เดียว', near(Core.solarCost(10, { pricePerKwp: 40000 }), 400000, 1e-9),
    Core.solarCost(10, { pricePerKwp: 40000 }).toFixed(0));
ok('PRICE: deye1 @8kWp ตรงจุด = 254,430', near(Core.solarCost(8, { pricePreset: 'deye1' }), 254430, 1e-9),
    Core.solarCost(8, { pricePreset: 'deye1' }).toFixed(0));
// sizing ใช้ preset ผ่าน settings: invest แถว 12 kWp = 320,350 และคืนทุนดีขึ้นกว่า 40k/kWp
{
    const tp = Core.cloneSettings(S); tp.solar.pricePreset = 'hw3';
    const sp = Core.computeSizing(tou, { settings: tp, mode: 'ongrid' });
    const r12p = sp.rows.find(r => Math.abs(r.sizeKwp - 12) < 0.01);
    ok('PRICE: sizing invest 12kWp = 320,350', near(r12p.investment, 320350, 1), r12p.investment.toFixed(0));
    const sLeg = Core.computeSizing(tou, { settings: S, mode: 'ongrid' }); // S = custom 40k/kWp
    const r12leg = sLeg.rows.find(r => Math.abs(r.sizeKwp - 12) < 0.01);
    ok('PRICE: payback 12kWp ดีขึ้นกว่า 40k/kWp', r12p.paybackMonths < r12leg.paybackMonths,
        r12p.paybackMonths.toFixed(1) + ' vs ' + r12leg.paybackMonths.toFixed(1) + ' mo');
    ok('PRICE: recommended ยังมีค่า', !!sp.recommended, sp.recommended && sp.recommended.sizeKwp + ' kWp');
}

// ---------- battery: โหลดต่อเนื่อง >= โซลาร์ (ไม่มีไฟเหลือชาร์จแบต) ----------
// โหลดเรียบ 6 kW 24 ชม. × 7 วัน — โซลาร์ 5 kWp พีค ~4.4 kW < 6 kW ทุกช่วง
{
    const rowsF = [];
    for (let d = 0; d < 7; d++) {
        for (let i = 0; i < 96; i++) {
            rowsF.push({ ts: new Date(2026, 3, d + 1), minute: i * 15, kw: 6, onPeak: i * 15 >= 540 && i * 15 < 1320 });
        }
    }
    const flat = { rows: rowsF, nDays: 7, nIntervals: rowsF.length, totalKwh: 1008, peakKw: 6,
        intervalMinutes: 15, metadata: { month: 4 }, isPea: true, label: 'flat6kW' };
    // แบตเริ่มว่าง (initialSoc default 0 — steady-state ไม่มีไฟฟรี)
    const bat10 = { capacityKwh: 10, dod: 0.8, efficiency: 0.9, initialSoc: 0 };
    const onF = Core.computeSizing(flat, { settings: S, mode: 'ongrid' });
    const hF = Core.computeSizing(flat, { settings: S, mode: 'hybrid', battery: bat10 });
    const r5h = hF.rows.find(r => r.sizeKwp === 5);
    const r5o = onF.rows.find(r => r.sizeKwp === 5);
    ok('BATT/FLAT: ไม่มีไฟเหลือ — แบตชาร์จ 0 kWh', r5h.batteryChargeKwh === 0, r5h.batteryChargeKwh.toFixed(3));
    ok('BATT/FLAT: SoC = 0% ตลอด (ไม่มีอะไรให้ชาร์จ)', r5h.batterySocMax === 0, (r5h.batterySocMax * 100).toFixed(1) + '%');
    ok('BATT/FLAT: savings hybrid = ongrid เป๊ะ (แบตไม่สร้างประหยัด)',
        Math.abs(r5h.savingsThb - r5o.savingsThb) < 0.01, (r5h.savingsThb - r5o.savingsThb).toFixed(3) + ' ฿');
    ok('BATT/FLAT: คืนทุนแย่กว่า ongrid (ค่าแบตเปล่าประโยชน์)', r5h.paybackMonths > r5o.paybackMonths,
        r5h.paybackMonths.toFixed(0) + ' vs ' + r5o.paybackMonths.toFixed(0) + ' mo');
    // เคสที่ผู้ใช้รายงาน: เลื่อนแบตใหญ่ขึ้นเรื่อย ๆ ต้องไม่ทำให้ประหยัดขยับ (คืนทุนแย่ลงอย่างเดียว)
    const h50 = Core.computeSizing(flat, { settings: S, mode: 'hybrid', sizes: [5],
        battery: { capacityKwh: 50, dod: 0.8, efficiency: 0.9 } }).rows[0];
    ok('BATT/FLAT: แบต 10→50 kWh ประหยัดยังเท่า ongrid เป๊ะ',
        Math.abs(h50.savingsThb - r5o.savingsThb) < 0.01, (h50.savingsThb - r5o.savingsThb).toFixed(3) + ' ฿');
    ok('BATT/FLAT: แบตยิ่งใหญ่ คืนทุนยิ่งช้า (เพดานเดียวกัน)', h50.paybackMonths > r5h.paybackMonths,
        h50.paybackMonths.toFixed(0) + ' > ' + r5h.paybackMonths.toFixed(0) + ' mo');
    const hF15 = Core.computeSizing(flat, { settings: S, mode: 'hybrid', sizes: [15], battery: bat10 });
    ok('BATT/FLAT: โซลาร์ 15kWp เริ่มมีไฟเหลือ → แบตชาร์จได้', hF15.rows[0].batteryChargeKwh > 0,
        hF15.rows[0].batteryChargeKwh.toFixed(1) + ' kWh');
    const scenF = Core.simulateScenario(flat, 5, { settings: S, mode: 'hybrid', battery: bat10 });
    ok('BATT/FLAT: simulateScenario รายงาน charge=0 discharge=0',
        scenF.batteryChargeKwh === 0 && scenF.batteryDischargeKwh === 0,
        scenF.batteryChargeKwh + ' / ' + scenF.batteryDischargeKwh.toFixed(1));

    // แนะนำแบตเมื่อไม่ผ่านเกณฑ์: เหตุผลต้องละเอียด + มีขนาด "ไม่สนเกณฑ์ 10 ปี" ให้
    const recFlat = Core.recommendBattery(flat, 5, { settings: S });
    ok('BATT/REJ: ไม่มีไฟเหลือ → เหตุผลระบุชัด (ไม่ผลิตเกินโหลด)',
        recFlat.bestCapacityKwh === 0 && /ไม่ผลิตเกินโหลด/.test(recFlat.note), recFlat.note.slice(0, 70));
    ok('BATT/REJ: ไม่มีขนาดที่ควรติดแม้ไม่สนเกณฑ์ 10 ปี (ประโยชน์ ~0)', recFlat.bestAnywayCapacityKwh === 0,
        String(recFlat.bestAnywayCapacityKwh));
    const recSlow = Core.recommendBattery(flat, 15, { settings: S, batteryPricePerKwh: 300000 });
    ok('BATT/REJ: มีไฟเหลือแต่คืนทุนช้ากว่า 10 ปี → เหตุผลระบุชัด',
        recSlow.bestCapacityKwh === 0 && /ช้ากว่าเกณฑ์ 10 ปี/.test(recSlow.note), recSlow.note.slice(0, 70));
    ok('BATT/REJ: ยังแนะนำขนาดดีที่สุดแบบไม่สนเกณฑ์ (bestAnyway)',
        recSlow.bestAnywayCapacityKwh > 0 && isFinite(recSlow.bestAnywayPaybackMonths),
        recSlow.bestAnywayCapacityKwh + ' kWh @ ' + (recSlow.bestAnywayPaybackMonths / 12).toFixed(1) + 'y');
}

// ---------- reserve (โซนสำรองไฟดับ — เก็บนิ่ง ไม่เข้าการคิดความคุ้มค่า) ----------
{
    const batFull = { capacityKwh: 10, dod: 0.8, efficiency: 0.9, initialSoc: 0 };
    const rFull = Core.computeSizing(tou, { settings: S, mode: 'hybrid', sizes: [12], battery: batFull }).rows[0];
    const rRes = Core.computeSizing(tou, { settings: S, mode: 'hybrid', sizes: [12],
        battery: Object.assign({}, batFull, { reserveFrac: 0.5 }) }).rows[0];
    const rEq = Core.computeSizing(tou, { settings: S, mode: 'hybrid', sizes: [12],
        battery: { capacityKwh: 3.75, dod: 0.8, efficiency: 0.9, initialSoc: 0 } }).rows[0];
    // 10 kWh @สำรอง 50% → วนใช้ 10×0.8 − 10×0.5 = 3 kWh ≡ แบต 3.75 kWh @DoD 0.8
    ok('RESERVE: 10kWh@50% ≈ แบต 3.75kWh (วนใช้ 3 kWh เท่ากัน)', near(rRes.savingsThb, rEq.savingsThb, 1),
        rRes.savingsThb.toFixed(1) + ' vs ' + rEq.savingsThb.toFixed(1));
    ok('RESERVE: ประหยัดลดลงเมื่อสำรอง 50%', rRes.savingsThb < rFull.savingsThb,
        rFull.savingsThb.toFixed(1) + ' → ' + rRes.savingsThb.toFixed(1));
    ok('RESERVE: ลงทุนคงเดิม (ซื้อทั้งก้อน) คืนทุนแย่ลง',
        near(rRes.investment, rFull.investment, 1e-6) && rRes.paybackMonths > rFull.paybackMonths,
        rRes.paybackMonths.toFixed(0) + ' > ' + rFull.paybackMonths.toFixed(0) + ' mo');
    const r80 = Core.computeSizing(tou, { settings: S, mode: 'hybrid', sizes: [12],
        battery: Object.assign({}, batFull, { reserveFrac: 0.8 }) }).rows[0];
    const rOn = Core.computeSizing(tou, { settings: S, mode: 'ongrid', sizes: [12] }).rows[0];
    ok('RESERVE: สำรอง 80% → วนใช้ไม่ได้ → ประหยัดเท่า On-Grid เป๊ะ', near(r80.savingsThb, rOn.savingsThb, 0.01),
        r80.savingsThb.toFixed(1) + ' vs ' + rOn.savingsThb.toFixed(1));
}

// ---------- day-count fix: แถว 24:00 ไม่ข้ามวัน (ไม่มีวันผี) + คืนทุนเป็นเดือนจริง ----------
{
    const per = {};
    tou.rows.forEach(r => { const k = r.ts.getFullYear() + '-' + r.ts.getMonth() + '-' + r.ts.getDate(); per[k] = (per[k] || 0) + 1; });
    const counts = Object.values(per);
    ok('DAYFIX: จำนวนวันที่มีข้อมูล = 18', counts.length === 18, counts.length);
    ok('DAYFIX: ไม่มีวันผี (ทุกวันที่มีข้อมูล ≥ 90 แถว)', Math.min(...counts) >= 90, Math.min(...counts));
    ok('DAYFIX: แถว 24:00 อยู่วันเดิม (minute=1440)', tou.rows.some(r => r.minute === 1440), 'minute=1440 present');
    const sizeTou2 = Core.computeSizing(tou, { settings: S, mode: 'ongrid', sizes: [12] });
    ok('DAYFIX: คืนทุน 12kWp = เดือนจริง (~58 เดือน, ไม่ผูกกับความยาวไฟล์)',
        near(sizeTou2.rows[0].paybackMonths, 480000 / (4971.1 * 30 / 18), 2), sizeTou2.rows[0].paybackMonths.toFixed(1) + ' mo');
}

// ---------- lock mode: ดึง/ดันมวลคงที่ (หน้าวาดโหลด โหมดล็อค kWh/เดือน) ----------
const DrawCalc = require('../draw-calc.js');
{
    const slots = new Array(96).fill(10); // แบน 10 kW = 240 kWh/วัน
    const kw = DrawCalc.pullPushMass(slots, 40, 49, 20); // ดึงช่วง 40-49 ขึ้นเป็น 20 kW
    for (let i = 40; i <= 49; i++) slots[i] = kw; // ตัววาดใส่ค่าที่ได้ลงช่วงที่ลาก
    const tot = slots.reduce((a, b) => a + b, 0) * 0.25;
    ok('LOCK: มวลรวมคงเดิมหลังดึง (240 kWh/วัน)', near(tot, 240, 1e-6), tot.toFixed(2));
    ok('LOCK: ช่วงที่ดึงได้ 20 kW เต็ม (มวลพอ)', near(kw, 20, 1e-6), kw.toFixed(1));
    ok('LOCK: ส่วนอื่นยวบลง (10 → ต่ำกว่า 10)', slots[0] < 10, slots[0].toFixed(2));
    const kw2 = DrawCalc.pullPushMass(slots, 40, 49, 0); // ดันช่วงเดิมลงเป็น 0
    for (let i = 40; i <= 49; i++) slots[i] = kw2;
    const tot2 = slots.reduce((a, b) => a + b, 0) * 0.25;
    ok('LOCK: มวลรวมคงเดิมหลังดัน', near(tot2, 240, 1e-6), tot2.toFixed(2));
    ok('LOCK: ดันลง 0 → ส่วนอื่นสูงขึ้น', near(kw2, 0, 1e-9) && slots[0] > 10, slots[0].toFixed(2));
    // ดึงเกินมวลทั้งกราฟ → จำกัดที่ระดับที่มวลอนุญาต (เกินเป้าไม่ได้ในโครงสร้าง)
    const slots3 = new Array(96).fill(0);
    slots3[0] = 24; // มวลทั้งกราฟมีแค่ 6 kWh
    const kw3 = DrawCalc.pullPushMass(slots3, 1, 2, 100); // อยากได้ 100 kW × 2 ช่วง = 50 kWh (ไม่พอ)
    slots3[1] = kw3; slots3[2] = kw3; // ตัววาดใส่ค่าที่ได้ลงช่วงที่ลาก
    const tot3 = slots3.reduce((a, b) => a + b, 0) * 0.25;
    ok('LOCK: ดึงเกินมวล → จำกัดที่ 12 kW (6 kWh ÷ 2 ช่วง)', near(kw3, 12, 1e-6), kw3.toFixed(1));
    ok('LOCK: มวลรวมยังคงเดิม (6 kWh)', near(tot3, 6, 1e-6), tot3.toFixed(2));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);