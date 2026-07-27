/* Irish Solar & Savings Predictor — application controller */
(function () {
    'use strict';

    const SM = window.SolarModel;
    const EM = window.EnergyModel;

    const state = {
        location: {
            name: 'Newcastle West, Co. Limerick (V42 AD96)',
            latitude: 52.4497,
            longitude: -9.0612,
            timezone: 'Europe/Dublin'
        },
        utcOffsetSeconds: 0,
        hourly: [],
        days: [],
        sims: [],
        selected: 0,
        chart: null,
        chartMode: 'flow',
        solarConfig: null,
        econConfig: null,
        usingFallback: false
    };

    const KNOWN_PLACES = {
        'V42AD96': { name: 'Newcastle West, Co. Limerick (V42 AD96)', lat: 52.4497, lon: -9.0612 },
        'V94XV2W': { name: 'Caherlevoy, Mountcollins, Co. Limerick (V94 XV2W)', lat: 52.3325, lon: -9.1842 },
        'CAHERLEVOY': { name: 'Caherlevoy, Mountcollins, Co. Limerick', lat: 52.3325, lon: -9.1842 },
        'MOUNTCOLLINS': { name: 'Mountcollins, Co. Limerick', lat: 52.3325, lon: -9.1842 },
        'ABBEYFEALE': { name: 'Abbeyfeale, Co. Limerick', lat: 52.3847, lon: -9.2982 },
        'NEWCASTLEWEST': { name: 'Newcastle West, Co. Limerick', lat: 52.4497, lon: -9.0612 },
        'CHARLEVILLE': { name: 'Charleville, Co. Cork', lat: 52.3550, lon: -8.6833 },
        'TRALEE': { name: 'Tralee, Co. Kerry', lat: 52.2704, lon: -9.7026 },
        'LIMERICK': { name: 'Limerick City', lat: 52.6638, lon: -8.6267 },
        'DUBLIN': { name: 'Dublin City', lat: 53.3498, lon: -6.2603 },
        'CORK': { name: 'Cork City', lat: 51.8985, lon: -8.4756 },
        'GALWAY': { name: 'Galway City', lat: 53.2707, lon: -9.0568 }
    };

    const ROUTING_KEYS = {
        'V42': { name: 'Newcastle West area (V42)', lat: 52.4497, lon: -9.0612 },
        'V94': { name: 'Limerick area (V94)', lat: 52.6680, lon: -8.6305 },
        'V92': { name: 'Tralee area (V92)', lat: 52.2704, lon: -9.7026 },
        'P56': { name: 'Charleville area (P56)', lat: 52.3550, lon: -8.6833 },
        'T12': { name: 'Cork area (T12)', lat: 51.8985, lon: -8.4756 },
        'H91': { name: 'Galway area (H91)', lat: 53.2707, lon: -9.0568 },
        'D02': { name: 'Dublin 2 (D02)', lat: 53.3383, lon: -6.2591 }
    };

    const $ = function (id) { return document.getElementById(id); };
    const euro = function (n) { return (n < 0 ? '−€' : '€') + Math.abs(n).toFixed(2); };
    const pad2 = function (n) { return String(n).padStart(2, '0'); };

    /* ── Config ──────────────────────────────────────────────── */

    function num(id, fallback) {
        const v = parseFloat($(id).value);
        return isNaN(v) ? fallback : v;
    }

    function readConfig() {
        const capacity = Math.max(0.5, num('sysCapacity', 5));
        const inverter = Math.max(0.5, num('inverterKw', capacity));

        state.solarConfig = {
            systemCapacityKwp: capacity,
            inverterKwAc: inverter,
            panelTiltDeg: Math.max(0, Math.min(90, num('panelTilt', 35))),
            panelAzimuthDeg: SM.ORIENTATIONS[$('panelOrientation').value] || 180,
            latitude: state.location.latitude,
            longitude: state.location.longitude,
            utcOffsetSeconds: state.utcOffsetSeconds
        };

        state.econConfig = {
            dailyUsageKwh: Math.max(0.5, num('dailyUsage', 10)),
            loadProfile: $('loadProfile').value,
            flexSchedule: $('flexSchedule').value,
            battery: {
                enabled: $('batteryEnabled').checked,
                capacityKwh: Math.max(0, num('batteryCapacity', 5)),
                maxChargeKw: Math.max(0.5, num('batteryPower', 3)),
                maxDischargeKw: Math.max(0.5, num('batteryPower', 3)),
                roundTripEff: 0.90,
                minSocPct: 10,
                strategy: $('batteryStrategy').value
            },
            ev: {
                enabled: $('evEnabled').checked,
                kwhPerSession: Math.max(0, num('evKwh', 20)),
                sessionsPerWeek: Math.max(0, Math.min(7, num('evSessions', 4))),
                chargerKw: 7.4
            },
            immersion: {
                enabled: $('immersionEnabled').checked,
                kwhPerDay: Math.max(0, num('immersionKwh', 2.4)),
                elementKw: 3.0
            },
            tariff: Object.assign({}, EM.DEFAULT_TARIFF, {
                dayRate: num('rateDay', 30),
                nightRate: num('rateNight', 20),
                evRate: num('rateEv', 10),
                peakRate: num('ratePeak', 30),
                exportRate: num('rateExport', 18.5),
                standingChargeEuroPerDay: num('standingCharge', 0.85),
                exportEnabled: num('rateExport', 18.5) > 0
            })
        };
        saveSettings();
    }

    function applyTariffPreset(key) {
        const p = EM.TARIFF_PRESETS[key];
        if (!p) return;
        $('rateDay').value = p.dayRate;
        $('rateNight').value = p.nightRate;
        $('rateEv').value = p.evRate;
        $('ratePeak').value = p.peakRate;
        $('rateExport').value = p.exportRate;
        $('standingCharge').value = p.standingChargeEuroPerDay;
        document.querySelectorAll('[data-tariff]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-tariff') === key);
        });
    }

    const SETTING_IDS = ['sysCapacity', 'inverterKw', 'panelTilt', 'panelOrientation', 'dailyUsage',
        'loadProfile', 'flexSchedule', 'batteryCapacity', 'batteryPower', 'batteryStrategy',
        'evKwh', 'evSessions', 'immersionKwh', 'rateDay', 'rateNight', 'rateEv', 'ratePeak',
        'rateExport', 'standingCharge'];
    const TOGGLE_IDS = ['batteryEnabled', 'evEnabled', 'immersionEnabled'];

    function saveSettings() {
        try {
            const data = {};
            SETTING_IDS.forEach(function (id) { data[id] = $(id).value; });
            TOGGLE_IDS.forEach(function (id) { data[id] = $(id).checked; });
            window.localStorage.setItem('solarPredictorSettings', JSON.stringify(data));
        } catch (e) { /* private browsing or file:// — settings just won't persist */ }
    }

    function loadSettings() {
        try {
            const raw = window.localStorage.getItem('solarPredictorSettings');
            if (!raw) return;
            const data = JSON.parse(raw);
            SETTING_IDS.forEach(function (id) { if (data[id] !== undefined) $(id).value = data[id]; });
            TOGGLE_IDS.forEach(function (id) { if (data[id] !== undefined) $(id).checked = data[id]; });
        } catch (e) { /* ignore malformed saved settings */ }
    }

    /* ── Geocoding ───────────────────────────────────────────── */

    async function geocode(query) {
        if (!query || !query.trim()) return null;
        const raw = query.trim();
        const upper = raw.toUpperCase().replace(/[.,]/g, ' ').trim();
        const compact = upper.replace(/\s+/g, '');

        if (KNOWN_PLACES[compact]) return KNOWN_PLACES[compact];
        const firstWord = compact.split(/[^A-Z0-9]/)[0];
        if (KNOWN_PLACES[firstWord]) return KNOWN_PLACES[firstWord];

        const eircode = compact.replace(/[^A-Z0-9]/g, '');
        const formatted = eircode.length === 7 ? eircode.slice(0, 3) + ' ' + eircode.slice(3) : raw;

        try {
            const r = await fetch('https://nominatim.openstreetmap.org/search?q=' +
                encodeURIComponent(formatted + ', Ireland') + '&format=json&limit=1&countrycodes=ie');
            if (r.ok) {
                const j = await r.json();
                if (j && j.length) {
                    return {
                        name: j[0].display_name.split(',').slice(0, 3).join(', ') + ' (' + formatted + ')',
                        lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon)
                    };
                }
            }
        } catch (e) { /* fall through to the next provider */ }

        try {
            const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' +
                encodeURIComponent(raw) + '&count=1&language=en&format=json');
            if (r.ok) {
                const j = await r.json();
                if (j.results && j.results.length) {
                    const g = j.results[0];
                    return { name: g.name + (g.admin1 ? ', ' + g.admin1 : ''), lat: g.latitude, lon: g.longitude };
                }
            }
        } catch (e) { /* fall through to routing key */ }

        if (eircode.length >= 3 && ROUTING_KEYS[eircode.slice(0, 3)]) return ROUTING_KEYS[eircode.slice(0, 3)];
        return null;
    }

    /* ── Weather ─────────────────────────────────────────────── */

    async function fetchWeather() {
        const tilt = Math.max(0, Math.min(90, num('panelTilt', 35)));
        const panelAz = SM.ORIENTATIONS[$('panelOrientation').value] || 180;
        // Open-Meteo measures azimuth from due south: 0 = S, −90 = E, +90 = W.
        const omAzimuth = Math.max(-180, Math.min(180, panelAz - 180));

        const core = 'https://api.open-meteo.com/v1/forecast' +
            '?latitude=' + state.location.latitude +
            '&longitude=' + state.location.longitude +
            '&hourly=temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,' +
            'shortwave_radiation,direct_radiation,diffuse_radiation,direct_normal_irradiance,' +
            'sunshine_duration,is_day';
        const tail = '&forecast_days=7&timezone=' + encodeURIComponent(state.location.timezone || 'Europe/Dublin');

        // First choice asks for irradiance already projected onto the roof plane.
        // If that variable is rejected we fall back to transposing it ourselves.
        const attempts = [
            core.replace('sunshine_duration', 'global_tilted_irradiance,sunshine_duration') +
                '&tilt=' + tilt + '&azimuth=' + omAzimuth + tail,
            core + tail
        ];

        for (let i = 0; i < attempts.length; i++) {
            try {
                const r = await fetch(attempts[i]);
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const data = await r.json();
                if (!data.hourly || !data.hourly.time) throw new Error('unexpected response shape');
                state.utcOffsetSeconds = data.utc_offset_seconds || 0;
                state.usingFallback = false;
                return parseWeather(data);
            } catch (err) {
                console.warn('Weather request attempt ' + (i + 1) + ' failed:', err);
            }
        }

        state.usingFallback = true;
        state.utcOffsetSeconds = 3600;
        return syntheticWeather();
    }

    function parseWeather(data) {
        const h = data.hourly;
        const out = [];
        const pick = function (arr, i) { return (arr && arr[i] !== null && arr[i] !== undefined) ? arr[i] : 0; };

        for (let i = 0; i < h.time.length; i++) {
            const stamp = SM.parseLocalStamp(h.time[i]);
            out.push({
                time: h.time[i],
                stamp: stamp,
                utcMillis: SM.toUtcMillis(stamp, data.utc_offset_seconds || 0),
                temperature_2m: pick(h.temperature_2m, i),
                precipitation: pick(h.precipitation, i),
                weather_code: pick(h.weather_code, i),
                cloud_cover: pick(h.cloud_cover, i),
                wind_speed_10m: pick(h.wind_speed_10m, i),
                shortwave_radiation: pick(h.shortwave_radiation, i),
                direct_radiation: pick(h.direct_radiation, i),
                diffuse_radiation: pick(h.diffuse_radiation, i),
                direct_normal_irradiance: pick(h.direct_normal_irradiance, i),
                global_tilted_irradiance: pick(h.global_tilted_irradiance, i),
                sunshine_duration: h.sunshine_duration ? pick(h.sunshine_duration, i) : undefined,
                is_day: pick(h.is_day, i)
            });
        }
        return out;
    }

    /** Offline stand-in so the page still demonstrates the model without network. */
    function syntheticWeather() {
        const out = [];
        const now = new Date();
        const clearnessByDay = [0.92, 0.35, 0.20, 0.62, 0.80, 0.28, 0.55];

        for (let d = 0; d < 7; d++) {
            const k = clearnessByDay[d];
            const cloud = Math.round(Math.max(2, Math.min(100, (1 - k) * 115)));
            for (let hr = 0; hr < 24; hr++) {
                const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, hr);
                const time = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + 'T' + pad2(hr) + ':00';
                const stamp = SM.parseLocalStamp(time);
                const utcMillis = SM.toUtcMillis(stamp, 3600);
                const sun = SM.getSunPosition(utcMillis, state.location.latitude, state.location.longitude);
                const cs = SM.clearSkyPoa(sun.elevation, sun.azimuth, 0, 180);
                const ghi = Math.max(0, cs.ghi * k);
                const diffuseShare = Math.min(1, 0.16 + 0.84 * (1 - k));
                out.push({
                    time: time, stamp: stamp, utcMillis: utcMillis,
                    temperature_2m: Math.round((12 + 6 * Math.sin((hr - 8) / 12 * Math.PI)) * 10) / 10,
                    precipitation: k < 0.35 ? 0.5 : 0,
                    weather_code: cloud > 85 ? 61 : cloud > 50 ? 3 : cloud > 25 ? 2 : 0,
                    cloud_cover: cloud,
                    wind_speed_10m: 12,
                    shortwave_radiation: Math.round(ghi),
                    direct_radiation: Math.round(ghi * (1 - diffuseShare)),
                    diffuse_radiation: Math.round(ghi * diffuseShare),
                    direct_normal_irradiance: 0,
                    global_tilted_irradiance: 0,
                    sunshine_duration: sun.elevation > 1.5 ? 3600 * Math.max(0, Math.min(1, (k - 0.25) / 0.6)) : 0,
                    is_day: sun.elevation > 0 ? 1 : 0
                });
            }
        }
        return out;
    }

    /* ── Processing ──────────────────────────────────────────── */

    function process() {
        const groups = {};
        const order = [];
        state.hourly.forEach(function (h) {
            const key = h.time.split('T')[0];
            if (!groups[key]) { groups[key] = []; order.push(key); }
            groups[key].push(h);
        });

        state.days = order.map(function (k) {
            return SM.analyzeDailySolarForecast(groups[k], state.solarConfig);
        });
        state.sims = state.days.map(function (d) { return EM.simulateDay(d, state.econConfig); });
        if (state.selected >= state.days.length) state.selected = 0;
    }

    /* ── Rendering ───────────────────────────────────────────── */

    function renderWeek() {
        const grid = $('forecastGrid');
        grid.innerHTML = '';

        state.days.forEach(function (day, i) {
            const sim = state.sims[i];
            const parts = day.date.split('-');
            const dt = new Date(+parts[0], +parts[1] - 1, +parts[2]);
            const name = i === 0 ? 'Today' : dt.toLocaleDateString('en-IE', { weekday: 'short' });

            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'day-card' + (i === state.selected ? ' selected' : '');
            card.setAttribute('aria-pressed', i === state.selected ? 'true' : 'false');
            card.innerHTML =
                '<div class="day-date">' + name + '</div>' +
                '<div class="day-sub">' + dt.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' }) + '</div>' +
                '<div class="day-icon">' + day.ratingIcon + '</div>' +
                '<div class="day-kwh">' + day.totalKwh.toFixed(1) + ' <span>kWh</span></div>' +
                '<div class="day-money">' + euro(sim.savingVsNoSolar) + '<small>saved</small></div>' +
                '<span class="solar-badge day-badge ' + day.ratingClass + '">' + (day.ratingShort || day.ratingLabel) + '</span>';

            card.addEventListener('click', function () {
                state.selected = i;
                renderAll();
            });
            grid.appendChild(card);
        });

        const weekSaving = state.sims.reduce(function (a, s) { return a + s.savingVsNoSolar; }, 0);
        const weekExport = state.sims.reduce(function (a, s) { return a + s.exportIncome; }, 0);
        const weekGen = state.sims.reduce(function (a, s) { return a + s.generationKwh; }, 0);
        const weekCost = state.sims.reduce(function (a, s) { return a + s.netCost; }, 0);

        const capacity = state.solarConfig.systemCapacityKwp;
        const annualGen = capacity * 850;
        const weekSolar = state.sims.reduce(function (a, s) { return a + s.solarContribution; }, 0);
        const weekBattery = state.sims.reduce(function (a, s) { return a + s.batteryContribution; }, 0);
        const annual = (weekGen > 0 ? (weekSolar / weekGen) * annualGen : 0) +
            (weekBattery / Math.max(1, state.sims.length)) * 365;

        $('weekTotals').innerHTML =
            block(weekGen.toFixed(1) + ' kWh', 'Generated over ' + state.days.length + ' days') +
            block(euro(weekCost), 'Electricity cost for the week') +
            block(euro(weekSaving), 'Saved against no solar') +
            block(euro(weekExport), 'Export income (CEG)') +
            block('≈ €' + Math.round(annual).toLocaleString('en-IE'), 'Estimated yearly saving');
    }

    function block(value, label) {
        return '<div><b>' + value + '</b><label>' + label + '</label></div>';
    }

    function renderHero() {
        const day = state.days[state.selected];
        const sim = state.sims[state.selected];
        if (!day) return;

        const parts = day.date.split('-');
        const dt = new Date(+parts[0], +parts[1] - 1, +parts[2]);
        const formatted = dt.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'short' });
        $('selectedDateBadge').textContent = state.selected === 0 ? 'Today, ' + formatted : formatted;

        $('verdictIcon').textContent = day.ratingIcon;
        $('verdictBadge').textContent = day.ratingLabel;
        $('verdictBadge').className = 'solar-badge ' + day.ratingClass;
        $('solarScoreVal').textContent = day.score + '/100';
        $('verdictSummary').textContent = day.summaryText;
        $('scoreBarFill').style.width = day.score + '%';

        $('clearnessVal').textContent = Math.round(day.clearnessIndex * 100) + '%';
        $('sunshineVal').textContent = day.sunshineHours.toFixed(1) + 'h';
        $('avgCloudVal').textContent = day.avgCloudCover + '%';

        $('totalKwhVal').textContent = day.totalKwh.toFixed(1);
        $('yieldPerKwpVal').textContent = day.yieldPerKwp.toFixed(2);
        $('peakPowerVal').textContent = day.maxPowerKw.toFixed(2);
        $('peakHourVal').textContent = day.peakHourStr;
        $('applianceWindowVal').textContent = day.optimalWindow;

        $('dayCostVal').textContent = euro(sim.netCost);
        $('dayCostVal').className = sim.netCost < 0 ? 'pos' : '';
        $('dayBaselineVal').textContent = euro(sim.baselineCost);
        $('daySavingVal').textContent = euro(sim.savingVsNoSolar);
        $('exportKwhVal').textContent = sim.exportedKwh.toFixed(1);
        $('exportIncomeVal').textContent = euro(sim.exportIncome);
    }

    function renderCosts() {
        const sim = state.sims[state.selected];
        if (!sim) return;
        const t = state.econConfig.tariff;
        const colors = { ev: 'var(--band-ev)', night: 'var(--band-night)', day: 'var(--band-day)', peak: 'var(--band-peak)' };

        let html = '';
        ['ev', 'night', 'day', 'peak'].forEach(function (band) {
            const b = sim.byBand[band];
            if (!b || b.kwh < 0.005) return;
            html += '<tr><td><span class="band-dot" style="background:' + colors[band] + '"></span>' +
                EM.bandLabel(band) + '</td><td>' + b.kwh.toFixed(1) + ' kWh</td><td>' +
                EM.rateForBand(band, t).toFixed(1) + 'c</td><td>' + euro(b.cost) + '</td></tr>';
        });
        html += '<tr class="sub-row"><td>Standing charge</td><td>—</td><td>—</td><td>' + euro(t.standingChargeEuroPerDay) + '</td></tr>';
        html += '<tr class="sub-row"><td>Export credit</td><td>' + sim.exportedKwh.toFixed(1) + ' kWh</td><td>' +
            t.exportRate.toFixed(1) + 'c</td><td class="pos">−' + euro(sim.exportIncome) + '</td></tr>';
        html += '<tr class="total-row"><td>Total for the day</td><td>—</td><td>—</td><td>' + euro(sim.netCost) + '</td></tr>';
        $('bandTableBody').innerHTML = html;

        const day = state.days[state.selected];
        const comparison = EM.compareStrategies(day, state.econConfig);
        $('strategyList').innerHTML = comparison.map(function (s, i) {
            return '<div class="strategy-row' + (i === 0 ? ' best' : '') + '">' +
                '<span class="s-name">' + s.label + '</span>' +
                (i === 0 ? '<span class="s-tag">cheapest</span>' : '') +
                '<span class="s-cost">' + euro(s.netCost) + '</span></div>';
        }).join('');

        const total = Math.max(0.01, Math.abs(sim.solarContribution) + Math.abs(sim.batteryContribution));
        $('splitBars').innerHTML =
            splitBar('From the panels', sim.solarContribution, total, '#f59e0b') +
            splitBar('From cheap-rate charging', sim.batteryContribution, total, '#a855f7') +
            splitBar('Solar used on site', sim.selfConsumptionPct, 100, '#10b981', sim.selfConsumptionPct + '%') +
            splitBar('House run on your own solar', sim.selfSufficiencyPct, 100, '#06b6d4', sim.selfSufficiencyPct + '%');
    }

    function splitBar(label, value, total, color, displayOverride) {
        const pct = Math.max(0, Math.min(100, (value / total) * 100));
        const shown = displayOverride || euro(value);
        return '<div class="split-item"><div class="split-head"><span>' + label + '</span><b>' + shown + '</b></div>' +
            '<div class="split-track"><div class="split-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
    }

    function renderInsights() {
        const notes = EM.buildInsights(state.sims, state.econConfig, state.solarConfig.systemCapacityKwp);
        let html = notes.map(function (n) {
            return '<div class="insight-card"><h4>' + n.icon + ' ' + n.title + '</h4><p>' + n.body + '</p></div>';
        }).join('');
        if (state.usingFallback) {
            html = '<div class="insight-card" style="border-left-color:var(--accent-rose)">' +
                '<h4>⚠️ Showing a sample forecast</h4><p>The weather service could not be reached, so the ' +
                'numbers below come from a built-in demonstration week rather than a real forecast. ' +
                'Check your connection and reload.</p></div>' + html;
        }
        $('insightsGrid').innerHTML = html;
    }

    function renderHourlyTable() {
        const day = state.days[state.selected];
        const sim = state.sims[state.selected];
        if (!day || !sim) return;

        const rows = {};
        sim.result.rows.forEach(function (r) { rows[r.hour] = r; });

        let html = '';
        day.hourlyYields.forEach(function (h) {
            const r = rows[h.hour] || {};
            const w = SM.WMO_WEATHER_CODES[h.weather_code] || { description: '—', icon: '·' };
            const icon = h.isDaylight ? w.icon : '🌙';
            const band = r.band || 'day';

            let powerClass = 'power-zero';
            if (h.powerKw >= state.solarConfig.systemCapacityKwp * 0.4) powerClass = 'power-high';
            else if (h.powerKw > 0.1) powerClass = 'power-mid';

            const batteryFlow = (r.solarToBattery || 0) + (r.gridToBattery || 0) - (r.batteryToLoad || 0);
            const batteryText = Math.abs(batteryFlow) < 0.05
                ? '<span class="power-zero">—</span>'
                : (batteryFlow > 0
                    ? '<span class="flow-out">▲ ' + batteryFlow.toFixed(1) + ' stored</span>'
                    : '<span class="flow-in">▼ ' + Math.abs(batteryFlow).toFixed(1) + ' used</span>');

            let gridText = '<span class="power-zero">—</span>';
            if ((r.exported || 0) > 0.05) gridText = '<span class="flow-out">↑ ' + r.exported.toFixed(1) + ' sold</span>';
            else if ((r.gridImport || 0) > 0.05) gridText = '<span class="flow-in">↓ ' + r.gridImport.toFixed(1) + ' bought</span>';

            html += '<tr' + (h.isDaylight ? '' : ' class="is-night"') + '>' +
                '<td class="num">' + pad2(h.hour) + ':00</td>' +
                '<td><span class="rate-chip rate-' + band + '">' + EM.rateForBand(band, state.econConfig.tariff).toFixed(0) + 'c</span></td>' +
                '<td>' + icon + ' ' + w.description + '</td>' +
                '<td class="num">' + Math.round(h.temperature_2m) + '°</td>' +
                '<td class="num">' + Math.round(h.cloud_cover) + '%</td>' +
                '<td class="num">' + h.effectiveIrradianceWm2 + ' / ' + h.clearSkyIrradianceWm2 + '</td>' +
                '<td><span class="power-pill ' + powerClass + '">' + h.powerKw.toFixed(2) + ' kW</span></td>' +
                '<td class="num">' + (r.load || 0).toFixed(2) + ' kWh</td>' +
                '<td class="num">' + batteryText + '</td>' +
                '<td class="num">' + gridText + '</td>' +
                '</tr>';
        });
        $('hourlyTableBody').innerHTML = html;
    }

    /* ── Charts ──────────────────────────────────────────────── */

    const CHART_TEXT = {
        flow: {
            title: 'Where the energy goes',
            caption: 'Bars above the line show how the house was supplied each hour; bars below show what went out to the grid. ' +
                'The amber line is total panel output.'
        },
        generation: {
            title: 'Generation against cloud cover',
            caption: 'Panel output in kW with cloud cover on the right-hand axis. Steep dips through the middle of the day are passing cloud.'
        },
        battery: {
            title: 'Battery charge and what each hour costs',
            caption: 'Bars are coloured by rate band — purple is the cheap EV window, amber the day rate. The line is energy stored in the battery.'
        },
        irradiance: {
            title: 'Sunlight reaching the panels',
            caption: 'The gap between the two lines is the day rating: the shaded band is the sunlight cloud took away. ' +
                'This comparison is why an overcast summer day scores poorly even though it runs for sixteen hours.'
        }
    };

    function renderChart() {
        const day = state.days[state.selected];
        const sim = state.sims[state.selected];
        if (!day || !sim) return;

        const ctx = $('hourlyChart').getContext('2d');
        if (state.chart) state.chart.destroy();

        const labels = [];
        for (let h = 0; h < 24; h++) labels.push(pad2(h));

        const byHour = {};
        day.hourlyYields.forEach(function (h) { byHour[h.hour] = h; });
        const rows = sim.result.rows;

        const grid = { color: 'rgba(255,255,255,0.06)' };
        const tick = { color: '#94a3b8', font: { size: 11 } };
        const base = {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { labels: { color: '#e2e8f0', boxWidth: 12, font: { size: 11 } } },
                tooltip: { backgroundColor: 'rgba(15,23,42,0.95)', borderColor: 'rgba(255,255,255,0.15)', borderWidth: 1 }
            }
        };

        let config;

        if (state.chartMode === 'flow') {
            config = {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        { label: 'Solar straight to the house', data: rows.map(function (r) { return r.directUse; }), backgroundColor: '#f59e0b', stack: 's' },
                        { label: 'From the battery', data: rows.map(function (r) { return r.batteryToLoad; }), backgroundColor: '#a855f7', stack: 's' },
                        { label: 'Bought from the grid', data: rows.map(function (r) { return r.gridImport; }), backgroundColor: '#f43f5e', stack: 's' },
                        { label: 'Sold to the grid', data: rows.map(function (r) { return -r.exported; }), backgroundColor: '#10b981', stack: 's' },
                        {
                            label: 'Total panel output', type: 'line',
                            data: rows.map(function (r) { return r.generation; }),
                            borderColor: '#fcd34d', backgroundColor: 'transparent',
                            borderWidth: 2, tension: 0.35, pointRadius: 0
                        }
                    ]
                },
                options: Object.assign({}, base, {
                    scales: {
                        x: { stacked: true, grid: grid, ticks: tick },
                        y: { stacked: true, grid: grid, ticks: tick, title: { display: true, text: 'kWh per hour', color: '#94a3b8' } }
                    }
                })
            };
        } else if (state.chartMode === 'generation') {
            config = {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Generation (kW)', data: rows.map(function (r) { return r.generation; }),
                            borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.2)',
                            fill: true, tension: 0.35, borderWidth: 3, pointRadius: 0, yAxisID: 'y'
                        },
                        {
                            label: 'Cloud cover (%)',
                            data: labels.map(function (_, h) { return byHour[h] ? byHour[h].cloud_cover : null; }),
                            borderColor: '#06b6d4', backgroundColor: 'transparent',
                            borderDash: [5, 5], tension: 0.25, borderWidth: 2, pointRadius: 0, yAxisID: 'y1'
                        }
                    ]
                },
                options: Object.assign({}, base, {
                    scales: {
                        x: { grid: grid, ticks: tick },
                        y: { position: 'left', min: 0, grid: grid, ticks: tick, title: { display: true, text: 'kW', color: '#f59e0b' } },
                        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: tick, title: { display: true, text: 'Cloud %', color: '#06b6d4' } }
                    }
                })
            };
        } else if (state.chartMode === 'battery') {
            const bandColor = { ev: '#a855f7', night: '#38bdf8', day: '#f59e0b', peak: '#fb7185' };
            config = {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Cost of that hour (€)',
                            data: rows.map(function (r) { return Math.round(r.cost * 100) / 100; }),
                            backgroundColor: rows.map(function (r) { return bandColor[r.band]; }),
                            yAxisID: 'y'
                        },
                        {
                            label: 'Stored in the battery (kWh)', type: 'line',
                            data: rows.map(function (r) { return Math.round(r.soc * 100) / 100; }),
                            borderColor: '#34d399', backgroundColor: 'rgba(16,185,129,0.12)',
                            fill: true, tension: 0.3, borderWidth: 2.5, pointRadius: 0, yAxisID: 'y1'
                        }
                    ]
                },
                options: Object.assign({}, base, {
                    scales: {
                        x: { grid: grid, ticks: tick },
                        y: { position: 'left', grid: grid, ticks: tick, title: { display: true, text: '€ per hour', color: '#94a3b8' } },
                        y1: { position: 'right', min: 0, grid: { drawOnChartArea: false }, ticks: tick, title: { display: true, text: 'kWh stored', color: '#34d399' } }
                    }
                })
            };
        } else {
            config = {
                type: 'line',
                data: {
                    labels: labels,
                    datasets: [
                        {
                            label: 'Clear-sky potential (W/m²)',
                            data: labels.map(function (_, h) { return byHour[h] ? byHour[h].clearSkyIrradianceWm2 : 0; }),
                            borderColor: 'rgba(148,163,184,0.7)', backgroundColor: 'rgba(148,163,184,0.14)',
                            borderDash: [6, 4], fill: true, tension: 0.35, borderWidth: 2, pointRadius: 0
                        },
                        {
                            label: 'Actually reaching the panels (W/m²)',
                            data: labels.map(function (_, h) { return byHour[h] ? byHour[h].effectiveIrradianceWm2 : 0; }),
                            borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.3)',
                            fill: true, tension: 0.35, borderWidth: 3, pointRadius: 0
                        }
                    ]
                },
                options: Object.assign({}, base, {
                    scales: {
                        x: { grid: grid, ticks: tick },
                        y: { min: 0, grid: grid, ticks: tick, title: { display: true, text: 'W/m² on the panel', color: '#94a3b8' } }
                    }
                })
            };
        }

        state.chart = new Chart(ctx, config);
        $('chartTitle').textContent = CHART_TEXT[state.chartMode].title;
        $('chartCaption').textContent = CHART_TEXT[state.chartMode].caption;
    }

    function renderAll() {
        renderWeek();
        renderHero();
        renderCosts();
        renderInsights();
        renderHourlyTable();
        renderChart();
    }

    /* ── Loading ─────────────────────────────────────────────── */

    function showLoading(msg) {
        const o = $('loadingOverlay');
        if (msg) $('loadingSubtitle').textContent = msg;
        o.style.display = 'flex';
        o.style.opacity = '1';
    }

    function hideLoading() {
        const o = $('loadingOverlay');
        o.style.opacity = '0';
        setTimeout(function () { o.style.display = 'none'; }, 300);
    }

    function updateLocationLabels() {
        const l = state.location;
        $('locationDisplayBadge').textContent = '📍 ' + l.name;
        $('footerCoordsText').textContent = l.name + ' · ' +
            Math.abs(l.latitude).toFixed(4) + '° ' + (l.latitude >= 0 ? 'N' : 'S') + ', ' +
            Math.abs(l.longitude).toFixed(4) + '° ' + (l.longitude >= 0 ? 'E' : 'W');
    }

    async function refresh(message) {
        showLoading(message);
        readConfig();
        state.hourly = await fetchWeather();
        readConfig(); // pick up the real UTC offset returned by the weather service
        process();
        renderAll();
        hideLoading();
    }

    async function handleSearch(override) {
        const query = override || $('locationSearchInput').value;
        if (!query) return;
        showLoading('Looking up "' + query + '"…');
        const geo = await geocode(query);
        if (!geo) {
            hideLoading();
            window.alert('No match for "' + query + '". Try a full Eircode such as V42 AD96, or a town name.');
            return;
        }
        state.location.name = geo.name;
        state.location.latitude = geo.lat;
        state.location.longitude = geo.lon;
        updateLocationLabels();
        await refresh('Running the model for ' + geo.name);
    }

    /* ── Boot ────────────────────────────────────────────────── */

    async function init() {
        loadSettings();

        $('currentTimeDisplay').textContent = new Date().toLocaleDateString('en-IE', {
            weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
        });

        const params = new URLSearchParams(window.location.search);
        const paramLoc = params.get('eircode') || params.get('location') || params.get('search');
        if (paramLoc) {
            $('locationSearchInput').value = paramLoc;
            const geo = await geocode(paramLoc);
            if (geo) {
                state.location.name = geo.name;
                state.location.latitude = geo.lat;
                state.location.longitude = geo.lon;
            }
        }
        updateLocationLabels();

        $('btnSearchLocation').addEventListener('click', function () { handleSearch(); });
        $('locationSearchInput').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') handleSearch();
        });

        document.querySelectorAll('[data-loc]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                const loc = btn.getAttribute('data-loc');
                $('locationSearchInput').value = loc;
                handleSearch(loc);
            });
        });

        document.querySelectorAll('[data-tariff]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                applyTariffPreset(btn.getAttribute('data-tariff'));
                readConfig();
                process();
                renderAll();
            });
        });

        // Array changes need fresh tilted-irradiance data; everything else is local maths.
        $('btnRecalculate').addEventListener('click', function () { refresh('Recalculating…'); });
        ['panelTilt', 'panelOrientation'].forEach(function (id) {
            $(id).addEventListener('change', function () { refresh('Re-running for the new roof angle…'); });
        });
        SETTING_IDS.concat(TOGGLE_IDS).forEach(function (id) {
            if (id === 'panelTilt' || id === 'panelOrientation') return;
            $(id).addEventListener('change', function () {
                readConfig();
                process();
                renderAll();
            });
        });

        document.querySelectorAll('[data-chart]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                state.chartMode = btn.getAttribute('data-chart');
                document.querySelectorAll('[data-chart]').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                renderChart();
            });
        });

        await refresh();
    }

    window.addEventListener('DOMContentLoaded', init);
})();
