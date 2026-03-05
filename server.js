const http = require("node:http");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HOST = "127.0.0.1";
const WATCHED_AIRPORTS = {
  PFO: {
    name: "Paphos",
    pageUrl: "https://www.hermesairports.com/flight-info/arrivals-and-departures-pfo/"
  },
  LCA: {
    name: "Larnaca",
    pageUrl: "https://www.hermesairports.com/flight-info/arrivals-and-departures-lca/"
  }
};
const BASE_CACHE_TTL_MS = 25_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_URL_LENGTH = 2048;
const ROOT_DIR = process.cwd();
const TABLE_REGEX = /<table class="flights-table tablesaw tablesaw-stack">[\s\S]*?<\/table>/g;
const ROW_REGEX = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
const CELL_REGEX = /<td[^>]*>([\s\S]*?)<\/td>/g;
const BLOCK_MARKERS = [
  "access denied",
  "temporarily blocked",
  "captcha",
  "verify you are human",
  "attention required",
  "sorry, you have been blocked",
  "cf-challenge",
  "challenge-platform",
  "/cdn-cgi/challenge-platform/",
  "rate limit",
  "too many requests",
  "bot detection",
  "forbidden"
];
const EU_COUNTRIES = new Set([
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
]);

let cache = {
  flights: [],
  alerts: [],
  lastSuccessAt: null,
  fetchedAt: null,
  stale: false,
  source: "Hermes Airports",
  warning: ""
};
let sourceBackoffUntil = 0;
let consecutiveFailureCount = 0;

function getJitteredTtlMs() {
  const jitterMs = Math.floor(Math.random() * 10_000);
  return BASE_CACHE_TTL_MS + jitterMs;
}

function getBackoffDelayMs() {
  const baseDelay = 30_000;
  const cappedMultiplier = Math.min(consecutiveFailureCount, 5);
  const backoffMs = baseDelay * (2 ** cappedMultiplier);
  return Math.min(backoffMs, 10 * 60_000);
}

function writeResponse(response, statusCode, headers) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");

  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      response.setHeader(name, value);
    }
  }

  response.statusCode = statusCode;
}

function sendJson(response, statusCode, payload) {
  writeResponse(response, statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }

  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }

  if (ext === ".js") {
    return "application/javascript; charset=utf-8";
  }

  if (ext === ".json") {
    return "application/json; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function resolveStaticPath(requestPath) {
  const safePath = requestPath === "/" ? "index.html" : requestPath.replace(/^[/\\]+/, "");
  const normalized = path.normalize(safePath);
  const filePath = path.resolve(ROOT_DIR, normalized);
  const rootWithSep = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : `${ROOT_DIR}${path.sep}`;

  if (filePath !== ROOT_DIR && !filePath.startsWith(rootWithSep)) {
    return null;
  }

  return filePath;
}

