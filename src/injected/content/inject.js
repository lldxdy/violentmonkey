import bridge, { addHandlers } from './bridge';
import { elemByTag, makeElem, nextTask, onElement, sendCmd } from './util';
import { bindEvents, fireBridgeEvent, META_STR } from '../util';
import { Run } from './cmd-run';

/* In FF, content scripts running in a same-origin frame cannot directly call parent's functions
 * so we'll use the extension's UUID, which is unique per computer in FF, for messages
 * like VAULT_WRITER to avoid interception by sites that can add listeners for all of our
 * INIT_FUNC_NAME ids even though we change it now with each release. */
const VAULT_WRITER = `${VM_UUID}${INIT_FUNC_NAME}VW`;
const VAULT_WRITER_ACK = `${VAULT_WRITER}+`;
const bridgeIds = bridge.ids;
let tardyQueue;
let bridgeInfo;
let contLists;
let pageLists;
/** @type {?boolean} */
let pageInjectable;
let frameEventWnd;
/** @type {ShadowRoot} */
let injectedRoot;

// https://bugzil.la/1408996
let VMInitInjection = window[INIT_FUNC_NAME];
/** Avoid running repeatedly due to new `documentElement` or with declarativeContent in Chrome.
 * The prop's mode is overridden to be unforgeable by a userscript in content mode. */
setOwnProp(window, INIT_FUNC_NAME, 1, false);
if (IS_FIREFOX) {
  window::on(VAULT_WRITER, evt => {
    evt::stopImmediatePropagation();
    if (!frameEventWnd) {
      // setupVaultId's first event is the frame's contentWindow
      frameEventWnd = evt::getRelatedTarget();
    } else {
      // setupVaultId's second event is the vaultId
      frameEventWnd::fire(new SafeCustomEvent(VAULT_WRITER_ACK, {
        __proto__: null,
        detail: tellBridgeToWriteVault(evt::getDetail(), frameEventWnd),
      }));
      frameEventWnd = null;
    }
  }, true);
} else {
  setOwnProp(global, VAULT_WRITER, tellBridgeToWriteVault, false);
}

addHandlers({
  /**
   * FF bug workaround to enable processing of sourceURL in injected page scripts
   */
  InjectList: IS_FIREFOX && injectPageList,
});

export function injectPageSandbox() {
  pageInjectable = false;
  const vaultId = safeGetUniqId();
  const handshakeId = safeGetUniqId();
  const contentId = safeGetUniqId();
  const webId = safeGetUniqId();
  if (useOpener(opener) || useOpener(!IS_TOP && parent)) {
    startHandshake();
  } else {
    /* Sites can do window.open(sameOriginUrl,'iframeNameOrNewWindowName').opener=null, spoof JS
     * environment and easily hack into our communication channel before our content scripts run.
     * Content scripts will see `document.opener = null`, not the original opener, so we have
     * to use an iframe to extract the safe globals. Detection via document.referrer won't work
     * is it can be emptied by the opener page, too. */
    inject({ code: `parent["${vaultId}"] = [this, 0]`/* DANGER! See addVaultExports */ }, () => {
      if (!IS_FIREFOX || addVaultExports(window.wrappedJSObject[vaultId])) {
        startHandshake();
      }
    });
  }
  return pageInjectable;

  function useOpener(opener) {
    let ok;
    if (opener && describeProperty(opener.location, 'href').get) {
      // TODO: Use a single PointerEvent with `pointerType: vaultId` when strict_min_version >= 59
      if (IS_FIREFOX) {
        const setOk = evt => { ok = evt::getDetail(); };
        window::on(VAULT_WRITER_ACK, setOk, true);
        opener::fire(new SafeMouseEvent(VAULT_WRITER, { relatedTarget: window }));
        opener::fire(new SafeCustomEvent(VAULT_WRITER, { detail: vaultId }));
        window::off(VAULT_WRITER_ACK, setOk, true);
      } else {
        ok = opener[VAULT_WRITER];
        ok = ok && ok(vaultId, window);
      }
    }
    return ok;
  }
  /** A page can read our script's textContent in a same-origin iframe via DOMNodeRemoved event.
   * Directly preventing it would require redefining ~20 DOM methods in the parent.
   * Instead, we'll send the ids via a temporary handshakeId event, to which the web-bridge
   * will listen only during its initial phase using vault-protected DOM methods.
   * TODO: simplify this when strict_min_version >= 63 (attachShadow in FF) */
  function startHandshake() {
    /* With `once` the listener is removed before DOMNodeInserted is dispatched by appendChild,
     * otherwise a same-origin parent page could use it to spoof the handshake. */
    window::on(handshakeId, handshaker, { capture: true, once: true });
    inject({
      code: `(${VMInitInjection}(${IS_FIREFOX},'${handshakeId}','${vaultId}'))()`
        + `\n//# sourceURL=${VM_UUID}sandbox/injected-web.js`,
    });
    // Clean up in case CSP prevented the script from running
    window::off(handshakeId, handshaker, true);
  }
  function handshaker(evt) {
    pageInjectable = true;
    evt::stopImmediatePropagation();
    bindEvents(contentId, webId, bridge);
    fireBridgeEvent(`${handshakeId}*`, [webId, contentId]);
  }
}

