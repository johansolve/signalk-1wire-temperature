'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const w1 = require('../lib/w1')

// Real output copied from a DS18B20 on a Raspberry Pi.
const REAL = '2b 01 55 05 7f a5 81 66 cf : crc=cf YES\n' +
             '2b 01 55 05 7f a5 81 66 cf t=18687\n'
const CRC_FAIL = '2b 01 55 05 7f a5 81 66 cf : crc=cf NO\n' +
                 '2b 01 55 05 7f a5 81 66 cf t=18687\n'
const NEGATIVE = 'ce fe 4b 46 7f ff 02 10 0c : crc=0c YES\n' +
                 'ce fe 4b 46 7f ff 02 10 0c t=-5062\n'
// A slave that never answers: CRC8 over nine zero bytes is zero, so the kernel
// marks this good and decodes it as 0 C.
const ALL_ZERO = '00 00 00 00 00 00 00 00 00 : crc=00 YES\n' +
                 '00 00 00 00 00 00 00 00 00 t=0\n'
const NO_TEMPERATURE = '2b 01 55 05 7f a5 81 66 cf : crc=cf YES\n' +
                       '2b 01 55 05 7f a5 81 66 cf\n'

let root

function sensorDir (id, slave) {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  if (slave !== undefined) fs.writeFileSync(path.join(dir, 'w1_slave'), slave)
}

beforeEach(function () {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'w1-test-'))
})

