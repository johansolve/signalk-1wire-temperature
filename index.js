/*
 * Copyright 2019 Ewald van Gemert <vangee@gmail.com>
 *
 * This file has been modified from the original. Changes in this fork:
 * an optional full Signal K path per sensor, and meta published with units
 * and displayName. See the repository history for details.
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
const _ds18b20 = require('ds18b20')

module.exports = function (app) {
  let _deviceList = [];
  let _timer = null;
  let _generation = 0;
  let plugin = {}

  plugin.id = 'raspberry-pi-1wire'
  plugin.name = 'Raspberry-Pi 1-Wire'
  plugin.description = '1-Wire temperature sensors on Raspberry-Pi'

  plugin.schema = {
    type: 'object',
    properties: {
      rate: {
        title: "Sample Rate (in seconds)",
        type: 'number',
        default: 30
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

    _ds18b20.sensors(function (err, ids) {
      if (generation !== _generation) return

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

      measureTemperatures()
      _timer = setInterval(measureTemperatures, options.rate * 1000)
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

  function measureTemperatures() {
    _.each(_deviceList, function (device) {
      // skip sensors that have neither a path nor a key configured
      if (!devicePath(device)) {
        app.debug('no path or key configured for sensor ' + device.oneWireId)
        return
      }
      // measure temperature
      _ds18b20.temperature(device.oneWireId, function (err, value) {
        var temperature = value + 273.15
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
      return {
        'path': path,
        'value': {
          'units': 'K',
          'displayName': device.locationName
        }
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

  function newSensor (id) {
    return {
      'oneWireId': id,
      'locationName': 'Sensor ' + id,
      'key': 'inside.' + id + '.temperature'
    }
  }

  return plugin
}
