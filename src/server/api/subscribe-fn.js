const queryData = require('../../isomorphic/query-data');
const getDbClient = require('./get-db');
const Debug = require('debug');

const debug = {
  streamError: Debug('evds.streamError'),
  subscribeError: Debug('evds.subscribeError')
};

const handleDbResponse = (query, value) => {
  return queryData(query, value);
};

const dbStreamHandler = (keys, values, query, cb) => {
  if (keys && values) {
    return (data) => {
      const value = handleDbResponse(query, data.value.parsed);
      cb({ key: data.key, value });
    };
  }
  if (!values) {
    return (key) => cb({ key });
  }
  if (!keys) {
    return (data) => {
      cb({ value: handleDbResponse(query, data.parsed) });
    };
  }
};

const doneFrame = { done: 1 };
module.exports = function createSubscribeFn(client, subscriptions) {
  return async function dbSubscribe({
    eventId,
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
    once = false,
    query
  }, onAcknowledge) {
    const keyToSubscribe = key;
    const watchEntireBucket = key === '';
    let db;

    try {
      db = await getDbClient(bucket);
    } catch(err) {
      return onAcknowledge({ error: err.message });
    }

    const checkRange = require('./../../isomorphic/is-value-in-range');
    const isInRange = checkRange(gt, gte, lt, lte);
    // watch entire bucket
    if (watchEntireBucket) {
      const onStreamError = (error) => {
        client.emit(eventId, { error: error.message });
      };
      const onStreamEnd = () => client.emit(eventId, doneFrame);
      const onDataCallback = (data) => {
        client.emit(eventId, data);
      };
      const bucketStream = (actionType) => (changeKey, newValue) => {
        if (
          'undefined' !== typeof changeKey
          && isInRange(changeKey)
        ) {
          const frame = { key: changeKey, action: actionType };
          if (actionType !== 'del') {
            frame.value = handleDbResponse(query, newValue);
          }
          client.emit(eventId, frame);
        }

        const options = { limit, reverse, keys, values, gt, lt, gte, lte };
        const stream = db.createReadStream(options);
        stream.on(
          'data',
          dbStreamHandler(options.keys, options.values, query, onDataCallback)
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
      db.on('put', onPutDecode);
      const onDelete = bucketStream('del');
      db.on('del', onDelete);
      subscriptions.set(eventId, function cleanup() {
        db.removeListener('put', onPutDecode);
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
        const putCb = async (key, { value }) => {
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
          db.removeListener('put', putCb);
          db.removeListener('del', delCb);
        });
        db.on('put', putCb);
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
