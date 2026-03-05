window.flightMonitor = function flightMonitor() {
  return {
    airports: {
      PFO: "Paphos",
      LCA: "Larnaca"
    },
    euCountries: new Set([
      "Austria",
      "Belgium",
      "Bulgaria",
      "Croatia",
      "Cyprus",
      "Czech Republic",
      "Denmark",
      "Estonia",
      "Finland",
      "France",
      "Germany",
      "Greece",
      "Hungary",
      "Ireland",
      "Italy",
      "Latvia",
      "Lithuania",
      "Luxembourg",
      "Malta",
      "Netherlands",
      "Poland",
      "Portugal",
      "Romania",
      "Slovakia",
      "Slovenia",
      "Spain",
      "Sweden"
    ]),
    flights: [],
    alerts: [],
    airport: "ALL",
    region: "ALL",
    sortOrder: "RECENT",
    search: "",
    isLoading: false,
    pollHandle: null,
    meta: {
      stale: false,
      lastSuccessAt: null,
      fetchedAt: null,
      source: "",
      warning: ""
    },

    get cancelledFlights() {
      return this.flights.filter((flight) => String(flight.status).toLowerCase() === "cancelled");
    },

    get visibleFlights() {
      return this.cancelledFlights
        .filter((flight) => {
          if (this.airport !== "ALL" && flight.airport !== this.airport) {
            return false;
          }

          if (this.region === "EU" && !this.isEuFlight(flight)) {
            return false;
          }

          if (this.region === "ATHENS" && !this.isAthensFlight(flight)) {
            return false;
          }

          if (!this.search) {
            return true;
          }

          const haystack = [
            flight.carrier,
            flight.flightNumber,
            flight.origin,
            flight.destination,
            flight.destinationCountry
          ].join(" ").toLowerCase();

          return haystack.includes(this.search.toLowerCase());
        })
        .sort((a, b) => {
          const timeDiff = this.getComparableTime(a.time) - this.getComparableTime(b.time);

          if (this.sortOrder === "RECENT" && timeDiff !== 0) {
            return -timeDiff;
          }

          if (this.sortOrder === "OLDEST" && timeDiff !== 0) {
            return timeDiff;
          }

          const priorityDiff = this.priorityScore(b) - this.priorityScore(a);
          if (priorityDiff !== 0) {
            return priorityDiff;
          }

          return String(a.time).localeCompare(String(b.time));
        });
    },

    get athensCount() {
      return this.cancelledFlights.filter((flight) => this.isAthensFlight(flight)).length;
    },

    get euCount() {
      return this.cancelledFlights.filter((flight) => this.isEuFlight(flight)).length;
    },

    get statusClass() {
      if (this.meta.warning) {
        return this.meta.lastSuccessAt ? "warning" : "error";
      }

      return "ok";
    },

    get statusMessage() {
      if (this.meta.warning && !this.meta.lastSuccessAt) {
        return `Live feed offline: ${this.meta.warning}`;
      }

      if (this.meta.warning) {
        return `Using stale data: ${this.meta.warning}`;
      }

      return `Live feed connected${this.meta.source ? ` (${this.meta.source})` : ""}`;
    },

    get formattedLastUpdated() {
      return this.meta.lastSuccessAt ? this.formatTime(this.meta.lastSuccessAt) : "--";
    },

    get formattedDataAge() {
      return this.formatAge(this.meta.lastSuccessAt || this.meta.fetchedAt);
    },

    isEuFlight(flight) {
      return this.euCountries.has(flight.destinationCountry);
    },

    isAthensFlight(flight) {
      const origin = String(flight.origin || "").toLowerCase();
      const destination = String(flight.destination || "").toLowerCase();

      return origin.includes("athens") || destination.includes("athens");
    },

    priorityScore(flight) {
      if (this.isAthensFlight(flight)) {
        return 3;
      }

      if (this.isEuFlight(flight)) {
        return 2;
      }

      return 1;
    },

    priorityClass(flight) {
      if (this.isAthensFlight(flight)) {
        return "priority-athens";
      }

      if (this.isEuFlight(flight)) {
        return "priority-eu";
      }

      return "";
    },

    badgeLabel(flight) {
      if (this.isAthensFlight(flight)) {
        return "Athens";
      }

      if (this.isEuFlight(flight)) {
        return "EU Route";
      }

      return "Monitor";
    },

    parseFlightDate(value) {
      if (!value) {
        return null;
      }

      const trimmed = String(value).trim();
      const direct = new Date(trimmed);
      if (!Number.isNaN(direct.getTime())) {
        return direct;
      }

      const hermesMatch = trimmed.match(
        /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s+GMT([+-]\d{2}):(\d{2})(?::\d{2})?$/
      );

      if (hermesMatch) {
        const [, year, month, day, hour, minute, tzHour, tzMinute] = hermesMatch;
        const normalized = `${year}-${month}-${day}T${hour}:${minute}:00${tzHour}:${tzMinute}`;
        const parsed = new Date(normalized);

        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }

      const fallbackMatch = trimmed.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
      if (fallbackMatch) {
        const [, year, month, day, hour, minute] = fallbackMatch;
        const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);

        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }

      return null;
    },

    formatTime(value) {
      if (!value) {
        return "Time unavailable";
      }

      const date = this.parseFlightDate(value);
      if (!date) {
        return value;
      }

      return date.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      });
    },

    formatAge(value) {
      if (!value) {
        return "--";
      }

      const parsed = this.parseFlightDate(value);
      if (!parsed) {
        return "--";
      }

      const ageMs = Date.now() - parsed.getTime();
      if (ageMs < 0) {
        return "0s";
      }

      const totalSeconds = Math.floor(ageMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;

      if (minutes === 0) {
        return `${seconds}s`;
      }

      return `${minutes}m ${seconds}s`;
    },

    getComparableTime(value) {
      const parsed = this.parseFlightDate(value);
      if (parsed) {
        return parsed.getTime();
      }

      return Number.MAX_SAFE_INTEGER;
    },

    async loadFlights(force = false) {
      this.isLoading = true;

      try {
        const response = await fetch(`/api/flights${force ? "?force=1" : ""}`, {
          headers: {
            Accept: "application/json"
          }
        });

        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || "Live feed request failed");
        }

        this.flights = Array.isArray(payload.flights) ? payload.flights : [];
        this.alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
        this.meta = {
          stale: Boolean(payload.stale),
          lastSuccessAt: payload.lastSuccessAt || null,
          fetchedAt: payload.fetchedAt || null,
          source: payload.source || "",
          warning: payload.warning || ""
        };
      } catch (error) {
        this.flights = [];
        this.alerts = [];
        this.meta = {
          stale: true,
          lastSuccessAt: null,
          fetchedAt: new Date().toISOString(),
          source: "",
          warning: error.message
        };
      } finally {
        this.isLoading = false;
      }
    },

    scheduleNextPoll() {
      if (this.pollHandle) {
        window.clearTimeout(this.pollHandle);
      }

      const nextDelayMs = 35_000 + Math.floor(Math.random() * 20_000);
      this.pollHandle = window.setTimeout(async () => {
        await this.loadFlights(false);
        this.scheduleNextPoll();
      }, nextDelayMs);
    },

    init() {
      this.loadFlights(true);
      this.scheduleNextPoll();
    }
  };
};
