// Newcastle West & Irish Eircode Solar Dashboard Application Logic

const {
    ORIENTATIONS,
    WMO_WEATHER_CODES,
    calculateHourlyYield,
    analyzeDailySolarForecast
} = window.SolarModel;

// Application State
let appData = {
    currentLocation: {
        name: 'Newcastle West, Co. Limerick (V42 AD96)',
        eircode: 'V42 AD96',
        latitude: 52.4497,
        longitude: -9.0612,
        timezone: 'Europe/Dublin'
    },
    hourlyWeather: [],
    dailyAnalyses: [],
    selectedDayIndex: 0,
    chartInstance: null,
    viewMode: 'generation',
    config: {
        systemCapacityKwp: 5.0,
        panelTiltDeg: 35,
        panelAzimuthDeg: 180
    }
};

// Known Eircode / Location lookup database for instant offline/fast mapping
const KNOWN_EIRCODES = {
    'V42AD96': { name: 'Newcastle West, Co. Limerick (V42 AD96)', lat: 52.4497, lon: -9.0612 },
    'V42 AD96': { name: 'Newcastle West, Co. Limerick (V42 AD96)', lat: 52.4497, lon: -9.0612 },
    'V94': { name: 'Limerick City', lat: 52.6680, lon: -8.6305 },
    'V92': { name: 'Tralee, Co. Kerry', lat: 52.2704, lon: -9.7026 },
    'P56': { name: 'Charleville, Co. Cork', lat: 52.3550, lon: -8.6833 },
    'D02': { name: 'Dublin City', lat: 53.3498, lon: -6.2603 }
};

// DOM Elements
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingSubtitle = document.getElementById('loadingSubtitle');
const locationDisplayBadge = document.getElementById('locationDisplayBadge');
const footerCoordsText = document.getElementById('footerCoordsText');

const locationSearchInput = document.getElementById('locationSearchInput');
const btnSearchLocation = document.getElementById('btnSearchLocation');

const sysCapacityInput = document.getElementById('sysCapacity');
const panelTiltInput = document.getElementById('panelTilt');
const panelOrientationSelect = document.getElementById('panelOrientation');
const btnRecalculate = document.getElementById('btnRecalculate');
const currentTimeDisplay = document.getElementById('currentTimeDisplay');

const selectedDateBadge = document.getElementById('selectedDateBadge');
const verdictIcon = document.getElementById('verdictIcon');
const verdictBadge = document.getElementById('verdictBadge');
const solarScoreVal = document.getElementById('solarScoreVal');
const verdictSummary = document.getElementById('verdictSummary');
const scoreBarFill = document.getElementById('scoreBarFill');

const totalKwhVal = document.getElementById('totalKwhVal');
const yieldPerKwpVal = document.getElementById('yieldPerKwpVal');
const applianceWindowVal = document.getElementById('applianceWindowVal');
const peakPowerVal = document.getElementById('peakPowerVal');
const peakHourVal = document.getElementById('peakHourVal');
const avgCloudVal = document.getElementById('avgCloudVal');

const forecastGrid = document.getElementById('forecastGrid');
const hourlyTableBody = document.getElementById('hourlyTableBody');
const btnChartGen = document.getElementById('btnChartGen');
const btnChartIrradiance = document.getElementById('btnChartIrradiance');

/**
 * Geocode Search Logic for Eircodes & Irish Addresses
 */
