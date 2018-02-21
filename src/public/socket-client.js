// TODO: offline-mode: reiterate keys for `subscribeBucket` whenever a mutation happens #mvp
// TODO: add support for listener removal for subscribers and offline listeners #mvp

import localForage from 'localforage';
import Emitter from 'tiny-emitter';
import queryData from '../isomorphic/query-data';
import { applyReducer } from 'fast-json-patch';
import checkRange from '../isomorphic/check-key-range';
const { serverApiBaseRoute } = require('./client/config');

const bucketsToIgnore = {
  _oplog: true,
  _sessions: true
};

const noop = () => {};
let debug = () => noop;
if (process.env.NODE_ENV === 'dev') {
  debug = require('debug');
}

const localDbError = debug('lucidbyte.localDbError');
const getInstance = (bucket) => {
  const config = { name: 'lucidbyte', storeName: bucket };
  return localForage.createInstance(config);
};
function persistToLocalDb(bucket, key, value, action) {
  const instance = getInstance(bucket);
  // db only allows strings as keys
  const keyAsString = key + '';

  debug('lucidbyte.cacheData')(bucket, key, value, action);

  if (action === 'del') {
    return instance.removeItem(keyAsString);
  }
  return instance.setItem(keyAsString, value)
    .catch(localDbError);
}

function getFromLocalDb(bucket, key) {
  const instance = getInstance(bucket);
  // NOTE: returns `null` if no value exists
  return instance.getItem(key).then(v => {
    if (null === v) {
      const msg = `getFromLocalDb: ${bucket}/${key}`;
      return Promise.reject(msg);
    }
    return v;
  });
}

function getBucketFromLocalDb(bucket, iterationOptions, cb, onComplete) {
  const { gt, gte, lt, lte, limit, reverse } = iterationOptions;
  const keyRangeFn = checkRange(gt, gte, lt, lte);
  const instance = getInstance(bucket);
  const list = [];
  instance.iterate((value, key) => {
    list.push({ key, value });
  }).then(() => {
    const l = reverse ? list.reverse() : list;
    l.slice(0, limit).forEach(d => {
      if (keyRangeFn(d.key)) {
        cb(d);
      }
    });
    onComplete();
  });
}

// local operations to cache during network outage
const localOpLog = localForage.createInstance({
  name: 'lucidbyte',
  storeName: '_opLog'
});

/*
  Log all writes to client-side storage when offline.

  data = {
    action = String!,
    bucket = String!,
    key = String!,
    value = Any?
  }
 */
function logAction(data, socket) {
  if (socket.connected) {
    return Promise.resolve({});
  }
  const highRestTimestamp = (Date.now() + performance.now()) * 1000 + '';
  const entryId = highRestTimestamp;
  return localOpLog.setItem(entryId, data);
}

class OfflineEmitter {
  constructor() {
    this.emitter = new Emitter();
  }

  eventName(bucket, key) {
    return `${bucket}/${key}`;
  }

  on(bucket, key, cb) {
    const eventName = this.eventName(bucket, key);
    this.emitter.on(eventName, cb);
    // returns a cleanup function
    return () => this.emitter.off(eventName, cb);
  }

  emit(bucket, key, data = {}) {
    this.emitter.emit(this.eventName(bucket, key), data);
  }
}

export default class Socket {
  constructor(config) {
    const {
      token,
      transports = ['websocket'],
      enableOffline = false
    } = config;
    const socketClientBasePath = serverApiBaseRoute;
    const io = require('socket.io-client');
    const socket = io(socketClientBasePath, {
      query: { token },
      secure: true,
      // force websocket as default
      transports
    });

    socket
      .on('connect', this.flushAndSyncLog);

    this.socket = socket;
    this.offlineEmitter = new OfflineEmitter();
    this.enableOffline = enableOffline;
  }

  isConnected() {
    return this.socket.connected;
  }