/**
 * @param {VMInjection} data
 * @param {boolean} isXml
 */
export async function injectScripts(data, isXml) {
  const { errors, info, [INJECT_MORE]: more } = data;
  const CACHE = 'cache';
  if (errors) {
    logging.warn(errors);
  }
  if (IS_FIREFOX) {
    IS_FIREFOX = parseFloat(info.ua.browserVersion); // eslint-disable-line no-global-assign
  }
  bridgeInfo = createNullObj();
  bridgeInfo[INJECT_PAGE] = info;
  bridgeInfo[INJECT_CONTENT] = info;
  assign(bridge[CACHE], data[CACHE]);
  if (isXml || data[INJECT_CONTENT_FORCE]) {
    pageInjectable = false;
  } else if (data[INJECT_PAGE] && pageInjectable == null) {
    injectPageSandbox();
  }
  const toContent = data.scripts
    .filter(scr => triageScript(scr) === INJECT_CONTENT)
    .map(scr => [scr.id, scr.key.data]);
  const moreData = (more || toContent.length)
    && sendCmd('InjectionFeedback', {
      [INJECT_CONTENT_FORCE]: !pageInjectable,
      [INJECT_CONTENT]: toContent,
      [INJECT_MORE]: more,
    });
  const getReadyState = describeProperty(Document[PROTO], 'readyState').get;
  const hasInvoker = contLists;
  if (hasInvoker) {
    setupContentInvoker();
  }
  // Using a callback to avoid a microtask tick when the root element exists or appears.
  await onElement('*', injectAll, 'start');
  if (pageLists?.body || contLists?.body) {
    await onElement('body', injectAll, 'body');
  }
  if (more && (data = await moreData)) {
    assign(bridge[CACHE], data[CACHE]);
    if (document::getReadyState() === 'loading') {
      await new SafePromise(resolve => {
        /* Since most sites listen to DOMContentLoaded on `document`, we let them run first
         * by listening on `window` which follows `document` when the event bubbles up. */
        on('DOMContentLoaded', resolve, { once: true });
      });
      await 0; // let the site's listeners on `window` run first
    }
    for (const scr of data.scripts) {
      triageScript(scr);
    }
    if (contLists && !hasInvoker) {
      setupContentInvoker();
    }
    await injectAll('end');
    await injectAll('idle');
  }
  // release for GC
  bridgeInfo = contLists = pageLists = VMInitInjection = null;
}

function triageScript(script) {
  let realm = script[INJECT_INTO];
  realm = (realm === INJECT_AUTO && !pageInjectable) || realm === INJECT_CONTENT
    ? INJECT_CONTENT
    : pageInjectable && INJECT_PAGE;
  if (realm) {
    const lists = realm === INJECT_CONTENT
      ? contLists || (contLists = createNullObj())
      : pageLists || (pageLists = createNullObj());
    const { gmi, [META_STR]: metaStr, pathMap, runAt } = script;
    const list = lists[runAt] || (lists[runAt] = []);
    safePush(list, script);
    setOwnProp(gmi, 'scriptMetaStr', metaStr[0]
      || script.code[metaStr[1]]::slice(metaStr[2], metaStr[3]));
    delete script[META_STR];
    if (pathMap) bridge.pathMaps[script.id] = pathMap;
  } else {
    bridgeIds[script.id] = ID_BAD_REALM;
  }
  return realm;
}

