/*
 * Copyright 2019 Ewald van Gemert <vangee@gmail.com>
 *
 * This file has been modified from the original. In this fork the sensors are
 * read from /sys/bus/w1 directly instead of through the ds18b20 library, each
 * sensor can be given a full Signal K path, and meta is published with units
 * and displayName. See CHANGELOG.md for the full list.
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

const _ = require('underscore')
const w1 = require('./lib/w1')

const W1_DEVICES = w1.W1_DEVICES
const RETRY_INTERVAL = 30000

module.exports = function (app) {
  let _deviceList = [];
  let _timer = null;
  let _generation = 0;
  let _pending = 0;
  let plugin = {}

  plugin.id = 'raspberry-pi-1wire'
  plugin.name = '1-Wire Temperature'
  plugin.description = '1-Wire temperature sensors through the Linux 1-wire subsystem'

  plugin.schema = {
    type: 'object',
    properties: {
      rate: {
        title: "Sample Rate (in seconds)",
        description: 'A 12 bit conversion takes 750 ms per sensor and the bus is serial, so keep this above roughly one second per sensor. A cycle that is still running when the next one is due is skipped.',
        type: 'number',
        minimum: 1,
        default: 10
      },
      devices: {
        type: 'array',
        title: '1-Wire Sensors',
        items: {
          type: 'object',
          properties: {
            oneWireId: {
              type: 'string',
              title: 'Sensor Id',
              default: '10-00080283a977'
            },
            locationName: {
              type: 'string',
              title: 'Location name',
              default: 'Engine room'
            },
            key: {
              type: 'string',
              title: 'Signal K Key',
              description: 'Deprecated, use \'Signal K Path\' instead. This is appended to \'environment\' to build the path. Ignored when a full path is set.',
              default: 'inside.engineroom.temperature'
            },
            path: {
              type: 'string',
              title: 'Signal K Path',
              description: 'Full Signal K path for this sensor, for example \'propulsion.0.temperature\' or \'electrical.alternators.0.temperature\'. Leave empty to fall back on the deprecated key above.',
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
    _deviceList = []
    var generation = ++_generation

    w1.listSensors(W1_DEVICES, function (err, ids) {
      if (generation !== _generation) return
      if (err) {
        // the w1 modules may still be probing when the server starts, so keep
        // looking instead of staying dead until someone restarts the plugin
        app.setPluginError('cannot read ' + W1_DEVICES + ': ' + err.message)
        _timer = setTimeout(function () {
          if (generation === _generation) plugin.start(options)
        }, RETRY_INTERVAL)
        return
      }

      var saveOptions = false
      _.each(ids, function (id) {
        // find device in options
        var device = _.findWhere(options.devices, {oneWireId: id})
        // create if not exists
        if (!device) {
          device = newSensor(id)
          if (!options.devices) options.devices = [];
          options.devices.push(device)
          saveOptions = true
        }
        
        _deviceList.push(device);
      })

      // save devicelist if new device detected
      if (saveOptions) {
        app.savePluginOptions(options, function () {
        })
      }

      sendMetas()
      reportResolution(generation)
      reportCalibration()

      measureTemperatures(generation)
      _timer = setInterval(function () {
        measureTemperatures(generation)
      }, options.rate * 1000)
    })
  }

  // A sensor at less than 12 bits silently costs precision, so say so once.
  function reportResolution (generation) {
    _.each(_deviceList, function (device) {
      w1.readResolution(W1_DEVICES, device.oneWireId, function (err, bits) {
        if (generation !== _generation) return
        if (bits === null) return
        if (bits < 12) {
          app.debug('sensor ' + device.oneWireId + ' is set to ' + bits +
            ' bit resolution, so readings are coarser than 0.0625 degrees')
        } else {
          app.debug('sensor ' + device.oneWireId + ' is set to ' + bits + ' bit resolution')
        }
      })
    })
  }

  // A calibration offset shifts every reading from a sensor without leaving any
  // other trace, so name the ones that are active. An offset that could not be
  // read as a number is worse than one that is missing, because the sensor looks
  // calibrated and is not, so that one is an error rather than a debug line.
  function reportCalibration () {
    _.each(_deviceList, function (device) {
      var offset = w1.parseCalibration(device.offset)
      if (offset === null) {
        app.error('sensor ' + device.oneWireId + ' has a calibration offset of ' +
          JSON.stringify(device.offset) + ' that is not a number, so no correction ' +
          'is applied. Use a decimal point rather than a comma.')
      } else if (offset !== 0) {
        app.debug('sensor ' + device.oneWireId + ' has a calibration offset of ' +
          offset + ' applied to every reading')
      }
    })
  }

  plugin.stop = function () {
    _generation++
    _deviceList = []
    if (_timer) {
      clearInterval(_timer)
      _timer = null
    }
  }

  function measureTemperatures(generation) {
    // each read occupies a threadpool thread for the whole conversion and the
    // bus is serial, so a slow cycle must not stack another batch on top
    if (_pending > 0) {
      app.debug('previous cycle still running with ' + _pending +
        ' reads outstanding, skipping this one')
      return
    }

    _.each(_deviceList, function (device) {
      // skip sensors that have neither a path nor a key configured
      if (!devicePath(device)) {
        app.debug('no path or key configured for sensor ' + device.oneWireId)
        return
      }
      // measure temperature
      _pending++
      w1.readTemperature(W1_DEVICES, device.oneWireId, function (err, value) {
        _pending--
        if (generation !== _generation) return
        // a failed read must not be published as NaN
        if (err) {
          app.debug(err.message)
          return
        }
        var temperature = w1.applyCalibration(value, device.offset) + 273.15
        // create message
        var delta = createDeltaMessage(device, temperature)
        // send temperature
        app.handleMessage(plugin.id, delta)
      })
    })
  }
  
  function devicePath (device) {
    if (device.path) return device.path
    if (device.key) return 'environment.' + device.key
    return null
  }

  function sendMetas () {
    var metas = _.filter(_.map(_deviceList, function (device) {
      var path = devicePath(device)
      if (!path) return null
      var meta = { 'units': 'K' }
      // an untouched auto-generated name is the bare sensor id, which is a
      // worse label than whatever Signal K already knows the path by
      if (device.locationName && device.locationName !== generatedName(device.oneWireId)) {
        meta.displayName = device.locationName
      }
      return {
        'path': path,
        'value': meta
      }
    }), function (meta) {
      return meta !== null
    })

    app.handleMessage(plugin.id, {
      'context': 'vessels.' + app.selfId,
      'updates': [
        {
          'meta': metas
        }
      ]
    })
  }

  function createDeltaMessage (device, temperature) {
    return {
      'context': 'vessels.' + app.selfId,
      'updates': [
        {
          'source': {
            'label': plugin.id
          },
          'timestamp': (new Date()).toISOString(),
          'values': [
            {
              'path': devicePath(device),
              'value': temperature
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
      'oneWireId': id,
      'locationName': generatedName(id),
      'key': 'inside.' + id + '.temperature',
      'offset': 0
    }
  }

  return plugin
}
