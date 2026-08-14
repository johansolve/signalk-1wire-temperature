/*
 * Access to the Linux 1-wire subsystem.
 *
 * Every slave shows up as its own directory under the bus root, named
 * <family>-<serial>, holding the raw scratchpad and a decoded temperature.
 * The bus root is a parameter rather than a constant so the tests can point
 * these functions at a fixture directory.
 */

const fs = require('fs')
const path = require('path')

const W1_DEVICES = '/sys/bus/w1/devices'

// Families that report a temperature: DS18S20, DS1822, DS18B20, DS1825, DS28EA00.
const SENSOR_FAMILIES = ['10', '22', '28', '3b', '42']
const SENSOR_ID = /^([0-9a-f]{2})-[0-9a-f]{12}$/

// What a DS18B20 holds after a power-on reset when no conversion has run. It
// passes CRC, so it has to be rejected by value or a stuck sensor reads as a
// plausible 85 degrees forever.
const POWER_ON_MILLIDEGREES = 85000

function isTemperatureSensor (entry) {
  const match = SENSOR_ID.exec(entry)
  return match !== null && SENSOR_FAMILIES.indexOf(match[1]) !== -1
}

// Decode one w1_slave file. Returns the temperature in degrees Celsius,
// keeping the full resolution the sensor reported, or throws.
function parseW1Slave (data, id) {
  if (data.indexOf('YES') === -1) {
    throw new Error('CRC check failed for sensor ' + id)
  }
  const match = /t=(-?\d+)/.exec(data)
  if (match === null) {
    throw new Error('no temperature reported by sensor ' + id)
  }
  const milli = parseInt(match[1], 10)
  if (milli === POWER_ON_MILLIDEGREES) {
    throw new Error('sensor ' + id + ' returned the 85 C power-on value')
  }
  return milli / 1000
}

// Every temperature sensor on the bus, across all bus masters.
function listSensors (root, callback) {
  fs.readdir(root, function (err, entries) {
    if (err) return callback(err)
    callback(null, entries.filter(isTemperatureSensor))
  })
}

function readTemperature (root, id, callback) {
  fs.readFile(path.join(root, id, 'w1_slave'), 'utf8', function (err, data) {
    if (err) return callback(err)
    let value
    try {
      value = parseW1Slave(data, id)
    } catch (e) {
      return callback(e)
    }
    callback(null, value)
  })
}

// Older kernels have no resolution attribute, so a missing file is not an error.
function readResolution (root, id, callback) {
  fs.readFile(path.join(root, id, 'resolution'), 'utf8', function (err, data) {
    if (err) return callback(null, null)
    const bits = parseInt(data, 10)
    callback(null, isNaN(bits) ? null : bits)
  })
}

module.exports = {
  W1_DEVICES,
  SENSOR_FAMILIES,
  POWER_ON_MILLIDEGREES,
  isTemperatureSensor,
  parseW1Slave,
  listSensors,
  readTemperature,
  readResolution
}
