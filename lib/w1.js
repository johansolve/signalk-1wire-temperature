/*
 * Copyright 2026 Johan Sölve
 *
 * Licensed under the Apache License, Version 2.0. See LICENSE.
 *
 * Access to the Linux 1-wire subsystem, plus the pure helpers that decode what
 * the bus returns and sanitise what the configuration supplies.
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

// The range the parts are specified over. Anything outside it is a decoding
// artefact rather than a temperature, and publishing it would be worse than
// publishing nothing.
const MIN_CELSIUS = -55
const MAX_CELSIUS = 125

const CRC_STATUS = /crc=[0-9a-f]{2}\s+(YES|NO)/
// The nine scratchpad bytes at the head of the first line.
const SCRATCHPAD = /^((?:[0-9a-f]{2} ){8}[0-9a-f]{2})/
const ALL_ZERO = /^(?:00 ){8}00$/
// Anchored to the end of its line, so trailing rubbish on the line is rejected
// rather than silently truncated to the digits that came first. Note that this
// cannot catch a file cut off mid-number at end of file: 't=186' sheared from
// 't=18687' still reads as a plausible 0.186 degrees.
const TEMPERATURE = /t=(-?\d+)\s*$/m

// A number written out in full, so a partly numeric string is rejected instead
// of quietly truncated. parseFloat on its own reads '0,5' as 0 and '2abc' as 2.
const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

// A correction larger than this is a typo, not a calibration. The parts are
// only specified over 180 degrees in total, and mounting error accounts for a
// few degrees, not fifty.
const MAX_CALIBRATION_DEGREES = 50

const MIN_RATE_SECONDS = 1
const DEFAULT_RATE_SECONDS = 10
// Node stores a timeout in a signed 32 bit integer of milliseconds. Anything
// larger overflows and is run as one millisecond, which is the very failure
// this clamp exists to prevent.
const MAX_RATE_SECONDS = 86400

function isTemperatureSensor (entry) {
  const match = SENSOR_ID.exec(entry)
  return match !== null && SENSOR_FAMILIES.indexOf(match[1]) !== -1
}

// Strictly numeric, or null. Shared by everything that has to make a number out
// of a configuration value that a human may have typed.
function parseNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || !NUMERIC.test(trimmed)) return null
  // '1e400' satisfies the pattern but overflows to Infinity
  const seconds = parseFloat(trimmed)
  return Number.isFinite(seconds) ? seconds : null
}

// Decode one w1_slave file. Returns the temperature in degrees Celsius,
// keeping the full resolution the sensor reported, or throws.
function parseW1Slave (data, id) {
  const crc = CRC_STATUS.exec(data)
  if (crc === null) {
    throw new Error('no CRC status from sensor ' + id)
  }
  if (crc[1] === 'NO') {
    throw new Error('CRC check failed for sensor ' + id)
  }

  // A slave that never answers leaves the scratchpad all zeroes, and CRC8 over
  // nine zero bytes is itself zero, so the kernel marks it YES and decodes a
  // perfectly plausible 0 C. Rejecting the value 0 instead would throw away
  // genuine readings at freezing, so the degenerate scratchpad is what is
  // caught here.
  const scratchpad = SCRATCHPAD.exec(data)
  if (scratchpad !== null && ALL_ZERO.test(scratchpad[1])) {
    throw new Error('sensor ' + id + ' returned an all-zero scratchpad')
  }

  const match = TEMPERATURE.exec(data)
  if (match === null) {
    throw new Error('no temperature reported by sensor ' + id)
  }
  const milli = parseInt(match[1], 10)
  if (milli === POWER_ON_MILLIDEGREES) {
    throw new Error('sensor ' + id + ' returned the 85 C power-on value')
  }
  const celsius = milli / 1000
  if (celsius < MIN_CELSIUS || celsius > MAX_CELSIUS) {
    throw new Error('sensor ' + id + ' reported ' + celsius +
      ' C, outside the specified range')
  }
  return celsius
}

// Read a configured calibration offset, which comes straight from the plugin
// config and can also be hand-edited. Returns the offset in degrees, or null
// when the config holds something that is not a number, so the caller can say so
// instead of ignoring it. An absent offset is not a mistake, it is zero.
function parseCalibration (offset) {
  if (offset === undefined || offset === null) return 0
  if (typeof offset === 'string' && offset.trim() === '') return 0
  const correction = parseNumber(offset)
  if (correction === null) return null
  // the readings themselves are range checked, so an unbounded correction was
  // the one way left to publish a nonsense temperature
  if (Math.abs(correction) > MAX_CALIBRATION_DEGREES) return null
  return correction
}

// Apply a per-sensor calibration offset to a reading in degrees Celsius.
// Returns null when the correction puts the reading outside the specified
// range, so the caller can discard it and say why: the reading is range checked
// before the offset is applied and never after, so a sensor at -55 with an
// offset of -50 published -105, which the README promises is discarded.
//
// An unusable offset must never turn the reading into NaN, so it falls back to
// no correction. Nothing is rounded: the correction is almost never a multiple
// of the sensor step, and rounding it back would throw away the resolution
// this plugin exists to keep.
function applyCalibration (celsius, offset) {
  const correction = parseCalibration(offset)
  if (correction === null) return celsius
  const corrected = celsius + correction
  if (corrected < MIN_CELSIUS || corrected > MAX_CELSIUS) return null
  return corrected
}

// The sample interval in milliseconds. The server hands plugins the raw
// configuration file without validating it against the schema or filling in its
// defaults, so 'minimum' and 'default' there bind the admin UI form and nothing
// else. An absent or unusable rate must not reach setInterval: it would arrive
// as NaN, which Node runs as one millisecond.
function sampleInterval (rate) {
  const seconds = parseNumber(rate)
  if (seconds === null || seconds < MIN_RATE_SECONDS || seconds > MAX_RATE_SECONDS) {
    return DEFAULT_RATE_SECONDS * 1000
  }
  return seconds * 1000
}

// Every temperature sensor on the bus, across all bus masters.
function listSensors (root, callback) {
  fs.readdir(root, function (err, entries) {
    if (err) return callback(err)
    callback(null, entries.filter(isTemperatureSensor))
  })
}

// The id is checked before it is interpolated into a path. Every caller passes
// an id that came off the bus, but this is where a configured string would
// reach the filesystem.
function readTemperature (root, id, callback) {
  if (!isTemperatureSensor(id)) {
    return process.nextTick(callback, new Error('not a 1-wire sensor id: ' + id))
  }
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

module.exports = {
  W1_DEVICES,
  SENSOR_FAMILIES,
  POWER_ON_MILLIDEGREES,
  MIN_CELSIUS,
  MAX_CELSIUS,
  DEFAULT_RATE_SECONDS,
  isTemperatureSensor,
  parseW1Slave,
  parseCalibration,
  applyCalibration,
  sampleInterval,
  listSensors,
  readTemperature
}
