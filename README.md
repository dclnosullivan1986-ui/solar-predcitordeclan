# Newcastle West & Irish Eircode Solar Predictor

A high-resolution hourly solar PV generation and weather forecasting application tailored for **Newcastle West, Co. Limerick (Eircode: V42 AD96)** and any address across Ireland.

---

## 🌟 Live Hosted Web Link
- **Public GitHub Pages Site**: [https://dclnosullivan1986-ui.github.io/solar-predcitordeclan/](https://dclnosullivan1986-ui.github.io/solar-predcitordeclan/)
- **GitHub Repository**: [https://github.com/dclnosullivan1986-ui/solar-predcitordeclan](https://github.com/dclnosullivan1986-ui/solar-predcitordeclan)

---

## 📁 Project File Inventory

This folder contains all files for the application:

1. **`solar-predictor-newcastle-west.html`**: Zero-dependency standalone HTML file. Double-click to open in Edge, Chrome, or Safari without needing a local web server.
2. **`index.html`**: Web application shell.
3. **`styles.css`**: Dark mode glassmorphism UI design system with responsive cards and solar score badges.
4. **`solar-model.js`**: Physics engine calculating sun position, tilt/azimuth alignment, temperature derating, inverter loss factors, and daily "Good Day / Bad Day" rating scores.
5. **`app.js`**: Eircode & Irish address geocoding search bar controller, Open-Meteo weather API connector, and Chart.js visualization graph setup.

---

## 💡 Key Features Summary

1. **Newcastle West Default Lock (V42 AD96)**:
   - Latitude: `52.4497° N`
   - Longitude: `-9.0612° W`
   - Default 5.0 kWp system size, 35° roof pitch, South orientation.

2. **Eircode & Address Search**:
   - Type any Eircode (e.g. `V42 AD96`, `V94`, `V92`, `P56`, `D02`, etc.) or town into the search bar at the top to instantly recalculate predictions for that location.

3. **Solar Verdict & Appliance Load Assistant**:
   - Categorizes solar potential into **Great Solar Day** ☀️, **Good Solar Day** 🌤️, **Moderate Solar Day** ⛅, or **Bad Solar Day** 🌧️.
   - Highlights optimal hourly windows (e.g. 11:00 AM – 3:00 PM) for running high-draw appliances (Heat Pump, EV Charger, Immersion Heater, Washing Machine).
