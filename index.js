var path = require('path');
var fs = require('graceful-fs');
var fse = require('fs-extra');
var yaml = require('yaml-js');
var tempfile = require('tempfile');
var loaderUtils = require('loader-utils');
var Promise = require('bluebird');

var BinPacking = require('./lib/BinPacking');
var FramesPacker = require('./lib/FramesPacker');
var readFromCacheAsync = require('./lib/readFromCacheAsync');
var preprocessAsync = require('./lib/preprocessAsync');
var getImageSizeAsync = require('./lib/getImageSizeAsync');
var spritesheetAsync = require('./lib/spritesheetAsync');
var pngOptimizeAsync = require('./lib/pngOptimizeAsync');

var urlLoader = require('url-loader');

function rewriteJSON(content, imagePathStr, mode, resource) {
  var sheetConfig = JSON.parse(content);
  var regex = new RegExp(`"[\\w\\/]*?(${sheetConfig.meta.image.slice(0, -5)}_\\w{6}\\.webp)"`)

  var imagePath = regex.exec(imagePathStr)[1]

  sheetConfig.meta.image = imagePath;

  if (resource) {
    sheetConfig.meta.image = `$$${resource.replace('$url', sheetConfig.meta.image)}$$`;
  }

  if (mode === 'inline') {
    sheetConfig.meta.json = `${path.basename(imagePath, '.webp')}.json`;
    if (resource) {
      sheetConfig.meta.json = `$$${resource.replace('$url', sheetConfig.meta.json)}$$`;
    }
  }

  return JSON.stringify(sheetConfig);
}

function buildFiles(context, options, name, callback) {
  var imageOptions = {};

  for (var key in options) {
    if (typeof key !== 'object') imageOptions[key] = options[key];
  }

  // build image
  var imagePathStr;
  var imageFullPath = path.resolve(options.output, `${name}.webp`);
  var imageContent = fs.readFileSync(imageFullPath);
  var imageContext = Object.assign({}, context, {
    resourcePath: imageFullPath,
    query: Object.assign({}, imageOptions, options.image)
  });


  imagePathStr = urlLoader.call(imageContext, imageContent);
  afterImage(imagePathStr, function (rs) {
    callback(rs);
  });

  function afterImage(imagePathStr, cb) {
    var content = '';
    // build json
    var jsonFullPath = path.resolve(options.output, `${name}.json`);
    var jsonStr = fs.readFileSync(jsonFullPath);
    var jsonContent = rewriteJSON(jsonStr, imagePathStr, options.mode, options.resource);
    if (options.mode === 'inline') {
      if (options.resource) {
        jsonContent = jsonContent.split('$$').map(segment => segment.replace(/(^")|("$)/g, '')).join('');
      }

      var source = `module.exports = ${jsonContent};`;
      return cb(source);
    } else if (options.mode === 'none') {
      return cb(jsonContent);
    }

    var jsonOptions = {};

    for (var key in options) {
      if (typeof key !== 'object') jsonOptions[key] = options[key];
    }

    var jsonContext = Object.assign({}, context, {
      resourcePath: jsonFullPath,
      query: Object.assign({}, jsonOptions, options.json)
    });

    content = urlLoader.call(jsonContext, jsonContent);
    cb(content);
  }
}

module.exports = function (content) {
  var self = this;
  var callback = self.async();
  var options = loaderUtils.getOptions(self) || {};
  var config = yaml.load(content.toString()) || {};
  var framesPacker = new FramesPacker(self.context, config);
  var inputTemp = tempfile();
  var outputTemp = tempfile();

  function afterProcess(result) {
    process.nextTick(function () {
      fse.remove(inputTemp);
      fse.remove(outputTemp);
    });
    callback(null, result);
  }

  options.process = typeof options.process === 'undefined' ? true : options.process;
  options.output = options.output || inputTemp;
  self.cacheable(true);
  self.addContextDependency(self.context);

  if (config.files) {
    Object.keys(config.files).forEach(function (filePath) {
      var fullPath = path.resolve(self.context, filePath);
      self.addDependency(fullPath);
    });
  }

  if (!options.process) {
    var result = '';
    var imageFullPath = path.resolve(options.output, `${framesPacker.output}.png`);
    if (!fs.existsSync(imageFullPath)) {
      self.emitError(`${framesPacker.output}.json and ${framesPacker.output}.png are not found in the directory output option specified when process option is disabled, please ensure these files were built into this directory in the last build.`);
      return afterProcess(result);
    } else {
      self.emitWarning(`Image processing will not execute when process option is disabled. ${framesPacker.output}.json and ${framesPacker.output}.png will be read from the directory output option specified.`);
      return buildFiles(self, options, framesPacker.output, afterProcess);
    }
  }

  framesPacker.initFrames();
  framesPacker.compressFrames();

  readFromCacheAsync(options.cacheable, config, framesPacker.frames, framesPacker.output, options.output)
    .then(function (cached) {
      if (!cached) {
        return preprocessAsync(framesPacker.frames, inputTemp, framesPacker.config)
          .then(function (compressedFrames) {
            return getImageSizeAsync(compressedFrames, framesPacker.config);
          })
          .then(function (sizedFrames) {
            var binPacking = new BinPacking(framesPacker.output, sizedFrames, {
              rotatable: framesPacker.config.rotatable,
              algorithm: 'max-rects'
            });
            binPacking.pack();
            var packedFrames = binPacking.packed;
            var canvasSize = {
              width: binPacking.canvasWidth,
              height: binPacking.canvasHeight
            };
            var outputPath = path.join(outputTemp, `${framesPacker.output}`);
            fse.ensureDirSync(outputTemp);
            return spritesheetAsync(packedFrames, canvasSize, outputPath, framesPacker.config);
          })
          .then(function (sourcePath) {
            var destPath = path.resolve(path.join(options.output, framesPacker.output));
            return Promise.all([
              pngOptimizeAsync(`${sourcePath}.png`, `${destPath}.webp`, framesPacker.config.colors),
              fse.copy(`${sourcePath}.json`, `${destPath}.json`)
            ]);
          });
      }
    })
    .then(function () {
      buildFiles(self, options, framesPacker.output, afterProcess);
    })
    .catch(function (error) {
      debugger;
      if (options.verbose) {
        console.error(error);
      }

      if (options.process) {
        self.emitError(`Error occurred in image processing, ImageMagick or pngquant may not be correctly installed or specified in operating system. See https://github.com/icefox0801/pixi-tileset-loader#system-dependencies for more information.`);
      }

      buildFiles(self, options, framesPacker.output, afterProcess);
    });
};

module.exports.raw = true;
