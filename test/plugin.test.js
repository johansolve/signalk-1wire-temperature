'use strict'

// The plugin talks to the bus only through lib/w1, so the whole lifecycle can be
// exercised without hardware by replacing that module's functions.

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('assert')

const w1 = require('../lib/w1')
const createPlugin = require('../index')

const real = {
  listSensors: w1.listSensors,
  readTemperature: w1.readTemperature
}

function fakeApp () {
  const app = {
    selfId: 'urn:mrn:signalk:uuid:test',
    deltas: [],
    debugs: [],
    errors: [],
    statuses: [],
    pluginErrors: [],
    saved: [],
    saveError: null
  }
  app.handleMessage = (id, delta) => app.deltas.push({ id, delta })
  app.debug = (msg) => app.debugs.push(msg)
  app.error = (msg) => app.errors.push(msg)
  app.setPluginStatus = (msg) => app.statuses.push(msg)
  app.setPluginError = (msg) => app.pluginErrors.push(msg)
  app.savePluginOptions = function (options, cb) {
    app.saved.push(JSON.parse(JSON.stringify(options)))
    if (cb) process.nextTick(cb, app.saveError)
  }
  return app
}

// Deltas carrying values, ignoring the meta-only update.
const values = (app) => app.deltas
  .filter(d => d.delta.updates[0].values)
  .map(d => d.delta.updates[0].values[0])
const metas = (app) => {
  const found = app.deltas.filter(d => d.delta.updates[0].meta)
  return found.length ? found[0].delta.updates[0].meta : null
}
const status = (app) => app.statuses[app.statuses.length - 1]

const dev = (id, extra) => Object.assign({ oneWireId: id }, extra)
const opts = (devices, rate) => ({ rate: rate === undefined ? 10 : rate, devices })

// Let the plugin's chain of nextTick callbacks run out, without advancing any
// clock. setImmediate fires after the whole nextTick queue.
const drain = () => new Promise(resolve => setImmediate(resolve))

function start (app, options) {
  plugin = createPlugin(app)
  plugin.start(options)
  return drain()
}

// Timers and the monotonic clock under the test's control. Frozen rather than
// offset: adding real elapsed time leaves a boundary test racing the scheduler.
function fakeClock (t) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const realNow = performance.now.bind(performance)
  let virtual = realNow()
  performance.now = () => virtual
  t.after(() => { performance.now = realNow })
  return async function advance (ms) {
    virtual += ms
    t.mock.timers.tick(ms)
    await drain()
  }
}

// A leaked interval has no symptom other than a process that will not exit, so
// it has to be counted rather than observed.
const liveTimers = () =>
  process.getActiveResourcesInfo().filter(r => r === 'Timeout').length

const ID = '28-000000000001'
const ID2 = '28-000000000002'
const ID3 = '28-000000000003'

let plugin

beforeEach(function () {
  w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID])
  w1.readTemperature = (root, id, cb) => process.nextTick(cb, null, 20)
})

afterEach(function () {
  if (plugin) plugin.stop()
  plugin = null
  Object.assign(w1, real)
})

describe('plugin contract', function () {
  it('exposes what the server requires, under the id configurations depend on', function () {
    // changing the id renames $source and orphans priorities.json entries
    plugin = createPlugin(fakeApp())
    assert.strictEqual(plugin.id, 'raspberry-pi-1wire')
    assert.strictEqual(typeof plugin.name, 'string')
    assert.strictEqual(typeof plugin.start, 'function')
    assert.strictEqual(typeof plugin.schema, 'object')
    assert.doesNotThrow(() => plugin.stop(), 'stopping one never started')
    // the plugin finds sensors itself, so a prefilled row can only name one
    // that does not exist
    const item = plugin.schema.properties.devices.items.properties
    assert.strictEqual(item.oneWireId.default, undefined)
    assert.strictEqual(item.locationName.default, undefined)
  })
})

