const queryData = require('../../isomorphic/query-data');
const shortid = require('shortid');
const getDbClient = require('./get-db');
const Debug = require('debug');

const debug = {
  streamError: Debug('evds.streamError'),
  subscribeError: Debug('evds.subscribeError')
};

const handleDbResponse = (query, value, ignoreQuery) => {
  return ignoreQuery
    ? value
    : queryData(query, value);
};

const dbStreamHandler = (keys, values, query, cb, enableOffline) => {
  if (keys && values) {
    return (data) => {
      data.value = handleDbResponse(query, data.value, enableOffline);
      cb(data);
    };
  }
  if (!values) {
    return (key) => cb({ key });
  }
  if (!keys) {
    return (value) => cb({ value: handleDbResponse(query, value, enableOffline) });
  }
};

const doneFrame = { done: 1 };
module.exports = function createSubscribeFn(client, subscriptions) {
  return async function dbSubscribe({
    bucket,
    key = '',
    limit = -1,
    gt,
    lt,
    gte,
    lte,
    reverse = false,
    keys = true,
    values = true,
    initialValue = true,
    // If true, we will not subscribe to db changes, but instead stream out
    // the results and then emit a { done: 1 } frame. This allows the client to
    // do things like `forEach` once.
    once = false,
    enableOffline,
    query
  }, ack) {
    const keyToSubscribe = key;
    const watchEntireBucket = key === '';
    // a unique eventId for each subscription
    const eventId = shortid.generate();
    let db;

    try {
      db = await getDbClient(bucket);
      ack(eventId);
    } catch(err) {
      return ack({ error: err.message });
    }

    const checkRange = require('./../../isomorphic/check-key-range');
    const isInRange = checkRange(gt, gte, lt, lte);
    // watch entire bucket
    if (watchEntireBucket) {
      const onStreamError = (error) => {
        client.emit(eventId, { error: error.message });
      };
      const onStreamEnd = () => client.emit(eventId, doneFrame);
      const bucketStream = (actionType) => (changeKey, newValue) => {
        if (isInRange(changeKey)) {
          const frame = { key: changeKey, action: actionType };
          if (actionType !== 'del') {
            frame.value = handleDbResponse(query, newValue, enableOffline);
          }
          client.emit(eventId, frame);
        }

        const options = enableOffline
          /*
            Only allow only options for offline mode that don't mutate the
            result set. This is important because offline mode needs the
            entire set for local database storage.
           */
          ? { reverse }
          : { limit, reverse, keys, values, gt, lt, gte, lte };
        const stream = db.createReadStream(options);
        const onDataCallback = (data) => {
          client.emit(eventId, data);
        };
        stream.on(
          'data',
          dbStreamHandler(keys, values, query, onDataCallback, enableOffline)
        );
        stream.on('error', onStreamError);
        stream.on('end', onStreamEnd);
      };

      if (initialValue) {
        bucketStream()();
      }

      if (once) {
        return;
      }

      const onPutDecode = bucketStream('put');
      db.on('putDecode', onPutDecode);
      const onDelete = bucketStream('del');
      db.on('del', onDelete);
      subscriptions.set(eventId, function cleanup() {
        db.removeListener('putDecode', onPutDecode);
        db.removeListener('del', onDelete);
      });
    } else {
      try {
        if (initialValue) {
          try {
            // emit initial value
            const currentValue = await db.get(key);
            client.emit(
              eventId,
              { value: handleDbResponse(query, currentValue) }
            );
          } catch(err) {
            debug.streamError(err.message);
          }
        }

        // setup subscription
        const putCb = async (key, value) => {
          const ignore = !watchEntireBucket && key !== keyToSubscribe;
          if (ignore) return;
          client.emit(
            eventId,
            { action: 'put', key, value: queryData(query, value) }
          );
        };
        const delCb = async (key) => {
          const ignore = !watchEntireBucket && key !== keyToSubscribe;
          if (ignore) return;
          client.emit(eventId, { action: 'del', key });
        };
        subscriptions.set(eventId, function cleanup() {
          db.removeListener('putDecode', putCb);
          db.removeListener('del', delCb);
        });
        db.on('putDecode', putCb);
        db.on('del', delCb);
      } catch(err) {
        if (err.type === 'NotFoundError') {
          return;
        }
        debug.subscribeError(err);
        client.emit(eventId, { error: err.message });
      }
    }
  };
};