function inject(item, iframeCb) {
  const { code } = item;
  const isCodeArray = isObject(code)
  const script = makeElem('script', !isCodeArray && code);
  // Firefox ignores sourceURL comment when a syntax error occurs so we'll print the name manually
  const onError = IS_FIREFOX && !iframeCb && (e => {
    const { stack } = e.error;
    if (!stack || `${stack}`.includes(VM_UUID)) {
      log('error', [item.displayName], e.error);
      e.preventDefault();
    }
  });
  const div = makeElem('div');
  // Hiding the script's code from mutation events like DOMNodeInserted or DOMNodeRemoved
  const divRoot = injectedRoot || (
    attachShadow
      ? div::attachShadow({ mode: 'closed' })
      : div
  );
  if (isCodeArray) {
    safeApply(append, script, code);
  }
  let iframe;
  let iframeDoc;
  if (iframeCb) {
    iframe = makeElem('iframe', {
      /* Preventing other content scripts */// eslint-disable-next-line no-script-url
      src: 'javascript:void 0',
      sandbox: 'allow-same-origin allow-scripts',
      style: 'display:none!important',
    });
    /* In FF the opener receives DOMNodeInserted attached at creation so it can see window[0] */
    if (!IS_FIREFOX) {
      divRoot::appendChild(iframe);
    }
  } else {
    divRoot::appendChild(script);
  }
  if (onError) {
    window::on('error', onError);
  }
  if (!injectedRoot) {
    // When using declarativeContent there's no documentElement so we'll append to `document`
    (elemByTag('*') || document)::appendChild(div);
  }
  if (onError) {
    window::off('error', onError);
  }
  if (iframeCb) {
    injectedRoot = divRoot;
    if (IS_FIREFOX) divRoot::appendChild(iframe);
    if ((iframeDoc = iframe.contentDocument)) {
      // Either removed in DOMNodeInserted by a hostile web page or CSP forbids iframes(?)
      iframeDoc::getElementsByTagName('*')[0]::appendChild(script);
      iframeCb();
    }
    iframe::remove();
    injectedRoot = null;
  }
  // Clean up in case something didn't load
  script::remove();
  div::remove();
}

function injectAll(runAt) {
  let res;
  for (let inPage = 1; inPage >= 0; inPage--) {
    const realm = inPage ? INJECT_PAGE : INJECT_CONTENT;
    const lists = inPage ? pageLists : contLists;
    const items = lists?.[runAt];
    if (items) {
      bridge.post('ScriptData', { items, info: bridgeInfo[realm] }, realm);
      bridgeInfo[realm] = false; // must be a sendable value to have own prop in the receiver
      if (!tardyQueue) tardyQueue = createNullObj();
      for (const { id } of items) tardyQueue[id] = 1;
      if (!inPage) nextTask()::then(tardyQueueCheck);
      else if (!IS_FIREFOX) res = injectPageList(runAt);
    }
  }
  return res;
}

async function injectPageList(runAt) {
  const scripts = pageLists[runAt];
  for (const scr of scripts) {
    if (scr.code) {
      if (runAt === 'idle') await nextTask();
      if (runAt === 'end') await 0;
      // Exposing window.vmXXX setter just before running the script to avoid interception
      if (!scr.meta.unwrap) bridge.post('Plant', scr.key);
      inject(scr);
      scr.code = '';
      if (scr.meta.unwrap) Run(scr.id);
    }
  }
  tardyQueueCheck();
}

function setupContentInvoker() {
  const invokeContent = VMInitInjection(IS_FIREFOX)(bridge.onHandle);
  const postViaBridge = bridge.post;
  bridge.post = (cmd, params, realm, node) => {
    const fn = realm === INJECT_CONTENT
      ? invokeContent
      : postViaBridge;
    fn(cmd, params, undefined, node);
  };
}

/**
 * Chrome doesn't fire a syntax error event, so we'll mark ids that didn't start yet
 * as "still starting", so the popup can show them accordingly.
 */
function tardyQueueCheck() {
  for (const id in tardyQueue) {
    if (bridgeIds[id] === 1) bridgeIds[id] = ID_INJECTING;
  }
  tardyQueue = null;
}

function tellBridgeToWriteVault(vaultId, wnd) {
  const { post } = bridge;
  if (post) { // may be absent if this page doesn't have scripts
    post('WriteVault', vaultId, INJECT_PAGE, wnd);
    return true;
  }
}

function addVaultExports(vaultSrc) {
  if (!vaultSrc) return; // blocked by CSP
  const exports = cloneInto(createNullObj(), document);
  // In FF a detached iframe's `console` doesn't print anything, we'll export it from content
  const exportedConsole = cloneInto(createNullObj(), document);
  ['log', 'info', 'warn', 'error', 'debug']::forEach(k => {
    exportedConsole[k] = exportFunction(logging[k], document);
    /* global exportFunction */
  });
  exports.console = exportedConsole;
  // vaultSrc[0] is the iframe's `this`
  // DANGER! vaultSrc[1] must be initialized in injectPageSandbox to prevent prototype hooking
  vaultSrc[1] = exports;
  return true;
}
