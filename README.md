# signalk-1wire-temperature

1-Wire temperature sensors for Signal K.

This is a fork of [signalk-raspberry-pi-1wire](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire)
by Ewald van Gemert, which has been unmaintained since 2019. It adds a
configurable Signal K path per sensor ([issue #2](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/issues/2))
and publishes `units`, so displays no longer show raw Kelvin
([issue #1](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/issues/1),
[#3](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/pull/3)).

The plugin id is unchanged, so an existing `raspberry-pi-1wire` configuration
is picked up as is. Do not run both plugins at the same time, they read the
same sensors.

## Getting Started

You will need a Signal K server and a 1-wire temperature sensor to make use of this plugin.

### Prerequisites

You need basic understanding of installing Node applications with NPM.

The Raspberry Pi is the usual host, but nothing here is specific to it. The
plugin reads the Linux 1-wire subsystem through `/sys/bus/w1` directly, with no
native dependencies, so it works on any Linux host with a 1-wire master, whether
that is `w1_gpio` on an SBC, a DS9490R USB adapter via `ds2490`, or an I2C
master via `w1_ds2482`. Sensors on every bus master are found. It does not work
on macOS, Windows or FreeBSD, which have no `/sys/bus/w1`.

Readings keep the full resolution the sensor reports, 0.0625 °C at the usual 12
bit setting. If a sensor is configured for fewer bits the plugin says so in the
debug log.

Readings that fail their CRC check are discarded rather than published, as is
the exact value 85.0000 °C, which is what a DS18B20 holds after a power-on reset
when the conversion never ran. That value passes CRC, so a sensor stuck there
would otherwise be published indefinitely as a plausible hot reading. The cost
is that a genuine reading of exactly 85.0000 °C is dropped until the temperature
moves by one step.

### Installing SignalK

You can install the application with the command `npm install signalk-server`
Get documentation for the application here:
- https://www.npmjs.com/package/signalk-server

### 1-Wire sensor

You can find documentation of connecting and enabeling 1-wire sensors on your Raspberry Pi here:
- [Domoticx Dutch manual](http://domoticx.com/raspberry-pi-temperatuur-sensor-ds18b20-uitlezen/)
- [Connecting 1-wire](https://www.modmypi.com/blog/ds18b20-one-wire-digital-temperature-sensor-and-the-raspberry-pi)

### Enable 1-wire on Raspberry

You will have to enable the 1-wire protocol on the Raspberry-Pi
- [Enable 1-wire](https://www.raspberrypi-spy.co.uk/2018/02/enable-1-wire-interface-raspberry-pi/)

### Configuration

Each detected sensor is listed in the plugin configuration with these settings:

- **Sensor Id** - the 1-wire id of the sensor
- **Location name** - a human readable name, also published as the `displayName` of the path so displays can label the value
- **Signal K Path** - the full Signal K path for this sensor, for example `propulsion.0.temperature` or `electrical.alternators.0.temperature`
- **Signal K Key** - deprecated. When no full path is set, this key is appended to `environment` to build the path

Existing configurations keep working unchanged: sensors without a **Signal K Path** still publish under `environment.<key>`.

Temperatures are published in Kelvin and the plugin sets `units` on each path, so displays can convert to the unit of your choice.

### Building examples

- ![alt BreadBoard Example](https://raw.githubusercontent.com/johansolve/signalk-raspberry-pi-1wire/master/examples/raspberry-breadboard-1wire.jpg)

You can use a ISDN splitter to house a sensor, and plugin two more sensors. You will need to alter and solder the PCB.

- ![alt ISDN splitter internals](https://raw.githubusercontent.com/johansolve/signalk-raspberry-pi-1wire/master/examples/raspberry-1wire-from-isdn-splitter.jpg)
- ![alt ISDN splitter](https://raw.githubusercontent.com/johansolve/signalk-raspberry-pi-1wire/master/examples/raspberry-1wire-from-isdn-splitter2.jpg)

## Contributing

Please read [Readme.md](https://github.com/SignalK/signalk-server-node) for details on Signal-K.

## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repository](https://github.com/johansolve/signalk-raspberry-pi-1wire/tags).

## Authors

* **Ewald van Gemert** - *Author of the original plugin*
* **Johan Sölve** - *Configurable paths, units, maintainer of this fork*

See also the list of Signalk-server [contributors](https://github.com/SignalK/signalk-server-node/graphs/contributors) who participated in this project.

## License

Apache License 2.0, copyright 2019 Ewald van Gemert.

The original project declares two different licenses and ships neither as a
file: its `package.json` says ISC, while the header of `index.js` says Apache
License 2.0. Both are permissive and neither imposes copyleft obligations, so
the difference does not restrict use. This fork follows the license the source
itself names and points at, ships that text as `LICENSE`, keeps the original
copyright notice intact, and marks modified files as changed, as Apache 2.0
requires.
