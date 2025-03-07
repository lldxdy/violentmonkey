/* eslint-disable no-unused-vars */

/**
 * This file runs before safe-globals of `injected-content` and `injected-web` entries.
 * `export` is stripped in the final output and is only used for our NodeJS test scripts.
 * WARNING! Don't use exported functions from @/common anywhere in injected!
 */

export const { location } = global;
export const PROTO = 'prototype';
export const IS_TOP = top === window;
export const CALLBACK_ID = '__CBID';
export const kFileName = 'fileName';

export const throwIfProtoPresent = process.env.DEBUG && (obj => {
  if (!obj || obj.__proto__) { // eslint-disable-line no-proto
    throw 'proto is not null';
  }
});
export const isString = val => typeof val === 'string';

export const getOwnProp = (obj, key, defVal) => {
  // obj may be a Proxy that throws in has() or its getter throws
  try {
    // hasOwnProperty is Reflect.has which throws for non-objects
    if (obj && typeof obj === 'object' && hasOwnProperty(obj, key)) {
      defVal = obj[key];
    }
  } catch (e) { /* NOP */ }
  return defVal;
};

/**
 * @param {T} obj
 * @param {string|Symbol} key
 * @param {?} value
 * @param {boolean} [mutable]
 * @param {'set' | 'get'} [valueKey]
 * @return {T}
 * @template T
 */
export const setOwnProp = (obj, key, value, mutable = true, valueKey) => (
  defineProperty(obj, key, {
    __proto__: null,
    [valueKey || 'value']: value,
    [!valueKey && 'writable']: mutable, // only allowed for 'value'
    configurable: mutable,
    enumerable: mutable,
  })
);

export const nullObjFrom = src => process.env.TEST
  ? global.Object.assign({ __proto__: null }, src)
  : assign(createNullObj(), src);

/** If `dst` has a proto, it'll be copied into a new proto:null object */
export const safePickInto = (dst, src, keys) => {
  if (getPrototypeOf(dst)) {
    dst = nullObjFrom(dst);
  }
  if (src) {
    keys::forEach(key => {
      if (hasOwnProperty(src, key)) {
        dst[key] = src[key];
      }
    });
  }
  return dst;
};

// WARNING! `obj` must use __proto__:null
export const ensureNestedProp = (obj, bucketId, key, defaultValue) => {
  if (process.env.DEBUG) throwIfProtoPresent(obj);
  const bucket = obj[bucketId] || (
    obj[bucketId] = createNullObj()
  );
  const val = bucket[key] ?? (
    bucket[key] = (defaultValue ?? createNullObj())
  );
  return val;
};

export const promiseResolve = async val => val;

// Using just one random() to avoid many methods in vault just for this
export const safeGetUniqId = (prefix = 'VM') => prefix + mathRandom();

/** args is [tags?, ...rest] */
export const log = (level, ...args) => {
  let s = `[${VIOLENTMONKEY}]`;
  if (args[0]) args[0]::forEach(tag => { s += `[${tag}]`; });
  args[0] = s;
  safeApply(logging[level], logging, args);
};

/**
 * Object.defineProperty seems to be inherently broken: it reads inherited props from desc
 * (even though the purpose of this API is to define own props) and then complains when it finds
 * invalid props like an inherited setter when you only provide `{value}`.
 */
export const safeDefineProperty = (obj, key, desc) => (
  defineProperty(obj, key, getPrototypeOf(desc) ? nullObjFrom(desc) : desc)
);

/** Unlike ::push() this one doesn't call possibly spoofed Array.prototype setters */
export const safePush = (arr, val) => (
  setOwnProp(arr, arr.length, val)
);
