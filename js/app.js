/*
 * Værkart – varsel fra MET/Yr oppå OpenStreetMap.
 * Ren statisk app (ingen byggesteg) – laget for GitHub Pages.
 *
 * Datakilder:
 *  - Varsel: MET Locationforecast 2.0 (api.met.no), CC BY 4.0
 *  - Kart:   OpenStreetMap-fliser
 *  - Søk:    Nominatim (OpenStreetMap)
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- Konfig

  var FORECAST_URL = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
  var NOMINATIM_URL = "https://nominatim.openstreetmap.org";

  // Kandidat-URLer for MET sine offisielle værsymboler (SVG). Vi prober ved
  // oppstart og bruker den første som svarer.
  var ICON_BASES = [
    "https://cdn.jsdelivr.net/gh/metno/weathericons@main/weather/svg/",
    "https://cdn.jsdelivr.net/gh/metno/weathericons@master/weather/svg/",
    "https://cdn.statically.io/gh/metno/weathericons/main/weather/svg/"
  ];
  var iconBase = ICON_BASES[0];

  // Rutenett av værpunkter i kartutsnittet
  var GRID_COLS = 6;
  var GRID_ROWS = 4;
  var COORD_DECIMALS = 2;   // ~1 km – gir god cache-treff ved panorering
  var FETCH_CONCURRENCY = 4;

  var HOURLY_HOURS = 48;    // time for time de første 48 t
  var SIXHOUR_DAYS = 9;     // deretter 6-timers steg opptil 9 døgn

  // ---------------------------------------------------------------- Tilstand

  var map;
  var markerLayer;
  var forecastCache = Object.create(null); // "lat,lon" -> { byTime, times } | "pending" | "failed"
  var gridPoints = [];                     // aktive punkter i utsnittet
  var timeline = buildTimeline();
  var timeIndex = 0;
  var playTimer = null;
  var detailAbort = null;

  // ---------------------------------------------------------------- Tidslinje

  /** Bygger en liste med UTC-tidspunkter: hver time i 48 t (fra neste hele
   *  time), deretter hver 6. time (justert til 00/06/12/18 UTC) i 9 døgn.
   *  Dette speiler oppløsningen i Locationforecast. */
  function buildTimeline() {
    var out = [];
    var t = new Date();
    t.setUTCMinutes(0, 0, 0);

    for (var h = 0; h < HOURLY_HOURS; h++) {
      out.push(new Date(t.getTime() + h * 3600e3));
    }

    var last = out[out.length - 1];
    var next6 = new Date(last.getTime());
    next6.setUTCHours(Math.ceil((next6.getUTCHours() + 1) / 6) * 6, 0, 0, 0);

    var end = t.getTime() + SIXHOUR_DAYS * 24 * 3600e3;
    for (var ts = next6.getTime(); ts <= end; ts += 6 * 3600e3) {
      out.push(new Date(ts));
    }
    return out;
  }

  var DAY_FMT = new Intl.DateTimeFormat("nb-NO", { weekday: "long", day: "numeric", month: "long" });
  var HOUR_FMT = new Intl.DateTimeFormat("nb-NO", { hour: "2-digit", minute: "2-digit" });

  function formatTimeLabel(date) {
    var now = new Date();
    var label;
    if (date.toDateString() === now.toDateString()) {
      label = "I dag";
    } else {
      var tomorrow = new Date(now.getTime() + 24 * 3600e3);
      label = date.toDateString() === tomorrow.toDateString()
        ? "I morgen"
        : capitalize(DAY_FMT.format(date));
    }
    return label + " kl. " + HOUR_FMT.format(date);
  }

  function capitalize(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------------------------------------------------------------- Værdata

  function coordKey(lat, lon) {
    return lat.toFixed(COORD_DECIMALS) + "," + lon.toFixed(COORD_DECIMALS);
  }

  /** Henter og indekserer varsel for ett punkt. Returnerer Promise. */
  function fetchForecast(lat, lon) {
    var key = coordKey(lat, lon);
    var cached = forecastCache[key];
    if (cached && cached !== "failed") {
      return cached.promise || Promise.resolve(cached);
    }

    var url = FORECAST_URL + "?lat=" + lat.toFixed(COORD_DECIMALS) +
              "&lon=" + lon.toFixed(COORD_DECIMALS);

    var entry = {};
    entry.promise = fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (json) {
        var series = (json.properties && json.properties.timeseries) || [];
        entry.byTime = Object.create(null);
        entry.times = [];
        series.forEach(function (step) {
          var ms = Date.parse(step.time);
          entry.byTime[ms] = step;
          entry.times.push(ms);
        });
        delete entry.promise;
        forecastCache[key] = entry;
        return entry;
      })
      .catch(function (err) {
        forecastCache[key] = "failed";
        throw err;
      });

    forecastCache[key] = entry;
    return entry.promise;
  }

  /** Nærmeste tidssteg i et varsel, maks 3,5 t unna. */
  function nearestStep(entry, date) {
    var target = date.getTime();
    var best = null;
    var bestDiff = 3.5 * 3600e3;
    for (var i = 0; i < entry.times.length; i++) {
      var diff = Math.abs(entry.times[i] - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = entry.byTime[entry.times[i]];
      }
      if (entry.times[i] > target + bestDiff) break;
    }
    return best;
  }

  function symbolCode(step) {
    var d = step.data;
    return (d.next_1_hours && d.next_1_hours.summary.symbol_code) ||
           (d.next_6_hours && d.next_6_hours.summary.symbol_code) ||
           (d.next_12_hours && d.next_12_hours.summary.symbol_code) ||
           null;
  }

  function airTemp(step) {
    var inst = step.data.instant && step.data.instant.details;
    return inst && typeof inst.air_temperature === "number" ? inst.air_temperature : null;
  }

  // ---------------------------------------------------------------- Rutenett

  var refreshQueued = false;

  function refreshGrid() {
    if (refreshQueued) return;
    refreshQueued = true;
    setTimeout(function () {
      refreshQueued = false;
      doRefreshGrid();
    }, 350);
  }

  function doRefreshGrid() {
    var bounds = map.getBounds();
    var south = bounds.getSouth(), north = bounds.getNorth();
    var west = bounds.getWest(), east = bounds.getEast();

    gridPoints = [];
    for (var r = 0; r < GRID_ROWS; r++) {
      for (var c = 0; c < GRID_COLS; c++) {
        var lat = south + (north - south) * (r + 0.5) / GRID_ROWS;
        var lon = west + (east - west) * (c + 0.5) / GRID_COLS;
        lon = ((lon + 180) % 360 + 360) % 360 - 180; // normaliser
        if (lat < -85 || lat > 85) continue;
        gridPoints.push({
          lat: +lat.toFixed(COORD_DECIMALS),
          lon: +lon.toFixed(COORD_DECIMALS)
        });
      }
    }

    // Hent manglende varsler med begrenset parallellitet
    var queue = gridPoints.slice();
    var failures = 0;

    function worker() {
      var p = queue.shift();
      if (!p) return Promise.resolve();
      return fetchForecast(p.lat, p.lon)
        .catch(function () { failures++; })
        .then(function () {
          renderMarkers(); // tegn etter hvert som data kommer
          return worker();
        });
    }

    var workers = [];
    for (var i = 0; i < FETCH_CONCURRENCY; i++) workers.push(worker());
    Promise.all(workers).then(function () {
      if (failures > 0 && failures === gridPoints.length) {
        showToast("Kunne ikke hente værdata fra MET akkurat nå.");
      }
    });

    renderMarkers();
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    var when = timeline[timeIndex];

    gridPoints.forEach(function (p) {
      var entry = forecastCache[coordKey(p.lat, p.lon)];
      if (!entry || entry === "failed" || entry.promise) return;

      var step = nearestStep(entry, when);
      if (!step) return;

      var code = symbolCode(step);
      var temp = airTemp(step);
      if (code === null && temp === null) return;

      var html = '<div class="wx-box">';
      if (code) {
        html += '<img src="' + iconBase + code + '.svg" alt="" draggable="false">';
      }
      if (temp !== null) {
        var rounded = Math.round(temp);
        var cls = rounded >= 0 ? "warm" : "cold";
        html += '<span class="wx-temp ' + cls + '">' + rounded + '°</span>';
      }
      html += "</div>";

      L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: "wx-marker", html: html, iconSize: [44, 56], iconAnchor: [22, 28] }),
        interactive: false,
        keyboard: false
      }).addTo(markerLayer);
    });
  }

  // ---------------------------------------------------------------- Tidslinje-UI

  var slider = document.getElementById("time-slider");
  var timeLabel = document.getElementById("time-label");
  var playBtn = document.getElementById("play-btn");
  var speedSelect = document.getElementById("speed-select");

  function setTimeIndex(idx, fromSlider) {
    timeIndex = Math.max(0, Math.min(timeline.length - 1, idx));
    if (!fromSlider) slider.value = String(timeIndex);
    timeLabel.textContent = formatTimeLabel(timeline[timeIndex]);
    renderMarkers();
  }

  function stopPlayback() {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
      playBtn.textContent = "▶";
      playBtn.title = "Spill av været fremover";
    }
  }

  function startPlayback() {
    stopPlayback();
    playBtn.textContent = "⏸";
    playBtn.title = "Pause";
    playTimer = setInterval(function () {
      var next = timeIndex + 1;
      if (next >= timeline.length) next = 0; // start på nytt
      setTimeIndex(next);
    }, parseInt(speedSelect.value, 10));
  }

  playBtn.addEventListener("click", function () {
    if (playTimer) stopPlayback();
    else startPlayback();
  });

  speedSelect.addEventListener("change", function () {
    if (playTimer) startPlayback(); // restart med ny hastighet
  });

  slider.addEventListener("input", function () {
    stopPlayback();
    setTimeIndex(parseInt(slider.value, 10), true);
  });

  // ---------------------------------------------------------------- Søk

  var searchInput = document.getElementById("search-input");
  var searchResults = document.getElementById("search-results");
  var searchTimer = null;
  var searchAbort = null;

  function hideResults() {
    searchResults.hidden = true;
    searchResults.innerHTML = "";
  }

  function runSearch(query) {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();

    var url = NOMINATIM_URL + "/search?format=jsonv2&limit=6&accept-language=no&q=" +
              encodeURIComponent(query);

    fetch(url, { signal: searchAbort.signal })
      .then(function (res) { return res.json(); })
      .then(function (results) {
        searchResults.innerHTML = "";
        if (!results.length) {
          var li = document.createElement("li");
          li.className = "muted";
          li.textContent = "Ingen treff";
          searchResults.appendChild(li);
        }
        results.forEach(function (r) {
          var li = document.createElement("li");
          var name = r.name || r.display_name.split(",")[0];
          li.innerHTML = "<strong></strong><span class='sub'></span>";
          li.querySelector("strong").textContent = name;
          li.querySelector(".sub").textContent = r.display_name;
          li.addEventListener("click", function () {
            hideResults();
            searchInput.value = name;
            goToPlace(parseFloat(r.lat), parseFloat(r.lon), name);
          });
          searchResults.appendChild(li);
        });
        searchResults.hidden = false;
      })
      .catch(function (err) {
        if (err.name !== "AbortError") {
          showToast("Stedssøket feilet. Prøv igjen.");
        }
      });
  }

  function goToPlace(lat, lon, name) {
    map.flyTo([lat, lon], Math.max(map.getZoom(), 9), { duration: 1.2 });
    openDetail(lat, lon, name);
  }

  searchInput.addEventListener("input", function () {
    clearTimeout(searchTimer);
    var q = searchInput.value.trim();
    if (q.length < 2) { hideResults(); return; }
    searchTimer = setTimeout(function () { runSearch(q); }, 400);
  });

  searchInput.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") {
      var first = searchResults.querySelector("li:not(.muted)");
      if (first) first.click();
      else if (searchInput.value.trim().length >= 2) runSearch(searchInput.value.trim());
    } else if (ev.key === "Escape") {
      hideResults();
    }
  });

  document.addEventListener("click", function (ev) {
    if (!ev.target.closest(".search")) hideResults();
  });

  // ---------------------------------------------------------------- Detaljpanel

  var detailPanel = document.getElementById("detail-panel");
  var detailTitle = document.getElementById("detail-title");
  var detailBody = document.getElementById("detail-body");

  document.getElementById("detail-close").addEventListener("click", function () {
    detailPanel.hidden = true;
  });

  function openDetail(lat, lon, knownName) {
    detailPanel.hidden = false;
    detailTitle.textContent = knownName || lat.toFixed(3) + "°, " + lon.toFixed(3) + "°";
    detailBody.innerHTML = '<p class="muted">Laster varsel …</p>';

    if (detailAbort) detailAbort.abort();
    var abort = detailAbort = new AbortController();

    // Stedsnavn via omvendt geokoding (hvis vi ikke fikk det fra søket)
    if (!knownName) {
      fetch(NOMINATIM_URL + "/reverse?format=jsonv2&zoom=12&accept-language=no&lat=" +
            lat + "&lon=" + lon, { signal: abort.signal })
        .then(function (res) { return res.json(); })
        .then(function (r) {
          if (abort.signal.aborted) return;
          var a = r.address || {};
          var name = a.village || a.town || a.suburb || a.city || a.municipality ||
                     (r.name || "").split(",")[0];
          if (name) {
            detailTitle.textContent = name + (a.country && a.country !== "Norge" ? ", " + a.country : "");
          }
        })
        .catch(function () { /* navnet er pynt – ignorer feil */ });
    }

    fetchForecast(lat, lon)
      .then(function (entry) {
        if (abort.signal.aborted) return;
        renderDetail(entry);
      })
      .catch(function () {
        if (abort.signal.aborted) return;
        detailBody.innerHTML = '<p class="muted">Kunne ikke hente varselet. Prøv igjen senere.</p>';
      });
  }

  function tempSpan(t) {
    if (t === null || t === undefined) return "";
    var r = Math.round(t);
    return '<span class="' + (r >= 0 ? "t-warm" : "t-cold") + '">' + r + "°</span>";
  }

  function renderDetail(entry) {
    var html = "";

    // ---- Neste 24 timer, time for time
    html += "<h3>Neste 24 timer</h3><table class='hour-table'>";
    var now = Date.now();
    var count = 0;
    for (var i = 0; i < entry.times.length && count < 24; i++) {
      var ms = entry.times[i];
      if (ms < now - 3600e3) continue;
      var step = entry.byTime[ms];
      var d = step.data;
      if (!d.next_1_hours) break; // hourly-delen er slutt
      count++;

      var precip = d.next_1_hours.details &&
                   d.next_1_hours.details.precipitation_amount;
      var wind = d.instant.details.wind_speed;

      html += "<tr>" +
        "<td>" + HOUR_FMT.format(new Date(ms)) + "</td>" +
        "<td><img src='" + iconBase + d.next_1_hours.summary.symbol_code + ".svg' alt=''></td>" +
        "<td>" + tempSpan(airTemp(step)) + "</td>" +
        "<td class='precip'>" + (precip ? precip.toFixed(1) + " mm" : "") + "</td>" +
        "<td class='wind'>" + (wind != null ? Math.round(wind) + " m/s" : "") + "</td>" +
        "</tr>";
    }
    html += "</table>";

    // ---- Langtidsvarsel per døgn
    var days = aggregateDays(entry);
    html += "<h3>Langtidsvarsel</h3><table class='day-table'>";
    days.forEach(function (day) {
      html += "<tr>" +
        "<td class='day-name'>" + day.label + "<span class='sub'>" + day.dateLabel + "</span></td>" +
        "<td>" + (day.symbol ? "<img src='" + iconBase + day.symbol + ".svg' alt=''>" : "") + "</td>" +
        "<td>" + tempSpan(day.max) + " / " + tempSpan(day.min) + "</td>" +
        "<td class='precip'>" + (day.precip > 0 ? day.precip.toFixed(1) + " mm" : "") + "</td>" +
        "<td class='wind'>" + (day.wind != null ? Math.round(day.wind) + " m/s" : "") + "</td>" +
        "</tr>";
    });
    html += "</table>";

    html += "<p class='muted' style='font-size:0.75rem'>Varsel fra Meteorologisk institutt (Yr). " +
            "Tidspunkter i lokal tid.</p>";

    detailBody.innerHTML = html;
  }

  var WEEKDAY_FMT = new Intl.DateTimeFormat("nb-NO", { weekday: "long" });
  var DATE_FMT = new Intl.DateTimeFormat("nb-NO", { day: "numeric", month: "short" });

  /** Grupperer varselet per lokal dato: min/max-temp, nedbørsum, maks vind
   *  og symbolet nærmest kl. 12 lokal tid. */
  function aggregateDays(entry) {
    var byDate = Object.create(null);
    var order = [];

    entry.times.forEach(function (ms) {
      var step = entry.byTime[ms];
      var local = new Date(ms);
      var dateKey = local.getFullYear() + "-" + local.getMonth() + "-" + local.getDate();

      var day = byDate[dateKey];
      if (!day) {
        day = byDate[dateKey] = {
          date: local, min: null, max: null, precip: 0, wind: null,
          symbol: null, symbolDist: Infinity
        };
        order.push(dateKey);
      }

      var t = airTemp(step);
      if (t !== null) {
        if (day.min === null || t < day.min) day.min = t;
        if (day.max === null || t > day.max) day.max = t;
      }

      var w = step.data.instant.details && step.data.instant.details.wind_speed;
      if (w != null && (day.wind === null || w > day.wind)) day.wind = w;

      // Nedbør: summer 6-timersblokker på 00/06/12/18 UTC for å unngå
      // dobbeltelling (blokken tilskrives døgnet den starter i)
      var d = step.data;
      if (d.next_6_hours && new Date(ms).getUTCHours() % 6 === 0) {
        var det = d.next_6_hours.details;
        if (det && typeof det.precipitation_amount === "number") {
          day.precip += det.precipitation_amount;
        }
      }

      // Dagssymbol: 6-timerssymbolet nærmest kl. 12 lokal tid
      var sym = (d.next_6_hours && d.next_6_hours.summary.symbol_code) ||
                (d.next_1_hours && d.next_1_hours.summary.symbol_code);
      if (sym) {
        var dist = Math.abs(local.getHours() - 12);
        if (dist < day.symbolDist) {
          day.symbolDist = dist;
          day.symbol = sym;
        }
      }
    });

    var today = new Date().toDateString();
    var tomorrow = new Date(Date.now() + 24 * 3600e3).toDateString();

    return order.map(function (key) {
      var day = byDate[key];
      var ds = day.date.toDateString();
      day.label = ds === today ? "I dag" :
                  ds === tomorrow ? "I morgen" :
                  capitalize(WEEKDAY_FMT.format(day.date));
      day.dateLabel = DATE_FMT.format(day.date);
      return day;
    }).filter(function (day) {
      return day.min !== null; // dropp døgn helt uten data
    });
  }

  // ---------------------------------------------------------------- Diverse

  var toastEl = document.getElementById("status-toast");
  var toastTimer = null;

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 4000);
  }

  /** Finner en ikonkilde som faktisk svarer. */
  function probeIconBase() {
    var idx = 0;
    function tryNext() {
      if (idx >= ICON_BASES.length) return;
      var img = new Image();
      img.onload = function () {
        iconBase = ICON_BASES[idx];
        renderMarkers();
      };
      img.onerror = function () {
        idx++;
        tryNext();
      };
      img.src = ICON_BASES[idx] + "partlycloudy_day.svg";
    }
    tryNext();
  }

  // ---------------------------------------------------------------- Init

  function init() {
    map = L.map("map", {
      zoomControl: true,
      worldCopyJump: true
    }).setView([65.0, 13.0], 5); // Norge

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
                   ' | Værdata: <a href="https://api.met.no/">MET Norge</a> (CC BY 4.0)'
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);

    map.on("moveend", refreshGrid);
    map.on("click", function (ev) {
      openDetail(ev.latlng.lat, ev.latlng.lng);
    });

    slider.max = String(timeline.length - 1);
    setTimeIndex(0);

    probeIconBase();
    doRefreshGrid();
  }

  init();
})();