async function geocodeAddress(queryStr) {
    if (!queryStr || !queryStr.trim()) return null;
    const cleanQuery = queryStr.trim().toUpperCase();

    // Check fast lookup table
    if (KNOWN_EIRCODES[cleanQuery]) {
        const item = KNOWN_EIRCODES[cleanQuery];
        return { name: item.name, latitude: item.lat, longitude: item.lon };
    }

    try {
        // Try Nominatim OpenStreetMap Ireland search
        const encoded = encodeURIComponent(`${queryStr}, Ireland`);
        const response = await fetch(`https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=ie`);
        if (response.ok) {
            const results = await response.json();
            if (results && results.length > 0) {
                const item = results[0];
                return {
                    name: `${item.display_name.split(',')[0]}, Ireland (${cleanQuery})`,
                    latitude: parseFloat(item.lat),
                    longitude: parseFloat(item.lon)
                };
            }
        }
    } catch (e) {
        console.warn('Nominatim geocode failed, trying fallback:', e);
    }

    try {
        // Fallback to Open-Meteo Geocoding API
        const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(queryStr)}&count=1&language=en&format=json`);
        if (response.ok) {
            const data = await response.json();
            if (data.results && data.results.length > 0) {
                const item = data.results[0];
                return {
                    name: `${item.name}${item.admin1 ? ', Co. ' + item.admin1 : ''} (${cleanQuery})`,
                    latitude: item.latitude,
                    longitude: item.longitude
                };
            }
        }
    } catch (e) {
        console.warn('Open-Meteo geocode failed:', e);
    }

    return null;
}

/**
 * Perform Location Search and reload model
 */
async function handleLocationSearch(queryOverride) {
    const query = queryOverride || locationSearchInput.value;
    if (!query) return;

    showLoadingScreen(`Searching location for "${query}"...`);
    const geo = await geocodeAddress(query);

    if (geo) {
        appData.currentLocation.name = geo.name;
        appData.currentLocation.latitude = geo.latitude;
        appData.currentLocation.longitude = geo.longitude;

        updateLocationHeaderBadges();
        appData.hourlyWeather = await fetchWeatherData();
        processForecastData();
        renderAllViews();
    } else {
        alert(`Could not find coordinates for "${query}". Reverting to Newcastle West (V42 AD96).`);
    }

    hideLoadingScreen();
}

function updateLocationHeaderBadges() {
    const { name, latitude, longitude } = appData.currentLocation;
    locationDisplayBadge.textContent = `📍 ${name}`;
    footerCoordsText.textContent = `${name} • Lat: ${latitude.toFixed(4)}° N | Lon: ${longitude.toFixed(4)}° W`;
}

/**
 * Fetch Hourly Forecast Data for Current Location
 */
async function fetchWeatherData() {
    const { latitude, longitude, timezone } = appData.currentLocation;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code,cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,shortwave_radiation,direct_radiation,diffuse_radiation,direct_normal_irradiance,global_tilted_irradiance,sunshine_duration,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,sunshine_duration,shortwave_radiation_sum&timezone=${encodeURIComponent(timezone || 'Europe/Dublin')}`;

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        return parseOpenMeteoResponse(data);
    } catch (err) {
        console.warn('Network call failed, generating synthetic forecast:', err);
        return generateSyntheticForecast();
    }
}

function parseOpenMeteoResponse(data) {
    const hourly = data.hourly;
    const hoursCount = hourly.time.length;
    const result = [];

    for (let i = 0; i < hoursCount; i++) {
        result.push({
            time: hourly.time[i],
            temperature_2m: hourly.temperature_2m[i],
            cloud_cover: hourly.cloud_cover[i],
            shortwave_radiation: hourly.shortwave_radiation[i],
            direct_radiation: hourly.direct_radiation[i],
            diffuse_radiation: hourly.diffuse_radiation[i],
            global_tilted_irradiance: hourly.global_tilted_irradiance ? hourly.global_tilted_irradiance[i] : 0,
            weather_code: hourly.weather_code[i],
            is_day: hourly.is_day[i]
        });
    }
    return result;
}

function generateSyntheticForecast() {
    const result = [];
    const now = new Date();

    for (let day = 0; day < 7; day++) {
        const cloudPatterns = [15, 35, 80, 45, 10, 90, 25];
        const baseCloud = cloudPatterns[day % 7];

        for (let hour = 0; hour < 24; hour++) {
            const dateObj = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, 0, 0);
            const isoTime = dateObj.toISOString().slice(0, 16);
            const isDay = hour >= 6 && hour <= 21 ? 1 : 0;
            
            let rad = 0;
            if (isDay) {
                const hourFactor = Math.sin((hour - 6) / 15 * Math.PI);
                const cloudAttenuation = (100 - baseCloud * 0.7) / 100;
                rad = Math.max(0, Math.round(750 * hourFactor * cloudAttenuation));
            }

            result.push({
                time: isoTime,
                temperature_2m: 14 + Math.round(Math.sin((hour - 8) / 12 * Math.PI) * 6),
                cloud_cover: baseCloud + Math.floor(Math.sin(hour) * 15),
                shortwave_radiation: rad,
                direct_radiation: Math.round(rad * 0.6),
                diffuse_radiation: Math.round(rad * 0.4),
                weather_code: baseCloud > 75 ? 3 : (baseCloud > 40 ? 2 : 0),
                is_day: isDay
            });
        }
    }
    return result;
}

