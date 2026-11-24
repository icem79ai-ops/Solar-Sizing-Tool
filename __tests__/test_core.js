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

// ---------- TOU file (frameset + sidecar) ----------
const pea = [
    { name: 'kW02001943440604092026003043.xls', content: fs.readFileSync(path.join(DOWN, 'kW02001943440604092026003043.xls')) },
    { name: 'sheet001.htm', content: fs.readFileSync(path.join(DOWN, 'kW02001943440604092026003043_files', 'sheet001.htm')) }
];
const tou = Core.parseAmrFiles(pea, XLSX);
ok('TOU: no parse error', !tou.error, tou.error);
if (!tou.error) {
    ok('TOU: nDays=23', tou.nDays === 23, tou.nDays);
    ok('TOU: total ~8167 kWh', near(tou.totalKwh, 8167, 5), tou.totalKwh.toFixed(1));
    ok('TOU: peak ~48.5 kW', near(tou.peakKw, 48.5, 0.5), tou.peakKw.toFixed(2));
    ok('TOU: metadata month=4', tou.metadata.month === 4, tou.metadata.month_th);

    // raw-data analysis bill (flag-based): ~36,269
    const ana = Core.analyzeData(tou, S.tariff);
    ok('TOU: analysis bill ~36,269', near(ana.bill.grandTotal, 36269, 15), ana.bill.grandTotal.toFixed(2));

    // sizing (on-grid): bill_before ~36,064, rec 12 kWp
    const sizeTou = Core.computeSizing(tou, { settings: S, mode: 'ongrid' });
    ok('TOU: scheduling bill ~36,064', near(sizeTou.rows[0].billBefore, 36064, 15), sizeTou.rows[0].billBefore.toFixed(2));
    ok('TOU: rec=12 kWp', sizeTou.recommended && Math.abs(sizeTou.recommended.sizeKwp - 12) < 0.01,
        sizeTou.recommended && sizeTou.recommended.sizeKwp);
    const r12 = sizeTou.rows.find(r => Math.abs(r.sizeKwp - 12) < 0.01);
    ok('TOU: ongrid 12kWp savings ~5,556', near(r12.savingsThb, 5556, 10), r12.savingsThb.toFixed(1));
    const r10 = sizeTou.rows.find(r => Math.abs(r.sizeKwp - 10) < 0.01);
    ok('TOU: ongrid 10kWp savings ~5,094', near(r10.savingsThb, 5094, 10), r10.savingsThb.toFixed(1));

    // hybrid scenario 10kWp + 15kWh -> 6,109
    const bat = { capacityKwh: 15, dod: 0.8, efficiency: 0.9, initialSoc: 0.5 };
    const scen = Core.simulateScenario(tou, 10, { settings: S, mode: 'hybrid', battery: bat });
    ok('TOU: hybrid 10kWp+15kWh savings ~6,109', near(scen.savings, 6109, 10), scen.savings.toFixed(1));
    // daily grid at 00:00 low (battery covers), battery_discharge present
    ok('TOU: hybrid daily has battery traces', !!scen.daily.batteryDischarge && !!scen.daily.batteryCharge);

    // battery recommendation for 12 kWp -> 15 kWh
    const rec = Core.recommendBattery(tou, 12, { settings: S });
    ok('TOU: recommend battery 15 kWh (12kWp)', rec.bestCapacityKwh === 15, rec.bestCapacityKwh + ' kWh');

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);