describe('publishing', function () {
  it('publishes a well formed delta in kelvin on the configured path', async function () {
    const app = fakeApp()
    await start(app, opts([dev(ID, { path: 'electrical.alternators.0.temperature' })]))
    assert.deepStrictEqual(values(app)[0], {
      path: 'electrical.alternators.0.temperature',
      value: 293.15
    })
    const delta = app.deltas.find(d => d.delta.updates[0].values).delta
    assert.strictEqual(delta.context, 'vessels.' + app.selfId)
    assert.strictEqual(delta.updates[0].source.label, plugin.id)
    assert.ok(!isNaN(Date.parse(delta.updates[0].timestamp)))
  })

  it('builds the path from the deprecated key, trimmed, when no path is set', async function () {
    const app = fakeApp()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2, ID3])
    await start(app, opts([
      dev(ID, { key: ' inside.engineroom.temperature ' }),
      dev(ID2, { path: ' a.b ' }),
      // a path that is not a string falls through to the key
      dev(ID3, { path: 42, key: 'c.d' })
    ]))
    assert.deepStrictEqual(values(app).map(v => v.path),
      ['environment.inside.engineroom.temperature', 'a.b', 'environment.c.d'])
  })

  it('publishes nothing for a sensor with neither path nor key, and reads on', async function () {
    const app = fakeApp()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    await start(app, opts([dev(ID), dev(ID2, { path: 'c.d' })]))
    assert.deepStrictEqual(values(app).map(v => v.path), ['c.d'])
    assert.strictEqual(metas(app).length, 1, 'no hole in the meta list either')
  })

  it('applies the calibration offset, and discards what it pushes out of range', async function () {
    const app = fakeApp()
    await start(app, opts([dev(ID, { path: 'a.b', offset: 1.5 })]))
    assert.strictEqual(values(app)[0].value, 294.65)

    plugin.stop()
    // the raw reading is range checked and the corrected one never was, so this
    // reached the data model as a negative temperature in kelvin
    const cold = fakeApp()
    w1.readTemperature = (root, id, cb) => process.nextTick(cb, null, -55)
    await start(cold, opts([dev(ID, { path: 'a.b', offset: -50 })]))
    assert.strictEqual(values(cold).length, 0)
    assert.ok(cold.debugs.some(m => /outside anything the sensor can measure/.test(m)))
  })

  it('never publishes a failed read as a value', async function () {
    const app = fakeApp()
    w1.readTemperature = (root, id, cb) => process.nextTick(cb, new Error('CRC check failed'))
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    assert.strictEqual(values(app).length, 0)
  })
})

describe('metadata', function () {
  it('publishes units, and displayName only once the sensor has a name of its own', async function () {
    const app = fakeApp()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    await start(app, opts([
      dev(ID, { path: 'a.b', locationName: 'Alternator' }),
      dev(ID2, { path: 'c.d', locationName: 'Sensor ' + ID2 })
    ]))
    assert.deepStrictEqual(metas(app), [
      { path: 'a.b', value: { units: 'K', displayName: 'Alternator' } },
      { path: 'c.d', value: { units: 'K' } }
    ])
  })

  it('prefers setDefaultMetadata, so a label the user set is left alone', async function () {
    // meta as a delta is last-writer-wins and overwrote it on every start
    const app = fakeApp()
    const written = []
    app.setDefaultMetadata = (path, value) => {
      written.push({ path, value })
      return Promise.resolve()
    }
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    await drain()
    assert.deepStrictEqual(written, [{ path: 'a.b', value: { units: 'K' } }])
    assert.strictEqual(metas(app), null, 'no delta when the server has the api')
  })

  it('offers every sensor its metadata even when one path is refused', async function () {
    // a rejection walks past every later link of a chain built from bare .then,
    // so one refused path took the units off every sensor behind it
    const app = fakeApp()
    const offered = []
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2, ID3])
    app.setDefaultMetadata = function (path) {
      offered.push(path)
      return path === 'a.b' ? Promise.reject(new Error('EROFS')) : Promise.resolve()
    }
    await start(app, opts([
      dev(ID, { path: 'a.b' }), dev(ID2, { path: 'c.d' }), dev(ID3, { path: 'e.f' })
    ]))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepStrictEqual(offered, ['a.b', 'c.d', 'e.f'])
    assert.ok(app.errors.some(m => /could not set meta for a\.b: EROFS/.test(m)))
  })

  it('never has two writes in flight, however long one takes', async function (t) {
    // each call ends in a write of the server's base deltas through a fixed
    // temporary path, so two at once rename that file out from under each other
    const advance = fakeClock(t)
    const app = fakeApp()
    let running = 0
    let peak = 0
    app.setDefaultMetadata = () => {
      peak = Math.max(peak, ++running)
      return new Promise(function () {})
    }
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    await advance(40000)
    // a config save is a stop followed by a start, so overlapping runs are
    // ordinary
    plugin.stop()
    plugin.start(opts([dev(ID, { path: 'a.b' })]))
    await drain()
    await advance(40000)
    assert.strictEqual(peak, 1, 'two writes against the same temporary file')
  })

  it('does not write metadata for a configuration that has been replaced', async function () {
    const app = fakeApp()
    const written = []
    let release
    const held = new Promise(resolve => { release = resolve })
    let first = true
    app.setDefaultMetadata = function (path) {
      written.push(path)
      if (first) { first = false; return held }
      return Promise.resolve()
    }
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    await start(app, opts([dev(ID, { path: 'old.1' }), dev(ID2, { path: 'old.2' })]))
    plugin.stop()
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepStrictEqual(written, ['old.1'],
      'a superseded run wrote the configuration it was started with')
  })

  it('still starts sampling when publishing meta throws', async function () {
    const app = fakeApp()
    let thrown = false
    app.handleMessage = function (id, delta) {
      if (delta.updates[0].meta && !thrown) {
        thrown = true
        throw new Error('subscriber blew up')
      }
      app.deltas.push({ id, delta })
    }
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    assert.strictEqual(values(app).length, 1, 'meta took the sample timer with it')
  })
})

