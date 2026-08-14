/*
 * Copyright 2019 Ewald van Gemert <vangee@gmail.com>
 * Copyright 2026 Johan Sölve
 *
 * This file has been modified from the original. In this fork the sensors are
 * read from /sys/bus/w1 directly instead of through the ds18b20 library, each
 * sensor can be given a full Signal K path and a calibration offset, readings
 * are taken one at a time, and meta is published with units and displayName.
 * See CHANGELOG.md for the full list.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const w1 = require('./lib/w1')

const W1_DEVICES = w1.W1_DEVICES
const RETRY_INTERVAL = 30000
// One failed read is ordinary, a run of them is a loose wire.
const FAILURE_THRESHOLD = 3
// A 12 bit conversion takes 750 ms, so a read still outstanding after this is
// never coming back.
const READ_TIMEOUT = 60000

// Elapsed time from a clock that only moves forward. A Pi without a
// battery-backed clock boots in 1970 and jumps years ahead the moment chronyd
// answers, which on the wall clock looks like a read that has been outstanding
// for decades.
function now () {
  return performance.now()
}

module.exports = function (app) {
  let _deviceList = []
  let _timer = null
  let _generation = 0
  // the measurement cycle that currently holds the bus, as a token rather than
  // a boolean: a straggler from an earlier cycle must not be able to release a
  // slot it no longer owns
  let _cycle = null
  // Sensors with a read still in flight, by bus id, holding the time the read
  // was issued. A read that never returns holds a thread pool thread for good,
  // and the pool is four threads by default, so the sensor is skipped rather
  // than asked again. It survives a restart, which cannot hand that thread back
  // either, and clears itself if the read does eventually return. The time is
  // what tells a read that is merely in progress from one that is never coming
  // back, which the status line needs.
  const _inFlight = {}
  // every metadata write the plugin has ever queued, chained end to end. Two
  // chains running at once write the server's base deltas through the same
  // temporary file and rename it out from under each other, and a config save
  // is a stop followed by a start, so overlapping runs are ordinary.
  let _metaChain = Promise.resolve()
  let _failures = {}
  // problems found in the configuration at startup. They are permanent until
  // someone edits the file, while the status line is rewritten every cycle, so
  // they are counted and carried rather than announced once and lost.
  let _configIssues = 0
  let _lastReading = null
  let plugin = {}

  plugin.id = 'raspberry-pi-1wire'
  plugin.name = '1-Wire Temperature'
  plugin.description = '1-Wire temperature sensors through the Linux 1-wire subsystem'

  plugin.schema = {
    type: 'object',
    properties: {
      rate: {
        title: 'Sample Rate (in seconds)',
        description: 'A 12 bit conversion takes 750 ms per sensor and the sensors are read one at a time, so keep this above roughly one second per sensor. A cycle that is still running when the next one is due is skipped.',
        type: 'number',
        minimum: 1,
        default: w1.DEFAULT_RATE_SECONDS
      },
      devices: {
        type: 'array',
        title: '1-Wire Sensors',
        items: {
          type: 'object',
          properties: {
            // No defaults on either of these. The form's add button fills a new
            // row from them, and the plugin finds the sensors itself, so the
            // only thing a default can produce is an entry for a sensor that
            // does not exist.
            oneWireId: {
              type: 'string',
              title: 'Sensor Id',
              description: 'Filled in from the bus. Sensors are found on their own, so there is nothing to add here by hand.'
            },
            locationName: {
              type: 'string',
              title: 'Location name',
              description: 'What this sensor measures, in words. Shown as the displayName of the path once it differs from the generated name.'
            },
            path: {
              type: 'string',
              title: 'Signal K Path',
              description: 'Full Signal K path for this sensor, for example \'propulsion.0.temperature\' or \'electrical.alternators.0.temperature\'. Leave empty to fall back on the deprecated key below.',
              default: ''
            },
            key: {
              type: 'string',
              title: 'Signal K Key',
              description: 'Deprecated, use \'Signal K Path\' instead. This is appended to \'environment\' to build the path. Ignored when a full path is set.',
              default: ''
            },
            offset: {
              type: 'number',
              title: 'Calibration offset',
              description: 'Added to every reading from this sensor. A kelvin and a degree Celsius are the same size, so enter the correction in degrees, for example 2 or -0.4. Use it when a sensor reads consistently high or low, which is usually down to where it is mounted rather than to the chip. Leave at 0 for no correction.',
              default: 0
            }
          }
        }
      }
    }
  }

  plugin.start = function (options) {
    // a config save stops and restarts the plugin, so ignore the sensor
    // enumeration of a previous run that is still in flight
    stopTimer()
    _deviceList = []
    _cycle = null
    // _inFlight is deliberately not reset here, see its declaration.
    _failures = {}
    _configIssues = 0
    _lastReading = null
    const generation = ++_generation

    w1.listSensors(W1_DEVICES, function (err, ids) {
      if (generation !== _generation) return
      if (err) {
        // the w1 modules may still be probing when the server starts, so keep
        // looking instead of staying dead until someone restarts the plugin
        return retry(generation, options,
          'cannot read ' + W1_DEVICES + ': ' + reason(err))
      }
      if (ids.length === 0) {
        // the directory exists as soon as the module loads, but the bus master
        // can take seconds to finish its first search, so an empty listing at
        // boot is not proof that nothing is attached
        return retry(generation, options,
          'no 1-wire temperature sensors on ' + W1_DEVICES +
          '. Check the wiring and that the bus is enabled.')
      }

      const malformed = options.devices !== undefined && !Array.isArray(options.devices)
      if (malformed) {
        configProblem('the configured sensor list is not a list, ignoring it. ' +
          'Nothing is saved over it, so the file can still be repaired by hand.')
      }
      const devices = Array.isArray(options.devices) ? options.devices : []

      let saveOptions = false
      ids.forEach(function (id) {
        let device = devices.find(function (candidate) {
          return candidate && normalisedId(candidate.oneWireId) === normalisedId(id)
        })
        if (!device) {
          device = newSensor(id)
          devices.push(device)
          saveOptions = true
        }
        if (device.oneWireId !== id) {
          // the bus only answers to its own spelling. The correction alone
          // never triggers a save; it reaches the file only if some other
          // sensor is being written in the same pass.
          app.debug('sensor id ' + JSON.stringify(device.oneWireId) +
            ' in the configuration read as ' + id)
          device.oneWireId = id
        }
        _deviceList.push(device)
      })
      options.devices = devices

      reportDuplicates(devices)
      reportMissing(devices, ids)
      reportPathless()

      // saving over a config we could not read would destroy whatever the user
      // was trying to write, so a discovered sensor waits until it is repaired
      if (saveOptions && !malformed) {
        app.savePluginOptions(options, function (saveError) {
          // a silent failure here means the discovered sensors are rediscovered
          // on every start and any edit made in the meantime is lost
          if (saveError) {
            app.error('could not save the discovered sensors: ' + reason(saveError))
          }
        })
      }

      sendMetas(generation)
      reportCalibration()
      // sendMetas publishes a delta on a server older than 2.30, and a
      // subscriber is free to stop the plugin from inside that call, which
      // would leave the interval below with nothing left to clear it
      if (generation !== _generation) return
      updateStatus()

      const interval = w1.sampleInterval(options.rate)
      // falling back without a word looks like the setting was honoured
      if (options.rate !== undefined && interval !== options.rate * 1000) {
        configProblem('sample rate ' + JSON.stringify(options.rate) +
          ' is not usable, falling back to ' + (interval / 1000) + ' seconds')
      }

      measureTemperatures(generation)

      // The first cycle publishes, a subscriber is free to stop the plugin from
      // inside that, and an interval created afterwards has nothing left to
      // clear it. Nothing in the contract with lib/w1 promises the read calls
      // back asynchronously, so the interval is guarded by what is true when it
      // is created rather than by what was true above.
      if (generation !== _generation) return
      _timer = setInterval(function () {
        measureTemperatures(generation)
      }, interval)
    })
  }

  function retry (generation, options, message) {
    app.setPluginError(message)
    _timer = setTimeout(function () {
      if (generation === _generation) plugin.start(options)
    }, RETRY_INTERVAL)
  }

  function stopTimer () {
    if (_timer) {
      // clearInterval and clearTimeout are the same operation in Node, so this
      // cancels a pending retry as well as a running measurement cycle
      clearInterval(_timer)
      _timer = null
    }
  }

  // A calibration offset shifts every reading from a sensor without leaving any
  // other trace, so name the ones that are active. One that could not be read as
  // a number is worse than one that is missing, because the sensor looks
  // calibrated and is not.
  function reportCalibration () {
    _deviceList.forEach(function (device) {
      const offset = w1.parseCalibration(device.offset)
      if (offset === null) {
        configProblem('sensor ' + device.oneWireId + ' has a calibration offset of ' +
          JSON.stringify(device.offset) + ' that is not a usable correction, so ' +
          'none is applied. It must be a number of degrees, written with a ' +
          'decimal point rather than a comma, and within 50 degrees of zero.')
      } else if (offset !== 0) {
        app.debug('sensor ' + device.oneWireId + ' has a calibration offset of ' +
          offset + ' applied to every reading')
      }
    })
  }

  // Two entries for one sensor, or two sensors on one path, both lose data
  // without any symptom other than a reading that never appears.
  function reportDuplicates (devices) {
    const byId = {}
    devices.forEach(function (device) {
      if (!device || !device.oneWireId) return
      const id = normalisedId(device.oneWireId)
      if (byId[id]) {
        configProblem('sensor ' + device.oneWireId + ' is configured more than once, ' +
          'only the first entry is used')
      }
      byId[id] = true
    })

    const byPath = {}
    _deviceList.forEach(function (device) {
      const path = devicePath(device)
      if (!path) return
      if (byPath[path]) {
        configProblem('more than one sensor publishes to ' + path +
          ', so the readings overwrite each other')
      }
      byPath[path] = true
    })
  }

  // A configured sensor that is not on the bus is silent for a reason nothing
  // else reports. Upgrades from the original plugin routinely carry a dozen of
  // these, left behind by a library that enumerated bus errors as if they were
  // sensors.
  function reportMissing (devices, ids) {
    const onBus = {}
    ids.forEach(function (id) { onBus[normalisedId(id)] = true })
    const seen = {}
    const missing = devices.filter(function (device) {
      if (!device || !device.oneWireId) return false
      const id = normalisedId(device.oneWireId)
      if (onBus[id] || seen[id]) return false
      seen[id] = true
      return true
    })
    if (missing.length === 0) return
    configProblem(missing.length + ' configured ' +
      (missing.length === 1 ? 'sensor is' : 'sensors are') +
      ' not on the bus and will not be read: ' +
      missing.map(function (device) { return device.oneWireId }).join(', '))
  }

  // Once at startup rather than once per sensor per cycle, which buried it.
  function reportPathless () {
    const pathless = _deviceList.filter(function (device) {
      return devicePath(device) === null
    })
    if (pathless.length === 0) return
    configProblem(pathless.length + ' ' +
      (pathless.length === 1 ? 'sensor has' : 'sensors have') +
      ' neither a path nor a key, so nothing is published for ' +
      (pathless.length === 1 ? 'it' : 'them') + ': ' +
      pathless.map(function (device) { return device.oneWireId }).join(', '))
  }

  plugin.stop = function () {
    _generation++
    _deviceList = []
    _cycle = null
    _failures = {}
    _configIssues = 0
    _lastReading = null
    stopTimer()
  }

  function measureTemperatures (generation) {
    // The bus is serial and each conversion holds a thread pool thread for the
    // full 750 ms, so the sensors are read one at a time. Starting them together
    // finishes no sooner, because the driver serialises anyway, but it pins the
    // whole pool and stalls file and network io for every other plugin in the
    // process.
    if (_cycle !== null) {
      // no read outstanding means the chain is walking, not stuck
      const since = _cycle.readStarted
      const running = since === null ? 0 : now() - since
      if (since === null || running < READ_TIMEOUT) {
        app.debug('previous cycle still running, skipping this one')
        return
      }
      // a sysfs read that never calls back would otherwise stop the plugin for
      // good, so the cycle is written off. Its chain stops walking as soon as
      // it notices it no longer owns the slot.
      const stuck = _cycle.reading
      app.error('the read of ' + (stuck ? stuck.oneWireId : 'a sensor') +
        ' has been outstanding for ' + Math.round(running / 1000) +
        ' s, abandoning that cycle')
      _cycle = null
      // the sensor itself is named by updateStatus, which reads _inFlight: a
      // read that never returns records no failure of its own
      updateStatus()
    }

    const cycle = { readStarted: null, reading: null }
    _cycle = cycle

    // Only the cycle that owns the slot may release it, and only the owning
    // cycle may keep walking: a straggler that has been abandoned, or that
    // belongs to a previous generation, has to stop where it stands.
    function owns () {
      return _cycle === cycle && generation === _generation
    }

    function release () {
      if (_cycle === cycle) _cycle = null
    }

    const devices = _deviceList.slice()
    let done = 0

    function next () {
      if (!owns()) {
        release()
        return
      }
      if (done >= devices.length) {
        release()
        updateStatus()
        return
      }

      const device = devices[done]
      done++
      // the device itself, not its index: the list is rebuilt every run
      cycle.reading = device
      const path = devicePath(device)
      if (!path) {
        // already reported once at startup by reportPathless()
        return next()
      }
      const sensor = normalisedId(device.oneWireId)
      if (_inFlight[sensor] !== undefined) {
        // its previous read never came back, so asking again would only pin a
        // second thread on the same dead sensor
        return next()
      }
      // healthy in itself, but behind a lock nobody is going to release
      if (busLockedUp()) {
        return next()
      }

      _inFlight[sensor] = now()
      cycle.readStarted = now()
      w1.readTemperature(W1_DEVICES, device.oneWireId, function (err, value) {
        delete _inFlight[sensor]
        if (!owns()) {
          release()
          return
        }
        try {
          const corrected = err ? null : w1.applyCalibration(value, device.offset)
          if (err) {
            // a failed read must not be published as NaN
            noteFailure(device, err)
          } else if (corrected === null) {
            // The read was fine and the correction put it somewhere the sensor
            // cannot be. Counted like a failed read rather than as a
            // configuration problem, which would add one to the count on every
            // cycle for as long as it lasted.
            noteFailure(device, new Error('a reading of ' + value +
              ' C plus the calibration offset ' + device.offset +
              ' is outside anything the sensor can measure, so it was discarded'))
          } else {
            _failures[device.oneWireId] = 0
            _lastReading = new Date()
            app.handleMessage(plugin.id,
              createDeltaMessage(path, corrected + 273.15))
          }
        } catch (e) {
          // the chain has to keep walking or the slot is never released and the
          // plugin goes quiet for good
          app.error('could not publish ' + path + ': ' + reason(e))
        }
        next()
      })
    }

    next()
  }

  // One failed read is ordinary and stays in the debug log. A sensor that keeps
  // failing has come loose, and with debug off that used to be invisible.
  function noteFailure (device, err) {
    const count = (_failures[device.oneWireId] || 0) + 1
    _failures[device.oneWireId] = count
    app.debug(reason(err))
    if (count === FAILURE_THRESHOLD) {
      app.error('sensor ' + device.oneWireId + ' has failed ' + count +
        ' reads in a row: ' + reason(err))
    }
  }

  // What to call a failure in a log line. Nothing guarantees that a rejection
  // or a thrown value is an Error, and reading .message off undefined throws
  // from inside the very handler meant to contain the failure.
  function reason (e) {
    if (e === null || e === undefined) return String(e)
    return typeof e.message === 'string' ? e.message : String(e)
  }

  // Whether this sensor's outstanding read is one that is never coming back,
  // rather than one merely in progress: a config save is a stop followed by a
  // start, so landing in the middle of an ordinary 750 ms read is routine and
  // is not evidence of anything.
  function readStalled (sensor) {
    const since = _inFlight[sensor]
    return since !== undefined && now() - since >= READ_TIMEOUT
  }

  // A read that never came back is still holding the bus master's mutex: the
  // driver takes it for the whole conversion and only releases it afterwards
  // on the ordinary externally powered wiring. Every other sensor blocks on
  // that same lock, reads nothing, and pins a thread pool thread while it
  // waits. The pool is four threads by default, so carrying on regardless
  // hands the lot to a dead bus and stops file and network io for every other
  // plugin in the server. Asks every outstanding read, not only the configured
  // ones: unplugging a sensor does not release the lock its read is holding.
  function busLockedUp () {
    return Object.keys(_inFlight).some(readStalled)
  }

  function updateStatus () {
    const failing = _deviceList.filter(function (device) {
      if ((_failures[device.oneWireId] || 0) >= FAILURE_THRESHOLD) return true
      // A read that never came back records no failure of its own, and the
      // failure counters do not survive a restart while the outstanding read
      // does, so this has to ask _inFlight as well: without it the first config
      // save after a sensor hung reported a bus with that sensor permanently
      // excluded as healthy.
      return readStalled(normalisedId(device.oneWireId))
    })
    let status = _deviceList.length +
      (_deviceList.length === 1 ? ' sensor' : ' sensors')
    if (_lastReading) {
      status += ', last read ' + _lastReading.toTimeString().slice(0, 8)
    }
    if (failing.length > 0) {
      status += ', not responding: ' + failing.map(sensorLabel).join(', ')
    }
    if (_configIssues > 0) {
      status += ', ' + _configIssues + ' configuration ' +
        (_configIssues === 1 ? 'problem' : 'problems') + ' in the server log'
    }
    app.setPluginStatus(status)
  }

  // Something the user has to fix. It goes to the log in full, and is counted
  // so the status line can say that it happened: app.error alone reaches only
  // the server log, which nobody reads until they are already looking for a
  // fault.
  function configProblem (message) {
    _configIssues++
    app.error(message)
  }

  // Bus ids are always lower case, but this field is hand-editable, so a pasted
  // id with different case or a stray space is realistic. Matched loosely, such
  // an entry would look like an unknown sensor and quietly lose its path and
  // calibration.
  function normalisedId (id) {
    return typeof id === 'string' ? id.trim().toLowerCase() : ''
  }

  // What to call a sensor in the status line, which a user reads. The log keeps
  // the bus id, which is what a user greps for.
  function sensorLabel (device) {
    if (device.locationName &&
        device.locationName !== generatedName(device.oneWireId)) {
      return device.locationName
    }
    return device.oneWireId
  }

  function devicePath (device) {
    if (typeof device.path === 'string' && device.path.trim() !== '') {
      return device.path.trim()
    }
    if (typeof device.key === 'string' && device.key.trim() !== '') {
      return 'environment.' + device.key.trim()
    }
    return null
  }

  function sendMetas (generation) {
    const metas = _deviceList.map(function (device) {
      const path = devicePath(device)
      if (!path) return null
      const meta = { units: 'K' }
      // an untouched auto-generated name is the bare sensor id, which is a
      // worse label than whatever Signal K already knows the path by
      if (device.locationName && device.locationName !== generatedName(device.oneWireId)) {
        meta.displayName = device.locationName
      }
      return { path: path, value: meta }
    }).filter(function (meta) {
      return meta !== null
    })

    if (metas.length === 0) return

    // Meta sent as a delta is last-writer-wins, so a displayName the user set
    // in the admin UI was overwritten on every start. setDefaultMetadata fills
    // in only what nobody has claimed, but it arrived in server 2.30, so the
    // delta stays as the fallback for older servers.
    if (typeof app.setDefaultMetadata === 'function') {
      // One at a time, and awaited. Each call ends in a write of the server's
      // base deltas through a fixed temporary path, so two in flight together
      // rename that file out from under each other. It holds the vessel uuid
      // and every base delta the user set, and a server that cannot parse it
      // starts with none of them.
      _metaChain = metas.reduce(function (previous, meta) {
        return previous.then(function () {
          // a run that has been superseded must not finish writing the
          // configuration it was started with over the one now in force
          if (generation !== _generation) return
          return app.setDefaultMetadata(meta.path, meta.value)
        }).catch(function (e) {
          // caught per path rather than once around the chain: a rejection
          // walks past every later link, so one path the server will not write
          // took the units off every sensor behind it in the list
          app.error('could not set meta for ' + meta.path + ': ' + reason(e))
        })
      }, _metaChain)
      return
    }

    try {
      app.handleMessage(plugin.id, {
        context: 'vessels.' + app.selfId,
        updates: [
          {
            meta: metas
          }
        ]
      })
    } catch (e) {
      // meta is a nicety; failing to publish it must not take the rest of
      // startup down with it and leave the plugin without a sample timer
      app.error('could not publish meta: ' + reason(e))
    }
  }

  function createDeltaMessage (path, temperature) {
    return {
      context: 'vessels.' + app.selfId,
      updates: [
        {
          source: {
            label: plugin.id
          },
          timestamp: (new Date()).toISOString(),
          values: [
            {
              path: path,
              value: temperature
            }
          ]
        }
      ]
    }
  }

  function generatedName (id) {
    return 'Sensor ' + id
  }

  function newSensor (id) {
    return {
      oneWireId: id,
      locationName: generatedName(id),
      key: 'inside.' + id + '.temperature',
      offset: 0
    }
  }

  return plugin
}
