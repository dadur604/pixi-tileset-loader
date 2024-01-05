var path = require('path');
var fse = require('fs-extra');
var Promise = require('bluebird');
var exec = require('child_process').exec;
var execAsync = Promise.promisify(exec);

function outputJSON (frames, canvasSize, outputPath, config) {
  var parsed = path.parse(outputPath);
  var json = {
    meta: {
      image: `${parsed.name}.webp`,
      size: { w: canvasSize.width, h: canvasSize.height },
      scale: '1'
    },
    frames: {},
    animations: {}
  };

  frames.forEach(function (frame, idx) {
    frame.width -= config.padding * 2;
    frame.height -= config.padding * 2;
    frame.x += config.padding;
    frame.y += config.padding;
    frame.index = idx;

    if (frame.trimmed) {
      json.frames[`${frame.name}.png`] = {
        frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        rotated: frame.rotated,
        trimmed: true,
        spriteSourceSize: { x: frame.trim.x, y: frame.trim.y, w: frame.width, h: frame.height },
        sourceSize: { w: frame.trim.width, h: frame.trim.height }
      };
    } else {
      json.frames[`${frame.name}.png`] = {
        frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
        rotated: frame.rotated,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: frame.width, h: frame.height },
        sourceSize: { w: frame.width, h: frame.height }
      };
    }
  });

  var animationFrameRegex = /(.*)_\d+$/;
  frames.map(frame => frame.name).forEach(frameName => {
    const match = animationFrameRegex.exec(frameName);
    if (!match) return;

    if (json.animations[match[1]] && Array.isArray(json.animations[match[1]])) {
      json.animations[match[1]].push(`${frameName}.png`)
    } else {
      json.animations[match[1]] = [`${frameName}.png`];
    }
  })



  return json;
};

module.exports = function (frames, canvasSize, outputPath, config) {
  var command = [
    '-define', 'png:exclude-chunks=date',
    '-quality', '0',
    '-size', `${canvasSize.width}x${canvasSize.height}`,
    'xc:none'
  ];

  command = command.concat(frames.map(function (frame) {
    return [
      `${frame.path}`,
      `${frame.rotated ? ['-rotate', '90'] : ''}`,
      '-geometry',
      `+${frame.x + ~~config.padding}+${frame.y + ~~config.padding}`,
      '-composite',
    ];
  }), [`${outputPath}.png`]);

  var args = command.flat().filter(arg => arg !== "")

  return new Promise(function (resolve, reject) {
    const child = spawn('convert', args, { shell: false, stdio: 'inherit' });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(`convert process exited with code ${code}`);
      } else {
        var json = outputJSON(frames, canvasSize, outputPath, config);
        fse.writeJSONSync(`${outputPath}.json`, json, {
          spaces: '  '
        });
        resolve(outputPath);
      }
    });
  });
};