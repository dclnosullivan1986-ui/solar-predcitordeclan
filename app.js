/* Irish Solar & Savings Predictor — application controller */
(function () {
    'use strict';

    const SM = window.SolarModel;
    const EM = window.EnergyModel;
    const MM = window.MeterModel;

    const state = {
        location: {
            name: 'Newcastle West, Co. Limerick (V42 AD96)',
            latitude: 52.4497,
            longitude: -9.0612,
            elevation: 61,
            precision: 'exact',   // exact | gps | town | area
            precisionNote: 'Exact Eircode match',
            timezone: 'Europe/Dublin'
        },
        utcOffsetSeconds: 0,
        hourly: [],
        modelSpread: null,        // Multi-model comparison (ECMWF, ICON, UKMO)
        days: [],
        sims: [],
        annualEstimate: null,
        meterData: null,          // Parsed ESB Networks HDF smart meter summary
        selected: 0,
        chart: null,
        chartMode: 'flow',
        solarConfig: null,
        econConfig: null,
        usingFallback: false
    };

    const KNOWN_PLACES = {
        'V42AD96': { name: 'Newcastle West, Co. Limerick (V42 AD96)', lat: 52.4497, lon: -9.0612, precision: 'exact', note: 'Exact Eircode match' },
        'V94XV2W': { name: 'Caherlevoy, Mountcollins, Co. Limerick (V94 XV2W)', lat: 52.3325, lon: -9.1842, precision: 'exact', note: 'Exact Eircode match' },
        'CAHERLEVOY': { name: 'Caherlevoy, Mountcollins, Co. Limerick', lat: 52.3325, lon: -9.1842, precision: 'exact', note: 'Townland match' },
        'MOUNTCOLLINS': { name: 'Mountcollins, Co. Limerick', lat: 52.3325, lon: -9.1842, precision: 'town', note: 'Village match' },
        'ABBEYFEALE': { name: 'Abbeyfeale, Co. Limerick', lat: 52.3847, lon: -9.2982, precision: 'town', note: 'Town match' },
        'NEWCASTLEWEST': { name: 'Newcastle West, Co. Limerick', lat: 52.4497, lon: -9.0612, precision: 'town', note: 'Town match' },
        'RATHKEALE': { name: 'Rathkeale, Co. Limerick', lat: 52.5236, lon: -8.9383, precision: 'town', note: 'Town match' },
        'ADARE': { name: 'Adare, Co. Limerick', lat: 52.5644, lon: -8.7897, precision: 'town', note: 'Town match' },
        'CHARLEVILLE': { name: 'Charleville, Co. Cork', lat: 52.3550, lon: -8.6833, precision: 'town', note: 'Town match' },
        'LISTOWEL': { name: 'Listowel, Co. Kerry', lat: 52.4464, lon: -9.4856, precision: 'town', note: 'Town match' },
        'TRALEE': { name: 'Tralee, Co. Kerry', lat: 52.2704, lon: -9.7026, precision: 'town', note: 'Town match' },
        'KILLARNEY': { name: 'Killarney, Co. Kerry', lat: 52.0599, lon: -9.5044, precision: 'town', note: 'Town match' },
        'LIMERICK': { name: 'Limerick City', lat: 52.6638, lon: -8.6267, precision: 'town', note: 'City match' },
        'ENNIS': { name: 'Ennis, Co. Clare', lat: 52.8436, lon: -8.9864, precision: 'town', note: 'Town match' },
        'DUBLIN': { name: 'Dublin City', lat: 53.3498, lon: -6.2603, precision: 'town', note: 'City match' },
        'CORK': { name: 'Cork City', lat: 51.8985, lon: -8.4756, precision: 'town', note: 'City match' },
        'GALWAY': { name: 'Galway City', lat: 53.2707, lon: -9.0568, precision: 'town', note: 'City match' },
        'WATERFORD': { name: 'Waterford City', lat: 52.2593, lon: -7.1101, precision: 'town', note: 'City match' },
        'KILKENNY': { name: 'Kilkenny City', lat: 52.6541, lon: -7.2448, precision: 'town', note: 'City match' },
        'SLIGO': { name: 'Sligo Town', lat: 54.2766, lon: -8.4761, precision: 'town', note: 'Town match' }
    };

    // Comprehensive Irish Eircode routing keys (all counties) for honest fallback when OSM lacks a rural address
    const ROUTING_KEYS = {
        // Limerick, Kerry, Clare
        'V42': { name: 'Newcastle West area (V42)', lat: 52.4497, lon: -9.0612 },
        'V94': { name: 'Limerick / West Limerick area (V94)', lat: 52.6680, lon: -8.6305 },
        'V35': { name: 'Kilmallock area (V35)', lat: 52.3989, lon: -8.5764 },
        'V92': { name: 'Tralee area (V92)', lat: 52.2704, lon: -9.7026 },
        'V93': { name: 'Killarney / Kenmare area (V93)', lat: 52.0599, lon: -9.5044 },
        'V31': { name: 'Listowel area (V31)', lat: 52.4464, lon: -9.4856 },
        'V23': { name: 'Cahersiveen / South Kerry (V23)', lat: 51.9489, lon: -10.2225 },
        'V95': { name: 'Ennis / West Clare (V95)', lat: 52.8436, lon: -8.9864 },
        'V14': { name: 'Shannon area (V14)', lat: 52.7106, lon: -8.8761 },
        'V15': { name: 'Kilrush area (V15)', lat: 52.6397, lon: -9.4833 },
        // Cork
        'T12': { name: 'Cork South (T12)', lat: 51.8890, lon: -8.4756 },
        'T23': { name: 'Cork North (T23)', lat: 51.9100, lon: -8.4756 },
        'T45': { name: 'Little Island / Glanmire (T45)', lat: 51.9080, lon: -8.3560 },
        'P56': { name: 'Charleville area (P56)', lat: 52.3550, lon: -8.6833 },
        'P51': { name: 'Mallow area (P51)', lat: 52.1389, lon: -8.6414 },
        'P61': { name: 'Fermoy area (P61)', lat: 52.1364, lon: -8.2756 },
        'P67': { name: 'Mitchelstown area (P67)', lat: 52.2661, lon: -8.2683 },
        'P12': { name: 'Macroom area (P12)', lat: 51.9056, lon: -8.9589 },
        'P14': { name: 'Crookstown area (P14)', lat: 51.8414, lon: -8.8314 },
        'P17': { name: 'Kinsale area (P17)', lat: 51.7075, lon: -8.5306 },
        'P24': { name: 'Cobh area (P24)', lat: 51.8503, lon: -8.2943 },
        'P25': { name: 'Midleton area (P25)', lat: 51.9144, lon: -8.1753 },
        'P31': { name: 'Ballincollig area (P31)', lat: 51.8894, lon: -8.5844 },
        'P36': { name: 'Youghal area (P36)', lat: 51.9500, lon: -7.8500 },
        'P43': { name: 'Carrigaline area (P43)', lat: 51.8117, lon: -8.3986 },
        'P47': { name: 'Dunmanway area (P47)', lat: 51.7219, lon: -9.1136 },
        'P72': { name: 'Bandon area (P72)', lat: 51.7469, lon: -8.7358 },
        'P75': { name: 'Bantry area (P75)', lat: 51.6806, lon: -9.4525 },
        'P81': { name: 'Skibbereen area (P81)', lat: 51.5553, lon: -9.2636 },
        'P85': { name: 'Clonakilty area (P85)', lat: 51.6231, lon: -8.8706 },
        // Tipperary, Waterford, Kilkenny, Wexford, Carlow
        'E21': { name: 'Cahir area (E21)', lat: 52.3750, lon: -7.9267 },
        'E25': { name: 'Cashel area (E25)', lat: 52.5158, lon: -7.8856 },
        'E32': { name: 'Carrick-on-Suir area (E32)', lat: 52.3469, lon: -7.4131 },
        'E34': { name: 'Tipperary Town area (E34)', lat: 52.4739, lon: -8.1558 },
        'E41': { name: 'Thurles area (E41)', lat: 52.6819, lon: -7.8022 },
        'E45': { name: 'Nenagh area (E45)', lat: 52.8619, lon: -8.1967 },
        'E53': { name: 'Roscrea area (E53)', lat: 52.9531, lon: -7.7983 },
        'E91': { name: 'Clonmel area (E91)', lat: 52.3550, lon: -7.7039 },
        'X91': { name: 'Waterford City area (X91)', lat: 52.2593, lon: -7.1101 },
        'X35': { name: 'Dungarvan area (X35)', lat: 52.0881, lon: -7.6253 },
        'X42': { name: 'Kilmacthomas area (X42)', lat: 52.2089, lon: -7.4281 },
        'R95': { name: 'Kilkenny area (R95)', lat: 52.6541, lon: -7.2448 },
        'R93': { name: 'Carlow area (R93)', lat: 52.8365, lon: -6.9341 },
        'Y14': { name: 'Arklow area (Y14)', lat: 52.7931, lon: -6.1642 },
        'Y21': { name: 'Enniscorthy area (Y21)', lat: 52.5008, lon: -6.5656 },
        'Y25': { name: 'Gorey area (Y25)', lat: 52.6747, lon: -6.2925 },
        'Y34': { name: 'New Ross area (Y34)', lat: 52.3964, lon: -6.9367 },
        'Y35': { name: 'Wexford area (Y35)', lat: 52.3369, lon: -6.4633 },
        // Dublin & Commuter Belt
        'D01': { name: 'Dublin 1 (D01)', lat: 53.3520, lon: -6.2560 },
        'D02': { name: 'Dublin 2 (D02)', lat: 53.3383, lon: -6.2591 },
        'D04': { name: 'Dublin 4 (D04)', lat: 53.3260, lon: -6.2280 },
        'D06': { name: 'Dublin 6 (D06)', lat: 53.3180, lon: -6.2650 },
        'D08': { name: 'Dublin 8 (D08)', lat: 53.3400, lon: -6.2850 },
        'D09': { name: 'Dublin 9 (D09)', lat: 53.3800, lon: -6.2450 },
        'D12': { name: 'Dublin 12 (D12)', lat: 53.3220, lon: -6.3220 },
        'D14': { name: 'Dublin 14 (D14)', lat: 53.2930, lon: -6.2500 },
        'D15': { name: 'Dublin 15 (D15)', lat: 53.3900, lon: -6.3900 },
        'D16': { name: 'Dublin 16 (D16)', lat: 53.2750, lon: -6.2700 },
        'D18': { name: 'Dublin 18 (D18)', lat: 53.2550, lon: -6.1850 },
        'D24': { name: 'Dublin 24 / Tallaght (D24)', lat: 53.2870, lon: -6.3730 },
        'A94': { name: 'Blackrock / Stillorgan (A94)', lat: 53.2950, lon: -6.1850 },
        'A96': { name: 'Dún Laoghaire (A96)', lat: 53.2939, lon: -6.1358 },
        'A98': { name: 'Bray area (A98)', lat: 53.2009, lon: -6.1111 },
        'A63': { name: 'Greystones area (A63)', lat: 53.1408, lon: -6.0631 },
        'A67': { name: 'Wicklow Town area (A67)', lat: 52.9808, lon: -6.0446 },
        'K32': { name: 'Balbriggan area (K32)', lat: 53.6108, lon: -6.1819 },
        'K36': { name: 'Malahide area (K36)', lat: 53.4508, lon: -6.1544 },
        'K67': { name: 'Swords area (K67)', lat: 53.4597, lon: -6.2181 },
        'K78': { name: 'Lucan area (K78)', lat: 53.3572, lon: -6.4486 },
        'W12': { name: 'Newbridge area (W12)', lat: 53.1819, lon: -6.7967 },
        'W23': { name: 'Celbridge / Maynooth (W23)', lat: 53.3814, lon: -6.5919 },
        'W91': { name: 'Naas area (W91)', lat: 53.2158, lon: -6.6669 },
        'C15': { name: 'Navan area (C15)', lat: 53.6528, lon: -6.6814 },
        'A85': { name: 'Dunshaughlin area (A85)', lat: 53.5125, lon: -6.5403 },
        'A91': { name: 'Dundalk area (A91)', lat: 54.0008, lon: -6.4059 },
        'A92': { name: 'Drogheda area (A92)', lat: 53.7179, lon: -6.3561 },
        // Midlands
        'R32': { name: 'Portlaoise area (R32)', lat: 53.0344, lon: -7.2998 },
        'R35': { name: 'Tullamore area (R35)', lat: 53.2739, lon: -7.4889 },
        'R42': { name: 'Birr area (R42)', lat: 53.0914, lon: -7.9133 },
        'N37': { name: 'Athlone area (N37)', lat: 53.4239, lon: -7.9407 },
        'N91': { name: 'Mullingar area (N91)', lat: 53.5259, lon: -7.3381 },
        'N39': { name: 'Longford area (N39)', lat: 53.7276, lon: -7.7933 },
        // Connacht & Ulster
        'H91': { name: 'Galway City / Connemara (H91)', lat: 53.2707, lon: -9.0568 },
        'H53': { name: 'Ballinasloe area (H53)', lat: 53.3275, lon: -8.2194 },
        'H54': { name: 'Tuam area (H54)', lat: 53.5139, lon: -8.8569 },
        'H62': { name: 'Loughrea area (H62)', lat: 53.1969, lon: -8.5669 },
        'H65': { name: 'Athenry area (H65)', lat: 53.2981, lon: -8.7458 },
        'H71': { name: 'Clifden area (H71)', lat: 53.4892, lon: -10.0206 },
        'F12': { name: 'Claremorris area (F12)', lat: 53.7206, lon: -9.0006 },
        'F23': { name: 'Castlebar area (F23)', lat: 53.8558, lon: -9.2989 },
        'F26': { name: 'Ballina area (F26)', lat: 54.1136, lon: -9.1561 },
        'F28': { name: 'Westport area (F28)', lat: 53.8000, lon: -9.5167 },
        'F42': { name: 'Roscommon area (F42)', lat: 53.6272, lon: -8.1892 },
        'F45': { name: 'Castlerea area (F45)', lat: 53.7667, lon: -8.4900 },
        'F52': { name: 'Boyle area (F52)', lat: 53.9722, lon: -8.3036 },
        'F91': { name: 'Sligo area (F91)', lat: 54.2766, lon: -8.4761 },
        'N41': { name: 'Carrick-on-Shannon area (N41)', lat: 53.9469, lon: -8.0900 },
        'F92': { name: 'Letterkenny area (F92)', lat: 54.9500, lon: -7.7333 },
        'F93': { name: 'Inishowen / Buncrana (F93)', lat: 55.1333, lon: -7.4500 },
        'F94': { name: 'Donegal Town / South Donegal (F94)', lat: 54.6539, lon: -8.1097 },
        'H12': { name: 'Cavan area (H12)', lat: 53.9908, lon: -7.3606 },
        'H18': { name: 'Monaghan area (H18)', lat: 54.2492, lon: -6.9683 }
    };

    const $ = function (id) { return document.getElementById(id); };
    const euro = function (n) { return (n < 0 ? '−€' : '€') + Math.abs(n).toFixed(2); };
    const pad2 = function (n) { return String(n).padStart(2, '0'); };

    /* ── Config ──────────────────────────────────────────────── */

    function num(id, fallback) {
        const el = $(id);
        if (!el) return fallback;
        const v = parseFloat(el.value);
        return isNaN(v) ? fallback : v;
    }

    function parseEvWindow(val) {
        const parts = String(val || '2-5').split('-');
        return { start: parseInt(parts[0], 10) || 2, end: parseInt(parts[1], 10) || 5 };
    }

    function readConfig() {
        const capacity = Math.max(0.5, num('sysCapacity', 5));
        const inverter = Math.max(0.5, num('inverterKw', capacity));
        const orientKey = $('panelOrientation').value;
        const array2Enabled = $('array2Enabled').checked;
        const array2Cap = Math.max(0, num('array2Capacity', 2.5));
        const evWin = parseEvWindow($('evWindowSelect').value);

        $('array2Fields').style.display = array2Enabled ? '' : 'none';

        state.solarConfig = {
            systemCapacityKwp: capacity,
            inverterKwAc: inverter,
            panelTiltDeg: Math.max(0, Math.min(90, num('panelTilt', 35))),
            panelAzimuthDeg: SM.ORIENTATIONS[orientKey] !== undefined ? SM.ORIENTATIONS[orientKey] : 180,
            orientationKey: orientKey,
            shadingLossPct: Math.max(0, Math.min(80, num('shadingLoss', 5))),
            systemAgeYears: Math.max(0, num('systemAge', 0)),
            calibrationPct: Math.max(70, Math.min(130, num('calibrationPct', 100))),
            array2: {
                enabled: array2Enabled,
                capacityKwp: array2Cap,
                tiltDeg: Math.max(0, Math.min(90, num('array2Tilt', 35))),
                azimuthDeg: SM.ORIENTATIONS[$('array2Orientation').value] !== undefined
                    ? SM.ORIENTATIONS[$('array2Orientation').value] : 270
            },
            latitude: state.location.latitude,
            longitude: state.location.longitude,
            elevation: state.location.elevation,
            utcOffsetSeconds: state.utcOffsetSeconds
        };

        const totalKwp = SM.totalArrayKwp(state.solarConfig);
        $('totalKwpBadge').textContent = totalKwp.toFixed(1) + ' kWp total' +
            (array2Enabled || orientKey === 'EAST_WEST' ? ' · split plane' : '');

        state.econConfig = {
            dailyUsageKwh: Math.max(0.5, num('dailyUsage', 10)),
            weatherAdjustedLoad: $('weatherAdjustedLoad').checked,
            loadProfile: $('loadProfile').value,
            customHourlyShape: state.meterData ? state.meterData.hourlyShape : null,
            flexSchedule: $('flexSchedule').value,
            battery: {
                enabled: $('batteryEnabled').checked,
                capacityKwh: Math.max(0, num('batteryCapacity', 5)),
                maxChargeKw: Math.max(0.5, num('batteryPower', 3)),
                maxDischargeKw: Math.max(0.5, num('batteryPower', 3)),
                roundTripEff: 0.90,
                minSocPct: 10,
                strategy: $('batteryStrategy').value,
                coupling: $('batteryCoupling').value
            },
            grid: {
                phase: $('gridPhase').value,
                exportLimitKw: Math.max(0, num('exportLimit', 6))
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
                dayRate: num('rateDay', 31.76),
                nightRate: num('rateNight', 24.67),
                evRate: num('rateEv', 9.96),
                peakRate: num('ratePeak', 40.95),
                exportRate: num('rateExport', 18.5),
                standingChargeEuroPerDay: num('standingCharge', 1.11),
                taxExemptionEuro: num('taxAllowance', 800),
                evStart: evWin.start,
                evEnd: evWin.end,
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
        const winKey = p.evStart + '-' + p.evEnd;
        if ($('evWindowSelect').querySelector('option[value="' + winKey + '"]')) {
            $('evWindowSelect').value = winKey;
        }
        document.querySelectorAll('[data-tariff]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-tariff') === key);
        });
    }

    const SETTING_IDS = ['sysCapacity', 'inverterKw', 'panelTilt', 'panelOrientation', 'shadingLoss',
        'systemAge', 'gridPhase', 'exportLimit', 'calibrationPct', 'array2Capacity', 'array2Tilt', 'array2Orientation',
        'dailyUsage', 'loadProfile', 'flexSchedule', 'batteryCapacity', 'batteryPower', 'batteryStrategy',
        'batteryCoupling', 'evKwh', 'evSessions', 'immersionKwh', 'rateDay', 'rateNight', 'rateEv',
        'evWindowSelect', 'ratePeak', 'rateExport', 'standingCharge', 'taxAllowance'];
    const TOGGLE_IDS = ['array2Enabled', 'weatherAdjustedLoad', 'batteryEnabled', 'evEnabled', 'immersionEnabled'];

    function saveSettings() {
        try {
            const data = {};
            SETTING_IDS.forEach(function (id) { if ($(id)) data[id] = $(id).value; });
            TOGGLE_IDS.forEach(function (id) { if ($(id)) data[id] = $(id).checked; });
            window.localStorage.setItem('solarPredictorSettings', JSON.stringify(data));
        } catch (e) { /* private browsing or file:// */ }
    }

    function loadSettings() {
        try {
            const raw = window.localStorage.getItem('solarPredictorSettings');
            if (raw) {
                const data = JSON.parse(raw);
                SETTING_IDS.forEach(function (id) { if (data[id] !== undefined && $(id)) $(id).value = data[id]; });
                TOGGLE_IDS.forEach(function (id) { if (data[id] !== undefined && $(id)) $(id).checked = data[id]; });
            }
        } catch (e) { /* ignore malformed saved settings */ }
        loadMeterData();
    }

    function saveMeterData() {
        try {
            if (state.meterData) {
                window.localStorage.setItem('solarPredictorMeter', JSON.stringify(state.meterData));
            } else {
                window.localStorage.removeItem('solarPredictorMeter');
            }
        } catch (e) { /* ignore storage limits */ }
    }

    function loadMeterData() {
        try {
            const raw = window.localStorage.getItem('solarPredictorMeter');
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (parsed && Array.isArray(parsed.hourlyShape) && parsed.hourlyShape.length === 24) {
                state.meterData = parsed;
                syncMeterProfileOption();
            }
        } catch (e) { /* ignore */ }
    }

    function syncMeterProfileOption() {
        const opt = $('customMeterOpt');
        if (!opt) return;
        if (state.meterData) {
            opt.disabled = false;
            opt.textContent = 'My ESB smart meter (' + state.meterData.profileDailyAvgKwh.toFixed(1) + ' kWh/d shape)';
        } else {
            opt.disabled = true;
            opt.textContent = 'My ESB smart meter (upload CSV)';
            if ($('loadProfile').value === 'CUSTOM_METER') {
                $('loadProfile').value = 'EVENING_PEAK';
            }
        }
    }

    function applyMeterUsageToModel() {
        const md = state.meterData;
        if (!md) return;
        syncMeterProfileOption();
        $('loadProfile').value = 'CUSTOM_METER';
        // Use current month's real seasonal average if available, otherwise overall baseline average
        const curMonthIdx = new Date().getMonth();
        const seasonalVal = md.seasonalByMonth && md.seasonalByMonth[curMonthIdx];
        const targetUsage = seasonalVal || md.profileDailyAvgKwh;
        if (targetUsage && targetUsage >= 1) {
            $('dailyUsage').value = (Math.round(targetUsage * 2) / 2).toFixed(1);
        }
        readConfig();
        process();
        renderAll();
    }

    function handleMeterFile(file) {
        if (!file || !MM) return;
        const errBox = $('meterErrorBanner');
        errBox.style.display = 'none';

        const reader = new FileReader();
        reader.onload = function (ev) {
            try {
                const parsed = MM.parseHdfCsv(String(ev.target.result || ''), file.name);
                state.meterData = parsed;
                saveMeterData();
                applyMeterUsageToModel();
            } catch (err) {
                errBox.textContent = 'Could not read CSV: ' + (err && err.message ? err.message : 'Invalid format');
                errBox.style.display = '';
            }
        };
        reader.onerror = function () {
            errBox.textContent = 'Could not open file. Please check file permissions and try again.';
            errBox.style.display = '';
        };
        reader.readAsText(file);
    }

    function clearMeterData() {
        state.meterData = null;
        saveMeterData();
        syncMeterProfileOption();
        if (state.chartMode === 'meter') {
            state.chartMode = 'flow';
            document.querySelectorAll('[data-chart]').forEach(function (b) {
                b.classList.toggle('active', b.getAttribute('data-chart') === 'flow');
            });
        }
        $('meterFileInput').value = '';
        readConfig();
        process();
        renderAll();
    }

    /* ── Geocoding (Eircodes, towns, and direct GPS lat,lon) ─── */

    async function geocode(query) {
        if (!query || !query.trim()) return null;
        const raw = query.trim();

        // 1. Direct lat, lon input (e.g. pasted from Google Maps: "52.3325, -9.1842")
        const coordMatch = /^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(raw);
        if (coordMatch) {
            const lat = parseFloat(coordMatch[1]);
            const lon = parseFloat(coordMatch[2]);
            if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
                return {
                    name: 'Custom coordinates (' + lat.toFixed(4) + '°, ' + lon.toFixed(4) + '°)',
                    lat: lat, lon: lon, precision: 'gps', note: 'Pinpoint coordinates'
                };
            }
        }

        const upper = raw.toUpperCase().replace(/[.,]/g, ' ').trim();
        const compact = upper.replace(/\s+/g, '');

        // 2. Exact built-in Irish database
        if (KNOWN_PLACES[compact]) return KNOWN_PLACES[compact];
        const firstWord = compact.split(/[^A-Z0-9]/)[0];
        if (KNOWN_PLACES[firstWord]) return KNOWN_PLACES[firstWord];

        const eircode = compact.replace(/[^A-Z0-9]/g, '');
        const isEircodeFormat = /^[AC-FHKNPRTV-Y]\d{2}[0-9AC-FHKNPRTV-Y]{4}$/.test(eircode);
        const formatted = isEircodeFormat ? eircode.slice(0, 3) + ' ' + eircode.slice(3) : raw;

        // 3. OpenStreetMap Nominatim (Irish Eircode / street / townland)
        try {
            const r = await fetch('https://nominatim.openstreetmap.org/search?q=' +
                encodeURIComponent(formatted + ', Ireland') + '&format=json&limit=1&countrycodes=ie');
            if (r.ok) {
                const j = await r.json();
                if (j && j.length) {
                    return {
                        name: j[0].display_name.split(',').slice(0, 3).join(', ') + (isEircodeFormat ? ' (' + formatted + ')' : ''),
                        lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon),
                        precision: isEircodeFormat ? 'exact' : 'town',
                        note: isEircodeFormat ? 'Exact address match' : 'Map match'
                    };
                }
            }
        } catch (e) { /* fall through */ }

        // 4. Open-Meteo Geocoding API (towns & villages)
        if (!isEircodeFormat) {
            try {
                const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' +
                    encodeURIComponent(raw) + '&count=5&language=en&format=json');
                if (r.ok) {
                    const j = await r.json();
                    if (j.results && j.results.length) {
                        // Prefer Irish matches first
                        const g = j.results.find(function (x) { return x.country_code === 'IE'; }) || j.results[0];
                        return {
                            name: g.name + (g.admin1 ? ', ' + g.admin1 : ''),
                            lat: g.latitude, lon: g.longitude,
                            precision: 'town', note: 'Town match'
                        };
                    }
                }
            } catch (e) { /* fall through */ }
        }

        // 5. Honest routing-key fallback (all Irish counties)
        if (eircode.length >= 3 && ROUTING_KEYS[eircode.slice(0, 3)]) {
            const rk = ROUTING_KEYS[eircode.slice(0, 3)];
            return {
                name: rk.name + (isEircodeFormat ? ' · ' + formatted : ''),
                lat: rk.lat, lon: rk.lon,
                precision: 'area',
                note: 'Routing-key area (~15 km) — use GPS or paste lat,lon for exact roof'
            };
        }
        return null;
    }

    /* ── Weather + Multi-Model Confidence Fetch ──────────────── */

    async function fetchWeather() {
        const tilt = Math.max(0, Math.min(90, num('panelTilt', 35)));
        const orientKey = $('panelOrientation').value;
        const panelAz = SM.ORIENTATIONS[orientKey];
        const isSingleFacing = (panelAz !== 'EAST_WEST') && !$('array2Enabled').checked;
        const omAzimuth = isSingleFacing ? Math.max(-180, Math.min(180, (Number(panelAz) || 180) - 180)) : 0;

        // wind_speed_unit=ms fixes the classic km/h-vs-m/s thermal model bug!
        const core = 'https://api.open-meteo.com/v1/forecast' +
            '?latitude=' + state.location.latitude +
            '&longitude=' + state.location.longitude +
            '&hourly=temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,' +
            'shortwave_radiation,direct_radiation,diffuse_radiation,direct_normal_irradiance,' +
            'sunshine_duration,snow_depth,is_day' +
            '&wind_speed_unit=ms';
        const tail = '&forecast_days=7&timezone=' + encodeURIComponent(state.location.timezone || 'Europe/Dublin');

        const attempts = [];
        if (isSingleFacing) {
            attempts.push(
                core.replace('sunshine_duration', 'global_tilted_irradiance,sunshine_duration') +
                '&tilt=' + tilt + '&azimuth=' + omAzimuth + tail
            );
        }
        attempts.push(core + tail);

        // Parallel lightweight multi-model comparison (ECMWF IFS 0.25°, ICON Seamless, UKMO UKV 2km)
        const multiUrl = 'https://api.open-meteo.com/v1/forecast' +
            '?latitude=' + state.location.latitude +
            '&longitude=' + state.location.longitude +
            '&hourly=shortwave_radiation,direct_radiation,diffuse_radiation' +
            '&models=ecmwf_ifs025,icon_seamless,ukmo_seamless' +
            '&forecast_days=7&timezone=' + encodeURIComponent(state.location.timezone || 'Europe/Dublin');

        const multiPromise = fetch(multiUrl)
            .then(function (r) { return r.ok ? r.json() : null; })
            .catch(function () { return null; });

        let mainData = null;
        for (let i = 0; i < attempts.length; i++) {
            try {
                const r = await fetch(attempts[i]);
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const data = await r.json();
                if (!data.hourly || !data.hourly.time) throw new Error('unexpected response shape');
                state.utcOffsetSeconds = data.utc_offset_seconds || 0;
                if (typeof data.elevation === 'number') state.location.elevation = Math.round(data.elevation);
                state.usingFallback = false;
                mainData = parseWeather(data);
                break;
            } catch (err) {
                console.warn('Weather request attempt ' + (i + 1) + ' failed:', err);
            }
        }

        const multiData = await multiPromise;
        state.modelSpread = (multiData && multiData.hourly && multiData.hourly.time) ? multiData : null;

        if (mainData) return mainData;

        state.usingFallback = true;
        state.utcOffsetSeconds = 0;
        state.modelSpread = null;
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
                wind_speed_ms: pick(h.wind_speed_10m, i),
                wind_speed_10m: pick(h.wind_speed_10m, i),
                shortwave_radiation: pick(h.shortwave_radiation, i),
                direct_radiation: pick(h.direct_radiation, i),
                diffuse_radiation: pick(h.diffuse_radiation, i),
                direct_normal_irradiance: pick(h.direct_normal_irradiance, i),
                global_tilted_irradiance: pick(h.global_tilted_irradiance, i),
                sunshine_duration: h.sunshine_duration ? pick(h.sunshine_duration, i) : undefined,
                snow_depth: pick(h.snow_depth, i),
                is_day: pick(h.is_day, i)
            });
        }
        return out;
    }

    /** Offline stand-in so the page still demonstrates the model without network. */
    function syntheticWeather() {
        const out = [];
        const now = new Date();
        const clearnessByDay = [0.90, 0.35, 0.20, 0.62, 0.80, 0.28, 0.55];

        for (let d = 0; d < 7; d++) {
            const k = clearnessByDay[d];
            const cloud = Math.round(Math.max(2, Math.min(100, (1 - k) * 115)));
            for (let hr = 0; hr < 24; hr++) {
                const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, hr);
                const time = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + 'T' + pad2(hr) + ':00';
                const stamp = SM.parseLocalStamp(time);
                const utcMillis = SM.toUtcMillis(stamp, 0);
                const cs = SM.clearSkyPoaPrecedingHour(utcMillis, state.location.latitude, state.location.longitude, 0, 180, state.location.elevation);
                const ghi = Math.max(0, cs.ghi * k);
                const diffuseShare = Math.min(1, 0.16 + 0.84 * (1 - k));
                out.push({
                    time: time, stamp: stamp, utcMillis: utcMillis,
                    temperature_2m: Math.round((11 + 5 * Math.sin((hr - 8) / 12 * Math.PI)) * 10) / 10,
                    precipitation: k < 0.35 ? 0.6 : 0,
                    weather_code: cloud > 85 ? 61 : cloud > 50 ? 3 : cloud > 25 ? 2 : 0,
                    cloud_cover: cloud,
                    wind_speed_ms: 4.5,
                    wind_speed_10m: 4.5,
                    shortwave_radiation: Math.round(ghi),
                    direct_radiation: Math.round(ghi * (1 - diffuseShare)),
                    diffuse_radiation: Math.round(ghi * diffuseShare),
                    direct_normal_irradiance: 0,
                    global_tilted_irradiance: 0,
                    sunshine_duration: cs.ghi > 20 ? 3600 * Math.max(0, Math.min(1, (k - 0.25) / 0.6)) : 0,
                    snow_depth: 0,
                    is_day: cs.ghi > 2 ? 1 : 0
                });
            }
        }
        return out;
    }

    /**
     * Evaluate ECMWF IFS, ICON-EU, and UKMO UKV through the exact same PV physics
     * engine to produce per-hour and per-day Low–High confidence envelopes.
     */
    function attachMultiModelConfidence(days, baseHourlyByTime) {
        if (!state.modelSpread || !state.modelSpread.hourly) return;
        const mh = state.modelSpread.hourly;
        const modelKeys = [
            { id: 'ecmwf_ifs025', name: 'ECMWF' },
            { id: 'icon_seamless', name: 'ICON' },
            { id: 'ukmo_seamless', name: 'UKMO' }
        ];

        // Index multi-model timestamps -> per-model hourly kW
        const byDate = {};
        const cfgNoGti = Object.assign({}, state.solarConfig, { ignoreApiGti: true });

        for (let i = 0; i < mh.time.length; i++) {
            const ts = mh.time[i];
            const dateKey = ts.split('T')[0];
            const base = baseHourlyByTime[ts];
            if (!base) continue;

            if (!byDate[dateKey]) {
                byDate[dateKey] = {
                    totals: {},
                    hourlyLow: new Array(24).fill(null),
                    hourlyHigh: new Array(24).fill(null)
                };
            }
            const hr = base.stamp.hour;
            const hrVals = [];

            modelKeys.forEach(function (mk) {
                const swArr = mh['shortwave_radiation_' + mk.id];
                if (!swArr || swArr[i] === null || swArr[i] === undefined) return;
                const dirArr = mh['direct_radiation_' + mk.id];
                const difArr = mh['diffuse_radiation_' + mk.id];

                const hObj = Object.assign({}, base, {
                    shortwave_radiation: swArr[i],
                    direct_radiation: (dirArr && dirArr[i] != null) ? dirArr[i] : 0,
                    diffuse_radiation: (difArr && difArr[i] != null) ? difArr[i] : swArr[i],
                    direct_normal_irradiance: 0,
                    global_tilted_irradiance: 0
                });
                const y = SM.calculateHourlyYield(hObj, cfgNoGti);
                hrVals.push(y.powerKw);
                if (!byDate[dateKey].totals[mk.name]) byDate[dateKey].totals[mk.name] = { kwh: 0, hours: 0 };
                byDate[dateKey].totals[mk.name].kwh += y.energyKwh;
                byDate[dateKey].totals[mk.name].hours += 1;
            });

            if (hrVals.length >= 2) {
                byDate[dateKey].hourlyLow[hr] = Math.round(Math.min.apply(null, hrVals) * 1000) / 1000;
                byDate[dateKey].hourlyHigh[hr] = Math.round(Math.max.apply(null, hrVals) * 1000) / 1000;
            }
        }

        days.forEach(function (day) {
            const entry = byDate[day.date];
            if (!entry) return;

            const validModels = [];
            Object.keys(entry.totals).forEach(function (name) {
                // Only count models that cover at least 20 hours of that day (UKMO stops after day 2/3)
                if (entry.totals[name].hours >= 20) {
                    validModels.push({ name: name, kwh: Math.round(entry.totals[name].kwh * 10) / 10 });
                }
            });

            if (validModels.length < 2) return;
            const vals = validModels.map(function (m) { return m.kwh; }).concat([day.totalKwh]);
            const lowKwh = Math.round(Math.min.apply(null, vals) * 10) / 10;
            const highKwh = Math.round(Math.max.apply(null, vals) * 10) / 10;
            const spread = highKwh - lowKwh;
            const relSpread = spread / Math.max(2.0, day.totalKwh);

            let level = 'high';
            let label = 'High confidence';
            if (relSpread > 0.35 && spread > 2.5) {
                level = 'low'; label = 'Low confidence';
            } else if (relSpread > 0.18 && spread > 1.2) {
                level = 'med'; label = 'Moderate confidence';
            }

            day.confidence = {
                level: level,
                label: label,
                lowKwh: lowKwh,
                highKwh: highKwh,
                spreadKwh: Math.round(spread * 10) / 10,
                models: validModels,
                hourlyLow: entry.hourlyLow,
                hourlyHigh: entry.hourlyHigh
            };
        });
    }

    /* ── Processing ──────────────────────────────────────────── */

    function process() {
        const groups = {};
        const order = [];
        const byTime = {};
        state.hourly.forEach(function (h) {
            const key = h.time.split('T')[0];
            if (!groups[key]) { groups[key] = []; order.push(key); }
            groups[key].push(h);
            byTime[h.time] = h;
        });

        state.days = order.map(function (k) {
            return SM.analyzeDailySolarForecast(groups[k], state.solarConfig);
        });
        attachMultiModelConfidence(state.days, byTime);

        // Sequential 7-day energy & battery dispatch (SOC carries over day to day!)
        state.sims = EM.simulateWeek(state.days, state.econConfig);
        // Location- & roof-specific 12-month PVGIS-calibrated estimate
        state.annualEstimate = SM.estimateMonthlyYield(state.solarConfig);

        if (state.selected >= state.days.length) state.selected = 0;
    }

    /* ── Irish Current Hour helper (for "Today" live status) ─── */

    function getCurrentIrishClock() {
        try {
            const now = new Date();
            const fmt = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'Europe/Dublin',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hour12: false
            });
            const parts = {};
            fmt.formatToParts(now).forEach(function (p) { parts[p.type] = p.value; });
            return {
                dateStr: parts.year + '-' + parts.month + '-' + parts.day,
                hour: parseInt(parts.hour, 10) % 24,
                minute: parseInt(parts.minute, 10) || 0
            };
        } catch (e) {
            const d = new Date();
            return {
                dateStr: d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()),
                hour: d.getHours(),
                minute: d.getMinutes()
            };
        }
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
            const rangeHtml = day.confidence
                ? '<div class="day-range">' + day.confidence.lowKwh.toFixed(1) + '–' + day.confidence.highKwh.toFixed(1) + ' kWh</div>'
                : '';

            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'day-card' + (i === state.selected ? ' selected' : '');
            card.setAttribute('aria-pressed', i === state.selected ? 'true' : 'false');
            card.innerHTML =
                '<div class="day-date">' + name + '</div>' +
                '<div class="day-sub">' + dt.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' }) + '</div>' +
                '<div class="day-icon">' + day.ratingIcon + '</div>' +
                '<div class="day-kwh">' + day.totalKwh.toFixed(1) + ' <span>kWh</span></div>' +
                rangeHtml +
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

        const annualGen = state.annualEstimate ? state.annualEstimate.annualKwh : SM.totalArrayKwp(state.solarConfig) * 870;
        const specificYield = state.annualEstimate ? state.annualEstimate.specificYield : 870;
        const weekSolar = state.sims.reduce(function (a, s) { return a + s.solarContribution; }, 0);
        const weekBattery = state.sims.reduce(function (a, s) { return a + s.batteryContribution; }, 0);
        const annualSaving = (weekGen > 0 ? (weekSolar / weekGen) * annualGen : 0) +
            (weekBattery / Math.max(1, state.sims.length)) * 365;

        $('weekTotals').innerHTML =
            block(weekGen.toFixed(1) + ' kWh', 'Generated over ' + state.days.length + ' days') +
            block(euro(weekCost), 'Electricity cost for the week') +
            block(euro(weekSaving), 'Saved against no solar') +
            block(euro(weekExport), 'Export income (CEG)') +
            block(Math.round(annualGen).toLocaleString('en-IE') + ' kWh/yr', specificYield + ' kWh/kWp for your roof') +
            block('≈ €' + Math.round(annualSaving).toLocaleString('en-IE'), 'Estimated yearly saving');
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

        const confEl = $('confidenceBadge');
        const rangeEl = $('kwhRangeText');
        if (day.confidence) {
            const c = day.confidence;
            const modelNames = c.models.map(function (m) { return m.name; }).join(' · ');
            confEl.className = 'confidence-pill conf-' + c.level;
            confEl.textContent = c.label + ' (' + modelNames + ')';
            confEl.style.display = '';

            rangeEl.textContent = 'Model range: ' + c.lowKwh.toFixed(1) + ' – ' + c.highKwh.toFixed(1) + ' kWh (' +
                c.models.map(function (m) { return m.name + ' ' + m.kwh.toFixed(1); }).join(', ') + ')';
            rangeEl.style.display = '';
        } else {
            confEl.style.display = 'none';
            rangeEl.style.display = 'none';
        }

        $('clearnessVal').textContent = Math.round(day.clearnessIndex * 100) + '%';
        $('sunshineVal').textContent = day.sunshineHours.toFixed(1) + 'h';
        $('avgCloudVal').textContent = day.avgCloudCover + '%';

        $('totalKwhVal').textContent = day.totalKwh.toFixed(1);
        $('yieldPerKwpVal').textContent = day.yieldPerKwp.toFixed(2);
        $('peakPowerVal').textContent = day.maxPowerKw.toFixed(2);
        $('peakHourVal').textContent = day.peakHourStr;
        $('applianceWindowVal').textContent = day.optimalWindow;

        // "Still to come today" calculation for live daytime viewing
        const remBox = $('remainingTodayCallout');
        const clock = getCurrentIrishClock();
        if (day.date === clock.dateStr) {
            // Remember hour slot H represents interval (H-1):00 to H:00.
            // If current clock is e.g. 10:20, interval 10 (09:00–10:00) is past,
            // interval 11 (10:00–11:00) has 40/60 remaining, and intervals >= 12 are fully ahead!
            let remainingKwh = 0;
            const currentSlot = (clock.hour + 1) % 24;
            const fracLeft = (60 - clock.minute) / 60;
            day.hourlyYields.forEach(function (h) {
                if (h.hour === currentSlot && clock.hour < 23) {
                    remainingKwh += h.energyKwh * fracLeft;
                } else if (h.hour > currentSlot || (clock.hour === 23 && h.hour === 0)) {
                    remainingKwh += h.energyKwh;
                }
            });
            if (remainingKwh > 0.05 && remainingKwh < day.totalKwh - 0.05) {
                $('remainingKwhVal').textContent = remainingKwh.toFixed(1) + ' kWh left from ' +
                    pad2(clock.hour) + ':' + pad2(clock.minute) + ' until sunset';
                remBox.style.display = '';
            } else {
                remBox.style.display = 'none';
            }
        } else {
            remBox.style.display = 'none';
        }

        $('dayCostVal').textContent = euro(sim.netCost);
        $('dayCostVal').className = sim.netCost < 0 ? 'pos' : '';
        $('dayBaselineVal').textContent = euro(sim.baselineCost);
        $('daySavingVal').textContent = euro(sim.savingVsNoSolar);
        $('dayUsageNote').textContent = state.econConfig.weatherAdjustedLoad
            ? ' (Weather-adjusted base load: ' + sim.loads.baseDaily.toFixed(1) + ' kWh.)'
            : '';
        $('exportKwhVal').textContent = sim.exportedKwh.toFixed(1);
        $('exportIncomeVal').textContent = euro(sim.exportIncome);

        const lossBox = $('lossCallout');
        if (sim.lostKwh > 0.05) {
            const bits = [];
            if (sim.clippedLostKwh > 0.05) bits.push(sim.clippedLostKwh.toFixed(1) + ' kWh clipped at the inverter');
            if (sim.curtailedKwh > 0.05) bits.push(sim.curtailedKwh.toFixed(1) + ' kWh held back by the export cap');
            if (sim.clippedRecoveredKwh > 0.05) bits.push(sim.clippedRecoveredKwh.toFixed(1) + ' kWh rescued by the battery');
            $('lossVal').textContent = bits.join(' · ') + ' — about ' + euro(sim.lostValue) + ' of it.';
            lossBox.style.display = '';
        } else {
            lossBox.style.display = 'none';
        }
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
        const prevSim = state.selected > 0 ? state.sims[state.selected - 1] : null;
        const initSoc = prevSim ? { solar: prevSim.result.endSocSolar, grid: prevSim.result.endSocGrid } : null;
        const comparison = EM.compareStrategies(day, state.econConfig, initSoc);

        $('strategyList').innerHTML = comparison.map(function (s, i) {
            return '<div class="strategy-row' + (i === 0 ? ' best' : '') + '">' +
                '<span class="s-name">' + s.label + '</span>' +
                (i === 0 ? '<span class="s-tag">cheapest</span>' : '') +
                '<span class="s-cost">' + euro(s.netCost) + '</span></div>';
        }).join('');

        const total = Math.max(0.01, Math.abs(sim.solarContribution) + Math.abs(sim.batteryContribution));
        $('splitBars').innerHTML =
            splitBar('From the panels', sim.solarContribution, total, '#f59e0b') +
            splitBar('From battery & rate shifting', sim.batteryContribution, total, '#a855f7') +
            splitBar('Solar used on site', sim.selfConsumptionPct, 100, '#10b981', sim.selfConsumptionPct + '%') +
            splitBar('House run on your own solar', sim.selfSufficiencyPct, 100, '#06b6d4', sim.selfSufficiencyPct + '%');
    }

    function splitBar(label, value, total, color, displayOverride) {
        const pct = Math.max(0, Math.min(100, (value / total) * 100));
        const shown = displayOverride || euro(value);
        return '<div class="split-item"><div class="split-head"><span>' + label + '</span><b>' + shown + '</b></div>' +
            '<div class="split-track"><div class="split-fill" style="width:' + pct + '%;background:' + color + '"></div></div></div>';
    }

    function renderSystemCheck() {
        const findings = EM.assessSystem(state.days, state.sims, state.solarConfig, state.econConfig);
        $('systemCheckGrid').innerHTML = findings.map(function (f) {
            return '<div class="check-card check-' + f.level + '">' +
                '<div class="check-head"><h4>' + f.title + '</h4>' +
                '<span class="check-metric">' + f.metric + '</span></div>' +
                '<p>' + f.body + '</p></div>';
        }).join('');
    }

    function renderInsights() {
        const totalKwp = SM.totalArrayKwp(state.solarConfig);
        const notes = EM.buildInsights(state.sims, state.econConfig, totalKwp, state.annualEstimate);
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

        const clock = getCurrentIrishClock();
        const isToday = day.date === clock.dateStr;
        const activeSlot = (clock.hour + 1) % 24;
        const totalKwp = SM.totalArrayKwp(state.solarConfig);

        const rows = {};
        sim.result.rows.forEach(function (r) { rows[r.hour] = r; });

        let html = '';
        day.hourlyYields.forEach(function (h) {
            const r = rows[h.hour] || {};
            const w = SM.WMO_WEATHER_CODES[h.weather_code] || { description: '—', icon: '·' };
            const icon = h.isDaylight ? w.icon : '🌙';
            const band = r.band || 'day';

            let powerClass = 'power-zero';
            if (h.powerKw >= totalKwp * 0.4) powerClass = 'power-high';
            else if (h.powerKw > 0.1) powerClass = 'power-mid';

            const batteryFlow = (r.solarToBattery || 0) + (r.gridToBattery || 0) - (r.batteryToLoad || 0);
            const socNote = state.econConfig.battery.enabled && state.econConfig.battery.capacityKwh > 0
                ? ' <span style="color:var(--text-subtle);font-size:0.72rem;">(' + (r.soc || 0).toFixed(1) + ')</span>'
                : '';
            const batteryText = Math.abs(batteryFlow) < 0.05
                ? '<span class="power-zero">—</span>' + socNote
                : (batteryFlow > 0
                    ? '<span class="flow-out">▲ ' + batteryFlow.toFixed(1) + '</span>' + socNote
                    : '<span class="flow-in">▼ ' + Math.abs(batteryFlow).toFixed(1) + '</span>' + socNote);

            let gridText = '<span class="power-zero">—</span>';
            if ((r.exported || 0) > 0.05) gridText = '<span class="flow-out">↑ ' + r.exported.toFixed(1) + ' sold</span>';
            else if ((r.gridImport || 0) > 0.05) gridText = '<span class="flow-in">↓ ' + r.gridImport.toFixed(1) + ' bought</span>';

            const isNow = isToday && (h.hour === activeSlot);
            const startHr = (h.hour + 23) % 24;
            const intervalLabel = pad2(startHr) + '–' + pad2(h.hour);
            const trClasses = [];
            if (!h.isDaylight) trClasses.push('is-night');
            if (isNow) trClasses.push('is-now');

            html += '<tr' + (trClasses.length ? ' class="' + trClasses.join(' ') + '"' : '') + '>' +
                '<td class="num">' + intervalLabel + (isNow ? '<span class="now-tag">NOW</span>' : '') + '</td>' +
                '<td><span class="rate-chip rate-' + band + '">' + EM.rateForBand(band, state.econConfig.tariff).toFixed(0) + 'c</span></td>' +
                '<td>' + icon + ' ' + w.description + (h.snowDerated ? ' ❄️' : '') + '</td>' +
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
            title: 'Generation, multi-model confidence & cloud cover',
            caption: 'Solid amber is the main forecast; the shaded amber band (when available) shows the spread across ECMWF, ICON and UKMO weather models. ' +
                'Dashed red above amber is DC power clipped by your inverter limit.'
        },
        battery: {
            title: 'Battery charge and what each hour costs',
            caption: 'Bars are coloured by rate band — purple is the cheap EV window, amber day rate, red peak. The green line is usable energy stored in the battery.'
        },
        irradiance: {
            title: 'Sunlight reaching the panels (preceding-hour aligned)',
            caption: 'Clear-sky potential is integrated over each preceding hour to match Open-Meteo radiation averages. ' +
                'The shaded gap between lines is what cloud took away — independent of shading or panel age.'
        },
        seasonal: {
            title: 'Expected 12-month yield for your exact roof',
            caption: 'PVGIS-calibrated Irish monthly forecast computed for your latitude, longitude, roof pitch, facing (including split planes), shading, panel age and inverter clipping.'
        },
        meter: {
            title: 'Your real ESB smart meter — monthly import vs export',
            caption: 'Directly parsed from your uploaded ESB Networks HDF CSV file. Watch export ramp up after solar switch-on and compare seasonal winter vs summer consumption.'
        }
    };

    function renderChart() {
        const day = state.days[state.selected];
        const sim = state.sims[state.selected];
        if (!day || !sim) return;

        const ctx = $('hourlyChart').getContext('2d');
        if (state.chart) state.chart.destroy();

        const labels = [];
        for (let h = 0; h < 24; h++) labels.push(pad2((h + 23) % 24) + '–' + pad2(h));

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
            const ds = [];
            if (day.confidence) {
                ds.push({
                    label: 'Model high (ECMWF/ICON/UKMO)',
                    data: labels.map(function (_, h) {
                        const v = day.confidence.hourlyHigh[h];
                        return v !== null ? Math.max(v, rows[h] ? rows[h].generation : 0) : (rows[h] ? rows[h].generation : 0);
                    }),
                    borderColor: 'rgba(251, 191, 36, 0.35)',
                    backgroundColor: 'rgba(245, 158, 11, 0.14)',
                    borderWidth: 1,
                    fill: '+1',
                    tension: 0.35,
                    pointRadius: 0,
                    yAxisID: 'y'
                });
                ds.push({
                    label: 'Model low (ECMWF/ICON/UKMO)',
                    data: labels.map(function (_, h) {
                        const v = day.confidence.hourlyLow[h];
                        return v !== null ? Math.min(v, rows[h] ? rows[h].generation : 0) : (rows[h] ? rows[h].generation : 0);
                    }),
                    borderColor: 'rgba(251, 191, 36, 0.35)',
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    fill: false,
                    tension: 0.35,
                    pointRadius: 0,
                    yAxisID: 'y'
                });
            }
            ds.push({
                label: 'Forecast generation (kW)', data: rows.map(function (r) { return r.generation; }),
                borderColor: '#f59e0b', backgroundColor: day.confidence ? 'transparent' : 'rgba(245,158,11,0.2)',
                fill: !day.confidence, tension: 0.35, borderWidth: 3, pointRadius: 0, yAxisID: 'y'
            });
            ds.push({
                label: 'Potential before clipping (kW)',
                data: labels.map(function (_, h) { return byHour[h] ? byHour[h].dcPotentialKw : 0; }),
                borderColor: 'rgba(244,63,94,0.75)', backgroundColor: 'transparent',
                borderDash: [4, 4], tension: 0.35, borderWidth: 2, pointRadius: 0, yAxisID: 'y'
            });
            ds.push({
                label: 'Cloud cover (%)',
                data: labels.map(function (_, h) { return byHour[h] ? byHour[h].cloud_cover : null; }),
                borderColor: '#06b6d4', backgroundColor: 'transparent',
                borderDash: [5, 5], tension: 0.25, borderWidth: 2, pointRadius: 0, yAxisID: 'y1'
            });

            config = {
                type: 'line',
                data: { labels: labels, datasets: ds },
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
        } else if (state.chartMode === 'seasonal') {
            const months = state.annualEstimate ? state.annualEstimate.months : [];
            const curMonth = new Date().getMonth();
            config = {
                type: 'bar',
                data: {
                    labels: months.map(function (m) { return m.label; }),
                    datasets: [
                        {
                            label: 'Expected monthly generation (kWh)',
                            data: months.map(function (m) { return m.kwh; }),
                            backgroundColor: months.map(function (m) {
                                return m.monthIndex === curMonth ? '#f59e0b' : 'rgba(245, 158, 11, 0.45)';
                            }),
                            borderColor: '#f59e0b',
                            borderWidth: 1,
                            borderRadius: 6,
                            yAxisID: 'y'
                        },
                        {
                            label: 'Daily average (kWh/day)',
                            type: 'line',
                            data: months.map(function (m) { return m.dailyAvgKwh; }),
                            borderColor: '#38bdf8',
                            backgroundColor: 'transparent',
                            borderWidth: 2.5,
                            tension: 0.35,
                            pointRadius: 3,
                            yAxisID: 'y1'
                        }
                    ]
                },
                options: Object.assign({}, base, {
                    scales: {
                        x: { grid: grid, ticks: tick },
                        y: { position: 'left', min: 0, grid: grid, ticks: tick, title: { display: true, text: 'kWh / month', color: '#f59e0b' } },
                        y1: { position: 'right', min: 0, grid: { drawOnChartArea: false }, ticks: tick, title: { display: true, text: 'kWh / day avg', color: '#38bdf8' } }
                    }
                })
            };
        } else if (state.chartMode === 'meter' && state.meterData) {
            const ms = state.meterData.monthlySeries || [];
            config = {
                type: 'bar',
                data: {
                    labels: ms.map(function (m) { return m.monthKey; }),
                    datasets: [
                        {
                            label: 'Grid Import (kWh)',
                            data: ms.map(function (m) { return m.importKwh; }),
                            backgroundColor: 'rgba(244, 63, 94, 0.65)',
                            borderColor: '#fb7185',
                            borderWidth: 1,
                            borderRadius: 4
                        },
                        {
                            label: 'Solar Export (kWh)',
                            data: ms.map(function (m) { return m.exportKwh; }),
                            backgroundColor: 'rgba(16, 185, 129, 0.72)',
                            borderColor: '#34d399',
                            borderWidth: 1,
                            borderRadius: 4
                        }
                    ]
                },
                options: Object.assign({}, base, {
                    scales: {
                        x: { grid: grid, ticks: tick },
                        y: { min: 0, grid: grid, ticks: tick, title: { display: true, text: 'kWh / month', color: '#94a3b8' } }
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

    function renderMeterSection() {
        const md = state.meterData;
        const summaryWrap = $('meterSummaryWrap');
        const historySection = $('meterHistorySection');
        const meterTabBtn = $('btnChartMeter');
        const btnApply = $('btnApplyMeterUsage');
        const btnClear = $('btnClearMeter');
        const statusBadge = $('meterStatusBadge');

        if (!md || !MM) {
            summaryWrap.style.display = 'none';
            historySection.style.display = 'none';
            meterTabBtn.style.display = 'none';
            btnApply.style.display = 'none';
            btnClear.style.display = 'none';
            statusBadge.className = 'precision-pill precision-town';
            statusBadge.textContent = '100% private · stays in your browser';
            $('meterDropTitle').textContent = 'Drop your ESB Networks HDF CSV here, or click to browse';
            $('meterDropSub').innerHTML = 'Supports <code>HDF_calckWh_*.csv</code> and <code>HDF_kW_*.csv</code> from esbnetworks.ie — unlocks your real 24-hour house usage profile, actual export earnings &amp; tariff back-testing.';
            return;
        }

        summaryWrap.style.display = '';
        historySection.style.display = '';
        meterTabBtn.style.display = '';
        btnApply.style.display = '';
        btnClear.style.display = '';
        statusBadge.className = 'precision-pill precision-exact';
        statusBadge.textContent = 'Linked · ' + md.totalDays + ' days' + (md.mprnMasked ? ' · MPRN ' + md.mprnMasked : '');

        $('meterDropTitle').textContent = 'Linked: ' + md.fileName + ' (' + md.minDate + ' → ' + md.maxDate + ')';
        $('meterDropSub').textContent = md.rowCount.toLocaleString('en-IE') + ' half-hour intervals parsed locally · ' +
            md.profileSourceLabel + ' active' + (md.isKwFormat ? ' · auto-converted kW → kWh' : '') + '. Drop a newer CSV anytime to refresh.';

        const t = state.econConfig.tariff;
        const totalExportEuro = t.exportEnabled ? (md.totalExportKwh * t.exportRate) / 100 : 0;
        const ytdExportEuro = t.exportEnabled ? (md.ytdExportKwh * t.exportRate) / 100 : 0;

        const kpi = function (val, lbl, sub) {
            return '<div class="meter-kpi"><b>' + val + '</b><span>' + lbl + '</span>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>';
        };

        let kpiHtml = '';
        kpiHtml += kpi(md.profileDailyAvgKwh.toFixed(1) + ' kWh/d', 'Your real house average', md.profileSourceLabel);
        kpiHtml += kpi(Math.round(md.totalImportKwh).toLocaleString('en-IE') + ' kWh', 'Total imported', md.totalDays + ' days on file');
        if (md.hasSolar) {
            kpiHtml += kpi(Math.round(md.totalExportKwh).toLocaleString('en-IE') + ' kWh', 'Actual solar exported', 'Worth ' + euro(totalExportEuro) + ' at ' + t.exportRate.toFixed(1) + 'c');
            kpiHtml += kpi(md.peakExportKw.toFixed(2) + ' kW', 'Peak half-hour export', 'Solar active since ' + md.firstExportDate);
        } else {
            kpiHtml += kpi('0 kWh', 'Solar export recorded', 'Pre-solar baseline ready for modelling');
        }
        $('meterKpis').innerHTML = kpiHtml;

        // Revenue CEG exemption tracker (€400 single / €800 joint account)
        const taxBar = $('meterTaxBar');
        const taxCap = t.taxExemptionEuro || 800;
        const taxLabel = taxCap >= 800 ? '€' + taxCap + ' Joint Revenue Tax-Free Allowance' : '€' + taxCap + ' Revenue Tax-Free Allowance';
        if (md.hasSolar && t.exportEnabled) {
            const pct = Math.min(100, Math.round((ytdExportEuro / taxCap) * 100));
            const remaining = Math.max(0, taxCap - ytdExportEuro);
            const barColor = ytdExportEuro >= taxCap ? '#f43f5e' : (ytdExportEuro >= taxCap * 0.75 ? '#f59e0b' : '#10b981');
            taxBar.innerHTML =
                '<div class="meter-tax-head">' +
                '<span>🇮🇪 <strong>' + md.latestYear + '</strong> Real Export Income vs ' + taxLabel + '</span>' +
                '<strong>' + euro(ytdExportEuro) + ' / €' + taxCap.toFixed(2) + ' (' + pct + '%)</strong>' +
                '</div>' +
                '<div class="split-track"><div class="split-fill" style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
                '<div style="font-size:0.72rem;color:var(--text-subtle);margin-top:6px;">' +
                md.ytdExportKwh.toFixed(1) + ' kWh exported in ' + md.latestYear + ' at ' + t.exportRate.toFixed(1) + 'c/kWh — ' +
                (ytdExportEuro >= taxCap
                    ? 'above the €' + taxCap + ' tax-free microgeneration threshold by ' + euro(ytdExportEuro - taxCap) + '.'
                    : euro(remaining) + ' of tax-free headroom remaining in ' + md.latestYear + '.') +
                '</div>';
            taxBar.style.display = '';
        } else {
            taxBar.style.display = 'none';
        }

        // Back-test tariffs on real half-hourly meter intervals
        const bt = MM.backtestTariffs(md, t);
        if (!bt) return;

        // Show automatic timer-spillover / clock-drift warning if charging leaks outside EV hours
        const leakBox = $('meterTimerLeakCallout');
        if (bt.timerLeak) {
            const lk = bt.timerLeak;
            $('meterTimerLeakText').textContent = 'About ' + lk.monthlyExcessKwh.toFixed(1) + ' kWh/month (' +
                lk.periodExcessKwh.toFixed(1) + ' kWh in this period) is being pulled during ' + lk.hourLabel +
                ' at the ' + t.nightRate.toFixed(2) + 'c Night rate instead of your ' + lk.evWindowLabel +
                ' (' + t.evRate.toFixed(2) + 'c) EV window — often caused by a battery/EV timer set to UTC instead of Irish Summer Time. ' +
                'Shifting that start time saves roughly ' + euro(lk.annualExtraEuro) + '/year.';
            leakBox.style.display = '';
        } else {
            leakBox.style.display = 'none';
        }

        $('meterPeriodSubtitle').textContent = bt.periodLabel;

        const colors = { ev: 'var(--band-ev)', night: 'var(--band-night)', day: 'var(--band-day)', peak: 'var(--band-peak)' };
        let bHtml = '';
        ['ev', 'night', 'day', 'peak'].forEach(function (band) {
            const b = bt.current.byBand[band];
            if (!b || b.kwh < 0.05) return;
            bHtml += '<tr><td><span class="band-dot" style="background:' + colors[band] + '"></span>' +
                EM.bandLabel(band) + '</td><td>' + b.kwh.toFixed(1) + ' kWh</td><td>' +
                EM.rateForBand(band, t).toFixed(1) + 'c</td><td>' + euro(b.cost) + '</td></tr>';
        });
        bHtml += '<tr class="sub-row"><td>Standing charge (' + bt.period.days + 'd)</td><td>—</td><td>—</td><td>' + euro(bt.current.standingCost) + '</td></tr>';
        bHtml += '<tr class="sub-row"><td>Actual export credit</td><td>' + bt.period.exportKwh.toFixed(1) + ' kWh</td><td>' +
            t.exportRate.toFixed(1) + 'c</td><td class="pos">−' + euro(bt.current.exportCredit) + '</td></tr>';
        bHtml += '<tr class="total-row"><td>Period net total</td><td>—</td><td>—</td><td>' + euro(bt.current.netCost) + '</td></tr>';
        bHtml += '<tr class="sub-row"><td>Annualised equivalent</td><td>—</td><td>365d</td><td>' + euro(bt.current.annualisedNet) + '/yr</td></tr>';
        $('meterBandTableBody').innerHTML = bHtml;

        $('meterTariffCompare').innerHTML = bt.comparisons.map(function (c, i) {
            const diffVsCurrent = bt.current.netCost - c.netCost;
            const saveTag = (i === 0 && diffVsCurrent > 5)
                ? '<span class="s-tag">saves ' + euro(diffVsCurrent) + '</span>'
                : (i === 0 ? '<span class="s-tag">cheapest</span>' : '');
            return '<div class="strategy-row' + (i === 0 ? ' best' : '') + '">' +
                '<span class="s-name">' + c.name + '</span>' + saveTag +
                '<span class="s-cost">' + euro(c.netCost) + ' <small style="color:var(--text-subtle);font-weight:500;">(' + euro(c.annualisedNet) + '/yr)</small></span></div>';
        }).join('');

        // Calibration hint comparing observed meter peak export against configured inverter/export cap
        const hintEl = $('meterCalibrationHint');
        if (md.hasSolar && md.peakExportKw > 0.5) {
            const inv = state.solarConfig.inverterKwAc;
            const expCap = state.econConfig.grid.exportLimitKw;
            if (md.peakExportKw > inv + 0.3) {
                hintEl.innerHTML = '<strong>Inverter check:</strong> Your meter peaked at <strong>' + md.peakExportKw.toFixed(2) +
                    ' kW</strong> export, which is higher than your configured ' + inv + ' kW inverter — consider raising your inverter limit above.';
            } else {
                hintEl.innerHTML = '<strong>Meter check:</strong> Peak recorded export is <strong>' + md.peakExportKw.toFixed(2) +
                    ' kW</strong> (within your ' + Math.min(inv, expCap).toFixed(1) + ' kW limit). Your real 24-hour load profile is ' +
                    ($('loadProfile').value === 'CUSTOM_METER' ? '<strong>active</strong> in the forecast.' : 'ready — select <em>My ESB smart meter</em> in Usage pattern.');
            }
        } else {
            hintEl.innerHTML = 'Your real 24-hour household usage rhythm is loaded and ready for solar &amp; battery modelling.';
        }
    }

    function renderAll() {
        renderMeterSection();
        renderWeek();
        renderHero();
        renderCosts();
        renderSystemCheck();
        renderInsights();
        renderHourlyTable();
        renderChart();
    }

    /* ── Loading & Location UI ───────────────────────────────── */

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
            Math.abs(l.longitude).toFixed(4) + '° ' + (l.longitude >= 0 ? 'E' : 'W') +
            ' · ' + Math.round(l.elevation || 0) + ' m';

        const badge = $('locationPrecisionBadge');
        if (badge) {
            const cls = (l.precision === 'exact' || l.precision === 'gps') ? 'precision-exact'
                : (l.precision === 'area' ? 'precision-area' : 'precision-town');
            badge.className = 'precision-pill ' + cls;
            badge.textContent = l.precisionNote || 'Exact match';
        }
    }

    async function refresh(message) {
        showLoading(message);
        readConfig();
        state.hourly = await fetchWeather();
        readConfig(); // pick up real UTC offset & elevation returned by Open-Meteo
        updateLocationLabels();
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
            window.alert('No match for "' + query + '". Try an Irish Eircode (e.g. V42 AD96), a town name, or paste GPS coordinates like 52.3325, -9.1842.');
            return;
        }
        state.location.name = geo.name;
        state.location.latitude = geo.lat;
        state.location.longitude = geo.lon;
        state.location.precision = geo.precision || 'town';
        state.location.precisionNote = geo.note || 'Location match';
        updateLocationLabels();
        await refresh('Running the model for ' + geo.name);
    }

    function handleGpsLookup() {
        if (!navigator.geolocation) {
            window.alert('GPS geolocation is not supported in this browser. You can paste coordinates like 52.4497, -9.0612 into the search box instead.');
            return;
        }
        showLoading('Getting your GPS location…');
        navigator.geolocation.getCurrentPosition(
            async function (pos) {
                const lat = Math.round(pos.coords.latitude * 10000) / 10000;
                const lon = Math.round(pos.coords.longitude * 10000) / 10000;
                state.location.name = 'My GPS location (' + lat.toFixed(4) + '°, ' + lon.toFixed(4) + '°)';
                state.location.latitude = lat;
                state.location.longitude = lon;
                state.location.precision = 'gps';
                state.location.precisionNote = 'GPS pinpoint (±' + Math.round(pos.coords.accuracy || 20) + ' m)';
                $('locationSearchInput').value = lat + ', ' + lon;
                updateLocationLabels();
                await refresh('Running the model for your exact roof…');
            },
            function () {
                hideLoading();
                window.alert('Could not read GPS location. Allow location permission or paste coordinates (e.g. 52.3325, -9.1842) into the search box.');
            },
            { enableHighAccuracy: true, timeout: 10000 }
        );
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
                state.location.precision = geo.precision || 'town';
                state.location.precisionNote = geo.note || 'Location match';
            }
        }
        updateLocationLabels();

        $('btnSearchLocation').addEventListener('click', function () { handleSearch(); });
        $('btnUseGps').addEventListener('click', handleGpsLookup);
        $('locationSearchInput').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') handleSearch();
        });

        // ESB Smart Meter HDF CSV upload handlers
        const dropzone = $('meterDropzone');
        const fileInput = $('meterFileInput');
        $('btnPickMeterCsv').addEventListener('click', function (e) {
            e.stopPropagation();
            fileInput.click();
        });
        dropzone.addEventListener('click', function (e) {
            if (e.target.closest('button')) return;
            fileInput.click();
        });
        dropzone.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
        });
        dropzone.addEventListener('dragover', function (e) {
            e.preventDefault();
            dropzone.classList.add('drag-over');
        });
        dropzone.addEventListener('dragleave', function () {
            dropzone.classList.remove('drag-over');
        });
        dropzone.addEventListener('drop', function (e) {
            e.preventDefault();
            dropzone.classList.remove('drag-over');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleMeterFile(e.dataTransfer.files[0]);
            }
        });
        fileInput.addEventListener('change', function () {
            if (fileInput.files && fileInput.files[0]) handleMeterFile(fileInput.files[0]);
        });
        $('btnApplyMeterUsage').addEventListener('click', function (e) {
            e.stopPropagation();
            applyMeterUsageToModel();
        });
        $('btnClearMeter').addEventListener('click', function (e) {
            e.stopPropagation();
            clearMeterData();
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

        $('gridPhase').addEventListener('change', function () {
            $('exportLimit').value = (EM.NC6_LIMIT[$('gridPhase').value] || 6).toFixed(1);
            readConfig(); process(); renderAll();
        });

        // Roof angle/split changes re-fetch tilted irradiance when single-plane; others compute locally
        $('btnRecalculate').addEventListener('click', function () { refresh('Recalculating…'); });
        ['panelTilt', 'panelOrientation', 'array2Enabled'].forEach(function (id) {
            $(id).addEventListener('change', function () { refresh('Re-running for the new roof setup…'); });
        });
        SETTING_IDS.concat(TOGGLE_IDS).forEach(function (id) {
            if (id === 'panelTilt' || id === 'panelOrientation' || id === 'array2Enabled' || !$(id)) return;
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
