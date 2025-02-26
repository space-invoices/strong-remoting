// Copyright IBM Corp. 2013,2018. All Rights Reserved.
// Node module: strong-remoting
// This file is licensed under the Artistic License 2.0.
// License text available at https://opensource.org/licenses/Artistic-2.0

'use strict';

const g = require('strong-globalize')();
/*!
 * Expose `HttpContext`.
 */
module.exports = HttpContext;

/*!
 * Module dependencies.
 */
const debug = require('debug')('strong-remoting:http-context');
const util = require('util');
const inherits = util.inherits;
const assert = require('assert');
const ContextBase = require('./context-base');
const js2xmlparser = require('js2xmlparser');
const SharedMethod = require('./shared-method');

const DEFAULT_SUPPORTED_TYPES = [
  'application/json', 'application/javascript', 'application/xml',
  'text/javascript', 'text/xml',
  'json', 'xml',
  '*/*',
];

/*!
 * This comment is here as a workaround for a strong-docs bug.
 * The above array value leads to spurious doc output.
 */

const MuxDemux = require('mux-demux');
const SSEClient = require('sse').Client;

/**
 * Create a new `HttpContext` with the given `options`.
 * Invoking a remote method via HTTP creates `HttpContext` object.
 *
 * @param {Object} req Express Request object.
 * @param {Object} res Express Response object.
 * @param {Function} method A [SharedMethod](#sharedmethod)
 * @options {Object} options See below.
 * @property {Boolean} xml Set to `true` to enable XML-based types.  Default is false.
 * @class
 */

function HttpContext(req, res, method, options, typeRegistry) {
  ContextBase.call(this, method, typeRegistry);

  this.req = req;
  this.res = res;
  this.method = method;
  this.options = options || {};
  this.args = this.buildArgs(method);
  this.methodString = method.stringName;
  this.supportedTypes = this.options.supportedTypes || DEFAULT_SUPPORTED_TYPES;
  this.result = {};

  const streamsDesc = method.streams;
  const returnStreamDesc = streamsDesc && streamsDesc.returns;
  const methodReturnsStream = !!returnStreamDesc;

  if (this.supportedTypes === DEFAULT_SUPPORTED_TYPES && !this.options.xml) {
    // Disable all XML-based types by default
    this.supportedTypes = this.supportedTypes.filter(function(type) {
      return !/\bxml\b/i.test(type);
    });
  }

  req.remotingContext = this;

  // streaming support
  if (methodReturnsStream) {
    this.createStream();
  }
}

inherits(HttpContext, ContextBase);

HttpContext.prototype.createStream = function() {
  const streamsDesc = this.method.streams;
  const returnStreamDesc = streamsDesc && streamsDesc.returns;
  const mdm = this.muxDemuxStream = new MuxDemux();
  const io = this.io = {};
  const res = this.res;

  debug('create stream');

  if (returnStreamDesc.json && returnStreamDesc.type === 'ReadableStream') {
    if (!this.shouldReturnEventStream()) {
      res.setHeader('Content-Type',
        returnStreamDesc.contentType || 'application/json; boundary=NL');
      res.setHeader('Transfer-Encoding', 'chunked');

      this.io.out = mdm.createWriteStream();
      // since the method returns a ReadableStream
      // setup an output to pipe the ReadableStream to
      mdm.pipe(res);
      res.on('close', function() {
        mdm.destroy();
      });
    }
  }
};

/**
 * Build args object from the http context's `req` and `res`.
 */