describe('the sample rate', function () {
  it('runs at the default when the rate is missing entirely', async function () {
    // the server passes the raw config, so an empty object really does arrive
    const app = fakeApp()
    plugin = createPlugin(app)
    plugin.start({})
    await drain()
    // at the 10 s default this is exactly one reading; unclamped it was hundreds
    assert.strictEqual(values(app).length, 1)
    assert.ok(!app.errors.some(m => /falling back/.test(m)),
      'a rate that was never configured is not a problem to report')
  })

  it('falls back audibly on a rate it cannot use', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    await start(app, opts([], '10 sek'))
    assert.strictEqual(values(app).length, 1, 'the startup cycle')
    await advance(9999)
    assert.strictEqual(values(app).length, 1, 'a cycle fell due early')
    await advance(1)
    assert.strictEqual(values(app).length, 2)
    // a silently replaced rate looks like the setting was honoured
    assert.ok(app.errors.some(m => /is not usable, falling back/.test(m)))
    assert.match(status(app), /1 configuration problem/)
  })
})

describe('the status line', function () {
  it('counts the sensors, singular and plural, and carries the last reading', async function () {
    const app = fakeApp()
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    assert.match(status(app), /^1 sensor, last read \d\d:\d\d:\d\d/)

    plugin.stop()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    plugin.start(opts([dev(ID, { path: 'a.b' }), dev(ID2, { path: 'c.d' })]))
    await drain()
    assert.match(status(app), /^2 sensors,/)
  })

  it('carries configuration problems, counts them, and forgets the ones fixed', async function () {
    // the server log is not read until someone is already looking for a fault
    const app = fakeApp()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    await start(app, opts([dev(ID), dev(ID2, { offset: 'två' })]))
    assert.match(status(app), /2 configuration problems in the server log/)

    plugin.stop()
    plugin.start(opts([dev(ID, { path: 'a.b' }), dev(ID2, { path: 'c.d' })]))
    await drain()
    assert.ok(!/configuration problem/.test(status(app)), status(app))
  })

  it('keeps the sensor count in front of everything else it says', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    w1.readTemperature = (root, id, cb) => process.nextTick(cb, new Error('ENOENT'))
    await start(app, opts([dev(ID, { path: 'a.b', offset: '0,5' })]))
    await advance(10000)
    await advance(10000)
    assert.match(status(app), /^1 sensor, not responding: .*, 1 configuration problem/)
  })
})

