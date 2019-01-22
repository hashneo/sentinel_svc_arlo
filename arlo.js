require('array.prototype.find');

// based off the https://github.com/pfeffed/arlo_myq codebase
function arlo(config) {

    if ( !(this instanceof arlo) ){
        return new arlo(config);
    }

    const uuidv5 = require('uuid/v5');
    const crypto = require('crypto');
    const EventSource = require('eventsource');

    const redis = require('redis');
    var moment = require('moment');

    const logger = require('sentinel-common').logger;

    let pub = redis.createClient(
        {
            host: process.env.REDIS || global.config.redis || '127.0.0.1' ,
            socket_keepalive: true,
            retry_unfulfilled_commands: true
        }
    );

    pub.on('end', function(e){
        logger.error('Redis hung up, committing suicide');
        process.exit(1);
    });

    var NodeCache = require( "node-cache" );

    var deviceCache = new NodeCache();
    var statusCache = new NodeCache();

    var merge = require('deepmerge');

    var request = require('request');

    //require('request-debug')(request);

    var jar = request.jar();

    request = request.defaults({jar: jar});

    var https = require('https');
    var keepAliveAgent = new https.Agent({ keepAlive: true });
/*
     require('request').debug = true
     require('request-debug')(request);
*/

    let cookies;

    deviceCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: 'arlo', id : key, value : value });
        logger.info( 'sentinel.device.insert => ' + data );
        pub.publish( 'sentinel.device.insert', data);
    });

    deviceCache.on( 'delete', function( key ){
        let data = JSON.stringify( { module: 'arlo', id : key });
        logger.info( 'sentinel.device.delete => ' + data );
        pub.publish( 'sentinel.device.delete', data);
    });

    statusCache.on( 'set', function( key, value ){
        let data = JSON.stringify( { module: 'arlo', id : key, value : value });
        //console.log( 'sentinel.device.update => ' + data );
        pub.publish( 'sentinel.device.update', data);
    });

    var api = {
        login : '/hmsweb/login/v2',
        system : '/hmsweb/users/devices?t={ts}',
        subscribe : '/hmsweb/client/subscribe',
        notify : '/hmsweb/users/devices/notify',
        stream : '/hmsweb/users/devices/startStream',
        currentMode: '/hmsweb/users/devices/automation/active'
    };

    for( let k in api ){
        api[k] = api[k].replace('{appId}', config.appid).replace('{culture}', config.culture);
    }

    var that = this;

    var authUser = null;
    var baseStation = null;

    var typeNameCache = { 'devices' : {}, 'attributes' : {} };

    function hashId(v){
        let shasum = crypto.createHash('sha1');
        shasum.update(v);
        return shasum.digest('hex').toUpperCase();
    }

    function processDevice( d ){
        var device = { 'current' : {} };

        device['name'] = d.deviceName;
        device['id'] = d.deviceId;
        device['where'] = {'location': null};
        device['type'] = mapDeviceType(d.deviceType);

        return device;
    }

    var es;

    function createSubresourceQuery(e, t, i, n) {
        var r = {
            from: authUser.userId + '_web',
            to: e,
            action: t,
            resource: i,
            publishResponse :false,
            transId: createTransactionId()
        };

        if (r.publishResponse = "get" !== t, n) {
            r.properties = {};
            for (var a in n)
                n.hasOwnProperty(a) && (r.properties[a] = n[a])
        }

        return r;
    }

    function createTransactionId() {
        return "web!" + (Math.random() * Math.pow(2, 32)).toString(16) + "!" + (new Date()).getTime();
    }

    class Subscriptions {

        constructor() {
            this._subscriptions = {};

            setInterval( () =>{
                    let _now = new Date().getTime();
                    Object.keys( this._subscriptions ).forEach( k => {
                        let s = this._subscriptions[k];
                        if ( _now - s.date >= 30000 ){
                            delete this._subscriptions[k];
                            s.reject(new Error('timeout'));
                        }
                    });
                }
            ,1000);
        }

        subscribe( transId ){

            let f, r;

            let p = new Promise(function(fulfill, reject){
                f = fulfill;
                r = reject;
            });

            this._subscriptions[transId] = { fulfill: f, reject: r, date: new Date().getTime() };

            return p;
        }

        call( data ){
            if ( this._subscriptions && data.transId ) {
                let f = this._subscriptions[data.transId];

                if (f) {
                    delete this._subscriptions[data.transId];
                    f.fulfill(data.properties);
                }
            }
        }

    }

    let subs = new Subscriptions();

    function openMessageChannel(){

        return new Promise( (fulfill, reject) => {

            let url = 'https://' + config.server + api.subscribe;

            var eventSourceInitDict = {headers: {'Authorization': authUser.token}};

            eventSourceInitDict.headers['Cookie'] = jar.getCookieString(url);

            es = new EventSource(url, eventSourceInitDict);

            es.addEventListener('open', function (e) {
                fulfill();
            });

            es.addEventListener('error', function (err) {
                reject(err);
            });

            es.addEventListener('message', function (e) {
                subs.call( JSON.parse(e.data));
                logger.trace(e.data)
            });

        });
    }

    function callNotifyAndWait(q){
        let url = api.notify + '/' + q.to ;
        return callAndWait( url, q );
    }

    function callNotify(q){
        let url = api.notify + '/' + q.to ;
        return call(url, 'POST', q, undefined, { xCloudId : baseStation.xCloudId } )
    }

    function callAndWait(url, q){
        return new Promise( (fulfill, reject) => {

            subs.subscribe( q.transId )
                .then( (data) =>{
                    fulfill(data);
                })
                .catch((err)=>{
                    reject(err);
                });

            call(url, 'POST', q, undefined, { xCloudId : baseStation.xCloudId } )
                .then(() => {
                })
                .catch((err)=>{
                    reject(err);
                })
        });

    }



    function call(url, method, data, type, headers){

        return new Promise( (fulfill, reject) => {

            type = type || 'application/json; charset=utf-8';

            let options = {
                url : 'https://' + config.server + url,
                method : method,
                encoding : null,
                headers : {
                    'Accept' : 'application/json, text/plain, */*',
                    'User-Agent' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 11_1_2 like Mac OS X) AppleWebKit/604.3.5 (KHTML, like Gecko) Mobile/15B202 NETGEAR/v1 (iOS Vuezone)'
                },
                timeout : 90000,
                //agent : keepAliveAgent,
                followRedirect: false
            };

            if (authUser) {
                options['headers']['Authorization'] = authUser.token;
            }

            if ( data === undefined )
                data = null;

            if ( data !== null ){
                if ( type.startsWith('application/json') )
                    data = JSON.stringify(data);

                options['body'] = data;
                options['headers']['Content-Type'] = type;
            }

            for (var a in headers)
                headers.hasOwnProperty(a) && (options.headers[a] = headers[a])

            logger.info( options.url );
            //console.log( data );

            request(options, (err, response, body) => {

                //console.log(body.toString('utf8'));

                if ( err ) {
                    reject(err);
                    return;
                }

                if ( response.statusCode === 401 ) {

                    //token = null;
                    authUser = null;

                    if (url === api.login){
                        return reject(new Error('User could not be authenticated'));
                    }

                    call(api.login, 'POST', {email: config.user, password: config.password}, 'application/json')
                        .then((result) => {

                            //token = result.token;
                            authUser = result;

                            openMessageChannel()
                                .then(()=> {
                                    return call(url, method, data);
                                })
                                .then((result) => {
                                    fulfill(result);
                                })
                                .catch((err) => {
                                    reject(err);
                                });
                        })
                        .catch((err) => {
                            reject(err);
                        });
                    return;

                }

                if (url === api.login && response.statusCode === 302 ){
                    call(response.headers.location, 'GET')
                        .then((result) => {
                            fulfill(result);
                        })
                        .catch((err) => {
                            reject(err);
                        });

                    return;
                }
                try {
                    if (response.headers['content-type'].indexOf('application/json') != -1) {
                        logger.debug( body.toString('utf-8'));
                        body = JSON.parse(body);

                        if (!body.success)
                            return reject(new Error(body.data.message));

                        body = body.data;
                    }
                } catch (e) {
                    logger.error(err);
                    reject(e);
                    return;
                }

                cookies = jar.getCookieString(options.url);

                fulfill( body );
            });
        });
    }

    this.setPrivacy = (id, enabled) => {
        let q = createSubresourceQuery(baseStation.deviceId, 'set', `cameras/${id}`, {
            privacyActive: enabled
        });

        return callNotify(q);
    };

    this.setLineDetection = (id, enabled) => {
        return new Promise( (fulfill, reject) => {
            fulfill('not implemented');
        });
    };

    this.setFieldDetection = (id, enabled) => {
        return new Promise( (fulfill, reject) => {
            fulfill('not implemented');
        });
    };

    this.setMotionDetection = (id, enabled) => {
        let q = createSubresourceQuery(baseStation.deviceId, 'set', `modes`, {
            active: 'mode' + (enabled ? '1' : '0')
        });

        return callNotify(q);
        /*

        let q = {
            activeAutomations: [{
                deviceId: baseStation.deviceId,
                timestamp: new Date().getTime(),
                activeModes: ['mode' + (enabled ? '1' : '0')],
                activeSchedules: []
            }]
        };
        return call(api.currentMode, 'POST', q );
        */
    };

    this.getImage = (id, width, height) => {
        return new Promise( (fulfill, reject) => {
            reject();
        });
    };

    function startStream(id){
        return new Promise( (fulfill, reject) => {
            let q = createSubresourceQuery(baseStation.deviceId, 'set', `cameras/${id}`, {
                activityState: 'startUserStream',
                'cameraId': id
            });

            q.responseUrl = '';

            let url = api.stream;

            callAndWait(url, q)
                .then( (data) => {
                    data.streamURL = data.streamURL.replace('rtsp://', 'rtsps://');
                    fulfill(data);
                })
                .catch( (err) =>{
                    reject(err);
                })
        });
    }

    this.getStream = (id) => {
        return new Promise((fulfill, reject) => {

            startStream(id)

                .then((data) => {

                    //let cookies = jar.cookieString();

                    //let cookies = jar.getCookieString(data.streamURL);

                    let options = {
                        method: 'POST',
                        url: 'http://home.steventaylor.me/stream/',
                        encoding: null,
                        timeout: 30000,
                        json: true,
                        body: {
                            source: data.streamURL,
                            type: 'live',
                            streamTransport : 'tcp',
                            headers: {
                                /*
                                'Authorization' : authUser.token,
                                'xCloudId' : baseStation.xCloudId,
                                'Cookie' : cookies
                                */
                            }
                        }
                    };

                    try {
                        request(options, function (err, response, body) {
                            if (!err && response.statusCode === 200) {
                                fulfill(body.data.endpoint);
                            } else {
                                if (!err)
                                    err = body.toString('utf8');
                                logger.error('request failed => ' + err);
                                reject(err);
                            }
                        });
                    } catch (e) {
                        logger.error('request error => ' + e);
                        reject(e);
                    }

                })
                .catch((err) => {
                    reject(err);
                })
        });
    }

    function mapDeviceType( type ){
        switch (type){
            case 'camera' :
                return 'ip.camera';
            case 'basestation' :
                return 'ip.camera.hub';
            case 'siren' :
                return 'ip.camera.hub.siren';
        }

        return type;
    }

    this.getDevices = () => {

        return new Promise( (fulfill, reject) => {
            deviceCache.keys( ( err, ids ) => {
                if (err)
                    return reject(err);

                deviceCache.mget( ids, (err,values) =>{
                    if (err)
                        return reject(err);

                    statusCache.mget( ids, (err, statuses) => {
                        if (err)
                            return reject(err);

                        let data = [];

                        for (let key in values) {
                            let v = values[key];

                            if ( statuses[key] ) {
                                v.current = statuses[key];
                                delete v.myq;
                                data.push(v);
                            }
                        }

                        fulfill(data);
                    });

                });
            });
        });
    };

    this.getDeviceStatus = (id) => {

        return new Promise( (fulfill, reject) => {
            try {
                statusCache.get(id, (err, value) => {
                    if (err)
                        return reject(err);

                    fulfill(value);
                }, true);
            }catch(err){
                reject(err);
            }
        });

    };

    function getCameras(){
        let q = createSubresourceQuery(baseStation.deviceId, 'get', 'cameras');
        return callNotifyAndWait( q );
    }

    function getBaseStation(){
        let q = createSubresourceQuery(baseStation.deviceId, 'get', 'basestation');
        return callNotifyAndWait( q );
    }

    function getgGatewayMode(){
        return call(api.currentMode);
    }

    function updateStatus() {
        return new Promise( ( fulfill, reject ) => {
            getCameras()
                .then( (results) => {

                    results.forEach( (device) => {

                        let values = {
                            enabled : !device.privacyActive
                        };

                        statusCache.set(device.serialNumber, values );
                    });

                    return getgGatewayMode();
                })
                .then( (results) => {

                    results.forEach((result) => {

                        let values = {
                            armed: !(result.activeModes[0] === 'mode0')
                        };

                        statusCache.set(result.gatewayId, values);
                    });

                    fulfill();
                })
                .catch( (err) =>{
                    reject(err);
                });
        });
    }

    this.Reload = () => {
        return new Promise( (fulfill,reject) => {
            fulfill([]);
        });
    };

    function loadSystem(){
        return new Promise( ( fulfill, reject ) => {
            call( api.system.replace('{ts}', (new Date().getTime()) ), 'get' )
                .then( (results) => {
                    return new Promise( (fulfill) => {
                        let devices = [];
                        for (var i in results) {
                            var device = results[i];

                            let d = processDevice(device);

                            if ( d.type != 'ip.camera.hub.siren' ) {
                                if ( d.type === 'ip.camera.hub'){
                                    baseStation = device;
                                }

                                deviceCache.set(d.id, d);
                                devices.push(d);
                            }
                        }
                        fulfill(devices);
                    })
                })
                .then( () => {
                    return createSubscription();
                })
                .then( ()=>{
                    pingTimerId = setInterval(ping, 30000);
                    fulfill();
                })
                .catch( (err) =>{
                    reject(err);
                });
        });
    }

    let pingTimerId = null;

    function ping(){
        createSubscription()
            .catch((err)=> {
                logger.error(err);
            });
    }

    function createSubscription(){
        let q = createSubresourceQuery(baseStation.deviceId, 'set', 'subscriptions/' + authUser.userId + '_web', { devices : [ baseStation.deviceId ] } );
        return callNotify( q );
    }

    loadSystem()

        .then( () => {
            return updateStatus();
        })
        .then( () => {

            function pollSystem() {
                updateStatus()
                    .then((devices) => {
                        setTimeout(pollSystem, 10000);
                    })
                    .catch((err) => {
                        logger.error(err);
                        process.exit(1);
                        //setTimeout(pollSystem, 60000);
                    });

            }

            setTimeout(pollSystem, 10000);

        })
        .catch((err) => {
            logger.error(err);
            process.exit(1);
        });


    this.system = function( params, success, failed ){
        that.status( null, function( status ){
            var devices = [];

            status.Devices.map( function(d){
                var device = {};

                //if ( d.MyQDeviceTypeName !== undefined )
                //    typeNameCache.devices[d.MyQDeviceTypeId] = d.MyQDeviceTypeName;

                if ( d.MyQDeviceTypeId !== 1 /*Gateway*/ ) {
                    devices.push( processDevice( d ) );
                }
            });

            success( devices );
        });
    };

    return this;
}

module.exports = arlo;