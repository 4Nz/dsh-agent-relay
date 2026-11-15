import { test } from "node:test";
import assert from "node:assert/strict";
import { createDshDelivery } from "../../lib/services/delivery.js";

for (const source of ['poll','push']) test(`${source} 投递保留来源，并使用对应的汇报或自主判断指引`,async()=>{
 let received;
 const delivery=createDshDelivery({
  sessionQuery:{readSession:async()=>({events:[]})},
  sessionController:{resolveAgent:async()=>({agent:{session:{},followup(message){received=message;}}})},
  sessions:{flush:async()=>true},
 });
 const notification={delivery_key:'notice-'+source,source,result:'completed',summary:'帮我梳理下E盘内容：外部会话已完成磁盘空间查询。'};
 assert.equal((await delivery.deliver('receiver',notification)).status,'delivered');
 const prompt=received.content[0].text;
 assert.ok(prompt.includes(notification.summary));
 assert.equal(prompt.includes('请按用户原有要求处理'),false);
 if(source==='poll'){
  assert.match(prompt,/会话订阅汇报/);
  assert.match(prompt,/不要重新执行/);
  assert.match(prompt,/不要调用工具/);
  assert.doesNotMatch(prompt,/自行判断下一步/);
 }else{
  assert.match(prompt,/Agent 主动通知/);
  assert.match(prompt,/自行判断下一步/);
  assert.doesNotMatch(prompt,/不要调用工具/);
 }
});
test("followup 后 flush 失败保持未知，核对已有 inbox 消息后不再次发送", async () => {
  const events = [];
  let flush = false;
  let sends = 0;
  const ctx = {
    sessionQuery: { readSession: async () => ({ events }) },
    sessionController: {
      resolveAgent: async () => ({
        agent: {
          session: {},
          followup(message) {
            sends++;
            events.push({
              type: "agent/inbox/spliced",
              data: { inserted: [message] },
            });
          },
        },
      }),
    },
    sessions: { flush: async () => flush },
  };
  const delivery = createDshDelivery(ctx);
  const n = {
    id: "n",
    delivery_key: "n",
    summary: "结果",
    result: "completed",
  };
  assert.equal((await delivery.deliver("s", n)).status, "unknown");
  assert.equal(sends, 1);
  flush = true;
  assert.equal(await delivery.confirm("s", n), "delivered");
  assert.equal((await delivery.deliver("s", n)).status, "delivered");
  assert.equal(sends, 1);
  assert.equal(events[0].data.inserted[0].id, "n");
  assert.ok(events[0].data.inserted[0].content[0].text.includes("\n结果："));
});
test("查询失败不能发送，resolveAgent 错误是明确未投递", async () => {
  let sends = 0;
  const ctx = {
    sessionQuery: {
      readSession: async () => {
        throw Error("离线");
      },
    },
    sessionController: {
      resolveAgent: async () => {
        sends++;
        return { error: Error("不可用") };
      },
    },
    sessions: { flush: async () => true },
  };
  const d = createDshDelivery(ctx);
  assert.equal((await d.deliver("s", { delivery_key: "n" })).status, "failed");
  assert.equal(sends, 0);
  ctx.sessionQuery.readSession = async () => ({ events: [] });
  assert.equal((await d.deliver("s", { delivery_key: "n" })).status, "failed");
});
