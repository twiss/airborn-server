var newrelic = require('newrelic');

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var express = require('express');
var app = express();

var pg = require('pg.js');

var AWS = require('aws-sdk');
var s3 = new AWS.S3();

var session = require('express-session');
var RedisStore = require('connect-redis')(session);

var bodyParser = require('body-parser');

var redisParams = require('parse-redis-url')().parse(process.env.REDISCLOUD_URL);
var redis = require('redis').createClient(redisParams.port, redisParams.host);
redis.auth(redisParams.password);

var visualCaptcha;

var channel = require('amqplib').connect(process.env.CLOUDAMQP_URL + '?heartbeat=10').then(function(conn) {
	return conn.createChannel();
});
function queueTask(queue, type, metadata, buffer, callback) {
	channel.then(function(channel) {
		channel.assertQueue(queue);
		channel.sendToQueue(queue, buffer, {type: type, headers: metadata});
	}).then(callback, function(err) {
		callback(null, err);
	});
}

app.use(bodyParser.json());

app.use(session({
	secret: process.env.COOKIE_SESSION_SECRET,
	store: new RedisStore({client: redis}),
	resave: true,
	saveUninitialized: true
}));

app.get('/', function(req, res) {
	res.sendfile('bootstrap.html');
});
app.get('/sjcl.js', function(req, res) {
	res.sendfile('sjcl.js');
});
app.get('/lang.json', function(req, res) {
	res.set('Access-Control-Allow-Origin', '*');
	res.sendfile('lang.json');
});
app.get(/^\/(?:content|register|repair|try)$/, function(req, res) {
	res.sendfile(req.path.substr(1) + '.html');
});
app.get(/^\/(?:bootstrap|content|register|repair|try)\.(?:js|css)$/, function(req, res) {
	res.sendfile(req.path.substr(1));
});
app.get(/^\/3rdparty\/.+\.(?:js|css|png)$/, function(req, res) {
	res.sendfile(req.path.substr(1));
});
app.get(/^\/images\/.+\.png$/, function(req, res) {
	res.sendfile(req.path.substr(1));
});

app.get('/user/:username/exists', function(req, res) {
	var username = req.param('username');
	req.session.username = username;
	pg.connect(process.env.DATABASE_URL, function(err, client, done) {
		if(err) {
			console.error(err);
			res.send(500);
			return;
		}
		client.query('SELECT salt FROM users WHERE username = $1', [username], function(err, result) {
			done();
			if(err) {
				console.error(err);
				res.send(500);
				return;
			}
			if(!result.rows[0]) {
				res.send(200, 'false');
				return;
			}
			res.send(200, 'true');
		});
	});
});

app.get('/user/:username/salt', function(req, res) {
	var username = req.param('username');
	req.session.username = username;
	pg.connect(process.env.DATABASE_URL, function(err, client, done) {
		if(err) {
			console.error(err);
			res.send(500);
			return;
		}
		client.query('SELECT salt FROM users WHERE username = $1', [username], function(err, result) {
			done();
			if(err) {
				console.error(err);
				res.send(500);
				return;
			} else if(!result.rows[0]) {
				res.send(404);
				return;
			}
			res.send(200, result.rows[0].salt);
		});
	});
});

app.get(/^\/object\/(.+)$/, function(req, res) {
	var authkey = req.get('X-Authentication');
	if(authkey) {
		login(req, res, authkey, cont);
	} else if(userLoggedIn(req)) {
		cont();
	} else {
		res.send(403);
		return;
	}
	function cont() {
		var stream = s3.getObject({Bucket: 'laskya-cloud', Key: req.session.S3Prefix + '/' + req.params[0]}).createReadStream();
		stream.pipe(res);
		stream.on('error', function(err) {
			console.error(err);
			res.send(err.statusCode);
		});
	}
});

app.post('/transaction/add', function(req, res) {
	if(userLoggedIn(req)) {
		var transactionId = req.body.transactionId;
		var queue = req.session.userID + ':' + transactionId;
		redis.incrby('transactions:' + queue, req.body.messageCount, function(err, result) {
			if(err) {
				console.error(err);
				res.send(500);
				return;
			}
			if(result === 0) {
				queueTask('transactions', 'commit', {
					queue: queue
				}, new Buffer(0), function(err) {
					if(err) {
						console.error(err);
						res.send(500);
						return;
					}
					res.send(200);
				});
			} else {
				res.send(200);
			}
		});
	} else {
		res.send(403);
		return;
	}
});

