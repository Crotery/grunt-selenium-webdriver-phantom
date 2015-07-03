/*
 * grunt-selenium-webdriver-phantom
 * https://github.com/henrytao-me/grunt-selenium-webdriver-phantom
 *
 * Copyright (c) 2014 Henry Tao
 * Licensed under the MIT license.
 */

"use strict";


var freeport = require('freeport')

var spawn = require('child_process').spawn,
    options = {},
    starting = false,
    started = false,
    os = require('os'),
    fs = require('fs'),

    selOptions = ['-jar'],
    seleniumServerProcess = null,

    phantomLoc = __dirname,
    phantomProcess = [];

/*
 * starts phantom, called after grid has been established
 * @private
 */

function startPhantom(next) {

    for (var i = 0; i < options.phantom.workers; i++) {

        (function (i) {

            freeport(function (err, port) {
                if (err) {
                    console.error(err)
                    throw err;
                }
                var args = options.phantom.args.slice(0)
                args.push('--webdriver=' + port)

                var ph = spawn(options.phantom.path, args);


                ph.on('uncaughtException', function (err) {

                    console.trace(err);
                    process.exit(1);

                });

                ph.stderr.setEncoding('utf8');
                ph.stderr.on('data', function (data) {
                    data = data.trim();
                    console.error("phantom " + i + ">" + data)
                });
                ph.stdout.setEncoding('utf8');
                // wait for client ready message before proceeding
                ph.stdout.on('data', function (msg) {
                    console.log("phantom " + i + ">" + msg)
                    // look for msg that indicates it's ready and then stop logging messages
                    if (!started && msg.indexOf('Registered with grid') > -1) {
                        //            console.log ('phantom client ready');
                        started = true;
                        starting = false;
                        if (typeof next === 'function') {
                            return next();
                        }
                    }

                })
                phantomProcess.push(ph)
            })

        })(i)
    }


}

/**
 * starts a selenium server with access to default browsers
 * @param next callback function
 * @param isHeadless will start bundled phantomjs single client with selenium in hub mode
 * @private
 */

function start(next, isHeadless) {

    if (started) {
        return next(console.log('already started'));
    }
    ;

    // init jar directory
    selOptions.push(options.path);

    if (isHeadless) {
        selOptions.push('-role');
        selOptions.push('hub');
        //selOptions.push( '-nodeConfig=' + require('path').resolve(__dirname, "seleniumConfig.json"))
        selOptions.push('-nodePolling')
        selOptions.push('2000')
        selOptions.push('-unregisterIfStillDownAfter')
        selOptions.push('1500')
    } else {
        selOptions = selOptions.concat(options.args);
    }

    seleniumServerProcess = spawn('java', selOptions);
    // selenium webdriver has a port prober in it which could be factored in.
    seleniumServerProcess.on('uncaughtException', function (err) {
        if (err.errno === 'EADDRINUSE') {
            console.log('PORT already IN USE, assume selenium running');
            next();
        } else {
            console.trace(err);
            process.exit(1);
        }
        ;
    });

    seleniumServerProcess.stderr.setEncoding('utf8');
    // parse procee output until server is actually ready, otherwise next task will break
    seleniumServerProcess.stderr.on('data', function (data) {
        var errMsg;
        console.error("selenium>" + data.toString())
        data = data.trim();
        if (isHeadless) {
            // check for grid started, which is outputted to standard error
            if (data.indexOf('Started SocketConnector') > -1) {
                //                console.log ('selenium hub ready');
                return startPhantom(next);
            } else if (data.indexOf('Address already in use') > -1) {
                // throw error if already started
                errMsg = 'FATAL ERROR starting selenium: ' + data + ' maybe try killall -9 java';
                throw errMsg;
            }
        } else if (data &&
                // throw error if something unexpected happens
            data.indexOf('org.openqa.grid.selenium.GridLauncher main') === -1 &&
            data.indexOf('Setting system property') === -1 &&
            data.indexOf('INFO') === -1 &&
            data.indexOf('WARNING') === -1 && !started
        ) {
            errMsg = 'FATAL ERROR starting selenium: ' + data;
            throw errMsg;
        }
    });
    seleniumServerProcess.stdout.setEncoding('utf8');
    seleniumServerProcess.stdout.on('data', function (msg) {
        console.log("selenium>" + msg.toString())
        // monitor process output for ready message
        if (!started && (msg.indexOf('Started org.openqa.jetty.jetty.servlet.ServletHandler') > -1)) {
            //            console.log ('seleniumrc server ready');
            started = true;
            starting = false;
            if (typeof next === 'function') {
                return next();
            }
        }

    });
}


