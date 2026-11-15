# TODO

## Decisions

- Version 0.1.0 set by hand in `package.json`, `package-lock.json` and the
  manifest (`docker_image` `ghcr.io/lm1lc3n7/gladys-owserver:0.1.0`); the
  Release workflow owns it from now on.
- The client is written from the public description of the owserver protocol
  (owfs.org). OWFS is GPL-2.0: nothing of its code is copied nor ported.
- One connection per request (no persistence flag): simple, and owserver
  closes it after each answer anyway. One request at a time.
- Flags: `ownet` only. Temperatures in Celsius, ids in `f.i`, no alias, no
  special directories, whatever owserver is set to.
- External id `probe:<FF>-<SERIAL12>`: the ROM id without its CRC, the dot
  replaced by a dash (no dot in ids).
- Inputs (`sensed`) mapped to `opening-sensor/binary`: pin low (contact closed
  to ground) = closed (1), pin high = open (0). Documented.
- DS2423 counters as `counter-sensor/integer` (no unit: what they count is the
  user's). A drop is held (lifetime counters never go down), accepted by one
  click on "Accept the counter drops" for every counter held (not an energy
  index: no two-click acceptance).
- 85 °C of a DS18x20 taken only after a temperature within 10 °C of it.
- No `keywords` in the manifest. Category `protocols` only (a hub bringing a
  whole bus of devices). No `countries`: the whole world.
- Dependabot: the one of the template, unchanged.
- Category (review r1 h, decided in r2): `protocols` only. A 1-Wire bus
  brings third-party devices with no dominant domain (probes in a cellar, a
  pond, a fridge; pulse counters; contacts): neither `climate` nor
  `environment`.

## Later

- Review r1, minors left: (a) the previous temperature of the 85 °C check is
  in memory only; a probe really at 85.000 °C from the start is never
  published (documented). (e) A first read of more than 300 features goes out
  in one `publishChangedStates` (the SDK sends the rest at the next call). (f)
  A state file that is not valid JSON is started again from empty and written
  over (documented; the floor then rests on the value Gladys holds).
- Outputs of the DS2406, DS2408, DS2413 (PIO), behind an option, never a
  switch for anything a "turn everything off" could trigger.
- DS2438 humidity and voltages (only when a humidity sensor is wired: the
  value is computed even without one), DS2450 voltages, EDS00xx sensors.
- Devices behind a DS2409 hub (`/1F.xxx/main/`).
- Persistent connections (flag 0x04) for large buses.
- [ ] r3 mineurs : STOP_WAIT 5 s → 1 s (stop() ~9 s sous écriture figée), test de durée de stop(), EADDRNOTAVAIL, clé de session sans port, session refaite à chaque start().