describe('sensors that stop answering', function () {
  it('escalates from debug to an error on the third failure, once', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    w1.readTemperature = (root, id, cb) => process.nextTick(cb, new Error('ENOENT'))
    await start(app, opts([dev(ID, { path: 'a.b', locationName: 'Seawater' })]))
    assert.deepStrictEqual(app.errors, [], 'one failure is ordinary')
    await advance(10000)
    assert.deepStrictEqual(app.errors, [], 'two failures is still ordinary')

    await advance(10000)
    assert.strictEqual(app.errors.length, 1)
    assert.match(app.errors[0], /has failed 3 reads in a row/)
    assert.match(status(app), /not responding: Seawater/, 'named as the user named it')

    await advance(10000)
    await advance(10000)
    assert.strictEqual(app.errors.length, 1, 'escalated again on every later read')
  })

  it('falls back on the bus id when the sensor was never named', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    w1.readTemperature = (root, id, cb) => process.nextTick(cb, new Error('ENOENT'))
    await start(app, opts([dev(ID, { path: 'a.b', locationName: 'Sensor ' + ID })]))
    await advance(10000)
    await advance(10000)
    assert.match(status(app), new RegExp('not responding: ' + ID))
  })

  it('starts counting from zero again once the sensor answers', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    let fail = true
    w1.readTemperature = (root, id, cb) => fail
      ? process.nextTick(cb, new Error('ENOENT'))
      : process.nextTick(cb, null, 20)
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    await advance(10000)
    fail = false
    await advance(10000)
    fail = true
    await advance(10000)
    await advance(10000)
    assert.deepStrictEqual(app.errors, [], 'a good read did not break the run')
  })

  it('logs a failure that is not an Error rather than throwing from the handler', async function () {
    // reading .message off undefined throws from inside the handler meant to
    // contain the failure, and an unhandled rejection ends the process
    const app = fakeApp()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    w1.readTemperature = (root, id, cb) => id === ID
      ? process.nextTick(cb, 'just a string')
      : process.nextTick(cb, null, 20)
    await start(app, opts([dev(ID, { path: 'a.b' }), dev(ID2, { path: 'c.d' })]))
    assert.ok(app.debugs.some(m => /just a string/.test(m)))
    assert.deepStrictEqual(values(app).map(v => v.path), ['c.d'],
      'the chain stopped at the sensor that failed oddly')
  })

  it('keeps publishing after a delta subscriber throws', async function () {
    const app = fakeApp()
    let thrown = false
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    app.handleMessage = function (id, delta) {
      if (delta.updates[0].values && !thrown) {
        thrown = true
        throw new Error('subscriber blew up')
      }
      app.deltas.push({ id, delta })
    }
    await start(app, opts([dev(ID, { path: 'a.b' }), dev(ID2, { path: 'c.d' })]))
    assert.deepStrictEqual(values(app).map(v => v.path), ['c.d'])
    assert.ok(app.errors.some(m => /could not publish a\.b/.test(m)))
  })
})

describe('serialised reads', function () {
  it('reads one sensor at a time rather than pinning the thread pool', async function () {
    // starting them together finishes no sooner, because the driver serialises
    // the bus anyway, but it pins the whole pool and stalls io for every other
    // plugin in the process
    const app = fakeApp()
    const ids = [ID, ID2, ID3]
    let running = 0
    let peak = 0
    w1.listSensors = (root, cb) => process.nextTick(cb, null, ids)
    w1.readTemperature = function (root, id, cb) {
      peak = Math.max(peak, ++running)
      setTimeout(() => { running--; cb(null, 20) }, 5)
    }
    await start(app, opts(ids.map(id => dev(id, { path: 'a.' + id }))))
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.strictEqual(values(app).length, 3, 'not every sensor was read')
    assert.strictEqual(peak, 1, 'reads overlapped, peak concurrency ' + peak)
  })

  it('skips a cycle that falls due while the previous one is still walking', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    const pending = []
    w1.readTemperature = (root, id, cb) => pending.push(cb)
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    await advance(10000)
    assert.strictEqual(pending.length, 1, 'a second cycle started over a serial bus')
    assert.ok(app.debugs.some(m => /skipping this one/.test(m)))
  })

  it('hands the bus back to the sensors behind a slow one once it answers', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    const ids = [ID, ID2]
    const pending = []
    w1.listSensors = (root, cb) => process.nextTick(cb, null, ids)
    w1.readTemperature = (root, id, cb) => pending.push({ id, cb })
    await start(app, opts(ids.map(id => dev(id, { path: 'a.' + id }))))
    await advance(30000)
    assert.strictEqual(pending.length, 1)
    pending.shift().cb(null, 20)
    await drain()
    assert.strictEqual(pending[0].id, ID2, 'the second sensor was never reached')
  })
})

