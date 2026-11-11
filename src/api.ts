import { endpoints, type RelayService } from "./services/relay.js";
export interface RelayConnection {
  fetch: {
    register(route: {
      path: string;
      methods: string[];
      requestBody: "buffered";
      fetch(request: Request): Promise<Response>;
    }): () => void;
  };
}
// 路由由 DSH connection 的认证桥接层处理，仅 owner peer 可访问。
export function registerRelayApi(
  connection: RelayConnection,
  relay: RelayService,
) {
  const disposers: (() => void)[] = [];
  try {
    for (const endpoint of endpoints) {
      const method = `agent-relay/${endpoint}`;
      disposers.push(
        connection.fetch.register({
          path: `/api/${method}`,
          methods: ["POST"],
          requestBody: "buffered",
          async fetch(request) {
            if (
              request.headers.get("content-type")?.split(";")[0].trim() !==
              "application/json"
            )
              return new Response("需要 application/json", { status: 415 });
            let body: unknown;
            try {
              body = await request.json();
            } catch {
              return new Response("JSON 无效", { status: 400 });
            }
            if (!body || typeof body !== "object" || Array.isArray(body))
              return new Response("RPC envelope 无效", { status: 400 });
            const envelope = body as Record<string, unknown>;
            if (
              envelope.type !== "client-request" ||
              typeof envelope.rpcId !== "string" ||
              !envelope.rpcId ||
              envelope.method !== method ||
              !("payload" in envelope)
            )
              return new Response("RPC envelope 无效", { status: 400 });
            const result = await relay.call(endpoint, envelope.payload);
            return Response.json({
              type: "server-response",
              rpcId: envelope.rpcId,
              result: result.ok
                ? result
                : { ...result, error: { ...result.error, details: {} } },
            });
          },
        }),
      );
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
