# Roadster Physics Check

Live: https://wooten-labs.com/roadster/

Each stunt from Tesla's October 15, 2026 Roadster reveal, rebuilt as a physics simulation in the browser. The on-screen telemetry (altitude, G, pitch, downforce) was read off Tesla's stream, and each stunt became a program for a simple flight computer. The car then flies that program as a rigid body: 10 nozzles (4 down, 4 rear, 2 yaw), a real-gas nitrogen tank, fan suction and tyre grip. Every assumption is a slider, and the wrong hardware crashes the car.

Not affiliated with, or endorsed by, Tesla or SpaceX.

## Files

- `site/roadster/physics.js`: the simulation. Pure functions, no DOM. Tank blowdown, nozzle allocation, rigid-body flight at 240 Hz, the wall-ride force balance, and the verdicts.
- `site/roadster/app.js`: the three.js scene, playback, gauges, charts and dials.
- `site/roadster/models.js`: procedural vehicle models.
- `site/roadster/tank-tables.js`: generated real-gas nitrogen tables. Don't edit it by hand.
- `scripts/roadster_tank_tables.py`: regenerates the tank tables with [CoolProp](http://www.coolprop.org/).

## Run it locally

It's a static page with no build step. Serve the folder and open it:

```
cd site/roadster
python3 -m http.server 8000
```

Then go to http://localhost:8000. three.js loads from jsDelivr.

To regenerate the tank tables:

```
pip install CoolProp
python3 scripts/roadster_tank_tables.py
```

## Licence

The code is MIT (see `LICENSE`), except `site/roadster/models.js`. Its vehicle outlines are traced from Wikimedia Commons photos, so it is shared under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/):

- [Model 3](https://commons.wikimedia.org/wiki/File:Tesla_Model_3_(2023),_long_range,_Japan,_left-side.jpg) by Kazyakuruma (CC0)
- [Cybercab](https://commons.wikimedia.org/wiki/File:Tesla_Cybercab_at_Santana_Row_side_view_dllu.jpg) by Dllu (CC BY-SA 4.0)
- [Semi render](https://commons.wikimedia.org/wiki/File:Tesla_Semi_Render.svg) by Jzh2074 (CC BY-SA 4.0)
- [Cybertruck](https://commons.wikimedia.org/wiki/File:Tesla_Cybertruck_-_Side_-_Tesla_Store_Athens_2024.jpg) by Mpelas199 (CC0)

The Roadster's shape is our own, estimated from Tesla's livestream.
