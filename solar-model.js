/**
 * Irish Solar Weather & Physics Model
 * Default location: Newcastle West, Co. Limerick (52.4497 N, -9.0612 W)
 *
 * The day rating is referenced against a CLEAR-SKY model for the same date and
 * location, so "Excellent" means wall-to-wall sunshine rather than "it was June".
 */

window.SolarModel = (function () {
    'use strict';

    const DEFAULT_LOCATION = {
        name: 'Newcastle West, Co. Limerick (V42 AD96)',
        latitude: 52.4497,
        longitude: -9.0612,
        elevation: 42,
        timezone: 'Europe/Dublin'
    };

    const ORIENTATIONS = {
        'SOUTH': 180,
        'SOUTH_SOUTH_WEST': 202,
        'SOUTH_WEST': 225,
        'WEST': 270,
        'SOUTH_SOUTH_EAST': 157,
        'SOUTH_EAST': 135,
        'EAST': 90,
        'EAST_WEST': 180 // split array behaves ~ south with a flatter curve; handled via tilt
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
        95: { description: 'Thunderstorm', icon: '⛈️' },
        96: { description: 'Thunderstorm, hail', icon: '⛈️' },
        99: { description: 'Thunderstorm, hail', icon: '⛈️' }
    };

    const RAD = Math.PI / 180;
    const ALBEDO = 0.2;

    /* ------------------------------------------------------------------ *
     * Time helpers
     * Open-Meteo returns local wall-clock strings ("2026-07-27T13:00") with
     * no zone suffix. Parsing those with `new Date()` uses the *browser's*
     * zone, which silently breaks the sun position for anyone outside
     * Ireland. So we parse the fields by hand and convert with the API's
     * own utc_offset_seconds.
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
     * Sun position (UTC in, degrees out)
     * ------------------------------------------------------------------ */

    function getSunPosition(utcMillis, lat, lon) {
        lat = (lat === undefined) ? DEFAULT_LOCATION.latitude : lat;
        lon = (lon === undefined) ? DEFAULT_LOCATION.longitude : lon;

        const d = new Date(utcMillis);
        const n = dayOfYearUtc(utcMillis);
        const declination = 23.45 * Math.sin(RAD * (360 / 365) * (n - 81));
        const b = (2 * Math.PI / 364) * (n - 81);
        const eqOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);

        const hours = d.getUTCHours() + d.getUTCMinutes() / 60;
        const solarTime = hours + (lon / 15) + (eqOfTime / 60);
        const hourAngle = (solarTime - 12) * 15;

        const sinEl = Math.sin(RAD * lat) * Math.sin(RAD * declination) +
            Math.cos(RAD * lat) * Math.cos(RAD * declination) * Math.cos(RAD * hourAngle);
        const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;

        let azimuth = 180;
        if (Math.abs(Math.cos(RAD * elevation)) > 1e-6) {
            const cosAz = (Math.sin(RAD * declination) * Math.cos(RAD * lat) -
                Math.cos(RAD * declination) * Math.sin(RAD * lat) * Math.cos(RAD * hourAngle)) /
                Math.cos(RAD * elevation);
            azimuth = Math.acos(Math.max(-1, Math.min(1, cosAz))) / RAD;
            if (hourAngle > 0) azimuth = 360 - azimuth;
        }
        return { elevation: elevation, azimuth: azimuth };
    }

    /** Cosine of the angle of incidence on a tilted plane. */
    function cosIncidence(sunEl, sunAz, tiltDeg, panelAz) {
        return Math.sin(RAD * sunEl) * Math.cos(RAD * tiltDeg) +
            Math.cos(RAD * sunEl) * Math.sin(RAD * tiltDeg) * Math.cos(RAD * (sunAz - panelAz));
    }

    /**
     * Simple Meinel/Hottel clear-sky model. Returns the plane-of-array
     * irradiance a perfectly cloudless sky would deliver at this instant.
     * This is the yardstick the day rating is measured against.
     */
    function clearSkyPoa(sunEl, sunAz, tiltDeg, panelAz) {
        if (sunEl <= 1.5) return { poa: 0, ghi: 0 };
        const airMass = 1 / (Math.sin(RAD * sunEl) + 0.50572 * Math.pow(sunEl + 6.07995, -1.6364));
        const dni = 1353 * Math.pow(0.7, Math.pow(airMass, 0.678));
        const dhi = 0.10 * dni * Math.sin(RAD * sunEl);
        const ghi = dni * Math.sin(RAD * sunEl) + dhi;
        const cosI = Math.max(0, cosIncidence(sunEl, sunAz, tiltDeg, panelAz));
        const poa = dni * cosI
            + dhi * ((1 + Math.cos(RAD * tiltDeg)) / 2)
            + ghi * ALBEDO * ((1 - Math.cos(RAD * tiltDeg)) / 2);
        return { poa: poa, ghi: ghi };
    }

    /* ------------------------------------------------------------------ *
     * Hourly PV yield
     * ------------------------------------------------------------------ */

    function calculateHourlyYield(weatherHour, config) {
        const cfg = config || {};
        const systemCapacityKwp = cfg.systemCapacityKwp || 5.0;
        const panelTiltDeg = (cfg.panelTiltDeg === undefined) ? 35 : cfg.panelTiltDeg;
        const panelAzimuthDeg = (cfg.panelAzimuthDeg === undefined) ? 180 : cfg.panelAzimuthDeg;
        const systemEfficiency = cfg.systemEfficiency || 0.85;
        const inverterKwAc = cfg.inverterKwAc || systemCapacityKwp;
        const shadeFactor = 1 - Math.max(0, Math.min(90, cfg.shadingLossPct || 0)) / 100;
        // Modules lose roughly half a percent of output a year.
        const degradation = Math.pow(0.995, Math.max(0, cfg.systemAgeYears || 0));

        const shortwave = weatherHour.shortwave_radiation || 0;
        const direct = weatherHour.direct_radiation || 0;
        const dniFeed = weatherHour.direct_normal_irradiance || 0;
        const diffuse = weatherHour.diffuse_radiation || 0;
        const globalTilted = weatherHour.global_tilted_irradiance || 0;
        const temperature = (weatherHour.temperature_2m === undefined || weatherHour.temperature_2m === null)
            ? 12 : weatherHour.temperature_2m;
        const cloudCover = weatherHour.cloud_cover || 0;
        const windSpeed = weatherHour.wind_speed_10m || 3;

        const utcMillis = weatherHour.utcMillis !== undefined
            ? weatherHour.utcMillis
            : toUtcMillis(parseLocalStamp(weatherHour.time), cfg.utcOffsetSeconds || 0);

        const sun = getSunPosition(utcMillis, cfg.latitude, cfg.longitude);
        const clear = clearSkyPoa(sun.elevation, sun.azimuth, panelTiltDeg, panelAzimuthDeg);

        if (shortwave <= 2 && globalTilted <= 2) {
            return {
                powerKw: 0, energyKwh: 0, dcPotentialKw: 0, clippedKw: 0,
                effectiveIrradianceWm2: 0,
                clearSkyIrradianceWm2: Math.round(clear.poa),
                sunElevation: sun.elevation, tempLossPct: 0,
                isDaylight: false, clearnessIndex: 0
            };
        }

        // Plane-of-array irradiance: use the API's tilted value when present,
        // otherwise transpose the direct/diffuse split ourselves.
        let poa = globalTilted > 0 ? globalTilted : 0;
        if (poa <= 0) {
            if (sun.elevation > 0) {
                const cosI = Math.max(0, cosIncidence(sun.elevation, sun.azimuth, panelTiltDeg, panelAzimuthDeg));
                // Beam irradiance on a tilted plane needs DNI, not the horizontal
                // component. Dividing by sin(elevation) recovers it; without this
                // step low winter sun is badly under-counted.
                const dni = dniFeed > 0
                    ? dniFeed
                    : direct / Math.max(0.05, Math.sin(RAD * sun.elevation));
                poa = Math.min(1100, dni) * cosI
                    + diffuse * ((1 + Math.cos(RAD * panelTiltDeg)) / 2)
                    + shortwave * ALBEDO * ((1 - Math.cos(RAD * panelTiltDeg)) / 2);
            } else {
                poa = diffuse * 0.5;
            }
        }

        // NOCT-style cell temperature with a wind correction.
        const cellTemp = temperature + (poa / 800) * (44 - 20) * (1 / (1 + 0.06 * Math.max(0, windSpeed - 1)));
        const tempDerating = 1 + (cellTemp - 25) * -0.0038;

        let dcKw = (poa / 1000) * systemCapacityKwp * systemEfficiency * tempDerating * shadeFactor * degradation;
        // Low-light losses: inverters and modules are less efficient at very low irradiance.
        if (poa < 120) dcKw *= 0.86 + 0.14 * (poa / 120);
        dcKw = Math.max(0, dcKw);

        // The inverter can only pass so much to AC. Everything above that is
        // "clipped" — lost entirely on an AC-coupled system, but a DC-coupled
        // hybrid can still push it into the battery, so it is reported separately.
        const powerKw = Math.min(inverterKwAc, dcKw);
        const clippedKw = Math.max(0, dcKw - powerKw);

        return {
            powerKw: Math.round(powerKw * 1000) / 1000,
            energyKwh: Math.round(powerKw * 1000) / 1000, // hourly steps: 1 kW for 1 h = 1 kWh
            dcPotentialKw: Math.round(dcKw * 1000) / 1000,
            clippedKw: Math.round(clippedKw * 1000) / 1000,
            effectiveIrradianceWm2: Math.round(poa),
            clearSkyIrradianceWm2: Math.round(clear.poa),
            sunElevation: Math.round(sun.elevation * 10) / 10,
            tempLossPct: Math.round((1 - tempDerating) * 1000) / 10,
            clearnessIndex: clear.poa > 20 ? Math.min(1.15, poa / clear.poa) : 0,
            isDaylight: sun.elevation > 0
        };
    }

    /**
     * Relative annual clear-sky energy on a plane, sampled at midday intervals
     * across twelve representative days. Used to compare a roof against the
     * best available pitch and facing for its latitude.
     */
    // Typical Irish monthly clearness. Without this weighting a pure clear-sky
    // integration recommends a steep winter-friendly pitch, which is wrong here:
    // Irish winters are too cloudy for that extra winter sun to ever arrive.
    const IE_MONTHLY_CLEARNESS = [0.31, 0.36, 0.40, 0.45, 0.47, 0.45, 0.43, 0.42, 0.39, 0.34, 0.30, 0.27];

    function annualTiltFactor(lat, lon, tiltDeg, azDeg) {
        let total = 0;
        for (let m = 0; m < 12; m++) {
            const base = Date.UTC(2025, m, 15);
            const kt = IE_MONTHLY_CLEARNESS[m];
            // Over half of Ireland's annual sunlight arrives as diffuse sky rather
            // than direct beam, and diffuse favours a flatter pitch. Ignoring that
            // recommends a needlessly steep roof.
            const diffuseFraction = Math.max(0.35, Math.min(0.95, 0.95 - 0.85 * kt));
            for (let h = 0; h < 24; h++) {
                const sun = getSunPosition(base + h * 3600000, lat, lon);
                if (sun.elevation <= 1.5) continue;
                const ghi = clearSkyPoa(sun.elevation, sun.azimuth, 0, 180).ghi * kt;
                const dhi = ghi * diffuseFraction;
                const dni = (ghi - dhi) / Math.max(0.05, Math.sin(RAD * sun.elevation));
                const cosI = Math.max(0, cosIncidence(sun.elevation, sun.azimuth, tiltDeg, azDeg));
                total += dni * cosI
                    + dhi * ((1 + Math.cos(RAD * tiltDeg)) / 2)
                    + ghi * ALBEDO * ((1 - Math.cos(RAD * tiltDeg)) / 2);
            }
        }
        return total;
    }

    /** Best pitch and facing for a latitude, found by search. */
    function bestTiltFor(lat, lon) {
        let best = { tilt: 35, azimuth: 180, value: 0 };
        for (let tilt = 0; tilt <= 60; tilt += 5) {
            for (let az = 120; az <= 240; az += 15) {
                const v = annualTiltFactor(lat, lon, tilt, az);
                if (v > best.value) best = { tilt: tilt, azimuth: az, value: v };
            }
        }
        return best;
    }

    /* ------------------------------------------------------------------ *
     * Day rating
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
     * Score a day against what a cloudless sky would have produced.
     *
     *   clearness  (55) : delivered energy / clear-sky energy
     *   sunshine   (30) : share of daylight with direct beam sunshine
     *   cloud      (15) : irradiance-weighted cloud cover
     *
     * All three must be high to reach Excellent, so a bright-but-grey Irish
     * summer day lands at "Poor", not "Good" — the old model gave a pass to
     * any day with 16 hours of daylight regardless of how thick the cloud was.
     */
    function analyzeDailySolarForecast(dayHours, config) {
        const cfg = config || {};
        const systemCapacityKwp = cfg.systemCapacityKwp || 5.0;

        let totalKwh = 0;
        let clippedKwh = 0;
        let dcPotentialKwh = 0;
        let clearSkyKwh = 0;
        let maxPowerKw = 0;
        let peakHour = null;
        let cloudWeightedSum = 0;
        let cloudWeight = 0;
        let sunshineSeconds = 0;
        let daylightSeconds = 0;
        let hasSunshineData = false;
        let rainMm = 0;
        let tMax = -99;
        let tMin = 99;

        const hourly = [];

        dayHours.forEach(function (hour) {
            const y = calculateHourlyYield(hour, cfg);
            const stamp = hour.stamp || parseLocalStamp(hour.time);
            const row = Object.assign({}, hour, y, { hour: stamp.hour });
            hourly.push(row);

            totalKwh += y.energyKwh;
            clippedKwh += y.clippedKw || 0;
            dcPotentialKwh += y.dcPotentialKw || 0;

            const clearKw = (y.clearSkyIrradianceWm2 / 1000) * systemCapacityKwp * (cfg.systemEfficiency || 0.85);
            clearSkyKwh += Math.min(cfg.inverterKwAc || systemCapacityKwp, clearKw);

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
                    sunshineSeconds += hour.sunshine_duration;
                }
            }
            rainMm += hour.precipitation || 0;
            if (hour.temperature_2m !== undefined && hour.temperature_2m !== null) {
                tMax = Math.max(tMax, hour.temperature_2m);
                tMin = Math.min(tMin, hour.temperature_2m);
            }
        });

        const clearnessIndex = clearSkyKwh > 0.2 ? Math.min(1.05, totalKwh / clearSkyKwh) : 0;
        const weightedCloud = cloudWeight > 0 ? Math.round(cloudWeightedSum / cloudWeight) : 100;

        let sunshineFraction;
        if (hasSunshineData && daylightSeconds > 0) {
            sunshineFraction = Math.min(1, sunshineSeconds / daylightSeconds);
        } else {
            // Fallback when the feed has no sunshine_duration: infer it from clearness.
            sunshineFraction = Math.max(0, Math.min(1, (clearnessIndex - 0.22) / 0.62));
        }

        let score = Math.round(
            55 * Math.max(0, Math.min(1, clearnessIndex)) +
            30 * sunshineFraction +
            15 * Math.max(0, (100 - weightedCloud) / 100)
        );
        score = Math.max(0, Math.min(100, score));

        // Bands are AND-gated. There is no "but it made a lot of kWh" escape
        // hatch, which is what used to promote overcast summer days to "Good".
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
        const yieldPerKwp = totalKwh / systemCapacityKwp;

        // Best contiguous run of hours for shifting a flexible load onto solar.
        const threshold = Math.max(0.4, maxPowerKw * 0.7);
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
        const optimalWindow = bestLen > 0
            ? pad(bestStart) + ':00 – ' + pad((bestStart + bestLen) % 24) + ':00'
            : 'No strong solar window today';

        return {
            date: dayHours[0] ? String(dayHours[0].time).split('T')[0] : '',
            totalKwh: Math.round(totalKwh * 100) / 100,
            clippedKwh: Math.round(clippedKwh * 100) / 100,
            dcPotentialKwh: Math.round(dcPotentialKwh * 100) / 100,
            clearSkyKwh: Math.round(clearSkyKwh * 100) / 100,
            yieldPerKwp: Math.round(yieldPerKwp * 100) / 100,
            maxPowerKw: Math.round(maxPowerKw * 100) / 100,
            peakHourStr: peakHour === null ? '—' : pad(peakHour) + ':00',
            avgCloudCover: weightedCloud,
            sunshineHours: Math.round((sunshineSeconds / 3600) * 10) / 10,
            sunshineFraction: Math.round(sunshineFraction * 100) / 100,
            clearnessIndex: Math.round(clearnessIndex * 100) / 100,
            daylightHours: Math.round(daylightSeconds / 3600),
            rainMm: Math.round(rainMm * 10) / 10,
            tempMax: tMax > -99 ? Math.round(tMax * 10) / 10 : null,
            tempMin: tMin < 99 ? Math.round(tMin * 10) / 10 : null,
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
            hourlyYields: hourly
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
        annualTiltFactor: annualTiltFactor,
        bestTiltFor: bestTiltFor,
        calculateHourlyYield: calculateHourlyYield,
        analyzeDailySolarForecast: analyzeDailySolarForecast
    };
})();
