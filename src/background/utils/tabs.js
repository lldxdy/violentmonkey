import { getActiveTab, noop, sendTabCmd, getFullUrl } from '@/common';
import { extensionRoot } from '@/common/consts';
import ua from '@/common/ua';
import { addOwnCommands, addPublicCommands, commands } from './message';
import { getOption } from './options';

const openers = {};
const openerTabIdSupported = !IS_FIREFOX // supported in Chrome
  || !!(window.AbortSignal && browser.windows); // and FF57+ except mobile

addOwnCommands({
  /**
   * @param {string} [pathId] - path or id to add to #scripts route in dashboard,
     if absent a new script will be created for active tab's URL
   * @returns {Promise<chrome.tabs.Tab>}
   */
  async OpenEditor(pathId, src) {
    if (!pathId) {
      const { tab, domain } = await commands.GetTabDomain();
      const id = domain && commands.CacheNewScript({
        url: (tab.pendingUrl || tab.url).split(/[#?]/)[0],
        name: `${getOption('scriptTemplateEdited') ? '' : '- '}${domain}`,
      });
      pathId = `_new${id ? `/${id}` : ''}`;
    }
    const url = `${extensionRoot}options/index.html#scripts/${pathId}`;
    // Firefox until v56 doesn't support moz-extension:// pattern in browser.tabs.query()
    for (const view of browser.extension.getViews()) {
      if (view.location.href === url) {
        const { id: tabId, windowId } = await view.browser.tabs.getCurrent();
        browser.windows.update(windowId, { focused: true });
        return browser.tabs.update(tabId, { active: true });
      }
    }
    return commands.TabOpen({ url, maybeInWindow: true }, src);
  },
});

addPublicCommands({
  /** @return {Promise<{ id: number } | chrome.tabs.Tab>} new tab is returned for internal calls */
  async TabOpen({
    url,
    active = true,
    container,
    insert = true,
    maybeInWindow = false,
    pinned,
  }, src = {}) {
    // src.tab may be absent when invoked from popup (e.g. edit/create buttons)
    const srcTab = src.tab || await getActiveTab() || {};
    // src.url may be absent when invoked directly as commands.TabOpen
    const srcUrl = src.url;
    const isInternal = !srcUrl || srcUrl.startsWith(extensionRoot);
    // only incognito storeId may be specified when opening in an incognito window
    const { incognito, windowId } = srcTab;
    // Chrome can't open chrome-xxx: URLs in incognito windows
    let storeId = srcTab.cookieStoreId;
    if (storeId && !incognito) {
      storeId = getContainerId(isInternal ? 0 : container) || storeId;
    }
    if (storeId) storeId = { cookieStoreId: storeId };
    // URL needs to be expanded for `canOpenIncognito` below
    if (!/^[-\w]+:/.test(url)) {
      url = isInternal
        ? browser.runtime.getURL(url)
        : getFullUrl(url, srcUrl);
    }
    const canOpenIncognito = !incognito || IS_FIREFOX || !/^(chrome[-\w]*):/.test(url);
    let newTab;
    if (maybeInWindow
        && browser.windows
        && getOption('editorWindow')
        /* cookieStoreId in windows.create() is supported since FF64 https://bugzil.la/1393570
         * and a workaround is too convoluted to add it for such an ancient version */
        && (!storeId || ua.firefox >= 64)) {
      const wndOpts = {
        url,
        incognito: canOpenIncognito && incognito,
        ...getOption('editorWindowSimple') && { type: 'popup' },
        ...!IS_FIREFOX && { focused: !!active }, // FF doesn't support this
        ...storeId,
      };
      const pos = getOption('editorWindowPos');
      const hasPos = pos && 'top' in pos;
      const wnd = await browser.windows.create({ ...wndOpts, ...pos }).catch(hasPos && noop)
        || hasPos && await browser.windows.create(wndOpts);
      newTab = wnd.tabs[0];
    }
    if (!newTab) {
      newTab = await browser.tabs.create({
        url,
        // normalizing as boolean because the API requires strict types
        active: !!active,
        pinned: !!pinned,
        ...storeId,
        ...canOpenIncognito && {
          windowId,
          ...insert && { index: srcTab.index + 1 },
          ...openerTabIdSupported && { openerTabId: srcTab.id },
        },
      });
    }
    const { id } = newTab;
    if (active && newTab.windowId !== windowId) {
      await browser.windows.update(newTab.windowId, { focused: true });
    }
    openers[id] = srcTab.id;
    return isInternal ? newTab : { id };
  },
  /** @return {void} */
  TabClose({ id } = {}, src) {
    const tabId = id || src?.tab?.id;
    if (tabId >= 0) browser.tabs.remove(tabId);
  },
  TabFocus(_, src) {
    browser.tabs.update(src.tab.id, { active: true }).catch(noop);
    browser.windows.update(src.tab.windowId, { focused: true }).catch(noop);
  },
});

browser.tabs.onRemoved.addListener((id) => {
  const openerId = openers[id];
  if (openerId >= 0) {
    sendTabCmd(openerId, 'TabClosed', id);
    delete openers[id];
  }
});

function getContainerId(index) {
  return index === 0 && 'firefox-default'
         || index > 0 && `firefox-container-${index}`;
}
