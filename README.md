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

The Raspberry Pi is the usual host, but nothing here is specific to it. The
plugin reads the Linux 1-wire subsystem through `/sys/bus/w1` directly, with no
native dependencies, so it works on any Linux host with a 1-wire master. It does
not work on macOS, Windows or FreeBSD, which have no `/sys/bus/w1`.

## Requirements

- **Linux with the 1-wire subsystem.** The plugin reads `/sys/bus/w1`, which
  needs the `wire` and `w1_therm` kernel modules plus a driver for whichever
  bus master you use. These ship with mainline Linux.
- **Node 18 or later.**
- **A 1-wire bus master**, see below.
- **A 4.7 kΩ pull-up resistor** between the sensor data line and 3.3 V. Without
  it the bus reads erratically or not at all.

No special privileges are needed. The sysfs files are world readable, so the
Signal K server reads them as its ordinary user.

### Enabling the bus on a Raspberry Pi or similar SBC

Add one line to `/boot/firmware/config.txt` (`/boot/config.txt` on systems
older than Bookworm) and reboot:

```
dtoverlay=w1-gpio
```

That puts the bus on GPIO4 (physical pin 7). Add `,gpiopin=<n>` to use another
pin. The overlay loads `wire` and `w1_gpio` for you, and `w1_therm` is pulled in
when a temperature sensor is found, so there is nothing to add to `/etc/modules`.

### Other bus masters

The bus master does not have to be a GPIO. A DS9490R USB adapter works through
`ds2490`, and an I2C master through `w1_ds2482`, on any Linux host including
ordinary x86 machines. Sensors on every bus master are found.

### Checking that it works

```
$ ls /sys/bus/w1/devices/
28-0121138f863c  28-3c01e0764633  w1_bus_master1

$ cat /sys/bus/w1/devices/28-3c01e0764633/w1_slave
2b 01 55 05 7f a5 81 66 cf : crc=cf YES
2b 01 55 05 7f a5 81 66 cf t=18687
```

Each `<family>-<serial>` directory is a sensor, and `t=` is the temperature in
millidegrees. If only the bus master shows up, the wiring or the pull-up is the
place to look. If nothing shows up at all, the overlay is not loaded, which
`lsmod | grep -E '^w1|^wire'` will confirm.

### Wiring references

- [Enable the 1-wire interface](https://www.raspberrypi-spy.co.uk/2018/02/enable-1-wire-interface-raspberry-pi/)
- [Connecting a DS18B20](https://www.modmypi.com/blog/ds18b20-one-wire-digital-temperature-sensor-and-the-raspberry-pi)

## Configuration

Each detected sensor is listed in the plugin configuration with these settings:

- **Sensor Id** - the 1-wire id of the sensor
- **Location name** - a human readable name, also published as the `displayName` of the path so displays can label the value
- **Signal K Path** - the full Signal K path for this sensor, for example `propulsion.0.temperature` or `electrical.alternators.0.temperature`
- **Signal K Key** - deprecated. When no full path is set, this key is appended to `environment` to build the path

Existing configurations keep working unchanged: sensors without a **Signal K Path** still publish under `environment.<key>`.

Temperatures are published in Kelvin and the plugin sets `units` on each path, so displays can convert to the unit of your choice.

## Readings

Readings keep the full resolution the sensor reports, 0.0625 °C at the usual 12
bit setting. If a sensor is configured for fewer bits the plugin says so in the
debug log.

Readings that fail their CRC check are discarded rather than published, as is
the exact value 85.0000 °C, which is what a DS18B20 holds after a power-on reset
when the conversion never ran. That value passes CRC, so a sensor stuck there
would otherwise be published indefinitely as a plausible hot reading. The cost
is that a genuine reading of exactly 85.0000 °C is dropped until the temperature
moves by one step.

A 12 bit conversion takes 750 ms per sensor and the bus is serial, so the sample
rate has a floor of roughly one second per sensor. A cycle that is still running
when the next one falls due is skipped rather than queued.

## Building examples

- ![alt BreadBoard Example](https://raw.githubusercontent.com/johansolve/signalk-1wire-temperature/master/examples/raspberry-breadboard-1wire.jpg)

You can use a ISDN splitter to house a sensor, and plugin two more sensors. You will need to alter and solder the PCB.

- ![alt ISDN splitter internals](https://raw.githubusercontent.com/johansolve/signalk-1wire-temperature/master/examples/raspberry-1wire-from-isdn-splitter.jpg)
- ![alt ISDN splitter](https://raw.githubusercontent.com/johansolve/signalk-1wire-temperature/master/examples/raspberry-1wire-from-isdn-splitter2.jpg)

## Contributing

Please read [Readme.md](https://github.com/SignalK/signalk-server-node) for details on Signal-K.

## Versioning

We use [SemVer](http://semver.org/) for versioning. For the versions available, see the [tags on this repository](https://github.com/johansolve/signalk-1wire-temperature/tags).

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