  subscribeBucket(params, cb, onComplete) {
    const { socket } = this;
    const {
      bucket,
      limit,
      reverse,
      gt,
      lt,
      gte,
      lte,
      keys,
      values,
      initialValue,
      query,
      once
    } = params;
    const onSubscribeBucket = (eventId) => {
      const isInRange = checkRange(gt, gte, lt, lte);
      let count = 0;
      let removeListener = null;
      const fn = (data) => {
        // ignore action frames
        if (data.action) {
          return;
        }
        if (data.done) {
          count = 0;
          if (onComplete) {
            // stream foreach style.
            // streams results until completed, then removes listener on server
            if (once) {
              removeListener();
            }
            onComplete();
          }
          return;
        }
        // we'll do option filtering locally for offline mode since
        // offline mode returns the entire dataset
        if (this.enableOffline) {
          if (limit && count++ >= limit) return;
          if (!isInRange(data.key)) return;
        }
        cb(data);
      };
      removeListener = () => socket.off(eventId, fn);
      socket.on(eventId, fn);

      const shouldCache = this.enableOffline && !bucketsToIgnore[bucket];
      if (shouldCache) {
        socket.on(eventId, (data) => {
          if (data.done) return;
          debug('lucidbyte.subscribeBucket.offline')(data);
          persistToLocalDb(bucket, data.key, data.value, data.action);
        });
      }
    };
    socket.emit(
      'subscribeBucket',
      { query, bucket, limit, gte, gt, lte, lt, reverse, keys, values,
        enableOffline: this.enableOffline, initialValue, once
      },
      onSubscribeBucket
    );
    socket.on('reconnect', () => {
      socket.emit('subscribe', params, onSubscribeBucket);
    });
    this.triggerCallbackIfOffline(cb, params, onComplete);
  }

  subscribeKey(params, subscriber) {
    const { socket } = this;
    const { bucket, key } = params;
    const onSubscribe = (eventId) => {
      socket.on(eventId, subscriber);
      if (this.enableOffline) {
        const offlineCb = (data) => {
          debug('lucidbyte.offline.subscribeKey')(data);
          persistToLocalDb(bucket, key, data.value, data.action);
        };
        socket.on(eventId, offlineCb);
      }
    };
    socket.emit(
      'subscribe',
      params,
      onSubscribe
    );
    socket.on('reconnect', () => {
      socket.emit('subscribe', params, onSubscribe);
    });
    this.triggerCallbackIfOffline(subscriber, params);
  }

  subscribe(params, subscriber, onComplete = noop) {
    const { bucket, key } = params;
    require('debug')('lucidbyte.subscribe')(bucket, key);
    this.offlineEmitter.on(bucket, key, (data) => {
      console.log('offline', data);
      persistToLocalDb(bucket, key, data.value);
      subscriber(data);
    });
    if (typeof params.key === 'undefined') {
      return this.subscribeBucket(params, subscriber, onComplete);
    }
    this.subscribeKey(params, subscriber);
  }

  put(params, cb) {
    const { bucket, key, value, _syncing } = params;
    const { socket } = this;

    if (!_syncing) {
      const logPromise = logAction({ action: 'put', bucket, key, value }, socket);
      if (!this.isConnected()) {
        this.offlineEmitter.emit(bucket, key, { value, action: 'put' });
        return logPromise;
      }
    }

    const callback = this.promisifySocket('put', params, cb);
    socket.emit('put', { bucket, key, value }, callback);
    return callback.promise;
  }

  patch(params, cb) {
    // accepts either `value` or `ops` property as the patch
    const { bucket, key, value, ops, _syncing } = params;
    const { socket } = this;
    const patch = value || ops;

    if (!_syncing) {
      const entry = { action: 'patch', bucket, key, value: patch };
      logAction(entry, socket);
      if (!this.isConnected()) {
        const curValue = getFromLocalDb(bucket, key);
        return curValue.then(val => {
          const newValue = patch.reduce(applyReducer, val);
          this.offlineEmitter.emit(bucket, key, { value: newValue, action: 'patch' });
        });
      }
    }

    const callback = this.promisifySocket('patch', params, cb);
    /*
      NOTE: send data pre-stringified so we don't have to stringify it again for
      the oplog.
     */
    const opsAsString = JSON.stringify(patch);
    socket.emit('patch', { bucket, key, ops: opsAsString }, callback);
    return callback.promise;
  }

