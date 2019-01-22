'use strict';

module.exports.setCameraArmedMode = (req, res) => {

    let id = req.swagger.params.id.value;
    let mode = req.swagger.params.mode.value;
    let state = req.swagger.params.state.value;

    let callFunction;

    switch (mode){
        case 'line':
            callFunction = global.module.setLineDetection(id, state === 'enable');
            break;
        case 'field':
            callFunction = global.module.setFieldDetection(id, state === 'enable');
            break;
        case 'motion':
            callFunction = global.module.setMotionDetection(id, state === 'enable');
            break
    }

    callFunction
        .then( (status) => {
            res.json( { data: { status: status }, result : 'ok' } );
        })
        .catch( (err) => {
            res.status(500).json( { code: err.code || 0, message: err.message } );
        });
};

module.exports.getCameraImage = (req, res) => {

    let id = req.swagger.params.id.value;
    let width = req.swagger.params.width.value;
    let height = req.swagger.params.height.value;

    global.module.getImage(id, width, height)
        .then((data) => {
            res.type(data.type);
            res.send(new Buffer(data.image, 'binary'));
            res.status(200).end();
        })
        .catch((err) => {
            res.status(500).json({code: err.code || 0, message: err.message});
        });
};

module.exports.getCameraStream = (req, res) => {

    let id = req.swagger.params.id.value;

    global.module.getStream(id)
        .then((status) => {
            res.json( { data: { status: status }, result : 'ok' } );
        })
        .catch((err) => {
            res.status(500).json({code: err.code || 0, message: err.message});
        });
};

module.exports.setCameraState = (req, res) => {

    let id = req.swagger.params.id.value;
    let state = req.swagger.params.state.value;

    global.module.setPrivacy(id, state === 'disable')
        .then( (status) => {
            res.json( { data: { status: status }, result : 'ok' } );
        })
        .catch( (err) => {
            res.status(500).json( { code: err.code || 0, message: err.message } );
        });
};

