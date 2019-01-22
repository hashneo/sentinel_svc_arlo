'use strict';

module.exports.health = (req, res) => {
    console.log('/health was called');
    res.json({"status": "ok"});
};
