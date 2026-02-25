declare module "@sinclair/typebox" {
  export const Type: {
    Object: (properties: Record<string, unknown>, options?: Record<string, unknown>) => unknown;
    String: (options?: Record<string, unknown>) => unknown;
    Number: (options?: Record<string, unknown>) => unknown;
    Optional: (schema: unknown) => unknown;
  };
}
