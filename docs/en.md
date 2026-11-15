# owserver (1-Wire) for Gladys Assistant

Unofficial connector, not affiliated with the OWFS project. It reads the 1-Wire
devices served by an **owserver** (the network server of OWFS) running on your
network, over its TCP protocol (port 4304), without any cloud.

Tested against owserver in its fake-adapter mode (`owserver --fake`), never
tested with a real 1-Wire bus: tell us how it works with yours.

## What you get

One Gladys device per 1-Wire device listed at the root of owserver, keyed by
its ROM id (for example `28-4AEC29CDBAAB`): a new address of the owserver, or
the probe moved to another bus, keeps its device and its history.

| Family             | Chip                                       | Features                   |
| ------------------ | ------------------------------------------ | -------------------------- |
| 10, 22, 28, 3B, 42 | DS18S20, DS1822, DS18B20, DS1825, DS28EA00 | Temperature (°C)           |
| 26                 | DS2438                                     | Temperature (°C)           |
| 1D                 | DS2423                                     | Counter A, Counter B       |
| 05, 12, 3A, 29     | DS2405, DS2406, DS2413, DS2408             | Inputs, as opening sensors |

Other families (DS2450, DS2409 hubs, EDS sensors...) are named in the status
as "not supported yet". Devices behind a DS2409 hub are not read.

Read-only: only directory and read requests are sent, nothing is ever written
to the bus. The outputs of the switches (DS2406, DS2408, DS2413) will come
later.

## Setting up owserver

owserver must listen on the network, not only on localhost. In
`/etc/owfs.conf` of the machine that holds the 1-Wire adapter:

```
server: usb = all          # or: server: i2c = ALL:ALL for a DS2482
server: port = 0.0.0.0:4304
```

then restart owserver. Check from another machine with
`owdir -s 192.168.1.30:4304 /`.

## Configuration

- **owserver address**: its IP address or host name, with a port only if it is
  not 4304.
- **Read interval**: 30 s, 1 min (default), 2 or 5 min. With many devices the
  interval is lengthened so that a full read stays under 250 values a minute
  (64 devices are read at most).

Then open the **Discover** tab and create the devices you want.

## How values are checked

- Temperatures are asked in Celsius whatever owserver is set to. A value
  outside -55 to +125 °C, or a text that is not a number, is not published.
- **85 °C** is the value a DS18x20 gives when it did not convert (a power
  glitch, a parasite-powered probe that lost its supply): it is held back,
  unless the previous temperature of that probe was within 10 °C of it. The
  status names the probe; check its power supply.
- **Counters** (DS2423) never go down in Gladys: a lower value (a counter
  without battery starts again from 0 after a power cut) is held back and the
  status says so. When it is right, click **Accept the counter drops**: each
  counter held takes its lower value as its new start, published from the next
  read. Saving the configuration never does it.
- **Inputs**: owserver gives the level of the pin. A pin pulled low (a contact
  closed to ground) is shown as **closed**, a pin held high (a contact open,
  with its pull-up) as **open**.
- A device that fails (gone from the bus, a bus error, a value not readable)
  leaves only that device unread; the status names it. A round of reads starts
  no new device after 60 s: the devices left over are read first next time.

## Buttons

- **Test the connection**: reads the owserver once when a read is due (never
  more than one per interval), otherwise tells the last read.
- **Accept the counter drops**: see above.

## Status messages

The configuration screen shows the address, how many devices were read, and
notes: devices not read (and why), 85 °C held back, counters held back,
families not supported yet, devices not created in Gladys, a `/data` folder
that cannot be read (then counters are checked only against the values Gladys
holds and nothing is saved; tried again every 10 s).

## Privacy and security

owserver has no login: nothing secret is configured, stored or logged. The
integration keeps in its `/data` folder only the time of the last read, the
ROM ids seen and the counter values.

OWFS is distributed under the GPL 2.0; this integration contains none of its
code and only talks to owserver over the network (see `THIRD_PARTY_NOTICES.md`).
