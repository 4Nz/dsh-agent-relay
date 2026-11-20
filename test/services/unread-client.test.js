import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../../lib/client/unread.js').catch(() => ({}));
function observable(value) {
  const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of [...listeners]) fn(); }, count: () => listeners.size };
}
const tick = () => new Promise(r => setImmediate(r));
const receipt = (sequence = 1, delivery_key = 'notice') => ({ dsh_session_id: 'a', sequence, delivery_key });
function fixture() {
  assert.equal(typeof module.createUnreadController, 'function', '缺少侧栏未读控制器');
  const list = observable({ phase: 'ready', byId: { a: { retainedBy: {}, running: false }, b: { retainedBy: { mainView: 1 }, running: false } } });
  const panel = observable({ activePanelId: null });
  const session = observable({ openState: 'open', running: false, removed: false });
  const eventSource = observable({ entries: [] });
  let notices = [receipt()], visible = true, focus, timer, online = true, ack;
  const reads = [];
  const rpc = { async call(_channel, method, args) {
    if (!online) throw Error('断线');
    if (method.endsWith('/unread')) return { ok: true, value: [...notices] };
    reads.push(args); if (ack) await ack;
    notices = notices.filter(x => x.dsh_session_id !== args.dsh_session_id || x.sequence > args.sequence);
    return { ok: true, value: { read: true } };
  } };
  const controller = module.createUnreadController(rpc, {
    sessions: { list, binding: id => id === 'a' ? { session, eventSource } : undefined },
    layout: { panelInfo: panel },
    visible: () => visible,
    onVisibilityChange(fn) { focus = fn; return () => { focus = undefined; }; },
    every(fn) { timer = fn; return () => { timer = undefined; }; },
  });
  const open = () => list.set({ phase: 'ready', byId: { a: { retainedBy: { mainView: 1 }, running: false } } });
  const loaded = (key = 'notice', complete = true) => eventSource.set({ entries: [
    { type: 'event', event: { type: 'agent/inbox/spliced', seq: 10, data: { inserted: [{ id: key }] } } },
    { type: 'event', event: { type: 'turn/start', seq: 11, data: {} } },
    ...(complete ? [{ type: 'event', event: { type: 'turn/end', seq: 12, data: {} } }] : []),
  ] });
  return { controller, reads, open, loaded, session, panel, list, eventSource,
    setNotices: x => { notices = x; }, offline: () => { online = false; }, online: () => { online = true; },
    visibility: x => { visible = x; focus?.(); }, poll: () => timer?.(), holdAck: x => { ack = x; },
    stopped: () => !timer && !focus && list.count() === 0 && panel.count() === 0 && session.count() === 0 && eventSource.count() === 0 };
}

test('后台消息不依赖通知权限；断线和重新挂载保留未读，实际查看已结束回复才清除', async () => {
  const f = fixture(); let stop = f.controller.start(); await tick();
  assert.equal(f.controller.getSnapshot().get('a').sequence, 1);
  f.offline(); await f.poll(); assert.equal(f.controller.getSnapshot().size, 1);
  stop(); assert.ok(f.stopped()); f.online(); stop = f.controller.start(); await tick();
  assert.equal(f.controller.getSnapshot().size, 1);
  f.open(); await tick(); assert.equal(f.reads.length, 0, '尚未加载消息不能清除');
  f.loaded('notice', false); await tick(); assert.equal(f.reads.length, 0, '轮次未结束不能清除');
  f.session.set({ openState: 'open', running: true, removed: false });
  f.loaded(); await tick(); assert.equal(f.reads.length, 0, '运行中不提前清除');
  f.session.set({ openState: 'open', running: false, removed: false }); await tick();
  assert.deepEqual(f.reads, [{ dsh_session_id: 'a', sequence: 1 }]);
  assert.equal(f.controller.getSnapshot().size, 0); stop(); assert.ok(f.stopped());
});

test('全局面板、隐藏页面和会话加载失败均不当成已读', async () => {
  const f = fixture(); f.panel.set({ activePanelId: 'agent-relay' });
  const stop = f.controller.start(); await tick(); f.open(); f.loaded(); await tick();
  assert.equal(f.reads.length, 0);
  f.visibility(false); f.panel.set({ activePanelId: null }); await tick(); assert.equal(f.reads.length, 0);
  f.session.set({ openState: 'error', running: false, removed: false }); f.visibility(true); await tick();
  assert.equal(f.reads.length, 0);
  f.session.set({ openState: 'open', running: false, removed: false }); await tick();
  assert.equal(f.controller.getSnapshot().size, 0); stop();
});

test('已读请求在途到达新消息，不清除新水位，失败后可重试', async () => {
  const f = fixture(); const stop = f.controller.start(); await tick();
  let finish; f.holdAck(new Promise(r => { finish = r; })); f.open(); f.loaded(); await tick();
  f.setNotices([receipt(2, 'second')]); await f.poll();
  finish(); await tick(); assert.equal(f.controller.getSnapshot().get('a').sequence, 2);
  f.holdAck(undefined); f.offline(); f.loaded('second'); await tick();
  assert.equal(f.controller.getSnapshot().size, 1);
  f.online(); await f.poll(); await tick();
  assert.equal(f.controller.getSnapshot().size, 0); stop();
});
