// Copyright 2015 rain1017.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
// implied. See the License for the specific language governing
// permissions and limitations under the License. See the AUTHORS file
// for names of contributors.

'use strict';

var P = require('bluebird');
var _ = require('lodash');
var should = require('should');
var memdb = require('../../lib');
var env = require('../env');
var logger = require('memdb-logger').getLogger('test', __filename);

describe('autoconnection test', function () {
    beforeEach(env.flushdb);

    it.skip('concurrent execute', function () {
        this.timeout(3600 * 1000);

        var shardId = Object.keys(env.config.shards)[0];
        var user1 = { _id: '1', name: 'rain', level: 0 };
        var autoconn = null;

        return P.try(function () {
            return env.startCluster(shardId);
        })
            .then(function () {
                return memdb.autoConnect(env.config);
            })
            .then(function (ret) {
                autoconn = ret;
                return autoconn.transaction(function () {
                    var User = autoconn.collection('user');
                    return User.insert(user1);
                }, shardId);
            })
            .then(function () {
                var count = 8;

                var delay = 0;
                return P.map(_.range(count), function () {
                    delay += 10;

                    return P.delay(delay)
                        .then(function () {
                            // Simulate non-atomic check and update operation
                            // each 'thread' add 1 to user1.level
                            return autoconn.transaction(function () {
                                var User = autoconn.collection('user');
                                var level = null;

                                return P.try(function () {
                                    return User.find(user1._id, 'level');
                                })
                                    .then(function (ret) {
                                        level = ret.level;
                                    })
                                    .delay(20)
                                    .then(function () {
                                        return User.update(user1._id, { level: level + 1 });
                                    });
                            }, shardId);
                        });
                })
                    .then(function () {
                        return autoconn.transaction(function () {
                            var User = autoconn.collection('user');
                            return P.try(function () {
                                return User.find(user1._id);
                            })
                                .then(function (ret) {
                                    // level should equal to count
                                    ret.level.should.eql(count);
                                    return User.remove(user1._id);
                                });
                        }, shardId);
                    });
            })
            .then(function () {
                return autoconn.transaction(function () {
                    return P.try(function () {
                        var User = autoconn.collection('user');
                        return User.insert(user1);
                    }).then(function () {
                        //Should roll back on exception
                        throw new Error('Oops!');
                    });
                }, shardId)
                    .catch(function (e) {
                        e.message.should.eql('Oops!');
                    });
            })
            .then(function () {
                return autoconn.transaction(function () {
                    return P.try(function () {
                        var User = autoconn.collection('user');
                        return User.find(user1._id);
                    })
                        .then(function (ret) {
                            (ret === null).should.eql(true);
                        });
                }, shardId);
            })
            .then(function () {
                return autoconn.close();
            })
            .finally(function () {
                return env.stopCluster();
            })
        // .nodeify(cb);
    });

    it.skip('autoconnect to multiple shards', function (cb) {
        var autoconn = null;

        return P.try(function () {
            return env.startCluster(['s1', 's2']);
        })
            .then(function () {
                return memdb.autoConnect({ shards: env.config.shards });
            })
            .then(function (ret) {
                autoconn = ret;

                // execute in s1
                return autoconn.transaction(function () {
                    var Player = autoconn.collection('player');
                    return Player.insert({ _id: 'p1', name: 'rain' });
                }, 's1');
            })
            .then(function () {
                // execute in s2
                return autoconn.transaction(function () {
                    var Player = autoconn.collection('player');
                    return Player.remove('p1');
                }, 's2');
            })
            .then(function () {
                return autoconn.close();
            })
            .finally(function () {
                return env.stopCluster();
            })
            .nodeify(cb);
    });

    it.skip('findReadOnly', function (cb) {
        var autoconn = null;

        return P.try(function () {
            return env.startCluster(['s1', 's2']);
        })
            .then(function () {
                return memdb.autoConnect({ shards: env.config.shards });
            })
            .then(function (ret) {
                autoconn = ret;

                // execute in s1
                return autoconn.transaction(function () {
                    return autoconn.collection('player').insert({ _id: 'p1', name: 'rain' });
                }, 's1');
            })
            .then(function () {
                // read in s2
                return autoconn.transaction(function () {
                    return autoconn.collection('player').findReadOnly('p1')
                        .then(function (player) {
                            player.name.should.eql('rain');
                        });
                }, 's2');
            })
            .then(function () {
                // execute in s1
                return autoconn.transaction(function () {
                    return autoconn.collection('player').remove('p1');
                }, 's1');
            })
            .then(function () {
                return autoconn.close();
            })
            .finally(function () {
                return env.stopCluster();
            })
            .nodeify(cb);
    });

    it('cpu load test', function () {
        this.timeout(3600 * 1000);

        var shardId = Object.keys(env.config.shards)[0];
        var autoconn = null;

        return P.try(function () {
            return env.startCluster(shardId);
        })
            .then(function () {
                return memdb.autoConnect(env.config);
            })
            .then(function (ret) {
                autoconn = ret;
                var count = 0;
                var index = 0;

                var modelAreaFishes = autoconn.collection('fish_hunter_area_fishes');
                var insertFishes = function (areaId,newFishes) {
                    var self = this;
                
                    return autoconn.transaction(P.coroutine(function* () {
                        var now =Date.now();
                        var reuse = [];
                        var fishes = yield modelAreaFishes.findReadOnly({areaId:areaId},'_id born alive ');
                        for(var i=0; i<fishes.length; i++){
                            if(now - fishes[i].born >= fishes[i].alive * 1000){
                                reuse.push({_id:fishes[i]._id,fishId:fishes[i].fishId});
                            }
                        }
                
                        reuse.sort((l,r) => {return l.fishId - r.fishId});
                        for (var i=0; i<newFishes.length; i++){
                
                            (function (idx) {
                                autoconn.transaction(P.coroutine(function* () {
                                    var temp = null;
                                    if(idx < reuse.length) {
                                        temp = yield modelAreaFishes.findById(reuse[idx]._id);
                
                                        if(!!temp){
                                            yield modelAreaFishes.update(temp._id,{$set:newFishes[idx]});
                                        }
                                    }
                
                                    if(!temp){
                                        var opts = newFishes[idx];
        
                                        opts._id = opts.areaId + opts.fishId;                
                                        yield modelAreaFishes.insert(opts);
                                    }
                                }),'s1')
                            })(i);
                        }
                    }),'s1');
                };

                return new P(function (resolve, reject) {
                    setInterval(()=>{
                        ++count;

                        var newFishes = [];
                        var now =Date.now();
                        var areaId = 'qwertyuiopasdfghjklzxcvb';
            
                        for(var i=0; i< 200; i++){
                            var opts = {
                                areaId:areaId,
                                fishId:now+i,
                                fishType: 'Fish_000',
                                amount: 1,
                                born: now,
                                alive: 15,
                                fish: {
                                    state:'solo',
                                    path:'bezier_1',
                                    index:i,
                                    score:20
                                }
                            }
                            newFishes.push(opts);
                        }
            
                        insertFishes(areaId,newFishes);
                    },2000);
                });

            })
            .then(function () {
                return autoconn.close();
            })
            .finally(function () {
                return env.stopCluster();
            })
        // .nodeify(cb);
    });
});