afterEach(function () {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('parseW1Slave', function () {
  it('keeps the full resolution the sensor reports', function () {
    // the old ds18b20 library rounded this to 18.7
    assert.strictEqual(w1.parseW1Slave(REAL, '28-abc'), 18.687)
  })

  it('reads negative temperatures', function () {
    assert.strictEqual(w1.parseW1Slave(NEGATIVE, '28-abc'), -5.062)
  })

  it('rejects a reading that failed its CRC', function () {
    assert.throws(() => w1.parseW1Slave(CRC_FAIL, '28-abc'), /CRC check failed/)
  })

  it('separates a missing CRC status from a failed one', function () {
    // both used to be reported as a CRC failure, which sent anyone debugging a
    // truncated file looking for a wiring fault
    assert.throws(() => w1.parseW1Slave('', '28-abc'), /no CRC status/)
  })

  it('rejects a scratchpad of nothing but zeroes', function () {
    // the CRC passes and it decodes as a believable 0 C, forever
    assert.throws(() => w1.parseW1Slave(ALL_ZERO, '28-abc'), /all-zero scratchpad/)
  })

  it('rejects the 85 C power-on value', function () {
    const powerOn = REAL.replace('t=18687', 't=85000')
    assert.throws(() => w1.parseW1Slave(powerOn, '28-abc'), /power-on value/)
  })

  it('accepts a genuine 85.0625 C, which is not the power-on value', function () {
    assert.strictEqual(w1.parseW1Slave(REAL.replace('t=18687', 't=85062'), '28-abc'), 85.062)
  })

  it('rejects a temperature the part cannot measure', function () {
    assert.throws(() => w1.parseW1Slave(REAL.replace('t=18687', 't=200000'), '28-abc'),
      /outside the specified range/)
    assert.throws(() => w1.parseW1Slave(REAL.replace('t=18687', 't=-60000'), '28-abc'),
      /outside the specified range/)
  })

  it('rejects a file with no temperature line', function () {
    assert.throws(() => w1.parseW1Slave(NO_TEMPERATURE, '28-abc'), /no temperature reported/)
  })

  it('rejects a temperature line with rubbish after the digits', function () {
    // parseInt would silently truncate this to a plausible reading
    assert.throws(() => w1.parseW1Slave(REAL.replace('t=18687', 't=18687x'), '28-abc'),
      /no temperature reported/)
  })

  it('names the sensor in every message it throws', function () {
    assert.throws(() => w1.parseW1Slave(CRC_FAIL, '28-000000000001'), /28-000000000001/)
  })
})

describe('sampleInterval', function () {
  it('falls back on the default for a rate that is missing or unusable', function () {
    // the server hands the plugin the raw config, so these really do arrive
    const fallback = w1.DEFAULT_RATE_SECONDS * 1000
    assert.strictEqual(w1.sampleInterval(undefined), fallback)
    assert.strictEqual(w1.sampleInterval(null), fallback)
    assert.strictEqual(w1.sampleInterval('10 sek'), fallback)
    assert.strictEqual(w1.sampleInterval(''), fallback)
    assert.strictEqual(w1.sampleInterval({}), fallback)
    assert.strictEqual(w1.sampleInterval(NaN), fallback)
    assert.strictEqual(w1.sampleInterval(0), fallback)
    assert.strictEqual(w1.sampleInterval(-5), fallback)
  })

  it('refuses a rate that would overflow the timer', function () {
    // over 2^31 ms Node runs the timeout immediately, once a millisecond
    assert.strictEqual(w1.sampleInterval(1e9), w1.DEFAULT_RATE_SECONDS * 1000)
    assert.strictEqual(w1.sampleInterval('1e400'), w1.DEFAULT_RATE_SECONDS * 1000)
  })

  it('takes a usable rate, as a number or as the string the form may save', function () {
    assert.strictEqual(w1.sampleInterval(30), 30000)
    assert.strictEqual(w1.sampleInterval('30'), 30000)
    assert.strictEqual(w1.sampleInterval(' 2.5 '), 2500)
  })
})

describe('parseCalibration', function () {
  it('treats an absent offset as no correction rather than as a mistake', function () {
    assert.strictEqual(w1.parseCalibration(undefined), 0)
    assert.strictEqual(w1.parseCalibration(null), 0)
    assert.strictEqual(w1.parseCalibration(''), 0)
  })

  it('takes a correction as a number or as a string', function () {
    assert.strictEqual(w1.parseCalibration(-0.4), -0.4)
    assert.strictEqual(w1.parseCalibration('2'), 2)
  })

  it('refuses a value that is not a number', function () {
    // '0,5' reads as 0 through parseFloat, which applies a correction nobody asked for
    assert.strictEqual(w1.parseCalibration('0,5'), null)
    assert.strictEqual(w1.parseCalibration('2abc'), null)
    assert.strictEqual(w1.parseCalibration({}), null)
  })

  it('refuses a correction that is a typo rather than a calibration', function () {
    assert.strictEqual(w1.parseCalibration(273.15), null)
    assert.strictEqual(w1.parseCalibration(50), 50)
  })
})

describe('applyCalibration', function () {
  it('shifts the reading without rounding it back to the sensor step', function () {
    assert.strictEqual(w1.applyCalibration(18.687, 0.5), 19.187)
  })

  it('leaves the reading alone when there is no usable correction', function () {
    assert.strictEqual(w1.applyCalibration(18.687, undefined), 18.687)
    assert.strictEqual(w1.applyCalibration(18.687, '0,5'), 18.687)
  })

  it('discards a reading the correction pushes out of range', function () {
    // the raw reading is range checked and the corrected one never was, so a
    // sensor at -55 with an offset of -50 published -105
    assert.strictEqual(w1.applyCalibration(-55, -50), null)
    assert.strictEqual(w1.applyCalibration(125, 10), null)
  })
})

describe('isTemperatureSensor', function () {
  it('accepts every family that reports a temperature', function () {
    w1.SENSOR_FAMILIES.forEach(function (family) {
      assert.ok(w1.isTemperatureSensor(family + '-000000000001'), family)
    })
  })

  it('rejects the bus master and anything else in the directory', function () {
    assert.ok(!w1.isTemperatureSensor('w1_bus_master1'))
    assert.ok(!w1.isTemperatureSensor('05-000000000001'))
    assert.ok(!w1.isTemperatureSensor('28-0001'))
    assert.ok(!w1.isTemperatureSensor('28-00000000000G'))
  })
})

describe('listSensors', function () {
  it('finds sensors on every bus master and ignores everything else', function (t, done) {
    sensorDir('28-000000000001', REAL)
    sensorDir('10-000000000002', REAL)
    fs.mkdirSync(path.join(root, 'w1_bus_master1'))
    fs.mkdirSync(path.join(root, 'w1_bus_master2'))
    w1.listSensors(root, function (err, ids) {
      assert.ifError(err)
      assert.deepStrictEqual(ids.sort(), ['10-000000000002', '28-000000000001'])
      done()
    })
  })

  it('reports a bus root that is not there', function (t, done) {
    w1.listSensors(path.join(root, 'nope'), function (err) {
      assert.ok(err)
      done()
    })
  })
})

describe('readTemperature', function () {
  it('reads a sensor off the bus', function (t, done) {
    sensorDir('28-000000000001', REAL)
    w1.readTemperature(root, '28-000000000001', function (err, value) {
      assert.ifError(err)
      assert.strictEqual(value, 18.687)
      done()
    })
  })

  it('reports a sensor whose file has gone', function (t, done) {
    w1.readTemperature(root, '28-000000000001', function (err) {
      assert.ok(err)
      done()
    })
  })

  it('reports a file it could read but not decode', function (t, done) {
    sensorDir('28-000000000001', CRC_FAIL)
    w1.readTemperature(root, '28-000000000001', function (err) {
      assert.match(err.message, /CRC check failed/)
      done()
    })
  })

  it('refuses an id that is not a sensor id rather than joining it into a path', function (t, done) {
    w1.readTemperature(root, '../../etc/passwd', function (err) {
      assert.match(err.message, /not a 1-wire sensor id/)
      done()
    })
  })
})