HttpContext.prototype.buildArgs = function(method) {
  const args = {};
  const ctx = this;
  const accepts = method.accepts;

  const isJsonRequest = /^application\/json\b/.test(ctx.req.get('content-type'));

  // build arguments from req and method options
  for (let i = 0, n = accepts.length; i < n; i++) {
    const o = accepts[i];
    const httpFormat = o.http;
    const name = o.name || o.arg;
    let val;

    const typeConverter = ctx.typeRegistry.getConverter(o.type);
    const conversionOptions = SharedMethod.getConversionOptionsForArg(o);

    // Turn off sloppy coercion for values coming from JSON payloads.
    // This is because JSON, unlike other methods, properly retains types
    // like Numbers, Booleans, and null/undefined.
    let doSloppyCoerce = !isJsonRequest;

    // This is an http method keyword, which requires special parsing.
    if (httpFormat) {
      switch (typeof httpFormat) {
        case 'function':
          // the options have defined a formatter
          val = httpFormat(ctx);
          // it's up to the custom provider to perform any coercion as needed
          doSloppyCoerce = false;
          break;
        case 'object':
          switch (httpFormat.source) {
            case 'body':
              val = ctx.req.body;
              break;
            case 'form':
            case 'formData':
              // From the form (body)
              val = ctx.req.body && ctx.req.body[name];
              break;
            case 'query':
              // From the query string
              val = ctx.req.query[name];
              doSloppyCoerce = true;
              break;
            case 'path':
              // From the url path
              val = ctx.req.params[name];
              doSloppyCoerce = true;
              break;
            case 'header':
              val = ctx.req.get(name);
              doSloppyCoerce = true;
              break;
            case 'req':
              // Direct access to http req
              val = ctx.req;
              break;
            case 'res':
              // Direct access to http res
              val = ctx.res;
              break;
            case 'context':
              // Direct access to http context
              val = ctx;
              break;
          }
          break;
      }
    } else {
      val = ctx.getArgByName(name, o);
      doSloppyCoerce = !(isJsonRequest && ctx.req.body &&
        val === ctx.req.body[name]);
    }

    // Most of the time, the data comes through 'sloppy' methods like HTTP headers or a qs
    // which don't preserve types.
    //
    // Use some sloppy typing semantics to try to guess what the user meant to send.
    const result = doSloppyCoerce ?
      typeConverter.fromSloppyValue(ctx, val, conversionOptions) :
      typeConverter.fromTypedValue(ctx, val, conversionOptions);

    debug('arg %j: %s converted %j to %j',
      name, doSloppyCoerce ? 'sloppy' : 'typed', val, result);

    const isValidResult = typeof result === 'object' &&
      ('error' in result || 'value' in result);
    if (!isValidResult) {
      throw new (assert.AssertionError)({
        message: 'Type conversion result should have "error" or "value" property. ' +
          'Got ' + JSON.stringify(result) + ' instead.',
      });
    }

    if (result.error) {
      throw result.error;
    }

    // Set the argument value.
    args[o.arg] = result.value;
  }

  return args;
};

/**
 * Get an arg by name using the given options.
 *
 * @param {String} name
 * @param {Object} options **optional**
 */

HttpContext.prototype.getArgByName = function(name, options) {
  const req = this.req;

  // search these in order by name
  const arg = req.params[name] !== undefined ? req.params[name] : // params
    (req.body && req.body[name]) !== undefined ? req.body[name] : // body
      req.query[name] !== undefined ? req.query[name] : // query
        req.get(name); // header

  return arg;
};

function buildArgs(ctx, method, fn) {
  try {
    return ctx.buildArgs(method);
  } catch (err) {
    // JSON.parse() might throw
    process.nextTick(function() {
      fn(err);
    });
    return undefined;
  }
}

/**
 * Invoke the given shared method using the provided scope against the current context.
 */

HttpContext.prototype.invoke = function(scope, method, fn, isCtor) {
  let args = this.args;
  if (isCtor) {
    args = this.ctorArgs = buildArgs(this, method, fn);
    if (args === undefined) {
      return;
    }
  }
  const http = method.http;
  const pipe = http && http.pipe;
  const pipeDest = pipe && pipe.dest;
  const pipeSrc = pipe && pipe.source;
  const ctx = this;
  const defaultErrorStatus = http && http.errorStatus;
  const res = this.res;

  if (pipeDest) {
    // only support response for now
    switch (pipeDest) {
      case 'res':
        // Probably not correct...but passes my test.
        this.res.header('Content-Type', 'application/json');
        this.res.header('Transfer-Encoding', 'chunked');

        const stream = method.invoke(scope, args, this.options, ctx, fn);
        stream.pipe(this.res);
        break;
      default:
        fn(new Error(g.f('unsupported pipe destination')));
        break;
    }
  } else if (pipeSrc) {
    // only support request for now
    switch (pipeDest) {
      case 'req':
        this.req.pipe(method.invoke(scope, args, this.options, ctx, fn));
        break;
      default:
        fn(new Error(g.f('unsupported pipe source')));
        break;
    }
  } else {
    // simple invoke
    method.invoke(scope, args, this.options, ctx, function(err, result) {
      if (err) {
        if (defaultErrorStatus &&
          (res.statusCode === undefined || res.statusCode === 200)) {
          res.status(err.status || err.statusCode || defaultErrorStatus);
        }
        return fn(err);
      }
      fn(null, result);
    });
  }
};

