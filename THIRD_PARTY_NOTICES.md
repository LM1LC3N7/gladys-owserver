# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## The owserver protocol (OWFS)

The client in `src/owserver/` speaks the owserver network protocol, written
from its public description on the OWFS website (<https://www.owfs.org>,
pages "owserver protocol", "owserver message types" and "owserver flag
word", read on 2026-11-15) and from the names of the device properties
(`temperature`, `counters.ALL`, `sensed.ALL`) of the OWFS device pages.

OWFS itself is distributed under the GNU General Public License 2.0. No OWFS
code is copied, ported or shipped with this integration: owserver runs on the
user's own machine, and this integration only talks to it over the network,
as any client of a documented protocol does.

## Runtime dependency

- `@gladysassistant/integration-sdk` (Apache-2.0), the Gladys integration SDK,
  installed from npm.
