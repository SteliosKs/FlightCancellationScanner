# Flight Cancellation Scanner

Minimal live flight cancellation monitor for:

- Paphos Airport (`PFO`)
- Larnaca Airport (`LCA`)

Priority order:

- Any flight involving Athens
- Other EU routes
- All remaining cancelled flights

## Setup

This version scrapes the public Hermes Airports arrivals/departures pages for `PFO` and `LCA` through a tiny local Node proxy.
The frontend uses Alpine.js from a CDN as a lightweight UI framework.

1. Start the local server:

```powershell
npm start
```

2. Open:

```text
http://127.0.0.1:3000
```

## Behavior

- The browser UI uses Alpine.js with no build step.
- The local server uses Node's built-in `http` module. No web framework is used.
- The backend scrapes Hermes Airports public flight tables for both Paphos and Larnaca.
- The UI refreshes automatically on a jittered interval and supports manual refresh.
- The backend uses serialized source fetches, jittered cache windows, and exponential backoff after source failures.
- If the provider fails, the UI shows either a hard failure or clearly marked stale cached data.

## Important

- This app depends on the Hermes Airports public page markup remaining compatible with the scraper.
- Hermes can change its HTML structure or throttle repeated requests, which would require scraper updates.
- It should not be the only source used for a life-critical travel decision. Use airport and airline direct channels as a second source.

## Security Notes

- Only `GET` and `HEAD` are accepted.
- Static file paths are constrained to the project root.
- The app does not take untrusted HTML input from users, and the UI renders dynamic text with safe text binding.
- This improves baseline OWASP posture, but it is not a formal guarantee of OWASP Top 10 compliance. A publishable review still needs HTTPS, deployment hardening, dependency review, and security testing.