async function serveStatic(requestPath, response) {
  const filePath = resolveStaticPath(requestPath);

  if (!filePath) {
    writeResponse(response, 403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  try {
    const content = await fs.readFile(filePath);
    writeResponse(response, 200, {
      "Content-Type": getContentType(filePath)
    });
    response.end(content);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      writeResponse(response, 404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    writeResponse(response, 500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Failed to read file");
  }
}

function isEuCountry(country) {
  return EU_COUNTRIES.has(country);
}

function stripTags(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function cleanText(value) {
  return decodeHtml(stripTags(value));
}

function fetchTextWithPowerShell(url) {
  const safeUrl = String(url).replace(/'/g, "''");
  const command = `Invoke-WebRequest -UseBasicParsing -Uri '${safeUrl}' | Select-Object -ExpandProperty Content`;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        command
      ],
      {
        timeout: REQUEST_TIMEOUT_MS
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        resolve(stdout);
      }
    );
  });
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    const code = error && error.cause && error.cause.code;
    if (code !== "UNABLE_TO_GET_ISSUER_CERT_LOCALLY") {
      throw error;
    }

    return fetchTextWithPowerShell(url);
  } finally {
    clearTimeout(timer);
  }
}

function detectBlockPage(html, airportCode) {
  const normalized = String(html || "").toLowerCase();

  for (const marker of BLOCK_MARKERS) {
    if (normalized.includes(marker)) {
      throw new Error(`Hermes ${airportCode} appears to be blocking automated access (${marker})`);
    }
  }

  const hasFlightTables = TABLE_REGEX.test(html);
  TABLE_REGEX.lastIndex = 0;

  if (!hasFlightTables) {
    const titleMatch = normalized.match(/<title>([\s\S]*?)<\/title>/i);
    const titleText = titleMatch ? stripTags(titleMatch[1]).toLowerCase() : "";

    if (titleText.includes("just a moment") || titleText.includes("attention required")) {
      throw new Error(`Hermes ${airportCode} appears to be blocking automated access (challenge page)`);
    }
  }
}

function inferCountry(routeName) {
  const route = String(routeName || "").toLowerCase();

  if (!route) {
    return "Unknown";
  }

  const rules = [
    ["athens", "Greece"],
    ["thessaloniki", "Greece"],
    ["chania", "Greece"],
    ["skiathos", "Greece"],
    ["heraklion", "Greece"],
    ["paros", "Greece"],
    ["preveza", "Greece"],
    ["bucharest", "Romania"],
    ["cluj", "Romania"],
    ["timisoara", "Romania"],
    ["frankfurt", "Germany"],
    ["berlin", "Germany"],
    ["cologne", "Germany"],
    ["dusseldorf", "Germany"],
    ["munich", "Germany"],
    ["vienna", "Austria"],
    ["budapest", "Hungary"],
    ["warsaw", "Poland"],
    ["katowice", "Poland"],
    ["gdansk", "Poland"],
    ["poznan", "Poland"],
    ["wroclaw", "Poland"],
    ["krakow", "Poland"],
    ["sofia", "Bulgaria"],
    ["riga", "Latvia"],
    ["kaunas", "Lithuania"],
    ["vilnius", "Lithuania"],
    ["eindhoven", "Netherlands"],
    ["amsterdam", "Netherlands"],
    ["brussels", "Belgium"],
    ["charleroi", "Belgium"],
    ["milan", "Italy"],
    ["rome", "Italy"],
    ["venice", "Italy"],
    ["bologna", "Italy"],
    ["paris", "France"],
    ["marseille", "France"],
    ["lyon", "France"],
    ["copenhagen", "Denmark"],
    ["stockholm", "Sweden"],
    ["malmo", "Sweden"],
    ["prague", "Czech Republic"],
    ["bratislava", "Slovakia"],
    ["zagreb", "Croatia"],
    ["dubrovnik", "Croatia"],
    ["split", "Croatia"],
    ["ljubljana", "Slovenia"],
    ["madrid", "Spain"],
    ["barcelona", "Spain"],
    ["palma", "Spain"],
    ["ibiza", "Spain"],
    ["london", "United Kingdom"],
    ["manchester", "United Kingdom"],
    ["bristol", "United Kingdom"],
    ["leeds", "United Kingdom"],
    ["newcastle", "United Kingdom"],
    ["birmingham", "United Kingdom"],
    ["glasgow", "United Kingdom"],
    ["edinburgh", "United Kingdom"],
    ["liverpool", "United Kingdom"],
    ["east midlands", "United Kingdom"],
    ["tel aviv", "Israel"],
    ["tel-aviv", "Israel"],
    ["haifa", "Israel"],
    ["amman", "Jordan"],
    ["dubai", "United Arab Emirates"]
  ];

  for (const [needle, country] of rules) {
    if (route.includes(needle)) {
      return country;
    }
  }

  return "Unknown";
}

function extractTimestamp(cellHtml, fallbackDate, fallbackTime) {
  const altMatch = cellHtml.match(/alt="([^"]+)"/i);
  if (altMatch) {
    const raw = altMatch[1].split("|")[0].trim();
    if (raw) {
      return raw;
    }
  }

  if (!fallbackDate && !fallbackTime) {
    return "";
  }

  return [fallbackDate, fallbackTime].filter(Boolean).join(" ");
}

function parseHermesAlerts(html) {
  const match = html.match(/<div class="alert-wrap"[\s\S]*?<div class="cms-website-content-region">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/i);
  if (!match) {
    return [];
  }

  const regionHtml = match[1];
  const paragraphMatches = Array.from(regionHtml.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi));
  const alerts = paragraphMatches
    .map((paragraph) => cleanText(paragraph[1]))
    .filter((text) => text && text.toLowerCase() !== "announcement:");

  return alerts;
}

function parseFlightTable(tableHtml, airportCode) {
  const airport = WATCHED_AIRPORTS[airportCode];
  const headerText = cleanText(tableHtml);
  const isArrivalBoard = headerText.includes(" From ") || headerText.includes("From");
  const boardType = isArrivalBoard ? "arrival" : "departure";
  const flights = [];
  let activeDate = "";

  for (const rowMatch of tableHtml.matchAll(ROW_REGEX)) {
    const fullRowHtml = rowMatch[0];
    const rowHtml = rowMatch[1];
    const rowText = cleanText(rowHtml);

    if (fullRowHtml.includes("new-day-row")) {
      activeDate = rowText;
      continue;
    }

    const cells = Array.from(rowHtml.matchAll(CELL_REGEX)).map((match) => match[1]);
    if (cells.length < 5) {
      continue;
    }

    const airlineCell = cells[0];
    const airlineImageMatch = airlineCell.match(/(?:title|alt)="([^"]+)"/i);
    const airline = airlineImageMatch ? decodeHtml(airlineImageMatch[1]).trim() : cleanText(airlineCell);
    const flightNumber = cleanText(cells[1]) || "Unknown";
    const route = cleanText(cells[2]) || "Unknown";
    const time = cleanText(cells[3]);
    const status = cleanText(cells[4]) || "Scheduled";
    const notificationCell = cells[5] || "";
    const timestamp = extractTimestamp(notificationCell, activeDate, time);
    const routeCountry = inferCountry(route);

    flights.push({
      id: [airportCode, boardType, activeDate, flightNumber, time].join(":"),
      airport: airportCode,
      boardType,
      carrier: airline || "Unknown carrier",
      flightNumber,
      origin: isArrivalBoard ? route : airport.name,
      destination: isArrivalBoard ? airport.name : route,
      destinationCountry: routeCountry,
      time: timestamp,
      status,
      notes: `Hermes ${boardType} board`
    });
  }

  return flights;
}

