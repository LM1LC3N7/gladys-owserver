# gladys-owserver

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
1-Wire devices served by an **owserver** (OWFS) on your network: DS18B20 and
other temperature probes, DS2423 counters, DS2405/DS2406/DS2408/DS2413 inputs.
It speaks the owserver TCP protocol (port 4304) directly, without any cloud.
Read-only. Not affiliated with the OWFS project.

Tested against `owserver --fake`, never tested with a real 1-Wire bus.

- User guide: [English](docs/en.md) · [Français](docs/fr.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## How it works

- One TCP connection per request, one request at a time, each bounded in time
  (10 s, 5 s of silence at most) and in size (64 KiB).
- A read is one `DIRALL` of the root, then one `READ` per supported device
  (`temperature`, `counters.ALL`, `sensed.ALL`), asked in Celsius and in the
  `f.i` id form whatever owserver is set to.
- One Gladys device per 1-Wire device, keyed by its ROM id
  (`probe:28-4AEC29CDBAAB`).
- Values are checked strictly: text is never a 0, temperatures stay within
  -55..125 °C, the 85 °C power-on value is held back, counters never go down
  (a drop is held until the user accepts it).
- The time of the last read, the ROM ids seen and the counter floors are kept
  in `/data`, never written over when `/data` cannot be read.

## Development

```bash
npm install
npm test             # node --test
npm run lint
npm run format:check
```

Tests run against the SDK's fake Gladys, a scripted owserver, and small real
TCP servers on 127.0.0.1. To try it against a real owserver in fake mode:

```bash
docker run --rm -p 4304:4304 debian:trixie-slim sh -c \
  'apt-get update && apt-get install -y owserver && owserver --foreground --fake=10,28,1D,29 -p 0.0.0.0:4304'
```

## License

Apache-2.0 (see `LICENSE` and `THIRD_PARTY_NOTICES.md`). OWFS is GPL-2.0; none
of its code is part of this integration.
