import { useCallback } from "react";
import { useTransport } from "../stores/transport-context";
import { useChatStore } from "../stores/chat";

/**
 * 发送消息 + 流式接收 + abort。
 * 内部调用 useChatStore.send / abort，绑定 transport。
 */
export function useChatStream() {
  const transport = useTransport();
  const chat = useChatStore();

  const send = useCallback(
    (
      text: string,
      opts: {
        provider_id: string;
        tools_enabled?: boolean;
        write_back?: boolean;
      },
    ) => {
      return chat.send(
        text,
        {
          provider_id: opts.provider_id,
          tools_enabled: opts.tools_enabled ?? true,
          write_back: opts.write_back ?? true,
        },
        transport,
      );
    },
    [chat.send, transport],
  );

  const abort = useCallback(() => {
    return chat.abort(transport);
  }, [chat.abort, transport]);

  return {
    send,
    abort,
    status: chat.status,
  };
}