function parseHermesPage(html, airportCode) {
  const tables = html.match(TABLE_REGEX) || [];
  return {
    flights: tables.flatMap((tableHtml) => parseFlightTable(tableHtml, airportCode)),
    alerts: parseHermesAlerts(html)
  };
}

async function fetchHermesPage(airportCode, force) {
  const airport = WATCHED_AIRPORTS[airportCode];
  const html = await fetchText(airport.pageUrl);
  detectBlockPage(html, airportCode);
  return parseHermesPage(html, airportCode);
}

function dedupeFlights(flights) {
  const map = new Map();

  for (const flight of flights) {
    if (!map.has(flight.id)) {
      map.set(flight.id, flight);
    }
  }

  return Array.from(map.values());
}

async function fetchFromProvider(force) {
  const now = Date.now();
  const cacheIsFresh = cache.lastSuccessAt && (now - new Date(cache.lastSuccessAt).getTime()) < getJitteredTtlMs();

  if (!force && cacheIsFresh) {
    return cache;
  }

  if (!force && sourceBackoffUntil > now) {
    throw new Error(`Source backoff active for ${Math.ceil((sourceBackoffUntil - now) / 1000)}s`);
  }

  const airportCodes = Object.keys(WATCHED_AIRPORTS);
  const successful = [];
  const failures = [];
  let alerts = [];

  for (const airportCode of airportCodes) {
    try {
      const payload = await fetchHermesPage(airportCode, force);
      successful.push(payload.flights);
      if (alerts.length === 0 && payload.alerts.length > 0) {
        alerts = payload.alerts;
      }

      // Small randomized delay reduces the request burst profile.
      if (airportCode !== airportCodes[airportCodes.length - 1]) {
        const waitMs = 600 + Math.floor(Math.random() * 900);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (successful.length === 0) {
    consecutiveFailureCount += 1;
    sourceBackoffUntil = Date.now() + getBackoffDelayMs();
    throw new Error(failures.join("; ") || "Hermes pages could not be fetched");
  }

  const mergedFlights = dedupeFlights(successful.flat()).map((flight) => ({
    ...flight,
    notes: String(flight.status).toLowerCase() === "cancelled"
      ? `${isEuCountry(flight.destinationCountry) ? "EU route" : "Non-EU route"} · ${flight.notes}`
      : flight.notes
  }));

  cache = {
    flights: mergedFlights,
    alerts,
    lastSuccessAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    stale: false,
    source: "Hermes Airports",
    warning: failures.length ? `Partial source failure: ${failures.join("; ")}` : ""
  };
  consecutiveFailureCount = failures.length ? 1 : 0;
  sourceBackoffUntil = failures.length ? Date.now() + getBackoffDelayMs() : 0;

  return cache;
}

async function handleApiFlights(requestUrl, response) {
  const force = requestUrl.searchParams.get("force") === "1";

  try {
    const payload = await fetchFromProvider(force);
    sendJson(response, 200, payload);
  } catch (error) {
    if (cache.lastSuccessAt) {
      cache = {
        ...cache,
        fetchedAt: new Date().toISOString(),
        stale: true,
        warning: error.message
      };
      sendJson(response, 200, cache);
      return;
    }

    sendJson(response, 503, {
      error: error.message,
      stale: true,
      flights: [],
      alerts: [],
      lastSuccessAt: null,
      fetchedAt: new Date().toISOString(),
      source: "Hermes Airports"
    });
  }
}

const server = http.createServer(async (request, response) => {
  if (!request.url || request.url.length > MAX_URL_LENGTH) {
    writeResponse(response, 400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    writeResponse(response, 405, {
      "Allow": "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8"
    });
    response.end("Method not allowed");
    return;
  }

  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

  if (requestUrl.username || requestUrl.password) {
    writeResponse(response, 400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Bad request");
    return;
  }

  if (requestUrl.pathname === "/api/flights") {
    if (request.method === "HEAD") {
      writeResponse(response, 200, { "Content-Type": "application/json; charset=utf-8" });
      response.end();
      return;
    }

    await handleApiFlights(requestUrl, response);
    return;
  }

  if (request.method === "HEAD") {
    try {
      const filePath = resolveStaticPath(requestUrl.pathname);
      if (!filePath) {
        writeResponse(response, 403, { "Content-Type": "text/plain; charset=utf-8" });
        response.end();
        return;
      }

      await fs.access(filePath);
      writeResponse(response, 200, {
        "Content-Type": getContentType(filePath)
      });
      response.end();
    } catch (error) {
      writeResponse(response, 404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end();
    }
    return;
  }

  await serveStatic(requestUrl.pathname, response);
});

server.listen(PORT, HOST, () => {
  console.log(`Flight monitor available at http://${HOST}:${PORT}`);
});
