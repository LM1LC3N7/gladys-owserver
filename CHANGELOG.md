# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-11-15

### Added

- First version: the 1-Wire devices of an owserver (OWFS) of the local network,
  read over the owserver TCP protocol (port 4304): temperatures (DS18B20,
  DS18S20, DS1822, DS1825, DS28EA00, DS2438), the two counters of a DS2423, and
  the inputs of the DS2405, DS2406, DS2408 and DS2413 as opening sensors.
  Read-only.
- Values checked strictly: no text published as a number, temperatures within
  -55..125 °C, the 85 °C power-on value held back, counters never lower in
  Gladys (a drop held until "Accept the counter drops").
- A read interval of 30 s to 5 min, lengthened with many devices (a full read under 250 values a
  minute), kept across restarts; the bus rests at least half an interval
  between two rounds.
- A `/data` write that does not finish never holds the reads nor the stop.
- CI jobs bounded by `timeout-minutes`.

[Unreleased]: https://github.com/LM1LC3N7/gladys-owserver/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-owserver/releases/tag/v0.1.1
