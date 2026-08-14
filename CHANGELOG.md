# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-08-16

First release of this fork of
[signalk-raspberry-pi-1wire](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire),
which has been unmaintained since 2019 at version 1.0.1. Published under a new
name, so nothing upgrades into this automatically. The plugin id is unchanged,
so an existing configuration is picked up as is.

The major version reflects that the sensors are read by entirely new code and
that Node 18 is now required. The configuration itself is backwards compatible.

### Removed

- The `ds18b20` dependency, last released in 2015.
- The `underscore` dependency. The plugin now installs with no dependencies.
- Support for Node below 18.

### Added

- A full Signal K path per sensor, listed above the deprecated key it replaces
  and no longer offered with the deprecated field prefilled in the form, instead
  of everything under `environment`
  ([#2](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/issues/2)).
  A sensor discovered on the bus is still given the generated key, so it
  publishes something before it has been configured.
- A calibration offset per sensor, applied before the reading is published.
  Corrections beyond 50 degrees are refused as a typo rather than a
  calibration.
- `units` and `displayName` are set as default metadata where the server
  supports it, so a label you set yourself is no longer overwritten on every
  start. `units` as meta, so displays no longer show raw Kelvin
  ([#1](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/issues/1),
  [#3](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/pull/3)),
  and `displayName` for sensors given a name of their own.
- A plugin status: sensors being read, when the last reading landed, which
  sensors have stopped answering, named as you named them, and how many problems
  were found in the configuration. Those are permanent until the file is edited,
  while the status is rewritten every cycle, so they are carried rather than
  announced once and lost in the server log.
- Configured sensors that are not on the bus are named at startup. An upgrade
  from the original plugin usually carries a dozen of them, left behind by a
  library that enumerated bus errors as though they were sensors, and nothing
  used to say so.
- A test suite for the parser and the plugin lifecycle, on Node's built-in
  runner, so `npm test` needs nothing installed. CI across Node 18 through 24.
  The timing-dependent parts drive a frozen clock rather than waiting out real
  intervals, so nothing in the suite races the scheduler.
- App Store display name, icon and category. The plugin is listed as
  "1-Wire Temperature" rather than "Raspberry-Pi 1-Wire", since nothing in it
  is specific to that board.
- `LICENSE` and `NOTICE`, neither of which the original shipped.
- Documentation of what the bus requires, how to enable it and how to check it.

### Changed

- Temperatures are read from `/sys/bus/w1` directly.
- Readings keep the sensor's full resolution, 0.0625 °C at 12 bits. The previous
  library rounded every reading to 0.1 °C.
- Sensors are found on every bus master, not just `w1_bus_master1`, and only
  the families that report a temperature are read.
- The `key` setting is deprecated in favour of the full path, and still works.
- Default sample rate is 10 seconds, down from 30.

### Fixed

Against the original 1.0.1, the last release on npm.

- A failed read published `NaN` into the data model, and a CRC failure reached
  it as exactly 0 °C, which is entirely believable aboard. CRC failures, the
  85 °C power-on value, an all-zero scratchpad and readings outside -55 to
  +125 °C are now discarded instead.
- An unusable sample rate reached `setInterval` as `NaN`, which Node runs as one
  millisecond. Signal K hands plugins the raw configuration file, without
  checking it against the schema or filling in its defaults, so a hand-edited
  rate really does arrive as typed. It falls back to the default now, and a rate
  that was configured but cannot be used is reported.
- An empty bus left the plugin running over no sensors, silently and for good.
  The bus is retried instead: the directory exists as soon as the module loads,
  while the bus master can take seconds to finish its first search.
- Every sensor was read in the same tick, each holding a thread pool thread for
  the full 750 ms conversion. Four sensors pinned Node's default pool and
  stalled file and network activity for every other plugin in the process,
  finishing no sooner, since the driver serialises the bus anyway.
- A read that never returns no longer costs a thread on every cycle from then
  on, nor one per sensor. That sensor is skipped rather than asked again, and
  stays skipped across a restart, which cannot hand the thread back either. The
  sensors behind it are held back too: the driver holds the bus master's lock
  for the whole conversion, so a read still outstanding is still holding it, and
  asking the others would pin a thread each while reading nothing. The cycle it
  hung is written off after a minute so the plugin does not go quiet for good,
  measured on a monotonic clock: a Pi without a battery-backed clock boots in
  1970 and jumps years forward the moment it is told the time.
- Read failures were not reported at all. They are logged now, and three in a
  row is called out rather than left in a debug log nobody has switched on.
- A configuration that could not be saved, a sensor configured twice and two
  sensors sharing one path all failed silently.
- A sensor id differing only in case or spacing lost that sensor's path and
  calibration, and was written back to the configuration as a duplicate. Such an
  id is now read as the spelling the bus uses, since the bus answers to nothing
  else. The correction alone never triggers a save, so it reaches the file only
  if some other sensor is being written in the same pass.
- A metadata write the server refuses no longer takes the metadata off every
  sensor behind it, and the writes are chained across restarts as well as within
  a run: each ends in a write of the server's base deltas through a fixed
  temporary path, so two at once rename that file, vessel uuid and all, out from
  under each other.
- A rejection that is not an `Error` no longer takes the server down with it.
  Reading `.message` off it threw from inside the handler meant to contain the
  failure, which left the metadata chain rejected with nothing left to handle
  it, and an unhandled rejection ends the process in Node 15 and later.
- Work still in flight when the plugin stopped could publish, duplicate the
  device list, or let two measurement cycles run at once.
- The settings form no longer offers a made-up sensor id and location when a row
  is added by hand. The plugin finds sensors itself, so the only thing those
  defaults could produce was an entry reported at the next start as configured
  but not on the bus.

[2.0.0]: https://github.com/johansolve/signalk-1wire-temperature/releases/tag/v2.0.0
