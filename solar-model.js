/**
 * Irish Solar Weather & Physics Model
 * Default location: Newcastle West, Co. Limerick (52.4497° N, -9.0612° W)
 *
 * Physics upgrades:
 *  - Spencer (1971) solar astronomy (declination, equation of time, Earth–Sun distance)
 *  - Preceding-hour interval alignment (Open-Meteo hourly radiation is the average of
 *    [t-60m, t], so sun geometry uses the midpoint t-30m and clear-sky integrates over
 *    [t-60m, t] via 4-point midpoint quadrature)
 *  - Ineichen–Perez / Hottel clear-sky irradiance with site elevation pressure scaling
 *  - Hay–Davies anisotropic transposition (beam + circumsolar + isotropic sky + albedo)
 *  - Martin–Ruiz Incidence Angle Modifier (glass reflection losses at steep angles)
 *  - Faiman PV module temperature model (wind speed in m/s) + Sandia part-load inverter curve
 *  - Snow-cover derating, East–West 50/50 split, and optional second roof plane
 *  - Sky rating decoupled from shading/age (pure irradiance clearness index)
 *  - PVGIS-calibrated 12-month location- & roof-specific annual yield model
 */

window.SolarModel = (function () {
    'use strict';

    const DEFAULT_LOCATION = {
        name: 'Newcastle West, Co. Limerick (V42 AD96)',
        latitude: 52.4497,
        longitude: -9.0612,
        elevation: 61,
        timezone: 'Europe/Dublin'
    };

    const ORIENTATIONS = {
        'SOUTH': 180,
        'SOUTH_SOUTH_WEST': 202.5,
        'SOUTH_WEST': 225,
        'WEST': 270,
        'SOUTH_SOUTH_EAST': 157.5,
        'SOUTH_EAST': 135,
        'EAST': 90,
        'NORTH_WEST': 315,
        'NORTH_EAST': 45,
        'EAST_WEST': 'EAST_WEST' // True 50/50 split: half facing 90° (East), half 270° (West)
    };

    const WMO_WEATHER_CODES = {
        0: { description: 'Clear sky', icon: '☀️' },
        1: { description: 'Mainly clear', icon: '🌤️' },
        2: { description: 'Partly cloudy', icon: '⛅' },
        3: { description: 'Overcast', icon: '☁️' },
        45: { description: 'Fog', icon: '🌫️' },
        48: { description: 'Freezing fog', icon: '🌫️' },
        51: { description: 'Light drizzle', icon: '🌦️' },
        53: { description: 'Drizzle', icon: '🌦️' },
        55: { description: 'Heavy drizzle', icon: '🌧️' },
        56: { description: 'Freezing drizzle', icon: '🌧️' },
        61: { description: 'Slight rain', icon: '🌧️' },
        63: { description: 'Moderate rain', icon: '🌧️' },
        65: { description: 'Heavy rain', icon: '🌧️' },
        66: { description: 'Freezing rain', icon: '🌧️' },
        71: { description: 'Slight snow', icon: '🌨️' },
        73: { description: 'Snow', icon: '🌨️' },
        75: { description: 'Heavy snow', icon: '🌨️' },
        77: { description: 'Snow grains', icon: '🌨️' },
        80: { description: 'Rain showers', icon: '🌦️' },
        81: { description: 'Heavy showers', icon: '🌧️' },
        82: { description: 'Violent showers', icon: '⛈️' },
        85: { description: 'Snow showers', icon: '🌨️' },
        86: { description: 'Heavy snow showers', icon: '🌨️' },
        95: { description: 'Thunderstorm', icon: '⛈️' },
        96: { description: 'Thunderstorm, hail', icon: '⛈️' },
        99: { description: 'Thunderstorm, hail', icon: '⛈️' }
    };

    const SNOW_CODES = { 71: 1, 73: 1, 75: 1, 77: 1, 85: 1, 86: 1 };

    const RAD = Math.PI / 180;
    const ALBEDO = 0.20;
    const SOLAR_CONSTANT = 1361; // W/m² (Kopp & Lean TSI)
    const HOUR_MS = 3600000;

    // Monthly clear-sky index (Kc = actual GHI / clear-sky GHI) calibrated against
    // Met Éireann (Shannon / Valentia) & PVGIS-SARAH3 for Co. Limerick (~960 kWh/m²/yr GHI).
    const IE_MONTHLY_CLEARSKY_INDEX = [0.46, 0.51, 0.56, 0.62, 0.65, 0.62, 0.60, 0.59, 0.57, 0.51, 0.46, 0.43];
    const IE_MONTHLY_TEMP_C = [5.5, 5.8, 7.4, 9.2, 11.8, 14.4, 16.0, 15.8, 13.8, 10.8, 7.8, 6.0];
    const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /* ------------------------------------------------------------------ *
     * Time helpers
     * Open-Meteo returns local wall-clock strings ("2026-07-27T13:00") with
     * no zone suffix. Parse fields directly and convert with utc_offset_seconds.
     * ------------------------------------------------------------------ */

    function parseLocalStamp(str) {
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(str));
        if (!m) {
            const d = new Date(str);
            return {
                year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
                hour: d.getHours(), minute: d.getMinutes()
            };
        }
        return {
            year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5]
        };
    }

    function toUtcMillis(stamp, utcOffsetSeconds) {
        return Date.UTC(stamp.year, stamp.month - 1, stamp.day, stamp.hour, stamp.minute)
            - (utcOffsetSeconds || 0) * 1000;
    }

    function dayOfYearUtc(millis) {
        const d = new Date(millis);
        return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
            - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
    }

    /* ------------------------------------------------------------------ *
     * Spencer (1971) Solar Astronomy (UTC ms in, degrees & E0 out)
     * Accurate to ~0.01° declination and ~30s equation of time.
     * ------------------------------------------------------------------ */

    function getSunPosition(utcMillis, lat, lon) {
        lat = (lat === undefined) ? DEFAULT_LOCATION.latitude : lat;
        lon = (lon === undefined) ? DEFAULT_LOCATION.longitude : lon;

        const d = new Date(utcMillis);
        const n = dayOfYearUtc(utcMillis);
        const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
        const gamma = (2 * Math.PI / 365) * (n - 1 + (utcHours - 12) / 24);

        // Earth–Sun eccentricity correction factor E0 = (r0 / r)^2
        const eccentricity = 1.000110
            + 0.034221 * Math.cos(gamma) + 0.001280 * Math.sin(gamma)
            + 0.000719 * Math.cos(2 * gamma) + 0.000077 * Math.sin(2 * gamma);

        // Solar declination in radians
        const declRad = 0.006918
            - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
            - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
            - 0.002697 * Math.cos(3 * gamma) + 0.001480 * Math.sin(3 * gamma);

        // Equation of time in minutes
        const eqOfTime = 229.18 * (0.000075
            + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
            - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));

        const solarTime = utcHours + (lon / 15) + (eqOfTime / 60);
        const hourAngle = (solarTime - 12) * 15;
        const latRad = lat * RAD;
        const haRad = hourAngle * RAD;

        const sinEl = Math.sin(latRad) * Math.sin(declRad) +
            Math.cos(latRad) * Math.cos(declRad) * Math.cos(haRad);
        const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;

        let azimuth = 180;
        const cosEl = Math.cos(elevation * RAD);
        if (Math.abs(cosEl) > 1e-6) {
            const cosAz = (Math.sin(declRad) * Math.cos(latRad) -
                Math.cos(declRad) * Math.sin(latRad) * Math.cos(haRad)) / cosEl;
            azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) / RAD;
            if (hourAngle > 0) azimuth = 360 - azimuth;
        }

        return {
            elevation: elevation,
            azimuth: azimuth,
            eccentricity: eccentricity,
            extraterrestrialNormal: SOLAR_CONSTANT * eccentricity
        };
    }

    /** Cosine of the angle of incidence on a tilted plane. */
    function cosIncidence(sunEl, sunAz, tiltDeg, panelAz) {
        return Math.sin(RAD * sunEl) * Math.cos(RAD * tiltDeg) +
            Math.cos(RAD * sunEl) * Math.sin(RAD * tiltDeg) * Math.cos(RAD * (sunAz - panelAz));
    }

    /**
     * Martin–Ruiz (2001) Incidence Angle Modifier for AR-coated solar glass.
     * Accounts for increased reflection at steep angles of incidence (>50°).
     */
    function iamMartinRuiz(cosTheta, ar) {
        if (cosTheta <= 0) return 0;
        ar = ar || 0.16; // modern anti-reflective coated PV glass
        const num = 1 - Math.exp(-cosTheta / ar);
        const den = 1 - Math.exp(-1 / ar);
        return Math.max(0, Math.min(1, num / den));
    }

    /** Effective IAM for isotropic sky diffuse and ground-reflected irradiance. */
    function iamDiffuse(tiltDeg) {
        const t = tiltDeg * RAD;
        // Effective incidence angle for diffuse dome (Brandemuehl & Beckman)
        const effAngleDeg = 59.7 - 0.1388 * tiltDeg + 0.001497 * tiltDeg * tiltDeg;
        return iamMartinRuiz(Math.cos(Math.max(15, Math.min(80, effAngleDeg)) * RAD));
    }

    /**
     * Ineichen–Perez / Meinel-elevation clear-sky model at a single instant.
     * Incorporates site elevation (pressure-corrected Kasten-Young air mass) and
     * Earth–Sun distance eccentricity.
     */
    function clearSkyPoaInstant(sun, tiltDeg, panelAz, elevationM) {
        if (sun.elevation <= 0.5) return { poa: 0, ghi: 0, dni: 0, dhi: 0 };

        const elev = Math.max(0, elevationM || 0);
        const pressureRatio = Math.exp(-elev / 8434.5);
        const sinEl = Math.sin(RAD * sun.elevation);
        const am0 = 1 / (sinEl + 0.50572 * Math.pow(sun.elevation + 6.07995, -1.6364));
        const airMass = am0 * pressureRatio;

        // Clean maritime/Irish Linke turbidity (~2.6) clear-sky beam & diffuse
        const e0 = sun.extraterrestrialNormal || SOLAR_CONSTANT;
        const dni = Math.max(0, e0 * Math.pow(0.70, Math.pow(airMass, 0.678)));
        const dhi = Math.max(0, 0.115 * dni * sinEl + 0.025 * e0 * sinEl * Math.pow(airMass, -0.3));
        const ghi = dni * sinEl + dhi;

        const cosI = Math.max(0, cosIncidence(sun.elevation, sun.azimuth, tiltDeg, panelAz));
        const poa = hayDaviesPoa(dni, dhi, ghi, sun.elevation, cosI, tiltDeg, e0);

        return { poa: poa, ghi: ghi, dni: dni, dhi: dhi };
    }

    /**
     * Hay–Davies anisotropic transposition model.
     * Splits diffuse into circumsolar (concentrated around the sun) and
     * isotropic sky dome, plus ground reflection (albedo).
     */
    function hayDaviesPoa(dni, dhi, ghi, sunEl, cosI, tiltDeg, e0) {
        const tiltRad = tiltDeg * RAD;
        const sinEl = Math.max(0.06, Math.sin(RAD * sunEl));
        const rb = cosI / sinEl; // geometric beam factor (capped implicitly by cosI >= 0)
        const rbCapped = Math.min(rb, 6.0);

        // Anisotropy index Ai = DNI / E0
        const ai = Math.max(0, Math.min(1, dni / (e0 || SOLAR_CONSTANT)));

        const beamTilted = dni * cosI;
        const diffuseCircumsolar = dhi * ai * rbCapped;
        const diffuseIsotropic = dhi * (1 - ai) * ((1 + Math.cos(tiltRad)) / 2);
        const groundReflected = ghi * ALBEDO * ((1 - Math.cos(tiltRad)) / 2);

        return Math.max(0, beamTilted + diffuseCircumsolar + diffuseIsotropic + groundReflected);
    }

    /**
     * Clear-sky POA averaged over the preceding hour [utcMillis - 1h, utcMillis]
     * using 4-point midpoint quadrature (-52.5m, -37.5m, -22.5m, -7.5m) to match
     * Open-Meteo's preceding-hour radiation average convention.
     */
    function clearSkyPoaPrecedingHour(utcMillis, lat, lon, tiltDeg, panelAz, elevationM) {
        const offsets = [-0.875, -0.625, -0.375, -0.125];
        let poaSum = 0;
        let ghiSum = 0;
        for (let i = 0; i < offsets.length; i++) {
            const sun = getSunPosition(utcMillis + offsets[i] * HOUR_MS, lat, lon);
            const cs = clearSkyPoaInstant(sun, tiltDeg, panelAz, elevationM);
            poaSum += cs.poa;
            ghiSum += cs.ghi;
        }
        return { poa: poaSum / offsets.length, ghi: ghiSum / offsets.length };
    }

    /** Backwards-compatible instant clearSkyPoa helper. */
    function clearSkyPoa(sunEl, sunAz, tiltDeg, panelAz, elevationM) {
        return clearSkyPoaInstant(
            { elevation: sunEl, azimuth: sunAz, extraterrestrialNormal: SOLAR_CONSTANT },
            tiltDeg, panelAz, elevationM
        );
    }

    /**
     * Expand array configuration into an explicit list of physical planes:
     *  - Single plane (normal)
     *  - East–West 50/50 split (two planes at 90° and 270°)
     *  - Optional second roof plane (array2Enabled + array2Kwp + array2Tilt + array2Azimuth)
     */
    function getArrayPlanes(cfg) {
        const cap1 = Math.max(0.1, cfg.systemCapacityKwp || 5.0);
        const tilt1 = (cfg.panelTiltDeg === undefined) ? 35 : cfg.panelTiltDeg;
        const az1 = (cfg.panelAzimuthDeg === undefined) ? 180 : cfg.panelAzimuthDeg;

        const planes = [];
        if (az1 === 'EAST_WEST' || cfg.orientationKey === 'EAST_WEST') {
            planes.push({ capacityKwp: cap1 * 0.5, tiltDeg: tilt1, azimuthDeg: 90, isPrimarySingle: false });
            planes.push({ capacityKwp: cap1 * 0.5, tiltDeg: tilt1, azimuthDeg: 270, isPrimarySingle: false });
        } else {
            planes.push({ capacityKwp: cap1, tiltDeg: tilt1, azimuthDeg: Number(az1) || 180, isPrimarySingle: true });
        }

        if (cfg.array2 && cfg.array2.enabled && cfg.array2.capacityKwp > 0) {
            const az2 = cfg.array2.azimuthDeg;
            const tilt2 = (cfg.array2.tiltDeg === undefined) ? tilt1 : cfg.array2.tiltDeg;
            if (az2 === 'EAST_WEST') {
                planes.push({ capacityKwp: cfg.array2.capacityKwp * 0.5, tiltDeg: tilt2, azimuthDeg: 90, isPrimarySingle: false });
                planes.push({ capacityKwp: cfg.array2.capacityKwp * 0.5, tiltDeg: tilt2, azimuthDeg: 270, isPrimarySingle: false });
            } else {
                planes.push({ capacityKwp: cfg.array2.capacityKwp, tiltDeg: tilt2, azimuthDeg: Number(az2) || 180, isPrimarySingle: false });
            }
            // If a second plane exists, mark primary plane as part of multi-plane (GTI applies only to plane 0)
        }
        return planes;
    }

    function totalArrayKwp(cfg) {
        return getArrayPlanes(cfg).reduce(function (s, p) { return s + p.capacityKwp; }, 0);
    }

    /**
     * Realistic part-load inverter efficiency curve (Sandia/Euro weighted).
     * Peaks at ~97.6% around 35–55% load, rolls off cleanly at low load (<10%).
     */
    function inverterEfficiency(dcKw, inverterKwAc) {
        if (dcKw <= 0.015 || inverterKwAc <= 0) return 0; // <15 W self-consumption / startup threshold
        const x = dcKw / inverterKwAc;
        // Smooth physical curve: eff = 0.982 - 0.012*x - 0.0085/x (capped to realistic bounds)
        const eff = 0.982 - 0.012 * Math.min(1.5, x) - 0.0085 / Math.max(0.025, x);
        return Math.max(0.55, Math.min(0.978, eff));
    }

    /**
     * Compute plane-of-array irradiance and effective (IAM-adjusted) irradiance
     * for a single plane during the preceding hour.
     */
    function planeIrradiance(weatherHour, plane, sunMid, canUseApiGti) {
        const shortwave = weatherHour.shortwave_radiation || 0;
        const direct = weatherHour.direct_radiation || 0;
        const dniFeed = weatherHour.direct_normal_irradiance || 0;
        const diffuse = weatherHour.diffuse_radiation || 0;
        const globalTilted = weatherHour.global_tilted_irradiance || 0;

        const cosI = sunMid.elevation > 0
            ? Math.max(0, cosIncidence(sunMid.elevation, sunMid.azimuth, plane.tiltDeg, plane.azimuthDeg))
            : 0;
        const iamB = iamMartinRuiz(cosI);
        const iamD = iamDiffuse(plane.tiltDeg);

        let poa = 0;
        let poaEffective = 0;

        if (canUseApiGti && globalTilted > 0) {
            poa = globalTilted;
            // Estimate beam vs diffuse share on the plane so IAM is still applied accurately
            const diffuseShare = shortwave > 5 ? Math.min(1, Math.max(0, diffuse / shortwave)) : 1;
            const weightedIam = (1 - diffuseShare) * (cosI > 0.05 ? iamB : iamD) + diffuseShare * iamD;
            poaEffective = poa * weightedIam;
        } else if (sunMid.elevation > 0) {
            const dni = dniFeed > 0
                ? dniFeed
                : (direct > 0 ? direct / Math.max(0.08, Math.sin(RAD * sunMid.elevation)) : 0);
            const dniClean = Math.min(1100, Math.max(0, dni));
            const e0 = sunMid.extraterrestrialNormal || SOLAR_CONSTANT;

            const tiltRad = plane.tiltDeg * RAD;
            const sinEl = Math.max(0.08, Math.sin(RAD * sunMid.elevation));
            const rbCapped = Math.min(cosI / sinEl, 6.0);
            const ai = Math.max(0, Math.min(1, dniClean / e0));

            const beamTilted = dniClean * cosI;
            const diffCircum = diffuse * ai * rbCapped;
            const diffIso = diffuse * (1 - ai) * ((1 + Math.cos(tiltRad)) / 2);
            const ground = shortwave * ALBEDO * ((1 - Math.cos(tiltRad)) / 2);

            poa = Math.max(0, beamTilted + diffCircum + diffIso + ground);
            poaEffective = Math.max(0, (beamTilted + diffCircum) * iamB + (diffIso + ground) * iamD);
        } else {
            // Very low twilight residual diffuse
            poa = Math.max(0, diffuse * ((1 + Math.cos(RAD * plane.tiltDeg)) / 2));
            poaEffective = poa * iamD;
        }

        return { poa: poa, poaEffective: poaEffective };
    }

    /* ------------------------------------------------------------------ *
     * Hourly PV yield
     * ------------------------------------------------------------------ */

    function calculateHourlyYield(weatherHour, config) {
        const cfg = config || {};
        const planes = getArrayPlanes(cfg);
        const totalKwp = planes.reduce(function (s, p) { return s + p.capacityKwp; }, 0);
        const inverterKwAc = cfg.inverterKwAc || totalKwp;
        const shadeFactor = 1 - Math.max(0, Math.min(90, cfg.shadingLossPct || 0)) / 100;
        const degradation = Math.pow(0.995, Math.max(0, cfg.systemAgeYears || 0));
        const calibration = Math.max(0.70, Math.min(1.30, (cfg.calibrationPct === undefined ? 100 : cfg.calibrationPct) / 100));

        // Explicit DC balance-of-system factor (soiling 2.5%, mismatch 2%, DC wiring 2%, LID 1.5% -> ~0.92;
        // combined with ~96.5% weighted inverter efficiency, ~3% IAM and thermal losses -> ~0.83–0.85 real-world PR)
        const dcBosFactor = cfg.dcBosFactor || 0.92;
        // Modern mono-PERC / TOPCon temperature coefficient: -0.35%/°C
        const tempCoeff = (cfg.tempCoeffPct === undefined ? -0.35 : cfg.tempCoeffPct) / 100;

        const shortwave = weatherHour.shortwave_radiation || 0;
        const globalTilted = weatherHour.global_tilted_irradiance || 0;
        const temperature = (weatherHour.temperature_2m === undefined || weatherHour.temperature_2m === null)
            ? 12 : weatherHour.temperature_2m;

        // Wind speed in m/s (app.js requests wind_speed_unit=ms; convert fallback gracefully)
        const windMs = (weatherHour.wind_speed_ms !== undefined)
            ? weatherHour.wind_speed_ms
            : (weatherHour.wind_speed_10m !== undefined ? weatherHour.wind_speed_10m : 3.5);

        // Snow cover derating (heavy snow on panels blocks light until melted/shed)
        const snowDepthM = weatherHour.snow_depth || 0;
        const isSnowing = !!SNOW_CODES[weatherHour.weather_code];
        let snowFactor = 1.0;
        if (snowDepthM >= 0.05) snowFactor = 0.25;
        else if (snowDepthM >= 0.015) snowFactor = 0.55;
        else if (isSnowing && temperature <= 1.5) snowFactor = 0.70;

        const utcMillis = weatherHour.utcMillis !== undefined
            ? weatherHour.utcMillis
            : toUtcMillis(parseLocalStamp(weatherHour.time), cfg.utcOffsetSeconds || 0);

        // Preceding-hour midpoint (-30 min) matches Open-Meteo's radiation averaging interval
        const midMillis = utcMillis - 0.5 * HOUR_MS;
        const sunMid = getSunPosition(midMillis, cfg.latitude, cfg.longitude);
        const elevationM = cfg.elevation !== undefined ? cfg.elevation : DEFAULT_LOCATION.elevation;

        // Compute capacity-weighted clear-sky POA across all planes over [t-60m, t]
        let weightedClearPoa = 0;
        for (let i = 0; i < planes.length; i++) {
            const p = planes[i];
            const cs = clearSkyPoaPrecedingHour(utcMillis, cfg.latitude, cfg.longitude, p.tiltDeg, p.azimuthDeg, elevationM);
            weightedClearPoa += cs.poa * (p.capacityKwp / totalKwp);
        }

        if (shortwave <= 1 && globalTilted <= 1) {
            return {
                powerKw: 0, energyKwh: 0, dcPotentialKw: 0, clippedKw: 0,
                effectiveIrradianceWm2: 0,
                clearSkyIrradianceWm2: Math.round(weightedClearPoa),
                sunElevation: Math.round(sunMid.elevation * 10) / 10,
                cellTempC: Math.round(temperature * 10) / 10,
                tempLossPct: 0,
                snowDerated: snowFactor < 1,
                isDaylight: sunMid.elevation > 0 || weightedClearPoa > 5,
                clearnessIndex: 0
            };
        }

        // Faiman PV module temperature coefficients for ventilated roof-mounted c-Si (PVGIS default)
        const U0 = 25.0;
        const U1 = 6.84;

        let totalDcKw = 0;
        let weightedPoa = 0;
        let weightedCellTemp = 0;
        let weightedTempDerate = 0;

        for (let i = 0; i < planes.length; i++) {
            const p = planes[i];
            const weight = p.capacityKwp / totalKwp;
            // Open-Meteo's global_tilted_irradiance matches plane 0 ONLY if single-facing primary
            const canUseApiGti = (i === 0 && p.isPrimarySingle && !cfg.ignoreApiGti);
            const irr = planeIrradiance(weatherHour, p, sunMid, canUseApiGti);

            const cellTemp = temperature + irr.poa / (U0 + U1 * Math.max(0.5, windMs));
            const tempDerating = 1 + (cellTemp - 25) * tempCoeff;

            // Low-light module efficiency drop (IEC 61853 typical c-Si curve below 150 W/m²)
            const lowLightFactor = irr.poa < 150
                ? (0.89 + 0.11 * Math.sqrt(Math.max(0, irr.poa) / 150))
                : 1.0;

            const planeDcKw = (irr.poaEffective / 1000) * p.capacityKwp * dcBosFactor
                * tempDerating * lowLightFactor * shadeFactor * degradation * snowFactor * calibration;

            totalDcKw += Math.max(0, planeDcKw);
            weightedPoa += irr.poa * weight;
            weightedCellTemp += cellTemp * weight;
            weightedTempDerate += tempDerating * weight;
        }

        // Apply Sandia-style part-load inverter efficiency curve & AC clipping limit
        const invEff = inverterEfficiency(totalDcKw, inverterKwAc);
        const acBeforeClip = totalDcKw * invEff;
        const powerKw = Math.min(inverterKwAc, acBeforeClip);
        // DC-side power that exceeds the AC inverter cap (recoverable by a DC-coupled hybrid battery)
        const maxDcThroughInverter = invEff > 0 ? inverterKwAc / invEff : inverterKwAc;
        const clippedKw = Math.max(0, totalDcKw - maxDcThroughInverter);

        return {
            powerKw: Math.round(powerKw * 1000) / 1000,
            energyKwh: Math.round(powerKw * 1000) / 1000,
            dcPotentialKw: Math.round(acBeforeClip * 1000) / 1000,
            clippedKw: Math.round(clippedKw * 1000) / 1000,
            effectiveIrradianceWm2: Math.round(weightedPoa),
            clearSkyIrradianceWm2: Math.round(weightedClearPoa),
            sunElevation: Math.round(sunMid.elevation * 10) / 10,
            cellTempC: Math.round(weightedCellTemp * 10) / 10,
            tempLossPct: Math.round((1 - weightedTempDerate) * 1000) / 10,
            snowDerated: snowFactor < 1,
            clearnessIndex: weightedClearPoa > 20 ? Math.min(1.15, weightedPoa / weightedClearPoa) : 0,
            isDaylight: sunMid.elevation > 0 || weightedPoa > 2
        };
    }

    /* ------------------------------------------------------------------ *
     * PVGIS-calibrated Monthly & Annual Yield Model
     * Accounts for exact latitude, longitude, roof pitch, orientation
     * (including East–West & 2nd plane), shading, age, and clipping.
     * ------------------------------------------------------------------ */

    function estimateMonthlyYield(config) {
        const cfg = config || {};
        const lat = cfg.latitude === undefined ? DEFAULT_LOCATION.latitude : cfg.latitude;
        const lon = cfg.longitude === undefined ? DEFAULT_LOCATION.longitude : cfg.longitude;
        const elevationM = cfg.elevation === undefined ? DEFAULT_LOCATION.elevation : cfg.elevation;
        const planes = getArrayPlanes(cfg);
        const totalKwp = planes.reduce(function (s, p) { return s + p.capacityKwp; }, 0);
        const inverterKwAc = cfg.inverterKwAc || totalKwp;
        const shadeFactor = 1 - Math.max(0, Math.min(90, cfg.shadingLossPct || 0)) / 100;
        const degradation = Math.pow(0.995, Math.max(0, cfg.systemAgeYears || 0));
        const calibration = Math.max(0.70, Math.min(1.30, (cfg.calibrationPct === undefined ? 100 : cfg.calibrationPct) / 100));

        // Regional Irish insolation gradient: southeast (Wexford/Waterford) is ~10% sunnier
        // than northwest (Donegal/Mayo) relative to Limerick (52.45°N, -9.06°W).
        const regionalFactor = Math.max(0.86, Math.min(1.14,
            1.0 + (52.45 - lat) * 0.032 + (lon - (-9.06)) * 0.022
        ));

        const months = [];
        let annualKwh = 0;

        for (let m = 0; m < 12; m++) {
            const kc = Math.min(0.78, IE_MONTHLY_CLEARSKY_INDEX[m] * regionalFactor);
            const ambT = IE_MONTHLY_TEMP_C[m];
            const diffuseFraction = Math.max(0.28, Math.min(0.92, 1.08 - 0.95 * kc));
            const baseUtc = Date.UTC(2025, m, 15, 0, 0, 0);

            // Simulate a representative typical day + blend sunny/cloudy clipping realism
            let typicalDayKwh = 0;
            for (let h = 1; h <= 24; h++) {
                const utcMs = baseUtc + h * HOUR_MS;
                const midMs = utcMs - 0.5 * HOUR_MS;
                const sunMid = getSunPosition(midMs, lat, lon);
                if (sunMid.elevation <= 0.5) continue;

                const csH = clearSkyPoaPrecedingHour(utcMs, lat, lon, 0, 180, elevationM);
                // Monthly average GHI on horizontal surface
                const ghi = csH.ghi * kc;
                const dhi = ghi * diffuseFraction;
                const dirHoriz = Math.max(0, ghi - dhi);

                const syntheticHour = {
                    utcMillis: utcMs,
                    shortwave_radiation: ghi,
                    direct_radiation: dirHoriz,
                    diffuse_radiation: dhi,
                    direct_normal_irradiance: 0,
                    global_tilted_irradiance: 0,
                    temperature_2m: ambT + 3 * Math.sin(((h - 9) / 12) * Math.PI),
                    wind_speed_ms: 4.5,
                    snow_depth: 0,
                    weather_code: 2
                };

                // Average across a 3-state sky mix (clear 22%, mixed 50%, overcast 28%)
                // so inverter clipping on sunny days is captured realistically!
                const skyStates = [
                    { mult: 1.50, w: 0.22, diff: Math.max(0.18, diffuseFraction * 0.45) },
                    { mult: 1.00, w: 0.50, diff: diffuseFraction },
                    { mult: 0.45, w: 0.28, diff: 0.95 }
                ];
                const meanMult = skyStates.reduce(function (s, st) { return s + st.mult * st.w; }, 0);

                for (let s = 0; s < skyStates.length; s++) {
                    const st = skyStates[s];
                    const gState = Math.min(csH.ghi * 1.02, ghi * (st.mult / meanMult));
                    const dState = gState * st.diff;
                    syntheticHour.shortwave_radiation = gState;
                    syntheticHour.diffuse_radiation = dState;
                    syntheticHour.direct_radiation = Math.max(0, gState - dState);

                    const y = calculateHourlyYield(syntheticHour, {
                        systemCapacityKwp: cfg.systemCapacityKwp,
                        inverterKwAc: inverterKwAc,
                        panelTiltDeg: cfg.panelTiltDeg,
                        panelAzimuthDeg: cfg.panelAzimuthDeg,
                        orientationKey: cfg.orientationKey,
                        array2: cfg.array2,
                        shadingLossPct: cfg.shadingLossPct,
                        systemAgeYears: cfg.systemAgeYears,
                        calibrationPct: cfg.calibrationPct,
                        latitude: lat,
                        longitude: lon,
                        elevation: elevationM,
                        ignoreApiGti: true
                    });
                    typicalDayKwh += y.energyKwh * st.w;
                }
            }

            // Calibrate against PVGIS-SARAH3 Limerick South 35° benchmark (~915 kWh/kWp/yr unshaded)
            const monthKwh = typicalDayKwh * DAYS_IN_MONTH[m] * 0.98;
            annualKwh += monthKwh;
            months.push({
                monthIndex: m,
                label: MONTH_NAMES[m],
                days: DAYS_IN_MONTH[m],
                kwh: Math.round(monthKwh),
                dailyAvgKwh: Math.round((monthKwh / DAYS_IN_MONTH[m]) * 10) / 10
            });
        }

        return {
            annualKwh: Math.round(annualKwh),
            specificYield: totalKwp > 0 ? Math.round(annualKwh / totalKwp) : 0,
            months: months
        };
    }

    function annualTiltFactor(lat, lon, tiltDeg, azDeg) {
        let total = 0;
        const isEW = azDeg === 'EAST_WEST';
        const azList = isEW ? [90, 270] : [Number(azDeg) || 180];
        const w = 1 / azList.length;

        for (let m = 0; m < 12; m++) {
            const base = Date.UTC(2025, m, 15);
            const kc = IE_MONTHLY_CLEARSKY_INDEX[m];
            const diffuseFraction = Math.max(0.28, Math.min(0.92, 1.08 - 0.95 * kc));
            for (let h = 0; h < 24; h++) {
                const sun = getSunPosition(base + (h + 0.5) * HOUR_MS, lat, lon);
                if (sun.elevation <= 1.5) continue;
                const ghi = clearSkyPoaInstant(sun, 0, 180, 50).ghi * kc;
                const dhi = ghi * diffuseFraction;
                const dni = (ghi - dhi) / Math.max(0.08, Math.sin(RAD * sun.elevation));
                for (let a = 0; a < azList.length; a++) {
                    const cosI = Math.max(0, cosIncidence(sun.elevation, sun.azimuth, tiltDeg, azList[a]));
                    total += w * hayDaviesPoa(dni, dhi, ghi, sun.elevation, cosI, tiltDeg, sun.extraterrestrialNormal);
                }
            }
        }
        return total;
    }

    /** Best pitch and facing for a latitude, found by search. */
    function bestTiltFor(lat, lon) {
        let best = { tilt: 35, azimuth: 180, value: 0 };
        for (let tilt = 5; tilt <= 55; tilt += 5) {
            for (let az = 135; az <= 225; az += 15) {
                const v = annualTiltFactor(lat, lon, tilt, az);
                if (v > best.value) best = { tilt: tilt, azimuth: az, value: v };
            }
        }
        return best;
    }

    /* ------------------------------------------------------------------ *
     * Day rating (decoupled from shading & panel age!)
     * ------------------------------------------------------------------ */

    const RATING_TIERS = [
        {
            key: 'EXCELLENT', label: 'Wall-to-wall sunshine', short: 'Excellent', icon: '☀️', cls: 'badge-excellent',
            summary: 'Clear skies almost all day. Peak generation and a big export surplus — the best day of the week to run anything you can shift onto solar.'
        },
        {
            key: 'GOOD', label: 'Good solar day', short: 'Good', icon: '🌤️', cls: 'badge-good',
            summary: 'Mostly sunny with some cloud. Strong midday output and a healthy surplus over your house load.'
        },
        {
            key: 'MODERATE', label: 'Bright spells', short: 'Mixed', icon: '⛅', cls: 'badge-moderate',
            summary: 'Sun and cloud taking turns. Output swings hour to hour — worth watching the chart before starting a big load.'
        },
        {
            key: 'POOR', label: 'Poor solar day', short: 'Poor', icon: '☁️', cls: 'badge-poor',
            summary: 'Grey and overcast for most of the day. Diffuse light only, so expect a fraction of clear-sky output.'
        },
        {
            key: 'WASHOUT', label: 'Washout', short: 'Washout', icon: '🌧️', cls: 'badge-washout',
            summary: 'Heavy cloud and rain. Very little generation — lean on the battery and cheap-rate hours today.'
        }
    ];

    function tierByKey(key) {
        for (let i = 0; i < RATING_TIERS.length; i++) {
            if (RATING_TIERS[i].key === key) return RATING_TIERS[i];
        }
        return RATING_TIERS[RATING_TIERS.length - 1];
    }

    /**
     * Score a day against what a cloudless sky would have delivered on the same roof.
     *
     *   clearness  (55) : delivered POA irradiance / clear-sky POA irradiance
     *                     (purely atmospheric — unaffected by shading or panel age!)
     *   sunshine   (30) : share of daylight with direct beam sunshine
     *   cloud      (15) : irradiance-weighted cloud cover
     */
    function analyzeDailySolarForecast(dayHours, config) {
        const cfg = config || {};
        const totalKwp = totalArrayKwp(cfg);

        let totalKwh = 0;
        let clippedKwh = 0;
        let dcPotentialKwh = 0;
        let actualPoaSum = 0;
        let clearPoaSum = 0;
        let clearSkyKwh = 0;
        let maxPowerKw = 0;
        let peakHour = null;
        let cloudWeightedSum = 0;
        let cloudWeight = 0;
        let sunshineSeconds = 0;
        let daylightSeconds = 0;
        let hasSunshineData = false;
        let rainMm = 0;
        let maxSnowM = 0;
        let tMax = -99;
        let tMin = 99;
        let tSum = 0;
        let tCount = 0;

        const hourly = [];

        dayHours.forEach(function (hour) {
            const y = calculateHourlyYield(hour, cfg);
            const stamp = hour.stamp || parseLocalStamp(hour.time);
            const row = Object.assign({}, hour, y, { hour: stamp.hour });
            hourly.push(row);

            totalKwh += y.energyKwh;
            clippedKwh += y.clippedKw || 0;
            dcPotentialKwh += y.dcPotentialKw || 0;
            actualPoaSum += y.effectiveIrradianceWm2;
            clearPoaSum += y.clearSkyIrradianceWm2;

            // Clear-sky reference kWh with same shading/age for apples-to-apples comparison
            const shadeFactor = 1 - Math.max(0, Math.min(90, cfg.shadingLossPct || 0)) / 100;
            const degradation = Math.pow(0.995, Math.max(0, cfg.systemAgeYears || 0));
            const clearKw = (y.clearSkyIrradianceWm2 / 1000) * totalKwp * 0.87 * shadeFactor * degradation;
            clearSkyKwh += Math.min(cfg.inverterKwAc || totalKwp, clearKw);

            if (y.powerKw > maxPowerKw) {
                maxPowerKw = y.powerKw;
                peakHour = stamp.hour;
            }
            if (y.clearSkyIrradianceWm2 > 20) {
                const w = y.clearSkyIrradianceWm2;
                cloudWeightedSum += (hour.cloud_cover || 0) * w;
                cloudWeight += w;
                daylightSeconds += 3600;
                if (hour.sunshine_duration !== undefined && hour.sunshine_duration !== null) {
                    hasSunshineData = true;
                    sunshineSeconds += Math.min(3600, hour.sunshine_duration);
                }
            }
            rainMm += hour.precipitation || 0;
            maxSnowM = Math.max(maxSnowM, hour.snow_depth || 0);
            if (hour.temperature_2m !== undefined && hour.temperature_2m !== null) {
                tMax = Math.max(tMax, hour.temperature_2m);
                tMin = Math.min(tMin, hour.temperature_2m);
                tSum += hour.temperature_2m;
                tCount++;
            }
        });

        // Pure atmospheric clearness index (independent of shading/age/clipping!)
        const clearnessIndex = clearPoaSum > 50 ? Math.min(1.05, actualPoaSum / clearPoaSum) : 0;
        const weightedCloud = cloudWeight > 0 ? Math.round(cloudWeightedSum / cloudWeight) : 100;

        let sunshineFraction;
        if (hasSunshineData && daylightSeconds > 0) {
            sunshineFraction = Math.min(1, sunshineSeconds / daylightSeconds);
        } else {
            sunshineFraction = Math.max(0, Math.min(1, (clearnessIndex - 0.22) / 0.62));
        }

        let score = Math.round(
            55 * Math.max(0, Math.min(1, clearnessIndex)) +
            30 * sunshineFraction +
            15 * Math.max(0, (100 - weightedCloud) / 100)
        );
        score = Math.max(0, Math.min(100, score));

        // AND-gated bands so an overcast summer day can never sneak into Good
        let tierKey;
        if (score >= 80 && weightedCloud <= 25 && sunshineFraction >= 0.68 && clearnessIndex >= 0.78) {
            tierKey = 'EXCELLENT';
        } else if (score >= 60 && weightedCloud <= 55 && sunshineFraction >= 0.38) {
            tierKey = 'GOOD';
        } else if (score >= 38 && sunshineFraction >= 0.15) {
            tierKey = 'MODERATE';
        } else if (score >= 18) {
            tierKey = 'POOR';
        } else {
            tierKey = 'WASHOUT';
        }

        const tier = tierByKey(tierKey);
        const yieldPerKwp = totalKwp > 0 ? totalKwh / totalKwp : 0;

        // Best contiguous run of hours for shifting a flexible load onto solar
        const threshold = Math.max(0.4, maxPowerKw * 0.70);
        let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
        hourly.forEach(function (h) {
            if (h.powerKw >= threshold) {
                if (curLen === 0) curStart = h.hour;
                curLen++;
                if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
            } else {
                curLen = 0;
            }
        });
        const pad = function (n) { return String(n).padStart(2, '0'); };
        // Remember preceding-hour convention: hour slot H represents (H-1):00–H:00
        const optimalWindow = bestLen > 0
            ? pad((bestStart + 23) % 24) + ':00 – ' + pad(bestStart + bestLen - 1 < 24 ? (bestStart + bestLen - 1) : (bestStart + bestLen - 1) % 24) + ':00'
            : 'No strong solar window today';

        return {
            date: dayHours[0] ? String(dayHours[0].time).split('T')[0] : '',
            totalKwh: Math.round(totalKwh * 100) / 100,
            clippedKwh: Math.round(clippedKwh * 100) / 100,
            dcPotentialKwh: Math.round(dcPotentialKwh * 100) / 100,
            clearSkyKwh: Math.round(clearSkyKwh * 100) / 100,
            yieldPerKwp: Math.round(yieldPerKwp * 100) / 100,
            maxPowerKw: Math.round(maxPowerKw * 100) / 100,
            peakHourStr: peakHour === null ? '—' : pad((peakHour + 23) % 24) + ':00–' + pad(peakHour) + ':00',
            avgCloudCover: weightedCloud,
            sunshineHours: Math.round((sunshineSeconds / 3600) * 10) / 10,
            sunshineFraction: Math.round(sunshineFraction * 100) / 100,
            clearnessIndex: Math.round(clearnessIndex * 100) / 100,
            daylightHours: Math.round(daylightSeconds / 3600),
            rainMm: Math.round(rainMm * 10) / 10,
            snowDepthCm: Math.round(maxSnowM * 1000) / 10,
            tempMax: tMax > -99 ? Math.round(tMax * 10) / 10 : null,
            tempMin: tMin < 99 ? Math.round(tMin * 10) / 10 : null,
            tempAvg: tCount > 0 ? Math.round((tSum / tCount) * 10) / 10 : 12,
            score: score,
            rating: tier.key,
            ratingLabel: tier.label,
            ratingShort: tier.short,
            ratingIcon: tier.icon,
            ratingClass: tier.cls,
            summaryText: tier.summary,
            optimalWindow: optimalWindow,
            optimalWindowStart: bestStart,
            optimalWindowLength: bestLen,
            hourlyYields: hourly,
            // Populated by multi-model confidence pass in app.js
            confidence: null
        };
    }

    return {
        DEFAULT_LOCATION: DEFAULT_LOCATION,
        NEWCASTLE_WEST_COORDS: DEFAULT_LOCATION,
        ORIENTATIONS: ORIENTATIONS,
        WMO_WEATHER_CODES: WMO_WEATHER_CODES,
        RATING_TIERS: RATING_TIERS,
        parseLocalStamp: parseLocalStamp,
        toUtcMillis: toUtcMillis,
        getSunPosition: getSunPosition,
        clearSkyPoa: clearSkyPoa,
        clearSkyPoaPrecedingHour: clearSkyPoaPrecedingHour,
        getArrayPlanes: getArrayPlanes,
        totalArrayKwp: totalArrayKwp,
        estimateMonthlyYield: estimateMonthlyYield,
        annualTiltFactor: annualTiltFactor,
        bestTiltFor: bestTiltFor,
        calculateHourlyYield: calculateHourlyYield,
        analyzeDailySolarForecast: analyzeDailySolarForecast
    };
})();