HttpContext.prototype.setReturnArgByName = function(name, value) {
  const ARG_WAS_HANDLED = true;
  const returnDesc = this.method.getReturnArgDescByName(name);
  const result = this.result;
  const res = this.res;

  if (!returnDesc) {
    debug('warning: cannot set return value for arg' +
      ' (%s) without description!', name);
    return;
  }

  if (returnDesc.root) {
    // TODO(bajtos) call SharedMethod's convertToBasicRemotingType here?
    this.resultType = typeof returnDesc.type === 'string' ?
      returnDesc.type.toLowerCase() : returnDesc.type;
    return;
  }

  if (returnDesc.http) {
    switch (returnDesc.http.target) {
      case 'status':
        res.status(value);
        return ARG_WAS_HANDLED;
      case 'header':
        res.set(returnDesc.http.header || name, value);
        return ARG_WAS_HANDLED;
    }
  }
};

function toJSON(input) {
  if (!input) {
    return input;
  }
  if (typeof input.toJSON === 'function') {
    return input.toJSON();
  } else if (Array.isArray(input)) {
    return input.map(toJSON);
  } else {
    return input;
  }
}

function toXML(input, options) {
  let xml;
  const xmlDefaultOptions = {declaration: true};
  const xmlOptions = util._extend(xmlDefaultOptions, options);
  if (input && typeof input.toXML === 'function') {
    xml = input.toXML();
  } else {
    if (typeof input == 'object') {
      // Trigger toJSON() conversions
      input = toJSON(input);
    }
    if (Array.isArray(input)) {
      input = {result: input};
    }
    xml = js2xmlparser.parse(xmlOptions.wrapperElement || 'response', input, {
      declaration: {
        include: xmlOptions.declaration,
        encoding: 'UTF-8',
      },
      format: {
        doubleQuotes: true,
        indent: '  ',
      },
      convertMap: {
        '[object Date]': function(date) {
          return date.toISOString();
        },
      },
    });
  }
  return xml;
}

HttpContext.prototype.shouldReturnEventStream = function() {
  const req = this.req;
  const query = req.query;
  const format = query._format;

  const acceptable = req.accepts('text/event-stream');
  const returnEventStream = (format === 'event-stream') || acceptable;
  if (returnEventStream) {
    this.res.setHeader('Content-Encoding', 'x-no-compression');
  }
  return returnEventStream;
};

HttpContext.prototype.respondWithEventStream = function(stream) {
  const client = new SSEClient(this.req, this.res);

  client.initialize();

  stream.on('data', function(chunk) {
    client.send('data', JSON.stringify(chunk));
  });

  stream.on('error', function(err) {
    const outErr = {message: err.message};
    for (const key in err) {
      outErr[key] = err[key];
    }
    client.send('error', JSON.stringify(outErr));
  });

  stream.on('end', function() {
    client.send({event: 'end', data: 'null'});
  });

  if (stream.destroy) {
    // ReadableStream#destroy() was added in Node.js 8.0.0
    // In earlier versions, some kinds of streams are already
    // providing this method, which allows us to correctly cancel them.
    // For streams that do not provide this method, there
    // is no other reliable way for closing them prematurely.
    client.once('close', function() {
      stream.destroy();
    });
  }
};

/**
 * Utility functions to send response body
 */
function sendBodyJson(res, data) {
  // Modified in the SI fork, handling response when req was canceled
  const {_headerSent} = res;
  if (!_headerSent) {
    res.json(data);
  }
}

function sendBodyJsonp(res, data) {
  res.jsonp(data);
}