function processForecastData() {
    const groups = {};
    appData.hourlyWeather.forEach(hour => {
        const dateStr = hour.time.split('T')[0];
        if (!groups[dateStr]) groups[dateStr] = [];
        groups[dateStr].push(hour);
    });

    appData.dailyAnalyses = Object.values(groups).map(dayHours => {
        return analyzeDailySolarForecast(
            dayHours,
            appData.config.systemCapacityKwp,
            appData.config.panelTiltDeg,
            appData.config.panelAzimuthDeg
        );
    });
}

function renderForecastCalendar() {
    forecastGrid.innerHTML = '';

    appData.dailyAnalyses.forEach((day, index) => {
        const dateObj = new Date(day.date);
        const dayName = index === 0 ? 'Today' : dateObj.toLocaleDateString('en-IE', { weekday: 'short' });
        const dateFormatted = dateObj.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' });

        const card = document.createElement('div');
        card.className = `day-card ${index === appData.selectedDayIndex ? 'selected' : ''}`;
        card.innerHTML = `
            <div class="day-date">${dayName}</div>
            <div class="day-sub">${dateFormatted}</div>
            <div class="day-icon">${day.ratingIcon}</div>
            <div class="day-kwh">${day.totalKwh} <span style="font-size: 0.8rem;">kWh</span></div>
            <div class="day-cloud">☁️ ${day.avgCloudCover}% cloud</div>
            <div style="margin-top: 8px;">
                <span class="solar-badge ${day.ratingClass}" style="font-size: 0.7rem; padding: 2px 8px;">${day.rating}</span>
            </div>
        `;

        card.addEventListener('click', () => {
            appData.selectedDayIndex = index;
            renderAllViews();
        });

        forecastGrid.appendChild(card);
    });
}

function renderHeroSummary() {
    const day = appData.dailyAnalyses[appData.selectedDayIndex];
    if (!day) return;

    const dateObj = new Date(day.date);
    const dateFormatted = dateObj.toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'short' });
    selectedDateBadge.textContent = appData.selectedDayIndex === 0 ? `Today (${dateFormatted})` : dateFormatted;

    verdictIcon.textContent = day.ratingIcon;
    verdictBadge.textContent = day.ratingLabel;
    verdictBadge.className = `solar-badge ${day.ratingClass}`;
    
    solarScoreVal.textContent = `${day.score}/100`;
    verdictSummary.textContent = day.summaryText;
    scoreBarFill.style.width = `${day.score}%`;

    totalKwhVal.textContent = day.totalKwh;
    yieldPerKwpVal.textContent = day.yieldPerKwp;
    applianceWindowVal.textContent = day.optimalWindow;

    peakPowerVal.textContent = day.maxPowerKw;
    peakHourVal.textContent = day.peakHourStr || 'N/A';
    avgCloudVal.textContent = `${day.avgCloudCover}%`;
}