describe('a read that never comes back', function () {
  it('is written off after the allowance, once, and names the sensor', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    w1.readTemperature = () => {}
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    await advance(50000)
    assert.deepStrictEqual(app.errors, [], 'written off before the allowance was up')

    await advance(20000)
    for (let i = 0; i < 4; i++) await advance(10000)
    const abandons = app.errors.filter(m => /abandoning that cycle/.test(m))
    assert.strictEqual(abandons.length, 1, 'wrote it off ' + abandons.length + ' times')
    assert.match(abandons[0], new RegExp(ID))
    // it records no failure of its own, so it would never reach the threshold
    assert.match(status(app), /not responding/)
  })

  it('is still named in the status after a config save', async function (t) {
    // the outstanding read outlives the run that started it while the failure
    // counters do not, so a save was all it took to report a bus with that
    // sensor permanently excluded as perfectly healthy
    const advance = fakeClock(t)
    const app = fakeApp()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    w1.readTemperature = (root, id, cb) => {
      if (id !== ID) process.nextTick(cb, null, 20)
    }
    const options = opts([
      dev(ID, { path: 'a.b', locationName: 'Seawater' }), dev(ID2, { path: 'c.d' })
    ])
    await start(app, options)
    await advance(70000)
    assert.match(status(app), /not responding: Seawater/, 'precondition')

    plugin.stop()
    plugin.start(options)
    await drain()
    assert.match(status(app), /not responding: Seawater/)
  })

  it('does not call a read that is merely in progress a sensor that stopped', async function (t) {
    // a config save landing in the middle of an ordinary read is not evidence
    // of anything
    const advance = fakeClock(t)
    const app = fakeApp()
    w1.readTemperature = () => {}
    const options = opts([dev(ID, { path: 'a.b' })])
    await start(app, options)
    await advance(20000)
    plugin.stop()
    plugin.start(options)
    await drain()
    assert.ok(!/not responding/.test(status(app)), status(app))
  })

  it('does not let the abandoned chain keep walking the sensor list', async function (t) {
    // the watchdog frees the slot, but two chains over a serial bus publish
    // stale values
    const advance = fakeClock(t)
    const app = fakeApp()
    const ids = [ID, ID2, ID3]
    const pending = []
    let started = 0
    w1.listSensors = (root, cb) => process.nextTick(cb, null, ids)
    w1.readTemperature = (root, id, cb) => { started++; pending.push(cb) }
    await start(app, opts(ids.map(id => dev(id, { path: 'a.' + id }))))
    assert.strictEqual(started, 1, 'the first read is outstanding')

    await advance(70000)
    const beforeRelease = started
    pending.shift()(null, 20)
    await drain()
    assert.strictEqual(started, beforeRelease,
      'abandoned chain kept reading, ' + beforeRelease + ' -> ' + started)
    assert.strictEqual(values(app).length, 0,
      'abandoned chain published a value 70 s after it was read')
  })

  it('costs one blocked thread and not one per sensor', async function (t) {
    // The driver holds the bus master's lock for the whole conversion, so a
    // read that never returns is still holding it. Every sensor behind it
    // would block on that same lock and pin a thread of its own, and four is
    // Node's whole default pool: file and network io then stops for every
    // other plugin in the server. A restart cannot hand any of them back.
    const advance = fakeClock(t)
    const app = fakeApp()
    const ids = [ID, ID2, ID3]
    let reads = 0
    w1.listSensors = (root, cb) => process.nextTick(cb, null, ids)
    w1.readTemperature = function (root, id, cb) { reads++ }
    const options = opts(ids.map(id => dev(id, { path: 'a.' + id })))
    await start(app, options)
    await advance(70000)
    for (let i = 0; i < 3; i++) {
      plugin.stop()
      plugin.start(options)
      await drain()
      await advance(10000)
    }

    assert.strictEqual(reads, 1, 'blocked reads grew to ' + reads)
    assert.deepStrictEqual(values(app), [])
  })

  it('keeps reading the healthy sensors when one of them is unplugged',
    async function (t) {
      // The ordinary failure, and a different one: an unplugged sensor answers
      // straight away with an error and holds no lock, so it says nothing at
      // all about the others and they must carry on being read.
      const advance = fakeClock(t)
      const app = fakeApp()
      const ids = [ID, ID2, ID3]
      w1.listSensors = (root, cb) => process.nextTick(cb, null, ids)
      w1.readTemperature = function (root, id, cb) {
        if (id === ID) return process.nextTick(cb, new Error('ENOENT'))
        process.nextTick(cb, null, 20)
      }
      await start(app, opts(ids.map(id => dev(id, { path: 'a.' + id }))))
      for (let i = 0; i < 3; i++) await advance(10000)

      const counts = {}
      for (const v of values(app)) counts[v.path] = (counts[v.path] || 0) + 1
      assert.strictEqual(counts['a.' + ID], undefined, 'the dead sensor published')
      assert.ok(counts['a.' + ID2] >= 2, JSON.stringify(counts))
      assert.ok(counts['a.' + ID3] >= 2, JSON.stringify(counts))
    })
})

