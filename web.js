/******************************************************************************
 * Libraries
 *****************************************************************************/
var express = require("express");
var oauth = require('oauth');
var mongo = require('mongodb');
var gcal = require('google-calendar');
var q = require('q');

/******************************************************************************
 * Variables
 *****************************************************************************/
var oa;
var app = express();

var clientId = 'GOOGLE_CLIENT_ID';
var clientSecret = 'GOOGLE_CLIENT_SECRET';
var scopes = 'https://www.googleapis.com/auth/calendar';
var googleUserId;
var refreshToken;
var baseUrl;

/******************************************************************************
 * App Setup
 *****************************************************************************/
app.configure('development',function(){
  console.log('!! DEVELOPMENT MODE !!');

  googleUserId = 'GOOGLE_EMAIL_ADDRESS';
  refreshToken = 'GOOGLE_REFRESH_TOKEN';
  baseUrl = 'DEV_API_URL';
});

app.configure('production', function(){
  console.log('!! PRODUCTION MODE !!');

  googleUserId = 'GOOGLE_EMAIL_ADDRESS';
  refreshToken = 'GOOGLE_REFRESH_TOKEN';
  baseUrl = 'PRODUCTION_API_URL';
});

var allowCrossDomain = function(req, res, next){

  //instantiate allowed domains list
  var allowedDomains = [
    'http://YOUR_DOMAIN.com',
    'https://YOUR_DOMAIN.com'
  ];

  //check if request origin is in allowed domains list
  if(allowedDomains.indexOf(req.headers.origin) != -1)
  {
    res.header('Access-Control-Allow-Origin', req.headers.origin);
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');
  }

  // intercept OPTIONS method
    if ('OPTIONS' == req.method) {
    res.send(200);
    }
    else {
    next();
    }
};

app.use(allowCrossDomain);
app.use(express.logger());
app.use(express.bodyParser());

/******************************************************************************
 * Database Setup
 *****************************************************************************/
var mongoCollectionName = 'MONGO_COLLECTION_NAME';
var mongoUri = process.env.MONGOLAB_URI || process.env.MONGOHQ_URL || 'mongodb://localhost/default';
var database;
function connect(callback)
{
  var deferred = q.defer();

  if(database === undefined)
  {
    mongo.Db.connect(mongoUri, function(err, db){
      if(err) deferred.reject({error: err});

      database = db;
      deferred.resolve();
    });
  }
  else
  {
    deferred.resolve();
  }

  return deferred.promise;
}

/******************************************************************************
 * Methods
 *****************************************************************************/
function authorize()
{
  var deferred = q.defer();

  oa = new oauth.OAuth2(clientId,
            clientSecret,
            "https://accounts.google.com/o",
            "/oauth2/auth",
            "/oauth2/token");

  if(refreshToken)
  {
    oa.getOAuthAccessToken(refreshToken, {grant_type:'refresh_token', client_id: clientId, client_secret: clientSecret}, function(err, access_token, refresh_token, res){

      //lookup settings from database
      connect().then(function(){
        database.collection(mongoCollectionName).findOne({google_user_id: googleUserId}, function(findError, settings){

          var expiresIn = parseInt(res.expires_in);
          var accessTokenExpiration = new Date().getTime() + (expiresIn * 1000);

          //add refresh token if it is returned
          if(refresh_token != undefined) settings.google_refresh_token = refresh_token;

          //update access token in database
          settings.google_access_token = access_token;
          settings.google_access_token_expiration = accessTokenExpiration;

          database.collection(mongoCollectionName).save(settings);

          console.log('-- access token updated:', access_token);

          deferred.resolve(access_token);
        });
      });

    })
  }
  else
  {
    deferred.reject({error: 'Application needs authorization.'});
  }

  return deferred.promise;
}

function getAccessToken()
{
  var deferred = q.defer();
  var accessToken;

  connect().then(function(){

    database.collection(mongoCollectionName).findOne({google_user_id: googleUserId}, function(findError, settings){
      console.log('GOOGLE SETTINGS RESPONSE:', settings, findError);

      //check if access token is still valid
      var today = new Date();
      var currentTime = today.getTime();
      if(currentTime < settings.google_access_token_expiration)
      {
        //use the current access token
        accessToken = settings.google_access_token;
        deferred.resolve(accessToken)
      }
      else
      {
        //refresh the access token
        authorize().then(function(token){

          accessToken = token;
          deferred.resolve(accessToken);

        }, function(error){

          deferred.reject(error);

        });
      }
    });

  }, function(error){
    deferred.reject(error);
  });

  return deferred.promise;
}