  // gets the value once
  get(params, cb) {
    const { socket } = this;
    const callback = this.promisifySocket('get', params, cb);
    if (this.enableOffline) {
      params._ol = 1;
    }
    socket.emit('get', params, callback);
    return callback.promise;
  }

  del(params, cb) {
    const { socket } = this;
    const { bucket, key } = params;

    if (!params._syncing) {
      const logPromise = logAction({ action: 'del', bucket, key }, socket);
      if (!this.isConnected()) {
        this.offlineEmitter.emit(bucket, key, { action: 'del' });
        return logPromise;
      }
    }

    const callback = this.promisifySocket('del', params, cb);
    socket.emit('delete', { bucket, key }, callback);
    return callback.promise;
  }

  close() {
    this.socket.close();
  }

  triggerCallbackIfOffline(cb, params, onComplete) {
    const { bucket, key, query } = params;
    if (!this.isConnected()) {
      const getBucket = typeof key === 'undefined';
      if (getBucket) {
        return getBucketFromLocalDb(bucket, params, ({ key, value }) => {
          cb({ value: queryData(query, value), key });
        }, onComplete);
      }
      return getFromLocalDb(bucket, key)
        .then(value => cb({ value: queryData(query, value), key }));
    }
    return cb;
  }

  promisifySocket(
    actionType,
    params = {},
    // TODO: add support for callbackFn to invoke instead of promise
    // cb
  ) {
    let promisifiedCallback;
    let fulfilled = false;
    const { bucket, key, query } = params;
    const promise = new Promise((resolve, reject) => {
      promisifiedCallback = ({ error, value }) => {
        if (fulfilled) {
          return;
        }
        fulfilled = true;
        // default timeout handler to prevent callback from hanging indefinitely
        const timeout = (!this.offlineEnabled && !this.isConnected())
          ? setTimeout(reject, 5000)
          : 0;
        clearTimeout(timeout);
        if (error) reject(error);
        else {
          if (this.enableOffline) {
            let valueToPersist;
            if (actionType === 'put') {
              valueToPersist = Promise.resolve(params.value);
            } else if (actionType === 'patch') {
              const fromLocalDb = getFromLocalDb(bucket, key);
              valueToPersist = fromLocalDb.then(value => {
                const ops = params.value || params.ops;
                console.log(value);
                return ops.reduce(applyReducer, value);
              }).catch((err) => {
                console.error('error', err, params);
              });
            } else {
              valueToPersist = Promise.resolve(value);
            }
            valueToPersist.then(v => {
              return persistToLocalDb(bucket, key, v, actionType);
            });
          }
          /*
            NOTE: when offline is enabled, the backend will return the full
            pre-queried value so the client-side can cache it. All querying is
            then done on the client-side instead.
           */
          const valueToSend = this.enableOffline
            ? queryData(query, value)
            : value;
          resolve(valueToSend);
        }
      };
    });
    promisifiedCallback.promise = promise;
    if (this.enableOffline && !this.isConnected()) {
      if (actionType === 'get') {
        getFromLocalDb(bucket, key)
          .then(value => promisifiedCallback({ value, key }));
      }
    }
    return promisifiedCallback;
  }

  flushAndSyncLog = () => {
    console.log('sync');
    localOpLog.iterate((entry, key) => {
      const { action, ...params } = entry;
      params._syncing = true;
      this[action](params)
        .catch(console.error)
        .then(() => {
          localOpLog.removeItem(key);
        });
    });
  }
}