app.put(/^\/object\/(.+)$/, function(req, res) {
	if(userLoggedIn(req)) {
		var name = req.params[0];
		var size = req.get('Content-Length');
		var transactionId = req.get('X-Transaction-Id');
		var queue = req.session.userID + ':' + (transactionId || '');
		if(!transactionId) {
			redis.incr('transactions:' + queue, function(err) {
				if(err) {
					console.error(err);
					res.send(500);
					return;
				}
			});
		}
		if(!+size) {
			// Reject Content-Length: 0 as a weak effort to prevent data
			// loss. Chrome 38 Linux sends that for PUT requests with a
			// blob under particularly strange network stack conditions.
			// TODO: (additionally) never truncate the body below and
			// reject instead.
			res.send(400);
			return;
		}
		var body = [];
		req.on('data', function(data) {
			body.push(data);
		});
		req.on('end', function() {
			queueTask(queue, 'putObject', {
				userID: req.session.userID,
				S3Prefix: req.session.S3Prefix,
				name: name,
				size: size
			}, Buffer.concat(body), function(err) {
				if(err) {
					console.error(err);
					res.send(500);
					return;
				}
				redis.decr('transactions:' + queue, function(err, result) {
					if(err) {
						console.error(err);
						res.send(500);
						return;
					}
					if(result === 0) {
						queueTask('transactions', 'commit', {
							queue: queue
						}, new Buffer(0), function(err) {
							if(err) {
								console.error(err);
								res.send(500);
								return;
							}
							res.send(200);
						});
					} else {
						res.send(200);
					}
				});
			});
		});
	} else {
		res.send(403);
		return;
	}
});

if(process.env.MIN_CORE_VERSION <= 1) {
	app.get(/^\/sign_s3_copy_(.+)$/, function(req, res) {
		if(!userLoggedIn(req)) {
			res.send(403);
			return;
		}
		
		var object_name = req.query.s3_object_name;
		var mime_type = req.query.s3_object_type;
		
		var copy_source = req.params[0];

		if(req.query.s3_object_name.substr(0, 17) !== req.session.S3Prefix + '/') {
			res.send(403);
			return;
		}
		
		pg.connect(process.env.DATABASE_URL, function(err, client, done) {
			if(err) {
				console.error(err);
				res.send(500);
				return;
			}
			var name = object_name.split('/')[1];
			var copy_source_name = copy_source.split('/')[1];
			client.query('INSERT INTO objects ("userId", name, size) VALUES ($1, $2, (SELECT size FROM objects WHERE "userId" = $3 AND name = $4))', [req.session.userID, name, req.session.userID, copy_source_name], function(err, result) {
				if(err) {
					client.query('UPDATE objects SET size = (SELECT size FROM objects WHERE "userId" = $1 AND name = $3) WHERE "userId" = $1 AND name = $2', [req.session.userID, name, copy_source_name], cont);
				} else {
					cont(err, result);
				}
			});
			function cont(err, result) {
				done();
				if(err) {
					console.error(err);
					res.send(500);
					return;
				}
				var now = new Date();
				var expires = Math.ceil((now.getTime() + 600000)/1000); // 10 minutes from now
				var amz_headers = 'x-amz-acl:public-read';
				amz_headers += '\nx-amz-copy-source:/' + process.env.S3_BUCKET_NAME + '/' + copy_source;

				var put_request = 'PUT\n\n'+mime_type+'\n'+expires+'\n'+amz_headers+'\n/'+process.env.S3_BUCKET_NAME+'/'+object_name;

				var signature = crypto.createHmac('sha1', new Buffer(process.env.AWS_SECRET_ACCESS_KEY, 'ascii')).update(put_request).digest('base64');
				signature = encodeURIComponent(signature.trim());
				signature = signature.replace('%2B','+');

				var url = 'https://'+process.env.S3_BUCKET_NAME+'.s3.amazonaws.com/'+object_name;

				var credentials = {
					req: put_request,
					signed_request: url+'?AWSAccessKeyId='+process.env.AWS_ACCESS_KEY_ID+'&Expires='+expires+'&Signature='+signature,
					url: url
				};
				res.send(JSON.stringify(credentials));
			}
		});
	});
	
	app.get(/^\/sign_s3_post_(\d+)$/, function(req, res) {
		if(!userLoggedIn(req)) {
			res.send(403);
			return;
		}
		
		var object_name = req.query.s3_object_name;
		var mime_type = req.query.s3_object_type;
		
		var object_size = req.params[0];

		if(req.query.s3_object_name.substr(0, 17) !== req.session.S3Prefix + '/') {
			res.send(403);
			return;
		}
		
		pg.connect(process.env.DATABASE_URL, function(err, client, done) {
			if(err) {
				console.error(err);
				res.send(500);
				return;
			}
			var name = object_name.split('/')[1];
			client.query('INSERT INTO objects ("userId", name, size) VALUES ($1, $2, $3)', [req.session.userID, name, object_size], function(err, result) {
				if(err) {
					client.query('UPDATE objects SET size = $3 WHERE "userId" = $1 AND name = $2', [req.session.userID, name, object_size], cont);
				} else {
					cont(err, result);
				}
			});
			function cont(err, result) {
				done();
				if(err) {
					console.error(err);
					res.send(500);
					return;
				}
				var now = new Date();
				var isoNow = now.toISOString().replace(/-|:|\.\d+/g, '');
				var date = now.getUTCFullYear() + ('00' + now.getUTCMonth()).substr(-2) + ('00' + now.getUTCDate()).substr(-2);
				var expires = new Date(now.getTime() + 600000); // 10 minutes from now

				var credential = process.env.AWS_ACCESS_KEY_ID + '/' + date + '/' + process.env.AWS_REGION + '/s3/aws4_request';
				var policy = new Buffer(JSON.stringify({
					expiration: expires.toISOString(),
					conditions: [
						{bucket: process.env.S3_BUCKET_NAME},
						{key: object_name},
						{acl: 'public-read'},
						['content-length-range', object_size, object_size],
						{'x-amz-algorithm': 'AWS4-HMAC-SHA256'},
						{'x-amz-credential': credential},
						{'x-amz-date': isoNow}
					]
				})).toString('base64');
				
				var dateKey = crypto.createHmac('sha256', new Buffer('AWS4' + process.env.AWS_SECRET_ACCESS_KEY, 'ascii')).update(date).digest();
				var dateRegionKey = crypto.createHmac('sha256', dateKey).update(process.env.AWS_REGION).digest();
				var dateRegionServiceKey = crypto.createHmac('sha256', dateRegionKey).update('s3').digest();
				var signingKey = crypto.createHmac('sha256', dateRegionServiceKey).update('aws4_request').digest();

				var signature = crypto.createHmac('sha256', signingKey).update(policy).digest('hex');

				var url = 'https://'+process.env.S3_BUCKET_NAME+'.s3.amazonaws.com/';

				var credentials = {
					fields: {
						key: object_name,
						acl: 'public-read',
						policy: policy,
						'x-amz-algorithm': 'AWS4-HMAC-SHA256',
						'x-amz-credential': credential,
						'x-amz-date': isoNow,
						'x-amz-signature': signature
					},
					signed_request: url,
					url: url + object_name
				};
				res.send(JSON.stringify(credentials));
			}
		});
	});
}

