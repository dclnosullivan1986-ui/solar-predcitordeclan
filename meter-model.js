/**
 * ESB Networks HDF Smart Meter CSV Parser & Analyzer
 *
 * Parses Irish ESB Networks Harmonised Downloadable Files (HDF) 100% locally
 * in the browser — supports both:
 *   - HDF_calckWh_*.csv  (Active Import/Export Interval (kWh))
 *   - HDF_kW_*.csv       (Active Import/Export Interval (kW) -> converted to kWh via / 2)
 *
 * Extracts:
 *   - Real 24-hour household load profile (preferring pre-solar history when present
 *     so daytime solar self-consumption doesn't mask true daytime demand)
 *   - Monthly import & export totals (kWh) + solar activation date & peak export kW
 *   - Year-to-date Clean Export Guarantee (CEG) income vs the €400 Revenue exemption
 *   - Exact rate-band breakdown (EV / Night / Day / Peak) & multi-tariff back-test
 */

window.MeterModel = (function () {
    'use strict';

    /**
     * Parse "DD-MM-YYYY HH:mm" or "YYYY-MM-DD HH:mm" timestamp strings fast without Date regex overhead.
     * ESB HDF timestamps mark the END of each 30-minute interval (e.g. 02:00 = 01:30–02:00, 02:30 = 02:00–02:30).
     */
    function parseEsbDate(str) {
        if (!str) return null;
        const s = str.trim();
        let day, month, year, hour, minute;

        // DD-MM-YYYY HH:mm (standard ESB Networks HDF format)
        if (s.length >= 16 && s[2] === '-' && s[5] === '-') {
            day = parseInt(s.slice(0, 2), 10);
            month = parseInt(s.slice(3, 5), 10);
            year = parseInt(s.slice(6, 10), 10);
            hour = parseInt(s.slice(11, 13), 10);
            minute = parseInt(s.slice(14, 16), 10);
        } else if (s.length >= 16 && s[4] === '-' && s[7] === '-') {
            // YYYY-MM-DD HH:mm or ISO
            year = parseInt(s.slice(0, 4), 10);
            month = parseInt(s.slice(5, 7), 10);
            day = parseInt(s.slice(8, 10), 10);
            hour = parseInt(s.slice(11, 13), 10);
            minute = parseInt(s.slice(14, 16), 10);
        } else {
            return null;
        }

        if (isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour)) return null;

        // Shift 30-min END time back by 15 mins to assign the interval to the hour it actually ran in
        // e.g. 02:30 (02:00–02:30) -> hour 2; 03:00 (02:30–03:00) -> hour 2; 00:00 (23:30–00:00) -> previous day hour 23
        let intervalHour = hour;
        let y = year, m = month, d = day;
        if (minute === 0) {
            if (hour === 0) {
                const prev = new Date(Date.UTC(year, month - 1, day) - 86400000);
                y = prev.getUTCFullYear();
                m = prev.getUTCMonth() + 1;
                d = prev.getUTCDate();
                intervalHour = 23;
            } else {
                intervalHour = hour - 1;
            }
        }

        const pad2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        return {
            year: y,
            month: m,
            day: d,
            hour: intervalHour,
            dateKey: y + '-' + pad2(m) + '-' + pad2(d),
            monthKey: y + '-' + pad2(m)
        };
    }

    /**
     * Parse raw ESB Networks HDF CSV text into a compact, rich analytics summary
     * suitable for instant UI rendering, tariff back-testing, and localStorage persistence.
     */
    function parseHdfCsv(csvText, fileName) {
        if (!csvText || typeof csvText !== 'string') {
            throw new Error('Empty file.');
        }

        const lines = csvText.split(/\r?\n/);
        if (lines.length < 2) {
            throw new Error('File does not contain enough rows.');
        }

        const header = lines[0].toLowerCase();
        if (!header.includes('read value') || !header.includes('read type')) {
            throw new Error('Not a recognised ESB Networks HDF CSV (expected "Read Value" and "Read Type" columns).');
        }

        const headerCols = lines[0].split(',').map(function (c) { return c.trim().toLowerCase(); });
        const idxMprn = headerCols.findIndex(function (c) { return c.includes('mprn'); });
        const idxVal = headerCols.findIndex(function (c) { return c.includes('read value'); });
        const idxType = headerCols.findIndex(function (c) { return c.includes('read type'); });
        const idxDate = headerCols.findIndex(function (c) { return c.includes('date'); });

        if (idxVal < 0 || idxType < 0 || idxDate < 0) {
            throw new Error('Required HDF columns missing.');
        }

        let mprn = '';
        let rowCount = 0;
        let isKwFormat = false;

        // Per-day & per-month accumulators
        const days = {};    // dateKey -> { imp, exp, impByHr[24], expByHr[24], monthKey, month, year }
        const months = {};  // monthKey -> { imp, exp, daySet, impByHr[24], expByHr[24], year, month }

        let minDate = null;
        let maxDate = null;
        let firstExportDate = null;
        let lastExportDate = null;
        let peakExportHalfHrKwh = 0;
        let peakImportHalfHrKwh = 0;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line || line.length < 10) continue;

            const cols = line.split(',');
            if (cols.length <= Math.max(idxVal, idxType, idxDate)) continue;

            if (!mprn && idxMprn >= 0 && cols[idxMprn]) {
                mprn = cols[idxMprn].trim();
            }

            const rawVal = parseFloat(cols[idxVal]);
            if (isNaN(rawVal) || rawVal < 0) continue;

            const readType = cols[idxType].trim();
            const rtLower = readType.toLowerCase();
            const isImport = rtLower.includes('import');
            const isExport = rtLower.includes('export');
            if (!isImport && !isExport) continue;

            // ESB HDF_kW files report average kW over 30 mins -> divide by 2 for kWh
            const isKwRow = rtLower.includes('(kw)') && !rtLower.includes('(kwh)');
            if (isKwRow) isKwFormat = true;
            const kwh = isKwRow ? rawVal * 0.5 : rawVal;

            const parsed = parseEsbDate(cols[idxDate]);
            if (!parsed) continue;

            rowCount++;
            if (!minDate || parsed.dateKey < minDate) minDate = parsed.dateKey;
            if (!maxDate || parsed.dateKey > maxDate) maxDate = parsed.dateKey;

            let dObj = days[parsed.dateKey];
            if (!dObj) {
                dObj = {
                    dateKey: parsed.dateKey,
                    monthKey: parsed.monthKey,
                    year: parsed.year,
                    month: parsed.month,
                    imp: 0,
                    exp: 0,
                    impByHr: new Array(24).fill(0),
                    expByHr: new Array(24).fill(0)
                };
                days[parsed.dateKey] = dObj;
            }

            let mObj = months[parsed.monthKey];
            if (!mObj) {
                mObj = {
                    monthKey: parsed.monthKey,
                    year: parsed.year,
                    month: parsed.month,
                    imp: 0,
                    exp: 0,
                    daysCount: 0,
                    impByHr: new Array(24).fill(0),
                    expByHr: new Array(24).fill(0)
                };
                months[parsed.monthKey] = mObj;
            }

            if (isImport) {
                dObj.imp += kwh;
                dObj.impByHr[parsed.hour] += kwh;
                mObj.imp += kwh;
                mObj.impByHr[parsed.hour] += kwh;
                if (kwh > peakImportHalfHrKwh) peakImportHalfHrKwh = kwh;
            } else {
                dObj.exp += kwh;
                dObj.expByHr[parsed.hour] += kwh;
                mObj.exp += kwh;
                mObj.expByHr[parsed.hour] += kwh;
                if (kwh > peakExportHalfHrKwh) peakExportHalfHrKwh = kwh;
                if (kwh > 0.02) {
                    if (!firstExportDate || parsed.dateKey < firstExportDate) firstExportDate = parsed.dateKey;
                    if (!lastExportDate || parsed.dateKey > lastExportDate) lastExportDate = parsed.dateKey;
                }
            }
        }

        const dayKeys = Object.keys(days).sort();
        if (!dayKeys.length) {
            throw new Error('No valid import/export interval rows were found in this CSV.');
        }

        // Count days per month
        dayKeys.forEach(function (dk) {
            months[days[dk].monthKey].daysCount++;
        });

        // Split pre-solar vs post-solar periods (if export started mid-dataset)
        const hasSolar = !!firstExportDate;
        const preSolarDays = [];
        const postSolarDays = [];
        dayKeys.forEach(function (dk) {
            const d = days[dk];
            if (hasSolar && dk >= firstExportDate) postSolarDays.push(d);
            else preSolarDays.push(d);
        });

        // Build real 24-hour household load profile:
        // Prefer pre-solar history (at least 30 days) because it reflects TRUE underlying
        // house consumption before daytime solar self-consumption hides midday load.
        // Fall back to all days if the meter only has post-solar data.
        const profileSource = preSolarDays.length >= 30 ? preSolarDays : dayKeys.map(function (k) { return days[k]; });
        const profileSourceLabel = preSolarDays.length >= 30
            ? 'Pre-solar baseline (' + preSolarDays.length + ' days)'
            : 'Meter import history (' + profileSource.length + ' days)';

        const hourlyAvgKwh = new Array(24).fill(0);
        profileSource.forEach(function (d) {
            for (let h = 0; h < 24; h++) hourlyAvgKwh[h] += d.impByHr[h];
        });
        for (let h = 0; h < 24; h++) hourlyAvgKwh[h] /= profileSource.length;

        const profileDailyAvg = hourlyAvgKwh.reduce(function (a, b) { return a + b; }, 0);
        const hourlyShape = profileDailyAvg > 0
            ? hourlyAvgKwh.map(function (v) { return v / profileDailyAvg; })
            : new Array(24).fill(1 / 24);

        // Seasonal monthly average daily base usage (from pre-solar or all days)
        const seasonalByMonth = new Array(12).fill(null);
        const mSum = new Array(12).fill(0);
        const mCnt = new Array(12).fill(0);
        profileSource.forEach(function (d) {
            mSum[d.month - 1] += d.imp;
            mCnt[d.month - 1] += 1;
        });
        for (let m = 0; m < 12; m++) {
            if (mCnt[m] >= 5) seasonalByMonth[m] = round2(mSum[m] / mCnt[m]);
        }

        // Build the back-test dataset: use the most recent period (up to 365 days; if solar is
        // active for >= 30 days, also provide post-solar period stats!)
        const recentStartIdx = Math.max(0, dayKeys.length - 365);
        const recentDays = dayKeys.slice(recentStartIdx).map(function (k) { return days[k]; });
        const recentHourlyImport = new Array(24).fill(0);
        let recentImportKwh = 0;
        let recentExportKwh = 0;
        recentDays.forEach(function (d) {
            recentImportKwh += d.imp;
            recentExportKwh += d.exp;
            for (let h = 0; h < 24; h++) recentHourlyImport[h] += d.impByHr[h];
        });

        // Post-solar hourly import & export totals (exact actual performance since solar switch-on!)
        const postHourlyImport = new Array(24).fill(0);
        let postImportKwh = 0;
        let postExportKwh = 0;
        postSolarDays.forEach(function (d) {
            postImportKwh += d.imp;
            postExportKwh += d.exp;
            for (let h = 0; h < 24; h++) postHourlyImport[h] += d.impByHr[h];
        });

        // Current calendar year (from maxDate's year) export total for €400 Revenue exemption tracker
        const latestYear = parseInt(maxDate.slice(0, 4), 10);
        let ytdExportKwh = 0;
        let ytdImportKwh = 0;
        let ytdDays = 0;
        dayKeys.forEach(function (dk) {
            const d = days[dk];
            if (d.year === latestYear) {
                ytdExportKwh += d.exp;
                ytdImportKwh += d.imp;
                ytdDays++;
            }
        });

        // Monthly series sorted chronologically
        const monthKeys = Object.keys(months).sort();
        const monthlySeries = monthKeys.map(function (mk) {
            const m = months[mk];
            return {
                monthKey: mk,
                year: m.year,
                month: m.month,
                days: m.daysCount,
                importKwh: round1(m.imp),
                exportKwh: round1(m.exp),
                avgImportDay: round1(m.imp / Math.max(1, m.daysCount)),
                avgExportDay: round1(m.exp / Math.max(1, m.daysCount))
            };
        });

        // Overall totals
        let totalImportKwh = 0;
        let totalExportKwh = 0;
        dayKeys.forEach(function (dk) {
            totalImportKwh += days[dk].imp;
            totalExportKwh += days[dk].exp;
        });

        // Mask MPRN slightly in display if desired, keep last 4 digits clearly visible
        const mprnDisplay = mprn.length > 6
            ? mprn.slice(0, 3) + '••••' + mprn.slice(-4)
            : mprn;

        return {
            fileName: fileName || 'ESB_HDF.csv',
            mprnMasked: mprnDisplay,
            isKwFormat: isKwFormat,
            rowCount: rowCount,
            totalDays: dayKeys.length,
            minDate: minDate,
            maxDate: maxDate,
            hasSolar: hasSolar,
            firstExportDate: firstExportDate,
            lastExportDate: lastExportDate,
            preSolarDaysCount: preSolarDays.length,
            postSolarDaysCount: postSolarDays.length,
            totalImportKwh: round1(totalImportKwh),
            totalExportKwh: round1(totalExportKwh),
            peakExportKw: round2(peakExportHalfHrKwh * 2),
            peakImportKw: round2(peakImportHalfHrKwh * 2),
            profileSourceLabel: profileSourceLabel,
            profileDailyAvgKwh: round2(profileDailyAvg),
            hourlyShape: hourlyShape,
            hourlyAvgKwh: hourlyAvgKwh.map(round3),
            seasonalByMonth: seasonalByMonth,
            latestYear: latestYear,
            ytdDays: ytdDays,
            ytdImportKwh: round1(ytdImportKwh),
            ytdExportKwh: round1(ytdExportKwh),
            // Compact 24-hour bucketed totals for instant tariff back-testing (no need to keep 43k rows in localStorage!)
            recentPeriod: {
                days: recentDays.length,
                startDate: recentDays[0].dateKey,
                endDate: recentDays[recentDays.length - 1].dateKey,
                importKwh: round1(recentImportKwh),
                exportKwh: round1(recentExportKwh),
                hourlyImport: recentHourlyImport.map(round2)
            },
            postSolarPeriod: postSolarDays.length > 0 ? {
                days: postSolarDays.length,
                startDate: postSolarDays[0].dateKey,
                endDate: postSolarDays[postSolarDays.length - 1].dateKey,
                importKwh: round1(postImportKwh),
                exportKwh: round1(postExportKwh),
                hourlyImport: postHourlyImport.map(round2)
            } : null,
            monthlySeries: monthlySeries
        };
    }

    /**
     * Evaluate any tariff (user's current tariff or a preset) against real meter hourly totals.
     */
    function costPeriodUnderTariff(period, tariff) {
        const EM = window.EnergyModel;
        const byBand = {
            ev: { kwh: 0, cost: 0 },
            night: { kwh: 0, cost: 0 },
            day: { kwh: 0, cost: 0 },
            peak: { kwh: 0, cost: 0 }
        };

        let importCost = 0;
        for (let h = 0; h < 24; h++) {
            const kwh = period.hourlyImport[h] || 0;
            const band = EM.bandForHour(h, tariff);
            const rate = EM.rateForBand(band, tariff);
            const cost = (kwh * rate) / 100;
            byBand[band].kwh += kwh;
            byBand[band].cost += cost;
            importCost += cost;
        }

        const standingCost = period.days * (tariff.standingChargeEuroPerDay || 0);
        const exportCredit = tariff.exportEnabled ? (period.exportKwh * tariff.exportRate) / 100 : 0;
        const netCost = importCost + standingCost - exportCredit;
        const annualisedNet = period.days > 0 ? (netCost / period.days) * 365 : 0;

        return {
            importCost: round2(importCost),
            standingCost: round2(standingCost),
            exportCredit: round2(exportCredit),
            netCost: round2(netCost),
            annualisedNet: round2(annualisedNet),
            byBand: byBand
        };
    }

    /**
     * Back-test the user's current tariff + all Irish tariff presets on their real meter data.
     */
    function backtestTariffs(meterData, currentTariff) {
        const EM = window.EnergyModel;
        if (!meterData) return null;

        // Use post-solar period if at least 30 days exist (reflects current solar + battery behaviour),
        // otherwise use the last 12 months (`recentPeriod`).
        const usePostSolar = !!(meterData.postSolarPeriod && meterData.postSolarPeriod.days >= 30);
        const period = usePostSolar ? meterData.postSolarPeriod : meterData.recentPeriod;
        const periodLabel = usePostSolar
            ? 'Since solar started (' + period.startDate + ' to ' + period.endDate + ', ' + period.days + ' days)'
            : 'Recent meter window (' + period.startDate + ' to ' + period.endDate + ', ' + period.days + ' days)';

        const currentEval = costPeriodUnderTariff(period, currentTariff);
        const comparisons = [];

        Object.keys(EM.TARIFF_PRESETS).forEach(function (key) {
            const p = EM.TARIFF_PRESETS[key];
            const res = costPeriodUnderTariff(period, p);
            comparisons.push({
                key: key,
                name: p.name,
                netCost: res.netCost,
                annualisedNet: res.annualisedNet,
                exportCredit: res.exportCredit,
                importCost: res.importCost
            });
        });

        comparisons.sort(function (a, b) { return a.netCost - b.netCost; });

        // Detect timer-clock drift / charging spillover into expensive hours adjacent to the EV window
        // (e.g. inverter/charger running on UTC instead of Irish Summer Time, starting at 01:00 instead of 02:00)
        let timerLeak = null;
        if (currentTariff.evEnd > currentTariff.evStart && currentTariff.nightRate > currentTariff.evRate + 2) {
            const preHr = (currentTariff.evStart + 23) % 24;
            const postHr = currentTariff.evEnd % 24;
            const refHrs = [0, 6, 7].filter(function (h) {
                return h !== preHr && h !== postHr && (h < currentTariff.evStart || h >= currentTariff.evEnd);
            });
            const baselineHrKwh = refHrs.length
                ? refHrs.reduce(function (s, h) { return s + (period.hourlyImport[h] || 0); }, 0) / refHrs.length
                : 0;

            const preExcess = Math.max(0, (period.hourlyImport[preHr] || 0) - baselineHrKwh * 1.4);
            const postExcess = Math.max(0, (period.hourlyImport[postHr] || 0) - baselineHrKwh * 1.4);
            const rateDiffEuro = (currentTariff.nightRate - currentTariff.evRate) / 100;

            if (preExcess >= 10 || postExcess >= 10) {
                const leakHr = preExcess >= postExcess ? preHr : postHr;
                const leakKwh = Math.max(preExcess, postExcess);
                const annualLeakKwh = period.days > 0 ? (leakKwh / period.days) * 365 : 0;
                const annualExtraCost = annualLeakKwh * rateDiffEuro;
                const pad2 = function (n) { return n < 10 ? '0' + n : '' + n; };
                timerLeak = {
                    hour: leakHr,
                    hourLabel: pad2(leakHr) + ':00–' + pad2((leakHr + 1) % 24) + ':00',
                    periodExcessKwh: round1(leakKwh),
                    monthlyExcessKwh: round1((leakKwh / Math.max(1, period.days)) * 30),
                    annualExtraEuro: round2(annualExtraCost),
                    evWindowLabel: pad2(currentTariff.evStart) + ':00–' + pad2(currentTariff.evEnd) + ':00'
                };
            }
        }

        return {
            period: period,
            periodLabel: periodLabel,
            current: currentEval,
            comparisons: comparisons,
            timerLeak: timerLeak
        };
    }

    function round1(n) { return Math.round(n * 10) / 10; }
    function round2(n) { return Math.round(n * 100) / 100; }
    function round3(n) { return Math.round(n * 1000) / 1000; }

    return {
        parseEsbDate: parseEsbDate,
        parseHdfCsv: parseHdfCsv,
        costPeriodUnderTariff: costPeriodUnderTariff,
        backtestTariffs: backtestTariffs
    };
})();
