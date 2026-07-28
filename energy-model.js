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
            strategy: 'SMART',         // SMART | NIGHT_FIRST | SOLAR_ONLY
            coupling: 'DC'             // DC hybrid can absorb clipped energy; AC cannot
        },
        grid: {
            phase: 'SINGLE',           // SINGLE | THREE
            exportLimitKw: 6.0         // ESB Networks NC6 ceiling: ~6 kVA single, ~11 kVA three
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

    /** Extract the per-hour DC energy the inverter had to clip. */
    function clippedByHour(day) {
        const out = new Array(24).fill(0);
        if (!day || !day.hourlyYields) return out;
        day.hourlyYields.forEach(function (h) {
            const idx = (h.hour === undefined) ? new Date(h.time).getHours() : h.hour;
            out[idx] += h.clippedKw || 0;
        });
        return out;
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
        const dcSpare = opts.dcSpare || new Array(24).fill(0);
        const exportLimit = (cfg.grid && cfg.grid.exportLimitKw > 0) ? cfg.grid.exportLimitKw : Infinity;
        const dcCoupled = cfg.battery.coupling !== 'AC';
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
            clippedRecovered: 0, clippedLost: 0, curtailed: 0,
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
                gridImport: 0, gridToBattery: 0, batteryToLoad: 0, soc: 0, cost: 0,
                clippedRecovered: 0, clippedLost: 0, curtailed: 0
            };
            let spare = dcSpare[h] || 0;

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

            // 3. Surplus solar tops up the battery. A DC-coupled hybrid gets first
            //    call on the energy the inverter had to clip, because that never has
            //    to cross the AC limit — this is why a battery recovers clipping
            //    losses on an oversized array and an AC-coupled one does not.
            if (useBattery) {
                let headroomKw = Math.max(0, cfg.battery.maxChargeKw - row.gridToBattery);

                if (dcCoupled && spare > 0 && headroomKw > 0) {
                    const room = usable - soc;
                    const take = Math.min(spare, headroomKw, room / chgEff);
                    if (take > 0) {
                        socSolar += take * chgEff;
                        soc = socSolar + socGrid;
                        spare -= take;
                        headroomKw -= take;
                        row.clippedRecovered = take;
                        row.solarToBattery += take;
                    }
                }

                if (g > 0 && headroomKw > 0) {
                    const room = usable - soc;
                    const take = Math.min(g, headroomKw, room / chgEff);
                    if (take > 0) {
                        socSolar += take * chgEff;
                        soc = socSolar + socGrid;
                        g -= take;
                        row.solarToBattery += take;
                    }
                }
            }
            row.clippedLost = spare;

            // 4. Whatever solar is left goes to the grid, up to the connection's
            //    export limit. Beyond that the inverter has to throttle back and
            //    the energy is simply never made.
            if (g > 0) {
                row.exported = Math.min(g, exportLimit);
                row.curtailed = g - row.exported;
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
            totals.clippedRecovered += row.clippedRecovered;
            totals.clippedLost += row.clippedLost;
            totals.curtailed += row.curtailed;
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
    function buildGridChargePlan(gen, load, cfg, dcSpare) {
        const plan = new Array(24).fill(0);
        if (!cfg.battery.enabled || cfg.battery.capacityKwh <= 0) return plan;
        if (cfg.battery.strategy === 'SOLAR_ONLY') return plan;

        const usable = cfg.battery.capacityKwh * (1 - cfg.battery.minSocPct / 100);
        if (cfg.battery.strategy === 'NIGHT_FIRST') return planForTarget(usable, cfg);
        dcSpare = dcSpare || new Array(24).fill(0);

        let best = null;
        const steps = 10;
        for (let i = 0; i <= steps; i++) {
            const target = usable * (i / steps);
            const candidate = planForTarget(target, cfg);
            let sim = runDispatch(gen, load, cfg, { useBattery: true, gridChargePlan: candidate, dcSpare: dcSpare, startSocSolar: 0, startSocGrid: 0 });
            sim = runDispatch(gen, load, cfg, {
                useBattery: true, gridChargePlan: candidate, dcSpare: dcSpare,
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
        const dcSpare = clippedByHour(day);
        const loads = buildLoads(cfg, day);
        const load = loads.total;
        const zeroGen = new Array(24).fill(0);
        const emptyPlan = new Array(24).fill(0);

        const plan = buildGridChargePlan(gen, load, cfg, dcSpare);

        // Two passes: carry yesterday's closing charge into today so the
        // opening state of charge is self-consistent rather than assumed empty.
        let result = runDispatch(gen, load, cfg, { useBattery: true, gridChargePlan: plan, dcSpare: dcSpare, startSocSolar: 0, startSocGrid: 0 });
        result = runDispatch(gen, load, cfg, {
            useBattery: true, gridChargePlan: plan, dcSpare: dcSpare,
            startSocSolar: result.endSocSolar, startSocGrid: result.endSocGrid
        });

        // Counterfactuals: the same house with no PV, and with PV but no storage.
        const noSolar = runDispatch(zeroGen, load, cfg, { useBattery: false, gridChargePlan: emptyPlan });
        const solarNoBattery = runDispatch(gen, load, cfg, { useBattery: false, gridChargePlan: emptyPlan, dcSpare: dcSpare });

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
            clippedRecoveredKwh: round2(result.clippedRecovered),
            clippedLostKwh: round2(result.clippedLost),
            curtailedKwh: round2(result.curtailed),
            lostKwh: round2(result.clippedLost + result.curtailed),
            lostValue: round2(result.clippedLost * (cfg.tariff.exportEnabled ? cfg.tariff.exportRate : 0) / 100 +
                result.curtailed * (cfg.tariff.exportEnabled ? cfg.tariff.exportRate : 0) / 100),
            noBatteryLostKwh: round2(solarNoBattery.clippedLost + solarNoBattery.curtailed),
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
     * System setup assessment
     * ------------------------------------------------------------------ */

    const NC6_LIMIT = { SINGLE: 6.0, THREE: 11.0 };

    /**
     * Grade the physical setup: array against inverter, inverter against the
     * ESB Networks connection limit, battery against the surplus it has to
     * catch, and roof against the best pitch and facing for the latitude.
     */
    function assessSystem(days, sims, solarCfg, config) {
        const cfg = mergeConfig(config);
        const out = [];
        if (!days.length) return out;

        const kwp = solarCfg.systemCapacityKwp;
        const inv = solarCfg.inverterKwAc;
        const ratio = kwp / inv;
        const phase = cfg.grid.phase;
        const nc6Limit = NC6_LIMIT[phase] || 6.0;
        const exportLimit = cfg.grid.exportLimitKw;
        const batt = cfg.battery;

        const n = days.length;
        const genKwh = days.reduce(function (a, d) { return a + d.totalKwh; }, 0);
        const dcKwh = days.reduce(function (a, d) { return a + (d.dcPotentialKwh || d.totalKwh); }, 0);
        const clipKwh = days.reduce(function (a, d) { return a + (d.clippedKwh || 0); }, 0);
        const recovered = sims.reduce(function (a, s) { return a + (s.clippedRecoveredKwh || 0); }, 0);
        const lost = sims.reduce(function (a, s) { return a + (s.lostKwh || 0); }, 0);
        const curtailed = sims.reduce(function (a, s) { return a + (s.curtailedKwh || 0); }, 0);
        const noBatteryLost = sims.reduce(function (a, s) { return a + (s.noBatteryLostKwh || 0); }, 0);
        const clipPct = dcKwh > 0 ? (clipKwh / dcKwh) * 100 : 0;
        const lostPct = dcKwh > 0 ? (lost / dcKwh) * 100 : 0;
        const rate = cfg.tariff.exportEnabled ? cfg.tariff.exportRate : cfg.tariff.dayRate;

        const peakSurplus = sims.reduce(function (m, s) {
            return s.result.rows.reduce(function (mm, r) {
                return Math.max(mm, r.generation - r.load);
            }, m);
        }, 0);
        const avgSurplus = sims.reduce(function (a, s) {
            return a + s.result.rows.reduce(function (x, r) { return x + Math.max(0, r.generation - r.load); }, 0);
        }, 0) / n;

        /* 1 ── array against inverter ────────────────────────────────── */
        const clipValue = clipKwh * rate / 100;
        if (ratio < 1.0) {
            out.push({
                level: 'watch', title: 'Inverter is larger than the array',
                metric: ratio.toFixed(2) + ':1 DC to AC',
                body: kwp + ' kWp behind a ' + inv + ' kW inverter. The inverter will never see its rated output, so you have paid ' +
                    'for headroom that does nothing. Irish light suits about 1.2 to 1.3, which would be roughly ' +
                    (inv * 1.25).toFixed(1) + ' kWp of panels on this inverter.'
            });
        } else if (clipPct < 1.5 && ratio < 1.15) {
            out.push({
                level: 'good', title: 'Nothing is being clipped, and there is room to add',
                metric: ratio.toFixed(2) + ':1, ' + clipPct.toFixed(1) + '% clipped',
                body: 'The inverter is comfortably ahead of the array. Irish roofs almost never reach rated output, so panels are usually ' +
                    'worth adding behind the same inverter — about ' + (inv * 1.25).toFixed(1) + ' kWp would still clip barely anything ' +
                    'while lifting output on dull days, which is most days here.'
            });
        } else if (clipPct < 1.5) {
            out.push({
                level: 'good', title: 'Array and inverter are well matched',
                metric: ratio.toFixed(2) + ':1, ' + clipPct.toFixed(1) + '% clipped',
                body: 'Barely anything is being clipped despite the array being ' + Math.round((ratio - 1) * 100) + '% larger than the inverter. ' +
                    'That oversizing is deliberate and normal here — Irish light almost never reaches rated output, so the extra panels lift ' +
                    'dull-day and winter yield while the inverter only has to throttle on a handful of bright summer hours.'
            });
        } else if (clipPct < 4) {
            out.push({
                level: 'good', title: 'Oversized array, and it is paying off',
                metric: ratio.toFixed(2) + ':1, ' + clipPct.toFixed(1) + '% clipped',
                body: kwp + ' kWp behind a ' + inv + ' kW inverter loses ' + clipKwh.toFixed(1) + ' kWh a week to clipping, about ' +
                    euroStr(clipValue) + '. That is a small price for the output those extra panels bring in on cloudy days, which is ' +
                    'most days in Ireland. Going up to ' + nc6Limit.toFixed(1) + ' kW would stay inside NC6 if you ever want to recover it.'
            });
        } else {
            out.push({
                level: clipPct > 8 ? 'issue' : 'watch',
                title: 'Clipping is starting to cost you',
                metric: ratio.toFixed(2) + ':1, ' + clipPct.toFixed(1) + '% clipped',
                body: clipKwh.toFixed(1) + ' kWh a week never makes it through the ' + inv + ' kW inverter, worth about ' + euroStr(clipValue) + '. ' +
                    (inv < nc6Limit - 0.4
                        ? 'A larger inverter up to ' + nc6Limit.toFixed(1) + ' kW stays inside the NC6 route and would convert most of it. '
                        : 'You are already at the NC6 ceiling, so a bigger inverter means the NC7 route. ') +
                    (batt.enabled && batt.coupling !== 'AC'
                        ? 'Your DC-coupled battery recovers ' + recovered.toFixed(1) + ' kWh of it when it has room.'
                        : 'None of it is currently being recovered.')
            });
        }

        /* 2 ── ESB connection route ──────────────────────────────────── */
        if (inv <= nc6Limit + 0.01) {
            out.push({
                level: 'good', title: 'Inside the NC6 route',
                metric: inv + ' kW on ' + (phase === 'THREE' ? 'three phase' : 'single phase'),
                body: 'ESB Networks assesses the limit on the inverter, not on the panels — 25 A (about 6 kVA) single phase, ' +
                    '16 A per phase (about 11 kVA) three phase. You are inside it, so an NC6 notification covers you with no connection fee. ' +
                    (inv < nc6Limit - 0.4
                        ? 'You could go up to ' + nc6Limit.toFixed(1) + ' kW and stay on the same route.'
                        : 'You are close to the ceiling.')
            });
        } else {
            out.push({
                level: 'issue', title: 'Above the NC6 ceiling',
                metric: inv + ' kW vs ' + nc6Limit.toFixed(1) + ' kW limit',
                body: 'An inverter of this rating needs the NC7 mini-generation route rather than NC6: a connection fee, and a formal ' +
                    'connection offer from ESB Networks before you can energise. Since 31 May 2023 anything rated over 25 A single phase ' +
                    'is no longer accepted under the inform-and-fit process. Export limiting the inverter down to ' + nc6Limit.toFixed(1) +
                    ' kW is the usual way round it.'
            });
        }

        /* 3 ── export limit vs inverter ──────────────────────────────── */
        if (exportLimit >= inv - 0.01) {
            out.push({
                level: 'good', title: 'Your inverter is the binding limit, not the grid',
                metric: 'export cap ' + exportLimit.toFixed(1) + ' kW',
                body: 'You can never push more than ' + inv + ' kW out, so the ' + exportLimit.toFixed(1) +
                    ' kW connection cap never comes into play. Nothing is being curtailed by the grid limit.'
            });
        } else {
            out.push({
                level: curtailed > 0.5 ? 'issue' : 'watch',
                title: 'Grid export cap is below your inverter',
                metric: curtailed.toFixed(1) + ' kWh curtailed this week',
                body: 'The connection is capped at ' + exportLimit.toFixed(1) + ' kW but the inverter can produce ' + inv + ' kW. ' +
                    'On bright days the inverter has to throttle back, worth about ' + euroStr(curtailed * rate / 100) + ' this week. ' +
                    'Storage is the fix: energy going into a battery is not export, so it does not count against the cap.'
            });
        }

        /* 4 ── what the battery is rescuing ──────────────────────────── */
        if (!batt.enabled || batt.capacityKwh <= 0) {
            out.push({
                level: noBatteryLost > 2 ? 'issue' : 'watch',
                title: 'No battery, so nothing catches the overflow',
                metric: noBatteryLost.toFixed(1) + ' kWh thrown away this week',
                body: 'With no storage, everything above the inverter and export limits is simply never generated — ' +
                    'there is nowhere for it to go. A battery absorbs that surplus instead, and on a DC-coupled hybrid it can take ' +
                    'energy from behind the inverter that would otherwise be clipped outright.'
            });
        } else if (clipKwh > 0.2 || curtailed > 0.2) {
            const saved = Math.max(0, noBatteryLost - lost);
            out.push({
                level: 'good',
                title: batt.coupling === 'AC' ? 'AC-coupled battery cannot reach clipped energy'
                    : (recovered > 0.1 ? 'DC-coupled battery is recovering clipping' : 'DC-coupled battery, but no room when it matters'),
                metric: recovered.toFixed(1) + ' kWh recovered this week',
                body: batt.coupling === 'AC'
                    ? 'An AC-coupled battery charges after the inverter, so it can catch surplus that would otherwise be exported or curtailed, ' +
                      'but it cannot touch energy clipped at the inverter itself. A DC-coupled hybrid can. On your array that difference is worth ' +
                      'roughly ' + clipKwh.toFixed(1) + ' kWh a week.'
                    : (recovered > 0.1
                        ? 'The battery charges from the DC side, so it picks up energy the inverter had to clip as well as ordinary surplus. ' +
                          'It is saving ' + saved.toFixed(1) + ' kWh a week that would otherwise be lost, about ' + euroStr(saved * rate / 100) + '.'
                        : 'A DC-coupled battery can absorb clipped energy, but yours is already full by the time clipping happens around midday — ' +
                          'it fills overnight on the cheap rate and tops up from the morning sun. More capacity, or a faster charge rate, ' +
                          'would be needed before it could catch any of the ' + clipKwh.toFixed(1) + ' kWh clipped this week.')
            });
        }

        /* 5 ── battery sizing ────────────────────────────────────────── */
        const usable = batt.capacityKwh * (1 - batt.minSocPct / 100);
        if (batt.enabled && batt.capacityKwh > 0) {
            if (usable < avgSurplus * 0.5) {
                out.push({
                    level: 'watch', title: 'Battery is small for your surplus',
                    metric: usable.toFixed(1) + ' kWh usable vs ' + avgSurplus.toFixed(1) + ' kWh daily surplus',
                    body: 'It fills early and everything after that goes to the grid. Whether more capacity pays depends on your rates: ' +
                        'at ' + cfg.tariff.evRate.toFixed(1) + 'c overnight against ' + cfg.tariff.dayRate.toFixed(1) +
                        'c by day, extra capacity earns its keep on the price gap even before the panels are involved.'
                });
            } else if (usable > avgSurplus * 3 && usable > cfg.dailyUsageKwh) {
                out.push({
                    level: 'watch', title: 'Battery is larger than you can fill or empty',
                    metric: usable.toFixed(1) + ' kWh usable vs ' + cfg.dailyUsageKwh + ' kWh daily usage',
                    body: 'Neither the panels nor the house can cycle this much in a day, so part of the pack sits idle. ' +
                        'Capacity only pays when it turns over.'
                });
            }
            if (peakSurplus > batt.maxChargeKw * 1.4) {
                out.push({
                    level: 'watch', title: 'Battery charges slower than your peak surplus',
                    metric: batt.maxChargeKw + ' kW charge vs ' + peakSurplus.toFixed(1) + ' kW peak surplus',
                    body: 'At midday the panels make more than the battery can take, so the excess goes straight out to the grid ' +
                        'whether the battery is full or not. It also means the overnight cheap window fills the pack more slowly — ' +
                        'at ' + batt.maxChargeKw + ' kW you can only move ' + (batt.maxChargeKw * 3).toFixed(1) + ' kWh in a three-hour window.'
                });
            }
        }

        /* 6 ── roof pitch and facing ─────────────────────────────────── */
        const lat = solarCfg.latitude, lon = solarCfg.longitude;
        const mine = window.SolarModel.annualTiltFactor(lat, lon, solarCfg.panelTiltDeg, solarCfg.panelAzimuthDeg);
        const best = window.SolarModel.bestTiltFor(lat, lon);
        const pct = best.value > 0 ? (mine / best.value) * 100 : 100;
        if (pct >= 97) {
            out.push({
                level: 'good', title: 'Roof pitch and facing are close to ideal',
                metric: Math.round(pct) + '% of the best possible',
                body: 'At this latitude the optimum is around ' + best.tilt + '° facing ' + Math.round(best.azimuth) +
                    '°. Yours is within a few percent, which is as good as it gets without moving the house.'
            });
        } else {
            out.push({
                level: pct < 85 ? 'issue' : 'watch',
                title: 'Roof is off the best pitch and facing',
                metric: Math.round(pct) + '% of the best possible',
                body: 'Best here would be about ' + best.tilt + '° facing ' + Math.round(best.azimuth) + '°, so you are giving up roughly ' +
                    Math.round(100 - pct) + '%. Worth knowing rather than worth fixing — but it does mean a west-facing array shifts output ' +
                    'later in the day, which suits an evening-peak house and hurts less than the raw number suggests.'
            });
        }

        /* 7 ── shading ───────────────────────────────────────────────── */
        if ((solarCfg.shadingLossPct || 0) >= 15) {
            out.push({
                level: (solarCfg.shadingLossPct >= 25) ? 'issue' : 'watch',
                title: 'Shading is costing you real output',
                metric: solarCfg.shadingLossPct + '% loss',
                body: 'At this level, panel-level optimisers or microinverters usually pay for themselves, because one shaded panel ' +
                    'otherwise drags down the whole string. Worth getting a shade survey before adding any more panels.'
            });
        }

        return out;
    }

    function euroStr(n) { return '€' + Math.abs(n).toFixed(2); }

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
            grid: Object.assign({}, DEFAULT_CONFIG.grid, c.grid || {}),
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
        clippedByHour: clippedByHour,
        simulateDay: simulateDay,
        compareStrategies: compareStrategies,
        buildInsights: buildInsights,
        assessSystem: assessSystem,
        NC6_LIMIT: NC6_LIMIT,
        mergeConfig: mergeConfig
    };
})();