describe('configuration hygiene', function () {
  it('registers a sensor it finds on the bus and saves it, once', async function () {
    const app = fakeApp()
    await start(app, opts([]))
    assert.strictEqual(app.saved.length, 1)
    assert.deepStrictEqual(app.saved[0].devices, [{
      oneWireId: ID,
      locationName: 'Sensor ' + ID,
      key: 'inside.' + ID + '.temperature',
      offset: 0
    }])

    plugin.stop()
    const clean = fakeApp()
    await start(clean, opts([dev(ID, { path: 'a.b' })]))
    assert.deepStrictEqual(clean.saved, [], 'rewrote a config that needed nothing')
  })

  it('says so when the configuration could not be saved', async function () {
    // otherwise the discovered sensors are rediscovered on every start and any
    // edit made in the meantime is lost
    const app = fakeApp()
    app.saveError = new Error('EROFS')
    await start(app, opts([]))
    assert.ok(app.errors.some(m => /could not save the discovered sensors: EROFS/.test(m)))
  })

  it('matches a hand-typed sensor id regardless of case or stray spaces', async function () {
    // matched loosely, such an entry loses its path and is written back as a
    // duplicate, and the bus answers to nothing but its own spelling
    const app = fakeApp()
    const asked = []
    w1.readTemperature = (root, id, cb) => { asked.push(id); process.nextTick(cb, null, 20) }
    const options = opts([dev(' 28-000000000001 '.toUpperCase(), { path: 'a.b', offset: 1 })])
    await start(app, options)
    assert.strictEqual(options.devices.length, 1, 'the sensor was registered twice')
    assert.deepStrictEqual(asked, [ID], 'the bus spelling has to win')
    assert.strictEqual(values(app)[0].value, 294.15, 'the calibration was lost')
  })

  it('survives a devices setting that is not a list, without saving over it', async function () {
    // saving over a config we could not read destroys what the user was writing
    const app = fakeApp()
    await start(app, { rate: 10, devices: 'nope' })
    assert.match(status(app), /configuration problem/)
    assert.deepStrictEqual(app.saved, [])
  })

  it('tolerates a null entry and one with no sensor id', async function () {
    const app = fakeApp()
    await start(app, opts([null, {}, dev(ID, { path: 'a.b' })]))
    assert.strictEqual(values(app).length, 1)
    assert.ok(!app.errors.some(m => /more than once/.test(m)), app.errors.join(' | '))
  })

  it('names configured sensors that are not on the bus', async function () {
    // an upgrade from the original plugin carries a dozen of these, left behind
    // by a library that enumerated bus errors as if they were sensors
    const app = fakeApp()
    await start(app, opts([
      dev(ID, { path: 'a.b' }), dev(ID2, { path: 'c.d' }), dev(ID3, { path: 'e.f' })
    ]))
    const named = app.errors.find(m => /not on the bus/.test(m))
    assert.ok(named, app.errors.join(' | '))
    assert.match(named, new RegExp(ID2 + ', ' + ID3))
  })

  it('calls out a sensor configured twice and two sensors on one path', async function () {
    const app = fakeApp()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    await start(app, opts([
      dev(ID, { path: 'a.b' }), dev(ID.toUpperCase(), { path: 'a.b' }), dev(ID2, { path: 'a.b' })
    ]))
    assert.ok(app.errors.some(m => /configured more than once/.test(m)), app.errors.join(' | '))
    assert.ok(app.errors.some(m => /more than one sensor publishes to a\.b/.test(m)))

    plugin.stop()
    const clean = fakeApp()
    await start(clean, opts([dev(ID), dev(ID2)]))
    assert.ok(!clean.errors.some(m => /publishes to/.test(m)),
      'two pathless sensors are not a path collision')
  })

  it('reports a calibration offset that is not a usable correction', async function () {
    // the sensor looks calibrated and is not, which is worse than no offset
    const app = fakeApp()
    await start(app, opts([dev(ID, { path: 'a.b', offset: '0,5' })]))
    assert.ok(app.errors.some(m => /not a usable correction/.test(m)), app.errors.join(' | '))
    assert.strictEqual(values(app)[0].value, 293.15, 'an unusable offset corrupted the reading')
  })
})

