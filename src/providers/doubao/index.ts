import type {
  ProviderCapabilities,
  ProviderExecutor,
  ProviderTaskInput,
  ProviderTaskResult,
} from "../types.js";
import { DoubaoTransportError } from "./transport.js";

export interface DoubaoTransportInput {
  prompt: string;
  model_item_key: string;
  thinking: false;
  tools: [];
}

export interface DoubaoTransportResponse {
  output: string | null;
  external_ref?: string | null;
}

export interface DoubaoTransport {
  chat(input: DoubaoTransportInput): Promise<DoubaoTransportResponse>;
  streamChat?(input: DoubaoTransportInput): AsyncIterable<unknown>;
}

export function createDoubaoProvider({
  transport,
  model_item_key = "0",
}: {
  transport: DoubaoTransport;
  model_item_key?: string;
}): ProviderExecutor {
  const capabilities: ProviderCapabilities = {
    execute: true,
    streaming: typeof transport.streamChat === "function",
    cancel: false,
    quota: false,
  };
  return {
    id: "doubao",
    capabilities: () => ({ ...capabilities }),
    async execute(input: ProviderTaskInput): Promise<ProviderTaskResult> {
      try {
        const result = await transport.chat({
          prompt: input.prompt,
          model_item_key,
          thinking: false,
          tools: [],
        });
        return {
          status: "completed",
          output: result.output,
          external_ref: result.external_ref ?? null,
        };
      } catch (error) {
        return error instanceof DoubaoTransportError
          ? { status: error.status, error: error.message }
          : { status: "unknown", error: "豆包发送结果未知，请勿自动重发" };
      }
    },
  };
}
