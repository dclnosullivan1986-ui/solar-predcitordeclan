/**
 * Irish Home Energy & Tariff Model
 *
 * Simulates one day hour-by-hour: solar generation, household load, flexible
 * loads (EV, immersion, battery), time-of-use import rates and Clean Export
 * Guarantee income — then prices it against the same house with no solar.
 *
 * Defaults follow a typical Irish smart "EV / night" plan:
 *   Day    08:00–23:00   30.0 c/kWh
 *   Night  23:00–08:00   20.0 c/kWh
 *   EV     02:00–05:00   10.0 c/kWh
 *   Export (CEG)         18.5 c/kWh
 */

window.EnergyModel = (function () {
    'use strict';

    const DEFAULT_TARIFF = {
        name: 'EV / night plan',
        dayRate: 30.0,
        nightRate: 20.0,
        evRate: 10.0,
        peakRate: 30.0,          // set above dayRate for smart tariffs with a 17:00–19:00 peak
        exportRate: 18.5,
        standingChargeEuroPerDay: 0.85,
        dayStart: 8,
        dayEnd: 23,
        evStart: 2,
        evEnd: 5,
        peakStart: 17,
        peakEnd: 19,
        exportEnabled: true
    };

    const TARIFF_PRESETS = {
        EV_NIGHT: {
            name: 'EV / night plan (default)',
            dayRate: 30.0, nightRate: 20.0, evRate: 10.0, peakRate: 30.0,
            exportRate: 18.5, standingChargeEuroPerDay: 0.85,
            dayStart: 8, dayEnd: 23, evStart: 2, evEnd: 5, peakStart: 17, peakEnd: 19,
            exportEnabled: true
        },
        SMART_PEAK: {
            name: 'Smart tariff with 17:00–19:00 peak',
            dayRate: 29.0, nightRate: 19.0, evRate: 10.0, peakRate: 42.0,
            exportRate: 18.5, standingChargeEuroPerDay: 0.85,
            dayStart: 8, dayEnd: 23, evStart: 2, evEnd: 5, peakStart: 17, peakEnd: 19,
            exportEnabled: true
        },
        STANDARD_24H: {
            name: 'Standard 24-hour rate',
            dayRate: 28.0, nightRate: 28.0, evRate: 28.0, peakRate: 28.0,
            exportRate: 18.5, standingChargeEuroPerDay: 0.75,
            dayStart: 0, dayEnd: 24, evStart: 2, evEnd: 2, peakStart: 17, peakEnd: 17,
            exportEnabled: true
        },
        NO_EXPORT: {
            name: 'No smart meter — export not paid',
            dayRate: 30.0, nightRate: 20.0, evRate: 10.0, peakRate: 30.0,
            exportRate: 0, standingChargeEuroPerDay: 0.85,
            dayStart: 8, dayEnd: 23, evStart: 2, evEnd: 5, peakStart: 17, peakEnd: 19,
            exportEnabled: false
        }
    };

    /** Normalised 24-hour household load shapes (excluding EV / immersion / battery). */
    const RAW_PROFILES = {
        EVENING_PEAK: {
            label: 'Typical home — evening peak',
            shape: [20, 18, 17, 16, 16, 18, 26, 42, 48, 40, 36, 36, 40, 38, 36, 40, 55, 78, 88, 80, 68, 55, 40, 29]
        },
        DAYTIME: {
            label: 'Home all day / WFH or retired',
            shape: [18, 16, 15, 15, 15, 17, 26, 40, 52, 58, 60, 60, 62, 60, 58, 55, 58, 68, 72, 62, 52, 42, 30, 24]
        },
        HEAT_PUMP: {
            label: 'Heat pump home — morning + evening',
            shape: [34, 32, 30, 30, 32, 38, 58, 70, 62, 46, 40, 38, 40, 40, 40, 46, 62, 82, 90, 80, 66, 54, 44, 38]
        },
        FLAT: {
            label: 'Flat / even usage',
            shape: [42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42]
        }
    };

    const LOAD_PROFILES = (function () {
        const out = {};
        Object.keys(RAW_PROFILES).forEach(function (k) {
            const raw = RAW_PROFILES[k].shape;
            const sum = raw.reduce(function (a, b) { return a + b; }, 0);
            out[k] = { label: RAW_PROFILES[k].label, shape: raw.map(function (v) { return v / sum; }) };
        });
        return out;
    })();

    const DEFAULT_CONFIG = {
        dailyUsageKwh: 10.0,
        loadProfile: 'EVENING_PEAK',
        battery: {
            enabled: true,
            capacityKwh: 5.0,
            maxChargeKw: 3.0,
            maxDischargeKw: 3.0,
            roundTripEff: 0.90,
            minSocPct: 10,
            strategy: 'SMART'          // SMART | NIGHT_FIRST | SOLAR_ONLY
        },
        ev: {
            enabled: false,
            kwhPerSession: 20.0,
            sessionsPerWeek: 4,
            chargerKw: 7.4
        },
        immersion: {
            enabled: true,
            kwhPerDay: 2.4,
            elementKw: 3.0
        },
        flexSchedule: 'CHEAP_NIGHT',   // CHEAP_NIGHT | SOLAR | ANYTIME
        tariff: DEFAULT_TARIFF,
        gridCo2KgPerKwh: 0.28
    };

    const STRATEGY_LABELS = {
        SMART: 'Smart — forecast-led overnight charging',
        NIGHT_FIRST: 'Night-first — fill the battery every night',
        SOLAR_ONLY: 'Solar only — never charge from the grid'
    };

    /* ------------------------------------------------------------------ */

    function bandForHour(h, t) {
        if (t.evEnd > t.evStart && h >= t.evStart && h < t.evEnd) return 'ev';
        if (t.peakEnd > t.peakStart && h >= t.peakStart && h < t.peakEnd && t.peakRate > t.dayRate) return 'peak';
        const inDay = t.dayEnd > t.dayStart
            ? (h >= t.dayStart && h < t.dayEnd)
            : (h >= t.dayStart || h < t.dayEnd);
        return inDay ? 'day' : 'night';
    }

    function rateForBand(band, t) {
        if (band === 'ev') return t.evRate;
        if (band === 'peak') return t.peakRate;
        if (band === 'night') return t.nightRate;
        return t.dayRate;
    }

    function bandLabel(band) {
        return { ev: 'EV / cheap night', night: 'Night', day: 'Day', peak: 'Evening peak' }[band] || band;
    }

    /** Spread `kwh` across `window` hours, capped at `maxKw`, spilling into `spill` hours. */
    function scheduleLoad(kwh, windowHours, maxKw, spillHours) {
        const out = new Array(24).fill(0);
        let remaining = kwh;
        const place = function (hours) {
            for (let i = 0; i < hours.length && remaining > 0.0001; i++) {
                const h = hours[i];
                const room = maxKw - out[h];
                if (room <= 0) continue;
                const put = Math.min(room, remaining);
                out[h] += put;
                remaining -= put;
            }
        };
        place(windowHours);
        if (remaining > 0.0001 && spillHours && spillHours.length) place(spillHours);
        // Anything still left simply has to run somewhere — put it at the cheapest remaining hour.
        if (remaining > 0.0001) out[windowHours[0] !== undefined ? windowHours[0] : 3] += remaining;
        return out;
    }

    function hoursInWindow(start, end) {
        const out = [];
        if (end > start) {
            for (let h = start; h < end; h++) out.push(h);
        } else {
            for (let h = start; h < 24; h++) out.push(h);
            for (let h = 0; h < end; h++) out.push(h);
        }
        return out;
    }

    /** Build the 24-hour load arrays for a configuration. */
    function buildLoads(cfg, day) {
        const t = cfg.tariff;
        const profile = (LOAD_PROFILES[cfg.loadProfile] || LOAD_PROFILES.EVENING_PEAK).shape;
        const base = profile.map(function (f) { return f * cfg.dailyUsageKwh; });

        const evDaily = cfg.ev.enabled
            ? (cfg.ev.kwhPerSession * cfg.ev.sessionsPerWeek) / 7
            : 0;
        const immersionDaily = cfg.immersion.enabled ? cfg.immersion.kwhPerDay : 0;

        let evShape = new Array(24).fill(0);
        let immersionShape = new Array(24).fill(0);

        const cheapWindow = hoursInWindow(t.evStart, t.evEnd);
        const nightSpill = hoursInWindow(t.dayEnd, t.dayStart).filter(function (h) {
            return cheapWindow.indexOf(h) === -1;
        });

        if (cfg.flexSchedule === 'SOLAR' && day && day.optimalWindowLength > 0) {
            const solarHours = [];
            for (let i = 0; i < Math.max(3, day.optimalWindowLength); i++) {
                solarHours.push((day.optimalWindowStart + i) % 24);
            }
            if (evDaily > 0) evShape = scheduleLoad(evDaily, solarHours, cfg.ev.chargerKw, cheapWindow.concat(nightSpill));
            if (immersionDaily > 0) immersionShape = scheduleLoad(immersionDaily, solarHours, cfg.immersion.elementKw, cheapWindow);
        } else if (cfg.flexSchedule === 'ANYTIME') {
            const evening = [18, 19, 20, 21, 22];
            if (evDaily > 0) evShape = scheduleLoad(evDaily, evening, cfg.ev.chargerKw, nightSpill);
            if (immersionDaily > 0) immersionShape = scheduleLoad(immersionDaily, [17, 18, 19], cfg.immersion.elementKw, nightSpill);
        } else {
            if (evDaily > 0) evShape = scheduleLoad(evDaily, cheapWindow, cfg.ev.chargerKw, nightSpill);
            if (immersionDaily > 0) immersionShape = scheduleLoad(immersionDaily, cheapWindow, cfg.immersion.elementKw, nightSpill);
        }

        const total = base.map(function (v, i) { return v + evShape[i] + immersionShape[i]; });
        return {
            base: base, ev: evShape, immersion: immersionShape, total: total,
            evDaily: evDaily, immersionDaily: immersionDaily,
            totalDaily: total.reduce(function (a, b) { return a + b; }, 0)
        };
    }

    /** Extract a 24-slot generation array from a day analysis. */
    function generationByHour(day) {
        const gen = new Array(24).fill(0);
        if (!day || !day.hourlyYields) return gen;
        day.hourlyYields.forEach(function (h) {
            const idx = (h.hour === undefined) ? new Date(h.time).getHours() : h.hour;
            gen[idx] += h.energyKwh || h.powerKw || 0;
        });
        return gen;
    }

    /* ------------------------------------------------------------------ *
     * Core hourly dispatch
     * ------------------------------------------------------------------ */

    function runDispatch(gen, load, cfg, opts) {
        const t = cfg.tariff;
        const useBattery = opts.useBattery && cfg.battery.enabled && cfg.battery.capacityKwh > 0;
        const usable = useBattery ? cfg.battery.capacityKwh * (1 - cfg.battery.minSocPct / 100) : 0;
        const chgEff = Math.sqrt(cfg.battery.roundTripEff);
        const dchEff = Math.sqrt(cfg.battery.roundTripEff);
        const strategy = cfg.battery.strategy;

        // The battery holds a mix of cheap grid energy and solar. Tracking the
        // two separately is what makes the self-sufficiency figure honest —
        // energy bought at 10c and discharged later is not self-supply.
        let socSolar = Math.max(0, opts.startSocSolar || 0);
        let socGrid = Math.max(0, opts.startSocGrid || 0);
        if (socSolar + socGrid > usable) {
            const k = usable / (socSolar + socGrid);
            socSolar *= k; socGrid *= k;
        }
        let soc = socSolar + socGrid;

        const rows = [];
        let totals = {
            generation: 0, directUse: 0, solarToBattery: 0, exported: 0,
            gridImport: 0, gridToBattery: 0, batteryToLoad: 0, batterySolarToLoad: 0, load: 0,
            importCost: 0, exportIncome: 0,
            byBand: { day: { kwh: 0, cost: 0 }, night: { kwh: 0, cost: 0 }, ev: { kwh: 0, cost: 0 }, peak: { kwh: 0, cost: 0 } }
        };

        for (let h = 0; h < 24; h++) {
            const band = bandForHour(h, t);
            const rate = rateForBand(band, t);
            let g = gen[h];
            let l = load[h];
            const row = {
                hour: h, band: band, rate: rate, generation: gen[h], load: load[h],
                directUse: 0, solarToBattery: 0, exported: 0,
                gridImport: 0, gridToBattery: 0, batteryToLoad: 0, soc: 0, cost: 0
            };

            // 1. Solar serves the house first — always the most valuable kWh.
            const direct = Math.min(g, l);
            g -= direct; l -= direct;
            row.directUse = direct;

            // 2. Charge the battery from the grid inside the cheap window.
            if (useBattery && opts.gridChargePlan[h] > 0) {
                const room = usable - soc;
                const take = Math.min(opts.gridChargePlan[h], cfg.battery.maxChargeKw, room / chgEff);
                if (take > 0) {
                    socGrid += take * chgEff;
                    soc = socSolar + socGrid;
                    row.gridToBattery = take;
                    row.gridImport += take;
                }
            }

            // 3. Surplus solar tops up the battery.
            if (useBattery && g > 0) {
                const room = usable - soc;
                const headroomKw = Math.max(0, cfg.battery.maxChargeKw - row.gridToBattery);
                const take = Math.min(g, headroomKw, room / chgEff);
                if (take > 0) {
                    socSolar += take * chgEff;
                    soc = socSolar + socGrid;
                    g -= take;
                    row.solarToBattery = take;
                }
            }

            // 4. Whatever solar is left goes to the grid.
            if (g > 0) {
                row.exported = g;
                g = 0;
            }

            // 5. Battery covers the rest of the load — but never during the cheap
            //    window, where importing is cheaper than spending stored energy.
            if (useBattery && l > 0 && band !== 'ev' && soc > 0) {
                const give = Math.min(l, cfg.battery.maxDischargeKw, soc * dchEff);
                if (give > 0) {
                    const drawn = give / dchEff;
                    const solarShare = soc > 0 ? socSolar / soc : 0;
                    socSolar = Math.max(0, socSolar - drawn * solarShare);
                    socGrid = Math.max(0, socGrid - drawn * (1 - solarShare));
                    soc = socSolar + socGrid;
                    l -= give;
                    row.batteryToLoad = give;
                    row.batterySolarToLoad = give * solarShare;
                }
            }

            // 6. Anything still unserved is imported.
            if (l > 0) {
                row.gridImport += l;
                l = 0;
            }

            row.soc = soc;
            row.cost = (row.gridImport * rate / 100) - (row.exported * (t.exportEnabled ? t.exportRate : 0) / 100);

            totals.generation += row.generation;
            totals.load += row.load;
            totals.directUse += row.directUse;
            totals.solarToBattery += row.solarToBattery;
            totals.exported += row.exported;
            totals.gridImport += row.gridImport;
            totals.gridToBattery += row.gridToBattery;
            totals.batteryToLoad += row.batteryToLoad;
            totals.batterySolarToLoad += (row.batterySolarToLoad || 0);
            totals.importCost += row.gridImport * rate / 100;
            totals.exportIncome += row.exported * (t.exportEnabled ? t.exportRate : 0) / 100;
            totals.byBand[band].kwh += row.gridImport;
            totals.byBand[band].cost += row.gridImport * rate / 100;

            rows.push(row);
        }

        totals.endSoc = soc;
        totals.endSocSolar = socSolar;
        totals.endSocGrid = socGrid;
        totals.solarServedLoad = totals.directUse + totals.batterySolarToLoad;
        totals.standingCharge = t.standingChargeEuroPerDay;
        totals.netCost = totals.importCost + t.standingChargeEuroPerDay - totals.exportIncome;
        totals.selfConsumedKwh = totals.directUse + totals.solarToBattery;
        totals.rows = rows;
        return totals;
    }

    /** Spread a target overnight purchase across the cheap-rate hours. */
    function planForTarget(target, cfg) {
        const plan = new Array(24).fill(0);
        const window = hoursInWindow(cfg.tariff.evStart, cfg.tariff.evEnd);
        if (!window.length) return plan;
        let remaining = target;
        for (let i = 0; i < window.length && remaining > 0.001; i++) {
            const put = Math.min(cfg.battery.maxChargeKw, remaining);
            plan[window[i]] = put;
            remaining -= put;
        }
        return plan;
    }

    /**
     * Decide how much to buy into the battery during the cheap window.
     *
     * SMART searches the whole range and keeps the cheapest, which is why it
     * can never lose to the other two. What it lands on depends on the day:
     * a washout wants a full battery bought at the night rate, while a clear
     * day may want the battery left empty so the panels can fill it and the
     * surplus can be exported.
     */
    function buildGridChargePlan(gen, load, cfg) {
        const plan = new Array(24).fill(0);
        if (!cfg.battery.enabled || cfg.battery.capacityKwh <= 0) return plan;
        if (cfg.battery.strategy === 'SOLAR_ONLY') return plan;

        const usable = cfg.battery.capacityKwh * (1 - cfg.battery.minSocPct / 100);
        if (cfg.battery.strategy === 'NIGHT_FIRST') return planForTarget(usable, cfg);

        let best = null;
        const steps = 10;
        for (let i = 0; i <= steps; i++) {
            const target = usable * (i / steps);
            const candidate = planForTarget(target, cfg);
            let sim = runDispatch(gen, load, cfg, { useBattery: true, gridChargePlan: candidate, startSocSolar: 0, startSocGrid: 0 });
            sim = runDispatch(gen, load, cfg, {
                useBattery: true, gridChargePlan: candidate,
                startSocSolar: sim.endSocSolar, startSocGrid: sim.endSocGrid
            });
            if (!best || sim.netCost < best.cost - 1e-9) best = { cost: sim.netCost, plan: candidate };
        }
        return best ? best.plan : plan;
    }

    /* ------------------------------------------------------------------ *
     * Day simulation
     * ------------------------------------------------------------------ */

    function simulateDay(day, config) {
        const cfg = mergeConfig(config);
        const gen = generationByHour(day);
        const loads = buildLoads(cfg, day);
        const load = loads.total;
        const zeroGen = new Array(24).fill(0);
        const emptyPlan = new Array(24).fill(0);

        const plan = buildGridChargePlan(gen, load, cfg);

        // Two passes: carry yesterday's closing charge into today so the
        // opening state of charge is self-consistent rather than assumed empty.
        let result = runDispatch(gen, load, cfg, { useBattery: true, gridChargePlan: plan, startSocSolar: 0, startSocGrid: 0 });
        result = runDispatch(gen, load, cfg, {
            useBattery: true, gridChargePlan: plan,
            startSocSolar: result.endSocSolar, startSocGrid: result.endSocGrid
        });

        // Counterfactuals: the same house with no PV, and with PV but no storage.
        const noSolar = runDispatch(zeroGen, load, cfg, { useBattery: false, gridChargePlan: emptyPlan });
        const solarNoBattery = runDispatch(gen, load, cfg, { useBattery: false, gridChargePlan: emptyPlan });

        const savingVsNoSolar = noSolar.netCost - result.netCost;
        const batteryContribution = solarNoBattery.netCost - result.netCost;
        const solarContribution = noSolar.netCost - solarNoBattery.netCost;

        const selfSufficiency = loads.totalDaily > 0 ? result.solarServedLoad / loads.totalDaily : 0;
        const selfConsumptionRate = result.generation > 0
            ? (result.directUse + result.solarToBattery) / result.generation
            : 0;

        return {
            date: day.date,
            rating: day.rating,
            loads: loads,
            gen: gen,
            plan: plan,
            result: result,
            noSolar: noSolar,
            solarNoBattery: solarNoBattery,
            savingVsNoSolar: round2(savingVsNoSolar),
            batteryContribution: round2(batteryContribution),
            solarContribution: round2(solarContribution),
            netCost: round2(result.netCost),
            baselineCost: round2(noSolar.netCost),
            importCost: round2(result.importCost),
            exportIncome: round2(result.exportIncome),
            exportedKwh: round2(result.exported),
            importedKwh: round2(result.gridImport),
            generationKwh: round2(result.generation),
            selfConsumedKwh: round2(result.directUse + result.solarToBattery),
            solarServedLoadKwh: round2(result.solarServedLoad),
            batteryThroughputKwh: round2(result.batteryToLoad),
            gridToBatteryKwh: round2(result.gridToBattery),
            selfSufficiencyPct: Math.max(0, Math.min(100, Math.round(selfSufficiency * 100))),
            selfConsumptionPct: Math.round(selfConsumptionRate * 100),
            co2AvoidedKg: round2((result.directUse + result.batteryToLoad + result.exported) * cfg.gridCo2KgPerKwh),
            byBand: result.byBand
        };
    }

    /** Run every battery strategy so the cheapest one can be recommended. */
    function compareStrategies(day, config) {
        const out = [];
        ['SMART', 'NIGHT_FIRST', 'SOLAR_ONLY'].forEach(function (s) {
            const cfg = mergeConfig(config);
            cfg.battery.strategy = s;
            const sim = simulateDay(day, cfg);
            out.push({
                strategy: s,
                label: STRATEGY_LABELS[s],
                netCost: sim.netCost,
                saving: sim.savingVsNoSolar,
                exportIncome: sim.exportIncome,
                importCost: sim.importCost
            });
        });
        out.sort(function (a, b) { return a.netCost - b.netCost; });
        return out;
    }

    /* ------------------------------------------------------------------ *
     * Irish context notes
     * ------------------------------------------------------------------ */

    function buildInsights(sims, config, systemCapacityKwp) {
        const cfg = mergeConfig(config);
        const t = cfg.tariff;
        const notes = [];
        if (!sims.length) return notes;

        const n = sims.length;
        const weekExport = sims.reduce(function (a, s) { return a + s.exportIncome; }, 0);
        const weekGen = sims.reduce(function (a, s) { return a + s.generationKwh; }, 0);
        const weekSolar = sims.reduce(function (a, s) { return a + s.solarContribution; }, 0);
        const weekBattery = sims.reduce(function (a, s) { return a + s.batteryContribution; }, 0);

        // Two different things are being extrapolated, so they scale differently.
        // Solar savings track annual yield; battery price arbitrage happens every
        // night whatever the weather. Extrapolating a July forecast week as a whole
        // would badly overstate the year.
        const annualGenKwh = systemCapacityKwp * 850;
        const annualSolarSaving = weekGen > 0 ? (weekSolar / weekGen) * annualGenKwh : 0;
        const annualBatterySaving = (weekBattery / n) * 365;
        const annualSaving = annualSolarSaving + annualBatterySaving;
        const annualExportIncome = weekGen > 0 ? (weekExport / weekGen) * annualGenKwh : 0;

        if (t.exportEnabled && t.evRate < t.exportRate) {
            notes.push({
                icon: '🧮',
                title: 'Your cheap-rate hours beat your own solar',
                body: 'Grid at ' + t.evRate.toFixed(1) + 'c between ' + pad(t.evStart) + ':00 and ' + pad(t.evEnd) +
                    ':00 costs less than the ' + t.exportRate.toFixed(1) + 'c you get paid to export. So the battery, EV and immersion are ' +
                    'cheaper to run overnight, and daytime surplus is worth more sold than stored. The forecast tells you how much surplus to expect.'
            });
        }

        if (!t.exportEnabled) {
            notes.push({
                icon: '🔌',
                title: 'No export payment — self-consumption is everything',
                body: 'With nothing paid for export, every surplus kWh is wasted unless you use it. Shift the immersion and EV into the sunny hours ' +
                    'instead of 02:00–05:00, and get a smart meter and NC6 registration in place so the Clean Export Guarantee can start paying you.'
            });
        }

        if (annualExportIncome > 400) {
            notes.push({
                icon: '🇮🇪',
                title: 'You may pass the €400 export exemption',
                body: 'Estimated export income of about €' + Math.round(annualExportIncome) + ' a year is above the €400 that is exempt from income tax, ' +
                    'USC and PRSI (the relief runs to the end of 2028). Anything over €400 goes on your annual return — worth a word with Revenue or an accountant.'
            });
        } else if (t.exportEnabled) {
            notes.push({
                icon: '🇮🇪',
                title: 'Export income looks tax-free',
                body: 'At roughly €' + Math.round(annualExportIncome) + ' a year you sit under the €400 microgeneration exemption from income tax, USC and PRSI, ' +
                    'which runs to the end of 2028. You need a smart meter and an NC6 registered with ESB Networks to be paid at all.'
            });
        }

        if (!cfg.battery.enabled || cfg.battery.capacityKwh <= 0) {
            notes.push({
                icon: '🔋',
                title: 'No battery in the model',
                body: 'Turn the battery on above to see what storage is worth on your tariff. With a ' + t.evRate.toFixed(1) + 'c night rate and a ' +
                    t.dayRate.toFixed(1) + 'c day rate, a battery earns its keep on the price gap alone, before any solar is involved.'
            });
        }

        const excellent = sims.filter(function (s) { return s.rating === 'EXCELLENT'; });
        const washouts = sims.filter(function (s) { return s.rating === 'WASHOUT' || s.rating === 'POOR'; });
        if (excellent.length) {
            notes.push({
                icon: '☀️',
                title: excellent.length + ' clear day' + (excellent.length > 1 ? 's' : '') + ' in the next week',
                body: 'Leave the battery with room on those mornings, and put the dishwasher, washing machine and any car charging into the middle of the day. ' +
                    'On a clear day the panels cover the house outright and everything after that is surplus.'
            });
        }
        if (washouts.length >= 3) {
            notes.push({
                icon: '☁️',
                title: washouts.length + ' poor solar days ahead',
                body: 'Overcast days still make some power from diffuse light, but nothing close to a full battery. Fill the battery on the ' +
                    t.evRate.toFixed(1) + 'c rate overnight and treat the panels as a bonus rather than the plan.'
            });
        }

        notes.push({
            icon: '📈',
            title: 'About €' + Math.round(annualSaving) + ' a year at these rates',
            body: 'Roughly €' + Math.round(annualSolarSaving) + ' from the panels and €' + Math.round(annualBatterySaving) +
                ' from moving load onto cheap rates. Based on ' + Math.round(annualGenKwh) + ' kWh a year from a ' + systemCapacityKwp +
                ' kWp system — 850 kWh per kWp is a realistic Irish figure, well below what a good week in July suggests. ' +
                'The €1,800 SEAI grant and 0% VAT on domestic solar come off the install cost when you work out payback.'
        });

        notes.push({
            icon: '💧',
            title: 'The immersion is the cheapest battery you own',
            body: 'A hot water cylinder stores a few kWh with no install cost and no degradation. On this plan the sums say heat it in the ' +
                pad(t.evStart) + ':00–' + pad(t.evEnd) + ':00 window; with no export payment, heat it at midday off the panels instead. ' +
                'A solar diverter does this automatically.'
        });

        return notes.slice(0, 6);
    }

    /* ------------------------------------------------------------------ */

    function pad(n) { return String(n).padStart(2, '0'); }
    function round2(n) { return Math.round(n * 100) / 100; }

    function mergeConfig(config) {
        const c = config || {};
        return {
            dailyUsageKwh: c.dailyUsageKwh === undefined ? DEFAULT_CONFIG.dailyUsageKwh : c.dailyUsageKwh,
            loadProfile: c.loadProfile || DEFAULT_CONFIG.loadProfile,
            battery: Object.assign({}, DEFAULT_CONFIG.battery, c.battery || {}),
            ev: Object.assign({}, DEFAULT_CONFIG.ev, c.ev || {}),
            immersion: Object.assign({}, DEFAULT_CONFIG.immersion, c.immersion || {}),
            flexSchedule: c.flexSchedule || DEFAULT_CONFIG.flexSchedule,
            tariff: Object.assign({}, DEFAULT_TARIFF, c.tariff || {}),
            gridCo2KgPerKwh: c.gridCo2KgPerKwh === undefined ? DEFAULT_CONFIG.gridCo2KgPerKwh : c.gridCo2KgPerKwh
        };
    }

    return {
        DEFAULT_TARIFF: DEFAULT_TARIFF,
        DEFAULT_CONFIG: DEFAULT_CONFIG,
        TARIFF_PRESETS: TARIFF_PRESETS,
        LOAD_PROFILES: LOAD_PROFILES,
        STRATEGY_LABELS: STRATEGY_LABELS,
        bandForHour: bandForHour,
        rateForBand: rateForBand,
        bandLabel: bandLabel,
        buildLoads: buildLoads,
        generationByHour: generationByHour,
        simulateDay: simulateDay,
        compareStrategies: compareStrategies,
        buildInsights: buildInsights,
        mergeConfig: mergeConfig
    };
})();