function sendBodyXml(res, data, method) {
  if (data === null) {
    res.header('Content-Length', '7');
    res.send('<null/>');
  } else if (data) {
    try {
      const xmlOptions = method.returns[0].xml || {};
      const xml = toXML(data, xmlOptions);
      res.send(xml);
    } catch (e) {
      res.status(500).send(e + '\n' + data);
    }
  }
}

function sendBodyDefault(res) {
  res.status(406).send('Not Acceptable');
}

/**
 * Deciding on the operation of response, function is called inside this.done()
 */

HttpContext.prototype.resolveReponseOperation = function(accepts) {
  const result = { // default
    sendBody: sendBodyJson,
    contentType: 'application/json',
  };
  switch (accepts) {
    case '*/*':
    case 'application/json':
    case 'json':
      break;
    case 'application/vnd.api+json':
      result.contentType = 'application/vnd.api+json';
      break;
    case 'application/javascript':
    case 'text/javascript':
      result.sendBody = sendBodyJsonp;
      break;
    case 'application/xml':
    case 'text/xml':
    case 'xml':
      if (accepts == 'application/xml') {
        result.contentType = 'application/xml';
      } else {
        result.contentType = 'text/xml';
      }
      result.sendBody = sendBodyXml;
      break;
    default:
      result.sendBody = sendBodyDefault;
      result.contentType = 'text/plain';
      break;
  }
  return result;
};

/**
 * Finish the request and send the correct response.
 */

HttpContext.prototype.done = function(cb) {
  const ctx = this;
  const method = this.method;
  const streamsDesc = method.streams;
  const returnStreamDesc = streamsDesc && streamsDesc.returns;
  const methodReturnsStream = !!returnStreamDesc;
  const res = this.res;
  const out = this.io && this.io.out;
  const err = this.error;
  const result = this.result;

  if (methodReturnsStream) {
    if (returnStreamDesc.json) {
      debug('handling json stream');

      const stream = result[returnStreamDesc.arg];

      if (returnStreamDesc.type === 'ReadableStream') {
        if (ctx.shouldReturnEventStream()) {
          debug('respondWithEventStream');
          ctx.respondWithEventStream(stream);
          return;
        }

        debug('piping to mdm stream');
        stream.pipe(out);
        stream.on('error', function(err) {
          const outErr = {message: err.message};
          for (const key in err) {
            outErr[key] = err[key];
          }

          // this is the reason we are using mux-demux
          out.error(outErr);

          out.end();
        });
        out.on('close', function() {
          stream.destroy();
        });
        // TODO(ritch) support multi-part streams
      } else {
        cb(new Error(g.f('unsupported stream type: %s', returnStreamDesc.type)));
      }
    } else {
      cb(new Error(g.f('Unsupported stream descriptor, only descriptors ' +
        'with property "{{json:true}}" are supported')));
    }
    return;
  }

  // send the result back as
  // the requested content type
  const data = this.result;
  let accepts = this.req.accepts(this.supportedTypes);
  const defaultStatus = this.method.http.status;

  if (defaultStatus) {
    res.status(defaultStatus);
  }

  if (this.req.query._format) {
    if (typeof this.req.query._format !== 'string') {
      accepts = 'invalid'; // this will 406
    } else {
      accepts = this.req.query._format.toLowerCase();
    }
  }
  const dataExists = typeof data !== 'undefined';
  const operationResults = this.resolveReponseOperation(accepts);
  if ((res.statusCode < 300 || res.statusCode > 399) && !res.get('Content-Type')) {
    const {_headerSent} = res;

    // Modified in the SI fork, handling response when req was canceled
    if (!_headerSent) {
      res.header('Content-Type', operationResults.contentType);
    }
  }
  if (dataExists) {
    if (this.resultType !== 'file') {
      operationResults.sendBody(res, data, method);
      res.end();
    } else if (Buffer.isBuffer(data) || typeof(data) === 'string') {
      res.end(data);
    } else if (data.pipe) {
      data.pipe(res);
    } else {
      const valueType = SharedMethod.getType(data);
      const msg = g.f('Cannot create a file response from %s ', valueType);
      return cb(new Error(msg));
    }
  } else {
    if (res.statusCode === undefined || res.statusCode === 200) {
      res.statusCode = 204;
    }
    res.end();
  }

  cb();
};
