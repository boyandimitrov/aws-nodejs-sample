var express = require('express');
var logger = require('morgan');
var AWS = require('aws-sdk');
var uuid = require('node-uuid');
var fs = require('fs');
var mime = require('mime');
var path = require('path');
var expressJwt = require('express-jwt');
var jwt = require('jsonwebtoken');
var gm = require('gm');
var kue = require('kue');
var nconf = require('nconf');

var pipe = require('./pipe');

var app = express();
var s3 = new AWS.S3();
var jobs = kue.createQueue({
    redis: {
        port: nconf.get("redis:port"),
        host: nconf.get("redis:host")
    }
});

var kueIdentity = uuid.v4();
var singleNodeCache = {};

AWS.config.loadFromPath('./config.json');
nconf.file('./config.json');

app.use(logger('combined'));
app.use(express.bodyParser());
app.use(express.json());
app.use(express.urlencoded());

app.use("/", express.static(__dirname + '/public') );

app.use('/api/private/', expressJwt({secret: nconf.get("sha_noise")}));

var users = {};
users['john.doe'] = {
    uid : '231312',
    tid : '179373',
    name : 'John Doe',
    username : 'john.doe',
    password : 'foobar'
}
users['william.smith'] = {
    uid : '213789',
    tid : '481903',
    name : 'William Smith',
    username : 'william.smith',
    password : 'bar'
}

var params = {
    Bucket: nconf.get("s3").bucket,
    ACL: 'public-read'
};
s3.createBucket(params, function(err, data) {});

var params_thumb = {
    Bucket: nconf.get("s3").bucket_thumb,
    ACL: 'public-read'
};
s3.createBucket(params_thumb, function(err, data) {});


function uploadFilesToS3(data, callback) {

    var lst = [
        function (next) {
            var ext = path.extname(data.originalFilename);
            this.thumbPath = path.join(path.dirname(data.path), (path.basename(data.originalFilename, ext) + '_thumb' + ext));
            gm(data.path)
                .options({imageMagick: true})
                .resize(240, 240)
                .write(this.thumbPath, next);
        },
        function (next) {
            fs.readFile(data.path, next);
        },
        function(next) {
            var params = {
                Bucket: nconf.get("s3").bucket,
                Key: data.originalFilename,
                Body: this.lastresult,
                ACL: 'public-read',
                ContentType: data.type,
                Metadata: users[data.user.username]
            };
            s3.putObject(params, next)
        },
        function(next) {
            fs.readFile(this.thumbPath, next);
        },
        function(next) {
            var params = {
                Bucket: nconf.get("s3").bucket_thumb,
                Key: path.basename(data.originalFilename, path.extname(data.originalFilename)),
                Body: this.lastresult,
                ACL: 'public-read',
                ContentType: data.type,
                Metadata: users[data.user.username]
            };
            s3.putObject(params, next);
        }
    ];

    var p = pipe.create();
    p.exec(lst, callback);
}

jobs.process(kueIdentity, 5, function(job, done){
    uploadFilesToS3(job.data, done);
});

app.post('/login/', function (req, res) {
    if(! (req.body.username === 'john.doe' && req.body.password === 'foobar') ||
        (req.body.username === 'william.smith' && req.body.password === 'bar') ) {
        res.send(401, 'Wrong user or password');
        return;
    }

    var profile = users[req.body.username];

    // We are sending the profile inside the token
    var token = jwt.sign(profile, nconf.get("sha_noise"), { expiresInMinutes: 60*5 });

    res.json({ token: token });
});

app.post('/api/private/keu_uploads', function(req, res) {
    var job = jobs.create(kueIdentity, {
        path : req.files.dummyname.path,
        originalFilename : req.files.dummyname.originalFilename,
        type : req.files.dummyname.type,
        user : req.user
    }).save( function(err){
        if( !err ) {
            console.log( job.id );
            res.end();
        }
    });
});

app.post('/api/private/uploads/', function(req, res) {
    //s3.listBuckets(function(err, data) {
    //    for (var index in data.Buckets) {
    //        var bucket = data.Buckets[index];
    //        console.log("Bucket: ", bucket.Name, ' : ', bucket.CreationDate);
    //    }

    var ext = path.extname(req.files.dummyname.originalFilename);
    var thumbPath = path.join(path.dirname(req.files.dummyname.path),  (path.basename(req.files.dummyname.originalFilename, ext) + '_thumb' +  ext) );
    gm(req.files.dummyname.path)
        .options({imageMagick: true})
        .resize(240, 240)
        //.noProfile()
        .write(thumbPath, function (err) {
            fs.readFile( req.files.dummyname.path, function(err, file) {
                var uid = req.user.uid;
                var params = {
                    Bucket      : nconf.get("s3").bucket,
                    Key         : req.files.dummyname.originalFilename,
                    Body        : file,
                    ACL         : 'public-read',
                    ContentType : req.files.dummyname.type,
                    Metadata    : {
                        uid : uid.toString(),
                        uName : 'Georgi Georgiev'
                    }
                };
                s3.putObject( params, function(err, result) {
                    fs.readFile( thumbPath, function(err, file) {
                        params = {
                            Bucket: nconf.get("s3").bucket_thumb,
                            Key: path.basename(req.files.dummyname.originalFilename, path.extname(req.files.dummyname.originalFilename)),
                            Body: file,
                            ACL: 'public-read',
                            ContentType: req.files.dummyname.type,
                            Metadata: {
                                uid: uid.toString(),
                                uName: 'Georgi Georgiev'
                            }
                        };
                        s3.putObject( params, function(err, result) {
                            res.end();
                        });
                    });
                });
            });
        });

    //});
})

app.get('/api/private/downloads', function(req, res) {
    if ( singleNodeCache.ETag ) {
        console.log('single node cache activated');
        res.writeHead(304);
        return res.end();
    }

    var imgStream = s3.getObject({
            Bucket: nconf.get("s3").bucket,
            Key: '63411304_4_585x461.jpg'
        }).createReadStream();

    s3.headObject({
        Bucket: nconf.get("s3").bucket,
        Key: '63411304_4_585x461.jpg'
    }, function(err, head) {
        console.log('meta: ', head.Metadata);

        if ( head.ETag ) {
            console.log('head meta cache activated');
            singleNodeCache.ETag = head.ETag;
            res.writeHead(304);
            return res.end();
        }

        res.writeHead(200, {
            'Cache-Control': 'public',
            'ETag': head.ETag
        });

        imgStream.pipe(res);
    });
});

app.del('/api/private/delete_file', function(req, res) {
    s3.deleteObject({
        Bucket: nconf.get("s3").bucket_thumb,
        Key: '63411304_4_585x461.jpg'
    }, function(err, result) {
        res.end();
    })
});

var server = app.listen(nconf.get('node:port'), function () {

    console.log(server.address());
    var host = server.address().address;
    var port = server.address().port;

    console.log('Example app listening at http://%s:%s', host, port)

});