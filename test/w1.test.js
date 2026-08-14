'use strict'

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
const POWER_ON = '50 05 4b 46 7f ff 0c 10 1c : crc=1c YES\n' +
                 '50 05 4b 46 7f ff 0c 10 1c t=85000\n'
const NEGATIVE = 'ce fe 4b 46 7f ff 02 10 0c : crc=0c YES\n' +
                 'ce fe 4b 46 7f ff 02 10 0c t=-5062\n'

let root

function sensorDir (id, slave, resolution) {
  const dir = path.join(root, id)
  fs.mkdirSync(dir, { recursive: true })
  if (slave !== undefined) fs.writeFileSync(path.join(dir, 'w1_slave'), slave)
  if (resolution !== undefined) fs.writeFileSync(path.join(dir, 'resolution'), resolution)
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

  it('rejects the 85 C power-on value even though it passes CRC', function () {
    assert.throws(() => w1.parseW1Slave(POWER_ON, '28-abc'), /power-on value/)
  })

  it('rejects a file with no temperature in it', function () {
    assert.throws(() => w1.parseW1Slave('YES but nothing else\n', '28-abc'), /no temperature/)
  })

  it('resolves steps finer than the old 0.1 degree rounding', function () {
    const a = w1.parseW1Slave(REAL.replace('t=18687', 't=18687'), '28-abc')
    const b = w1.parseW1Slave(REAL.replace('t=18687', 't=18625'), '28-abc')
    assert.strictEqual(Number((a - b).toFixed(4)), 0.062)
  })
})

describe('applyCalibration', function () {
  it('adds the offset to the reading', function () {
    assert.strictEqual(w1.applyCalibration(18.5, 2), 20.5)
  })

  it('applies a negative offset', function () {
    assert.strictEqual(w1.applyCalibration(18.5, -0.5), 18)
  })

  it('accepts an offset that arrived from the config as a string', function () {
    assert.strictEqual(w1.applyCalibration(18.5, '2'), 20.5)
    assert.strictEqual(w1.applyCalibration(18.5, '-0.5'), 18)
  })

  it('leaves the reading alone when no offset is configured', function () {
    assert.strictEqual(w1.applyCalibration(18.5, undefined), 18.5)
    assert.strictEqual(w1.applyCalibration(18.5, null), 18.5)
    assert.strictEqual(w1.applyCalibration(18.5, ''), 18.5)
    assert.strictEqual(w1.applyCalibration(18.5, 0), 18.5)
  })

  it('never turns a reading into NaN, whatever the config holds', function () {
    for (const junk of ['abc', {}, [], NaN, Infinity, -Infinity, true]) {
      const result = w1.applyCalibration(18.5, junk)
      assert.ok(Number.isFinite(result), 'offset ' + JSON.stringify(junk) + ' gave ' + result)
      assert.strictEqual(result, 18.5)
    }
  })

  it('keeps sub-step resolution rather than rounding the correction away', function () {
    assert.strictEqual(w1.applyCalibration(18.687, 0.0625), 18.7495)
  })

  it('ignores a decimal comma instead of truncating it to zero', function () {
    // parseFloat('0,5') is 0, which would look like a configured no-op
    assert.strictEqual(w1.parseCalibration('0,5'), null)
    assert.strictEqual(w1.applyCalibration(18.5, '0,5'), 18.5)
  })

  it('ignores a partly numeric offset instead of truncating it', function () {
    for (const junk of ['2abc', '5%', '2 degrees', '0x10', '- 2', 'Infinity', '1e400']) {
      assert.strictEqual(w1.parseCalibration(junk), null, junk)
    }
  })
})