app.post('/register', function(req, res) {
	if(!req.session.ishuman) {
		res.send(403);
		return;
	}
	pg.connect(process.env.DATABASE_URL, function(err, client, done) {
		if(err) {
			console.error(err);
			res.send(500);
			return;
		}
		var id = guid().replace(/-/g, '').toUpperCase();
		var username = req.body.username;
		var salt = req.body.salt;
		var authkey = req.body.authkey;
		var S3Prefix = crypto.createHmac('sha256', new Buffer(authkey, 'hex')).update(username).digest('hex').substr(0, 16);
		client.query('INSERT INTO users (id, username, salt, authkey, "S3Prefix", account_version) VALUES ($1, $2, $3, $4, $5, 3)', [id, username, salt, authkey, S3Prefix], function(err, result) {
			done();
			if(err) {
				console.error(err);
				if(err.detail && err.detail.match(/Key \(username\)=\(.+\) already exists./)) {
					res.send(409, 'User exists.');
				} else {
					res.send(500);
				}
				return;
			}
			req.session.username = username;
			login(req, res, authkey, function() {
				res.send(200);
			});
		});
	});
});

app.get('/messages', function(req, res) {
	res.send([]);
});

var server = app.listen(process.env.PORT || 8080, function() {
	console.log('Listening on port %d', server.address().port);
});

var io = require('socket.io')(server);

io.on('connection', function(socket) {
	socket.emit('hello', '/push/' + socket.id + '/');
});

app.use('/push/', bodyParser.urlencoded({type: [], extended: false, limit: 100, parameterLimit: 1}));

app.put('/push/:id/', function(req, res) {
	console.log(req.body);
	io.to(req.params.id).emit('push', {
		registrationId: req.query.registrationId,
		version: parseInt(req.body.version, 10)
	});
	res.send(200);
});

