'use strict';

var _ = require('lodash');
var util = require('util');
var P = require('bluebird');
var child_process = require('child_process');
var uuid = require('node-uuid');

// Add some usefull promise methods
exports.extendPromise = function(P){
    // This is designed for large array
    // The original map with concurrency option does not release memory
    P.mapLimit = function(items, fn, limit){
        if(!limit){
            limit = 1000;
        }
        var groups = [];
        var group = [];
        items.forEach(function(item){
            group.push(item);
            if(group.length >= limit){
                groups.push(group);
                group = [];
            }
        });
        if(group.length > 0){
            groups.push(group);
        }

        var results = [];
        var promise = P.resolve();
        groups.forEach(function(group){
            promise = promise.then(function(){
                return P.map(group, fn)
                .then(function(ret){
                    ret.forEach(function(item){
                        results.push(item);
                    });
                });
            });
        });
        return promise.thenReturn(results);
    };

    P.mapSeries = function(items, fn){
        var results = [];
        return P.each(items, function(item){
            return P.try(function(){
                return fn(item);
            })
            .then(function(ret){
                results.push(ret);
            });
        })
        .thenReturn(results);
    };
};

exports.uuid = function(){
    return uuid.v4();
};

exports.isEmpty = function(obj){
    for(var key in obj){
        return false;
    }
    return true;
};

exports.getObjPath = function(obj, path){
    var current = obj;
    path.split('.').forEach(function(field){
        if(!!current){
            current = current[field];
        }
    });
    return current;
};

exports.setObjPath = function(obj, path, value){
    if(typeof(obj) !== 'object'){
        throw new Error('not object');
    }
    var current = obj;
    var fields = path.split('.');
    var finalField = fields.pop();
    fields.forEach(function(field){
        if(!current.hasOwnProperty(field)){
            current[field] = {};
        }
        current = current[field];
        if(typeof(current) !== 'object'){
            throw new Error('field ' + path + ' exists and not a object');
        }
    });
    current[finalField] = value;
};

exports.deleteObjPath = function(obj, path){
    if(typeof(obj) !== 'object'){
        throw new Error('not object');
    }
    var current = obj;
    var fields = path.split('.');
    var finalField = fields.pop();
    fields.forEach(function(field){
        if(!!current){
            current = current[field];
        }
    });
    if(current !== undefined){
        delete current[finalField];
    }
};

exports.clone = function(obj){
    return JSON.parse(JSON.stringify(obj));
};

exports.isDict = function(obj){
    return typeof(obj) === 'object' && obj !== null && !Array.isArray(obj);
};

// escape '$' and '.' in field name
// '$abc.def\\g' => '\\u0024abc\\u002edef\\\\g'
exports.escapeField = function(str){
    return str.replace(/\\/g, '\\\\').replace(/\$/g, '\\u0024').replace(/\./g, '\\u002e');
};

exports.unescapeField = function(str){
    return str.replace(/\\u002e/g, '.').replace(/\\u0024/g, '$').replace(/\\\\/g, '\\');
};

// Async foreach for mongo's cursor
exports.mongoForEach = function(itor, func){
    var deferred = P.defer();

    var next = function(err){
        if(err){
            return deferred.reject(err);
        }
        // async iterator with .next(cb)
        itor.next(function(err, value){
            if(err){
                return deferred.reject(err);
            }
            if(value === null){
                return deferred.resolve();
            }
            P.try(function(){
                return func(value);
            })
            .nodeify(next);
        });
    };
    next();

    return deferred.promise;
};

exports.remoteExec = function(ip, cmd, opts){
    ip = ip || '127.0.0.1';
    opts = opts || {};
    var user = opts.user || process.env.USER;
    var successCodes = opts.successCodes || [0];

    var args = [user + '@' + ip, 'bash -c \'' + cmd + '\''];
    var child = child_process.spawn('ssh', args);

    var deferred = P.defer();
    var stdout = '', stderr = '';
    child.stdout.on('data', function(data){
        stdout += data;
    });
    child.stderr.on('data', function(data){
        stderr += data;
    });
    child.on('exit', function(code, signal){
        if(successCodes.indexOf(code) !== -1){
            deferred.resolve(stdout);
        }
        else{
            deferred.reject(new Error(util.format('remoteExec return code %s on %s@%s - %s\n%s', code, user, ip, cmd, stderr)));
        }
    });
    return deferred.promise;
};
