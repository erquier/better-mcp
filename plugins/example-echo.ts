/**
 * Example Plugin for better-mcp
 *
 * Demonstrates the plugin API with two tools:
 * - echo: Echoes back the input message
 * - greet: Returns a greeting for the given name
 */

export const plugin = {
  name: "example-echo",
  version: "1.0.0",
  description: "Example plugin with echo and greet tools",

  tools: [
    {
      name: "echo",
      description: "Echoes back the input message exactly as provided",
      inputSchema: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "The message to echo back",
          },
        },
        required: ["message"],
      },
      handler: async (args: Record<string, unknown>, _context: { config: unknown; project: string }) => {
        const message = typeof args.message === "string" ? args.message : String(args.message ?? "");
        return {
          content: [{ type: "text", text: message }],
        };
      },
    },

    {
      name: "greet",
      description: "Returns a friendly greeting for the given name",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name to greet",
          },
        },
        required: ["name"],
      },
      handler: async (args: Record<string, unknown>, _context: { config: unknown; project: string }) => {
        const name = typeof args.name === "string" ? args.name : "World";
        const greeting = `Hello, ${name}!`;
        return {
          content: [{ type: "text", text: greeting }],
        };
      },
    },
  ],
};