/******************************************************************************
 * API
 *****************************************************************************/
app.get('/', function(request, response) {
  response.send('<!DOCTYPE html><meta charset=utf-8><form action=/authorize><input type=submit>');
});

app.get('/authorize', function(request, response){
    oa = new oauth.OAuth2(clientId,
            clientSecret,
            "https://accounts.google.com/o",
            "/oauth2/auth",
            "/oauth2/token");

    response.redirect(oa.getAuthorizeUrl({scope:scopes, response_type:'code', redirect_uri:baseUrl+'/callback', access_type:'offline',user_id:googleUserId}));
});

app.get('/deauthorize', function(request, response){
  //TODO: implmenet deauthorize API method
});

app.get('/callback', function(request, response){

  if(request.query.code){
    oa.getOAuthAccessToken(request.query.code, {grant_type:'authorization_code', redirect_uri:baseUrl+'/callback'}, function(err, access_token, refresh_token, res){
      if(err)
      {
        response.end('error: ' + JSON.stringify(err));
      }
      else
      {
        //lookup settings from database
        connect().then(function(){
          database.collection(mongoCollectionName).findOne({google_user_id: googleUserId}, function(findError, settings){
            console.log('--writing access token to database--');
            var accessTokenExpiration = new Date().getTime() + (3500 * 1000);

            //update access token in database
            settings.google_access_token = access_token;
            settings.google_access_token_expiration = accessTokenExpiration;

            //set google refresh token if it is returned
            if(refresh_token != undefined) settings.google_refresh_token = refresh_token;

            database.collection(mongoCollectionName).save(settings);

            response.writeHead(200, {"Content-Type": "application/javascript"});
            response.write('refresh token: ' + refresh_token + '\n');
            response.write(JSON.stringify(res, null, '\t'));
            response.end();
          });
        });

      }

    });
  }
});

app.get('/events', function(request, response){

  var getGoogleEvents = function(accessToken)
  {
    //instantiate google calendar instance
    var google_calendar = new gcal.GoogleCalendar(accessToken);

    google_calendar.events.list(googleUserId, {'timeMin': new Date().toISOString()}, function(err, eventList){
      if(err){
        response.send(500, err);
      }
      else{
        response.writeHead(200, {"Content-Type": "application/json"});
        response.write(JSON.stringify(eventList, null, '\t'));
        response.end();
      }
    });
  };

  //retrieve current access token
  getAccessToken().then(function(accessToken){
    getGoogleEvents(accessToken);
  }, function(error){
    //TODO: handle getAccessToken error
  });

});

app.post('/event', function(request, response){

  var addEventBody = {
    'status':'confirmed',
    'summary': request.body.contact.firstName + ' ' + request.body.contact.lastName,
    'description': request.body.contact.phone + '\n' + request.body.contact.details,
    'organizer': {
      'email': googleUserId,
      'self': true
    },
    'start': {
      'dateTime': request.body.startdate,
    },
    'end': {
      'dateTime': request.body.enddate
    },
    'attendees': [
        {
          'email': googleUserId,
          'organizer': true,
          'self': true,
          'responseStatus': 'needsAction'
        },
        {
          'email': request.body.contact.email,
        'organizer': false,
        'responseStatus': 'needsAction'
        }
    ]
  };

  var addGoogleEvent = function(accessToken){
    //instantiate google calendar instance
    var google_calendar = new gcal.GoogleCalendar(accessToken);
    console.log('****** ADDING GOOGLE EVENT *******');
    google_calendar.events.insert(googleUserId, addEventBody, function(addEventError, addEventResponse){
      console.log('GOOGLE RESPONSE:', addEventError, addEventResponse);

      if(!addEventError)
        response.send(200, addEventResponse);

      response.send(400, addEventError);
    });
  };

  //retrieve current access token
  getAccessToken().then(function(accessToken){
    addGoogleEvent(accessToken);
  }, function(error){
    //TODO: handle error
  });

});



var port = process.env.PORT || 5000;
app.listen(port, function() {
  console.log("Listening on " + port);
});