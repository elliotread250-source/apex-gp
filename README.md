# APEX GP

A first-person Formula-style racing game that runs in the browser. No install, no build step: it's one HTML file using Three.js,
plus a small Python server (`server.py`) that serves it and relays multiplayer messages.

**Play:** https://apex-gp-production.up.railway.app (also https://elliotread250-source.github.io/apex-gp/)

## Features
- 10 teams with different top speed, acceleration, grip and braking
- 3 circuits: Autodromo Veloce (fast), Riviera Street Circuit (tight), Northfield Grand Prix (flowing)
- Grand Prix against up to 9 AI rivals with a 5-light start, or Time Trial with saved best laps
- Cockpit cam with halo, live steering-wheel display and g-force head movement, plus T-cam and chase cam
- DRS zones, ERS boost, auto or manual gearbox, kerbs, grass, wall hits, and power oversteer
- Synthesised engine, tyre and wind sound, plus gamepad support
- Online multiplayer for up to 8 players with a room code or invite link

## Multiplayer
Every player keeps one WebSocket to the relay at `/ws` (`server.py`, stdlib Python, transport in `wsnet.py`).
The host's browser still runs the race and relays everyone's state, as before, but nothing is
peer-to-peer any more, so it works on mobile networks and behind strict NATs. The relay stamps each
message with its real sender, lets players talk only to the host and only the host broadcast, caps
message size and rate, and closes the room when the host leaves. The GitHub Pages copy uses the relay
on Railway (allowed by origin); `?relay=wss://…` points a page at another relay.

```
python server.py                      # http://localhost:8080
node tools/relay-test.mjs http://localhost:8080
```

## Controls
| Key | Action |
| --- | --- |
| W / ↑ / Space | Throttle |
| S / ↓ | Brake (reverse when stopped) |
| A D / ← → | Steer |
| Shift | DRS (in green zones) |
| E | ERS boost |
| G | Auto / manual gearbox |
| X / Z | Shift up / down (manual) |
| C | Cycle camera |
| B | Look behind |
| [ ] | Field of view |
| R | Reset car |
| M | Mute |
| Esc / P | Pause |

Gamepad: RT/LT for throttle and brake, left stick to steer, A for DRS, B for ERS, Y for camera, Start to pause.
