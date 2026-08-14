# signalk-1wire-temperature

1-Wire temperature sensors for Signal K.

This is a fork of
[signalk-raspberry-pi-1wire](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire)
by Ewald van Gemert, which has been unmaintained since 2019. It adds a
configurable Signal K path per sensor ([issue #2](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/issues/2))
and publishes `units`, so displays no longer show raw Kelvin
([issue #1](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/issues/1),
[#3](https://github.com/ewaldvangemert/signalk-raspberry-pi-1wire/pull/3)).

The plugin id is unchanged, so an existing `raspberry-pi-1wire` configuration
is picked up as is. **Uninstall the original package first.** Both share that
id, and a server that finds two copies loads exactly one of them, chosen by
package name, and says so only on its console.

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
- [Connecting a DS18B20](https://thepihut.com/blogs/raspberry-pi-tutorials/ds18b20-one-wire-digital-temperature-sensor-and-the-raspberry-pi)

## Configuration

**On first start the plugin finds every temperature sensor on the bus, writes
them into its configuration, and begins publishing immediately.** A sensor you
have not configured is published under `environment.inside.<sensor id>.temperature`,
which means it reaches your data, and anything recording it, before you have
told the plugin what it measures. Give each sensor a path, or a name at least,
before letting it run for long.

The bus is enumerated when the plugin starts, and only then. A sensor plugged in
while it is running is not picked up until the plugin is restarted, which saving
the settings does.

Each detected sensor is listed in the plugin configuration with these settings:

- **Sensor Id** - the 1-wire id of the sensor
- **Location name** - a human readable name. Once it differs from the
  generated `Sensor <id>`, it is also published as the `displayName` of the
  path so displays can label the value
- **Signal K Path** - the full Signal K path for this sensor, for example
  `propulsion.0.temperature` or `electrical.alternators.0.temperature`
- **Signal K Key** - deprecated. When no full path is set, this key is
  appended to `environment` to build the path
- **Calibration offset** - added to every reading from this sensor, `0` for no correction

Existing configurations keep working unchanged: sensors without a **Signal K
Path** still publish under `environment.<key>`, and sensors without a
**Calibration offset** are published uncorrected.

Anything wrong with the configuration is written to the server log in full, and
counted in the plugin status so it is visible without opening the log: a sensor
that is configured but absent, one configured twice, one with nowhere to
publish, two sensors sharing a path, an unusable calibration offset or sample
rate, and a sensor list that is not a list at all. Upgrades from the original
plugin usually carry several absent sensors, left behind by a library that
enumerated bus errors as though they were sensors.

If the bus cannot be read or holds no sensors yet, the plugin says so in its
status and looks again every 30 seconds rather than staying dead until it is
restarted. The bus master can take a few seconds after boot to finish its first
search, so an empty listing then is not proof that nothing is attached.

Temperatures are published in Kelvin and the plugin sets `units` on each path,
so displays can convert to the unit of your choice. Where the server supports
default metadata, `units` and `displayName` are set only if nothing has claimed
them, so a label you set yourself is left alone. The server records those in its
base deltas permanently, so changing a sensor's path leaves the old path's meta
behind; harmless, but the base deltas are the place to clear it out.

Readings appear under the source `raspberry-pi-1wire.XX`. The suffix is what
Signal K appends to a plugin source that names no talker, and it is kept as it
was so existing source filters and priority rules keep matching. One
consequence: the server clears a stopped plugin's readings by exact source name
and knows this one without the suffix, so the last temperatures go on being
served until the server restarts.

## Readings

Readings keep the full resolution the sensor reports, 0.0625 °C at the usual 12
bit setting. Lower settings are read just as well; the sensor's own
configuration decides, and this plugin does not change it.

Readings are discarded rather than published when:

- The CRC check fails, or the file carries no CRC status or no temperature
  at all.
- The value is exactly 85.0000 °C, which is what a DS18B20 holds after a power-on
  reset when the conversion never ran. It passes CRC, so a sensor stuck there
  would otherwise read as a plausible hot value forever. This is not only a
  precaution: kernels between 5.8 and 6.3 held the bus lock the wrong way round
  in `convert_t` and produced spurious 85 °C readings by themselves, which covers
  Raspberry Pi OS Bullseye and early Bookworm. The kernel's own check for it is
  off by default.
- The scratchpad is all zeroes, which is what a slave that never answers leaves
  behind. CRC over nine zero bytes is itself zero, so the kernel marks it good
  and decodes a thoroughly believable 0 °C. The zero *scratchpad* is what is
  rejected, not the value, so a genuine reading at freezing still gets through.
- The temperature falls outside the -55 to +125 °C the parts are specified over.
  Note that family `3b` covers the MAX31850 as well as the DS1825, and a K-type
  thermocouple interface reads far beyond that range, so this plugin is no use
  for one.

The 85 °C rule has a cost worth knowing about. At 12 bit it discards a single
0.0625 °C step, but at 9 to 11 bit one step covers up to 0.5 °C, so a band that
wide around 85 °C is dropped. On a sensor that can genuinely sit there, an
alternator or an engine block, that is a blind spot exactly where an alarm
threshold is likely to be.

### Sample rate

A 12 bit conversion takes 750 ms per sensor and the sensors are read one at a
time, so the rate has a floor of roughly one second per sensor. That is the slow
case: 9, 10 and 11 bit take 95, 190 and 375 ms, and a DS1825 at 14 bit takes 100.
A DS18S20 always takes the full 750 ms. A cycle still running when the next one
falls due is skipped rather than queued.

A rate that is missing, is not a number, is below one second, or is more than a
day falls back to the default of ten seconds. Note that it falls back rather
than being raised to one second, so a hand-edited `"rate": 0.5` samples every
ten seconds, not every one. Signal K hands plugins the file as it stands, so the
`minimum` and `default` in the settings form do not constrain a config that was
edited on disk.

### When a sensor stops answering

An unplugged sensor is the common case: the read comes straight back with an
error, every other sensor carries on as usual, and the broken one is named in
the plugin status after three failures in a row.

A read that never returns at all is rarer and worse, because nothing can take
that thread back. One still outstanding a minute after it was issued has its
cycle written off, and that sensor is then skipped rather than asked again,
across restarts too, since restarting cannot hand the thread back either.

The rest of the bus waits with it. The driver holds the bus master's lock for
the whole conversion, so a read still outstanding is still holding it: the other
sensors would block on that same lock, read nothing, and pin a thread pool
thread each while they waited. Four of those is Node's whole default pool, and
file and network activity would then stop for every other plugin in the server.
Sampling resumes by itself if the read ever does return.

### Calibration

Resolution is not accuracy. A DS18B20 resolves 0.0625 °C but is only specified
to ±0.5 °C between -10 and +85 °C, and a sensor is usually further off than that
because of where it sits rather than because of the chip: a through-hull that is
partly warmed by the hull, a sender bolted to a block that runs hotter than the
fluid in it.

**Calibration offset** corrects that. It is added to every reading from that one
sensor, in degrees, so `2` reads two degrees higher and `-0.4` reads slightly
lower. A kelvin and a degree Celsius are the same size, so the number you measure
against a reference thermometer is the number you enter, whichever unit you
compared in. Write it with a decimal point: an offset that cannot be read as a
number, or one beyond 50 degrees, is reported in the server log and ignored
rather than applied as something you did not intend. Corrected readings are
range checked too, so an offset near the end of a sensor's range cannot publish
a temperature the part could never have measured.

Correcting here rather than in a single dashboard is usually what you want. The
offset lands before the value reaches Signal K, so every consumer sees the same
corrected figure and the recorded history is corrected too. An offset applied in
one chart's query corrects that chart alone and leaves every other display, and
everything already written to a database, reading something else.

Two things it will not do. It cannot rescue a sensor whose error changes with
temperature, since a fixed offset only shifts the curve and never bends it. And
it shifts history only from the moment it is set, so data recorded before that
keeps the old values.

## Wiring examples

- ![Breadboard wiring for a 1-wire sensor](https://raw.githubusercontent.com/johansolve/signalk-1wire-temperature/master/examples/raspberry-breadboard-1wire.jpg)

An ISDN splitter makes a convenient housing for a sensor and gives you two more
sockets to plug sensors into. The PCB has to be modified and resoldered.

- ![The modified PCB inside an ISDN splitter](https://raw.githubusercontent.com/johansolve/signalk-1wire-temperature/master/examples/raspberry-1wire-from-isdn-splitter.jpg)
- ![The finished splitter with sensor sockets](https://raw.githubusercontent.com/johansolve/signalk-1wire-temperature/master/examples/raspberry-1wire-from-isdn-splitter2.jpg)

## Contributing

Signal K itself is documented at
[SignalK/signalk-server](https://github.com/SignalK/signalk-server). Issues and
pull requests for this plugin go to
[its issue tracker](https://github.com/johansolve/signalk-1wire-temperature/issues).

## Versioning

We use [SemVer](https://semver.org/) for versioning. For the versions
available, see the [tags on this repository](https://github.com/johansolve/signalk-1wire-temperature/tags).

## Authors

* **Ewald van Gemert** - *Author of the original plugin*
* **Johan Sölve** - *Configurable paths, units, maintainer of this fork*


## License

Apache License 2.0. Copyright 2019 Ewald van Gemert, copyright 2026 Johan Sölve.

The original shipped no license file and labelled itself inconsistently: ISC in
`package.json` and at the foot of its README, Apache 2.0 in the header of
`index.js`, its only source file. This fork follows the source header, which is
the notice attached to the code itself, and ships that text as `LICENSE`. The
ISC notice is reproduced in `NOTICE` so the original terms travel with the code
under either reading. Both are permissive, so the choice restricts nobody either
way.