function renderHourlyTable() {
    hourlyTableBody.innerHTML = '';
    const day = appData.dailyAnalyses[appData.selectedDayIndex];
    if (!day) return;

    day.hourlyYields.forEach(hour => {
        const hourTime = new Date(hour.time).toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit' });
        const weatherInfo = WMO_WEATHER_CODES[hour.weather_code] || { description: 'Clear', icon: '☀️' };

        let powerClass = 'power-zero';
        if (hour.powerKw >= 2.0) powerClass = 'power-high';
        else if (hour.powerKw > 0.1) powerClass = 'power-mid';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td style="font-weight: 700;">${hourTime}</td>
            <td>${weatherInfo.icon} ${weatherInfo.description}</td>
            <td>${hour.temperature_2m}°C</td>
            <td>${hour.cloud_cover}%</td>
            <td>${hour.effectiveIrradianceWm2} W/m²</td>
            <td>
                <span class="power-pill ${powerClass}">${hour.powerKw} kW</span>
            </td>
            <td style="font-size: 0.8rem; color: #94a3b8;">
                ${hour.isDaylight ? '☀️ Daylight' : '🌙 Night'}
            </td>
        `;
        hourlyTableBody.appendChild(row);
    });
}

function renderChart() {
    const day = appData.dailyAnalyses[appData.selectedDayIndex];
    if (!day) return;

    const labels = day.hourlyYields.map(h => new Date(h.time).getHours() + ':00');
    const powerData = day.hourlyYields.map(h => h.powerKw);
    const cloudData = day.hourlyYields.map(h => h.cloud_cover);
    const irradianceData = day.hourlyYields.map(h => h.effectiveIrradianceWm2);

    const ctx = document.getElementById('hourlyChart').getContext('2d');

    if (appData.chartInstance) {
        appData.chartInstance.destroy();
    }

    const isGenMode = appData.viewMode === 'generation';
    const mainDatasetLabel = isGenMode ? 'Solar Generation (kW)' : 'Irradiance (W/m²)';
    const mainData = isGenMode ? powerData : irradianceData;
    const mainColor = '#f59e0b';

    appData.chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: mainDatasetLabel,
                    data: mainData,
                    borderColor: mainColor,
                    backgroundColor: 'rgba(245, 158, 11, 0.2)',
                    fill: true,
                    tension: 0.35,
                    borderWidth: 3,
                    yAxisID: 'y'
                },
                {
                    label: 'Cloud Cover (%)',
                    data: cloudData,
                    borderColor: '#06b6d4',
                    backgroundColor: 'rgba(6, 182, 212, 0.05)',
                    borderDash: [5, 5],
                    tension: 0.2,
                    borderWidth: 2,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { ticks: { color: '#94a3b8' } },
                y: { type: 'linear', position: 'left', title: { display: true, text: mainDatasetLabel, color: mainColor }, ticks: { color: '#94a3b8' }, min: 0 },
                y1: { type: 'linear', position: 'right', title: { display: true, text: 'Cloud Cover (%)', color: '#06b6d4' }, ticks: { color: '#94a3b8' }, min: 0, max: 100 }
            },
            plugins: { legend: { labels: { color: '#f8fafc' } } }
        }
    });
}

function renderAllViews() {
    renderForecastCalendar();
    renderHeroSummary();
    renderChart();
    renderHourlyTable();
}

function handleConfigUpdate() {
    appData.config.systemCapacityKwp = parseFloat(sysCapacityInput.value) || 5.0;
    appData.config.panelTiltDeg = parseFloat(panelTiltInput.value) || 35;
    appData.config.panelAzimuthDeg = ORIENTATIONS[panelOrientationSelect.value] || 180;

    processForecastData();
    renderAllViews();
}

function showLoadingScreen(msg = 'Fetching Weather & Running Solar Model...') {
    if (loadingOverlay) {
        if (loadingSubtitle) loadingSubtitle.textContent = msg;
        loadingOverlay.style.display = 'flex';
        loadingOverlay.style.opacity = '1';
    }
}

function hideLoadingScreen() {
    if (loadingOverlay) {
        loadingOverlay.style.opacity = '0';
        setTimeout(() => { loadingOverlay.style.display = 'none'; }, 300);
    }
}

async function initApp() {
    const now = new Date();
    currentTimeDisplay.textContent = now.toLocaleDateString('en-IE', {
        weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    // Check URL parameters for custom eircode or location (e.g. ?eircode=V42AD96 or ?location=Tralee)
    const urlParams = new URLSearchParams(window.location.search);
    const paramLoc = urlParams.get('eircode') || urlParams.get('location') || urlParams.get('search');
    if (paramLoc) {
        locationSearchInput.value = paramLoc;
        const geo = await geocodeAddress(paramLoc);
        if (geo) {
            appData.currentLocation.name = geo.name;
            appData.currentLocation.latitude = geo.latitude;
            appData.currentLocation.longitude = geo.longitude;
        }
    }

    updateLocationHeaderBadges();

    // Event listeners
    btnSearchLocation.addEventListener('click', () => handleLocationSearch());
    locationSearchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleLocationSearch();
    });

    // Preset pills event listener
    document.querySelectorAll('.pill-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const loc = e.target.getAttribute('data-loc');
            locationSearchInput.value = loc;
            handleLocationSearch(loc);
        });
    });

    btnRecalculate.addEventListener('click', handleConfigUpdate);

    btnChartGen.addEventListener('click', () => {
        appData.viewMode = 'generation';
        btnChartGen.classList.add('active');
        btnChartIrradiance.classList.remove('active');
        renderChart();
    });

    btnChartIrradiance.addEventListener('click', () => {
        appData.viewMode = 'irradiance';
        btnChartIrradiance.classList.add('active');
        btnChartGen.classList.remove('active');
        renderChart();
    });

    appData.hourlyWeather = await fetchWeatherData();
    processForecastData();
    renderAllViews();
    hideLoadingScreen();
}

window.addEventListener('DOMContentLoaded', initApp);