describe('starting, stopping and retrying', function () {
  it('retries an unreadable bus instead of staying dead until restarted', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    let attempts = 0
    w1.listSensors = (root, cb) => ++attempts === 1
      ? process.nextTick(cb, new Error('ENOENT'))
      : process.nextTick(cb, null, [ID])
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    assert.ok(app.pluginErrors.some(m => /cannot read/.test(m)))

    await advance(20000)
    assert.strictEqual(values(app).length, 0,
      'started a sample interval alongside the retry')
    await advance(9999)
    assert.strictEqual(attempts, 1, 'retried before the interval was up')
    await advance(1)
    assert.strictEqual(values(app).length, 1)
  })

  it('retries an empty bus, which at boot is not proof that nothing is attached', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    let attempts = 0
    w1.listSensors = (root, cb) =>
      process.nextTick(cb, null, ++attempts === 1 ? [] : [ID])
    await start(app, opts([]))
    assert.ok(app.pluginErrors.some(m => /no 1-wire temperature sensors/.test(m)))
    await advance(30000)
    assert.strictEqual(values(app).length, 1)
  })

  it('publishes nothing from a run that has been stopped', async function () {
    const app = fakeApp()
    let held
    w1.readTemperature = (root, id, cb) => { held = cb }
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    plugin.stop()
    held(null, 20)
    await drain()
    assert.strictEqual(values(app).length, 0)
  })

  it('ignores an enumeration that returns after the plugin was stopped', async function () {
    const app = fakeApp()
    let held
    w1.listSensors = (root, cb) => { held = cb }
    plugin = createPlugin(app)
    plugin.start(opts([]))
    plugin.stop()
    held(null, [ID])
    await drain()
    assert.strictEqual(values(app).length, 0)
    assert.deepStrictEqual(app.saved, [])
  })

  it('stops reading when a subscriber stops the plugin from inside a delta', async function () {
    const app = fakeApp()
    w1.listSensors = (root, cb) => process.nextTick(cb, null, [ID, ID2])
    app.handleMessage = function (id, delta) {
      app.deltas.push({ id, delta })
      if (delta.updates[0].values) plugin.stop()
    }
    await start(app, opts([dev(ID, { path: 'a.b' }), dev(ID2, { path: 'c.d' })]))
    assert.strictEqual(values(app).length, 1)
  })

  it('leaves no interval behind when a synchronous read lets a subscriber stop it', async function () {
    // fs.readFile is asynchronous, but lib/w1 is the seam this is written
    // against and nothing in that contract promises the callback is. Reached
    // synchronously, the subscriber stops the plugin from inside the first
    // cycle and the interval is created after stopTimer has already run.
    const app = fakeApp()
    const before = liveTimers()
    w1.listSensors = (root, cb) => cb(null, [ID])
    w1.readTemperature = (root, id, cb) => cb(null, 20)
    let stopped = false
    app.handleMessage = function (id, delta) {
      app.deltas.push({ id, delta })
      if (delta.updates[0].values && !stopped) {
        stopped = true
        plugin.stop()
      }
    }
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    assert.strictEqual(liveTimers(), before, 'an interval nobody will ever clear')
  })

  it('leaves no timer behind, whether stopped or started twice over', async function () {
    const app = fakeApp()
    const before = liveTimers()
    await start(app, opts([dev(ID, { path: 'a.b' })]))
    plugin.start(opts([dev(ID, { path: 'a.b' })]))
    await drain()
    assert.match(status(app), /^1 sensor,/, 'the sensor list doubled')
    plugin.stop()
    assert.strictEqual(liveTimers(), before)
  })

  it('clears the failure counters on restart', async function (t) {
    const advance = fakeClock(t)
    const app = fakeApp()
    let fail = true
    w1.readTemperature = (root, id, cb) => fail
      ? process.nextTick(cb, new Error('ENOENT'))
      : process.nextTick(cb, null, 20)
    const options = opts([dev(ID, { path: 'a.b' })])
    await start(app, options)
    await advance(10000)
    await advance(10000)
    assert.match(status(app), /not responding/)

    plugin.stop()
    fail = false
    plugin.start(options)
    await drain()
    assert.ok(!/not responding/.test(status(app)), status(app))
  })
})