describe('parseCalibration', function () {
  it('separates an absent offset from an unusable one', function () {
    // absent is not a mistake, unusable is, and only one of them gets reported
    assert.strictEqual(w1.parseCalibration(undefined), 0)
    assert.strictEqual(w1.parseCalibration(null), 0)
    assert.strictEqual(w1.parseCalibration(''), 0)
    assert.strictEqual(w1.parseCalibration('   '), 0)
    assert.strictEqual(w1.parseCalibration('abc'), null)
    assert.strictEqual(w1.parseCalibration({}), null)
    assert.strictEqual(w1.parseCalibration(NaN), null)
  })

  it('accepts the numeric forms a config can hold', function () {
    assert.strictEqual(w1.parseCalibration(2), 2)
    assert.strictEqual(w1.parseCalibration(-0.4), -0.4)
    assert.strictEqual(w1.parseCalibration('2'), 2)
    assert.strictEqual(w1.parseCalibration(' -0.5 '), -0.5)
    assert.strictEqual(w1.parseCalibration('+1.5'), 1.5)
    assert.strictEqual(w1.parseCalibration('.5'), 0.5)
    assert.strictEqual(w1.parseCalibration('2.'), 2)
  })
})

describe('isTemperatureSensor', function () {
  it('accepts every temperature family', function () {
    for (const family of w1.SENSOR_FAMILIES) {
      assert.ok(w1.isTemperatureSensor(family + '-0121138f863c'), family)
    }
  })

  it('rejects bus masters and non-temperature families', function () {
    assert.ok(!w1.isTemperatureSensor('w1_bus_master1'))
    assert.ok(!w1.isTemperatureSensor('w1_bus_master2'))
    assert.ok(!w1.isTemperatureSensor('05-000000000000'))
    assert.ok(!w1.isTemperatureSensor('28-tooshort'))
  })
})

describe('listSensors', function () {
  it('finds sensors across every bus master and skips the masters themselves', function (done) {
    sensorDir('28-3c01e0764633', REAL)
    sensorDir('28-0121138f863c', REAL)
    sensorDir('10-00080283a977', REAL)
    fs.mkdirSync(path.join(root, 'w1_bus_master1'))
    fs.mkdirSync(path.join(root, 'w1_bus_master2'))

    w1.listSensors(root, function (err, ids) {
      assert.ifError(err)
      assert.deepStrictEqual(ids.sort(), [
        '10-00080283a977', '28-0121138f863c', '28-3c01e0764633'
      ])
      done()
    })
  })

  it('reports a missing bus root instead of throwing', function (done) {
    w1.listSensors(path.join(root, 'nope'), function (err, ids) {
      assert.ok(err)
      assert.strictEqual(ids, undefined)
      done()
    })
  })
})

describe('readTemperature', function () {
  it('reads a sensor from the bus', function (done) {
    sensorDir('28-3c01e0764633', REAL)
    w1.readTemperature(root, '28-3c01e0764633', function (err, value) {
      assert.ifError(err)
      assert.strictEqual(value, 18.687)
      done()
    })
  })

  it('passes a read error through instead of yielding a value', function (done) {
    w1.readTemperature(root, '28-missing', function (err, value) {
      assert.ok(err)
      assert.strictEqual(value, undefined)
      done()
    })
  })

  it('passes a CRC failure through as an error', function (done) {
    sensorDir('28-3c01e0764633', CRC_FAIL)
    w1.readTemperature(root, '28-3c01e0764633', function (err, value) {
      assert.ok(err)
      assert.strictEqual(value, undefined)
      done()
    })
  })
})

describe('readResolution', function () {
  it('reads the configured resolution', function (done) {
    sensorDir('28-3c01e0764633', REAL, '12\n')
    w1.readResolution(root, '28-3c01e0764633', function (err, bits) {
      assert.ifError(err)
      assert.strictEqual(bits, 12)
      done()
    })
  })

  it('treats a missing resolution file as unknown, not an error', function (done) {
    sensorDir('28-3c01e0764633', REAL)
    w1.readResolution(root, '28-3c01e0764633', function (err, bits) {
      assert.ifError(err)
      assert.strictEqual(bits, null)
      done()
    })
  })

  it('treats unparsable contents as unknown', function (done) {
    sensorDir('28-3c01e0764633', REAL, 'nonsense\n')
    w1.readResolution(root, '28-3c01e0764633', function (err, bits) {
      assert.ifError(err)
      assert.strictEqual(bits, null)
      done()
    })
  })
})