function login(req, res, authkey, cont) {
	pg.connect(process.env.DATABASE_URL, function(err, client, done) {
		if(err) {
			console.error(err);
			res.send(500);
			return;
		}
		client.query('SELECT id, authkey, "S3Prefix", account_version, tier FROM users WHERE username = $1', [req.session.username], function(err, result) {
			done();
			if(err || !result.rows[0]) {
				console.error(err);
				res.send(500);
				return;
			}
			if(result.rows[0].authkey === authkey) {
				req.session.userID = result.rows[0].id;
				req.session.S3Prefix = result.rows[0].S3Prefix;
				res.cookie('account_info', {
					S3Prefix: result.rows[0].S3Prefix,
					account_version: result.rows[0].account_version,
					tier: result.rows[0].tier
				});
				cont();
			} else {
				res.send(401);
			}
		});
	});
}

function userLoggedIn(req) {
	return req.session.userID !== undefined;
}

function guid() {
	var d = new Date().getTime();
	var uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
		var r = (d + Math.random()*16)%16 | 0;
		d = Math.floor(d/16);
		return (c=='x' ? r : (r&0x7|0x8)).toString(16);
	});
	return uuid;
}


/********* visualCaptcha *********/

// Define routes functions
// Fetches and streams an audio file
function _getAudio( req, res, next ) {
	// Default file type is mp3, but we need to support ogg as well
	if ( req.params.type !== 'ogg' ) {
		req.params.type = 'mp3';
	}
	
	if ( ! visualCaptcha ) {
		visualCaptcha = require( 'visualcaptcha' )( req.session, req.query.namespace );
	}

	visualCaptcha.streamAudio( res, req.params.type );
};

// Fetches and streams an image file
function _getImage( req, res, next ) {
	var isRetina = false;

	// Default is non-retina
	if ( req.query.retina ) {
		isRetina = true;
	}
	
	if ( ! visualCaptcha ) {
		visualCaptcha = require( 'visualcaptcha' )( req.session, req.query.namespace );
	}

	visualCaptcha.streamImage( req.params.index, res, isRetina );
};

// Start and refresh captcha options
function _startRoute( req, res, next ) {

	// After initializing visualCaptcha, we only need to generate new options
	if ( ! visualCaptcha ) {
		visualCaptcha = require( 'visualcaptcha' )( req.session, req.query.namespace );
	}
	visualCaptcha.generate( req.params.howmany );

	// We have to send the frontend data to use on POST.
	res.send( 200, visualCaptcha.getFrontendData() );
};

// Try to validate the captcha
// We need to make sure we generate new options after trying to validate, to avoid abuse
function _trySubmission( req, res, next ) {
	var namespace = req.query.namespace,
		frontendData,
		queryParams = [],
		imageAnswer,
		audioAnswer,
		responseStatus,
		responseObject;
	
	if ( ! visualCaptcha ) {
		visualCaptcha = require( 'visualcaptcha' )( req.session, req.query.namespace );
	}
	
	frontendData = visualCaptcha.getFrontendData();

	// Add namespace to query params, if present
	if ( namespace && namespace.length !== 0 ) {
		queryParams.push( 'namespace=' + namespace );
	}
	
	// If an image field name was submitted, try to validate it
	if ( ( imageAnswer = req.body[ frontendData.imageFieldName ] ) ) {
		if ( visualCaptcha.validateImage( imageAnswer ) ) {
			queryParams.push( 'status=validImage' );

			responseStatus = 200;
		} else {
			queryParams.push( 'status=failedImage' );

			responseStatus = 403;
		}
	} else if ( ( audioAnswer = req.body[ frontendData.audioFieldName ] ) ) {
		// We set lowercase to allow case-insensitivity, but it's actually optional
		if ( visualCaptcha.validateAudio( audioAnswer.toLowerCase() ) ) {
			queryParams.push( 'status=validAudio' );

			responseStatus = 200;
		} else {
			queryParams.push( 'status=failedAudio' );

			responseStatus = 403;
		}
	} else {
		queryParams.push( 'status=failedPost' );

		responseStatus = 500;
	}

	if(responseStatus === 403) {
		newrelic.setIgnoreTransaction(true);
		setTimeout(function() {
			res.send( responseStatus );
		}, 2000);
	} else {
		req.session.ishuman = true;
		res.send( responseStatus );
	}
};

// Routes definition


app.post( '/captcha/try', _trySubmission );

// @param type is optional and defaults to 'mp3', but can also be 'ogg'
app.get( '/captcha/audio', _getAudio );
app.get( '/captcha/audio/:type', _getAudio );

// @param index is required, the index of the image you wish to get
app.get( '/captcha/image/:index', _getImage );

// @param howmany is required, the number of images to generate
app.get( '/captcha/start/:howmany', _startRoute );