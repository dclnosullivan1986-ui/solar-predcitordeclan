/**
 * Newcastle West Solar Weather & Physics Model
 * Location: Newcastle West, Co. Limerick, Ireland (52.4497° N, 9.0612° W)
 */

window.SolarModel = (function() {
    const NEWCASTLE_WEST_COORDS = {
        latitude: 52.4497,
        longitude: -9.0612,
        elevation: 42,
        timezone: 'Europe/Dublin'
    };

    const ORIENTATIONS = {
        'SOUTH': 180,
        'SOUTH_WEST': 225,
        'WEST': 270,
        'SOUTH_EAST': 135,
        'EAST': 90
    };

    const WMO_WEATHER_CODES = {
        0: { description: 'Clear Sky', icon: '☀️' },
        1: { description: 'Mainly Clear', icon: '🌤️' },
        2: { description: 'Partly Cloudy', icon: '⛅' },
        3: { description: 'Overcast', icon: '☁️' },
        45: { description: 'Foggy', icon: '🌫️' },
        51: { description: 'Light Drizzle', icon: '🌦️' },
        61: { description: 'Slight Rain', icon: '🌧️' },
        63: { description: 'Moderate Rain', icon: '🌧️' },
        80: { description: 'Rain Showers', icon: '🌦️' }
    };

    function getSunPosition(date, lat = NEWCASTLE_WEST_COORDS.latitude, lon = NEWCASTLE_WEST_COORDS.longitude) {
        const rad = Math.PI / 180;
        const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 1000 / 60 / 60 / 24);
        const declination = 23.45 * Math.sin(rad * (360 / 365) * (dayOfYear - 81));
        const b = (2 * Math.PI / 364) * (dayOfYear - 81);
        const eqOfTime = 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
        const hours = date.getUTCHours() + date.getUTCMinutes() / 60;
        const solarTime = hours + (lon / 15) + (eqOfTime / 60);
        const hourAngle = (solarTime - 12) * 15;
        
        const sinElevation = Math.sin(rad * lat) * Math.sin(rad * declination) +
                             Math.cos(rad * lat) * Math.cos(rad * declination) * Math.cos(rad * hourAngle);
        const elevation = Math.asin(Math.max(-1, Math.min(1, sinElevation))) / rad;
        
        const cosAzimuth = (Math.sin(rad * declination) * Math.cos(rad * lat) -
                            Math.cos(rad * declination) * Math.sin(rad * lat) * Math.cos(rad * hourAngle)) /
                            Math.cos(rad * elevation);
        let azimuth = Math.acos(Math.max(-1, Math.min(1, cosAzimuth))) / rad;
        if (hourAngle > 0) azimuth = 360 - azimuth;
        
        return { elevation, azimuth };
    }

    function calculateHourlyYield(weatherHour, config) {
        const {
            systemCapacityKwp = 5.0,
            panelTiltDeg = 35,
            panelAzimuthDeg = 180,
            systemEfficiency = 0.85
        } = config;

        const shortwaveRadiation = weatherHour.shortwave_radiation || 0;
        const directRadiation = weatherHour.direct_radiation || 0;
        const diffuseRadiation = weatherHour.diffuse_radiation || 0;
        const globalTilted = weatherHour.global_tilted_irradiance || 0;
        const temperature = weatherHour.temperature_2m || 15;
        const cloudCover = weatherHour.cloud_cover || 0;

        if (shortwaveRadiation <= 2 && globalTilted <= 2) {
            return { powerKw: 0, effectiveIrradianceWm2: 0, cloudLossPct: 0, tempLossPct: 0, isDaylight: false };
        }

        let poaIrradiance = globalTilted > 0 ? globalTilted : 0;
        if (poaIrradiance <= 0) {
            const sunPos = getSunPosition(new Date(weatherHour.time), config.latitude, config.longitude);
            if (sunPos.elevation > 0) {
                const rad = Math.PI / 180;
                const incidenceCos = Math.sin(rad * sunPos.elevation) * Math.cos(rad * panelTiltDeg) +
                    Math.cos(rad * sunPos.elevation) * Math.sin(rad * panelTiltDeg) * Math.cos(rad * (sunPos.azimuth - panelAzimuthDeg));
                poaIrradiance = Math.max(0, directRadiation * Math.max(0, incidenceCos)) + diffuseRadiation * ((1 + Math.cos(rad * panelTiltDeg)) / 2);
            } else {
                poaIrradiance = diffuseRadiation * 0.5;
            }
        }

        const cellTemp = temperature + (poaIrradiance / 800) * 25;
        const tempDerating = 1 + (cellTemp - 25) * -0.004;
        let powerKw = (poaIrradiance / 1000) * systemCapacityKwp * systemEfficiency * tempDerating;
        powerKw = Math.min(systemCapacityKwp * 1.05, Math.max(0, powerKw));

        return {
            powerKw: parseFloat(powerKw.toFixed(3)),
            effectiveIrradianceWm2: Math.round(poaIrradiance),
            cloudLossPct: cloudCover,
            tempLossPct: parseFloat(((1 - tempDerating) * 100).toFixed(1)),
            isDaylight: true
        };
    }

    function analyzeDailySolarForecast(dailyHoursData, systemCapacityKwp = 5.0, panelTiltDeg = 35, panelAzimuthDeg = 180, lat = 52.4497, lon = -9.0612) {
        let totalKwh = 0, maxPowerKw = 0, peakHourStr = '', totalCloudSum = 0, daylightCount = 0;
        const hourlyYields = [];

        dailyHoursData.forEach(hour => {
            const yieldData = calculateHourlyYield(hour, { systemCapacityKwp, panelTiltDeg, panelAzimuthDeg, latitude: lat, longitude: lon });
            hourlyYields.push({ ...hour, ...yieldData });
            totalKwh += yieldData.powerKw;

            if (yieldData.powerKw > maxPowerKw) {
                maxPowerKw = yieldData.powerKw;
                peakHourStr = `${String(new Date(hour.time).getHours()).padStart(2, '0')}:00`;
            }
            if (yieldData.isDaylight) {
                daylightCount++;
                totalCloudSum += hour.cloud_cover || 0;
            }
        });

        const avgCloudCover = daylightCount > 0 ? Math.round(totalCloudSum / daylightCount) : 100;
        const yieldPerKwp = totalKwh / systemCapacityKwp;

        let score = Math.round((Math.min(yieldPerKwp / 4.5, 1.0) * 65) + (Math.max(0, 100 - avgCloudCover) * 0.35));
        score = Math.min(100, Math.max(5, score));

        let rating = 'POOR', ratingLabel = 'Bad Solar Day', ratingIcon = '🌧️', ratingClass = 'badge-poor';
        let summaryText = 'Heavy clouds/rain expected. Low solar output; plan grid/battery reliance.';

        if (score >= 72 || yieldPerKwp >= 3.2) {
            rating = 'EXCELLENT'; ratingLabel = 'Great Solar Day'; ratingIcon = '☀️'; ratingClass = 'badge-excellent';
            summaryText = 'High solar generation expected! Great window to charge EV, heat water/home, & export energy.';
        } else if (score >= 48 || yieldPerKwp >= 2.0) {
            rating = 'GOOD'; ratingLabel = 'Good Solar Day'; ratingIcon = '🌤️'; ratingClass = 'badge-good';
            summaryText = 'Solid solar generation available. Good windows around midday for major household appliances.';
        } else if (score >= 28 || yieldPerKwp >= 1.0) {
            rating = 'MODERATE'; ratingLabel = 'Moderate Solar Day'; ratingIcon = '⛅'; ratingClass = 'badge-moderate';
            summaryText = 'Passing clouds & partial sun. Moderate generation; stagger heavy appliance loads.';
        }

        const highGenHours = hourlyYields.filter(h => h.powerKw >= Math.max(0.4, maxPowerKw * 0.55)).map(h => new Date(h.time).getHours());
        let optimalWindow = 'N/A';
        if (highGenHours.length > 0) {
            optimalWindow = `${String(Math.min(...highGenHours)).padStart(2, '0')}:00 – ${String(Math.max(...highGenHours) + 1).padStart(2, '0')}:00`;
        }

        return {
            date: dailyHoursData[0] ? dailyHoursData[0].time.split('T')[0] : '',
            totalKwh: parseFloat(totalKwh.toFixed(2)),
            yieldPerKwp: parseFloat(yieldPerKwp.toFixed(2)),
            maxPowerKw: parseFloat(maxPowerKw.toFixed(2)),
            peakHourStr, avgCloudCover, score, rating, ratingLabel, ratingIcon, ratingClass, summaryText, optimalWindow, hourlyYields
        };
    }

    return {
        NEWCASTLE_WEST_COORDS,
        ORIENTATIONS,
        WMO_WEATHER_CODES,
        getSunPosition,
        calculateHourlyYield,
        analyzeDailySolarForecast
    };
})();
