import bridge, { addHandlers, onScripts } from './bridge';
import { nextTask, sendCmd } from './util';

const getPersisted = describeProperty(PageTransitionEvent[PROTO], 'persisted').get;
const runningIds = [];
let pending;

onScripts.push(() => {
  addHandlers({ Run });
  // isTrusted is `unforgeable` per DOM spec
  on('pageshow', evt => evt.isTrusted && evt::getPersisted() && sendSetBadge());
});

export function Run(id, realm) {
  safePush(runningIds, id);
  bridge.ids[id] = realm || INJECT_PAGE;
  if (!pending) pending = sendSetBadge(2);
}

async function sendSetBadge(numThrottles) {
  while (--numThrottles >= 0) await nextTask();
  sendCmd('SetBadge', runningIds); // not awaiting to clear `pending` immediately
  pending = false;
}
