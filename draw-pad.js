/* draw-pad.js — ตัววาดโหลดโปรไฟล์ 1 วัน (96 ช่วง ทุก 15 นาที) ด้วยเมาส์/นิ้ว
 * ใช้งาน: var pad = DrawPad.mount(element, { onChange: fn });
 *   pad.getSlots()  → อาเรย์ 96 ค่า (kW)
 *   pad.setSlots(a) → ตั้งค่าใหม่ (ย้อนกลับได้)
 * ย้อนกลับ/ทำซ้ำ: ปุ่ม หรือ Ctrl+Z / Ctrl+Y
 */
(function (root, factory) {
    root.DrawPad = factory(root.DrawCalc);
})(typeof self !== 'undefined' ? self : this, function (DrawCalc) {
    'use strict';

    var SLOTS = DrawCalc.SLOTS;
    var LIMIT = 200;

    function el(tag, attrs, text) {
        var e = document.createElement(tag);
        if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
        if (text) e.textContent = text;
        return e;
    }

    function mount(container, opts) {
        opts = opts || {};
        var onChange = opts.onChange || function () {};
        var slots = DrawCalc.hourlyToSlots(Array(24).fill(0.5));
        var past = [], future = [];
        var drawing = false, lastI = null;

        // ---- ส่วนประกอบ UI
        var bar = el('div', { class: 'draw-bar' });
        var btnUndo = el('button', { type: 'button', title: 'ย้อนกลับ (Ctrl+Z)' }, '↶ ย้อนกลับ');
        var btnRedo = el('button', { type: 'button', title: 'ทำซ้ำ (Ctrl+Y)' }, '↷ ทำซ้ำ');
        var btnClear = el('button', { type: 'button' }, '🧹 ล้าง');
        var btnSample = el('button', { type: 'button' }, '🏠 ตัวอย่างบ้านทั่วไป');
        var kmaxIn = el('input', { type: 'number', min: '5', max: '500', step: '5', value: '60', style: 'width:70px' });
        var kmaxLbl = el('label', null, 'แกน kW สูงสุด ');
        kmaxLbl.appendChild(kmaxIn);
        var status = el('span', { class: 'note' });
        [btnUndo, btnRedo, btnClear, btnSample, kmaxLbl, status].forEach(function (n) { bar.appendChild(n); });

        var cv = el('canvas', { width: '960', height: '380', class: 'draw-canvas' });
        var hint = el('p', { class: 'note' }, 'ลากบนกราฟเพื่อกำหนด kW ทุก 15 นาที · ส้ม = On-Peak 09:00–22:00 · ฟ้า = Off-Peak');
        container.innerHTML = '';
        container.appendChild(bar);
        container.appendChild(cv);
        container.appendChild(hint);

        var ctx = cv.getContext('2d');
        var PL = 56, PR = 12, PT = 12, PB = 58;
        var CELL_W = (cv.width - PL - PR) / SLOTS;

        function kmax() { var v = Number(kmaxIn.value); return v >= 5 && v <= 500 ? v : 60; }
        function plotH() { return cv.height - PT - PB; }
        function yOf(kw) { return PT + plotH() * (1 - Math.min(kw, kmax()) / kmax()); }
        function setStatus(t) { status.textContent = t; }
        function snapshot() { past.push(slots.slice()); if (past.length > LIMIT) past.shift(); future = []; }

        function render() {
            var W = cv.width, H = cv.height, K = kmax();
            ctx.clearRect(0, 0, W, H);
            ctx.font = '13px sans-serif';
            ctx.lineWidth = 1;
            ctx.strokeStyle = '#2a3344'; ctx.fillStyle = '#9aa6bd';
            for (var g = 0; g <= 4; g++) {
                var kv = K / 4 * g, y = yOf(kv);
                ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
                ctx.fillText(kv.toFixed(0) + ' kW', 4, y + 4);
            }
            for (var i = 0; i < SLOTS; i++) {
                var x = PL + i * CELL_W;
                var top = yOf(slots[i]), bottom = yOf(0);
                var minute = i * 15;
                var onPeak = minute >= 540 && minute < 1320;
                ctx.fillStyle = onPeak ? 'rgba(255,170,60,.85)' : 'rgba(90,170,255,.85)';
                ctx.fillRect(x + 0.5, top, Math.max(1, CELL_W - 1), bottom - top);
            }
            for (var k = 0; k < SLOTS; k += 2) {
                var lx = PL + k * CELL_W + CELL_W / 2;
                var m = k * 15;
                var label = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
                ctx.save();
                ctx.translate(lx + 4, H - PB + 8);
                ctx.rotate(-Math.PI / 2);
                ctx.fillStyle = '#9aa6bd';
                ctx.fillText(label, 0, 0);
                ctx.restore();
            }
        }

        function changed() { render(); onChange(getSlots()); }

        function getSlots() { return slots.slice(); }

        function pos(e) {
            var r = cv.getBoundingClientRect();
            return { x: (e.clientX - r.left) * (cv.width / r.width), y: (e.clientY - r.top) * (cv.height / r.height) };
        }

        function applyAt(e) {
            var p = pos(e);
            if (p.x < PL || p.x > cv.width - PR || p.y < PT || p.y > cv.height - PB) return;
            var i = Math.min(SLOTS - 1, Math.max(0, Math.floor((p.x - PL) / CELL_W)));
            var kw = (1 - (p.y - PT) / plotH()) * kmax();
            kw = Math.round(Math.min(kmax(), Math.max(0, kw)) * 10) / 10;
            var from = lastI === null ? i : lastI;
            var lo = Math.min(from, i), hi = Math.max(from, i);
            for (var k = lo; k <= hi; k++) slots[k] = kw;
            lastI = i;
            changed();
        }

        cv.addEventListener('pointerdown', function (e) {
            snapshot(); drawing = true; lastI = null;
            cv.setPointerCapture(e.pointerId);
            applyAt(e);
        });
        cv.addEventListener('pointermove', function (e) { if (drawing) applyAt(e); });
        function endStroke() { drawing = false; lastI = null; }
        cv.addEventListener('pointerup', endStroke);
        cv.addEventListener('pointercancel', endStroke);

        function undo() {
            if (!past.length) { setStatus('ไม่มีอะไรให้ย้อนกลับ'); return; }
            future.push(slots.slice()); slots = past.pop(); changed(); setStatus('ย้อนกลับแล้ว');
        }
        function redo() {
            if (!future.length) { setStatus('ไม่มีอะไรให้ทำซ้ำ'); return; }
            past.push(slots.slice()); slots = future.pop(); changed(); setStatus('ทำซ้ำแล้ว');
        }
        function setSlots(arr) { snapshot(); slots = DrawCalc.cleanSlots(arr); changed(); }

        btnUndo.onclick = undo;
        btnRedo.onclick = redo;
        btnClear.onclick = function () { setSlots(Array(SLOTS).fill(0)); setStatus('ล้างแล้ว (ย้อนกลับได้)'); };
        btnSample.onclick = function () {
            var h = [0.3,0.3,0.3,0.3,0.3,0.3,0.5,0.8,1.0,1.2,1.2,1.0,1.0,1.0,1.1,1.5,2.5,4.0,5.0,4.5,3.5,2.0,1.0,0.5];
            setSlots(DrawCalc.hourlyToSlots(h)); setStatus('ใส่ตัวอย่างแล้ว (ย้อนกลับได้)');
        };
        kmaxIn.onchange = function () { render(); };

        function onKey(e) {
            if (!(e.ctrlKey || e.metaKey) || !container.isConnected) return;
            if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); undo(); }
            if (e.key === 'y' || e.key === 'Y') { e.preventDefault(); redo(); }
        }
        document.addEventListener('keydown', onKey);

        render();
        onChange(getSlots());
        return { getSlots: getSlots, setSlots: setSlots, undo: undo, redo: redo };
    }

    return { mount: mount };
});
