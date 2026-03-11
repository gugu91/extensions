declare module "@mariozechner/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => any): void;
    registerTool(definition: {
      name: string;
      label: string;
      description: string;
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: any,
        signal?: AbortSignal,
        onUpdate?: ((update: any) => void) | undefined,
        ctx?: any,
      ) => Promise<any> | any;
    }): void;
    registerCommand(
      name: string,
      options: {
        description?: string;
        handler: (args: string, ctx: any) => Promise<void> | void;
      },
    ): void;
    sendUserMessage(
      content: string | Array<Record<string, unknown>>,
      options?: { deliverAs?: string },
    ): void;
  }
}
