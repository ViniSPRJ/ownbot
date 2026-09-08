/** The only explicitly loaded Pi extension. No native filesystem/shell tools are registered. */
export default async function ownbotExtension(pi: any) {
  const endpoint = process.env.OWNBOT_PI_TOOL_RELAY;
  const token = process.env.OWNBOT_PI_TOOL_TOKEN;
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint) || !token)
    throw new Error("Ownbot tool relay missing");
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const response = await fetch(`${endpoint}/tools`, { headers });
  if (!response.ok) throw new Error("Ownbot tool catalogue unavailable");
  const { tools } = (await response.json()) as {
    tools: {
      name: string;
      alias: string;
      description: string;
      inputSchema: any;
    }[];
  };
  const names = new Set(tools.map((t) => t.alias));
  pi.on("tool_call", (event: any) =>
    names.has(event.toolName)
      ? undefined
      : {
          block: true,
          terminate: true,
          reason: "Only granted Ownbot tools are permitted",
        },
  );
  for (const tool of tools)
    pi.registerTool({
      name: tool.alias,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(toolCallId: string, args: unknown, signal: AbortSignal) {
        const result = await fetch(`${endpoint}/call`, {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({
            tool: tool.name,
            toolCallId,
            arguments: args,
          }),
        });
        if (!result.ok)
          throw new Error("Ownbot permission or tool call refused");
        const body = (await result.json()) as {
          content: any[];
          isError?: boolean;
        };
        if (body.isError) throw new Error("Ownbot granted tool failed");
        return { content: body.content, details: {} };
      },
    });
}