/**
 * Stop the servers
 *
 * @param function optional callback
 * @private
 */

function stop(next) {
    if (phantomProcess.length) {
        seleniumServerProcess.on('close', function (code, signal) {
            // this should really resolve both callbacks rather than guessing phantom wrapper will terminate instantly
            if (typeof next === 'function' && !seleniumServerProcess) {
                next();
            }
        });
        // SIGTERM should ensure processes end cleanly, can do killall -9 java if getting startup errors
        phantomProcess.forEach(function (p) {
            p.kill('SIGTERM')
        });
        started = false;
        starting = false;
    }

    if (seleniumServerProcess) {
        seleniumServerProcess.on('close', function (code, signal) {
            if (typeof next === 'function') {
                // need to stub out the other callback
                next();
            }
            ;
        });
        seleniumServerProcess.kill('SIGTERM');
        started = false;
        starting = false;
    }
};

/*
 * stop the child processes if this process exits
 * @private
 */
process.on('exit', function onProcessExit() {
    if (started) {
        stop();
    }
});

/**
 * Exports 3 tasks
 * selenium_start - will start selenium local server on http://127.0.0.1:4444/wd/hub with all browsers in PATH available
 * selenium_phantom_hub - will start selenium grid hub and attachphantomjs to it
 * stop_selenium - stops whichever server was started
 * @public
 */
module.exports = function (grunt) {

    var executableName = function (file) {
        if (os.type() == 'Windows_NT') {
            return file + '.exe';
        } else {
            return file;
        }
        ;
    };

    grunt.registerMultiTask('selenium_webdriver_phantom', 'grunt plugin for starting selenium webdriver with phantom', function () {

        var done = this.async();

        // protractor info
        var protractor = {};
        protractor.path = require('path').resolve(__dirname, '..', '..', 'protractor');
        protractor.package = require(require('path').resolve(protractor.path, 'package.json'));
        protractor.cnf = require(require('path').resolve(protractor.path, 'config.json'));
        // phantom info
        var phantom = {};
        phantom.path = require('path').resolve(__dirname, '..', '..', 'phantomjs');

        // init options
        options = this.options({
            path: require('path').resolve(protractor.path, 'selenium', 'selenium-server-standalone-' + protractor.cnf.webdriverVersions.selenium + '.jar'),

            args: ['-Dwebdriver.chrome.driver=' + require('path').resolve(protractor.path, 'selenium', executableName('chromedriver'))]
        });

        // check if phantom or not
        if (!options.phantom) {
            // start selenium with no phantom support
            return start(done, false);

        } else {
            // set phantom default variables
            options.phantom.path = options.phantom.path || require('path').resolve(phantom.path, 'bin', 'phantomjs');
            options.phantom.args = options.phantom.args || ['--webdriver-selenium-grid-hub=http://127.0.0.1:4444'];

            options.phantom.workers = options.phantom.workers || 4;
            // start selenium with phantom support
            return start(done, true);

        }
        ;
    });

    grunt.registerTask('selenium_webdriver_phantom:stop', 'grunt plugin for stop selenium webdriver', function () {
        var done = this.async();
        return stop(done);
    });
};
