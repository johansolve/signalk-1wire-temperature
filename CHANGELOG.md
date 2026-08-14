# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-08-14

First release of this fork of
[signalk-raspberry-pi-1wire](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire),
which has been unmaintained since 2019 at version 1.0.1. Published under a new
name, so nothing upgrades into this automatically. The plugin id is unchanged,
so an existing configuration is picked up as is.

The major version reflects that the sensors are read by entirely new code and
that Node 18 is now required. The configuration itself is backwards compatible.

### Removed

- The `ds18b20` dependency, last released in 2015. The plugin has no native
  dependencies now.
- Support for Node below 18.

### Added

- A full Signal K path can be set per sensor, instead of every sensor being
  forced under `environment`. Resolves upstream
  [#2](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/issues/2).
- `units` is published as meta for every sensor, so displays can convert from
  Kelvin instead of showing it raw. Resolves upstream
  [#1](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/issues/1)
  and covers the same ground as upstream
  [#3](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/pull/3).
- `displayName` is published for sensors that have been given a location name
  of their own.
- The configured sensor resolution is reported at startup, with a warning when
  a sensor is set below 12 bits.
- Sensor enumeration is retried when the bus is not readable yet, rather than
  leaving the plugin dead until it is restarted by hand.
- Test suite and CI across Node 18, 20 and 22.

### Changed

- Temperatures are read from `/sys/bus/w1` directly.
- Readings keep the full resolution the sensor reports, 0.0625 °C at 12 bits.
  The previous library rounded every reading to 0.1 °C.
- Sensors on every bus master are found, not just `w1_bus_master1`.
- Default sample rate is 10 seconds, down from 30.

### Fixed

- A failed sensor read published `NaN` into the data model. Failed reads are
  now logged and skipped.
- Readings that fail their CRC check are discarded rather than published.
- The 85.0000 °C power-on value is rejected. It passes CRC, so a sensor stuck
  after a failed conversion was previously published as a plausible hot
  reading indefinitely.
- A sample cycle that is still running when the next one falls due is skipped,
  instead of stacking another batch of blocking reads onto the thread pool.
- Sensor enumeration and readings still in flight when the plugin is stopped no
  longer publish, and no longer duplicate the device list on restart.

[2.0.0]: https://github.com/johansolve/signalk-1wire-temperature/releases/tag/v2.0.0
