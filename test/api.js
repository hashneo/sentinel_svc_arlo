var request = require('supertest');
const swaggerParser = require('swagger-parser');
var assert = require('chai').assert;
const app = require('../app.js');

describe('api', function() {

    before(function() {
        // runs before all tests in this block
    });

    after(function() {
        // runs after all tests in this block
    });

    beforeEach(function() {
        // runs before each test in this block
    });

    afterEach(function() {
        // runs after each test in this block
    });

    // test cases
    describe('Swagger', function(){
        var apiDoc;

        describe('Parsing document', function(){
            it('should load and parse correctly', function(done){
                swaggerParser.parse('api/swagger/swagger.yaml')
                    .then(function(doc){
                        apiDoc = doc;
                        done();
                    })
                    .catch( function(err){
                        done(err);
                    });
            });
        });

        describe('Validating Document', function(){
            it('should validate, without errors', function(done){
                swaggerParser.validate(apiDoc)
                    .then(function(){
                        done();
                    })
                    .catch( function(err){
                        done(err);
                    });
            });
        });

    });

    describe('testing the API', function () {
        it('should pass, without errors', function (done) {
            request(app)
                .get('/health')
                .set('Accept', 'application/json')
                .expect('Content-Type', /json/)
                .expect(200, done);
        });
    });

});